// HTTP client for the internal ML service (127.0.0.1 only, X-Internal-Secret). The ML service never touches the DB:
// Node streams decrypted bytes in and persists whatever comes back.
import { config } from '../config.js';

const headers = () => ({ 'X-Internal-Secret': config.ML_INTERNAL_SECRET });

async function handle(r, path) {
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!r.ok) {
    const err = new Error(`ML ${path} failed: ${r.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? body?.raw ?? ''}`.trim());
    err.status = r.status;
    err.code = body?.error?.code;
    // 4xx from the ML service means the input is bad: retrying won't help.
    err.permanent = r.status >= 400 && r.status < 500;
    throw err;
  }
  return body;
}

export async function mlJson(path, payload, { timeoutMs = 600_000 } = {}) {
  const r = await fetch(`${config.ML_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return handle(r, path);
}

export async function mlMultipart(path, { file, filename, fields = {} }, { timeoutMs = 900_000 } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) fd.set(k, String(v));
  fd.set('file', new Blob([file]), filename || 'file');
  const r = await fetch(`${config.ML_BASE_URL}${path}`, { method: 'POST', headers: headers(), body: fd, signal: AbortSignal.timeout(timeoutMs) });
  return handle(r, path);
}

/** Binary response (TTS). Returns { buffer, headers }. */
export async function mlBinary(path, payload, { timeoutMs = 300_000 } = {}) {
  const r = await fetch(`${config.ML_BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) await handle(r, path);
  return { buffer: Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
