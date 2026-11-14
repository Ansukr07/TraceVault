// Demo-facing case features (future spec): authenticity rollup (F1), escalation risk (F5), complaint draft (F3).
//   authenticity: owner, collaborator, legal, investigator (scoped) · risk: owner, collaborator · complaint: owner
import { Router } from 'express';
import { ah, requireAuth, requireCaseRole } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { authenticityFor } from '../services/authenticity.js';
import { buildComplaint } from '../services/complaint.js';
import { assessRisk } from '../services/risk.js';
import { CaseSnapshot, Entity, Evidence, Summary, TimelineEvent } from '../models/index.js';
import { evidenceFilter, scopeFor } from '../services/scope.js';

export const advancedRouter = Router({ mergeParams: true });
advancedRouter.use(requireAuth);

// Which items most need a second look. Sorted worst-first; images are analysed (and cached) on first request.
advancedRouter.get(
  '/authenticity',
  requireCaseRole('owner', 'collaborator', 'legal', 'investigator'),
  ah(async (req, res) => {
    const scope = await scopeFor(req);
    const items = await Evidence.find({ caseId: req.case._id, duplicateOf: null, 'redacted.at': { $exists: false }, ...evidenceFilter(scope, '_id') }).sort({ idx: 1 }).limit(60);
    const out = [];
    for (const e of items) {
      try {
        const { authenticity: a } = await authenticityFor(e);
        const worst = a.checks.find((c) => c.status === 'fail') ?? a.checks.find((c) => c.status === 'warn');
        out.push({ evidenceId: String(e._id), idx: e.idx, filename: e.filename, kind: e.kind, riskIndicator: a.riskIndicator, band: a.band, reason: worst?.summary ?? null });
      } catch {
        out.push({ evidenceId: String(e._id), idx: e.idx, filename: e.filename, kind: e.kind, riskIndicator: null, band: 'unknown', reason: 'Could not be analysed.' });
      }
    }
    out.sort((a, b) => (b.riskIndicator ?? -1) - (a.riskIndicator ?? -1));
    res.json({
      counts: { high: out.filter((o) => o.band === 'high').length, medium: out.filter((o) => o.band === 'medium').length, low: out.filter((o) => o.band === 'low').length },
      items: out,
      disclaimer: 'Indicators only. Not a forensic conclusion.',
    });
  }),
);

// Escalation risk: owner and collaborators only, never shared with legal/police unless the owner chooses to share it.
advancedRouter.get(
  '/risk',
  requireCaseRole('owner', 'collaborator'),
  ah(async (req, res) => {
    const [events, snap] = await Promise.all([TimelineEvent.find({ caseId: req.case._id }).lean(), CaseSnapshot.findOne({ caseId: req.case._id }, 'insights').lean()]);
    const risk = assessRisk({ events, insights: snap?.insights ?? null });
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'RISK_COMPUTED', target: String(req.case._id), payload: { level: risk.level, score: risk.score } });
    res.json({ risk: { ...risk, computedAt: new Date().toISOString(), eventCount: events.length } });
  }),
);

// Complaint draft: assembled from the case. Complainant personal details are never stored here; the wizard keeps them in the browser.
advancedRouter.get(
  '/complaint-draft',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    const cid = req.case._id;
    const [events, entities, summary, snap] = await Promise.all([
      TimelineEvent.find({ caseId: cid }).sort({ ts: 1 }).lean(),
      Entity.find({ caseId: cid }).sort({ mentionCount: -1 }).lean(),
      Summary.findOne({ caseId: cid, lang: 'en-IN' }).sort({ version: -1 }).lean(),
      CaseSnapshot.findOne({ caseId: cid }, 'insights').lean(),
    ]);
    const draft = buildComplaint({ c: req.case, events, entities, summary, insights: snap?.insights ?? null });
    await audit(cid, { actorId: req.user._id, actorRole: req.role, action: 'COMPLAINT_DRAFTED', target: String(cid), payload: { offences: draft.offences.map((o) => o.id), accused: draft.accused.length } });
    res.json({ draft });
  }),
);
