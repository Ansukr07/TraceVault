// End-to-end check of F2 offline verification: real RFC 3161 tokens (openssl TSA) in a bundle that the
// shipped verify.py must accept, and reject once an original, the audit log or a token is altered.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildEntry } from './audit-chain.js';
import { VERIFY_PY, auditJsonl } from './export.js';
import { merkleRoot } from './merkle.js';
import { buildQuery } from './tsp.js';

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'pipe' });
const have = (cmd, args = ['--version']) => { try { execFileSync(cmd, args, { stdio: 'pipe' }); return true; } catch { return false; } };
const PYTHON = ['python', 'python3', 'py'].find((c) => have(c));
const READY = have('openssl', ['version']) && PYTHON;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let tsaDir;
let root;

function stamp(hashHex, name) {
  const q = buildQuery(hashHex);
  fs.writeFileSync(path.join(tsaDir, 'q.tsq'), q.der);
  run('openssl', ['ts', '-reply', '-queryfile', 'q.tsq', '-config', 'tsa.cnf', '-out', 'r.tsr'], tsaDir);
  fs.copyFileSync(path.join(tsaDir, 'r.tsr'), path.join(root, 'timestamps', name));
}

before(() => {
  if (!READY) return;
  tsaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-tsa2-'));
  const d = tsaDir;
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=Bundle Test CA', '-days', '2'], d);
  run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'tsa.key', '-out', 'tsa.csr', '-subj', '/CN=Bundle Test TSA'], d);
  fs.writeFileSync(path.join(d, 'ext.cnf'), 'extendedKeyUsage=critical,timeStamping\n');
  run('openssl', ['x509', '-req', '-in', 'tsa.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'tsa.pem', '-days', '2', '-extfile', 'ext.cnf'], d);
  fs.copyFileSync(path.join(d, 'ca.pem'), path.join(d, 'chain.pem'));
  fs.writeFileSync(path.join(d, 'serial'), '01\n');
  fs.writeFileSync(path.join(d, 'tsa.cnf'), ['[tsa]', 'default_tsa=t', '[t]', 'serial=./serial', 'crypto_device=builtin', 'signer_cert=./tsa.pem', 'certs=./chain.pem', 'signer_key=./tsa.key', 'signer_digest=sha256', 'default_policy=1.2.3.4.1', 'digests=sha256', 'accuracy=secs:1', 'ordering=yes', 'tsa_name=yes', 'ess_cert_id_alg=sha256', ''].join('\n'));
});
after(() => {
  for (const d of [tsaDir, root]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

/** Build a small but real bundle folder with two originals, an audit chain and three time-stamps. */
function makeBundle() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-bundle-'));
  fs.mkdirSync(path.join(root, 'originals'));
  fs.mkdirSync(path.join(root, 'timestamps'));
  const caseId = '65f0c0ffee0000000000abcd';
  const files = [['E1_a.txt', 'first original'], ['E2_b.txt', 'second original']].map(([n, body], i) => {
    fs.writeFileSync(path.join(root, 'originals', n), body);
    return { evidenceId: `ev${i + 1}`, idx: i + 1, path: `originals/${n}`, filename: n, sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'other' };
  });
  const chain = [];
  for (let i = 0; i < 3; i++) chain.push(buildEntry(caseId, chain.at(-1) ?? null, { actorId: 'u1', actorRole: 'owner', action: 'EVIDENCE_UPLOADED', target: `t${i}`, payload: { i } }));
  const rootHash = merkleRoot(files.map((f) => f.sha256));
  const manifest = Buffer.from(JSON.stringify({ format: 'tracevault-bundle/1', caseId, exportedAt: new Date().toISOString(), scope: 'whole-case', files, merkleRoot: rootHash, auditHead: chain.at(-1).hash, auditCount: chain.length }, null, 2));
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(root, 'audit.jsonl'), auditJsonl(chain));
  fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify({ payload: { manifestSha256: sha(manifest) }, signature: null }));
  fs.writeFileSync(path.join(root, 'verify.py'), VERIFY_PY);
  fs.copyFileSync(path.join(tsaDir, 'ca.pem'), path.join(root, 'timestamps', 'trust.pem'));

  stamp(files[0].sha256, 'evidence_1.tsr');
  stamp(chain.at(-1).hash, 'audit_head_3.tsr');
  stamp(rootHash, 'merkle_root_2.tsr');
  const index = [
    { file: 'timestamps/evidence_1.tsr', type: 'evidence', ref: 'ev1', hash: files[0].sha256 },
    { file: 'timestamps/audit_head_3.tsr', type: 'audit_head', ref: '3', hash: chain.at(-1).hash },
    { file: 'timestamps/merkle_root_2.tsr', type: 'merkle_root', ref: '2', hash: rootHash },
  ];
  fs.writeFileSync(path.join(root, 'timestamps', 'index.json'), JSON.stringify(index, null, 2));
  return { files, chain };
}

const verify = () => spawnSync(PYTHON, [path.join(root, 'verify.py'), root], { encoding: 'utf8' });

test('a pristine bundle with time-stamps verifies, including the authority signature', (t) => {
  if (!READY) return t.skip('openssl or python not available');
  makeBundle();
  const r = verify();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\[5\] Trusted timestamps/);
  assert.match(r.stdout, /evidence ev1 at \d{14}.*authority signature ok/);
  assert.match(r.stdout, /VERIFIED: nothing was altered/);
});

test('altering an original after it was time-stamped fails verification', (t) => {
  if (!READY) return t.skip('openssl or python not available');
  makeBundle();
  fs.writeFileSync(path.join(root, 'originals', 'E1_a.txt'), 'first original, edited');
  const r = verify();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /hash mismatch originals\/E1_a\.txt/);
});

test('a token issued for a different hash is rejected', (t) => {
  if (!READY) return t.skip('openssl or python not available');
  makeBundle();
  stamp(sha('something else entirely'), 'evidence_1.tsr'); // valid token, wrong subject
  const r = verify();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /token was issued for a different hash/);
});

test('a corrupted token signature is caught when openssl is available', (t) => {
  if (!READY) return t.skip('openssl or python not available');
  makeBundle();
  const f = path.join(root, 'timestamps', 'audit_head_3.tsr');
  const b = fs.readFileSync(f);
  b[b.length - 40] ^= 0xff;
  fs.writeFileSync(f, b);
  const r = verify();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /FAIL audit_head 3/);
});

test('a bundle with no timestamps directory still verifies', (t) => {
  if (!READY) return t.skip('openssl or python not available');
  makeBundle();
  fs.rmSync(path.join(root, 'timestamps'), { recursive: true });
  const r = verify();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /none in this bundle/);
});
