import { useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, post } from './lib/api';
import { fmtDate, langName, SEVERITY, useCase, useCaseSocket, useChunk, type Entity } from './lib/case';
import { AppShell } from './ui';

const TABS: [string, string][] = [
  ['', 'Overview'], ['evidence', 'Evidence'], ['timeline', 'Timeline'], ['graph', 'Graph'], ['inconsistencies', 'Inconsistencies'],
  ['summary', 'Summary'], ['insights', 'Insights'], ['audit', 'Integrity'], ['upload', 'Add evidence'], ['settings', 'Settings'],
];

/** Case header + tab bar. Keeps a live socket open while any case page is mounted. */
export function CaseShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { id } = useParams();
  const c = useCase(id);
  useCaseSocket(id);
  return (
    <AppShell>
      <Link to="/cases" className="back">← Cases</Link>
      <header className="case-head">
        <div>
          <p className="eyebrow">{c.data ? `${c.data.incidentType} · ${c.data.role}` : 'Case'}</p>
          <h1 className="case-title">{c.data?.title ?? '…'}</h1>
        </div>
        {c.data && <span className={`badge ${c.data.status === 'ready' ? 'ok' : c.data.status === 'processing' ? 'signal' : ''}`}>{c.data.status}</span>}
      </header>
      <nav className="tabs" aria-label="Case sections">
        {TABS.map(([p, label]) => (
          <NavLink key={p} to={`/cases/${id}${p ? `/${p}` : ''}`} end={!p} className="tab">{label}</NavLink>
        ))}
      </nav>
      <div className={wide ? 'case-body wide' : 'case-body'}>{children}</div>
    </AppShell>
  );
}

export function SeverityTag({ score, labels }: { score: number; labels?: string[] }) {
  const tone = ['', 'warn', 'bad', 'bad sev3'][score] ?? '';
  return (
    <span className={`badge ${tone}`} title={labels?.join(', ')}>
      {SEVERITY[score] ?? 'benign'}
    </span>
  );
}

/** [E3:12] → hover preview of the cited chunk, click opens it in the viewer. "E3" cites a whole evidence item. */
export function CitationChip({ id, caseId }: { id: string; caseId: string }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const isChunk = /^E\d+:\d+$/.test(id);
  const q = useChunk(caseId, id, isChunk);
  const ev = useQuery({
    queryKey: ['evidence', caseId],
    queryFn: () => api<{ evidence: { id: string; idx: number }[] }>(`/cases/${caseId}/evidence`).then((r) => r.evidence),
    enabled: !isChunk,
    staleTime: 60_000,
  });
  const target = isChunk ? q.data?.evidenceId : ev.data?.find((e) => `E${e.idx}` === id)?.id;
  const go = () => target && nav(`/cases/${caseId}/evidence/${target}${isChunk ? `?chunk=${encodeURIComponent(id)}` : ''}`);
  return (
    <span className="cite-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={`cite${q.data === null && isChunk ? ' restricted' : ''}`} onClick={go} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} aria-label={`Source ${id}`}>
        {id}
      </button>
      {open && isChunk && (
        <span className="cite-pop" role="tooltip">
          {q.isLoading && <span className="muted">Loading…</span>}
          {q.data === null && <span className="muted">Restricted or unavailable</span>}
          {q.data && (
            <>
              <span className="eyebrow">{q.data.evidence?.label ?? 'Evidence'} · {q.data.sender ? `${q.data.sender} · ` : ''}{fmtDate(q.data.refTs)}</span>
              <span className="cite-text">{q.data.text}</span>
              {q.data.textEn && q.data.textEn !== q.data.text && <span className="cite-en">{q.data.textEn} <em>· machine translation</em></span>}
              {q.data.locator?.startMs != null && <span className="mono muted">audio {Math.round(q.data.locator.startMs / 1000)}s–{Math.round((q.data.locator.endMs ?? 0) / 1000)}s</span>}
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function Cites({ ids, caseId }: { ids: string[]; caseId: string }) {
  return <span className="cites">{ids.map((c) => <CitationChip key={c} id={c} caseId={caseId} />)}</span>;
}

const ABUSIVE = /\b(bitch|slut|whore|randi|kutti|kutta|harami|chutiya|saali|bastard|fuck\w*)\b/gi;

/** Original text with entity spans highlighted; abusive words masked until clicked (W8). */
export function Highlighted({ text, entities = [], mask = true }: { text: string; entities?: Entity[]; mask?: boolean }) {
  const [revealed, setRevealed] = useState(false);
  const parts: ReactNode[] = [];
  let pos = 0;
  const sorted = [...entities].filter((e) => e.start >= 0 && e.end <= text.length).sort((a, b) => a.start - b.start);
  const plain = (s: string, k: string) => {
    if (!mask || revealed) return <span key={k}>{s}</span>;
    const out: ReactNode[] = [];
    let i = 0;
    s.replace(ABUSIVE, (m, _g, off: number) => {
      out.push(s.slice(i, off));
      out.push(<button key={`${k}-${off}`} type="button" className="masked" onClick={() => setRevealed(true)} title="Hidden word — click to show">{'•'.repeat(Math.min(m.length, 6))}</button>);
      i = off + m.length;
      return m;
    });
    out.push(s.slice(i));
    return <span key={k}>{out}</span>;
  };
  sorted.forEach((e, i) => {
    if (e.start < pos) return;
    if (e.start > pos) parts.push(plain(text.slice(pos, e.start), `t${i}`));
    parts.push(<mark key={`e${i}`} className={`ent ent-${e.type.toLowerCase()}`} title={`${e.type}${e.norm != null ? ` · ${String(e.norm)}` : ''}`}>{text.slice(e.start, e.end)}</mark>);
    pos = e.end;
  });
  if (pos < text.length) parts.push(plain(text.slice(pos), 'end'));
  return <span className="hl">{parts}</span>;
}

/** Original text first; English working copy behind a toggle, always labelled as machine translation. */
export function Bilingual({ text, textEn, lang, entities, translation }: { text: string; textEn?: string | null; lang?: string; entities?: Entity[]; translation?: { provider: string } }) {
  const [en, setEn] = useState(false);
  const hasEn = !!textEn && textEn !== text;
  return (
    <span className="bilingual">
      {en && hasEn ? <span>{textEn}<span className="mt-label"> · machine translation{translation?.provider ? ` (${translation.provider})` : ''}</span></span> : <Highlighted text={text} entities={entities} />}
      {hasEn && (
        <button type="button" className="lang-toggle" onClick={() => setEn((v) => !v)}>
          {en ? `Show original (${langName(lang)})` : 'Show English'}
        </button>
      )}
    </span>
  );
}

export function HashBadge({ evidenceId, sha256 }: { evidenceId: string; sha256: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'bad'>('idle');
  const [reason, setReason] = useState('');
  async function verify() {
    setState('busy');
    try {
      const r = await post<{ ok: boolean; reason?: string }>(`/evidence/${evidenceId}/verify`);
      setState(r.ok ? 'ok' : 'bad');
      setReason(r.reason ?? '');
    } catch (e) {
      setState('bad');
      setReason((e as Error).message);
    }
  }
  return (
    <div className="hashbox">
      <p className="eyebrow">SHA-256 at upload</p>
      <p className="hash">{sha256}</p>
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={verify} disabled={state === 'busy'}>{state === 'busy' ? 'Re-hashing…' : 'Verify this file'}</button>
        {state === 'ok' && <span className="badge ok">Matches — unchanged</span>}
        {state === 'bad' && <span className="badge bad">Failed: {reason}</span>}
      </div>
    </div>
  );
}

/** Content warning before severity-3 material (W8, §11.2). */
export function ContentWarning({ show, children }: { show: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!show);
  if (open) return <>{children}</>;
  return (
    <div className="cw">
      <p><strong>Content warning.</strong> This contains threats or sexual content.</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>Show content</button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card empty">
      <h2 style={{ fontSize: 20 }}>{title}</h2>
      {children && <div className="muted" style={{ maxWidth: 420 }}>{children}</div>}
    </div>
  );
}

export function Stat({ n, label, tone }: { n: ReactNode; label: string; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ''}`}>
      <p className="dot stat-n">{n}</p>
      <p className="eyebrow">{label}</p>
    </div>
  );
}
