import crypto from 'node:crypto';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Deterministic JSON: keys sorted recursively, so the hash is stable. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

export const genesisHash = (caseId) => sha256(`TRACEVAULT_GENESIS:${caseId}`);

/** hash_n = SHA256(hash_{n-1} || canonicalJSON(entry_n)) */
export function entryHash(prevHash, entry) {
  return sha256(prevHash + canonicalJSON(entry));
}

/** Build the next entry for a case given the previous one (or null). */
export function buildEntry(caseId, prev, { ts = new Date().toISOString(), actorId, actorRole, action, target, payload }) {
  const seq = prev ? prev.seq + 1 : 1;
  const prevHash = prev ? prev.hash : genesisHash(caseId);
  const entry = {
    caseId,
    seq,
    ts,
    actorId,
    actorRole,
    action,
    target,
    payloadHash: sha256(canonicalJSON(payload ?? {})),
  };
  return { ...entry, prevHash, hash: entryHash(prevHash, entry) };
}

/**
 * Recompute the chain. Returns { ok: true } or { ok: false, brokenAtSeq, reason }
 * naming the first bad entry.
 */
export function verifyChain(caseId, entries) {
  let prevHash = genesisHash(caseId);
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq) return { ok: false, brokenAtSeq: expectedSeq, reason: 'sequence gap' };
    if (e.prevHash !== prevHash) return { ok: false, brokenAtSeq: e.seq, reason: 'prevHash mismatch' };
    // Hash only the signed fields; storage extras like Mongo's _id must not affect it.
    const entry = { caseId: e.caseId, seq: e.seq, ts: e.ts, actorId: e.actorId, actorRole: e.actorRole, action: e.action, target: e.target, payloadHash: e.payloadHash };
    if (entryHash(prevHash, entry) !== e.hash) return { ok: false, brokenAtSeq: e.seq, reason: 'hash mismatch' };
    prevHash = e.hash;
    expectedSeq++;
  }
  return { ok: true, head: prevHash, count: entries.length };
}
