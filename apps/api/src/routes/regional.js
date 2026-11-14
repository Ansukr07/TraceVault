// Regional complaint routing and report export (regional-states-india-spec.md §6, §8). Owner only.
// Complainant personal details arrive in the POST body for a single render and are never stored.
import { Router } from 'express';
import { ah, httpError, requireAuth, requireCaseRole, validate, z } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { buildComplaint } from '../services/complaint.js';
import { collect, fileHash } from '../services/export.js';
import { CaseSnapshot, Entity, Summary, TimelineEvent } from '../models/index.js';
import { resolveRegional } from '../services/regional/profile.js';
import { TEMPLATES } from '../services/regional/templates.js';
import { renderPdf, send } from './export.js';
import { seesUnreviewed } from './legal.js';

export const regionalRouter = Router({ mergeParams: true });
regionalRouter.use(requireAuth);

const setSchema = z.object({
  complainantCity: z.string().trim().max(80).optional(),
  incidentCity: z.string().trim().max(80).optional(),
  locality: z.string().trim().max(120).optional(),
  preferredLanguage: z.enum(['en', 'hi', 'mr', 'bn', 'ta', 'kn', 'te', 'gu', 'ur']).optional(),
  victimGender: z.enum(['female', 'male', 'other', 'undisclosed']).optional(),
  victimIsMinor: z.boolean().optional(),
});

const reportBody = z.object({
  complainant: z.object({ name: z.string().max(120).optional(), phone: z.string().max(30).optional(), email: z.string().max(120).optional(), address: z.string().max(400).optional() }).optional(),
  platform: z.enum(['instagram', 'whatsapp', 'x', 'telegram', 'facebook', 'snapchat', 'other']).optional(),
  handles: z.array(z.string().max(200)).max(10).optional(),
  bank: z.string().max(120).optional(),
});

async function load(req) {
  const cid = req.case._id;
  const [events, entities, summary, snap] = await Promise.all([
    TimelineEvent.find({ caseId: cid }).sort({ ts: 1 }).lean(),
    Entity.find({ caseId: cid }).sort({ mentionCount: -1 }).lean(),
    Summary.findOne({ caseId: cid, lang: 'en-IN' }).sort({ version: -1 }).lean(),
    CaseSnapshot.findOne({ caseId: cid }, 'insights').lean(),
  ]);
  const c = req.case.toObject();
  const insights = snap?.insights ?? null;
  const resolved = resolveRegional({ c, events, insights }, { includeUnreviewed: seesUnreviewed(req) });
  return { c, events, entities, summary, insights, resolved };
}

regionalRouter.put(
  '/',
  requireCaseRole('owner'),
  validate(setSchema),
  ah(async (req, res) => {
    req.case.regional = { ...(req.case.regional?.toObject?.() ?? {}), ...req.body };
    await req.case.save();
    await audit(req.case._id, { actorId: req.user._id, actorRole: req.role, action: 'REGIONAL_PROFILE_SET', target: String(req.case._id), payload: { city: req.body.complainantCity ?? null, lang: req.body.preferredLanguage ?? null } });
    res.json({ regional: req.case.regional });
  }),
);

regionalRouter.get(
  '/resolve',
  requireCaseRole('owner'),
  ah(async (req, res) => {
    const { resolved } = await load(req);
    res.json({ regional: resolved });
  }),
);

regionalRouter.post(
  '/report/:code.pdf',
  requireCaseRole('owner'),
  validate(reportBody),
  ah(async (req, res) => {
    const code = req.params.code.toUpperCase();
    const tpl = TEMPLATES[code];
    if (!tpl) throw httpError(404, 'NOT_FOUND', 'Unknown report');
    const { c, events, entities, summary, insights, resolved } = await load(req);
    if (resolved.input.victimIsMinor) throw httpError(409, 'MINOR_CASE', resolved.minorNotice);
    const draft = buildComplaint({ c, events, entities, summary, insights });
    const d = await collect(req);
    const html = tpl({ draft, resolved, d, ...req.body });
    const pdf = await renderPdf(html, { title: `${code}: ${c.title}`, footer: `DRAFT · ${d.stamp}`, header: `TraceVault · ${code} (draft)` });
    await audit(c._id, {
      actorId: req.user._id, actorRole: req.role, action: 'REGIONAL_REPORT_EXPORTED', target: String(c._id),
      payload: { code, profileId: resolved.profile.id, catalogueSha256: resolved.stamp.catalogueSha256, sha256: fileHash(pdf) },
    });
    send(res, pdf, `tracevault-${code.toLowerCase()}-${String(c._id).slice(-6)}.pdf`, 'application/pdf');
  }),
);
