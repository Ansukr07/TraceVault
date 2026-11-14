// City resolution, profile selection and recipient list (regional-states-india-spec.md §3, §5, §6.3).
import { loadLegal } from './data.js';
import { buildSignals, evaluateOffences } from './rules.js';

export const FRESH_DAYS = 180;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-zऀ-෿ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Match free text to a registry city. Never guesses between commissionerates: the registry's boundary question is returned instead. */
export function resolveCity({ locality, incidentCity, complainantCity } = {}) {
  const { metros } = loadLegal().metros;
  for (const raw of [complainantCity, incidentCity, locality]) {
    const t = norm(raw);
    if (!t) continue;
    const m = metros.find((x) => [x.name, ...(x.aliases ?? [])].some((n) => t === norm(n) || t.includes(norm(n))));
    if (m) return { id: m.id, matchedOn: raw, boundary: m.boundary ?? null };
  }
  return { id: null, matchedOn: null, boundary: null };
}

const isFresh = (m, now) => !!m.verifiedAt && now - new Date(m.verifiedAt).getTime() < FRESH_DAYS * 86_400_000;

/**
 * A city profile is used only if a lawyer reviewed it, it has a source, and it was verified in the last 180 days.
 * Otherwise (or when the city is unknown) the national profile is used and the reason is stated.
 */
export function selectProfile(cityId, { includeUnreviewed = false, now = Date.now() } = {}) {
  const { national, metros } = loadLegal().metros;
  const m = metros.find((x) => x.id === cityId);
  if (!m) return { profile: national, fellBack: true, reason: cityId ? 'City not in the registry.' : 'No city given.', unreviewed: false };
  const ok = !!m.reviewedBy && !!m.source && isFresh(m, now);
  if (ok) return { profile: m, fellBack: false, reason: null, unreviewed: false };
  if (includeUnreviewed) return { profile: m, fellBack: false, reason: 'Profile not yet reviewed or verified.', unreviewed: true };
  return { profile: national, fellBack: true, reason: `The ${m.name} profile has not been reviewed and verified yet; showing the national route instead.`, unreviewed: false };
}

const helplines = (profile, key) => (profile.helplines ?? loadLegal().metros.national.helplines).filter((h) => h.for.includes('all') || h.for.includes(key));

/** Ordered recipients the Export page shows as tabs. Contact details come only from the registry; nothing is invented. */
export function recipientsFor(profile, offences, { hasPayment, victimGender, victimIsMinor }) {
  const nat = loadLegal().metros.national;
  const out = [];
  const fraud = hasPayment || offences.some((o) => ['cheating', 'personation', 'cheating_personation', 'identity'].includes(o.id));
  if (fraud) {
    out.push({ id: 'financial_fraud', label: 'Report the payment: 1930 / cybercrime.gov.in', report: 'RG4', urgent: true, note: 'Report quickly. Funds can sometimes be held if the transfer is reported early.', contacts: helplines(nat, 'fraud') });
  }
  const unit = profile.cyberUnits?.[0];
  if (unit) out.push({ id: 'cyber_unit', label: unit.name, report: 'RG1', authority: profile.policeBody.head, contacts: [unit.phone && { name: unit.name, phone: unit.phone }, unit.portalUrl && { name: unit.name, url: unit.portalUrl }].filter(Boolean) });
  out.push({ id: 'any_station', label: 'Any police station (Zero FIR)', report: 'RG1', authority: nat.policeBody.head, note: 'A police station cannot turn you away for wrong jurisdiction; it can register the complaint and transfer it.', contacts: [] });
  out.push({ id: 'platform', label: 'The platform where it happened', report: 'RG3', contacts: [] });
  if (victimGender === 'female') out.push({ id: 'women', label: 'Women’s help', report: null, contacts: helplines(nat, 'woman_victim').filter((h) => h.for.includes('woman_victim')) });
  if (victimIsMinor) out.push({ id: 'child', label: 'Child help', report: null, contacts: helplines(nat, 'minor_victim').filter((h) => h.for.includes('minor_victim')) });
  return out;
}

export const REPORTS = [
  { code: 'RG1', title: 'Police complaint draft', audience: 'Police station or cyber police station', format: 'pdf', roles: ['owner'] },
  { code: 'RG2', title: 'Cyber cell cover note', audience: 'Cyber police station', format: 'pdf', roles: ['owner'] },
  { code: 'RG3', title: 'Platform takedown and preservation request', audience: 'Social media or messaging platform', format: 'pdf', roles: ['owner'] },
  { code: 'RG4', title: 'Bank or UPI fraud freeze letter', audience: 'Bank nodal officer', format: 'pdf', roles: ['owner'] },
];

/** Everything the Complaint and Export pages need for one case. */
export function resolveRegional({ c, events, insights }, { includeUnreviewed = false, now = Date.now() } = {}) {
  const r = c.regional ?? {};
  const legal = loadLegal();
  const city = resolveCity(r);
  const { profile, fellBack, reason, unreviewed } = selectProfile(city.id, { includeUnreviewed, now });
  const minor = !!r.victimIsMinor;
  const sig = buildSignals({ c, events, insights });
  const offences = minor ? [] : evaluateOffences(sig, { includeUnreviewed, victimGender: r.victimGender ?? null });
  const hasPayment = sig.payment.length > 0;
  const times = events.map((e) => e.ts).filter(Boolean).sort();
  return {
    input: { complainantCity: r.complainantCity ?? null, incidentCity: r.incidentCity ?? null, locality: r.locality ?? null, preferredLanguage: r.preferredLanguage ?? 'en', victimGender: r.victimGender ?? null, victimIsMinor: minor },
    city: { id: city.id, boundary: city.boundary },
    profile: { id: profile.id, name: profile.name, policeBody: profile.policeBody, cyberUnits: profile.cyberUnits ?? [], languages: profile.languages, localNotes: profile.localNotes ?? [], fellBack, reason, unreviewed },
    offences,
    offencesHidden: !includeUnreviewed && !minor ? evaluateOffences(sig, { includeUnreviewed: true, victimGender: r.victimGender ?? null }).length - offences.length : 0,
    recipients: minor ? recipientsFor(profile, [], { hasPayment: false, victimGender: r.victimGender, victimIsMinor: true }).filter((x) => x.id === 'child') : recipientsFor(profile, offences, { hasPayment, victimGender: r.victimGender, victimIsMinor: minor }),
    reports: minor ? [] : REPORTS.map(({ code, title, audience, format }) => ({ code, title, audience, format })),
    minorNotice: minor ? 'A minor is involved. TraceVault does not generate complaint letters for this case. Call Childline 1098 or 112, or go to the nearest police station; reporting is required by law in many situations, so get help from a lawyer or child-protection officer.' : null,
    checklist: legal.procedure.checklist,
    stamp: { catalogueVersion: legal.catalogueVersion, catalogueSha256: legal.catalogueSha256, profileId: profile.id, cutover: legal.offences.cutover, firstEvent: times[0] ?? null },
    unreviewed: unreviewed || offences.some((o) => o.unreviewed),
  };
}
