// Agentic investigation (ML: System1 + LangGraph agents) and semantic search over a case.
//   owner, collaborator: full case; the latest run is saved on the case snapshot.
//   legal, investigator: run over their share scope only; results are returned, never saved over the owner's.
import { Router } from 'express';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { CaseSnapshot, Evidence } from '../models/index.js';
import { askAgent, classifyIncident, evidenceQuality, reindexCase, runInvestigation, semanticSearch } from '../services/investigation.js';
import { evidenceAllowed, scopeFor } from '../services/scope.js';

export const investigationRouter = Router({ mergeParams: true });
investigationRouter.use(requireAuth);
const ROLES = ['owner', 'collaborator', 'legal', 'investigator'];
const running = new Set(); // one investigation per case at a time

function mlUnavailable(err) {
  if (err.status === 409) return err;
  if (err.name === 'TimeoutError' || err.cause?.code === 'ECONNREFUSED' || /fetch failed/.test(err.message)) {
    return httpError(503, 'ML_UNAVAILABLE', 'The analysis service is not reachable right now. Try again in a minute.');
  }
  return err;
}

// Latest saved investigation (full-case viewers only).
investigationRouter.get(
  '/investigation',
  requireCaseRole(...ROLES),
  ah(async (req, res) => {
    const scope = await scopeFor(req);
    if (scope) return res.json({ investigation: null, scoped: true });
    const snap = await CaseSnapshot.findOne({ caseId: req.case._id }, 'investigation builtAt').lean();
    const inv = snap?.investigation ?? null;
    res.json({ investigation: inv, stale: !!(inv && snap.builtAt && new Date(inv.ranAt) < snap.builtAt), running: running.has(String(req.case._id)) });
  }),
);

investigationRouter.post(
  '/investigation',
  requireCaseRole(...ROLES),
  validate(z.object({ objective: z.string().trim().min(3).max(1000).optional() }).default({})),
  ah(async (req, res) => {
    const key = String(req.case._id);
    if (running.has(key)) throw httpError(409, 'ALREADY_RUNNING', 'An investigation is already running for this case');
    const scope = await scopeFor(req);
    running.add(key);
    try {
      const inv = await runInvestigation(req.case, scope, req.body.objective).catch((e) => { throw mlUnavailable(e); });
      inv.ranBy = { userId: String(req.user._id), role: req.role };
      if (!scope) await CaseSnapshot.updateOne({ caseId: req.case._id }, { $set: { investigation: inv } }, { upsert: true });
      await audit(req.case._id, {
        actorId: req.user._id, actorRole: req.role, action: 'INVESTIGATION_RUN', target: key,
        payload: { agents: inv.plan?.selectedAgents ?? [], system1: inv.system1?.primary ?? null, scoped: !!scope, durationMs: inv.durationMs },
      });
      res.json({ investigation: inv });
    } finally {
      running.delete(key);
    }
  }),
);

// System1 incident-type scores only (fast path, no agents).
investigationRouter.post(
  '/incident-type',
  requireCaseRole(...ROLES),
  ah(async (req, res) => {
    const out = await classifyIncident(req.case, await scopeFor(req)).catch((e) => { throw mlUnavailable(e); });
    res.json({ incident: out });
  }),
);

// Cited retrieval agent: returns evidence passages for a question (no generated answer).
investigationRouter.post(
  '/investigation/ask',
  requireCaseRole(...ROLES),
  validate(z.object({ question: z.string().trim().min(2).max(1000) })),
  ah(async (req, res) => {
    const out = await askAgent(req.case, await scopeFor(req), req.body.question).catch((e) => { throw mlUnavailable(e); });
    res.json(out);
  }),
);

investigationRouter.post(
  '/investigation/evidence-quality',
  requireCaseRole(...ROLES),
  validate(z.object({ evidenceId: z.string().optional() }).default({})),
  ah(async (req, res) => {
    const scope = await scopeFor(req);
    let target;
    if (req.body.evidenceId) {
      const e = await Evidence.findOne({ _id: req.body.evidenceId, caseId: req.case._id }, 'idx').lean().catch(() => null);
      if (!e || !evidenceAllowed(scope, e._id)) throw httpError(404, 'NOT_FOUND', 'Evidence not found');
      target = `E${e.idx}`;
    }
    const out = await evidenceQuality(req.case, scope, target).catch((e) => { throw mlUnavailable(e); });
    res.json(out);
  }),
);

// Semantic, cross-language search ("ಹಣ ಕಳುಹಿಸಿ" finds "send the payment").
investigationRouter.post(
  '/semantic-search',
  requireCaseRole(...ROLES),
  validate(z.object({ question: z.string().trim().min(2).max(1000), limit: z.number().int().min(1).max(20).optional() })),
  ah(async (req, res) => {
    const out = await semanticSearch(req.case, await scopeFor(req), req.body.question, req.body.limit ?? 8).catch((e) => { throw mlUnavailable(e); });
    res.json(out);
  }),
);

investigationRouter.post(
  '/semantic-index',
  requireCaseRole('owner', 'collaborator'),
  ah(async (req, res) => {
    const out = await reindexCase(req.case).catch((e) => { throw mlUnavailable(e); });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'SEMANTIC_INDEX_REBUILT', target: String(req.case._id), payload: out });
    res.json(out);
  }),
);
