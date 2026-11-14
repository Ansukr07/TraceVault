// Complaint draft (future spec F3): turns the processed case into a structured, cited complaint the complainant
// can review. It assembles facts already in the case; it does not file anything and does not give legal advice.
//
// The offence table lives in data/legal/offences.json so a lawyer can review and edit it without touching code
// (regional-states-india-spec.md §4). `reviewedBy` there stays null until one has.
import { loadLegal } from './regional/data.js';
import { buildSignals, evaluateOffences } from './regional/rules.js';

const IDENT_LABEL = { PHONE: 'phone', UPI_ID: 'upi', EMAIL: 'email', HANDLE: 'handle', BANK_ACCT: 'bank', URL: 'url' };
const KINDS = new Set(Object.keys(IDENT_LABEL));

const flat = (ident = {}) =>
  Object.entries(ident).flatMap(([k, vals]) => (Array.isArray(vals) ? vals : []).map((v) => ({ kind: IDENT_LABEL[k] ?? k.toLowerCase(), value: String(v) })));

/**
 * @param {{ c: object, events: object[], entities: object[], summary: object|null, insights: object|null }} d
 */
export function buildComplaint({ c, events, entities, summary, insights }) {
  const theirs = events.filter((e) => e.sourceType !== 'self_statement');

  const sig = buildSignals({ c, events, insights });
  const offences = evaluateOffences(sig, { core: true, includeUnreviewed: true, ignoreVictimGate: true }).map(({ id, act, section, title, rationale, citations, strength }) => ({ id, act, section, title, rationale, citations, strength }));
  const ctx = { payments: sig.payment };

  // Accused identifiers: non-owner people with their linked identifiers, then loose identifiers nobody owns.
  const others = entities.filter((e) => !e.isOwner);
  const people = others.filter((e) => e.type === 'PERSON');
  const owned = new Set(people.flatMap((p) => flat(p.identifiers).map((i) => i.value)));
  const accused = people
    .map((p) => ({ name: p.name, aliases: (p.aliases ?? []).filter((a) => a !== p.name).slice(0, 4), identifiers: flat(p.identifiers), mentions: p.mentionCount ?? 0 }))
    .filter((p) => p.identifiers.length || p.mentions >= 2)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 4);
  const loose = others.filter((e) => KINDS.has(e.type) && !owned.has(e.name)).map((e) => ({ kind: IDENT_LABEL[e.type], value: e.name })).slice(0, 10);

  const times = events.map((e) => e.ts).filter(Boolean).sort();
  const loss = ctx.payments.reduce((s, e) => s + e.amount, 0);
  const demanded = theirs.filter((e) => e.amount && e.category !== 'payment').map((e) => ({ amount: e.amount, citations: e.citations?.slice(0, 1) ?? [] }));

  const narrative = (summary?.sections ?? []).filter((s) => s.sentences?.length).map((s) => ({ title: s.title, sentences: s.sentences.map((x) => ({ text: x.text, citations: x.citations ?? [], supported: x.supported !== false })) }));

  const checks = [
    { field: 'accused', ok: accused.some((a) => a.identifiers.length) || loose.length > 0, message: 'Add at least one identifier for the accused (phone, UPI ID, handle or email).' },
    { field: 'dates', ok: times.length > 0, message: 'No incident dates were found in the evidence.' },
    { field: 'narrative', ok: narrative.length > 0, message: 'No cited summary exists yet. Generate the case summary first.' },
    { field: 'evidence', ok: true, message: '' },
  ];

  return {
    case: { id: String(c._id), title: c.title, incidentType: c.incidentType },
    incident: { from: times[0] ?? null, to: times.at(-1) ?? null, category: c.incidentType, eventCount: events.length },
    accused,
    looseIdentifiers: loose,
    money: { lossInr: loss || null, demands: demanded.slice(0, 6) },
    narrative,
    offences,
    offenceNote: loadLegal().offences.note,
    offencesReviewedBy: loadLegal().offences.offences.filter((o) => o.core).every((o) => o.reviewedBy) ? loadLegal().offences.offences.find((o) => o.core).reviewedBy : null,
    checks,
    generatedAt: new Date().toISOString(),
  };
}
