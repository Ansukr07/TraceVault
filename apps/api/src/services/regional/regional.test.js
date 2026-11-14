import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegal, setLegalForTest } from './data.js';
import { buildSignals, evaluateOffences } from './rules.js';
import { recipientsFor, resolveCity, resolveRegional, selectProfile } from './profile.js';
import { TEMPLATES } from './templates.js';
import { buildComplaint } from '../complaint.js';

const ev = (o) => ({ sourceType: 'document', labels: [], severity: 0, citations: [], category: 'contact', title: '', description: '', ...o });
const events = [
  ev({ ts: '2024-09-02T21:00', citations: ['E1:1'], description: 'why did you block me' }),
  ev({ ts: '2024-09-12T02:10', labels: ['threat'], citations: ['E4:2'], description: 'dekh lena' }),
  ev({ ts: '2024-09-14T02:30', labels: ['threat'], citations: ['E4:5'], description: 'maar dunga' }),
  ev({ ts: '2024-09-20T01:10', labels: ['extortion'], amount: 15000, citations: ['E6:2'], category: 'extortion', description: 'send 15000 or I leak your photos' }),
  ev({ ts: '2024-09-21T10:00', labels: ['sexual', 'threat'], citations: ['E6:3'], description: 'your private photos will go viral' }),
  ev({ ts: '2024-09-22T09:00', labels: ['abuse'], citations: ['E5:1'], description: 'fake account created in your name, story is live, 412 views' }),
  ev({ ts: '2024-09-24T09:00', category: 'payment', amount: 25000, citations: ['E10:1'], description: 'UPI debit' }),
];
const insights = { escalating: true, escalation: [{}, {}, {}], messageCount: 40 };
const c = { _id: 'c1', title: 'Test case', incidentType: 'harassment', regional: {} };
const sig = buildSignals({ c, events, insights });
const ids = (list) => list.map((o) => o.id);

test('the original nine offences match exactly what the old inline table matched', () => {
  const got = ids(evaluateOffences(sig, { core: true, includeUnreviewed: true, ignoreVictimGate: true })).sort();
  assert.deepEqual(got, ['defamation', 'extortion', 'identity', 'intimidation', 'modesty', 'personation', 'privacy', 'stalking']);
  const d = buildComplaint({ c, events, entities: [], summary: null, insights });
  assert.deepEqual(ids(d.offences).sort(), got);
});

test('unreviewed rows are hidden from end users and shown, flagged, to admins', () => {
  assert.deepEqual(evaluateOffences(sig, {}), []);
  const all = evaluateOffences(sig, { includeUnreviewed: true, victimGender: 'female' });
  assert.ok(all.length > 0 && all.every((o) => o.unreviewed));
});

test('section 66A never appears, even when the evidence matches its trigger signals', () => {
  assert.ok(sig.threat.length > 0);
  const all = evaluateOffences(sig, { includeUnreviewed: true, victimGender: 'female' });
  assert.ok(!all.some((o) => o.id === 'it_66a' || o.section === '66A'));
  const row = loadLegal().offences.offences.find((o) => o.id === 'it_66a');
  assert.equal(row.status, 'struck_down');
});

test('woman-victim provisions need a stated victimGender, never an inferred one', () => {
  const without = ids(evaluateOffences(sig, { includeUnreviewed: true }));
  const withF = ids(evaluateOffences(sig, { includeUnreviewed: true, victimGender: 'female' }));
  for (const id of ['modesty', 'sexual_harassment']) {
    assert.ok(!without.includes(id), id);
    assert.ok(withF.includes(id), id);
  }
  assert.ok(!ids(evaluateOffences(sig, { includeUnreviewed: true, victimGender: 'undisclosed' })).includes('modesty'));
});

test('events before 1 July 2024 cite the IPC section first, later ones BNS first', () => {
  const old = [ev({ ts: '2024-03-01T10:00', labels: ['threat'], citations: ['E1:1'] })];
  const o1 = evaluateOffences(buildSignals({ c, events: old, insights: null }), { includeUnreviewed: true }).find((o) => o.id === 'intimidation');
  assert.equal(o1.display, 'IPC s.503/506 (BNS s.351)');
  const mixed = [...old, ev({ ts: '2024-09-01T10:00', labels: ['threat'], citations: ['E1:2'] })];
  const o2 = evaluateOffences(buildSignals({ c, events: mixed, insights: null }), { includeUnreviewed: true }).find((o) => o.id === 'intimidation');
  assert.match(o2.display, /^BNS s\.351 \(IPC s\.503\/506 for events before 1 July 2024\)$/);
  const o3 = evaluateOffences(sig, { includeUnreviewed: true }).find((o) => o.id === 'intimidation');
  assert.equal(o3.display, 'BNS s.351');
});

test('city resolution matches aliases and returns the boundary question instead of guessing', () => {
  assert.equal(resolveCity({ complainantCity: 'Bangalore' }).id, 'blr');
  assert.equal(resolveCity({ complainantCity: 'Calcutta' }).id, 'kol');
  const h = resolveCity({ complainantCity: 'Secunderabad' });
  assert.equal(h.id, 'hyd');
  assert.match(h.boundary.question, /commissionerate/);
  assert.equal(resolveCity({ complainantCity: 'Shimla' }).id, null);
});

test('an unreviewed or stale profile falls back to the national route and says why', () => {
  const s = selectProfile('blr', {});
  assert.equal(s.fellBack, true);
  assert.equal(s.profile.id, 'national');
  assert.match(s.reason, /not been reviewed/);
  const adm = selectProfile('blr', { includeUnreviewed: true });
  assert.equal(adm.profile.id, 'blr');
  assert.equal(adm.unreviewed, true);
});

test('a reviewed, sourced profile is used until 180 days after verification', () => {
  const real = loadLegal();
  const patched = structuredClone(real);
  const m = patched.metros.metros.find((x) => x.id === 'blr');
  Object.assign(m, { reviewedBy: 'Adv. Test', source: 'https://example.invalid', verifiedAt: '2026-10-01' });
  setLegalForTest(patched);
  try {
    const now = new Date('2026-11-14').getTime();
    assert.equal(selectProfile('blr', { now }).profile.id, 'blr');
    const later = new Date('2027-05-01').getTime();
    assert.equal(selectProfile('blr', { now: later }).fellBack, true);
    m.source = null;
    assert.equal(selectProfile('blr', { now }).fellBack, true);
  } finally {
    setLegalForTest(real);
  }
});

test('recipients put the 1930 route first when money was lost, and never invent contact details', () => {
  const { profile } = selectProfile('del', { includeUnreviewed: true });
  const r = recipientsFor(profile, [], { hasPayment: true, victimGender: 'female', victimIsMinor: false });
  assert.equal(r[0].id, 'financial_fraud');
  assert.ok(r[0].contacts.some((x) => x.phone === '1930'));
  const unit = r.find((x) => x.id === 'cyber_unit');
  assert.deepEqual(unit.contacts, []); // no verified phone or portal in the registry, so none is printed
  assert.ok(r.some((x) => x.id === 'any_station'));
  assert.ok(r.some((x) => x.id === 'women'));
});

test('a minor victim gets no offences or reports, only the child-help route', () => {
  const r = resolveRegional({ c: { ...c, regional: { victimIsMinor: true, complainantCity: 'Delhi' } }, events, insights }, { includeUnreviewed: true });
  assert.deepEqual(r.offences, []);
  assert.deepEqual(r.reports, []);
  assert.match(r.minorNotice, /1098/);
  assert.deepEqual(r.recipients.map((x) => x.id), ['child']);
});

test('resolveRegional hides unreviewed provisions from end users but counts them', () => {
  const user = resolveRegional({ c: { ...c, regional: { complainantCity: 'Pune' } }, events, insights }, {});
  assert.deepEqual(user.offences, []);
  assert.ok(user.offencesHidden > 0);
  assert.equal(user.profile.id, 'national');
  assert.equal(user.profile.fellBack, true);
  assert.equal(user.city.boundary.options.includes('Pimpri-Chinchwad'), true);
  const admin = resolveRegional({ c: { ...c, regional: { complainantCity: 'Pune' } }, events, insights }, { includeUnreviewed: true });
  assert.equal(admin.profile.id, 'pnq');
  assert.equal(admin.unreviewed, true);
  assert.match(admin.stamp.catalogueSha256, /^[0-9a-f]{64}$/);
});

test('report templates render escaped, addressed to the city authority, with draft and unreviewed banners', () => {
  const resolved = resolveRegional({ c: { ...c, regional: { complainantCity: 'Mumbai', victimGender: 'female' } }, events, insights }, { includeUnreviewed: true });
  const draft = buildComplaint({ c, events, entities: [{ type: 'PERSON', name: 'A <b>Bad</b> Actor', mentionCount: 9, identifiers: { UPI_ID: ['x@ybl'] } }], summary: null, insights });
  const d = { evidence: [{ idx: 1, filename: 'chat.txt', sha256: 'ab'.repeat(32) }], merkle: 'cd'.repeat(32), auditHead: 'ef'.repeat(32), chain: { ok: true }, events };
  for (const code of Object.keys(TEMPLATES)) {
    const html = TEMPLATES[code]({ draft, resolved, d, complainant: { name: 'Asha <script>' } });
    assert.match(html, /DRAFT|Draft/);
    assert.match(html, /UNREVIEWED/);
    assert.doesNotMatch(html, /<script>|<b>Bad<\/b>/);
    assert.doesNotMatch(html, /66A/);
  }
  const rg1 = TEMPLATES.RG1({ draft, resolved, d, complainant: {} });
  assert.match(rg1, /Commissioner of Police, Mumbai/);
  assert.match(rg1, /Zero FIR/);
  assert.match(TEMPLATES.RG4({ draft, resolved, d, complainant: {} }), /1930/);
});
