import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useEvidence } from '../lib/case';
import { hashFile } from '../lib/hashFile';
import { uploadEvidence } from '../lib/upload';
import { DotGrid, DotText } from '../ui';
import { CaseShell } from '../components';

type Row = { key: string; name: string; sha?: string; state: 'hashing' | 'uploading' | 'done' | 'duplicate' | 'error'; pct: number; msg?: string };

const LABEL: Record<Row['state'], [string, string]> = {
  hashing: ['Fingerprinting', 'signal'],
  uploading: ['Uploading', 'signal'],
  done: ['Sealed', 'ok'],
  duplicate: ['Duplicate', 'warn'],
  error: ['Failed', 'bad'],
};

function size(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

export function UploadPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const evidence = useEvidence(id);
  const patch = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  async function handle(file: File) {
    const key = crypto.randomUUID();
    setRows((rs) => [...rs, { key, name: file.name, state: 'hashing', pct: 0 }]);
    try {
      const sha = await hashFile(file, (p) => patch(key, { pct: p }));
      patch(key, { sha, state: 'uploading', pct: 1 });
      const r = await uploadEvidence(id!, file, sha, { onProgress: (p) => patch(key, { pct: Math.max(0.02, p) }) });
      patch(key, { state: r.duplicate ? 'duplicate' : 'done', msg: r.duplicate ? 'Same file already in this case (kept, grouped as duplicate)' : undefined });
      qc.invalidateQueries({ queryKey: ['evidence', id] });
    } catch (e) {
      patch(key, { state: 'error', msg: e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message });
    }
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => { [...(e.target.files ?? [])].forEach(handle); e.target.value = ''; };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); [...e.dataTransfer.files].forEach(handle); };
  const items = Array.isArray(evidence.data) ? evidence.data : [];

  return (
    <CaseShell>
      <h2 style={{ fontSize: 22 }}>Add what you saved, <span className="muted">we'll seal it</span></h2>

      <div
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <p className="dot" aria-hidden="true"><DotText>Drop files.</DotText></p>
        <p className="muted" style={{ maxWidth: 440 }}>Each file is fingerprinted with SHA-256 in your browser before it leaves your device.</p>
        <div className="kinds">
          {['WhatsApp .txt', 'Telegram / Instagram .json', 'Images', 'Voice notes', 'PDF', '.eml'].map((k) => <span key={k} className="chip">{k}</span>)}
        </div>
        <button type="button" className="btn btn-light" onClick={() => input.current?.click()} style={{ marginTop: 6 }}>
          <span className="tile"><DotGrid /></span>Choose files
        </button>
        <input ref={input} type="file" multiple onChange={onPick} aria-label="Choose evidence files" className="sr-only" />
      </div>

      {rows.length > 0 && (
        <section className="card" style={{ marginTop: 16 }} aria-live="polite">
          <div className="card-title"><p className="eyebrow">This session</p></div>
          <ul className="list">
            {rows.map((r) => {
              const [label, tone] = LABEL[r.state];
              return (
                <li key={r.key}>
                  <div className="row"><strong style={{ fontWeight: 500 }}>{r.name}</strong><span className={`badge ${tone}`}>{r.state === 'hashing' ? `${label} ${Math.round(r.pct * 100)}%` : label}</span></div>
                  {(r.state === 'hashing' || r.state === 'uploading') && <div className="progress"><i style={{ width: `${Math.round(r.pct * 100)}%` }} /></div>}
                  {r.msg && <p className={r.state === 'error' ? 'err' : 'muted'} style={{ fontSize: 13 }}>{r.msg}</p>}
                  {r.sha && <p className="hash">sha256 {r.sha}</p>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="card" style={{ marginTop: 16 }}>
        <div className="card-title">
          <h2 style={{ fontSize: 22 }}>In this case</h2>
          <span className="dot" style={{ fontSize: 28 }}>{items.length}</span>
        </div>
        {evidence.isLoading && <p className="muted">Loading…</p>}
        {evidence.data && items.length === 0 && <p className="muted">Nothing here yet. Files you add appear here once sealed.</p>}
        <ul className="list">
          {items.map((e) => (
            <li key={e.id}>
              <div className="row">
                <strong style={{ fontWeight: 500 }}>{e.filename}</strong>
                {e.duplicateOf ? <span className="badge warn">Duplicate</span> : <span className="badge ok">Sealed</span>}
              </div>
              <div className="meta"><span className="chip">{e.kind}</span><span className="mono">{size(e.size)}</span></div>
              <p className="hash">sha256 {e.sha256}</p>
            </li>
          ))}
        </ul>
      </section>
    </CaseShell>
  );
}
