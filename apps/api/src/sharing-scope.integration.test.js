// Share grants, scope, revocation and export roles against a real MongoDB replica set (skipped if none is reachable).
// The ML service is not needed: nothing here calls it (the evidence jobs are enqueued but no runner is started).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.MASTER_KEK_BASE64 ||= crypto.randomBytes(32).toString('base64');
const dbName = `tracevault_test_scope_${Date.now()}`;
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
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, body: json, buf, headers: r.headers };
};
const register = async (email) => (await call('POST', '/auth/register', { body: { email, name: email.split('@')[0], password: 'correct-horse-battery' } })).body.accessToken;

test('scoped share: visibility, revocation, expiry, download and export limits', async (t) => {
  if (skip) return t.skip(`no MongoDB replica set: ${skip}`);
  const owner = await register('owner@example.com');
  const lawyer = await register('lawyer@example.com');
  const other = await register('stranger@example.com');
  const c = (await call('POST', '/cases', { token: owner, body: { title: 'Scoped case', incidentType: 'fraud' } })).body.case;

  const up = async (text, name) => {
    const buf = Buffer.from(text);
    const fd = new FormData();
    fd.set('clientSha256', sha(buf));
    fd.set('file', new Blob([buf]), name);
    const r = await call('POST', `/cases/${c.id}/evidence`, { token: owner, body: fd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.evidence;
  };
  const e1 = await up('12/05/24, 9:41 pm - Rahul: pay 5000 or else\n', 'chat1.txt');
  const e2 = await up('13/05/24, 9:41 pm - Rahul: second private chat\n', 'chat2.txt');

  // Create a grant for e1 only; nobody but the invited address can accept.
  const g = await call('POST', `/cases/${c.id}/shares`, { token: owner, body: { email: 'lawyer@example.com', role: 'legal', scope: { type: 'evidence', evidenceIds: [e1.id] }, expiresInDays: 7, allowDownload: false } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal((await call('POST', '/share/accept', { token: other, body: { token: g.body.inviteToken } })).status, 403);
  assert.equal((await call('GET', `/cases/${c.id}/evidence`, { token: lawyer })).status, 404, 'not a member before accepting');
  assert.equal((await call('POST', '/share/accept', { token: lawyer, body: { token: g.body.inviteToken } })).status, 200);

  // The lawyer sees only e1, everywhere.
  const list = await call('GET', `/cases/${c.id}/evidence`, { token: lawyer });
  assert.deepEqual(list.body.evidence.map((e) => e.id), [e1.id]);
  assert.equal((await call('GET', `/evidence/${e1.id}`, { token: lawyer })).status, 200);
  assert.equal((await call('GET', `/evidence/${e2.id}`, { token: lawyer })).status, 404, 'out-of-scope evidence by id');
  assert.equal((await call('GET', `/evidence/${e2.id}/file`, { token: lawyer })).status, 404);
  assert.equal((await call('GET', `/evidence/${e2.id}/extracted`, { token: lawyer })).status, 404);
  const ov = await call('GET', `/cases/${c.id}/overview`, { token: lawyer });
  assert.equal(ov.body.counts.evidence, 1, 'overview counts only the shared item');

  // Viewing is allowed, downloading is not (allowDownload=false); the original streams intact.
  const view = await call('GET', `/evidence/${e1.id}/file`, { token: lawyer });
  assert.equal(view.status, 200);
  assert.equal(sha(view.buf), e1.sha256);
  assert.equal((await call('GET', `/evidence/${e1.id}/file?download=1`, { token: lawyer })).status, 403);

  // Role gates: legal may export the certificate path but not the bundle; the owner's bundle is a valid zip.
  assert.equal((await call('GET', `/cases/${c.id}/export/bundle.zip`, { token: lawyer })).status, 403);
  assert.equal((await call('GET', `/cases/${c.id}/export/bundle.zip`, { token: other })).status, 404);
  assert.equal((await call('PATCH', `/cases/${c.id}/settings`, { token: lawyer, body: { llmMode: 'local' } })).status, 403);
  const info = await call('GET', `/cases/${c.id}/export`, { token: lawyer });
  assert.equal(info.body.evidenceCount, 1);
  assert.equal(info.body.available.bundle, false);
  const bundle = await call('GET', `/cases/${c.id}/export/bundle.zip`, { token: owner });
  assert.equal(bundle.status, 200, bundle.buf.toString().slice(0, 200));
  assert.equal(bundle.buf.subarray(0, 2).toString(), 'PK');
  for (const name of ['manifest.json', 'audit.jsonl', 'checkpoint.json', 'verify.py', 'originals/E1_chat1.txt', 'originals/E2_chat2.txt']) {
    assert.ok(bundle.buf.includes(Buffer.from(name)), `bundle contains ${name}`);
  }

  // The owner sees views counted and audited.
  const grants = await call('GET', `/cases/${c.id}/shares`, { token: owner });
  assert.ok(grants.body.grants[0].viewCount >= 1);
  const audit = await call('GET', `/cases/${c.id}/audit`, { token: owner });
  assert.ok(audit.body.entries.some((e) => e.action === 'SHARED_CASE_VIEWED'));
  assert.ok(audit.body.entries.some((e) => e.action === 'BUNDLE_EXPORTED'));

  // Expiry and revocation cut access immediately, on every route, including by evidence id.
  const { ShareGrant } = await import('./models/index.js');
  await ShareGrant.updateOne({ _id: g.body.grant.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await call('GET', `/cases/${c.id}/evidence`, { token: lawyer })).status, 404);
  assert.equal((await call('GET', `/evidence/${e1.id}/file`, { token: lawyer })).status, 404, 'expired grant must not read evidence by id');
  await ShareGrant.updateOne({ _id: g.body.grant.id }, { $set: { expiresAt: new Date(Date.now() + 86_400_000) } });
  assert.equal((await call('GET', `/evidence/${e1.id}`, { token: lawyer })).status, 200);
  assert.equal((await call('DELETE', `/cases/${c.id}/shares/${g.body.grant.id}`, { token: owner })).status, 204);
  assert.equal((await call('GET', `/evidence/${e1.id}`, { token: lawyer })).status, 404, 'revoked grant');

  // A tampered audit log makes the bundle refuse to sign.
  await mongoose.connection.db.collection('auditentries').updateOne({ caseId: c.id, seq: 2 }, { $set: { action: 'FORGED' } });
  const bad = await call('GET', `/cases/${c.id}/export/bundle.zip`, { token: owner });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error.code, 'INTEGRITY_FAILED');
});
