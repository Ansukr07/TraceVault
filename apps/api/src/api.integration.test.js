// Runs against a real MongoDB replica set. Skipped automatically when none is reachable.
// Uses a throwaway database; override the server with MONGO_TEST_URI.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.MASTER_KEK_BASE64 ||= crypto.randomBytes(32).toString('base64');
const dbName = `tracevault_test_${Date.now()}`;
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
  await mongoose.syncIndexes?.();
  const models = await import('./models/index.js');
  await Promise.all(Object.values(models).map((m) => m.init()));
  server = createApp().listen(0);
  url = `http://127.0.0.1:${server.address().port}/api/v1`;
});

after(async () => {
  server?.close();
  if (!skip) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const j = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(url + path, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, cookie: r.headers.get('set-cookie') };
};

const register = async (email) => (await j('POST', '/auth/register', { body: { email, name: 'T', password: 'correct-horse-battery' } })).body.accessToken;

test('auth, RBAC, upload, seal, verify, tamper', async (t) => {
  if (skip) return t.skip(`no MongoDB replica set: ${skip}`);

  const alice = await register('alice@example.com');
  const mallory = await register('mallory@example.com');

  const c = await j('POST', '/cases', { token: alice, body: { title: 'Case A', incidentType: 'fraud' } });
  assert.equal(c.status, 201);
  const id = c.body.case.id;
  assert.equal(c.body.case.settings.voiceMode, 'local', 'no consent -> local voice');

  // Non-member gets 404, not 403
  assert.equal((await j('GET', `/cases/${id}`, { token: mallory })).status, 404);
  assert.equal((await j('GET', `/cases/${id}/evidence`, { token: mallory })).status, 404);
  assert.equal((await j('GET', '/cases/not-an-id', { token: alice })).status, 404);
  assert.equal((await j('GET', `/cases/${id}`)).status, 401);

  const upload = (buf, name, clientHash) => {
    const fd = new FormData();
    fd.set('clientSha256', clientHash ?? sha(buf));
    fd.set('file', new Blob([buf]), name);
    return j('POST', `/cases/${id}/evidence`, { token: alice, body: fd });
  };

  const chat = Buffer.from('12/05/24, 9:41 pm - Rahul: send 5000 or else\n');
  const u1 = await upload(chat, 'WhatsApp Chat.txt');
  assert.equal(u1.status, 201, JSON.stringify(u1.body));
  assert.equal(u1.body.evidence.sha256, sha(chat));
  assert.equal(u1.body.duplicate, false);

  assert.equal((await upload(chat, 'again.txt')).body.duplicate, true);
  const bad = await upload(chat, 'x.txt', 'a'.repeat(64));
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'HASH_MISMATCH');
  assert.equal((await upload(Buffer.from('MZ\x90\x00'), 'virus.exe')).status, 415);

  // Hash mismatch stored nothing
  const list = await j('GET', `/cases/${id}/evidence`, { token: alice });
  assert.equal(list.body.evidence.length, 2);

  // Decrypts back to the original; mallory can't read it
  const eid = u1.body.evidence.id;
  const dl = await fetch(`${url}/evidence/${eid}/file`, { headers: { Authorization: `Bearer ${alice}` } });
  assert.ok(Buffer.from(await dl.arrayBuffer()).equals(chat));
  assert.equal((await j('GET', `/evidence/${eid}/file`, { token: mallory })).status, 404);

  assert.equal((await j('POST', `/evidence/${eid}/verify`, { token: alice })).body.ok, true);

  // Audit chain is valid and covers every action
  let a = await j('GET', `/cases/${id}/audit`, { token: alice });
  assert.equal(a.body.chain.ok, true);
  assert.ok(a.body.entries.some((e) => e.action === 'EVIDENCE_UPLOADED'));

  // Tamper with a stored chunk -> verify fails
  const { Evidence } = await import('./models/index.js');
  const ev = await Evidence.findById(eid);
  await mongoose.connection.db.collection('evidence.chunks').updateOne({ files_id: ev.storage.fileId, n: 0 }, { $set: { data: new mongoose.mongo.Binary(Buffer.from('tampered tampered tampered!!')) } });
  const v = await j('POST', `/evidence/${eid}/verify`, { token: alice });
  assert.equal(v.body.ok, false);

  // Tamper with an audit entry -> chain breaks at that entry
  await mongoose.connection.db.collection('auditentries').updateOne({ caseId: id, seq: 2 }, { $set: { action: 'FORGED' } });
  a = await j('GET', `/cases/${id}/audit`, { token: alice });
  assert.equal(a.body.chain.ok, false);
  assert.equal(a.body.chain.brokenAtSeq, 2);
});

test('refresh rotation and reuse detection', async (t) => {
  if (skip) return t.skip(`no MongoDB replica set: ${skip}`);
  const r = await j('POST', '/auth/register', { body: { email: 'rot@example.com', name: 'R', password: 'correct-horse-battery' } });
  const cookie1 = r.cookie.split(';')[0];
  const r2 = await j('POST', '/auth/refresh', { headers: { Cookie: cookie1 } });
  assert.equal(r2.status, 200);
  const cookie2 = r2.cookie.split(';')[0];
  assert.notEqual(cookie1, cookie2);
  // Replaying the old token revokes the whole family, including the new one
  assert.equal((await j('POST', '/auth/refresh', { headers: { Cookie: cookie1 } })).status, 401);
  assert.equal((await j('POST', '/auth/refresh', { headers: { Cookie: cookie2 } })).status, 401);
});

test('login rate limit after 10 failures', async (t) => {
  if (skip) return t.skip(`no MongoDB replica set: ${skip}`);
  let last;
  for (let i = 0; i < 11; i++) last = await j('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'wrong-wrong-wrong' } });
  assert.equal(last.status, 429);
});
