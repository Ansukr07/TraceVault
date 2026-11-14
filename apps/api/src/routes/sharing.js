import crypto from 'node:crypto';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import { Router } from 'express';
import { config } from '../config.js';
import { sarvamAudioSecondsToday } from '../jobs/pipeline.js';
import { AuditEntry, Case, Evidence, ProviderUsage, ShareGrant, User } from '../models/index.js';
import { Job } from '../jobs/runner.js';
import { ah, httpError, requireAdmin, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { sha256Hex } from '../services/crypto.js';

const STATUS_ORDER = { received: 1, under_review: 2, needs_evidence: 2, fir_registered: 3, closed: 4 };
// Legal / investigator access lapses at expiresAt. A collaborator is a trusted helper: expiresAt only bounds how
// long the invite link can be accepted, and access then lasts until the owner revokes it.
const isActive = (g) => !g.revokedAt && (g.role === 'collaborator' ? !!g.acceptedAt || g.expiresAt > new Date() : g.expiresAt > new Date());

const grantView = (g, recipient) => ({
  id: String(g._id),
  caseId: String(g.caseId),
  recipientEmail: g.recipientEmail,
  role: g.role,
  scope: { type: g.scope?.type ?? 'case', evidenceIds: g.scope?.evidenceIds ?? [] },
  allowDownload: g.allowDownload,
  createdAt: g.createdAt,
  expiresAt: g.expiresAt,
  accepted: !!g.acceptedAt,
  acceptedAt: g.acceptedAt,
  revoked: !!g.revokedAt,
  active: isActive(g),
  viewCount: g.viewCount,
  lastViewedAt: g.lastViewedAt,
  officerStatus: g.officerStatus,
  statusAt: g.statusAt,
  firNumber: g.firNumber,
  requests: (g.requests ?? []).map((r) => ({ at: r.at, message: r.message })),
  recipient: recipient ? { name: recipient.name, officer: recipient.officer?.agency ? { agency: recipient.officer.agency, unit: recipient.officer.unit, verified: !!recipient.officer.verifiedAt } : undefined } : undefined,
});

// ───────── Owner: /cases/:id/shares ─────────
export const caseSharesRouter = Router({ mergeParams: true });
caseSharesRouter.use(requireAuth, requireCaseRole('owner'));

const createBody = z.object({
  email: z.string().email(),
  role: z.enum(['legal', 'investigator', 'collaborator']),
  scope: z.object({ type: z.enum(['case', 'evidence']).default('case'), evidenceIds: z.array(z.string()).max(50).default([]) }).default({}),
  expiresInDays: z.number().int().min(1).max(365).default(30),
  allowDownload: z.boolean().default(false),
});

caseSharesRouter.post(
  '/',
  validate(createBody),
  ah(async (req, res) => {
    const b = req.body;
    if (b.role === 'collaborator') { b.scope = { type: 'case', evidenceIds: [] }; b.allowDownload = false; } // helpers work on the whole case, never export
    if (b.scope.type === 'evidence' && !b.scope.evidenceIds.length) throw httpError(400, 'VALIDATION', 'Pick at least one evidence item or share the whole case');
    if (b.email.toLowerCase() === req.user.email) throw httpError(400, 'VALIDATION', 'You already own this case');
    const token = crypto.randomBytes(32).toString('base64url');
    const g = await ShareGrant.create({
      caseId: req.case._id,
      ownerId: req.user._id,
      recipientEmail: b.email,
      role: b.role,
      scope: b.scope,
      allowDownload: b.allowDownload,
      expiresAt: new Date(Date.now() + b.expiresInDays * 86_400_000),
      tokenHash: sha256Hex(token),
    });
    await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'SHARE_CREATED', target: String(g._id), payload: { role: b.role, scope: b.scope.type, expiresInDays: b.expiresInDays, allowDownload: b.allowDownload } });
    // The raw token is returned once and never stored.
    res.status(201).json({ grant: grantView(g), inviteToken: token, invitePath: `/share/accept?token=${token}` });
  }),
);

caseSharesRouter.get(
  '/',
  ah(async (req, res) => {
    const grants = await ShareGrant.find({ caseId: req.case._id }).sort({ createdAt: -1 }).lean();
    const users = await User.find({ _id: { $in: grants.map((g) => g.acceptedBy).filter(Boolean) } }, 'name officer').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({ grants: grants.map((g) => grantView(g, g.acceptedBy ? byId.get(String(g.acceptedBy)) : null)) });
  }),
);

caseSharesRouter.delete(
  '/:gid',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.gid)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const g = await ShareGrant.findOne({ _id: req.params.gid, caseId: req.case._id });
    if (!g) throw httpError(404, 'NOT_FOUND', 'Not found');
    if (!g.revokedAt) {
      g.revokedAt = new Date();
      await g.save();
      if (g.role === 'collaborator' && g.acceptedBy) {
        // Collaborators have no expiry check on every request, so revoking must remove them from the case.
        req.case.members = req.case.members.filter((m) => String(m.userId) !== String(g.acceptedBy) || m.role === 'owner');
        await req.case.save();
      }
      await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'SHARE_REVOKED', target: String(g._id) });
    }
    res.status(204).end();
  }),
);

// ───────── Recipient: /share (preview + accept) ─────────
export const shareRouter = Router();

const mask = (e) => e.replace(/^(.).*(@.*)$/, '$1•••$2');

shareRouter.get(
  '/preview',
  ah(async (req, res) => {
    const token = String(req.query.token ?? '');
    const g = token.length > 20 && (await ShareGrant.findOne({ tokenHash: sha256Hex(token) }).lean());
    if (!g) throw httpError(404, 'NOT_FOUND', 'This invite link is not valid');
    const [c, owner] = await Promise.all([Case.findOne({ _id: g.caseId, deletedAt: null }, 'title incidentType').lean(), User.findById(g.ownerId, 'name').lean()]);
    const state = g.revokedAt ? 'revoked' : g.acceptedAt ? 'accepted' : g.expiresAt <= new Date() ? 'expired' : !c ? 'revoked' : 'valid';
    res.json({
      state,
      role: g.role,
      expiresAt: g.expiresAt,
      allowDownload: g.allowDownload,
      scope: { type: g.scope?.type ?? 'case', count: g.scope?.evidenceIds?.length ?? 0 },
      recipientEmailMasked: mask(g.recipientEmail),
      owner: owner?.name,
      case: state === 'valid' ? { title: c.title, incidentType: c.incidentType } : null,
    });
  }),
);

shareRouter.post(
  '/accept',
  requireAuth,
  validate(z.object({ token: z.string().min(20) })),
  ah(async (req, res) => {
    const g = await ShareGrant.findOne({ tokenHash: sha256Hex(req.body.token) });
    if (!g) throw httpError(404, 'NOT_FOUND', 'This invite link is not valid');
    if (g.revokedAt) throw httpError(410, 'REVOKED', 'This invite was revoked');
    if (g.expiresAt <= new Date()) throw httpError(410, 'EXPIRED', 'This invite has expired');
    if (g.acceptedAt) throw httpError(409, 'ALREADY_ACCEPTED', 'This invite was already used');
    if (g.recipientEmail !== req.user.email) throw httpError(403, 'EMAIL_MISMATCH', `This invite was sent to ${mask(g.recipientEmail)}. Sign in with that address to accept it.`);
    if (g.role === 'investigator' && req.user.accountType !== 'officer') throw httpError(403, 'OFFICER_ONLY', 'Investigator access can only be accepted with an officer account');
    const c = await Case.findOne({ _id: g.caseId, deletedAt: null });
    if (!c) throw httpError(404, 'NOT_FOUND', 'This case is no longer available');
    const m = c.members.find((x) => String(x.userId) === String(req.user._id));
    if (m) m.role = g.role;
    else c.members.push({ userId: req.user._id, role: g.role });
    await c.save();
    g.acceptedBy = req.user._id;
    g.acceptedAt = new Date();
    g.statusAt = g.acceptedAt;
    await g.save();
    await audit(c._id, { actorId: req.user._id, actorRole: g.role, action: 'SHARE_ACCEPTED', target: String(g._id) });
    res.json({ caseId: String(c._id), role: g.role, expiresAt: g.expiresAt });
  }),
);

// ───────── Officer / lawyer: /officer ─────────
export const officerRouter = Router();
officerRouter.use(requireAuth);

officerRouter.get(
  '/cases',
  ah(async (req, res) => {
    const grants = await ShareGrant.find({ acceptedBy: req.user._id, revokedAt: null, role: { $in: ['legal', 'investigator'] } }).sort({ createdAt: -1 }).lean();
    const [cases, owners, counts] = await Promise.all([
      Case.find({ _id: { $in: grants.map((g) => g.caseId) }, deletedAt: null }, 'title incidentType status').lean(),
      User.find({ _id: { $in: grants.map((g) => g.ownerId) } }, 'name').lean(),
      Evidence.aggregate([{ $match: { caseId: { $in: grants.map((g) => g.caseId) } } }, { $group: { _id: '$caseId', n: { $sum: 1 } } }]),
    ]);
    const cById = new Map(cases.map((c) => [String(c._id), c]));
    const oById = new Map(owners.map((o) => [String(o._id), o.name]));
    const nById = new Map(counts.map((c) => [String(c._id), c.n]));
    const rows = grants
      .filter((g) => cById.has(String(g.caseId)))
      .map((g) => {
        const c = cById.get(String(g.caseId));
        return {
          grantId: String(g._id),
          caseId: String(g.caseId),
          title: c.title,
          incidentType: c.incidentType,
          caseStatus: c.status,
          ownerName: oById.get(String(g.ownerId)) ?? 'Complainant',
          role: g.role,
          evidenceCount: g.scope?.type === 'evidence' ? g.scope.evidenceIds.length : nById.get(String(g.caseId)) ?? 0,
          scopeType: g.scope?.type ?? 'case',
          sharedAt: g.createdAt,
          expiresAt: g.expiresAt,
          active: isActive(g),
          officerStatus: g.officerStatus,
          firNumber: g.firNumber,
          lastViewedAt: g.lastViewedAt,
          allowDownload: g.allowDownload,
        };
      });
    const soon = Date.now() + 7 * 86_400_000;
    res.json({
      cases: rows,
      stats: {
        newShares: rows.filter((r) => r.active && r.officerStatus === 'received').length,
        underReview: rows.filter((r) => r.active && ['under_review', 'needs_evidence'].includes(r.officerStatus)).length,
        expiringSoon: rows.filter((r) => r.active && new Date(r.expiresAt).getTime() < soon).length,
        total: rows.length,
      },
    });
  }),
);

// Everything below acts on one case the caller currently has an active grant for.
const officerCase = requireCaseRole('legal', 'investigator');

officerRouter.get('/cases/:id/grant', officerCase, (req, res) => res.json({ grant: grantView(req.grant), notesLength: req.grant.notes.length }));

// FIR / case status is a police action: lawyers (role 'legal') can read, request evidence and keep notes, but not set it.
officerRouter.patch(
  '/cases/:id/status',
  requireCaseRole('investigator'),
  validate(z.object({ status: z.enum(['received', 'under_review', 'needs_evidence', 'fir_registered', 'closed']), firNumber: z.string().max(60).optional() })),
  ah(async (req, res) => {
    const { status, firNumber } = req.body;
    if (status === 'fir_registered' && !(firNumber || req.grant.firNumber)) throw httpError(400, 'VALIDATION', 'Enter the FIR / complaint number');
    req.grant.officerStatus = status;
    req.grant.statusAt = new Date();
    if (firNumber !== undefined) req.grant.firNumber = firNumber;
    await req.grant.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'OFFICER_STATUS_CHANGED', target: String(req.grant._id), payload: { status, firNumber: req.grant.firNumber } });
    res.json({ grant: grantView(req.grant) });
  }),
);

officerRouter.post(
  '/cases/:id/requests',
  officerCase,
  validate(z.object({ message: z.string().min(3).max(500) })),
  ah(async (req, res) => {
    req.grant.requests.push({ at: new Date(), by: req.user._id, message: req.body.message });
    req.grant.officerStatus = 'needs_evidence';
    req.grant.statusAt = new Date();
    await req.grant.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_REQUESTED', target: String(req.grant._id) });
    res.status(201).json({ grant: grantView(req.grant) });
  }),
);

officerRouter.get('/cases/:id/notes', officerCase, (req, res) => res.json({ notes: req.grant.notes }));
officerRouter.put(
  '/cases/:id/notes',
  officerCase,
  validate(z.object({ notes: z.string().max(5000) })),
  ah(async (req, res) => {
    req.grant.notes = req.body.notes; // private to the recipient; never in exports unless chosen
    await req.grant.save();
    res.json({ ok: true });
  }),
);

// ───────── Government oversight: /oversight (aggregates only) ─────────
export const oversightRouter = Router();
oversightRouter.use(
  requireAuth,
  ah(async (req, _res, next) => {
    if (req.user.accountType !== 'official' && !req.user.isAdmin) throw httpError(403, 'FORBIDDEN', 'Oversight accounts only');
    next();
  }),
);

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const hours = (ms) => Math.round((ms / 3_600_000) * 10) / 10;

oversightRouter.get(
  '/summary',
  ah(async (req, res) => {
    const minCell = config.OVERSIGHT_MIN_CELL;
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), type: z.string().optional(), unit: z.string().optional() }).parse(req.query);
    const created = {};
    if (q.from) created.$gte = new Date(q.from);
    if (q.to) created.$lte = new Date(q.to);
    const grants = await ShareGrant.find({ role: 'investigator', ...(Object.keys(created).length ? { createdAt: created } : {}) }).lean();
    const [cases, officers] = await Promise.all([
      Case.find({ _id: { $in: grants.map((g) => g.caseId) } }, 'incidentType').lean(),
      User.find({ accountType: 'officer' }, 'officer').lean(),
    ]);
    const typeOf = new Map(cases.map((c) => [String(c._id), c.incidentType]));
    const unitOf = new Map(officers.map((o) => [String(o._id), o.officer?.unit || 'Unassigned']));
    const rows = grants
      .map((g) => ({ ...g, type: typeOf.get(String(g.caseId)) ?? 'other', unit: g.acceptedBy ? unitOf.get(String(g.acceptedBy)) ?? 'Unassigned' : 'Not yet accepted' }))
      .filter((g) => (!q.type || g.type === q.type) && (!q.unit || g.unit === q.unit));

    // Small counts are suppressed so no individual case can be inferred.
    const cell = (n) => (n > 0 && n < minCell ? { n: null, suppressed: true } : { n, suppressed: false });
    const accepted = rows.filter((g) => g.acceptedAt);
    const funnel = [
      ['Shared', rows.length],
      ['Accepted', accepted.length],
      ['Under review', accepted.filter((g) => STATUS_ORDER[g.officerStatus] >= 2).length],
      ['FIR registered', accepted.filter((g) => STATUS_ORDER[g.officerStatus] >= 3).length],
      ['Closed', accepted.filter((g) => g.officerStatus === 'closed').length],
    ].map(([label, n]) => ({ label, ...cell(n) }));

    const byMonth = new Map();
    for (const g of rows) {
      const m = g.createdAt.toISOString().slice(0, 7);
      const e = byMonth.get(m) ?? {};
      e[g.type] = (e[g.type] ?? 0) + 1;
      byMonth.set(m, e);
    }
    const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, counts]) => ({
      month,
      total: cell(Object.values(counts).reduce((s, n) => s + n, 0)),
      byType: Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, cell(n)])),
    }));

    const byUnit = new Map();
    for (const g of rows) {
      const u = byUnit.get(g.unit) ?? { unit: g.unit, shares: 0, open: 0, overdue: 0, officers: new Set(), accept: [] };
      u.shares += 1;
      if (g.acceptedBy) u.officers.add(String(g.acceptedBy));
      if (g.acceptedAt) u.accept.push(g.acceptedAt - g.createdAt);
      if (isActive(g) && g.officerStatus !== 'closed' && g.acceptedAt) u.open += 1;
      if (isActive(g) && g.officerStatus === 'received' && g.acceptedAt && Date.now() - g.acceptedAt > 3 * 86_400_000) u.overdue += 1;
      byUnit.set(g.unit, u);
    }

    const toFir = accepted.filter((g) => STATUS_ORDER[g.officerStatus] >= 3 && g.statusAt).map((g) => g.statusAt - g.acceptedAt);
    const verified = await AuditEntry.countDocuments({ action: 'CASE_VERIFIED', actorRole: { $in: ['investigator', 'legal'] } });
    const m1 = median(accepted.map((g) => g.acceptedAt - g.createdAt));
    const m2 = median(toFir);
    res.json({
      minCell,
      generatedAt: new Date(),
      tiles: {
        shared: cell(rows.length),
        medianHoursToAccept: m1 == null ? null : hours(m1),
        medianHoursToFir: m2 == null ? null : hours(m2),
        verificationsRun: cell(verified),
        expiredWithoutAction: cell(rows.filter((g) => !g.revokedAt && g.expiresAt <= new Date() && g.officerStatus === 'received').length),
      },
      funnel,
      months,
      types: [...new Set(rows.map((g) => g.type))],
      units: [...byUnit.values()].map((u) => ({
        unit: u.unit,
        officers: cell(u.officers.size),
        shares: cell(u.shares),
        open: cell(u.open),
        overdue: cell(u.overdue),
        medianHoursToAccept: u.accept.length >= minCell || minCell <= 1 ? (median(u.accept) == null ? null : hours(median(u.accept))) : null,
      })),
    });
  }),
);

// ───────── Platform admin: /admin (no case content) ─────────
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

const userView = (u) => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  accountType: u.accountType ?? 'citizen',
  isAdmin: u.isAdmin,
  disabled: u.disabled,
  createdAt: u.createdAt,
  officer: u.officer?.agency ? { agency: u.officer.agency, unit: u.officer.unit, rank: u.officer.rank, badgeId: u.officer.badgeId, verifiedAt: u.officer.verifiedAt, rejectedAt: u.officer.rejectedAt, rejectReason: u.officer.rejectReason } : undefined,
});

adminRouter.get(
  '/users',
  ah(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const filter = q ? { $or: [{ email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] } : {};
    res.json({ users: (await User.find(filter).sort({ createdAt: -1 }).limit(200).lean()).map(userView) });
  }),
);

adminRouter.patch(
  '/users/:uid',
  validate(z.object({ disabled: z.boolean() })),
  ah(async (req, res) => {
    if (String(req.params.uid) === String(req.user._id)) throw httpError(400, 'VALIDATION', 'You cannot disable your own account');
    const u = await User.findByIdAndUpdate(req.params.uid, { disabled: req.body.disabled }, { new: true });
    if (!u) throw httpError(404, 'NOT_FOUND', 'Not found');
    await audit(`user:${u._id}`, { actorId: req.user._id, actorRole: 'admin', action: req.body.disabled ? 'USER_DISABLED' : 'USER_ENABLED', target: String(u._id) });
    res.json({ user: userView(u) });
  }),
);

adminRouter.post(
  '/users',
  validate(z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(10).max(200), accountType: z.literal('official') })),
  ah(async (req, res) => {
    if (await User.exists({ email: req.body.email.toLowerCase() })) throw httpError(409, 'EMAIL_TAKEN', 'Email already registered');
    const u = await User.create({ email: req.body.email, name: req.body.name, accountType: 'official', passwordHash: await argon2.hash(req.body.password, { type: argon2.argon2id }) });
    await audit(`user:${u._id}`, { actorId: req.user._id, actorRole: 'admin', action: 'OFFICIAL_CREATED', target: String(u._id) });
    res.status(201).json({ user: userView(u) });
  }),
);

adminRouter.get(
  '/officers/pending',
  ah(async (_req, res) => {
    const users = await User.find({ accountType: 'officer', 'officer.verifiedAt': null, 'officer.rejectedAt': null }).sort({ createdAt: 1 }).lean();
    res.json({ officers: users.map(userView) });
  }),
);

adminRouter.post(
  '/officers/:uid/verify',
  validate(z.object({ approve: z.boolean(), reason: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const u = await User.findOne({ _id: req.params.uid, accountType: 'officer' });
    if (!u) throw httpError(404, 'NOT_FOUND', 'Not found');
    if (req.body.approve) {
      u.officer.verifiedAt = new Date();
      u.officer.verifiedBy = req.user._id;
      u.officer.rejectedAt = undefined;
    } else {
      if (!req.body.reason) throw httpError(400, 'VALIDATION', 'Give a reason for rejecting');
      u.officer.rejectedAt = new Date();
      u.officer.rejectReason = req.body.reason;
      u.officer.verifiedAt = undefined;
    }
    await u.save();
    await audit(`user:${u._id}`, { actorId: req.user._id, actorRole: 'admin', action: req.body.approve ? 'OFFICER_VERIFIED' : 'OFFICER_REJECTED', target: String(u._id) });
    res.json({ user: userView(u) });
  }),
);

adminRouter.get(
  '/usage',
  ah(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const rows = await ProviderUsage.aggregate([
      { $match: { ts: { $gte: new Date(Date.now() - days * 86_400_000) } } },
      { $group: { _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, provider: '$provider' }, calls: { $sum: 1 }, audioSeconds: { $sum: { $ifNull: ['$audioSeconds', 0] } }, chars: { $sum: { $ifNull: ['$chars', 0] } } } },
      { $sort: { '_id.day': 1 } },
    ]);
    res.json({
      usage: rows.map((r) => ({ day: r._id.day, provider: r._id.provider ?? 'unknown', calls: r.calls, audioSeconds: Math.round(r.audioSeconds), chars: r.chars })),
      softCap: { audioSecondsPerDay: config.SARVAM_DAILY_AUDIO_SEC_CAP, usedToday: Math.round(await sarvamAudioSecondsToday()) },
    });
  }),
);

// Admin-only health detail (spec O3): real checks, not assumptions. Public /health stays status-only.
adminRouter.get(
  '/health',
  ah(async (_req, res) => {
    const db = mongoose.connection.readyState === 1 ? 'ok' : 'down';
    let gridfs = { status: 'down', files: 0 };
    try {
      gridfs = { status: 'ok', files: await mongoose.connection.db.collection('evidence.files').estimatedDocumentCount() };
    } catch { /* leave as down */ }
    let ml = { status: 'down' };
    try {
      const r = await fetch(`${config.ML_BASE_URL}/health`, { headers: { 'X-Internal-Secret': config.ML_INTERNAL_SECRET }, signal: AbortSignal.timeout(3000) });
      if (r.ok) ml = await r.json();
    } catch { /* leave as down */ }
    res.json({ db, gridfs, ml });
  }),
);

adminRouter.get(
  '/jobs',
  ah(async (_req, res) => {
    const jobs = await Job.find({}).sort({ updatedAt: -1 }).limit(100).lean();
    res.json({
      jobs: jobs.map((j) => ({ id: String(j._id), type: j.type, status: j.status, attempts: j.attempts ?? 0, runAt: j.runAt, updatedAt: j.updatedAt, error: j.error ? String(j.error).slice(0, 200) : undefined })),
      counts: jobs.reduce((m, j) => ({ ...m, [j.status]: (m[j.status] ?? 0) + 1 }), {}),
    });
  }),
);

adminRouter.post(
  '/jobs/:jid/retry',
  ah(async (req, res) => {
    const j = await Job.findOneAndUpdate({ _id: req.params.jid, status: 'failed' }, { $set: { status: 'queued', runAt: new Date(), lockedBy: null, lockedUntil: null } }, { new: true });
    if (!j) throw httpError(404, 'NOT_FOUND', 'Only failed jobs can be retried');
    res.json({ ok: true });
  }),
);
