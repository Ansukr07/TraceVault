// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) on node:crypto: no extra dependency. Secrets are stored AES-256-GCM
// encrypted under the master KEK; recovery codes are stored only as SHA-256 hashes.
import crypto from 'node:crypto';
import { getKek } from '../config.js';
import { sha256Hex } from './crypto.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

export function unbase32(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error('bad base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export const newSecret = () => base32(crypto.randomBytes(20));

export function hotp(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[19] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** Returns the matched time-step (for replay protection) or null. Accepts ±1 step of clock drift. */
export function verifyTotp(secretB32, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const step = Math.floor(now / 30_000);
  for (const d of [0, -1, 1]) {
    const a = Buffer.from(hotp(secretB32, step + d));
    if (crypto.timingSafeEqual(a, Buffer.from(code))) return step + d;
  }
  return null;
}

export const otpauthUri = (secret, email) =>
  `otpauth://totp/TraceVault:${encodeURIComponent(email)}?secret=${secret}&issuer=TraceVault&algorithm=SHA1&digits=6&period=30`;

export function sealSecret(secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKek(), iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function openSecret({ ct, iv, tag }) {
  const d = crypto.createDecipheriv('aes-256-gcm', getKek(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex'));
export const hashRecovery = (c) => sha256Hex(String(c).trim().toLowerCase());
