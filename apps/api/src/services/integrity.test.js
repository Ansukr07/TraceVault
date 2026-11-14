import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildEntry, verifyChain } from './audit-chain.js';
import { merkleRoot, merkleProof, verifyProof } from './merkle.js';

const mk = (n) => {
  const chain = [];
  for (let i = 0; i < n; i++) {
    chain.push(buildEntry('c1', chain.at(-1) ?? null, { actorId: 'u1', actorRole: 'owner', action: 'X', target: `t${i}`, payload: { i } }));
  }
  return chain;
};

test('valid chain verifies', () => {
  const r = verifyChain('c1', mk(5));
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
});

test('tampering one entry is detected at that entry', () => {
  const chain = mk(6);
  chain[3] = { ...chain[3], target: 'evil' };
  const r = verifyChain('c1', chain);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAtSeq, 4);
});

test('deleting an entry is detected', () => {
  const chain = mk(5);
  chain.splice(2, 1);
  assert.equal(verifyChain('c1', chain).ok, false);
});

test('merkle proofs verify for every leaf, and fail for wrong root', () => {
  const hashes = Array.from({ length: 7 }, (_, i) => crypto.createHash('sha256').update(String(i)).digest('hex'));
  const root = merkleRoot(hashes);
  for (const hsh of hashes) assert.ok(verifyProof(hsh, merkleProof(hashes, hsh), root));
  assert.equal(verifyProof(hashes[0], merkleProof(hashes, hashes[0]), merkleRoot(hashes.slice(1))), false);
  assert.equal(merkleRoot([...hashes].reverse()), root);
});
