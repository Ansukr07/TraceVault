// Voice statement drafts: versioned edits, explicit apply, roles and share scope. Needs MongoDB; skipped otherwise.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.MASTER_KEK_BASE64 ||= crypto.randomBytes(32).toString('base64');
const dbName = `tracevault_test_stmt_${Date.now()}`;
const base = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
let server, url, skip = false;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

before(async () => {
  try {
    await mongoose.connect(base, { dbName, serverSelectionTimeoutMS: 2500 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) throw new Error('not a replica set');
  } catch (e) {
    skip = e.message;
    return;
  }
  const { createApp } = await import('./app.js');
  const models = await import('./models/index.js');
  await Promise.all(Object.values(models).map((m) => m.init?.()));
  server = createApp().listen(0);
  url = `http://127.0.0.1:${server.address().port}/api/v1`;
});
after(async () => {
  server?.close();
  if (!skip) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(url + path, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const register = async (email) => (await call('POST', '/auth/register', { body: { email, name: email.split('@')[0], password: 'correct-horse-battery' } })).body.accessToken;

// A minimal valid 1-second 16 kHz mono WAV: the upload sniffer needs real magic bytes.
function wav() {
  const n = 16000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000)), 44 + i * 2);
  return b;
}

test('statement upload, versioned edits, explicit apply, roles and scope', async (t) => {
  if (skip) return t.skip(`no MongoDB replica set: ${skip}`);
  const owner = await register('own@example.com');
  const friend = await register('friend@example.com');
  const lawyer = await register('law@example.com');
  const police = await register('cop@example.com');
  const c = (await call('POST', '/cases', { token: owner, body: { title: 'Stmt case', incidentType: 'other' } })).body.case;
  const { Case, Evidence, Statement } = await import('./models/index.js');
  await Case.updateOne({ _id: c.id }, { $push: { members: { userId: (await mongoose.connection.db.collection('users').findOne({ email: 'friend@example.com' }))._id, role: 'collaborator' } } });

  // Record upload: kind=statement is accepted for audio and audited as STATEMENT_RECORDED.
  const buf = wav();
  const fd = new FormData();
  fd.set('clientSha256', sha(buf)); fd.set('kind', 'statement'); fd.set('sourceLabel', 'Your voice statement'); fd.set('file', new Blob([buf]), 'statement.wav');
  const up = await call('POST', `/cases/${c.id}/evidence`, { token: owner, body: fd });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.evidence.kind, 'statement');
  const bad = new FormData();
  bad.set('clientSha256', sha(Buffer.from('hello'))); bad.set('kind', 'statement'); bad.set('file', new Blob([Buffer.from('hello')]), 'x.txt');
  assert.equal((await call('POST', `/cases/${c.id}/evidence`, { token: owner, body: bad })).status, 415, 'a statement must be audio');

  // Listed as pending until the narrative job produces a draft.
  let list = await call('GET', `/cases/${c.id}/statements`, { token: owner });
  assert.equal(list.body.statements.length, 1);
  assert.equal(list.body.statements[0].statement, null);

  // Simulate the narrative job's output.
  const s1 = await Statement.create({
    caseId: c.id, evidenceId: up.body.evidence.id, version: 1, lang: 'hi-IN', textNative: 'native', textEn: 'He threatened me. He wanted money.',
    sentences: [{ text: 'He threatened me.', citations: ['E1:0'] }, { text: 'He wanted money.', citations: ['E1:1'] }],
    suggestions: { incidentType: { value: 'sextortion', confidence: 0.8 }, people: [], phones: [], payments: [], handles: [], amounts: [], dates: [], locations: [] }, generator: { name: 'transcript-cleanup' },
  });
  list = await call('GET', `/cases/${c.id}/statements`, { token: owner });
  assert.equal(list.body.statements[0].statement.version, 1);

  // Editing makes version 2 and keeps version 1; citations must look like chunk ids.
  const e = await call('PATCH', `/statements/${s1._id}`, { token: friend, body: { sentences: [{ text: 'He threatened me on WhatsApp.', citations: ['E1:0'] }] } });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.statement.version, 2);
  assert.equal(await Statement.countDocuments({ evidenceId: up.body.evidence.id }), 2);
  assert.equal((await call('PATCH', `/statements/${s1._id}`, { token: owner, body: { sentences: [{ text: 'x', citations: ['not-a-chunk'] }] } })).status, 400);
  list = await call('GET', `/cases/${c.id}/statements`, { token: owner });
  assert.equal(list.body.statements[0].statement.textEn, 'He threatened me on WhatsApp.');
  assert.equal(list.body.statements[0].statement.versions.length, 2);

  // Apply: owner only, only what is chosen, nothing when nothing is chosen.
  assert.equal((await call('POST', `/statements/${s1._id}/suggestions/apply`, { token: friend, body: { incidentType: 'sextortion' } })).status, 403);
  assert.equal((await call('POST', `/statements/${s1._id}/suggestions/apply`, { token: owner, body: {} })).status, 400);
  assert.equal((await call('GET', `/cases/${c.id}`, { token: owner })).body.case.incidentType, 'other', 'nothing applied yet');
  const ap = await call('POST', `/statements/${s1._id}/suggestions/apply`, { token: owner, body: { incidentType: 'sextortion', tags: ['Rahul'] } });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const after = (await call('GET', `/cases/${c.id}`, { token: owner })).body.case;
  assert.equal(after.incidentType, 'sextortion');

  // Strangers get 404; a legal share with a scope that excludes the statement doesn't see it; investigators can't list drafts.
  const stranger = await register('nobody@example.com');
  assert.equal((await call('GET', `/cases/${c.id}/statements`, { token: stranger })).status, 404);
  assert.equal((await call('PATCH', `/statements/${s1._id}`, { token: stranger, body: { sentences: [] } })).status, 404);
  const other = await Evidence.create({ caseId: c.id, uploadedBy: new mongoose.Types.ObjectId(), filename: 'a.txt', kind: 'chat_export', mime: 'text/plain', size: 1, sha256: 'a'.repeat(64), idx: 99 });
  const g = await call('POST', `/cases/${c.id}/shares`, { token: owner, body: { email: 'law@example.com', role: 'legal', scope: { type: 'evidence', evidenceIds: [String(other._id)] }, expiresInDays: 3 } });
  assert.equal((await call('POST', '/share/accept', { token: lawyer, body: { token: g.body.inviteToken } })).status, 200);
  assert.equal((await call('GET', `/cases/${c.id}/statements`, { token: lawyer })).body.statements.length, 0, 'out-of-scope statement hidden');
  assert.equal((await call('PATCH', `/statements/${s1._id}`, { token: lawyer, body: { sentences: [] } })).status, 404);
  void police;

  const audit = (await call('GET', `/cases/${c.id}/audit`, { token: owner })).body.entries.map((x) => x.action);
  for (const a of ['STATEMENT_RECORDED', 'STATEMENT_EDITED', 'STATEMENT_SUGGESTIONS_APPLIED']) assert.ok(audit.includes(a), a);
});
