// Processing DAG (spec §7): extract|transcribe → nlp → (debounced) case_rebuild → summarize.
// Per-evidence failures never block the case: the evidence is marked failed and the rebuild still runs.
import { EventEmitter } from 'node:events';
import {
  Case,
  CaseSnapshot,
  Chunk,
  Decision,
  DerivedArtifact,
  DuplicateGroup,
  Entity,
  Evidence,
  Statement,
  Inconsistency,
  ProviderUsage,
  Summary,
  TimelineEvent,
  User,
} from '../models/index.js';
import { mlJson, mlMultipart } from '../services/ml-client.js';
import { readPlain, sealBuffer } from '../services/evidence-store.js';
import { debounceCaseJob, enqueue, Job } from './runner.js';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const EXTRACT_VERSION = 1;
const isAudio = (kind) => kind === 'audio' || kind === 'statement';

export async function enqueueEvidence(e, { force = false, voiceProvider } = {}) {
  const type = isAudio(e.kind) ? 'transcribe' : 'extract';
  return enqueue({
    type,
    caseId: e.caseId,
    evidenceId: e._id,
    step: 'extract',
    version: force ? `${EXTRACT_VERSION}.${Date.now()}` : EXTRACT_VERSION,
    payload: voiceProvider ? { voiceProvider } : undefined,
  });
}

async function recordUsage(caseId, usage) {
  if (usage?.length) await ProviderUsage.insertMany(usage.map((u) => ({ ...u, caseId, ts: new Date() })));
}

function voiceProviderFor(c, override) {
  if (override) return override;
  return c.settings?.voiceMode === 'sarvam' && c.settings?.voiceConsentAt ? 'sarvam' : 'local';
}

function emit(caseId, evt, data) {
  bus.emit('case', { caseId: String(caseId), event: evt, data });
}

async function failEvidence(e, err) {
  await Evidence.updateOne({ _id: e._id }, { $set: { status: 'failed', error: String(err?.message ?? err).slice(0, 500) } });
  emit(e.caseId, 'processing.error', { evidenceId: String(e._id), step: 'extract', error: String(err?.message ?? err).slice(0, 200) });
  await debounceCaseJob({ type: 'case_rebuild', caseId: e.caseId });
}

/** Wrap a per-evidence handler: permanent (4xx) ML errors and the last retry mark the evidence failed. */
const perEvidence = (fn) => async (job, ctx) => {
  const e = await Evidence.findById(job.evidenceId);
  if (!e) return { skipped: 'evidence gone' };
  const c = await Case.findById(e.caseId);
  if (!c || c.deletedAt) return { skipped: 'case deleted' };
  try {
    return await fn(job, ctx, e, c);
  } catch (err) {
    if (err.permanent || job.attempts >= job.maxAttempts) {
      await failEvidence(e, err);
      return { failed: err.message };
    }
    throw err;
  }
};

const extractHandler = perEvidence(async (job, ctx, e, c) => {
  await Evidence.updateOne({ _id: e._id }, { $set: { status: 'processing', error: null } });
  emit(c._id, 'processing.progress', { evidenceId: String(e._id), step: isAudio(e.kind) ? 'transcribe' : 'extract', status: 'running', pct: 5 });
  const buf = await readPlain(e);
  const voiceProvider = voiceProviderFor(c, job.payload?.voiceProvider);
  const out = await mlMultipart('/extract', {
    file: buf,
    filename: e.filename,
    fields: {
      kind: e.kind,
      filename: e.filename,
      voiceProvider,
      translateMode: c.settings?.translateMode ?? 'off',
      referenceTs: e.createdAt?.toISOString().slice(0, 19),
    },
  });
  await ctx.progress(70);
  await recordUsage(c._id, out.usage);
  if (out.fallback) emit(c._id, 'provider.fallback', { evidenceId: String(e._id), reason: out.fallback });

  await DerivedArtifact.deleteMany({ evidenceId: e._id, type: out.artifactType });
  await DerivedArtifact.create({ caseId: c._id, evidenceId: e._id, type: out.artifactType, sourceSha256: e.sha256, generator: out.generator, data: out.artifact });
  await Chunk.deleteMany({ evidenceId: e._id });
  if (out.chunks.length) {
    await Chunk.insertMany(
      out.chunks.map((ch) => ({
        caseId: c._id,
        evidenceId: e._id,
        cid: `E${e.idx}:${ch.idx}`,
        idx: ch.idx,
        unit: ch.unit,
        text: ch.text,
        textEn: ch.textEn ?? null,
        lang: ch.lang,
        langConfidence: ch.langConfidence,
        translation: ch.translation,
        sender: ch.sender,
        speaker: ch.speaker,
        refTs: ch.refTs,
        tsSource: ch.refTsSource,
        sourceType: e.kind === 'statement' ? 'self_statement' : 'document',
        locator: ch.locator,
        conf: ch.conf,
        lowConfidence: ch.lowConfidence,
        timeOfDay: ch.timeOfDay,
        media: ch.media,
        failed: ch.failed,
      })),
    );
  }
  const langs = out.chunks.map((ch) => ch.lang).filter(Boolean);
  await Evidence.updateOne(
    { _id: e._id },
    {
      $set: {
        metadata: out.metadata,
        flags: out.flags,
        hashes: out.hashes,
        durationMs: out.metadata?.durationMs,
        provider: out.metadata?.provider,
        detectedLang: out.metadata?.lang ?? (langs.length ? mode(langs) : null),
      },
    },
  );

  // Archive members / email attachments become child evidence (sealed, audited, processed).
  for (const child of out.children ?? []) {
    try {
      const { evidence: ce, duplicateOf } = await sealBuffer({
        caseDoc: c,
        buffer: Buffer.from(child.data, 'base64'),
        filename: child.filename,
        uploadedBy: e.uploadedBy,
        sourceLabel: e.sourceLabel ? `${e.sourceLabel} / ${child.filename}` : child.filename,
        parentEvidenceId: e._id,
      });
      if (!duplicateOf) await enqueueEvidence(ce);
    } catch (err) {
      emit(c._id, 'processing.error', { evidenceId: String(e._id), step: 'unpack', error: `${child.filename}: ${err.message}` });
    }
  }
  if (!out.chunks.length) {
    await Evidence.updateOne({ _id: e._id }, { $set: { status: 'done' } });
    await debounceCaseJob({ type: 'case_rebuild', caseId: c._id });
    return { chunks: 0, children: out.children?.length ?? 0 };
  }
  await enqueue({ type: 'nlp', caseId: c._id, evidenceId: e._id, step: 'nlp', version: `${job.key.split(':').at(-1)}` });
  return { chunks: out.chunks.length, children: out.children?.length ?? 0 };
});

function mode(arr) {
  const m = new Map();
  for (const a of arr) m.set(a, (m.get(a) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const nlpHandler = perEvidence(async (job, _ctx, e, c) => {
  emit(c._id, 'processing.progress', { evidenceId: String(e._id), step: 'nlp', status: 'running', pct: 80 });
  const chunks = await Chunk.find({ evidenceId: e._id }).sort({ idx: 1 }).lean();
  const known = await Chunk.distinct('sender', { caseId: c._id, sender: { $ne: null } });
  const r = await mlJson('/nlp/enrich', {
    chunks: chunks.map((ch) => ({ id: ch.cid, text: ch.text ?? '', textEn: ch.textEn, refTs: ch.refTs, sender: ch.sender })),
    knownNames: known.filter(Boolean),
  });
  const byId = new Map(r.items.map((i) => [i.id, i]));
  await Chunk.bulkWrite(
    chunks.map((ch) => {
      const i = byId.get(ch.cid);
      return { updateOne: { filter: { _id: ch._id }, update: { $set: { entities: i?.entities ?? [], times: i?.times ?? [], severity: i?.severity ?? { score: 0, labels: [] } } } } };
    }),
  );
  await Evidence.updateOne({ _id: e._id }, { $set: { status: 'done' } });
  emit(c._id, 'processing.progress', { evidenceId: String(e._id), step: 'nlp', status: 'done', pct: 100 });
  if (e.kind === 'statement') await enqueue({ type: 'narrative', caseId: c._id, evidenceId: e._id, step: 'narrative', version: job.key.split(':').at(-1) });
  await debounceCaseJob({ type: 'case_rebuild', caseId: c._id });
  return { chunks: chunks.length };
});

// ------------------------------------------------------------------ case rebuild
const evidencePayload = (e) => ({
  id: String(e._id),
  idx: e.idx,
  kind: e.kind,
  filename: e.filename,
  sourceLabel: e.sourceLabel,
  sha256: e.sha256,
  metadata: e.metadata ?? {},
  flags: e.flags ?? [],
  hashes: e.hashes ?? {},
});

export const chunkPayload = (ch) => ({
  id: ch.cid,
  idx: ch.idx,
  evidenceId: String(ch.evidenceId),
  text: ch.text ?? '',
  textEn: ch.textEn,
  lang: ch.lang,
  sender: ch.sender,
  refTs: ch.refTs,
  unit: ch.unit,
  locator: ch.locator ?? {},
  entities: ch.entities ?? [],
  times: ch.times ?? [],
  severity: ch.severity ?? { score: 0, labels: [] },
  sourceType: ch.sourceType,
  timeOfDay: ch.timeOfDay,
  conf: ch.conf,
});

export async function loadCaseInputs(caseId) {
  const evidence = await Evidence.find({ caseId, duplicateOf: null, status: 'done', 'redacted.at': null }).sort({ idx: 1 }).lean();
  const chunks = await Chunk.find({ caseId, evidenceId: { $in: evidence.map((e) => e._id) }, failed: { $ne: true } }).sort({ evidenceId: 1, idx: 1 }).lean();
  return { evidence, chunks };
}

export async function rebuildCase(caseId, { summarize = true, ctx } = {}) {
  const t0 = Date.now();
  const c = await Case.findById(caseId);
  if (!c || c.deletedAt) return { skipped: true };
  emit(caseId, 'processing.progress', { step: 'case_rebuild', status: 'running', pct: 10 });
  const { evidence, chunks } = await loadCaseInputs(caseId);
  const ownerId = c.members.find((m) => m.role === 'owner')?.userId;
  const owner = ownerId ? await User.findById(ownerId, 'name').lean() : null;
  const decisions = await Decision.find({ caseId }).lean();
  const constraints = {
    mustLink: decisions.filter((d) => d.kind === 'must_link').map((d) => [d.a, d.b]),
    cannotLink: decisions.filter((d) => d.kind === 'cannot_link').map((d) => [d.a, d.b]),
  };
  const eventOverrides = Object.fromEntries(decisions.filter((d) => d.kind === 'event_override').map((d) => [d.key, d.data]));

  const r = await mlJson('/case/rebuild', {
    case: { title: c.title, incidentType: c.incidentType },
    ownerName: owner?.name,
    evidence: evidence.map(evidencePayload),
    chunks: chunks.map(chunkPayload),
    constraints,
    eventOverrides,
  });
  await ctx?.progress(60);

  const cid = c._id;
  await Promise.all([Entity.deleteMany({ caseId: cid }), TimelineEvent.deleteMany({ caseId: cid }), DuplicateGroup.deleteMany({ caseId: cid }), Inconsistency.deleteMany({ caseId: cid })]);
  await Promise.all([
    r.entities.length && Entity.insertMany(r.entities.map((x) => ({ ...x, caseId: cid }))),
    r.events.length && TimelineEvent.insertMany(r.events.map((x) => ({ ...x, caseId: cid }))),
    r.duplicates.length && DuplicateGroup.insertMany(r.duplicates.map((x) => ({ ...x, caseId: cid }))),
    r.inconsistencies.length && Inconsistency.insertMany(r.inconsistencies.map((x) => ({ ...x, caseId: cid }))),
  ]);
  await CaseSnapshot.updateOne(
    { caseId: cid },
    { $set: { graph: r.graph, insights: r.insights, candidates: r.candidates, keyMoments: r.keyMoments, mentions: r.mentions, generator: r.generator, builtAt: new Date(), durationMs: Date.now() - t0 } },
    { upsert: true },
  );
  emit(caseId, 'processing.progress', { step: 'case_rebuild', status: 'done', pct: 70 });

  if (summarize) await generateSummary(c, { evidence, chunks, entities: r.entities, events: r.events, inconsistencies: r.inconsistencies });

  const pending = await Evidence.exists({ caseId: cid, status: { $in: ['uploaded', 'processing'] } });
  await Case.updateOne({ _id: cid }, { $set: { status: pending ? 'processing' : 'ready', processedAt: new Date() } });
  emit(caseId, 'processing.done', { pending: !!pending, durationMs: Date.now() - t0 });
  return { entities: r.entities.length, events: r.events.length, inconsistencies: r.inconsistencies.length };
}

export async function generateSummary(c, inputs, { createdBy } = {}) {
  let { evidence, chunks, entities, events, inconsistencies } = inputs ?? {};
  if (!inputs) {
    ({ evidence, chunks } = await loadCaseInputs(c._id));
    entities = await Entity.find({ caseId: c._id }).lean();
    events = await TimelineEvent.find({ caseId: c._id }).sort({ ts: 1 }).lean();
    inconsistencies = await Inconsistency.find({ caseId: c._id }).lean();
  }
  const statuses = await Decision.find({ caseId: c._id, kind: 'inconsistency_status' }).lean();
  const dismissed = new Set(statuses.filter((d) => d.data?.status === 'dismissed').map((d) => d.key));
  const strip = ({ _id, caseId, ...x }) => x;
  const s = await mlJson('/case/summarize', {
    case: { title: c.title, incidentType: c.incidentType },
    llmMode: c.settings?.llmMode ?? 'cloud_redacted',
    evidence: evidence.map(evidencePayload),
    chunks: chunks.map(chunkPayload),
    entities: entities.map(strip),
    events: events.map(strip),
    inconsistencies: inconsistencies.filter((i) => !dismissed.has(i.key)).map(strip),
  });
  const last = await Summary.findOne({ caseId: c._id, lang: 'en-IN' }).sort({ version: -1 }).lean();
  const sents = s.sections.flatMap((x) => x.sentences);
  const doc = await Summary.create({
    caseId: c._id,
    version: (last?.version ?? 0) + 1,
    lang: 'en-IN',
    sections: s.sections,
    generator: s.generator,
    stats: { sentences: sents.length, cited: sents.filter((x) => x.citations?.length).length, unsupported: sents.filter((x) => x.supported === false).length },
    createdBy,
  });
  emit(c._id, 'summary.ready', { version: doc.version });
  return doc;
}

/** Voice statement → cited first-person narrative + prefill suggestions (V-INTAKE). */
export async function draftStatement(e, c) {
  const chunks = await Chunk.find({ evidenceId: e._id }).sort({ idx: 1 }).lean();
  const names = await Entity.find({ caseId: c._id, type: 'PERSON' }, 'aliases').lean();
  const out = await mlJson('/case/narrative', {
    segments: chunks.map((ch) => ({ id: ch.cid, text: ch.failed ? '[untranscribed]' : ch.text, textEn: ch.textEn, lang: ch.lang })),
    lang: e.detectedLang,
    llmMode: c.settings?.llmMode ?? 'cloud_redacted',
    refTs: e.createdAt?.toISOString().slice(0, 19),
    knownNames: names.flatMap((n) => n.aliases ?? []),
  });
  const last = await Statement.findOne({ evidenceId: e._id }).sort({ version: -1 }).lean();
  const doc = await Statement.create({
    caseId: c._id, evidenceId: e._id, version: (last?.version ?? 0) + 1, lang: out.lang, textNative: out.textNative, textEn: out.textEn,
    sentences: out.sentences, suggestions: out.suggestions, generator: out.generator,
  });
  emit(c._id, 'statement.ready', { evidenceId: String(e._id), statementId: String(doc._id), version: doc.version });
  return doc;
}

export const handlers = {
  narrative: perEvidence(async (_job, _ctx, e, c) => {
    const s = await draftStatement(e, c);
    return { version: s.version, sentences: s.sentences.length };
  }),
  extract: extractHandler,
  transcribe: extractHandler,
  nlp: nlpHandler,
  case_rebuild: async (job, ctx) => rebuildCase(job.caseId, { ctx }),
};

/** Per-evidence progress for the overview page. */
export async function caseProgress(caseId) {
  const jobs = await Job.find({ caseId, status: { $in: ['queued', 'running', 'failed'] } }, 'type evidenceId status progress error attempts').lean();
  return jobs.map((j) => ({ type: j.type, evidenceId: j.evidenceId ? String(j.evidenceId) : null, status: j.status, progress: j.progress, error: j.error ?? null }));
}
