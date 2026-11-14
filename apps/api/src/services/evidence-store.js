// Sealing and reading originals (spec E3, V5): encrypt into GridFS, record + audit in one transaction.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline as pipelineCb } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { getKek } from '../config.js';
import { Case, Evidence } from '../models/index.js';
import { audit, withTransaction } from './audit.js';
import { createDecryptor, createEncryptor } from './crypto.js';
import { detectEvidence } from './detect.js';
import { enqueueEvidenceTimestamp } from './timestamps.js';

export const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'evidence' });

export const hashFile = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });

export const sealError = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * Seal a file already on disk. Caller has verified the client hash (uploads) or computed it (children).
 * Returns { evidence, duplicateOf }.
 */
export async function sealFile({ caseDoc, tmpPath, originalName, sha256, uploadedBy, actorRole, sourceLabel = '', requestedKind, parentEvidenceId, size }) {
  const detected = await detectEvidence(tmpPath, originalName);
  if (!detected) throw sealError(415, 'UNSUPPORTED_TYPE', 'Unsupported or unrecognised file type');
  let { kind } = detected;
  if (requestedKind === 'statement') {
    if (kind !== 'audio') throw sealError(415, 'UNSUPPORTED_TYPE', 'A voice statement must be an audio file');
    kind = 'statement';
  }
  const canonical = await Evidence.findOne({ caseId: caseDoc._id, sha256, duplicateOf: null }).sort({ createdAt: 1 });

  const enc = createEncryptor(getKek());
  const up = bucket().openUploadStream(sha256, { metadata: { caseId: String(caseDoc._id) } });
  let fileId = up.id;
  try {
    await pipeline(fs.createReadStream(tmpPath), enc.stream, up);
    const { evidenceSeq } = await Case.findByIdAndUpdate(caseDoc._id, { $inc: { evidenceSeq: 1 } }, { new: true, projection: { evidenceSeq: 1 } });
    const doc = await withTransaction(async (session) => {
      const [e] = await Evidence.create(
        [
          {
            caseId: caseDoc._id,
            uploadedBy,
            filename: path.basename(originalName).slice(0, 255),
            kind,
            mime: detected.mime,
            size: size ?? (await fs.promises.stat(tmpPath)).size,
            sha256,
            sourceLabel,
            parentEvidenceId,
            duplicateOf: canonical?._id,
            storage: { backend: 'gridfs', fileId },
            enc: enc.meta(),
            idx: evidenceSeq,
          },
        ],
        { session },
      );
      await audit(
        caseDoc._id,
        {
          actorId: uploadedBy,
          actorRole,
          action: kind === 'statement' ? 'STATEMENT_RECORDED' : parentEvidenceId ? 'EVIDENCE_EXTRACTED' : 'EVIDENCE_UPLOADED',
          target: String(e._id),
          payload: { evidenceId: String(e._id), sha256, size: e.size, mime: e.mime, parentEvidenceId: parentEvidenceId ? String(parentEvidenceId) : undefined },
        },
        session,
      );
      return e;
    });
    fileId = null;
    await enqueueEvidenceTimestamp(doc); // F2: independent time witness; never fails the upload
    return { evidence: doc, duplicateOf: canonical?._id ?? null };
  } finally {
    if (fileId) await bucket().delete(fileId).catch(() => {});
  }
}

/** Seal an in-memory buffer (zip / email attachments) as child evidence. */
export async function sealBuffer({ caseDoc, buffer, filename, uploadedBy, actorRole = 'system', sourceLabel, parentEvidenceId }) {
  const tmp = path.join(os.tmpdir(), `tv-${crypto.randomUUID()}`);
  await fs.promises.writeFile(tmp, buffer);
  try {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return await sealFile({ caseDoc, tmpPath: tmp, originalName: filename, sha256, uploadedBy, actorRole, sourceLabel, parentEvidenceId, size: buffer.length });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// pipeline() (not .pipe()) so a GridFS error — e.g. a tampered chunk — destroys the decryptor instead of hanging.
export const openPlain = (e) => pipelineCb(bucket().openDownloadStream(e.storage.fileId), createDecryptor(e.enc, getKek()), () => {});

export async function readPlain(e) {
  const parts = [];
  for await (const c of openPlain(e)) parts.push(c);
  return Buffer.concat(parts);
}

/** Rehash a stored original. GCM authentication fails first if bytes were altered. */
export async function verifyStored(e) {
  const h = crypto.createHash('sha256');
  try {
    for await (const chunk of openPlain(e)) h.update(chunk);
  } catch {
    return { ok: false, expected: e.sha256, actual: null, reason: 'decryption/authentication failed (stored bytes were altered)' };
  }
  const actual = h.digest('hex');
  return actual === e.sha256 ? { ok: true, expected: e.sha256, actual } : { ok: false, expected: e.sha256, actual, reason: 'hash mismatch' };
}
