import crypto from 'node:crypto';

/** Envelope encryption: a random per-file data key (DEK) wrapped by the master KEK. All AES-256-GCM. */

export function wrapKey(dek, kek) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return { wrapped: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function unwrapKey({ wrapped, iv, tag }, kek) {
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(wrapped, 'base64')), d.final()]);
}

/** Returns a Transform that encrypts, plus `meta()` to call after the stream ends. */
export function createEncryptor(kek) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  return {
    stream: cipher,
    meta: () => ({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), key: wrapKey(dek, kek) }),
  };
}

export function createDecryptor(enc, kek) {
  const dek = unwrapKey(enc.key, kek);
  const d = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(enc.iv, 'base64'));
  d.setAuthTag(Buffer.from(enc.tag, 'base64'));
  return d;
}

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
