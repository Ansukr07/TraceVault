import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { config } from '../config.js';
import { Case, Chunk, DerivedArtifact, Evidence } from '../models/index.js';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { hashFile, openPlain, sealFile, verifyStored } from '../services/evidence-store.js';
import { enqueueEvidence } from '../jobs/pipeline.js';

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_r, _f, cb) => cb(null, `tv-${crypto.randomUUID()}`) }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

export const view = (e) => ({
  id: String(e._id),
  caseId: String(e.caseId),
  idx: e.idx,
  filename: e.filename,
  kind: e.kind,
  mime: e.mime,
  size: e.size,
  sha256: e.sha256,
  sourceLabel: e.sourceLabel,
  parentEvidenceId: e.parentEvidenceId ? String(e.parentEvidenceId) : null,
  duplicateOf: e.duplicateOf ? String(e.duplicateOf) : null,
  status: e.status,
  error: e.error ?? null,
  metadata: e.metadata ?? {},
  flags: e.flags ?? [],
  durationMs: e.durationMs ?? null,
  detectedLang: e.detectedLang ?? null,
  provider: e.provider ?? null,
  redacted: !!e.redacted?.at,
  createdAt: e.createdAt,
});

const bodySchema = z.object({
  clientSha256: z.string().regex(/^[a-f0-9]{64}$/i, 'must be a 64-char hex SHA-256'),
  sourceLabel: z.string().max(120).default(''),
  kind: z.enum(['statement']).optional(),
});

// Evidence routes under /cases/:id/evidence
export const caseEvidenceRouter = Router({ mergeParams: true });
caseEvidenceRouter.use(requireAuth);

caseEvidenceRouter.get(
  '/',
  requireCaseRole(),
  ah(async (req, res) => {
    const items = await Evidence.find({ caseId: req.case._id }).sort({ idx: 1, createdAt: 1 }).lean();
    const counts = await Chunk.aggregate([
      { $match: { caseId: req.case._id } },
      { $group: { _id: '$evidenceId', n: { $sum: 1 }, sev: { $max: '$severity.score' } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    res.json({
      evidence: items.map((e) => ({ ...view(e), chunkCount: byId.get(String(e._id))?.n ?? 0, maxSeverity: byId.get(String(e._id))?.sev ?? 0 })),
    });
  }),
);

caseEvidenceRouter.post(
  '/',
  requireCaseRole('owner', 'collaborator'),
  upload.single('file'),
  ah(async (req, res) => {
    const tmp = req.file?.path;
    try {
      if (!req.file) throw httpError(400, 'NO_FILE', 'Attach a file in the "file" field');
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw httpError(400, 'VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const { clientSha256, sourceLabel, kind: requestedKind } = parsed.data;

      if ((await Evidence.countDocuments({ caseId: req.case._id, parentEvidenceId: null })) >= config.MAX_FILES_PER_CASE) {
        throw httpError(409, 'CASE_FULL', `Max ${config.MAX_FILES_PER_CASE} files per case`);
      }
      const sha256 = await hashFile(tmp);
      if (sha256 !== clientSha256.toLowerCase()) throw httpError(422, 'HASH_MISMATCH', 'Client and server SHA-256 differ; nothing was stored');

      const { evidence: doc, duplicateOf } = await sealFile({
        caseDoc: req.case,
        tmpPath: tmp,
        originalName: req.file.originalname,
        sha256,
        uploadedBy: req.user._id,
        actorRole: req.role,
        sourceLabel,
        requestedKind,
        size: req.file.size,
      });
      if (req.case.status !== 'processing') await Case.updateOne({ _id: req.case._id }, { $set: { status: 'processing' } });
      // Exact duplicates are sealed and recorded but not re-processed: they share the canonical item's content.
      if (!duplicateOf) await enqueueEvidence(doc);
      else await Evidence.updateOne({ _id: doc._id }, { $set: { status: 'done' } });
      res.status(201).json({ evidence: view(doc), duplicate: !!duplicateOf, duplicateOf: duplicateOf ? String(duplicateOf) : null });
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {});
    }
  }),
);

// Evidence routes addressed by id: /evidence/:eid/...
export const evidenceRouter = Router();
evidenceRouter.use(requireAuth);

const loadEvidence = (...roles) =>
  ah(async (req, _res, next) => {
    if (!mongoose.isValidObjectId(req.params.eid)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const e = await Evidence.findById(req.params.eid);
    // Membership check; non-members see 404 for evidence just as for cases.
    const c = e && (await Case.findOne({ _id: e.caseId, deletedAt: null, 'members.userId': req.user._id }));
    if (!c) throw httpError(404, 'NOT_FOUND', 'Not found');
    req.evidence = e;
    req.case = c;
    req.role = c.members.find((m) => String(m.userId) === String(req.user._id)).role;
    if (roles.length && !roles.includes(req.role)) throw httpError(403, 'FORBIDDEN', 'Insufficient role');
    next();
  });

evidenceRouter.get('/:eid', loadEvidence(), (req, res) => res.json({ evidence: view(req.evidence) }));

evidenceRouter.get(
  '/:eid/file',
  loadEvidence(),
  ah(async (req, res) => {
    if (req.evidence.redacted?.at) throw httpError(410, 'REDACTED', 'This original was redacted; only its hash remains');
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_DOWNLOADED', target: String(req.evidence._id) });
    res.set({
      'Content-Type': req.evidence.mime,
      'Content-Length': req.evidence.size,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    // GCM authenticates on final(): if the stored bytes were altered the stream errors and the response is aborted.
    await pipeline(openPlain(req.evidence), res).catch(() => res.destroy());
  }),
);

// Extracted content for the viewer (W1–W6): artifact + chunks with entity spans.
evidenceRouter.get(
  '/:eid/extracted',
  loadEvidence(),
  ah(async (req, res) => {
    const [artifact, chunks] = await Promise.all([
      DerivedArtifact.findOne({ evidenceId: req.evidence._id }).sort({ createdAt: -1 }).lean(),
      Chunk.find({ evidenceId: req.evidence._id }).sort({ idx: 1 }).lean(),
    ]);
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_VIEWED', target: String(req.evidence._id) });
    res.json({
      evidence: view(req.evidence),
      artifact: artifact ? { type: artifact.type, generator: artifact.generator, data: artifact.data } : null,
      chunks: chunks.map(({ _id, caseId, evidenceId, ...c }) => c),
    });
  }),
);

evidenceRouter.get(
  '/:eid/transcript',
  loadEvidence(),
  ah(async (req, res) => {
    const a = await DerivedArtifact.findOne({ evidenceId: req.evidence._id, type: 'transcript' }).sort({ createdAt: -1 }).lean();
    if (!a) throw httpError(404, 'NOT_FOUND', 'No transcript yet');
    res.json({ transcript: a.data, generator: a.generator });
  }),
);

evidenceRouter.post(
  '/:eid/verify',
  loadEvidence(),
  ah(async (req, res) => {
    const r = await verifyStored(req.evidence);
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_VERIFIED', target: String(req.evidence._id), payload: { ok: r.ok } });
    res.json(r);
  }),
);

evidenceRouter.post(
  '/:eid/reprocess',
  loadEvidence('owner'),
  validate(z.object({ voiceProvider: z.enum(['sarvam', 'local']).optional() }).default({})),
  ah(async (req, res) => {
    await enqueueEvidence(req.evidence, { force: true, voiceProvider: req.body.voiceProvider });
    await Evidence.updateOne({ _id: req.evidence._id }, { $set: { status: 'processing', error: null } });
    await Case.updateOne({ _id: req.case._id }, { $set: { status: 'processing' } });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_REPROCESSED', target: String(req.evidence._id), payload: req.body });
    res.status(202).json({ queued: true });
  }),
);
