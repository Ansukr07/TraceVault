// F2 service layer against a real MongoDB and a real RFC 3161 TSA (openssl behind a local HTTP server).
// Skipped when MongoDB or openssl is unavailable. Uses a throwaway database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import mongoose from 'mongoose';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const oid = () => new mongoose.Types.ObjectId();
let skip = false;
let dir;
let server;
let tsaUrl;
let tsaMode = 'ok'; // 'ok' | 'down'
let M; // dynamic imports, after env is set
const base = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const sh = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });

before(async () => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
  } catch {
    skip = 'openssl not available';
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tsa3-'));
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Svc Test CA', '-days', '2');
  sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=Svc Test TSA');
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'extendedKeyUsage=critical,timeStamping\n');
  sh('x509', '-req', '-in', 'tsa.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'tsa.pem', '-days', '2', '-extfile', 'ext.cnf');
  fs.copyFileSync(path.join(dir, 'ca.pem'), path.join(dir, 'chain.pem'));
  fs.writeFileSync(path.join(dir, 'serial'), '01\n');
  fs.writeFileSync(path.join(dir, 'tsa.cnf'), ['[tsa]', 'default_tsa=t', '[t]', 'serial=./serial', 'crypto_device=builtin', 'signer_cert=./tsa.pem', 'certs=./chain.pem', 'signer_key=./tsa.key', 'signer_digest=sha256', 'default_policy=1.2.3.4.1', 'digests=sha256', 'accuracy=secs:1', 'ordering=yes', 'tsa_name=yes', 'ess_cert_id_alg=sha256', ''].join('\n'));

  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (tsaMode === 'down') { res.writeHead(503).end(); return; }
      fs.writeFileSync(path.join(dir, 'q.tsq'), Buffer.concat(chunks));
      sh('ts', '-reply', '-queryfile', 'q.tsq', '-config', 'tsa.cnf', '-out', 'r.tsr');
      res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }).end(fs.readFileSync(path.join(dir, 'r.tsr')));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  tsaUrl = `http://127.0.0.1:${server.address().port}/tsr`;

  process.env.TSA_PRIMARY_URL = tsaUrl;
  process.env.TSA_TRUST_PEM_PATH = path.join(dir, 'ca.pem');
  process.env.TIMESTAMP_ANCHOR_EVERY_N = '3';
  try {
    await mongoose.connect(base, { dbName: `tracevault_ts_${Date.now()}`, serverSelectionTimeoutMS: 2500 });
  } catch (e) {
    skip = e.message;
    return;
  }
  M = {
    ts: await import('./timestamps.js'),
    models: await import('../models/index.js'),
    audit: await import('./audit.js'),
    chain: await import('./audit-chain.js'),
    cfg: (await import('../config.js')).config,
  };
  await M.models.Timestamp.init();
  await M.models.AuditEntry.init();
});

after(async () => {
  if (M) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const fakeJob = (doc, attempts = 1, maxAttempts = 8) => ({ payload: { timestampId: String(doc._id) }, attempts, maxAttempts });
const mkEvidence = (caseId, name) => M.models.Evidence.create({ caseId, uploadedBy: oid(), filename: name, kind: 'other', mime: 'text/plain', size: 3, sha256: sha(name), familyId: name });

test('issues a token, records time/authority/trust, and audits it without breaking the chain', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  const doc = await M.ts.ensureTimestamp(caseId, { type: 'evidence', ref: String(oid()), hash: sha('a') });
  assert.equal(doc.status, 'pending');
  await M.ts.timestampHandlers.timestamp_issue(fakeJob(doc));
  const done = await M.models.Timestamp.findById(doc._id);
  assert.equal(done.status, 'issued');
  assert.equal(done.trust, 'trusted');
  assert.equal(done.tsa.name, 'Svc Test TSA');
  assert.ok(done.token.length > 500);
  assert.ok(Math.abs(Date.now() - done.genTime.getTime()) < 60_000);
  const entries = await M.models.AuditEntry.find({ caseId: String(caseId) }).sort({ seq: 1 }).lean();
  assert.deepEqual(entries.map((e) => e.action), ['TIMESTAMP_ISSUED']);
  assert.equal(M.chain.verifyChain(String(caseId), entries).ok, true);
});

test('ensureTimestamp is idempotent per case + type + hash', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  const s = { type: 'evidence', ref: String(oid()), hash: sha('same') };
  const a = await M.ts.ensureTimestamp(caseId, s);
  const b = await M.ts.ensureTimestamp(caseId, s);
  assert.equal(String(a._id), String(b._id));
  assert.equal(await M.models.Timestamp.countDocuments({ caseId }), 1);
});

test('an unreachable TSA leaves the stamp pending, then it succeeds on retry', async (t) => {
  if (skip) return t.skip(skip);
  const doc = await M.ts.ensureTimestamp(oid(), { type: 'evidence', ref: String(oid()), hash: sha('retry') });
  tsaMode = 'down';
  await assert.rejects(M.ts.timestampHandlers.timestamp_issue(fakeJob(doc, 1)));
  let cur = await M.models.Timestamp.findById(doc._id);
  assert.equal(cur.status, 'pending');
  assert.equal(cur.attempts, 1);
  assert.match(cur.lastError, /HTTP 503/);
  tsaMode = 'ok';
  await M.ts.timestampHandlers.timestamp_issue(fakeJob(doc, 2));
  cur = await M.models.Timestamp.findById(doc._id);
  assert.equal(cur.status, 'issued');
  assert.equal(cur.lastError, null);
});

test('retries exhausted marks the stamp failed and audits TIMESTAMP_FAILED', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  const doc = await M.ts.ensureTimestamp(caseId, { type: 'evidence', ref: String(oid()), hash: sha('doomed') });
  tsaMode = 'down';
  await assert.rejects(M.ts.timestampHandlers.timestamp_issue(fakeJob(doc, 8, 8)));
  tsaMode = 'ok';
  assert.equal((await M.models.Timestamp.findById(doc._id)).status, 'failed');
  assert.ok(await M.models.AuditEntry.exists({ caseId: String(caseId), action: 'TIMESTAMP_FAILED' }));
});

test('falls back to the second authority when the first is down', async (t) => {
  if (skip) return t.skip(skip);
  const keep = M.cfg.TSA_PRIMARY_URL;
  M.cfg.TSA_PRIMARY_URL = 'http://127.0.0.1:1/dead';
  M.cfg.TSA_FALLBACK_URL = tsaUrl;
  try {
    const doc = await M.ts.ensureTimestamp(oid(), { type: 'evidence', ref: String(oid()), hash: sha('fallback') });
    await M.ts.timestampHandlers.timestamp_issue(fakeJob(doc));
    const cur = await M.models.Timestamp.findById(doc._id);
    assert.equal(cur.status, 'issued');
    assert.equal(cur.tsa.url, tsaUrl);
  } finally {
    M.cfg.TSA_PRIMARY_URL = keep;
    M.cfg.TSA_FALLBACK_URL = '';
  }
});

test('anchorCase stamps the audit head and Merkle root; verification then detects tampering', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  const [e1, e2] = [await mkEvidence(caseId, 'one'), await mkEvidence(caseId, 'two')];
  await M.audit.audit(caseId, { actorRole: 'owner', action: 'EVIDENCE_UPLOADED', target: String(e1._id) });
  const out = await M.ts.anchorCase(caseId);
  assert.deepEqual(out.created.map((d) => d.subject.type).sort(), ['audit_head', 'merkle_root']);
  for (const d of out.created) await M.ts.timestampHandlers.timestamp_issue(fakeJob(d));

  const evDoc = await M.ts.ensureTimestamp(caseId, { type: 'evidence', ref: String(e2._id), hash: e2.sha256 });
  await M.ts.timestampHandlers.timestamp_issue(fakeJob(evDoc));

  for (const d of await M.models.Timestamp.find({ caseId })) {
    const r = await M.ts.verifyTimestampDoc(d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.trust, 'trusted');
  }
  // Evidence bytes "change" after stamping: the check must fail and say why.
  await M.models.Evidence.updateOne({ _id: e2._id }, { $set: { sha256: sha('tampered') } });
  const bad = await M.ts.verifyTimestampDoc(await M.models.Timestamp.findById(evDoc._id));
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /no longer matches/);
  // ...and the audit head entry being rewritten is caught too.
  const head = await M.models.Timestamp.findOne({ caseId, 'subject.type': 'audit_head' });
  await M.models.AuditEntry.updateOne({ caseId: String(caseId), seq: Number(head.subject.ref) }, { $set: { hash: sha('forged') } });
  const bad2 = await M.ts.verifyTimestampDoc(await M.models.Timestamp.findById(head._id));
  assert.equal(bad2.ok, false);
  assert.match(bad2.errors.join(' '), /no longer matches the time-stamped head/);
});

test('maybeAnchor waits for N audit entries since the last anchor', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  await mkEvidence(caseId, 'x');
  await M.audit.audit(caseId, { actorRole: 'owner', action: 'A' });
  await M.audit.audit(caseId, { actorRole: 'owner', action: 'B' });
  await M.ts.maybeAnchor(caseId); // 2 entries < N=3
  assert.equal(await M.models.Timestamp.countDocuments({ caseId }), 0);
  await M.audit.audit(caseId, { actorRole: 'owner', action: 'C' });
  await M.ts.maybeAnchor(caseId); // 3 entries >= N
  assert.equal(await M.models.Timestamp.countDocuments({ caseId, 'subject.type': 'audit_head' }), 1);
});

test('with no authority configured nothing is created and nothing is sent', async (t) => {
  if (skip) return t.skip(skip);
  const keep = M.cfg.TSA_PRIMARY_URL;
  M.cfg.TSA_PRIMARY_URL = '';
  try {
    assert.equal(M.ts.timestampsEnabled(), false);
    const caseId = oid();
    assert.equal(await M.ts.ensureTimestamp(caseId, { type: 'evidence', ref: 'r', hash: sha('off') }), null);
    assert.equal((await M.ts.anchorCase(caseId)).enabled, false);
    assert.equal(await M.models.Timestamp.countDocuments({ caseId }), 0);
  } finally {
    M.cfg.TSA_PRIMARY_URL = keep;
  }
});
