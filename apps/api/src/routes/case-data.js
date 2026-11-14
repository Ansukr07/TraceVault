// Case intelligence routes (spec §10.1): overview, timeline, entities, graph, duplicates, inconsistencies,
// summary, Q&A, insights, chunks (citation previews), full integrity verification, settings.
import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import {
  AuditEntry,
  Case,
  CaseSnapshot,
  Chunk,
  Decision,
  DuplicateGroup,
  Entity,
  Evidence,
  Inconsistency,
  ProviderUsage,
  Summary,
  TimelineEvent,
} from '../models/index.js';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { verifyChain } from '../services/audit-chain.js';
import { merkleRoot } from '../services/merkle.js';
import { verifyStored } from '../services/evidence-store.js';
import { mlBinary, mlJson, mlMultipart } from '../services/ml-client.js';
import { caseProgress, chunkPayload, generateSummary, loadCaseInputs } from '../jobs/pipeline.js';
import { debounceCaseJob } from '../jobs/runner.js';

export const caseDataRouter = Router({ mergeParams: true });
caseDataRouter.use(requireAuth);

const strip = ({ _id, caseId, __v, ...x }) => x;
const rebuildSoon = (caseId) => debounceCaseJob({ type: 'case_rebuild', caseId, delayMs: 1500 });

// ------------------------------------------------------------------ overview
caseDataRouter.get(
  '/overview',
  requireCaseRole(),
  ah(async (req, res) => {
    const cid = req.case._id;
    const [evidence, people, events, incs, dups, snap, progress, summary] = await Promise.all([
      Evidence.find({ caseId: cid }, 'kind status duplicateOf idx filename sourceLabel').lean(),
      Entity.countDocuments({ caseId: cid, type: 'PERSON' }),
      TimelineEvent.find({ caseId: cid }).sort({ ts: 1 }).lean(),
      Inconsistency.find({ caseId: cid }, 'key type severity title').lean(),
      DuplicateGroup.countDocuments({ caseId: cid }),
      CaseSnapshot.findOne({ caseId: cid }).lean(),
      caseProgress(cid),
      Summary.findOne({ caseId: cid, lang: 'en-IN' }).sort({ version: -1 }).lean(),
    ]);
    const statuses = await Decision.find({ caseId: cid, kind: 'inconsistency_status' }).lean();
    const closed = new Set(statuses.filter((d) => d.data?.status === 'dismissed').map((d) => d.key));
    const topEntities = await Entity.find({ caseId: cid, isOwner: { $ne: true } }).sort({ mentionCount: -1 }).limit(8).lean();
    const keySet = new Set(snap?.keyMoments ?? []);
    res.json({
      counts: {
        evidence: evidence.length,
        processed: evidence.filter((e) => e.status === 'done').length,
        failed: evidence.filter((e) => e.status === 'failed').length,
        people,
        events: events.length,
        inconsistencies: incs.filter((i) => !closed.has(i.key)).length,
        duplicates: dups + evidence.filter((e) => e.duplicateOf).length,
      },
      status: req.case.status,
      progress,
      keyMoments: events.filter((e) => keySet.has(e.key)).map(strip),
      miniTimeline: events.map((e) => ({ key: e.key, ts: e.ts, severity: e.severity, category: e.category })),
      topEntities: topEntities.map((e) => ({ key: e.key, type: e.type, name: e.name, mentionCount: e.mentionCount })),
      insights: snap?.insights ? { escalating: snap.insights.escalating, firstContact: snap.insights.firstContact, peakHours: snap.insights.peakHours } : null,
      summaryVersion: summary?.version ?? null,
      builtAt: snap?.builtAt ?? null,
    });
  }),
);

caseDataRouter.get('/jobs', requireCaseRole(), ah(async (req, res) => res.json({ jobs: await caseProgress(req.case._id) })));

// ------------------------------------------------------------------ chunks (citation previews)
caseDataRouter.get(
  '/chunks',
  requireCaseRole(),
  ah(async (req, res) => {
    const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter((s) => /^E\d+:\d+$/.test(s)).slice(0, 200);
    const chunks = await Chunk.find({ caseId: req.case._id, cid: { $in: ids } }).lean();
    const ev = await Evidence.find({ _id: { $in: chunks.map((c) => c.evidenceId) } }, 'kind filename sourceLabel mime idx').lean();
    const byId = new Map(ev.map((e) => [String(e._id), e]));
    res.json({
      chunks: chunks.map((c) => ({
        id: c.cid, evidenceId: String(c.evidenceId), text: c.text, textEn: c.textEn, lang: c.lang, sender: c.sender, refTs: c.refTs,
        unit: c.unit, locator: c.locator, translation: c.translation, sourceType: c.sourceType, severity: c.severity,
        evidence: byId.has(String(c.evidenceId)) ? { kind: byId.get(String(c.evidenceId)).kind, label: byId.get(String(c.evidenceId)).sourceLabel || byId.get(String(c.evidenceId)).filename } : null,
      })),
    });
  }),
);

// ------------------------------------------------------------------ timeline
caseDataRouter.get(
  '/timeline',
  requireCaseRole(),
  ah(async (req, res) => {
    const q = { caseId: req.case._id };
    const { person, category, minSeverity, from, to, source } = req.query;
    if (person) q.$or = [{ actors: person }, { targets: person }];
    if (category) q.category = { $in: String(category).split(',') };
    if (minSeverity) q.severity = { $gte: Number(minSeverity) };
    if (from || to) q.ts = { ...(from ? { $gte: String(from) } : {}), ...(to ? { $lte: String(to) } : {}) };
    if (source) q.evidenceIds = source;
    const [events, entities] = await Promise.all([
      TimelineEvent.find(q).sort({ ts: 1 }).lean(),
      Entity.find({ caseId: req.case._id, type: 'PERSON' }, 'key name isOwner').lean(),
    ]);
    res.json({ events: events.map(strip), people: entities.map(strip) });
  }),
);

const eventEdit = z.object({
  ts: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/).optional(),
  tsPrecision: z.enum(['exact', 'day', 'approx']).optional(),
  title: z.string().min(1).max(300).optional(),
  category: z.enum(['extortion', 'threat', 'sexual', 'abuse', 'financial_request', 'payment', 'meeting', 'contact']).optional(),
});

caseDataRouter.patch(
  '/events/:key',
  requireCaseRole('owner', 'collaborator'),
  validate(eventEdit),
  ah(async (req, res) => {
    const ev = await TimelineEvent.findOne({ caseId: req.case._id, key: req.params.key });
    if (!ev) throw httpError(404, 'NOT_FOUND', 'Event not found');
    const prev = await Decision.findOne({ caseId: req.case._id, kind: 'event_override', key: ev.key });
    const data = { ...(prev?.data ?? {}), ...req.body };
    await Decision.updateOne({ caseId: req.case._id, kind: 'event_override', key: ev.key }, { $set: { data, by: req.user._id } }, { upsert: true });
    Object.assign(ev, req.body, { userEdited: true });
    await ev.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'EVENT_EDITED', target: ev.key, payload: req.body });
    res.json({ event: strip(ev.toObject()) });
  }),
);

// ------------------------------------------------------------------ entities
caseDataRouter.get(
  '/entities',
  requireCaseRole(),
  ah(async (req, res) => {
    const [entities, snap, decisions] = await Promise.all([
      Entity.find({ caseId: req.case._id }).sort({ mentionCount: -1 }).lean(),
      CaseSnapshot.findOne({ caseId: req.case._id }, 'candidates').lean(),
      Decision.find({ caseId: req.case._id, kind: { $in: ['must_link', 'cannot_link'] } }).lean(),
    ]);
    res.json({
      entities: entities.map(strip),
      candidates: snap?.candidates ?? [],
      decisions: decisions.map((d) => ({ id: String(d._id), kind: d.kind, a: d.a, b: d.b, at: d.createdAt })),
    });
  }),
);

const pairBody = z.object({ a: z.string().min(3).max(300), b: z.string().min(3).max(300) });

for (const [path, kind, action] of [['merge', 'must_link', 'ENTITY_MERGED'], ['split', 'cannot_link', 'ENTITY_SPLIT']]) {
  caseDataRouter.post(
    `/entities/${path}`,
    requireCaseRole('owner', 'collaborator'),
    validate(pairBody),
    ah(async (req, res) => {
      // Constraints are stored on alias keys, which survive rebuilds even when entity keys change.
      const ents = await Entity.find({ caseId: req.case._id, $or: [{ key: { $in: [req.body.a, req.body.b] } }, { aliasKeys: { $in: [req.body.a, req.body.b] } }] }).lean();
      const resolveAlias = (k) => (k.startsWith('PERSON:') ? k : ents.find((e) => e.key === k)?.aliasKeys?.[0] ?? k);
      const a = resolveAlias(req.body.a);
      const b = resolveAlias(req.body.b);
      const opposite = kind === 'must_link' ? 'cannot_link' : 'must_link';
      await Decision.deleteMany({ caseId: req.case._id, kind: opposite, $or: [{ a, b }, { a: b, b: a }] });
      await Decision.updateOne({ caseId: req.case._id, kind, a, b }, { $set: { by: req.user._id } }, { upsert: true });
      await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action, target: `${a}|${b}` });
      await rebuildSoon(req.case._id);
      res.status(202).json({ queued: true });
    }),
  );
}

caseDataRouter.delete(
  '/entities/decisions/:did',
  requireCaseRole('owner', 'collaborator'),
  ah(async (req, res) => {
    const d = await Decision.findOneAndDelete({ _id: req.params.did, caseId: req.case._id, kind: { $in: ['must_link', 'cannot_link'] } });
    if (!d) throw httpError(404, 'NOT_FOUND', 'Not found');
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'ENTITY_DECISION_REVERTED', target: `${d.a}|${d.b}` });
    await rebuildSoon(req.case._id);
    res.status(202).json({ queued: true });
  }),
);

// ------------------------------------------------------------------ graph / duplicates / insights
caseDataRouter.get(
  '/graph',
  requireCaseRole(),
  ah(async (req, res) => {
    const snap = await CaseSnapshot.findOne({ caseId: req.case._id }, 'graph candidates builtAt').lean();
    res.json({ graph: snap?.graph ?? { nodes: [], edges: [] }, builtAt: snap?.builtAt ?? null });
  }),
);

caseDataRouter.get(
  '/duplicates',
  requireCaseRole(),
  ah(async (req, res) => {
    const [groups, exact] = await Promise.all([
      DuplicateGroup.find({ caseId: req.case._id }).lean(),
      Evidence.find({ caseId: req.case._id, duplicateOf: { $ne: null } }, 'duplicateOf filename').lean(),
    ]);
    res.json({ groups: groups.map(strip), exactUploads: exact.map((e) => ({ evidenceId: String(e._id), duplicateOf: String(e.duplicateOf), filename: e.filename })) });
  }),
);

caseDataRouter.get(
  '/insights',
  requireCaseRole(),
  ah(async (req, res) => {
    const snap = await CaseSnapshot.findOne({ caseId: req.case._id }, 'insights').lean();
    res.json({ insights: snap?.insights ?? null });
  }),
);

// ------------------------------------------------------------------ inconsistencies
caseDataRouter.get(
  '/inconsistencies',
  requireCaseRole(),
  ah(async (req, res) => {
    const [items, statuses] = await Promise.all([
      Inconsistency.find({ caseId: req.case._id }).sort({ severity: -1 }).lean(),
      Decision.find({ caseId: req.case._id, kind: 'inconsistency_status' }).lean(),
    ]);
    const st = new Map(statuses.map((d) => [d.key, d.data]));
    res.json({ items: items.map((i) => ({ ...strip(i), status: st.get(i.key)?.status ?? 'open', note: st.get(i.key)?.note ?? null })) });
  }),
);

caseDataRouter.patch(
  '/inconsistencies/:key',
  requireCaseRole('owner', 'collaborator', 'legal'),
  validate(z.object({ status: z.enum(['open', 'dismissed', 'explained']), note: z.string().max(2000).optional() })),
  ah(async (req, res) => {
    if (req.body.status === 'explained' && !req.body.note) throw httpError(400, 'NOTE_REQUIRED', 'Add a note explaining the inconsistency');
    if (!(await Inconsistency.exists({ caseId: req.case._id, key: req.params.key }))) throw httpError(404, 'NOT_FOUND', 'Not found');
    await Decision.updateOne(
      { caseId: req.case._id, kind: 'inconsistency_status', key: req.params.key },
      { $set: { data: { status: req.body.status, note: req.body.note ?? null }, by: req.user._id } },
      { upsert: true },
    );
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: `INCONSISTENCY_${req.body.status.toUpperCase()}`, target: req.params.key, payload: req.body });
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ summary + Q&A
caseDataRouter.get(
  '/summary',
  requireCaseRole(),
  ah(async (req, res) => {
    const lang = String(req.query.lang || 'en-IN');
    const base = await Summary.findOne({ caseId: req.case._id, lang: 'en-IN' }).sort({ version: -1 }).lean();
    if (!base) return res.json({ summary: null });
    if (lang === 'en-IN') return res.json({ summary: strip(base) });
    // S8: translate the validated English summary sentence by sentence; citations unchanged.
    let tr = await Summary.findOne({ caseId: req.case._id, lang, version: base.version }).lean();
    if (!tr) {
      if (req.case.settings?.translateMode === 'off') throw httpError(409, 'TRANSLATION_OFF', 'Translation is turned off for this case');
      const items = base.sections.flatMap((s, si) => s.sentences.map((x, xi) => ({ id: `${si}.${xi}`, text: x.text, src: 'en-IN' })));
      const r = await mlJson('/translate', { items, target: lang, redact: req.case.settings?.translateMode === 'sarvam_redacted' });
      await ProviderUsage.insertMany((r.usage ?? []).map((u) => ({ ...u, caseId: req.case._id })));
      const by = new Map(r.items.map((i) => [i.id, i.text]));
      tr = (
        await Summary.create({
          caseId: req.case._id,
          version: base.version,
          lang,
          generator: { ...base.generator, translation: { provider: 'sarvam' } },
          stats: base.stats,
          sections: base.sections.map((s, si) => ({
            ...s,
            sentences: s.sentences.map((x, xi) => ({ ...x, textEn: x.text, text: by.get(`${si}.${xi}`) ?? x.text, machineTranslated: by.has(`${si}.${xi}`) })),
          })),
        })
      ).toObject();
    }
    res.json({ summary: strip(tr) });
  }),
);

caseDataRouter.post(
  '/summary/regenerate',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    const doc = await generateSummary(req.case, null, { createdBy: req.user._id });
    await Summary.deleteMany({ caseId: req.case._id, lang: { $ne: 'en-IN' }, version: { $lt: doc.version } });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'SUMMARY_REGENERATED', target: String(doc._id), payload: { version: doc.version } });
    res.json({ summary: strip(doc.toObject()) });
  }),
);

async function answerQuestion(c, question) {
  const { chunks } = await loadCaseInputs(c._id);
  const entities = await Entity.find({ caseId: c._id, type: 'PERSON' }, 'type aliases name').lean();
  return mlJson('/case/ask', { question, llmMode: c.settings?.llmMode ?? 'cloud_redacted', chunks: chunks.map(chunkPayload), entities: entities.map(strip) });
}

caseDataRouter.post(
  '/ask',
  requireCaseRole(),
  validate(z.object({ question: z.string().min(2).max(1000), lang: z.string().optional() })),
  ah(async (req, res) => {
    const out = await answerQuestion(req.case, req.body.question);
    await audit(req.case._id, {
      actorId: req.user._id, actorRole: req.role, action: 'QUESTION_ASKED', target: String(req.case._id),
      payload: { questionHash: crypto.createHash('sha256').update(req.body.question).digest('hex') },
    });
    res.json(out);
  }),
);

const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

// V-ASK: the question audio is transcribed and discarded; only the question hash is audited.
caseDataRouter.post(
  '/ask/voice',
  requireCaseRole(),
  audioUpload.single('audio'),
  ah(async (req, res) => {
    if (!req.file) throw httpError(400, 'NO_FILE', 'Attach audio in the "audio" field');
    if (req.case.settings?.voiceMode !== 'sarvam' || !req.case.settings?.voiceConsentAt) throw httpError(409, 'VOICE_DISABLED', 'Voice questions need Sarvam voice processing enabled for this case');
    const q = await mlMultipart('/voice/transcribe-query', { file: req.file.buffer, filename: req.file.originalname || 'question.webm' });
    req.file.buffer = null;
    const out = await answerQuestion(req.case, q.text);
    let answerNative = null;
    if (q.lang && !q.lang.startsWith('en') && req.case.settings?.translateMode !== 'off') {
      const t = await mlJson('/translate', { items: [{ id: 'a', text: out.answer, src: 'en-IN' }], target: q.lang, redact: false }).catch(() => null);
      answerNative = t?.items?.[0]?.text ?? null;
    }
    await audit(req.case._id, {
      actorId: req.user._id, actorRole: req.role, action: 'QUESTION_ASKED', target: String(req.case._id),
      payload: { questionHash: crypto.createHash('sha256').update(q.text).digest('hex'), voice: true },
    });
    res.json({ question: q.text, lang: q.lang, ...out, answerNative });
  }),
);

// V-TTS: read the summary (or any cited answer) aloud. Returns audio/wav with sentence timings.
caseDataRouter.post(
  '/summary/speak',
  requireCaseRole(),
  validate(z.object({ lang: z.string().default('en-IN'), voice: z.string().optional(), text: z.string().max(20000).optional() })),
  ah(async (req, res) => {
    if (req.case.settings?.voiceMode !== 'sarvam') throw httpError(409, 'VOICE_DISABLED', 'Read-aloud needs Sarvam voice processing enabled for this case');
    let text = req.body.text;
    if (!text) {
      const s = await Summary.findOne({ caseId: req.case._id, lang: req.body.lang }).sort({ version: -1 }).lean()
        ?? (await Summary.findOne({ caseId: req.case._id, lang: 'en-IN' }).sort({ version: -1 }).lean());
      if (!s) throw httpError(404, 'NOT_FOUND', 'No summary yet');
      const severe = s.sections.find((x) => x.title === 'Threats & harm')?.sentences?.length;
      text = (severe ? 'Content warning: this summary describes threats and harassment. ' : '') + s.sections.flatMap((x) => x.sentences.map((y) => y.text)).join(' ');
    }
    const { buffer, headers } = await mlBinary('/tts', { text, lang: req.body.lang, voice: req.body.voice });
    const usage = JSON.parse(headers.get('x-provider-usage') ?? '[]');
    if (usage.length) await ProviderUsage.insertMany(usage.map((u) => ({ ...u, caseId: req.case._id })));
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'TTS_GENERATED', target: String(req.case._id), payload: { lang: req.body.lang } });
    res.set({ 'Content-Type': 'audio/wav', 'X-Sentence-Timings': headers.get('x-sentence-timings') ?? '[]', 'Cache-Control': 'no-store' });
    res.send(buffer);
  }),
);

// ------------------------------------------------------------------ integrity (V3)
caseDataRouter.post(
  '/verify',
  requireCaseRole(),
  ah(async (req, res) => {
    const cid = req.case._id;
    const entries = await AuditEntry.find({ caseId: String(cid) }).sort({ seq: 1 }).lean();
    const chain = verifyChain(String(cid), entries);
    const evidence = await Evidence.find({ caseId: cid, 'redacted.at': null }).sort({ idx: 1 });
    const files = [];
    for (const e of evidence) files.push({ evidenceId: String(e._id), idx: e.idx, filename: e.filename, ...(await verifyStored(e)) });
    const brokenFile = files.find((f) => !f.ok);
    const result = {
      ok: chain.ok && !brokenFile,
      chain,
      files,
      firstBrokenFile: brokenFile ?? null,
      merkleRoot: merkleRoot(evidence.map((e) => e.sha256)),
      auditHead: entries.at(-1)?.hash ?? null,
      verifiedAt: new Date().toISOString(),
    };
    await audit(cid, { actorId: req.user._id, actorRole: req.role, action: 'CASE_VERIFIED', target: String(cid), payload: { ok: result.ok } });
    res.json(result);
  }),
);

// ------------------------------------------------------------------ settings (C3, P)
caseDataRouter.patch(
  '/settings',
  requireCaseRole('owner'),
  validate(
    z.object({
      llmMode: z.enum(['cloud', 'cloud_redacted', 'local']).optional(),
      voiceMode: z.enum(['sarvam', 'local']).optional(),
      voiceConsent: z.boolean().optional(),
      translateMode: z.enum(['sarvam', 'sarvam_redacted', 'off']).optional(),
      timezone: z.string().max(60).optional(),
    }),
  ),
  ah(async (req, res) => {
    const c = await Case.findById(req.case._id);
    const s = c.settings;
    const b = req.body;
    if (b.llmMode) {
      // Local LLM means nothing leaves the machine unless the owner re-enables providers explicitly.
      if (b.llmMode === 'local' && s.llmMode !== 'local') {
        if (!b.voiceMode) s.voiceMode = 'local';
        if (!b.translateMode) s.translateMode = 'off';
      }
      s.llmMode = b.llmMode;
    }
    if (b.voiceMode === 'sarvam') {
      if (!b.voiceConsent && !s.voiceConsentAt) throw httpError(400, 'CONSENT_REQUIRED', 'Sending voice notes to Sarvam AI needs explicit consent');
      s.voiceMode = 'sarvam';
    } else if (b.voiceMode === 'local') s.voiceMode = 'local';
    if (b.voiceConsent === true) {
      s.voiceConsentAt = new Date();
      s.voiceConsentBy = req.user._id;
    } else if (b.voiceConsent === false) {
      s.voiceConsentAt = undefined;
      s.voiceConsentBy = undefined;
      s.voiceMode = 'local';
    }
    if (b.translateMode) s.translateMode = b.translateMode;
    if (b.timezone) c.timezone = b.timezone;
    await c.save();
    await audit(c._id, { actorId: req.user._id, actorRole: req.role, action: 'PRIVACY_SETTINGS_CHANGED', target: String(c._id), payload: { ...b, voiceConsent: b.voiceConsent } });
    res.json({ settings: c.settings, timezone: c.timezone });
  }),
);
