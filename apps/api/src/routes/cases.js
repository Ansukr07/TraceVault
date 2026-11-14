import { Router } from 'express';
import { Case, Evidence, AuditEntry } from '../models/index.js';
import { ah, requireAuth, requireCaseRole, validate, z, httpError } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { merkleRoot } from '../services/merkle.js';
import { verifyChain } from '../services/audit-chain.js';

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
    // Soft delete for now; crypto-shred (destroy wrapped keys) arrives with the evidence lifecycle work.
    req.case.deletedAt = new Date();
    await req.case.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: 'owner', action: 'CASE_DELETED', target: String(req.case._id) });
    res.status(204).end();
  }),
);
