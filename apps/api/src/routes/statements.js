// Voice statement drafts (spec §6.4, §10.1): list latest drafts, save edits as new versions, apply suggestions.
// A self-statement is the complainant's own account: it is listed and exported as such and never corroborates itself.
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Router } from 'express';
import { Case, Evidence, Statement } from '../models/index.js';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { evidenceAllowed, resolveAccess, scopeFor } from '../services/scope.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const view = (s, e, versions) => ({
  id: String(s._id),
  evidenceId: String(s.evidenceId),
  evidence: e && { idx: e.idx, filename: e.filename, status: e.status, durationMs: e.durationMs, provider: e.provider, detectedLang: e.detectedLang, createdAt: e.createdAt },
  version: s.version,
  versions: versions.map((v) => ({ id: String(v._id), version: v.version, createdAt: v.createdAt, edited: !!v.editedBy })),
  lang: s.lang,
  textNative: s.textNative,
  textEn: s.textEn,
  sentences: s.sentences,
  suggestions: s.suggestions,
  appliedSuggestions: s.appliedSuggestions ?? [],
  generator: s.generator,
  edited: !!s.editedBy,
  createdAt: s.createdAt,
});

// /cases/:id/statements
export const caseStatementsRouter = Router({ mergeParams: true });
caseStatementsRouter.use(requireAuth);

caseStatementsRouter.get(
  '/',
  requireCaseRole('owner', 'collaborator', 'legal'),
  ah(async (req, res) => {
    const scope = await scopeFor(req);
    const evs = await Evidence.find({ caseId: req.case._id, kind: 'statement', ...(scope ? { _id: { $in: [...scope.ids] } } : {}) }).sort({ idx: 1 }).lean();
    const all = await Statement.find({ evidenceId: { $in: evs.map((e) => e._id) } }).sort({ version: -1 }).lean();
    const out = [];
    for (const e of evs) {
      const versions = all.filter((s) => String(s.evidenceId) === String(e._id));
      out.push({ evidenceId: String(e._id), evidence: { idx: e.idx, filename: e.filename, status: e.status, error: e.error, durationMs: e.durationMs, provider: e.provider, detectedLang: e.detectedLang, createdAt: e.createdAt }, statement: versions[0] ? view(versions[0], e, versions) : null });
    }
    res.json({ statements: out });
  }),
);

// /statements/:sid
export const statementRouter = Router();
statementRouter.use(requireAuth);

const loadStatement = (...roles) =>
  ah(async (req, _res, next) => {
    if (!mongoose.isValidObjectId(req.params.sid)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const s = await Statement.findById(req.params.sid);
    const c = s && (await Case.findOne({ _id: s.caseId, deletedAt: null, 'members.userId': req.user._id }));
    const access = c && (await resolveAccess(c, req.user));
    if (!access) throw httpError(404, 'NOT_FOUND', 'Not found');
    req.grant = access.grant;
    req.role = access.role;
    if (access.grant && !evidenceAllowed(await scopeFor(req), s.evidenceId)) throw httpError(404, 'NOT_FOUND', 'Not found');
    if (!roles.includes(access.role)) throw httpError(403, 'FORBIDDEN', 'Insufficient role');
    req.statement = s;
    req.case = c;
    next();
  });

// Saving an edit creates version n+1 (nothing is overwritten) and is audited by hash, not content.
statementRouter.patch(
  '/:sid',
  loadStatement('owner', 'collaborator'),
  validate(z.object({
    textNative: z.string().max(20000).optional(),
    sentences: z.array(z.object({ text: z.string().min(1).max(2000), citations: z.array(z.string().regex(/^E\d+:\d+$/)).max(8) })).max(300).optional(),
    note: z.string().max(500).optional(),
  })),
  ah(async (req, res) => {
    const prev = req.statement;
    const latest = await Statement.findOne({ evidenceId: prev.evidenceId }).sort({ version: -1 }).lean();
    const sentences = req.body.sentences ?? prev.sentences;
    const next = await Statement.create({
      caseId: prev.caseId, evidenceId: prev.evidenceId, version: latest.version + 1, lang: prev.lang,
      textNative: req.body.textNative ?? prev.textNative, textEn: sentences.map((x) => x.text).join(' '), sentences,
      suggestions: prev.suggestions, appliedSuggestions: prev.appliedSuggestions, generator: prev.generator, editedBy: req.user._id, note: req.body.note,
    });
    await audit(prev.caseId, { actorId: req.user._id, actorRole: req.role, action: 'STATEMENT_EDITED', target: String(next._id), payload: { version: next.version, textSha256: sha(`${next.textNative}\n${next.textEn}`) } });
    const versions = await Statement.find({ evidenceId: prev.evidenceId }).sort({ version: -1 }).lean();
    res.json({ statement: view(next.toObject(), null, versions) });
  }),
);

// Nothing is applied without an explicit click: the owner chooses which suggestions to copy into the case.
statementRouter.post(
  '/:sid/suggestions/apply',
  loadStatement('owner'),
  validate(z.object({
    incidentType: z.enum(['harassment', 'fraud', 'stalking', 'sextortion', 'other']).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    appendSummary: z.boolean().optional(),
  })),
  ah(async (req, res) => {
    const c = req.case;
    const b = req.body;
    const applied = [];
    if (b.incidentType) { c.incidentType = b.incidentType; applied.push(`incidentType:${b.incidentType}`); }
    if (b.tags?.length) {
      c.tags = [...new Set([...(c.tags ?? []), ...b.tags])].slice(0, 20);
      applied.push(...b.tags.map((t) => `tag:${t}`));
    }
    if (b.appendSummary) {
      const line = `Statement (${new Date().toISOString().slice(0, 10)}): ${req.statement.textEn.slice(0, 500)}`;
      c.description = `${c.description ? `${c.description}\n\n` : ''}${line}`.slice(0, 5000);
      applied.push('description');
    }
    if (!applied.length) throw httpError(400, 'NOTHING_SELECTED', 'Select at least one suggestion to apply');
    await c.save();
    await Statement.updateOne({ _id: req.statement._id }, { $addToSet: { appliedSuggestions: { $each: applied } } });
    await audit(c._id, { actorId: req.user._id, actorRole: 'owner', action: 'STATEMENT_SUGGESTIONS_APPLIED', target: String(req.statement._id), payload: { applied } });
    res.json({ applied, incidentType: c.incidentType, tags: c.tags });
  }),
);
