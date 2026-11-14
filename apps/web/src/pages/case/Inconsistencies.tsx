import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, patch } from '../../lib/api';
import { useEvidence } from '../../lib/case';
import { CaseShell, CitationChip, Empty, SeverityTag } from '../../components';

type Ref = { evidenceId: string; chunkId?: string; field?: string; quote: string; quoteEn?: string | null };
type Item = { key: string; type: string; subtype?: string; severity: number; title: string; explanation: string; refs: Ref[]; confidence: number; status: 'open' | 'dismissed' | 'explained'; note: string | null };

const MAX_SHOWN = 25; // spec §8: default cap, the rest sit behind "Show more"
const TYPE_LABEL: Record<string, string> = {
  EDITED_FILE: 'Edited file', METADATA_MISMATCH: 'Metadata mismatch', DATE_CONFLICT: 'Date conflict', AMOUNT_MISMATCH: 'Amount mismatch',
  SENDER_MISMATCH: 'Sender mismatch', COVERAGE_GAP: 'Coverage note', IMPOSSIBLE_SEQUENCE: 'Impossible sequence', CONTENT_CONTRADICTION: 'Content contradiction',
};

function Card({ caseId, it, label }: { caseId: string; it: Item; label: (eid: string) => string }) {
  const qc = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(it.note ?? '');
  const [err, setErr] = useState('');
  async function set(status: Item['status'], n?: string) {
    try {
      await patch(`/cases/${caseId}/inconsistencies/${it.key}`, { status, note: n });
      setNoteOpen(false);
      qc.invalidateQueries({ queryKey: ['inconsistencies', caseId] });
      qc.invalidateQueries({ queryKey: ['overview', caseId] });
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <article className={`card inc${it.status === 'dismissed' ? ' dismissed' : ''}`}>
      <div className="row">
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <span className="chip">{TYPE_LABEL[it.type] ?? it.type}{it.subtype === 'statement_vs_evidence' ? ' · your statement' : ''}</span>
          <SeverityTag score={it.severity} />
          <span className="mono muted" style={{ fontSize: 11 }}>{Math.round(it.confidence * 100)}% confidence</span>
        </div>
        {it.status !== 'open' && <span className={`badge ${it.status === 'explained' ? 'ok' : ''}`}>{it.status}</span>}
      </div>
      <h3 style={{ fontSize: 19 }}>{it.title}</h3>
      <p className="muted">{it.explanation}</p>
      <div className="inc-sides">
        {it.refs.map((r, i) => (
          <div key={i} className="inc-side">
            <div className="row">
              <Link to={`/cases/${caseId}/evidence/${r.evidenceId}${r.chunkId ? `?chunk=${encodeURIComponent(r.chunkId)}` : ''}`} className="eyebrow" style={{ textDecoration: 'none' }}>{label(r.evidenceId)}{r.field ? ` · ${r.field}` : ''}</Link>
              {r.chunkId && <CitationChip id={r.chunkId} caseId={caseId} />}
            </div>
            <span className="hl">“{r.quote}”</span>
            {r.quoteEn && <span className="muted" style={{ fontSize: 13 }}>{r.quoteEn} <span className="mt-label">· machine translation</span></span>}
          </div>
        ))}
      </div>
      {it.note && !noteOpen && <p style={{ fontSize: 14 }}><strong>Explanation:</strong> {it.note}</p>}
      {noteOpen ? (
        <div className="stack" style={{ gap: 8 }}>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. I cropped the screenshot to hide my friend's number." aria-label="Explanation" />
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn btn-dark btn-sm" onClick={() => set('explained', note)} disabled={!note.trim()}>Save explanation</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNoteOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNoteOpen(true)}>Explain</button>
          {it.status !== 'dismissed' ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('dismissed')}>Dismiss</button>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => set('open')}>Reopen</button>
          )}
        </div>
      )}
      {err && <p className="err">{err}</p>}
    </article>
  );
}

export function InconsistenciesPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['inconsistencies', id], queryFn: () => api<{ items: Item[] }>(`/cases/${id}/inconsistencies`).then((r) => r.items) });
  const ev = useEvidence(id);
  const [showAll, setShowAll] = useState(false);
  const label = (eid: string) => {
    const e = ev.data?.find((x) => x.id === eid);
    return e ? `E${e.idx} · ${e.sourceLabel || e.filename}` : 'Evidence';
  };
  const items = q.data ?? [];
  const open = items.filter((i) => i.status !== 'dismissed');
  const dismissed = items.filter((i) => i.status === 'dismissed');
  return (
    <CaseShell>
      <p className="muted" style={{ maxWidth: 680 }}>
        These are places where your evidence disagrees with itself. Checking them before filing makes your case stronger. Explained items appear in the report with your note.
      </p>
      {q.data && items.length === 0 && <Empty title="No inconsistencies found">Edited files, conflicting dates and mismatched amounts would appear here.</Empty>}
      {open.slice(0, showAll ? undefined : MAX_SHOWN).map((it) => <Card key={it.key} caseId={id} it={it} label={label} />)}
      {!showAll && open.length > MAX_SHOWN && (
        <button type="button" className="btn btn-ghost" onClick={() => setShowAll(true)}>Show {open.length - MAX_SHOWN} more</button>
      )}
      {dismissed.length > 0 && <p className="eyebrow" style={{ marginTop: 12 }}>Dismissed</p>}
      {dismissed.map((it) => <Card key={it.key} caseId={id} it={it} label={label} />)}
    </CaseShell>
  );
}
