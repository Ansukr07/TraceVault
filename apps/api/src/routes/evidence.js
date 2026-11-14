import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { Router } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { config } from '../config.js';
import { UploadChunk, UploadSession } from '../models/uploads.js';
import { Annotation, Case, Chunk, DerivedArtifact, Evidence, Speaker } from '../models/index.js';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { hashFile, openPlain, sealFile, verifyStored } from '../services/evidence-store.js';
import { authenticityFor } from '../services/authenticity.js';
import { enqueueEvidence } from '../jobs/pipeline.js';
import { uploadLimiter, voiceLimiter } from '../middleware/rateLimit.js';
import { clamEnabled, scanFile } from '../services/clamav.js';
import { debounceCaseJob } from '../jobs/runner.js';
import { evidenceAllowed, evidenceFilter, logSharedView, resolveAccess, scopeFor } from '../services/scope.js';

const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir(), filename: (_r, _f, cb) => cb(null, `tv-${crypto.randomUUID()}`) }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

// Below the ~4.5 MB serverless request-body cap.
export const CHUNK_BYTES = 4_000_000;

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
    const scope = await scopeFor(req);
    const items = await Evidence.find({ caseId: req.case._id, ...(scope ? { _id: { $in: [...scope.ids] } } : {}) }).sort({ idx: 1, createdAt: 1 }).lean();
    const counts = await Chunk.aggregate([
      { $match: { caseId: req.case._id, ...evidenceFilter(scope) } },
      { $group: { _id: '$evidenceId', n: { $sum: 1 }, sev: { $max: '$severity.score' } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    res.json({
      evidence: items.map((e) => ({ ...view(e), chunkCount: byId.get(String(e._id))?.n ?? 0, maxSeverity: byId.get(String(e._id))?.sev ?? 0 })),
    });
  }),
);

/** Shared by the multipart route and chunked /complete: scan, verify the client hash, seal, enqueue. */
async function sealUpload(req, { tmp, originalName, size, clientSha256, sourceLabel, requestedKind }) {
  if (req.case.sealedAt) throw httpError(409, 'CASE_SEALED', 'This case is sealed. Add new evidence to an addendum case.');
  if ((await Evidence.countDocuments({ caseId: req.case._id, parentEvidenceId: null })) >= config.MAX_FILES_PER_CASE) {
    throw httpError(409, 'CASE_FULL', `Max ${config.MAX_FILES_PER_CASE} files per case`);
  }
  if (clamEnabled()) {
    let scan;
    try {
      scan = await scanFile(tmp);
    } catch (err) {
      if (!config.CLAMAV_FAIL_OPEN) throw httpError(503, 'SCANNER_UNAVAILABLE', 'The virus scanner is unavailable, so the upload was refused');
      scan = { clean: true };
    }
    if (!scan.clean) {
      await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'UPLOAD_REJECTED_MALWARE', target: String(req.case._id), payload: { signature: scan.signature, filename: originalName } });
      throw httpError(422, 'MALWARE_DETECTED', `Upload refused: the file was flagged by the virus scanner (${scan.signature})`);
    }
  }
  const sha256 = await hashFile(tmp);
  if (sha256 !== clientSha256.toLowerCase()) throw httpError(422, 'HASH_MISMATCH', 'Client and server SHA-256 differ; nothing was stored');

  const { evidence: doc, duplicateOf } = await sealFile({
    caseDoc: req.case,
    tmpPath: tmp,
    originalName,
    sha256,
    uploadedBy: req.user._id,
    actorRole: req.role,
    sourceLabel,
    requestedKind,
    size,
  });
  if (req.case.status !== 'processing') await Case.updateOne({ _id: req.case._id }, { $set: { status: 'processing' } });
  // Exact duplicates are sealed and recorded but not re-processed: they share the canonical item's content.
  if (!duplicateOf) await enqueueEvidence(doc);
  else await Evidence.updateOne({ _id: doc._id }, { $set: { status: 'done' } });
  return { evidence: view(doc), duplicate: !!duplicateOf, duplicateOf: duplicateOf ? String(duplicateOf) : null };
}

const parseBody = (body) => {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw httpError(400, 'VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return parsed.data;
};

// Small files (below the serverless body cap): single multipart request.
caseEvidenceRouter.post(
  '/',
  requireCaseRole('owner', 'collaborator'),
  uploadLimiter,
  upload.single('file'),
  ah(async (req, res) => {
    const tmp = req.file?.path;
    try {
      if (req.case.sealedAt) throw httpError(409, 'CASE_SEALED', 'This case is sealed. Add new evidence to an addendum case.');
      if (!req.file) throw httpError(400, 'NO_FILE', 'Attach a file in the "file" field');
      const { clientSha256, sourceLabel, kind } = parseBody(req.body);
      res.status(201).json(await sealUpload(req, { tmp, originalName: req.file.originalname, size: req.file.size, clientSha256, sourceLabel, requestedKind: kind }));
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {});
    }
  }),
);

// Large files: chunked upload. POST /uploads -> PUT /uploads/:uid/chunks/:n (raw bytes) -> POST /uploads/:uid/complete.
caseEvidenceRouter.post(
  '/uploads',
  requireCaseRole('owner', 'collaborator'),
  uploadLimiter,
  validate(bodySchema.extend({ filename: z.string().min(1).max(255), size: z.number().int().positive() })),
  ah(async (req, res) => {
    if (req.case.sealedAt) throw httpError(409, 'CASE_SEALED', 'This case is sealed. Add new evidence to an addendum case.');
    const { filename, size, clientSha256, sourceLabel, kind } = req.body;
    if (size > config.MAX_UPLOAD_MB * 1024 * 1024) throw httpError(413, 'TOO_LARGE', `Max upload is ${config.MAX_UPLOAD_MB} MB`);
    const s = await UploadSession.create({ caseId: req.case._id, userId: req.user._id, filename, size, clientSha256: clientSha256.toLowerCase(), sourceLabel, kind, chunkSize: CHUNK_BYTES, total: Math.ceil(size / CHUNK_BYTES) });
    res.status(201).json({ uploadId: String(s._id), chunkSize: s.chunkSize, total: s.total });
  }),
);

const loadUpload = ah(async (req, _res, next) => {
  const s = mongoose.isValidObjectId(req.params.uid) && (await UploadSession.findOne({ _id: req.params.uid, caseId: req.case._id, userId: req.user._id }));
  if (!s) throw httpError(404, 'NOT_FOUND', 'Upload not found or expired');
  req.upload = s;
  next();
});

caseEvidenceRouter.put(
  '/uploads/:uid/chunks/:n',
  requireCaseRole('owner', 'collaborator'),
  loadUpload,
  express.raw({ type: 'application/octet-stream', limit: CHUNK_BYTES + 1024 }),
  ah(async (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= req.upload.total) throw httpError(400, 'VALIDATION', 'Chunk index out of range');
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw httpError(400, 'VALIDATION', 'Send the chunk as application/octet-stream');
    await UploadChunk.updateOne({ uploadId: req.upload._id, n }, { $set: { data: req.body, createdAt: new Date() } }, { upsert: true });
    res.status(204).end();
  }),
);

caseEvidenceRouter.post(
  '/uploads/:uid/complete',
  requireCaseRole('owner', 'collaborator'),
  loadUpload,
  ah(async (req, res) => {
    const s = req.upload;
    const tmp = path.join(os.tmpdir(), `tv-${crypto.randomUUID()}`);
    try {
      const have = await UploadChunk.countDocuments({ uploadId: s._id });
      if (have !== s.total) throw httpError(409, 'INCOMPLETE', `Received ${have} of ${s.total} chunks`);
      const out = fs.createWriteStream(tmp);
      let bytes = 0;
      for (let n = 0; n < s.total; n++) {
        const c = await UploadChunk.findOne({ uploadId: s._id, n }).lean();
        if (!c) throw httpError(409, 'INCOMPLETE', `Chunk ${n} is missing`);
        const buf = Buffer.from(c.data.buffer ?? c.data);
        bytes += buf.length;
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      if (bytes !== s.size) throw httpError(422, 'SIZE_MISMATCH', 'Assembled size differs from the declared size; nothing was stored');
      const body = await sealUpload(req, { tmp, originalName: s.filename, size: bytes, clientSha256: s.clientSha256, sourceLabel: s.sourceLabel, requestedKind: s.kind });
      await Promise.all([UploadChunk.deleteMany({ uploadId: s._id }), UploadSession.deleteOne({ _id: s._id })]);
      res.status(201).json(body);
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
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
    // Shared members: the grant must still be active (not revoked/expired) and the item inside its scope.
    const access = await resolveAccess(c, req.user);
    if (!access) throw httpError(404, 'NOT_FOUND', 'Not found');
    req.evidence = e;
    req.case = c;
    req.role = access.role;
    req.grant = access.grant;
    if (access.grant) {
      const scope = await scopeFor(req);
      if (!evidenceAllowed(scope, e._id)) throw httpError(404, 'NOT_FOUND', 'Not found');
      await logSharedView(c._id, req.user, access.role, access.grant);
    }
    if (roles.length && !roles.includes(req.role)) throw httpError(403, 'FORBIDDEN', 'Insufficient role');
    next();
  });

evidenceRouter.get('/:eid', loadEvidence(), (req, res) => res.json({ evidence: view(req.evidence) }));

// F1: manipulation indicators (ELA heatmap, editing software, date conflicts). Indicators only, never a verdict.
evidenceRouter.get(
  '/:eid/authenticity',
  loadEvidence(),
  ah(async (req, res) => {
    if (req.evidence.redacted?.at) throw httpError(410, 'REDACTED', 'This original was redacted; only its hash remains');
    const { authenticity, computed } = await authenticityFor(req.evidence);
    if (computed) await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'AUTHENTICITY_RUN', target: String(req.evidence._id), payload: { risk: authenticity.riskIndicator, band: authenticity.band } });
    res.json({ authenticity });
  }),
);

evidenceRouter.get(
  '/:eid/file',
  loadEvidence(),
  ah(async (req, res) => {
    if (req.evidence.redacted?.at) throw httpError(410, 'REDACTED', 'This original was redacted; only its hash remains');
    // Viewing is always allowed for an active grant; saving a copy needs allowDownload (?download=1).
    if (req.query.download && req.grant && !req.grant.allowDownload) throw httpError(403, 'DOWNLOAD_NOT_ALLOWED', 'The owner did not allow downloads for this share');
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
    const speakers = await Speaker.find({ evidenceId: req.evidence._id }).sort({ label: 1 }).lean();
    res.json({ transcript: a.data, generator: a.generator, speakers: speakers.map(speakerView) });
  }),
);

const speakerView = (s) => ({ label: s.label, displayName: s.displayName ?? null, entityId: s.entityId ? String(s.entityId) : null });

// Speaker labels (spec 6.2): rename "SPEAKER_2" to a person. Chunks take the name as sender, so the timeline
// actor, entity resolution and the graph pick it up on the next (debounced) rebuild.
evidenceRouter.get(
  '/:eid/speakers',
  loadEvidence(),
  ah(async (req, res) => {
    const speakers = await Speaker.find({ evidenceId: req.evidence._id }).sort({ label: 1 }).lean();
    res.json({ speakers: speakers.map(speakerView) });
  }),
);

evidenceRouter.patch(
  '/:eid/speakers/:label',
  loadEvidence('owner', 'collaborator'),
  validate(z.object({ displayName: z.string().trim().max(80).nullable(), entityId: z.string().nullable().optional() })),
  ah(async (req, res) => {
    const { label } = req.params;
    const sp = await Speaker.findOne({ evidenceId: req.evidence._id, label });
    if (!sp) throw httpError(404, 'NOT_FOUND', 'No such speaker');
    const name = req.body.displayName || null;
    sp.displayName = name;
    if (req.body.entityId !== undefined) sp.entityId = req.body.entityId && mongoose.isValidObjectId(req.body.entityId) ? req.body.entityId : undefined;
    await sp.save();
    // sender falls back to the raw label so a cleared name doesn't leave a stale actor behind
    await Chunk.updateMany({ evidenceId: req.evidence._id, speaker: label }, { $set: { sender: name } });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'SPEAKER_RENAMED', target: String(req.evidence._id), payload: { label, displayName: name } });
    await debounceCaseJob({ type: 'case_rebuild', caseId: req.case._id });
    res.json({ speaker: speakerView(sp) });
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

// Annotations (E9): owner, collaborator and legal may add notes; everyone with access can read them.
evidenceRouter.get(
  '/:eid/annotations',
  loadEvidence(),
  ah(async (req, res) => {
    const items = await Annotation.find({ evidenceId: req.evidence._id }).sort({ createdAt: 1 }).lean();
    res.json({ annotations: items.map((a) => ({ id: String(a._id), text: a.text, chunkId: a.chunkId ?? null, authorName: a.authorName, authorRole: a.authorRole, createdAt: a.createdAt, mine: String(a.authorId) === String(req.user._id) })) });
  }),
);

evidenceRouter.post(
  '/:eid/annotations',
  loadEvidence('owner', 'collaborator', 'legal'),
  validate(z.object({ text: z.string().trim().min(1).max(2000), chunkId: z.string().regex(/^E\d+:\d+$/).optional() })),
  ah(async (req, res) => {
    const a = await Annotation.create({ caseId: req.case._id, evidenceId: req.evidence._id, authorId: req.user._id, authorName: req.user.name, authorRole: req.role, text: req.body.text, chunkId: req.body.chunkId });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_ANNOTATED', target: String(req.evidence._id), payload: { annotationId: String(a._id) } });
    res.status(201).json({ annotation: { id: String(a._id), text: a.text, chunkId: a.chunkId ?? null, authorName: a.authorName, authorRole: a.authorRole, createdAt: a.createdAt, mine: true } });
  }),
);

evidenceRouter.delete(
  '/:eid/annotations/:aid',
  loadEvidence('owner', 'collaborator', 'legal'),
  ah(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.aid)) throw httpError(404, 'NOT_FOUND', 'Not found');
    const a = await Annotation.findOneAndDelete({ _id: req.params.aid, evidenceId: req.evidence._id, authorId: req.user._id });
    if (!a) throw httpError(404, 'NOT_FOUND', 'Not found');
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'ANNOTATION_DELETED', target: String(req.evidence._id), payload: { annotationId: String(a._id) } });
    res.status(204).end();
  }),
);

evidenceRouter.post(
  '/:eid/reprocess',
  loadEvidence('owner'),
  voiceLimiter,
  validate(z.object({ voiceProvider: z.enum(['sarvam', 'local']).optional(), diarize: z.boolean().optional(), numSpeakers: z.number().int().min(2).max(8).optional() }).default({})),
  ah(async (req, res) => {
    await enqueueEvidence(req.evidence, { force: true, voiceProvider: req.body.voiceProvider, diarize: req.body.diarize, numSpeakers: req.body.numSpeakers });
    await Evidence.updateOne({ _id: req.evidence._id }, { $set: { status: 'processing', error: null } });
    await Case.updateOne({ _id: req.case._id }, { $set: { status: 'processing' } });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVIDENCE_REPROCESSED', target: String(req.evidence._id), payload: req.body });
    res.status(202).json({ queued: true });
  }),
);
