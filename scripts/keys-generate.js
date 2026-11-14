// Writes the Ed25519 audit key and a random KEK if missing. Idempotent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const envPath = path.join(root, '.env');
const keysDir = path.join(root, 'keys');
fs.mkdirSync(keysDir, { recursive: true });

if (!fs.existsSync(envPath)) fs.copyFileSync(path.join(root, '.env.example'), envPath);
let env = fs.readFileSync(envPath, 'utf8');

const pemPath = path.join(keysDir, 'audit_ed25519.pem');
if (!fs.existsSync(pemPath)) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('generated', pemPath);
}

const setIfEmpty = (key, value) => {
  const re = new RegExp(`^${key}=(.*?)(\\s+#.*)?$`, 'm');
  const m = env.match(re);
  if (m && m[1].trim() && m[1].trim() !== 'change-me') return false;
  env = m ? env.replace(re, `${key}=${value}`) : env + `\n${key}=${value}\n`;
  console.log('set', key);
  return true;
};

const rnd = (n) => crypto.randomBytes(n).toString('base64url');
setIfEmpty('MASTER_KEK_BASE64', crypto.randomBytes(32).toString('base64'));
setIfEmpty('JWT_ACCESS_SECRET', rnd(48));
setIfEmpty('JWT_REFRESH_SECRET', rnd(48));
// ML_INTERNAL_SECRET (api) and INTERNAL_SECRET (ml) must match.
const sec = rnd(32);
if (setIfEmpty('ML_INTERNAL_SECRET', sec)) setIfEmpty('INTERNAL_SECRET', sec);
else {
  const cur = env.match(/^ML_INTERNAL_SECRET=(.*)$/m)[1].trim();
  env = env.replace(/^INTERNAL_SECRET=.*$/m, `INTERNAL_SECRET=${cur}`);
}

fs.writeFileSync(envPath, env);
console.log('.env ready');
