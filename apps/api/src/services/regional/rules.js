// Offence rule engine. Rules are JSON (data/legal/offences.json); this file turns a processed case into named
// signals and evaluates the rules against them. Matches are candidates for a lawyer to confirm, never conclusions.
import { loadLegal } from './data.js';

const RX = {
  evade: /\bblock(?:ed)?\b|new (?:account|number|sim|handle|profile)|another (?:account|number|sim)|second sim/i,
  fake: /fake (?:account|profile|id)|impersonat|pretend(?:ing)? to be|using my (?:name|photos?|pics?)/i,
  shame: /\bviral\b|\bstory is live\b|\bposted\b.{0,30}\b(?:public|story|insta|facebook)|\bviews\b|\bexpos(?:e|ed|ing)\b/i,
};
const SEVERITY_LABELS = ['threat', 'sexual', 'extortion'];

/** Case data -> { signalName: [events] }. The complainant’s own statements are never counted against the accused. */
export function buildSignals({ c, events, insights }) {
  const theirs = events.filter((e) => e.sourceType !== 'self_statement');
  const has = (e, l) => (e.labels ?? []).includes(l);
  const text = (e) => `${e.title ?? ''} ${e.description ?? ''}`;
  const evade = theirs.filter((e) => RX.evade.test(text(e)));
  const contactsTotal = insights?.messageCount ?? theirs.length;
  const persistent = (insights?.escalation?.length ?? 0) >= 2 || !!insights?.escalating;
  const payments = events.filter((e) => e.category === 'payment' && e.amount);
  const sig = {
    threat: theirs.filter((e) => has(e, 'threat')),
    extortion: theirs.filter((e) => has(e, 'extortion')),
    sexual: theirs.filter((e) => has(e, 'sexual')),
    abuse: theirs.filter((e) => has(e, 'abuse')),
    evasion: evade,
    impersonation: theirs.filter((e) => RX.fake.test(text(e))),
    public_shaming: theirs.filter((e) => RX.shame.test(text(e)) && SEVERITY_LABELS.some((l) => has(e, l))),
    payment: payments,
    contact_sample: theirs.slice(0, 3),
  };
  sig.persistent_contact = persistent && (contactsTotal >= 8 || evade.length > 0) ? theirs : [];
  sig.fraud_case = c?.incidentType === 'fraud' ? theirs : [];
  return sig;
}

function holds(expr, sig) {
  if (expr == null) return false;
  if (typeof expr === 'string') return (sig[expr]?.length ?? 0) > 0;
  if (expr.all) return expr.all.every((e) => holds(e, sig));
  if (expr.any) return expr.any.some((e) => holds(e, sig));
  if (expr.not) return !holds(expr.not, sig);
  return false;
}

function evidenceFor(spec, sig) {
  if (Array.isArray(spec)) return spec.flatMap((n) => sig[n] ?? []);
  if (spec?.firstOf) {
    for (const n of spec.firstOf) if (sig[n]?.length) return sig[n];
  }
  return [];
}

const cites = (list) => [...new Set(list.flatMap((e) => e.citations ?? []))].slice(0, 5);

/**
 * @param {object} sig         from buildSignals
 * @param {object} opts
 *   core               only the original nine national rules (keeps the legacy complaint draft unchanged)
 *   includeUnreviewed  show rules nobody has signed off on (admins, dev); each result is flagged `unreviewed`
 *   victimGender       'female' enables woman_victim rules; never inferred, only stated by the user
 *   ignoreVictimGate   legacy complaint draft behaviour
 */
export function evaluateOffences(sig, { core = false, includeUnreviewed = false, victimGender = null, ignoreVictimGate = false } = {}) {
  const { offences } = loadLegal();
  const cutover = new Date(offences.cutover).getTime();
  const out = [];
  for (const o of offences.offences) {
    if (o.status === 'struck_down') continue; // guard G4: never emitted, whatever the evidence says
    if (core && !o.core) continue;
    if (!includeUnreviewed && !o.reviewedBy) continue;
    if (o.appliesTo === 'woman_victim' && !ignoreVictimGate && victimGender !== 'female') continue;
    if (!holds(o.when, sig)) continue;
    const ev = [...new Set(evidenceFor(o.evidence, sig))];
    const stamped = ev.map((e) => new Date(e.ts).getTime()).filter((t) => !Number.isNaN(t));
    const pre = stamped.filter((t) => t < cutover).length;
    const post = stamped.length - pre;
    out.push({
      id: o.id, act: o.act, section: o.section, title: o.title, legacy: o.legacy,
      plainMeaning: o.plainMeaning,
      rationale: `Possible because the evidence shows ${o.plainMeaning}.`,
      citations: cites(ev),
      strength: ev.length >= 2 ? 'strong' : 'possible',
      eras: { preCutover: pre, postCutover: post },
      display: displaySection(o, pre, post),
      unreviewed: !o.reviewedBy,
    });
  }
  return out;
}

/** Events before 1 July 2024 are cited under the old IPC section first, BNS in brackets; later events the reverse. */
export function displaySection(o, pre, post) {
  const now = `${shortAct(o.act)} s.${o.section}`;
  if (!o.legacy) return now;
  const old = `${shortAct(o.legacy.act)} s.${o.legacy.section}`;
  if (pre > 0 && post === 0) return `${old} (${now})`;
  if (pre > 0) return `${now} (${old} for events before 1 July 2024)`;
  return now;
}
const shortAct = (a) => (/Nyaya/.test(a) ? 'BNS' : /Penal/.test(a) ? 'IPC' : /Information Technology/.test(a) ? 'IT Act' : a);
