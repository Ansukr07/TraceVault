import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDecryptor, createEncryptor } from './crypto.js';
import { detectEvidence } from './detect.js';

const kek = crypto.randomBytes(32);

async function roundTrip(plain, tamper) {
  const enc = createEncryptor(kek);
  const chunks = [];
  await pipeline(Readable.from([plain]), enc.stream, async function* (src) { for await (const c of src) chunks.push(c); });
  const ct = Buffer.concat(chunks);
  if (tamper) ct[0] ^= 1;
  const dec = createDecryptor(enc.meta(), kek);
  const out = [];
  await pipeline(Readable.from([ct]), dec, async function* (src) { for await (const c of src) out.push(c); });
  return Buffer.concat(out);
}

test('envelope encryption round-trips', async () => {
  const plain = crypto.randomBytes(100_000);
  assert.ok((await roundTrip(plain)).equals(plain));
});

test('tampered ciphertext fails authentication', async () => {
  await assert.rejects(roundTrip(Buffer.from('evidence bytes'), true));
});

test('wrong KEK cannot unwrap', async () => {
  const enc = createEncryptor(kek);
  enc.stream.end('x');
  assert.throws(() => createDecryptor(enc.meta(), crypto.randomBytes(32)));
});

test('type detection uses magic bytes, not extension', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tv-'));
  const w = async (name, buf) => { const p = path.join(dir, name); await fs.writeFile(p, buf); return p; };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  try {
    assert.equal((await detectEvidence(await w('a.png', png), 'a.png')).kind, 'image');
    assert.equal(await detectEvidence(await w('evil.png', Buffer.from('MZ\x90\x00\x03')), 'evil.png'), null);
    assert.equal((await detectEvidence(await w('chat.txt', '12/05/24, 9:41 pm - Rahul: hi'), 'chat.txt')).kind, 'chat_export');
    assert.equal(await detectEvidence(await w('bin.txt', Buffer.from([1, 2, 0, 3])), 'bin.txt'), null);
    assert.equal((await detectEvidence(await w('m.eml', 'From: a@b.c\r\n\r\nhi'), 'm.eml')).kind, 'email');
    assert.equal(await detectEvidence(await w('x.exe', 'hello'), 'x.exe'), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
