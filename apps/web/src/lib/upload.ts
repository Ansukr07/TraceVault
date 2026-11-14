import { api } from './api';

// Serverless request bodies are capped at ~4.5 MB, so anything bigger goes up as numbered chunks (server: routes/evidence.js).
const SINGLE_MAX = 4_000_000;

export type UploadResult = { duplicate: boolean; duplicateOf: string | null; evidence: any };

export async function uploadEvidence(
  caseId: string,
  file: File,
  sha256: string,
  opts: { sourceLabel?: string; kind?: 'statement'; onProgress?: (fraction: number) => void } = {},
): Promise<UploadResult> {
  const { sourceLabel = '', kind, onProgress } = opts;
  if (file.size <= SINGLE_MAX) {
    const fd = new FormData();
    fd.set('clientSha256', sha256);
    if (kind) fd.set('kind', kind);
    if (sourceLabel) fd.set('sourceLabel', sourceLabel);
    fd.set('file', file);
    return api<UploadResult>(`/cases/${caseId}/evidence`, { method: 'POST', body: fd });
  }
  const base = `/cases/${caseId}/evidence/uploads`;
  const { uploadId, chunkSize, total } = await api<{ uploadId: string; chunkSize: number; total: number }>(base, {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size: file.size, clientSha256: sha256, sourceLabel, ...(kind ? { kind } : {}) }),
  });
  for (let n = 0; n < total; n++) {
    const part = file.slice(n * chunkSize, (n + 1) * chunkSize);
    // Retry a flaky chunk a couple of times; chunk PUTs are idempotent.
    for (let attempt = 0; ; attempt++) {
      try {
        await api(`${base}/${uploadId}/chunks/${n}`, { method: 'PUT', body: part, headers: { 'Content-Type': 'application/octet-stream' } });
        break;
      } catch (e) {
        if (attempt >= 2) throw e;
      }
    }
    onProgress?.((n + 1) / total);
  }
  return api<UploadResult>(`${base}/${uploadId}/complete`, { method: 'POST', signal: AbortSignal.timeout(300_000) });
}
