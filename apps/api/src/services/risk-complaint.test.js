import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from './risk.js';
import { buildComplaint } from './complaint.js';
import { fromFlags } from './authenticity.js';

const ev = (o) => ({ sourceType: 'document', labels: [], severity: 0, citations: [], category: 'contact', title: '', description: '', ...o });

// Shaped like the Ananya demo case: persistent contact, block evasion, threats, extortion, fake account, payments.
const events = [
  ev({ ts: '2024-09-02T21:00', severity: 1, citations: ['E1:1'], description: 'hi, why did you block me' , title: 'Karthik messaged' }),
  ev({ ts: '2024-09-09T23:10', severity: 1, citations: ['E2:3'], description: 'texting from my new account since you blocked me' }),
  ev({ ts: '2024-09-12T02:10', severity: 2, labels: ['threat'], citations: ['E4:2'], description: 'tera college aur your PG gate, dekh lena' }),
  ev({ ts: '2024-09-14T02:30', severity: 2, labels: ['threat'], citations: ['E4:5'], description: 'maar dunga' }),
  ev({ ts: '2024-09-20T01:10', severity: 3, labels: ['extortion', 'financial_request'], amount: 15000, citations: ['E6:2'], category: 'extortion', description: 'Send 15000 or I leak your photos' }),
  ev({ ts: '2024-09-21T10:00', severity: 2, labels: ['sexual', 'threat'], citations: ['E6:3'], description: 'your private photos will go viral' }),
  ev({ ts: '2024-09-22T09:00', severity: 2, labels: ['abuse'], citations: ['E5:1'], description: 'fake account created in your name, story is live, 412 views' }),
  ev({ ts: '2024-09-24T09:00', category: 'payment', amount: 25000, citations: ['E10:1'], description: 'UPI debit' }),
  ev({ ts: '2024-09-26T09:00', category: 'payment', amount: 10000, citations: ['E10:2'], description: 'UPI debit' }),
];
const insights = { escalating: true, escalation: [{}, {}, {}, {}], peakHours: [1, 2, 23], messageCount: 40 };

test('a harassment-and-extortion case is rated high with cited, named signals', () => {
  const r = assessRisk({ events, insights });
  assert.equal(r.level, 'high');
  assert.ok(r.score >= 65 && r.score <= 100);
  const ids = r.signals.map((s) => s.id);
  for (const id of ['threats', 'sexual', 'coercion', 'escalating', 'persistence', 'block_evasion', 'proximity', 'night']) assert.ok(ids.includes(id), id);
  assert.ok(r.signals.every((s) => s.label && s.weight > 0));
  assert.ok(r.signals.find((s) => s.id === 'threats').citations.includes('E4:2'));
  assert.match(r.disclaimer, /not a prediction/);
  assert.ok(r.resources.items.some((i) => i.phone === '112'));
  assert.deepEqual(r.signals.map((s) => s.weight), [...r.signals.map((s) => s.weight)].sort((a, b) => b - a));
});

test('a benign case is low and offers no emergency panel', () => {
  const r = assessRisk({ events: [ev({ severity: 0, description: 'see you at lunch' })], insights: { escalating: false, escalation: [{}], peakHours: [13] } });
  assert.equal(r.level, 'low');
  assert.equal(r.score, 0);
  assert.equal(r.resources, null);
});

test('the complainant’s own statement is never counted as a signal', () => {
  const r = assessRisk({ events: [ev({ sourceType: 'self_statement', labels: ['threat'], severity: 2, description: 'he said he would find you' })], insights: null });
  assert.equal(r.score, 0);
});

const entities = [
  { type: 'PERSON', name: 'Ananya Rao', isOwner: true },
  { type: 'PERSON', name: 'Karthik Menon', aliases: ['Karthik', '@karthik.clicks'], mentionCount: 30, identifiers: { PHONE: ['+91 98450 01234'], UPI_ID: ['karthik.menon@okicici', 'ktk.pay88@ybl'], HANDLE: ['karthik.clicks'] } },
  { type: 'UPI_ID', name: 'orphan@ybl', mentionCount: 1 },
  { type: 'UPI_ID', name: 'ktk.pay88@ybl', mentionCount: 2 },
];
const summary = { sections: [{ title: 'What happened', sentences: [{ text: 'He sent threats.', citations: ['E4:2'], supported: true }, { text: 'Unchecked line.', citations: [], supported: false }] }, { title: 'Empty', sentences: [] }] };
const c = { _id: 'c1', title: 'Ananya Rao – harassment', incidentType: 'harassment' };

test('complaint draft gathers accused identifiers, losses, dates and cited narrative', () => {
  const d = buildComplaint({ c, events, entities, summary, insights });
  assert.equal(d.accused.length, 1);
  assert.equal(d.accused[0].name, 'Karthik Menon');
  assert.deepEqual(d.accused[0].identifiers.map((i) => i.kind).sort(), ['handle', 'phone', 'upi', 'upi']);
  assert.deepEqual(d.looseIdentifiers, [{ kind: 'upi', value: 'orphan@ybl' }]); // already-linked ones are not repeated
  assert.equal(d.money.lossInr, 35000);
  assert.deepEqual(d.money.demands.map((m) => m.amount), [15000]);
  assert.equal(d.incident.from, '2024-09-02T21:00');
  assert.equal(d.incident.to, '2024-09-26T09:00');
  assert.equal(d.narrative.length, 1); // empty section dropped
  assert.equal(d.narrative[0].sentences[1].supported, false); // unsupported sentence stays flagged
  assert.ok(d.checks.every((k) => k.ok));
});

test('offence suggestions are candidates tied to evidence, never an assertion', () => {
  const d = buildComplaint({ c, events, entities, summary, insights });
  const ids = d.offences.map((o) => o.id);
  for (const id of ['intimidation', 'extortion', 'stalking', 'modesty', 'privacy', 'defamation', 'identity']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('cheating')); // not a fraud case
  const ext = d.offences.find((o) => o.id === 'extortion');
  assert.ok(ext.citations.includes('E6:2'));
  assert.match(ext.rationale, /^Possible because/);
  assert.equal(d.offencesReviewedBy, null); // no lawyer sign-off yet, and the UI must say so
  assert.match(d.offenceNote, /not by legal analysis/);
  assert.ok(d.offences.every((o) => o.act && o.section && o.title));
});

test('an empty case fails the completeness checks instead of inventing content', () => {
  const d = buildComplaint({ c, events: [], entities: [], summary: null, insights: null });
  const bad = d.checks.filter((k) => !k.ok).map((k) => k.field).sort();
  assert.deepEqual(bad, ['accused', 'dates', 'narrative']);
  assert.deepEqual(d.offences, []);
});

test('metadata-only authenticity: editor flag is high risk, clean file is low, wording stays indicative', () => {
  const edited = fromFlags({ flags: [{ type: 'EDITED_FILE', field: 'Software', value: 'Snapseed 2.0' }] });
  assert.equal(edited.band, 'high');
  assert.match(edited.checks[0].summary, /Snapseed/);
  const clean = fromFlags({ flags: [] });
  assert.equal(clean.band, 'low');
  for (const r of [edited, clean]) {
    assert.match(r.disclaimer, /not a forensic conclusion/i);
    assert.doesNotMatch(JSON.stringify(r), /\b(fake|forged|proof of)\b/i);
  }
});
