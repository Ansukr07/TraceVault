import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildQuery, parseResponse, readTLV, verifyToken } from './tsp.js';

// A real RFC 3161 TSA is built with the openssl CLI so the verifier is tested against genuine tokens.
let dir;
let haveOpenssl = true;
let caPem;
const sh = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });

before(() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
  } catch {
    haveOpenssl = false;
    return;
  }
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tsa-'));
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Test Root CA', '-days', '2');
  sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=Test TSA');
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'extendedKeyUsage=critical,timeStamping\n');
  sh('x509', '-req', '-in', 'tsa.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'tsa.pem', '-days', '2', '-extfile', 'ext.cnf');
  fs.copyFileSync(path.join(dir, 'ca.pem'), path.join(dir, 'chain.pem'));
  fs.writeFileSync(path.join(dir, 'serial'), '0A\n');
  fs.writeFileSync(
    path.join(dir, 'tsa.cnf'),
    ['[tsa]', 'default_tsa=t', '[t]', 'serial=./serial', 'crypto_device=builtin', 'signer_cert=./tsa.pem', 'certs=./chain.pem', 'signer_key=./tsa.key', 'signer_digest=sha256', 'default_policy=1.2.3.4.1', 'digests=sha256', 'accuracy=secs:1', 'ordering=yes', 'tsa_name=yes', 'ess_cert_id_alg=sha256', ''].join('\n'),
  );
  caPem = fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8');
});

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

function issue(hashHex) {
  const q = buildQuery(hashHex);
  fs.writeFileSync(path.join(dir, 'q.tsq'), q.der);
  sh('ts', '-reply', '-queryfile', 'q.tsq', '-config', 'tsa.cnf', '-out', 'r.tsr');
  return { resp: fs.readFileSync(path.join(dir, 'r.tsr')), nonce: q.nonce };
}

test('query is a well-formed DER TimeStampReq that openssl can read', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('evidence');
  const q = buildQuery(h);
  fs.writeFileSync(path.join(dir, 'q2.tsq'), q.der);
  const text = sh('ts', '-query', '-in', 'q2.tsq', '-text').toString();
  assert.match(text, /Hash Algorithm: sha256/i);
  const dump = text
    .split(/\r?\n/)
    .filter((l) => /^\s+[0-9a-f]{4} - /i.test(l))
    .map((l) => l.slice(11, 58).replace(/[^0-9a-f]/gi, ''))
    .join('')
    .toLowerCase();
  assert.equal(dump, h);
  assert.match(text, /Certificate required: yes/i);
});

test('buildQuery rejects a bad hash', () => {
  assert.throws(() => buildQuery('xyz'));
});

test('valid token verifies and reports time, serial and TSA name', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('original bytes');
  const { resp, nonce } = issue(h);
  const r = verifyToken(resp, h, { nonce, trustPem: caPem });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.signatureValid, true);
  assert.equal(r.trust, 'trusted');
  assert.match(r.serial, /^[0-9A-F]+$/); // openssl increments its serial file on every reply
  assert.equal(r.tsaName, 'Test TSA');
  assert.ok(Math.abs(Date.now() - r.genTime.getTime()) < 60_000);
});

test('trust is "unchecked" without a trust bundle and "untrusted" with a different root', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('x');
  const { resp } = issue(h);
  assert.equal(verifyToken(resp, h).trust, 'unchecked');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(other.privateKey.type, 'private');
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'o.key', '-out', 'o.pem', '-subj', '/CN=Other Root', '-days', '2');
  const r = verifyToken(resp, h, { trustPem: fs.readFileSync(path.join(dir, 'o.pem'), 'utf8') });
  assert.equal(r.ok, true); // the signature is still valid...
  assert.equal(r.trust, 'untrusted'); // ...but we do not trust who signed it
});

test('a different hash than the one stamped is rejected', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const { resp } = issue(hash('A'));
  const r = verifyToken(resp, hash('B'));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /does not match the record/);
});

test('nonce mismatch is rejected', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('n');
  const { resp } = issue(h);
  const r = verifyToken(resp, h, { nonce: 'deadbeefdeadbeef' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /nonce/);
});

test('flipping any byte of the signed time-stamp info is detected', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('tamper');
  const { resp } = issue(h);
  const p = parseResponse(resp);
  const at = resp.indexOf(p.tstOctets); // position of the signed TSTInfo inside the response
  assert.ok(at > 0);
  // Flip a byte inside the genTime so it still parses, then expect the CMS digest/signature check to fail.
  const copy = Buffer.from(resp);
  const timeAt = copy.indexOf(Buffer.from(p.summary.genTime.toISOString().slice(0, 4)), at);
  copy[timeAt + 3] ^= 0x01;
  const r = verifyToken(copy, h);
  assert.equal(r.ok, false);
});

test('a corrupted signature fails', (t) => {
  if (!haveOpenssl) return t.skip('openssl not available');
  const h = hash('sig');
  const { resp } = issue(h);
  const copy = Buffer.from(resp);
  // The RSA signature is the last long OCTET STRING in the file; flip a byte inside it.
  const sigAt = copy.length - 40;
  copy[sigAt] ^= 0xff;
  const r = verifyToken(copy, h);
  assert.equal(r.ok, false);
});

test('garbage and rejected responses fail cleanly', () => {
  assert.equal(verifyToken(Buffer.from('not der'), hash('a')).ok, false);
  // TimeStampResp with status 2 (rejection) and no token
  const rejected = Buffer.from('3005300302 0102'.replace(/ /g, ''), 'hex');
  assert.equal(readTLV(rejected).tag, 0x30);
  const v = verifyToken(rejected, hash('a'));
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /rejected|malformed/);
});
