import crypto from 'node:crypto';

const h = (buf) => crypto.createHash('sha256').update(buf).digest();
const node = (l, r) => h(Buffer.concat([Buffer.from([1]), l, r])); // 0x01 prefix: internal node
const leaf = (hex) => h(Buffer.concat([Buffer.from([0]), Buffer.from(hex, 'hex')])); // 0x00 prefix: leaf

function levels(hashes) {
  let level = [...hashes].sort().map(leaf);
  const all = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(node(level[i], level[i + 1] ?? level[i]));
    level = next;
    all.push(level);
  }
  return all;
}

/** Merkle root (hex) over evidence SHA-256 hashes (order-independent). */
export function merkleRoot(hashes) {
  if (!hashes.length) return h('').toString('hex');
  const all = levels(hashes);
  return all.at(-1)[0].toString('hex');
}

/** Proof that `hash` belongs to the set: array of {side, hash}. */
export function merkleProof(hashes, hash) {
  const sorted = [...hashes].sort();
  let idx = sorted.indexOf(hash);
  if (idx < 0) return null;
  const proof = [];
  for (const level of levels(hashes).slice(0, -1)) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push({ side: idx % 2 === 0 ? 'right' : 'left', hash: (level[sib] ?? level[idx]).toString('hex') });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(hash, proof, root) {
  let cur = leaf(hash);
  for (const p of proof) {
    const sib = Buffer.from(p.hash, 'hex');
    cur = p.side === 'right' ? node(cur, sib) : node(sib, cur);
  }
  return cur.toString('hex') === root;
}
