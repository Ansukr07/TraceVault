import { Router } from 'express';
import {
  Annotation, AuditEntry, Case, CaseSnapshot, Chunk, Decision, DerivedArtifact, DuplicateGroup, Entity, Evidence,
  Inconsistency, Speaker, Statement, Summary, TimelineEvent,
} from '../models/index.js';
import { bucket } from '../services/evidence-store.js';
import { ah, requireAuth, requireCaseRole, validate, z, httpError } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { merkleRoot } from '../services/merkle.js';
import { verifyChain } from '../services/audit-chain.js';
import { stamp } from '../services/timestamp.js';

export const casesRouter = Router();
casesRouter.use(requireAuth);

const createBody = z.object({
  title: z.string().min(1).max(200),
  incidentType: z.enum(['harassment', 'fraud', 'stalking', 'sextortion', 'other']).default('other'),
  description: z.string().max(5000).default(''),
  tags: z.array(z.string().max(40)).max(20).default([]),
  // Voice audio can't be redacted before STT, so Sarvam needs explicit consent (spec 5.12).
  voiceConsent: z.boolean().default(false),
});

const view = (c, role) => ({
  id: String(c._id),
  title: c.title,
  incidentType: c.incidentType,
  description: c.description,
  tags: c.tags,
  status: c.status,
  timezone: c.timezone,
  settings: c.settings,
  sealedAt: c.sealedAt ?? null,
  sealedRoot: c.sealedRoot ?? null,
  addendumOf: c.addendumOf ? String(c.addendumOf) : null,
  role,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

casesRouter.post(
  '/',
  validate(createBody),
  ah(async (req, res) => {
    const { voiceConsent, ...fields } = req.body;
    const c = await Case.create({
      ...fields,
      members: [{ userId: req.user._id, role: 'owner' }],
      settings: voiceConsent
        ? { voiceMode: 'sarvam', voiceConsentAt: new Date(), voiceConsentBy: req.user._id }
        : { voiceMode: 'local' },
    });
    await audit(c._id, { actorId: req.user._id, actorRole: 'owner', action: 'CASE_CREATED', target: String(c._id), payload: { title: c.title, voiceMode: c.settings.voiceMode } });
    res.status(201).json({ case: view(c, 'owner') });
  }),
);

casesRouter.get(
  '/',
  ah(async (req, res) => {
    const cases = await Case.find({ deletedAt: null, 'members.userId': req.user._id }).sort({ updatedAt: -1 }).lean();
    const counts = await Evidence.aggregate([{ $match: { caseId: { $in: cases.map((c) => c._id) } } }, { $group: { _id: '$caseId', n: { $sum: 1 } } }]);
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({
      cases: cases.map((c) => ({
        ...view(c, c.members.find((m) => String(m.userId) === String(req.user._id)).role),
        evidenceCount: byId.get(String(c._id)) ?? 0,
      })),
    });
  }),
);

// Seal (C6): owner freezes the evidence set. The Merkle root and audit head are written to the chain so a later
// addition is visible as a different root. Uploads then go into a new linked addendum case.
casesRouter.post(
  '/:id/seal',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    if (req.case.sealedAt) throw httpError(409, 'ALREADY_SEALED', 'This case is already sealed');
    const items = await Evidence.find({ caseId: req.case._id }, 'sha256 status').lean();
    if (!items.length) throw httpError(400, 'EMPTY', 'Add evidence before sealing');
    if (items.some((e) => e.status === 'uploaded' || e.status === 'processing')) throw httpError(409, 'STILL_PROCESSING', 'Wait for processing to finish before sealing');
    const head = await AuditEntry.findOne({ caseId: String(req.case._id) }).sort({ seq: -1 }).lean();
    req.case.sealedAt = new Date();
    req.case.sealedBy = req.user._id;
    req.case.sealedRoot = merkleRoot(items.map((e) => e.sha256));
    await req.case.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'CASE_SEALED', target: String(req.case._id), payload: { merkleRoot: req.case.sealedRoot, evidenceCount: items.length, auditHead: head?.hash ?? null } });
    res.json({ case: view(req.case, 'owner') });
  }),
);

// V7: anchor the current Merkle root publicly. Explicit owner action: the 32-byte root (no content) goes to public calendars.
casesRouter.post(
  '/:id/timestamp',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    const items = await Evidence.find({ caseId: req.case._id }, 'sha256').lean();
    if (!items.length) throw httpError(400, 'EMPTY', 'Add evidence first');
    const root = merkleRoot(items.map((e) => e.sha256));
    let r;
    try {
      r = await stamp(root);
    } catch (e) {
      throw httpError(502, 'TIMESTAMP_FAILED', e.message);
    }
    req.case.timestamps.push({ root, calendar: r.calendar, at: new Date(), ots: r.ots });
    await req.case.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'ROOT_TIMESTAMPED', target: String(req.case._id), payload: { merkleRoot: root, calendar: r.calendar } });
    res.status(201).json({ timestamp: { root, calendar: r.calendar, at: req.case.timestamps.at(-1).at } });
  }),
);

casesRouter.get(
  '/:id/timestamps',
  requireCaseRole('owner', 'legal', 'investigator'),
  (req, res) => res.json({ timestamps: req.case.timestamps.map((t, i) => ({ index: i, root: t.root, calendar: t.calendar, at: t.at })) }),
);

casesRouter.get(
  '/:id/timestamps/:i.ots',
  requireCaseRole('owner', 'legal', 'investigator'),
  (req, res) => {
    const t = req.case.timestamps[Number(req.params.i)];
    if (!t) throw httpError(404, 'NOT_FOUND', 'No such timestamp');
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="merkle-root-${t.root.slice(0, 8)}.ots"` }).send(t.ots);
  },
);

casesRouter.post(
  '/:id/addendum',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    if (!req.case.sealedAt) throw httpError(409, 'NOT_SEALED', 'Only a sealed case needs an addendum');
    const c = await Case.create({
      title: `${req.case.title} (addendum)`.slice(0, 200),
      incidentType: req.case.incidentType,
      description: `Addendum to "${req.case.title}". The original case is sealed.`,
      tags: req.case.tags,
      timezone: req.case.timezone,
      settings: req.case.settings,
      addendumOf: req.case._id,
      members: [{ userId: req.user._id, role: 'owner' }],
    });
    await audit(c._id, { actorId: req.user._id, actorRole: 'owner', action: 'CASE_CREATED', target: String(c._id), payload: { title: c.title, addendumOf: String(req.case._id) } });
    await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'ADDENDUM_CREATED', target: String(c._id) });
    res.status(201).json({ case: view(c, 'owner') });
  }),
);

casesRouter.get('/:id', requireCaseRole(), (req, res) => res.json({ case: view(req.case, req.role) }));

casesRouter.patch(
  '/:id',
  requireCaseRole('owner', 'collaborator'),
  validate(createBody.pick({ title: true, incidentType: true, description: true, tags: true }).partial()),
  ah(async (req, res) => {
    Object.assign(req.case, req.body);
    await req.case.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'CASE_UPDATED', target: String(req.case._id), payload: req.body });
    res.json({ case: view(req.case, req.role) });
  }),
);

// Integrity: rehash chain + report Merkle root over evidence hashes (file rehash comes with the GridFS verifier).
casesRouter.get(
  '/:id/audit',
  requireCaseRole(),
  ah(async (req, res) => {
    const entries = await AuditEntry.find({ caseId: String(req.case._id) }).sort({ seq: 1 }).lean();
    const ev = await Evidence.find({ caseId: req.case._id }, 'sha256').lean();
    res.json({ chain: verifyChain(String(req.case._id), entries), merkleRoot: merkleRoot(ev.map((e) => e.sha256)), entries });
  }),
);

casesRouter.delete(
  '/:id',
  requireCaseRole('owner'),
  validate(z.object({ confirmTitle: z.string() })),
  ah(async (req, res) => {
    if (req.body.confirmTitle !== req.case.title) throw httpError(400, 'CONFIRM_MISMATCH', 'Type the case title to confirm');
    // Crypto-shred (spec C5): the Merkle root is captured first, then derived data and ciphertext are purged and the
    // wrapped data keys destroyed. Evidence rows stay as hash tombstones (filename, size, sha256) so the audit chain still verifies.
    const cid = req.case._id;
    const items = await Evidence.find({ caseId: cid }).lean();
    const root = merkleRoot(items.map((e) => e.sha256));
    for (const M of [Chunk, DerivedArtifact, Entity, TimelineEvent, DuplicateGroup, Inconsistency, Decision, CaseSnapshot, Summary, Statement, Annotation, Speaker]) {
      await M.deleteMany({ caseId: cid });
    }
    for (const e of items) {
      if (e.storage?.fileId) await bucket().delete(e.storage.fileId).catch(() => {}); // already gone is fine
    }
    await Evidence.updateMany({ caseId: cid }, { $unset: { 'enc.key': '', 'storage.fileId': '', metadata: '', flags: '', hashes: '' }, $set: { status: 'failed', error: 'Shredded' } });
    req.case.deletedAt = new Date();
    await req.case.save();
    await audit(cid, { actorId: req.user._id, actorRole: 'owner', action: 'CASE_DELETED', target: String(cid), payload: { merkleRoot: root, evidenceCount: items.length, shredded: true } });
    res.status(204).end();
  }),
);
