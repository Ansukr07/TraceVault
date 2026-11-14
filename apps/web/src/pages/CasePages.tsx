import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AppShell, DotGrid, DotText, PageHead } from '../ui';

type CaseSummary = { id: string; title: string; incidentType: string; status: string; role?: string; evidenceCount?: number; updatedAt: string };

const TYPES = ['harassment', 'fraud', 'stalking', 'sextortion', 'other'];

function statusTone(s: string) {
  if (/ready|done|complete|sealed/i.test(s)) return 'ok';
  if (/process|running|queued/i.test(s)) return 'signal';
  if (/fail|error/i.test(s)) return 'bad';
  return '';
}

function ago(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

type StatusFilter = 'all' | 'draft' | 'processing' | 'ready';
type Sort = 'updated' | 'title' | 'evidence';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

function Tile({ label, n, hint, live }: { label: string; n: number; hint: string; live?: boolean }) {
  return (
    <div className={`dash-tile${live ? ' live' : ''}`}>
      <p className="eyebrow">{label}</p>
      <p className="dot dash-n">{n}</p>
      <p className="dash-hint">{hint}</p>
    </div>
  );
}

export function CasesPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ['cases'], queryFn: () => api<{ cases: CaseSummary[] }>('/cases') });
  const cases = data?.cases ?? [];
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<Sort>('updated');

  const total = cases.length;
  const evidence = cases.reduce((s, c) => s + (c.evidenceCount ?? 0), 0);
  const processing = cases.filter((c) => c.status === 'processing').length;
  const ready = cases.filter((c) => c.status === 'ready').length;
  const counts: Record<StatusFilter, number> = { all: total, draft: cases.filter((c) => c.status === 'draft').length, processing, ready };

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return cases
      .filter((c) => (filter === 'all' || c.status === filter) && (!needle || `${c.title} ${c.incidentType}`.toLowerCase().includes(needle)))
      .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'evidence' ? (b.evidenceCount ?? 0) - (a.evidenceCount ?? 0) : +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }, [cases, q, filter, sort]);

  const latest = [...cases].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))[0];
  const steps: [string, boolean, string][] = [
    ['Create a case', total > 0, '/cases/new'],
    ['Add your first evidence', evidence > 0, latest ? `/cases/${latest.id}/upload` : '/cases/new'],
    ['Let processing finish', ready > 0, latest ? `/cases/${latest.id}` : '/cases/new'],
    ['Share with a lawyer or officer', false, latest ? `/cases/${latest.id}/share` : '/cases/new'],
  ];
  const firstName = user?.name?.split(' ')[0];

  return (
    <AppShell>
      <PageHead
        eyebrow={`Dashboard · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}`}
        title={<>{greeting()}{firstName ? `, ${firstName}` : ''} <span className="muted">your cases at a glance</span></>}
        actions={<Link to="/cases/new" className="btn btn-light" style={{ height: 46 }}><span className="tile" style={{ width: 34, height: 34 }}><DotGrid /></span>New case</Link>}
      />

      <section className="dash-tiles" aria-label="Summary">
        <Tile label="Cases" n={total} hint={total === 1 ? '1 case file' : `${total} case files`} />
        <Tile label="Evidence sealed" n={evidence} hint="Originals with SHA-256" />
        <Tile label="Processing" n={processing} hint={processing ? 'Reading your files' : 'Nothing running'} live={processing > 0} />
        <Tile label="Ready" n={ready} hint="Timeline and summary built" />
      </section>

      {error && <p role="alert" className="err">{(error as Error).message}</p>}

      <div className="dash-main">
        <section className="dash-panel" aria-label="Cases">
          <div className="dash-panel-head">
            <h2>Cases</h2>
            <span className="mono muted">{rows.length} of {total}</span>
          </div>
          <div className="dash-toolbar">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cases" aria-label="Search cases" />
            <div className="seg" role="group" aria-label="Filter by status">
              {(['all', 'draft', 'processing', 'ready'] as StatusFilter[]).map((f) => (
                <label key={f}>
                  <input type="radio" name="status-filter" checked={filter === f} onChange={() => setFilter(f)} />
                  <span>{f} · {counts[f]}</span>
                </label>
              ))}
            </div>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort cases">
              <option value="updated">Recently updated</option>
              <option value="title">Title A–Z</option>
              <option value="evidence">Most evidence</option>
            </select>
          </div>

          {isLoading && <p className="muted dash-empty">Loading…</p>}
          {data && total === 0 && (
            <div className="dash-empty">
              <p className="dot" aria-hidden="true"><DotText>Empty.</DotText></p>
              <h3>No cases yet</h3>
              <p className="muted" style={{ maxWidth: 360 }}>Create a case, then add chats, screenshots, voice notes, PDFs or emails. Each file is fingerprinted before it leaves your device.</p>
              <Link to="/cases/new" className="btn btn-dark">Create your first case</Link>
            </div>
          )}
          {data && total > 0 && rows.length === 0 && <p className="muted dash-empty">No cases match.</p>}

          {rows.length > 0 && (
            <ul className="dash-rows">
              <li className="dash-row dash-row-head" aria-hidden="true">
                <span>Case</span><span>Status</span><span>Evidence</span><span>Updated</span><span />
              </li>
              {rows.map((c) => (
                <li key={c.id}>
                  <Link to={`/cases/${c.id}`} className="dash-row">
                    <span className="dash-case">
                      <strong>{c.title}</strong>
                      <span className="meta"><span className="chip">{c.incidentType}</span>{c.role && c.role !== 'owner' && <span className="chip">{c.role}</span>}</span>
                    </span>
                    <span><span className={`badge ${statusTone(c.status)}`}>{c.status}</span></span>
                    <span className="mono">{c.evidenceCount ?? 0} files</span>
                    <span className="mono muted">{ago(c.updatedAt)}</span>
                    <span className="dash-go" aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="dash-rail">
          <section className="dash-panel dash-rail-card" aria-label="Quick actions">
            <div className="dash-panel-head"><h2>Quick actions</h2></div>
            <div className="dash-actions">
              <Link to="/cases/new" className="dash-action"><span>New case</span><span aria-hidden="true">→</span></Link>
              <Link to={latest ? `/cases/${latest.id}/upload` : '/cases/new'} className="dash-action"><span>Add evidence{latest ? ' to latest' : ''}</span><span aria-hidden="true">→</span></Link>
              <Link to={latest ? `/cases/${latest.id}/summary` : '/cases/new'} className="dash-action"><span>Open latest summary</span><span aria-hidden="true">→</span></Link>
              <Link to="/verify" className="dash-action"><span>Verify an evidence bundle</span><span aria-hidden="true">→</span></Link>
            </div>
          </section>
          <section className="dash-panel dash-rail-card" aria-label="Getting started">
            <div className="dash-panel-head"><h2>Getting started</h2><span className="mono muted">{steps.filter((s) => s[1]).length}/{steps.length}</span></div>
            <ol className="dash-steps">
              {steps.map(([label, done, to]) => (
                <li key={label} className={done ? 'done' : ''}>
                  <span className="dash-check" aria-hidden="true">{done ? '✓' : ''}</span>
                  <Link to={to}>{label}</Link>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}

export function NewCasePage() {
  const nav = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: '', incidentType: 'other', description: '' });
  const [voiceConsent, setVoiceConsent] = useState(false);

  function next(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.title.trim()) return;
    setStep(2);
    window.scrollTo({ top: 0 });
  }

  async function create(after: 'upload' | 'statement') {
    setBusy(true);
    setErr('');
    try {
      const r = await post<{ case: { id: string } }>('/cases', { ...form, title: form.title.trim(), voiceConsent });
      nav(`/cases/${r.case.id}/${after}`);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <Link to="/cases" className="back">← Cases</Link>
      <PageHead
        eyebrow={`New case · step ${step} of 2`}
        title={step === 1 ? <>Open a case file <span className="muted">in a minute</span></> : <>Who sees what <span className="muted">before you add anything</span></>}
      />
      <div className="two-col">
        {step === 1 ? (
          <form onSubmit={next} className="card stack" style={{ gap: 22 }}>
            <label className="field">Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={200} placeholder="e.g. Messages from unknown number, March" /></label>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 8 }}>Type of incident</legend>
              <div className="seg">
                {TYPES.map((t) => (
                  <label key={t}>
                    <input type="radio" name="incidentType" value={t} checked={form.incidentType === t} onChange={() => setForm({ ...form, incidentType: t })} />
                    <span>{t}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="field">
              <span>Description <span className="hint">· optional</span></span>
              <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={5000} rows={4} placeholder="Anything you want to remember about this case. You can add more later." />
            </label>
            <div><button className="btn btn-dark" style={{ height: 46 }}>Continue to privacy</button></div>
          </form>
        ) : (
          <section className="card stack" style={{ gap: 20 }} aria-label="Privacy and consent">
            <p className="muted" style={{ fontSize: 14 }}>These are the defaults for <strong style={{ color: 'var(--ink)', fontWeight: 500 }}>{form.title}</strong>. You can change them any time in Case settings.</p>
            <ul className="list privacy-list">
              <li>
                <div className="row"><strong>Your original files</strong><span className="badge ok">stay with us</span></div>
                <p className="muted">Encrypted, fingerprinted with SHA-256, and never changed. Never sent to any AI provider as files.</p>
              </li>
              <li>
                <div className="row"><strong>Summaries and timeline</strong><span className="badge">Qwen 3.8 · Groq</span></div>
                <p className="muted">Names, phone numbers, UPI IDs and similar details are replaced with placeholders before text is sent, then restored.</p>
              </li>
              <li>
                <div className="row"><strong>Translation</strong><span className="badge">Sarvam Translate</span></div>
                <p className="muted">Hindi, Hinglish and other Indian-language text is translated after the same redaction. The original text is always kept next to it.</p>
              </li>
              <li>
                <div className="row"><strong>Voice notes</strong><span className="badge warn">needs your consent</span></div>
                <p className="muted">Audio can’t be redacted before transcription, so it goes to Sarvam AI as recorded.</p>
              </li>
            </ul>
            <label className="consent">
              <input type="checkbox" checked={voiceConsent} onChange={(e) => setVoiceConsent(e.target.checked)} />
              <span>Voice notes will be sent to Sarvam AI, an Indian speech provider, for transcription. <span className="muted">Without this, voice notes are transcribed on our server only, and there is no translation or read-aloud for them.</span></span>
            </label>
            {err && <p role="alert" className="err">{err}</p>}
            <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
              <button type="button" className="btn btn-ghost" style={{ height: 46 }} disabled={busy} onClick={() => setStep(1)}>Back</button>
              <button type="button" className="btn btn-dark" style={{ height: 46 }} disabled={busy} onClick={() => create('upload')}>{busy ? 'Creating…' : 'Create and add evidence'}</button>
              <button type="button" className="btn btn-ghost" style={{ height: 46 }} disabled={busy} onClick={() => create('statement')}>Create and tell what happened</button>
            </div>
          </section>
        )}
        <aside className="card stack" style={{ gap: 20 }}>
          <p className="eyebrow">What happens next</p>
          {[
            ['01', 'Add evidence', 'Chats, screenshots, voice notes, PDFs and emails.'],
            ['02', 'We seal it', 'Each original gets a SHA-256 fingerprint and is never changed.'],
            ['03', 'We rebuild it', 'People, dates and amounts are linked into one timeline.'],
            ['04', 'You share it', 'With a lawyer or police, for as long as you choose.'],
          ].map(([n, h, p]) => (
            <div key={n} style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: 12 }}>
              <span className="dot" style={{ fontSize: 24 }}>{n}</span>
              <div><h3 style={{ fontSize: 16, marginBottom: 4 }}>{h}</h3><p className="muted" style={{ fontSize: 14 }}>{p}</p></div>
            </div>
          ))}
        </aside>
      </div>
    </AppShell>
  );
}
