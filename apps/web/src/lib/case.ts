import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from './api';

export type CaseSettings = { llmMode: 'cloud' | 'cloud_redacted' | 'local'; voiceMode: 'sarvam' | 'local'; voiceConsentAt?: string; translateMode: 'sarvam' | 'sarvam_redacted' | 'off'; ocrMode?: 'local' | 'cloud' | 'sarvam'; system1Mode?: 'local' | 'hosted' };
export type CaseT = { id: string; title: string; incidentType: string; description: string; status: string; timezone: string; settings: CaseSettings; role: string; createdAt: string; sealedAt?: string | null; sealedRoot?: string | null; addendumOf?: string | null };
export type Entity = { type: string; text: string; start: number; end: number; norm: unknown; precision?: string; direction?: string };
export type Chunk = {
  cid: string; idx: number; unit: string; text: string; textEn?: string | null; lang?: string; langConfidence?: number; translation?: { provider: string; model: string; redacted: boolean };
  sender?: string; speaker?: string; refTs?: string; locator: { bbox?: number[]; page?: number; startMs?: number; endMs?: number; messageIdx?: number; lineNo?: number; side?: string };
  conf?: number; lowConfidence?: boolean; timeOfDay?: string; media?: string; failed?: boolean; entities?: Entity[]; severity?: { score: number; labels: string[] }; sourceType?: string;
};
export type Evidence = {
  id: string; idx: number; filename: string; kind: string; mime: string; size: number; sha256: string; sourceLabel: string; parentEvidenceId: string | null; duplicateOf: string | null;
  status: string; error: string | null; metadata: Record<string, any>; flags: { type: string; field?: string; value?: string }[]; durationMs: number | null; detectedLang: string | null;
  provider: string | null; createdAt: string; chunkCount?: number; maxSeverity?: number;
};
export type TEvent = {
  key: string; ts: string | null; tsEnd?: string; tsPrecision: string; title: string; description: string; descriptionEn?: string | null; category: string; severity: number; labels: string[];
  actors: string[]; targets: string[]; location?: string; amount?: number; identifiers: string[]; citations: string[]; evidenceIds: string[]; sourceType: string; lane: string;
  confidence: number; corroborationCount: number; audio?: { evidenceId: string; startMs: number; endMs: number } | null; userEdited?: boolean;
};
export type ChunkPreview = { id: string; evidenceId: string; text: string; textEn?: string; lang?: string; sender?: string; refTs?: string; unit: string; locator: Chunk['locator']; translation?: Chunk['translation']; sourceType?: string; evidence: { kind: string; label: string } | null };

export const useCase = (id?: string) => useQuery({ queryKey: ['case', id], queryFn: () => api<{ case: CaseT }>(`/cases/${id}`).then((r) => r.case), enabled: !!id });
export const useEvidence = (id?: string) =>
  useQuery({ queryKey: ['evidence', id], queryFn: () => api<{ evidence: Evidence[] }>(`/cases/${id}/evidence`).then((r) => r.evidence), enabled: !!id });

type JobRow = { type: string; evidenceId: string | null; status: string; progress: number; error: string | null };
const isActive = (j: JobRow) => j.status === 'queued' || j.status === 'running';

/**
 * Processing progress for one case. Polls /jobs (3s while work is pending, 15s otherwise) instead of holding a socket,
 * because the API runs as serverless functions. The poll also wakes the background worker on the server.
 * Invalidates case queries when jobs progress or finish.
 */
export function useCaseProgress(caseId?: string) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['jobs', caseId],
    queryFn: () => api<{ jobs: JobRow[] }>(`/cases/${caseId}/jobs`).then((r) => r.jobs),
    enabled: !!caseId,
    refetchInterval: (query) => (query.state.data?.some(isActive) ? 3000 : 15000),
    refetchIntervalInBackground: false,
  });
  const prev = useRef<JobRow[] | null>(null);
  useEffect(() => {
    const jobs = q.data;
    if (!jobs || !caseId) return;
    const before = prev.current;
    prev.current = jobs;
    if (!before) return;
    const sig = (js: JobRow[]) => js.map((j) => `${j.type}:${j.evidenceId}:${j.status}`).sort().join('|');
    if (sig(before) === sig(jobs)) return;
    const keys = ['evidence', 'overview'];
    // Something finished (or failed): the derived views have new data.
    if (before.filter(isActive).length > jobs.filter(isActive).length || !jobs.some(isActive)) {
      keys.push('timeline', 'graph', 'inconsistencies', 'entities', 'insights', 'case', 'duplicates', 'summary', 'statements');
    }
    keys.forEach((k) => qc.invalidateQueries({ queryKey: [k, caseId] }));
  }, [q.data, caseId, qc]);
  return q.data ?? [];
}

/** Batch-loads citation previews (one request per render batch, cached per id). */
const pending = new Map<string, { ids: Set<string>; timer: number; resolvers: ((m: Record<string, ChunkPreview>) => void)[] }>();
function loadChunks(caseId: string, id: string): Promise<ChunkPreview | null> {
  return new Promise((resolve) => {
    let p = pending.get(caseId);
    if (!p) {
      p = { ids: new Set(), resolvers: [], timer: 0 };
      pending.set(caseId, p);
      p.timer = window.setTimeout(async () => {
        pending.delete(caseId);
        const ids = [...p!.ids];
        const map: Record<string, ChunkPreview> = {};
        for (let i = 0; i < ids.length; i += 150) {
          const r = await api<{ chunks: ChunkPreview[] }>(`/cases/${caseId}/chunks?ids=${encodeURIComponent(ids.slice(i, i + 150).join(','))}`).catch(() => ({ chunks: [] }));
          r.chunks.forEach((c) => (map[c.id] = c));
        }
        p!.resolvers.forEach((r) => r(map));
      }, 30);
    }
    p.ids.add(id);
    p.resolvers.push((m) => resolve(m[id] ?? null));
  });
}
export const useChunk = (caseId: string, id: string, enabled = true) =>
  useQuery({ queryKey: ['chunk', caseId, id], queryFn: () => loadChunks(caseId, id), enabled: enabled && /^E\d+:\d+$/.test(id), staleTime: 5 * 60_000 });

/** Authenticated blob URL for an evidence original (uploads are never served from a static path). */
export function useEvidenceBlob(evidenceId?: string, enabled = true) {
  const q = useQuery({
    queryKey: ['blob', evidenceId],
    queryFn: async () => {
      const r = await fetch(`/api/v1/evidence/${evidenceId}/file`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error(`Could not load original (${r.status})`);
      return URL.createObjectURL(await r.blob());
    },
    enabled: !!evidenceId && enabled,
    staleTime: Infinity,
    gcTime: 60_000,
  });
  useEffect(() => () => { if (q.data) URL.revokeObjectURL(q.data); }, [q.data]);
  return q;
}

export const fmtDate = (ts?: string | null, precision = 'exact') => {
  if (!ts) return 'Unknown date';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  if (precision !== 'exact' || (d.getHours() === 0 && d.getMinutes() === 0)) return precision === 'approx' ? `≈ ${date}` : date;
  return `${date}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
};
export const fmtMoney = (v?: number | null) => (v == null ? '' : `₹${v.toLocaleString('en-IN')}`);
export const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
export const fmtMs = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

export const SEVERITY = ['benign', 'concerning', 'harmful', 'severe'] as const;
export const LANG_NAME: Record<string, string> = {
  'en-IN': 'English', 'hi-IN': 'Hindi', 'hi-Latn': 'Hinglish', 'kn-IN': 'Kannada', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi',
  'bn-IN': 'Bengali', 'gu-IN': 'Gujarati', 'pa-IN': 'Punjabi', 'od-IN': 'Odia',
};
export const langName = (l?: string | null) => (l ? LANG_NAME[l] ?? l : 'Unknown');

export function useEntityNames(caseId?: string) {
  const q = useQuery({ queryKey: ['entities', caseId], queryFn: () => api<{ entities: { key: string; name: string; type: string; isOwner?: boolean }[]; candidates: any[]; decisions: any[] }>(`/cases/${caseId}/entities`), enabled: !!caseId });
  return useMemo(() => {
    const m = new Map<string, string>();
    q.data?.entities.forEach((e) => m.set(e.key, e.name));
    return { names: m, query: q };
  }, [q]);
}
