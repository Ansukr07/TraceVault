// Trusted timestamps (future spec F2). Lists and verifies RFC 3161 tokens; downloads raw .tsr files.
//   list: owner, collaborator, legal, investigator (scoped) · anchor: owner · verify: any member · token: any member (scoped)
import mongoose from 'mongoose';
import { Router } from 'express';
import { ah, httpError, requireAuth, requireCaseRole } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { Case, Evidence, Timestamp } from '../models/index.js';
import { evidenceAllowed, resolveAccess, scopeFor } from '../services/scope.js';
import { anchorCase, timestampsEnabled, tsaList, verifyTimestampDoc } from '../services/timestamps.js';

export const caseTimestampsRouter = Router({ mergeParams: true });
export const timestampRouter = Router();
caseTimestampsRouter.use(requireAuth);
timestampRouter.use(requireAuth);

const view = (t, idxById) => ({
  id: String(t._id),
  type: t.subject.type,
  ref: t.subject.ref,
  evidenceIdx: t.subject.type === 'evidence' ? idxById.get(t.subject.ref) ?? null : null,
  hash: t.subject.hash,
  protocol: t.protocol,
  tsa: t.tsa?.name ?? null,
  genTime: t.genTime ?? null,
  serial: t.serial ?? null,
  status: t.status,
  trust: t.trust,
  attempts: t.attempts,
  lastError: t.lastError ?? null,
  verifiedAt: t.verifiedAt ?? null,
  hasToken: !!t.token,
  createdAt: t.createdAt,
});

// Evidence-subject stamps are only visible when the evidence is in the viewer's scope.
async function visible(req, filter = {}) {
  const scope = await scopeFor(req);
  const docs = await Timestamp.find({ caseId: req.case._id, ...filter }, '-token').sort({ createdAt: -1 }).lean();
  const ev = await Evidence.find({ caseId: req.case._id }, 'idx').lean();
  const idxById = new Map(ev.map((e) => [String(e._id), e.idx]));
  return { docs: docs.filter((t) => t.subject.type !== 'evidence' || evidenceAllowed(scope, t.subject.ref)), idxById };
}

caseTimestampsRouter.get(
  '/',
  requireCaseRole('owner', 'collaborator', 'legal', 'investigator'),
  ah(async (req, res) => {
    const filter = req.query.evidenceId ? { 'subject.type': 'evidence', 'subject.ref': String(req.query.evidenceId) } : {};
    const { docs, idxById } = await visible(req, filter);
    res.json({
      enabled: timestampsEnabled(),
      authorities: tsaList().map((t) => t.name),
      summary: { total: docs.length, issued: docs.filter((t) => ['issued', 'verified'].includes(t.status)).length, pending: docs.filter((t) => t.status === 'pending').length, failed: docs.filter((t) => t.status === 'failed').length },
      timestamps: docs.map((t) => view(t, idxById)),
    });
  }),
);

caseTimestampsRouter.post(
  '/anchor',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    if (!timestampsEnabled()) throw httpError(409, 'TIMESTAMPS_DISABLED', 'No time-stamp authority is configured on this server');
    const out = await anchorCase(req.case._id);
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'TIMESTAMP_ANCHOR_REQUESTED', target: String(req.case._id), payload: { created: out.created.length } });
    res.status(202).json({ queued: out.created.length });
  }),
);

caseTimestampsRouter.post(
  '/verify',
  requireCaseRole(),
  ah(async (req, res) => {
    const { docs, idxById } = await visible(req, { token: { $exists: true } });
    const out = [];
    for (const t of docs) {
      const doc = await Timestamp.findById(t._id);
      const r = await verifyTimestampDoc(doc);
      out.push({ ...view(doc.toObject(), idxById), check: { ok: r.ok, trust: r.trust, errors: r.errors, current: r.current } });
    }
    res.json({ verified: out.filter((o) => o.check.ok).length, failed: out.filter((o) => !o.check.ok).length, timestamps: out });
  }),
);

timestampRouter.get(
  '/:tid/token',
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.tid)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const t = await Timestamp.findById(req.params.tid);
    const c = t && (await Case.findOne({ _id: t.caseId, deletedAt: null, 'members.userId': req.user._id }));
    const access = c && (await resolveAccess(c, req.user));
    if (!t?.token || !access) throw httpError(404, 'NOT_FOUND', 'Not found');
    if (access.grant && t.subject.type === 'evidence') {
      const scope = await scopeFor({ role: access.role, grant: access.grant });
      if (!evidenceAllowed(scope, t.subject.ref)) throw httpError(404, 'NOT_FOUND', 'Not found');
    }
    res.set({ 'Content-Type': 'application/timestamp-reply', 'Content-Disposition': `attachment; filename="${t.subject.type}-${String(t._id).slice(-6)}.tsr"`, 'Cache-Control': 'no-store' });
    res.end(t.token);
  }),
);
