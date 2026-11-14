import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from './lib/api';
import { fmtDate, langName, SEVERITY, useCase, useCaseProgress, useChunk, type Entity } from './lib/case';
import { AppShell } from './ui';

export function Watermark({ email, caseId }: { email?: string; caseId?: string }) {
  if (!email) return null;
  return (
    <div className="watermark" aria-hidden="true">
      Viewed by {email} · Case {caseId?.slice(-6) ?? 'TV'} · Strictly Confidential
    </div>
  );
}

type Note = { id: string; text: string; authorName: string; authorRole: string; createdAt: string; mine: boolean; chunkId?: string | null };

/** Notes on an evidence item (spec E9). Owner, collaborator and legal can add; authors can delete their own. */
export function Annotations({ evidenceId, role }: { evidenceId: string; role?: string }) {
  const qc = useQueryClient();
  const key = ['annotations', evidenceId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ annotations: Note[] }>(`/evidence/${evidenceId}/annotations`).then((r) => r.annotations) });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const can = role === 'owner' || role === 'collaborator' || role === 'legal';

  async function add() {
    setBusy(true); setErr('');
    try { await post(`/evidence/${evidenceId}/annotations`, { text: text.trim() }); setText(''); await qc.invalidateQueries({ queryKey: key }); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    await api(`/evidence/${evidenceId}/annotations/${id}`, { method: 'DELETE' }).catch(() => {});
    qc.invalidateQueries({ queryKey: key });
  }
  const notes = q.data ?? [];

  return (
    <section className="card" aria-label="Notes">
      <div className="card-title"><h3>Notes</h3><span className="mono muted" style={{ fontSize: 11 }}>{notes.length}</span></div>
      {notes.length === 0 && <p className="muted" style={{ fontSize: 14 }}>No notes yet. Notes sit beside the evidence; they never change the sealed original.</p>}
      <ul className="list">
        {notes.map((n) => (
          <li key={n.id}>
            <div className="row" style={{ gap: 8 }}>
              <span style={{ fontSize: 13 }}><strong style={{ fontWeight: 500 }}>{n.authorName}</strong> <span className="chip">{n.authorRole}</span></span>
              <span className="mono muted" style={{ fontSize: 11 }}>{fmtDate(n.createdAt)}</span>
            </div>
            <p style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{n.text}</p>
            {n.mine && <div><button type="button" className="btn-text muted" style={{ fontSize: 12 }} onClick={() => remove(n.id)}>Delete</button></div>}
          </li>
        ))}
      </ul>
      {can && (
        <div className="stack" style={{ marginTop: 12 }}>
          <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for this evidence" aria-label="New note" />
          {err && <p role="alert" className="err">{err}</p>}
          <div><button type="button" className="btn btn-ghost" disabled={busy || !text.trim()} onClick={add}>Add note</button></div>
        </div>
      )}
    </section>
  );
}

type Grant = {
  id: string; role: string; expiresAt: string; allowDownload: boolean; officerStatus: string; firNumber?: string;
  scope: { type: string; evidenceIds: string[] }; requests: { at: string; message: string }[];
};
const OFFICER_STATUS: [string, string][] = [['received', 'Received'], ['under_review', 'Under review'], ['fir_registered', 'FIR registered'], ['closed', 'Closed']];

/** Officer / lawyer action rail (plan §7.2): access banner, status + FIR, request more evidence, private notes. */
export function OfficerRail({ caseId }: { caseId: string }) {
  const qc = useQueryClient();
  const g = useQuery({ queryKey: ['grant', caseId], queryFn: () => api<{ grant: Grant }>(`/officer/cases/${caseId}/grant`).then((r) => r.grant) });
  const n = useQuery({ queryKey: ['notes', caseId], queryFn: () => api<{ notes: string }>(`/officer/cases/${caseId}/notes`).then((r) => r.notes) });
  const [fir, setFir] = useState('');
  const [msg, setMsg] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { if (g.data?.firNumber) setFir(g.data.firNumber); }, [g.data?.firNumber]);
  useEffect(() => { if (n.data !== undefined) setNotes(n.data); }, [n.data]);

  async function run(label: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(label); setErr(''); setSaved('');
    try { await fn(); await qc.invalidateQueries({ queryKey: ['grant', caseId] }); setSaved(ok); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  }
  if (!g.data) return null;
  const d = g.data;
  const daysLeft = Math.max(0, Math.ceil((new Date(d.expiresAt).getTime() - Date.now()) / 86_400_000));

  return (
    <section className="card officer-rail" aria-label="Officer actions">
      <p className="verify-banner" style={{ marginBottom: 16 }}>
        <strong>{d.role === 'investigator' ? 'Investigator' : 'Legal'} access</strong> until {fmtDate(d.expiresAt)} ({daysLeft} day{daysLeft === 1 ? '' : 's'} left)
        {d.scope.type === 'evidence' ? ` · ${d.scope.evidenceIds.length} item(s) shared` : ' · whole case'} · Every view is logged and visible to the complainant.
      </p>
      <div className="grid-2">
        {d.role === 'investigator' && <div className="stack">
          <p className="eyebrow">Case status</p>
          <div className="seg">
            {OFFICER_STATUS.map(([v, label]) => (
              <label key={v}>
                <input type="radio" name="officer-status" checked={d.officerStatus === v} disabled={!!busy}
                  onChange={() => run('status', () => api(`/officer/cases/${caseId}/status`, { method: 'PATCH', body: JSON.stringify({ status: v, firNumber: fir || undefined }) }), `Marked ${label.toLowerCase()}`)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {d.officerStatus === 'needs_evidence' && <span className="badge warn">Waiting for more evidence</span>}
          <label className="field">FIR / complaint number
            <span className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <input value={fir} onChange={(e) => setFir(e.target.value)} placeholder="e.g. 0142/2026" />
              <button type="button" className="btn btn-ghost" disabled={!!busy || !fir}
                onClick={() => run('fir', () => api(`/officer/cases/${caseId}/status`, { method: 'PATCH', body: JSON.stringify({ status: d.officerStatus, firNumber: fir }) }), 'FIR number saved')}>Save</button>
            </span>
          </label>
          <p className="muted" style={{ fontSize: 13 }}>Status changes are audited and shown to the complainant on their Sharing page.</p>
        </div>}
        <div className="stack">
          <p className="eyebrow">Request more evidence</p>
          <label className="field">Message to the complainant
            <textarea rows={3} maxLength={500} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="e.g. Please add the bank statement for June." />
          </label>
          <div><button type="button" className="btn btn-dark" disabled={!!busy || msg.trim().length < 3}
            onClick={() => run('req', async () => { await post(`/officer/cases/${caseId}/requests`, { message: msg.trim() }); setMsg(''); }, 'Request sent')}>Send request</button></div>
          {d.requests.length > 0 && (
            <ul className="list" style={{ fontSize: 13 }}>
              {d.requests.map((r, i) => <li key={i}><span className="muted">{fmtDate(r.at)}</span> {r.message}</li>)}
            </ul>
          )}
          <p className="eyebrow" style={{ marginTop: 6 }}>Private notes</p>
          <textarea rows={3} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Only you can see these. They are not part of any export." aria-label="Private notes" />
          <div><button type="button" className="btn btn-ghost" disabled={!!busy}
            onClick={() => run('notes', () => api(`/officer/cases/${caseId}/notes`, { method: 'PUT', body: JSON.stringify({ notes }) }), 'Notes saved')}>Save notes</button></div>
        </div>
      </div>
      {err && <p role="alert" className="err" style={{ marginTop: 12 }}>{err}</p>}
      {saved && !err && <p className="muted" role="status" style={{ marginTop: 12, fontSize: 13 }}>{saved}</p>}
    </section>
  );
}

/** Case header + tab bar. Keeps progress polling while any case page is mounted. */
export function CaseShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const { id } = useParams();
  const c = useCase(id);
  useCaseProgress(id);
  const role = c.data?.role ?? 'owner';
  const isOfficerOrLegal = role === 'investigator' || role === 'legal';

  const tabs: [string, string][] = isOfficerOrLegal
    ? [
        ['', 'Overview'], ['evidence', 'Evidence'], ['timeline', 'Timeline'], ['graph', 'Graph'],
        ['inconsistencies', 'Inconsistencies'], ['summary', 'Summary'], ['insights', 'Insights'],
        ['audit', 'Integrity'], ['export', 'Export'],
      ]
    : role === 'collaborator'
    ? [
        ['', 'Overview'], ['evidence', 'Evidence'], ['timeline', 'Timeline'], ['graph', 'Graph'],
        ['inconsistencies', 'Inconsistencies'], ['summary', 'Summary'], ['insights', 'Insights'],
        ['statement', 'Statement'], ['audit', 'Integrity'], ['upload', 'Add evidence'],
      ]
    : [
        ['', 'Overview'], ['evidence', 'Evidence'], ['timeline', 'Timeline'], ['graph', 'Graph'],
        ['inconsistencies', 'Inconsistencies'], ['summary', 'Summary'], ['insights', 'Insights'],
        ['statement', 'Statement'], ['complaint', 'Complaint'], ['audit', 'Integrity'], ['upload', 'Add evidence'], ['share', 'Share'], ['export', 'Export'],
        ['settings', 'Settings'],
      ];

  const backLink = isOfficerOrLegal ? '/officer' : '/cases';
  const backText = isOfficerOrLegal ? '← Officer Inbox' : '← Cases';

  return (
    <AppShell>
      <Link to={backLink} className="back">{backText}</Link>
      <header className="case-head">
        <div>
          <p className="eyebrow">{c.data ? `${c.data.incidentType} · ${c.data.role}` : 'Case'}</p>
          <h1 className="case-title">{c.data?.title ?? '…'}</h1>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {c.data?.sealedAt && <span className="chip" title="Evidence set frozen; add new evidence in an addendum">Sealed</span>}
          {isOfficerOrLegal && <span className="chip" style={{ background: 'var(--paper-2)' }}>Scoped Access</span>}
          {c.data && <span className={`badge ${c.data.status === 'ready' ? 'ok' : c.data.status === 'processing' ? 'signal' : ''}`}>{c.data.status}</span>}
        </div>
      </header>
      <div className="case-layout">
        <nav className="tabs" aria-label="Case sections">
          <p className="eyebrow tabs-label">Case sections</p>
          {tabs.map(([p, label]) => (
            <NavLink key={p} to={`/cases/${id}${p ? `/${p}` : ''}`} end={!p} className="tab">{label}</NavLink>
          ))}
        </nav>
        <div className="case-main">
          {isOfficerOrLegal && id && <OfficerRail caseId={id} />}
          <div className={wide ? 'case-body wide' : 'case-body'}>{children}</div>
        </div>
      </div>
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

/** Shimmering placeholder block. Sized by the caller via className/style. */
export function Skeleton({ w, h = 14, r, className = '' }: { w?: number | string; h?: number | string; r?: number | string; className?: string }) {
  return <span className={`skel ${className}`} aria-hidden="true" style={{ width: w, height: h, borderRadius: r }} />;
}

/**
 * Page-level loading state shaped like the content that is coming, so the layout doesn't jump.
 * variant: stats+feed (timeline), stats+canvas (graph), stats+cards (overview/insights), text (summary/settings).
 */
export function PageLoading({ variant = 'cards', label = 'Loading' }: { variant?: 'timeline' | 'graph' | 'cards' | 'text'; label?: string }) {
  const stats = (
    <div className="skel-stats">{[0, 1, 2, 3].map((i) => <div key={i} className="skel-card"><Skeleton w={44} h={30} r={6} /><Skeleton w="60%" h={10} /></div>)}</div>
  );
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-busy="true">
      <p className="eyebrow loading-label"><span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>{label}…</p>
      {variant !== 'text' && stats}
      {variant === 'timeline' && (
        <>
          <Skeleton h={44} r={12} />
          <Skeleton h={190} r={20} />
          <div className="skel-split">
            <div className="skel-feed">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skel-card skel-event">
                  <Skeleton w="38%" h={10} /><Skeleton w="82%" h={16} /><Skeleton w="54%" h={10} />
                </div>
              ))}
            </div>
            <div className="skel-card skel-side"><Skeleton w="50%" h={12} /><Skeleton w="85%" h={20} /><Skeleton h={10} /><Skeleton h={10} /><Skeleton w="70%" h={10} /></div>
          </div>
        </>
      )}
      {variant === 'graph' && (
        <>
          <Skeleton h={52} r={12} />
          <div className="skel-split">
            <div className="skel-graph"><span className="skel-node n1" /><span className="skel-node n2" /><span className="skel-node n3" /><span className="skel-node n4" /><span className="skel-node n5" /></div>
            <div className="skel-card skel-side"><Skeleton w="45%" h={14} /><Skeleton h={10} /><Skeleton h={10} /><Skeleton w="75%" h={10} /></div>
          </div>
        </>
      )}
      {variant === 'cards' && (
        <div className="skel-split">
          <div className="skel-card skel-side"><Skeleton w="40%" h={14} /><Skeleton h={10} /><Skeleton h={10} /><Skeleton w="65%" h={10} /></div>
          <div className="skel-card skel-side"><Skeleton w="40%" h={14} /><Skeleton h={10} /><Skeleton h={10} /><Skeleton w="65%" h={10} /></div>
        </div>
      )}
      {variant === 'text' && (
        <div className="skel-card skel-side">
          <Skeleton w="35%" h={18} /><Skeleton h={10} /><Skeleton h={10} /><Skeleton w="80%" h={10} /><Skeleton w="35%" h={18} /><Skeleton h={10} /><Skeleton w="60%" h={10} />
        </div>
      )}
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
