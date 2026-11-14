// Escalation risk indicator (future spec F5). A transparent weighted-rules model, not a black box: every point
// comes from a named signal with the evidence behind it. It is advisory ("patterns advocates treat as higher
// risk"), never a prediction, and is shown to the complainant only.

export const RESOURCES = {
  verifyBeforeLaunch: true, // numbers and sites must be re-checked by an advocate before real use
  items: [
    { name: 'Emergency (police, fire, ambulance)', phone: '112', note: 'If you are in immediate danger' },
    { name: 'National Cyber Crime Helpline', phone: '1930', url: 'https://cybercrime.gov.in', note: 'Report online fraud, extortion and harassment' },
    { name: 'Women Helpline', phone: '181', note: 'Support and referral, 24x7' },
  ],
};

export const DISCLAIMER = 'Signals in this case match patterns that advocates treat as higher-risk. This is not a prediction and not a diagnosis.';

const RX = {
  blockEvasion: /\bblock(?:ed)?\b|\bunblock\b|new (?:account|number|sim|handle|profile)|another (?:account|number|sim)|second sim|fake (?:account|profile)/i,
  proximity: /where you (?:live|stay|work)|your (?:pg|hostel|office|metro|gate|college|house|home)|outside your|following you|saw you|waiting (?:outside|near)|come to your|find you/i,
};

const LEVELS = [
  [65, 'high'],
  [35, 'elevated'],
  [0, 'low'],
];

/**
 * @param {{events: object[], insights: object|null, incidentType?: string}} d
 * Events are the case TimelineEvents (labels, category, severity, citations, description).
 */
export function assessRisk({ events, insights }) {
  const theirs = events.filter((e) => e.sourceType !== 'self_statement');
  const cites = (list) => [...new Set(list.flatMap((e) => e.citations ?? []))].slice(0, 4);
  const has = (e, label) => (e.labels ?? []).includes(label);
  const signals = [];
  const add = (id, label, weight, detail, evs = []) => signals.push({ id, label, weight, detail, citations: cites(evs) });

  const threats = theirs.filter((e) => has(e, 'threat'));
  if (threats.length) add('threats', 'Threats of harm', threats.length >= 3 ? 28 : 20, `${threats.length} message(s) contain threats.`, threats);

  const sexual = theirs.filter((e) => has(e, 'sexual'));
  if (sexual.length) add('sexual', 'Threats involving intimate images or sexual content', 20, `${sexual.length} message(s) refer to private images or sexual content.`, sexual);

  const coercion = theirs.filter((e) => has(e, 'extortion') || (has(e, 'financial_request') && e.severity >= 2));
  if (coercion.length) add('coercion', 'Money demanded under pressure', 15, `${coercion.length} message(s) demand payment or threaten exposure.`, coercion);

  if (insights?.escalating) add('escalating', 'Messages are getting more severe over time', 15, 'The weekly severity of messages from the other person is rising.');

  const weeks = insights?.escalation?.length ?? 0;
  if (weeks >= 3) add('persistence', 'Contact has continued for weeks', 8, `Harmful messages appear across ${weeks} different weeks.`);

  const evade = theirs.filter((e) => RX.blockEvasion.test(`${e.title ?? ''} ${e.description ?? ''}`));
  if (evade.length) add('block_evasion', 'Contact continues after blocking, or from new accounts', 10, 'Messages mention being blocked, new numbers, new accounts or fake profiles.', evade);

  const near = theirs.filter((e) => e.category === 'meeting' || RX.proximity.test(e.description ?? ''));
  if (near.length) add('proximity', 'References to your location or meeting in person', 12, 'Messages show knowledge of where you live, study or work, or ask to meet.', near);

  const night = (insights?.peakHours ?? []).filter((h) => h >= 0 && h < 5).length;
  if (night) add('night', 'Many messages arrive in the small hours', 4, 'The busiest message hours are between midnight and 5 am.');

  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const level = LEVELS.find(([min]) => score >= min)[1];
  return { score, level, signals: signals.sort((a, b) => b.weight - a.weight), disclaimer: DISCLAIMER, resources: level === 'low' ? null : RESOURCES };
}
