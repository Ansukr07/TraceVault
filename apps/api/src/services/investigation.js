// Agentic investigation over the ML service (System1 + LangGraph agents + case-scoped vector search).
// Node builds the scope-filtered case snapshot (caseCtx) from Mongo; the ML service never touches the DB.
// Ids in the snapshot use the citation form the UI already understands: evidence "E3", chunk "E3:12".
import { mlDelete, mlJson } from './ml-client.js';
import { Chunk, Entity, Evidence, TimelineEvent } from '../models/index.js';
import { citationAllowed, evidenceFilter } from './scope.js';

const evId = (e) => `E${e.idx}`;
export const allowHosted = (c) => (c.settings?.system1Mode ?? 'local') === 'hosted';
const ROW_UPI = /[\w.-]+@[a-z]+/i;
const ROW_AMT = /\b\d{1,3}(?:,\d{2,3})+(?:\.\d{2})?\b|\b\d{4,7}\.\d{2}\b/;

/** Bank/UPI statement rows from PDF/statement chunks: one row per unit that carries a UPI id and an amount. */
export function statementRows(chunks) {
  const rows = [];
  for (const c of chunks) {
    const text = c.text ?? '';
    const upi = ROW_UPI.exec(text);
    const amt = ROW_AMT.exec(text);
    if (!upi || !amt) continue;
    rows.push({
      amount: amt[0].replaceAll(',', ''),
      upiId: upi[0],
      direction: /\/DR\/|Debit:\s*\d/i.test(text) ? 'debit' : 'credit',
      text,
      citations: [c.cid],
    });
  }
  return rows;
}

/** Scope-filtered, read-only case snapshot for the agents. `scope` = scopeFor(req) (null = full case). */
export async function buildCaseCtx(c, scope, extra = {}) {
  const cid = c._id;
  const evidence = await Evidence.find({ caseId: cid, duplicateOf: null, status: 'done', 'redacted.at': null, ...evidenceFilter(scope, '_id') }).sort({ idx: 1 }).lean();
  const byOid = new Map(evidence.map((e) => [String(e._id), e]));
  const chunks = await Chunk.find({ caseId: cid, evidenceId: { $in: evidence.map((e) => e._id) }, failed: { $ne: true } }).sort({ evidenceId: 1, idx: 1 }).lean();
  const allowed = (ids = []) => ids.filter((x) => citationAllowed(scope, x));
  const [entities, events] = await Promise.all([Entity.find({ caseId: cid }).lean(), TimelineEvent.find({ caseId: cid }).sort({ ts: 1 }).lean()]);
  const entityKeys = new Set(entities.map((e) => e.key));

  const chunkIdsByEvidence = new Map();
  for (const ch of chunks) {
    const k = String(ch.evidenceId);
    if (!chunkIdsByEvidence.has(k)) chunkIdsByEvidence.set(k, []);
    chunkIdsByEvidence.get(k).push(ch.cid);
  }
  // Bank statements arrive as PDFs ('statement' is the owner's voice/text statement, not a bank document).
  const rows = statementRows(chunks.filter((ch) => byOid.get(String(ch.evidenceId))?.kind === 'pdf'));

  return {
    caseId: String(cid),
    scopeFiltered: true,
    incidentType: c.incidentType && c.incidentType !== 'other' ? c.incidentType : undefined,
    evidence: evidence.map((e) => {
      const confs = chunks.filter((ch) => String(ch.evidenceId) === String(e._id) && typeof ch.conf === 'number').map((ch) => ch.conf);
      return {
        id: evId(e),
        kind: e.kind,
        filename: e.filename,
        mimeType: e.mime,
        mime: e.mime,
        sha256: e.sha256,
        size: e.size,
        width: e.metadata?.width,
        height: e.metadata?.height,
        capturedAt: e.metadata?.captureTime ?? e.metadata?.sentAt ?? e.metadata?.createdAt ?? e.metadata?.filenameTs,
        ocrConfidence: confs.length ? Math.min(...confs) : undefined,
        flags: e.flags ?? [],
        chunkIds: chunkIdsByEvidence.get(String(e._id)) ?? [],
      };
    }),
    chunks: chunks.map((ch) => ({ id: ch.cid, evidenceId: evId(byOid.get(String(ch.evidenceId))), text: ch.text ?? '', textEn: ch.textEn ?? undefined })),
    entities: entities
      .map((e) => ({ id: e.key, type: e.type === 'PERSON' ? 'Person' : 'Account', name: e.name, chunkIds: allowed(e.mentionChunkIds), citations: allowed(e.mentionChunkIds).slice(0, 5) }))
      .filter((e) => !scope || e.chunkIds.length),
    events: events
      .map((ev) => ({
        id: ev.key,
        title: ev.title,
        description: ev.descriptionEn || ev.description || ev.title,
        timestamp: ev.ts,
        timeEnd: ev.tsEnd,
        category: ev.amount ? 'payment' : ev.category,
        amount: ev.amount ?? undefined,
        entityIds: [...(ev.actors ?? []), ...(ev.targets ?? [])].filter((k) => entityKeys.has(k)),
        evidenceChunkIds: allowed(ev.citations),
        severity: ev.severity,
        confidence: ev.confidence,
      }))
      .filter((ev) => !scope || ev.evidenceChunkIds.length),
    statements: rows.length ? [{ transactions: rows }] : [],
    // System1 (Laya) keeps case text on this server unless the owner chose hosted inference.
    system1AllowHosted: allowHosted(c),
    ...extra,
  };
}

const OBJECTIVE = 'Investigate this case: who did what and when, what payments were made, which evidence is weak, and what is missing.';

/** Planner + selected agents + System1 review. */
export async function runInvestigation(c, scope, objective = OBJECTIVE) {
  const t0 = Date.now();
  // The objective doubles as the retrieval agent's question, so its cited passages answer what was asked.
  const caseCtx = await buildCaseCtx(c, scope, { question: objective });
  if (!caseCtx.chunks.length) {
    const err = new Error('No processed evidence in scope yet');
    err.status = 409;
    err.code = 'NOTHING_TO_INVESTIGATE';
    throw err;
  }
  const out = await mlJson('/agents/investigate', { caseCtx, objective }, { timeoutMs: 900_000 });
  return { ...out, objective, scoped: !!scope, counts: { evidence: caseCtx.evidence.length, chunks: caseCtx.chunks.length, events: caseCtx.events.length }, durationMs: Date.now() - t0, ranAt: new Date().toISOString() };
}

export async function askAgent(c, scope, question) {
  const caseCtx = await buildCaseCtx(c, scope);
  return mlJson('/agents/rag', { caseCtx, question }, { timeoutMs: 300_000 });
}

export async function evidenceQuality(c, scope, evidenceId) {
  const caseCtx = await buildCaseCtx(c, scope);
  return mlJson('/agents/evidence-quality', { caseCtx, evidenceId }, { timeoutMs: 300_000 });
}

/** Semantic (cross-language) search over the case's Chroma index; hits outside the caller's scope are dropped. */
export async function semanticSearch(c, scope, question, limit = 8) {
  const r = await mlJson('/vectors/query', { caseId: String(c._id), question, limit: Math.min(50, limit * 3) }, { timeoutMs: 120_000 });
  const ids = (r.results ?? []).map((h) => h.chunkId).filter((id) => id && citationAllowed(scope, id));
  // The index can hold chunks of evidence that was later redacted or re-extracted: only return chunks that still exist.
  const live = await Chunk.find({ caseId: c._id, cid: { $in: ids }, failed: { $ne: true } }, 'cid evidenceId').lean();
  const redacted = new Set((await Evidence.find({ caseId: c._id, 'redacted.at': { $ne: null } }, '_id').lean()).map((e) => String(e._id)));
  const ok = new Set(live.filter((ch) => !redacted.has(String(ch.evidenceId))).map((ch) => ch.cid));
  const hits = (r.results ?? []).filter((h) => ok.has(h.chunkId)).slice(0, limit);
  return { hits: hits.map((h) => ({ chunkId: h.chunkId, textEn: h.textEn, sourceText: h.sourceText, score: h.distance == null ? null : Math.round((1 - h.distance) * 1000) / 1000 })) };
}

/** System1 incident-type scores over the English working copy of the case (in scope). */
export async function classifyIncident(c, scope) {
  const caseCtx = await buildCaseCtx(c, scope);
  const text = caseCtx.chunks.map((ch) => ch.textEn || ch.text).filter(Boolean).join('\n').slice(0, 12_000);
  if (!text.trim()) return null;
  return mlJson('/incident/classify', { textEn: text, allowHosted: allowHosted(c) }, { timeoutMs: 600_000 });
}

/** (Re)build the case's semantic index from its current chunks — for cases processed before indexing existed. */
export async function reindexCase(c) {
  const evidence = await Evidence.find({ caseId: c._id, duplicateOf: null, status: 'done', 'redacted.at': null }, '_id').lean();
  const chunks = await Chunk.find({ caseId: c._id, evidenceId: { $in: evidence.map((e) => e._id) }, failed: { $ne: true } }, 'cid text textEn').lean();
  await mlDelete(`/vectors/case/${c._id}`).catch(() => {});
  let indexed = 0;
  for (let i = 0; i < chunks.length; i += 200) {
    const batch = chunks.slice(i, i + 200).filter((ch) => ch.text);
    if (!batch.length) continue;
    const r = await mlJson('/nlp/enrich', {
      caseId: String(c._id), storeChunks: true, classifyIncident: false,
      chunks: batch.map((ch) => ({ id: ch.cid, text: ch.text, textEn: ch.textEn ?? undefined })),
    }, { timeoutMs: 900_000 });
    indexed += r.indexedChunks ?? 0;
  }
  return { chunks: chunks.length, indexed };
}
