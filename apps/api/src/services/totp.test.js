import test from 'node:test';
import assert from 'node:assert/strict';
import { base32, hotp, unbase32, verifyTotp } from './totp.js';

// RFC 4226 appendix D test vectors, secret "12345678901234567890".
const secret = base32(Buffer.from('12345678901234567890'));

test('HOTP matches RFC 4226 vectors', () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => hotp(secret, i)), ['755224', '287082', '359152', '969429']);
});
test('base32 round-trips', () => assert.equal(unbase32(secret).toString(), '12345678901234567890'));
test('TOTP accepts ±1 step and rejects others', () => {
  const t = 59_000; // RFC 6238: T=59 -> counter 1
  const code = hotp(secret, 1);
  assert.equal(verifyTotp(secret, code, t), 1);
  assert.equal(verifyTotp(secret, code, t + 30_000), 1, 'one step late still ok');
  assert.equal(verifyTotp(secret, code, t + 90_000), null);
  assert.equal(verifyTotp(secret, 'abcdef', t), null);
});
