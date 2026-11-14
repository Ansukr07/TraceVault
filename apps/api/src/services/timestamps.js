// Trusted timestamping (future spec F2): stamp evidence hashes, audit-chain heads and Merkle roots with an
// independent RFC 3161 authority, so a case state can be proven to have existed at a given time.
// Only SHA-256 hashes leave the server. With no TSA configured the feature is off and nothing is created.
import fs from 'node:fs';
import { config } from '../config.js';
import { bus } from '../jobs/bus.js';
import { enqueue } from '../jobs/runner.js';
import { AuditEntry, Evidence, Timestamp } from '../models/index.js';
import { audit } from './audit.js';
import { merkleRoot } from './merkle.js';
import { requestToken, verifyToken } from './tsp.js';

export const MAX_TIMESTAMP_ATTEMPTS = 8;

export const tsaList = () =>
  [config.TSA_PRIMARY_URL, config.TSA_FALLBACK_URL].filter(Boolean).map((url) => ({ url, name: new URL(url).hostname }));
export const timestampsEnabled = () => tsaList().length > 0;

let trustCache;
export function trustPem() {
  if (trustCache !== undefined) return trustCache || undefined;
  try {
    trustCache = process.env.TSA_TRUST_PEM?.replace(/\\n/g, '\n') || (config.TSA_TRUST_PEM_PATH ? fs.readFileSync(config.TSA_TRUST_PEM_PATH, 'utf8') : '');
  } catch {
    trustCache = '';
  }
  return trustCache || undefined;
}

const emit = (caseId, event, data) => bus.emit('case', { caseId: String(caseId), event, data });

/** Create the timestamp record (idempotent on case + type + hash) and queue its issue job. */
export async function ensureTimestamp(caseId, subject) {
  if (!timestampsEnabled()) return null;
  const doc = await Timestamp.findOneAndUpdate(
    { caseId, 'subject.type': subject.type, 'subject.hash': subject.hash },
    { $setOnInsert: { caseId, subject } },
    { upsert: true, new: true },
  );
  if (doc.status === 'pending') {
    await enqueue({ type: 'timestamp_issue', caseId, step: `timestamp:${doc._id}`, payload: { timestampId: String(doc._id) }, maxAttempts: MAX_TIMESTAMP_ATTEMPTS });
  }
  return doc;
}

/** Called after an original is sealed. Never throws: a TSA problem must not fail an upload. */
export const enqueueEvidenceTimestamp = (e) =>
  ensureTimestamp(e.caseId, { type: 'evidence', ref: String(e._id), hash: e.sha256 }).catch((err) => console.error('timestamp enqueue failed', err.message));

/** Ask each configured TSA in turn until one returns a token that verifies for this hash. */
export async function issueTimestamp(doc, { fetchImpl } = {}) {
  const errors = [];
  for (const tsa of tsaList()) {
    try {
      const got = await requestToken(tsa.url, doc.subject.hash, { fetchImpl });
      const v = verifyToken(got.response, doc.subject.hash, { nonce: got.nonce, trustPem: trustPem() });
      if (!v.ok) throw new Error(v.errors.join('; '));
      doc.set({
        token: got.response, nonce: got.nonce, genTime: v.genTime, serial: v.serial, tsa: { name: v.tsaName ?? tsa.name, url: tsa.url },
        trust: v.trust, status: 'issued', lastError: null,
      });
      await doc.save();
      await audit(doc.caseId, {
        actorRole: 'system', action: 'TIMESTAMP_ISSUED', target: String(doc._id),
        payload: { type: doc.subject.type, ref: doc.subject.ref, hash: doc.subject.hash, tsa: tsa.name, genTime: v.genTime.toISOString(), serial: v.serial, trust: v.trust },
      });
      emit(doc.caseId, 'timestamp.issued', { timestampId: String(doc._id), type: doc.subject.type, ref: doc.subject.ref, genTime: v.genTime, tsa: doc.tsa.name });
      return doc;
    } catch (e) {
      errors.push(`${tsa.name}: ${e.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'no TSA configured');
}

export const timestampHandlers = {
  timestamp_issue: async (job) => {
    const doc = await Timestamp.findById(job.payload.timestampId);
    if (!doc || doc.status === 'issued' || doc.status === 'verified') return { skipped: true };
    try {
      await issueTimestamp(doc);
    } catch (e) {
      const final = job.attempts >= job.maxAttempts;
      doc.attempts += 1;
      doc.lastError = String(e.message).slice(0, 500);
      if (final) {
        doc.status = 'failed';
        await audit(doc.caseId, { actorRole: 'system', action: 'TIMESTAMP_FAILED', target: String(doc._id), payload: { type: doc.subject.type, hash: doc.subject.hash, error: doc.lastError } });
      }
      await doc.save();
      throw e; // lets the job runner back off and retry
    }
    if (doc.subject.type === 'evidence') await maybeAnchor(doc.caseId);
    return { genTime: doc.genTime };
  },
};

const lastAnchor = (caseId) => Timestamp.findOne({ caseId, 'subject.type': 'audit_head' }).sort({ createdAt: -1 }).lean();
const lastAnchorSeq = async (caseId) => Number((await lastAnchor(caseId))?.subject.ref ?? 0);

/** Stamp the audit-chain head and the Merkle root of every sealed original. Safe to call repeatedly. */
export async function anchorCase(caseId) {
  if (!timestampsEnabled()) return { enabled: false, created: [] };
  const [head, hashes] = await Promise.all([
    AuditEntry.findOne({ caseId: String(caseId) }).sort({ seq: -1 }).lean(),
    Evidence.find({ caseId }, 'sha256').lean().then((rows) => rows.map((r) => r.sha256)),
  ]);
  const created = [];
  if (head && hashes.length) {
    created.push(await ensureTimestamp(caseId, { type: 'audit_head', ref: String(head.seq), hash: head.hash }));
    created.push(await ensureTimestamp(caseId, { type: 'merkle_root', ref: String(hashes.length), hash: merkleRoot(hashes) }));
  }
  return { enabled: true, created: created.filter(Boolean) };
}

/** Anchor once N audit entries have accumulated since the last anchor (default 50). */
export async function maybeAnchor(caseId) {
  const head = await AuditEntry.findOne({ caseId: String(caseId) }).select('seq').sort({ seq: -1 }).lean();
  if (head && head.seq - (await lastAnchorSeq(caseId)) >= config.TIMESTAMP_ANCHOR_EVERY_N) await anchorCase(caseId);
}

/**
 * Re-check a stored token and that it still matches live data. Returns { ok, trust, genTime, errors[], current }.
 * `current` says whether the stamped hash is still what the case holds (false only for superseded audit heads).
 */
export async function verifyTimestampDoc(doc) {
  if (!doc.token) return { ok: false, errors: ['no token yet'], trust: 'unchecked', current: null };
  const v = verifyToken(doc.token, doc.subject.hash, { nonce: doc.nonce, trustPem: trustPem() });
  const errors = [...v.errors];
  let current = null;
  if (doc.subject.type === 'evidence') {
    const e = await Evidence.findById(doc.subject.ref, 'sha256').lean();
    current = !!e && e.sha256 === doc.subject.hash;
    if (!current) errors.push('the stored evidence no longer matches the time-stamped hash');
  } else if (doc.subject.type === 'audit_head') {
    const entry = await AuditEntry.findOne({ caseId: String(doc.caseId), seq: Number(doc.subject.ref) }, 'hash').lean();
    current = !!entry && entry.hash === doc.subject.hash;
    if (!current) errors.push(`audit entry #${doc.subject.ref} no longer matches the time-stamped head`);
  }
  const ok = v.ok && errors.length === 0;
  doc.trust = v.trust;
  if (ok) {
    doc.status = 'verified';
    doc.verifiedAt = new Date();
    doc.lastError = null;
  } else {
    doc.lastError = errors.join('; ').slice(0, 500);
  }
  await doc.save();
  await audit(doc.caseId, { actorRole: 'system', action: 'TIMESTAMP_VERIFIED', target: String(doc._id), payload: { ok, trust: v.trust, errors } });
  return { ok, trust: v.trust, genTime: v.genTime, tsaName: v.tsaName, errors, current };
}

/**
 * Periodic maintenance (called from the API process): re-queue stamps whose retries were exhausted,
 * and anchor cases that saw activity in the last day but have no recent anchor.
 */
export async function timestampSweep() {
  if (!timestampsEnabled()) return;
  const bucket = Math.floor(Date.now() / 3_600_000);
  const stuck = await Timestamp.find({ status: { $in: ['pending', 'failed'] }, token: { $exists: false }, updatedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).limit(200);
  for (const d of stuck) {
    d.status = 'pending';
    await d.save();
    await enqueue({ type: 'timestamp_issue', caseId: d.caseId, step: `timestamp:${d._id}`, version: `r${bucket}`, payload: { timestampId: String(d._id) }, maxAttempts: MAX_TIMESTAMP_ATTEMPTS });
  }
  // Cases with real (non-system-timestamp) activity in the last day and no anchor for 24 h. Ignoring TIMESTAMP_*
  // entries stops a quiet case from re-anchoring forever because each anchor writes its own audit entries.
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  for (const cid of await AuditEntry.distinct('caseId', { ts: { $gt: since }, action: { $not: /^TIMESTAMP_/ } })) {
    const [head, last] = await Promise.all([AuditEntry.findOne({ caseId: cid }).select('seq').sort({ seq: -1 }).lean(), lastAnchor(cid)]);
    if (head && (!last || (head.seq > Number(last.subject.ref) && last.createdAt < new Date(Date.now() - 24 * 3_600_000)))) await anchorCase(cid);
  }
}
