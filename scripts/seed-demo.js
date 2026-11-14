// Loads the demo case (spec O5) through the real API, exactly as a user would:
// register/login → create case → hash + upload every demo file → wait for processing → print the result.
//
//   npm run seed:demo                      (API on http://localhost:4000)
//   API_URL=http://127.0.0.1:4100 npm run seed:demo
//
// Demo login (local test account, change via env): DEMO_EMAIL / DEMO_PASSWORD below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const API = (process.env.API_URL ?? 'http://localhost:4000') + '/api/v1';
const EMAIL = process.env.DEMO_EMAIL ?? 'priya.demo@tracevault.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'tracevault-demo-password';
const DATA = path.join(root, 'eval', 'data', 'priya_case');
const FILES = [
  ['WhatsApp Chat with Rahul K.txt', 'WhatsApp – Rahul chat'],
  ['screenshot_rahul_demand.png', 'Screenshot of demand'],
  ['sbi_statement_may2024.pdf', 'SBI statement May 2024'],
  ['email_from_rk.eml', 'Email from rk.alt'],
];

async function call(method, p, { token, body } = {}) {
  const r = await fetch(API + p, {
    method,
    headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 300)}`);
  return { status: r.status, body: json };
}

if (!fs.existsSync(path.join(DATA, 'ground_truth.json'))) {
  const py = path.join(root, 'services', 'ml', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  console.log('generating demo dataset…');
  spawnSync(py, [path.join(root, 'eval', 'generate_case.py')], { stdio: 'inherit' });
}
const voiceNotes = fs.readdirSync(DATA).filter((f) => /\.(opus|wav|ogg|m4a|mp3)$/i.test(f)).map((f) => [f, `Voice note ${f.slice(4, 12)}`]);

let reg = await call('POST', '/auth/register', { body: { email: EMAIL, name: 'Priya', password: PASSWORD } });
if (reg.status === 409) reg = await call('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
const token = reg.body.accessToken;

const c = (await call('POST', '/cases', { token, body: { title: `Priya v. Rahul K (demo ${new Date().toISOString().slice(0, 16)})`, incidentType: 'sextortion', description: 'Synthetic demo case: sextortion and UPI fraud across WhatsApp, a screenshot, a bank statement and email.', voiceConsent: voiceNotes.length > 0 } })).body.case;
console.log('case', c.id);

for (const [name, label] of [...FILES, ...voiceNotes]) {
  const buf = fs.readFileSync(path.join(DATA, name));
  const fd = new FormData();
  fd.set('clientSha256', crypto.createHash('sha256').update(buf).digest('hex'));
  fd.set('sourceLabel', label);
  fd.set('file', new Blob([buf]), name);
  const r = await call('POST', `/cases/${c.id}/evidence`, { token, body: fd });
  console.log(`  uploaded ${name}  sha256=${r.body.evidence.sha256.slice(0, 16)}…`);
}

const t0 = Date.now();
let ov;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  ov = (await call('GET', `/cases/${c.id}/overview`, { token })).body;
  process.stdout.write(`\r  processing… ${ov.counts.processed}/${ov.counts.evidence} files, status=${ov.status}   `);
  if (ov.status === 'ready' && ov.summaryVersion) break;
  if (Date.now() - t0 > 6 * 60_000) throw new Error('timed out waiting for processing');
}
console.log(`\n  ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const [tl, inc, sum, ver] = await Promise.all([
  call('GET', `/cases/${c.id}/timeline`, { token }),
  call('GET', `/cases/${c.id}/inconsistencies`, { token }),
  call('GET', `/cases/${c.id}/summary`, { token }),
  call('POST', `/cases/${c.id}/verify`, { token }),
]);
console.log(`\ncounts: ${JSON.stringify(ov.counts)}`);
console.log(`events: ${tl.body.events.length}; inconsistencies: ${inc.body.items.map((i) => i.type).join(', ')}`);
console.log(`integrity: ${ver.body.ok ? 'OK' : 'BROKEN'}  merkleRoot=${ver.body.merkleRoot.slice(0, 16)}…`);
console.log('\nsummary:');
for (const s of sum.body.summary.sections) {
  if (!s.sentences.length) continue;
  console.log(`  ## ${s.title}`);
  for (const x of s.sentences.slice(0, 4)) console.log(`   - ${x.text} ${x.citations.map((cc) => `[${cc}]`).join('')}${x.supported === false ? ' ⚠' : ''}`);
}
console.log(`\nOpen http://localhost:5173/cases/${c.id}  (login: ${EMAIL}; password in DEMO_PASSWORD or scripts/seed-demo.js)`);
