// Read-only legal reference data (regional-states-india-spec.md §8). Unreviewed rows are hidden from end users:
// a lawyer sets `reviewedBy` in data/legal/*.json. Admins, and a dev flag, can see everything (flagged unreviewed).
import { Router } from 'express';
import { ah, httpError, requireAuth } from '../middleware/index.js';
import { loadLegal } from '../services/regional/data.js';
import { selectProfile } from '../services/regional/profile.js';

export const legalRouter = Router();
legalRouter.use(requireAuth);

export const seesUnreviewed = (req) => !!req.user.isAdmin || process.env.LEGAL_ALLOW_UNREVIEWED === '1';

legalRouter.get(
  '/metros',
  ah(async (req, res) => {
    const { metros } = loadLegal().metros;
    const all = seesUnreviewed(req);
    const list = metros
      .map((m) => ({ m, sel: selectProfile(m.id, { includeUnreviewed: all }) }))
      .filter(({ sel }) => !sel.fellBack)
      .map(({ m, sel }) => ({ id: m.id, name: m.name, state: m.state, languages: m.languages, hasBoundaryQuestion: !!m.boundary, unreviewed: sel.unreviewed }));
    res.json({ metros: list, note: 'Cities not listed use the national route (nearest police station and cybercrime.gov.in) until their profile is reviewed.' });
  }),
);

legalRouter.get(
  '/metros/:id',
  ah(async (req, res) => {
    const sel = selectProfile(req.params.id, { includeUnreviewed: seesUnreviewed(req) });
    if (sel.fellBack) throw httpError(404, 'NOT_FOUND', 'No reviewed profile for this city');
    res.json({ profile: sel.profile, unreviewed: sel.unreviewed });
  }),
);

legalRouter.get(
  '/offences',
  ah(async (req, res) => {
    const { offences } = loadLegal();
    const all = seesUnreviewed(req);
    const rows = offences.offences.filter((o) => o.status !== 'struck_down' && (all || o.reviewedBy));
    res.json({ version: offences.version, note: offences.note, offences: rows.map(({ when, evidence, ...o }) => ({ ...o, unreviewed: !o.reviewedBy })) });
  }),
);

legalRouter.get(
  '/crosswalk',
  ah(async (req, res) => {
    const { crosswalk } = loadLegal();
    if (!crosswalk.reviewedBy && !seesUnreviewed(req)) return res.json({ note: crosswalk.note, rows: [], awaitingReview: true });
    res.json({ note: crosswalk.note, rows: crosswalk.rows, awaitingReview: !crosswalk.reviewedBy });
  }),
);
