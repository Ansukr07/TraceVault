import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { AppShell, DotGrid, DotText, PageHead } from '../ui';

type CaseSummary = { id: string; title: string; incidentType: string; status: string; evidenceCount?: number; updatedAt: string };

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

export function CasesPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['cases'], queryFn: () => api<{ cases: CaseSummary[] }>('/cases') });
  const cases = data?.cases ?? [];
  return (
    <AppShell>
      <PageHead
        eyebrow={`Cases · ${cases.length}`}
        title={<>Your cases <span className="muted">in one place</span></>}
        actions={<Link to="/cases/new" className="btn btn-light" style={{ height: 46 }}><span className="tile" style={{ width: 34, height: 34 }}><DotGrid /></span>New case</Link>}
      />
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p role="alert" className="err">{(error as Error).message}</p>}
      {data && cases.length === 0 && (
        <div className="card empty">
          <p className="dot" aria-hidden="true"><DotText>Empty.</DotText></p>
          <h2 style={{ fontSize: 22 }}>No cases yet</h2>
          <p className="muted" style={{ maxWidth: 360 }}>Create a case, then add chats, screenshots, voice notes, PDFs or emails. Each file is fingerprinted before it leaves your device.</p>
          <Link to="/cases/new" className="btn btn-dark">Create your first case</Link>
        </div>
      )}
      <ul className="case-grid">
        {cases.map((c) => (
          <li key={c.id}>
            <Link to={`/cases/${c.id}`} className="case-card">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="chip">{c.incidentType}</span>
                <span className={`badge ${statusTone(c.status)}`}>{c.status}</span>
              </div>
              <h3>{c.title}</h3>
              <div className="foot">
                <div>
                  <p className="dot count">{c.evidenceCount ?? 0}</p>
                  <p className="eyebrow" style={{ marginTop: 6 }}>Evidence files</p>
                </div>
                <span className="mono muted" style={{ fontSize: 11 }}>{ago(c.updatedAt)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}

export function NewCasePage() {
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr('');
    try {
      const r = await post<{ case: { id: string } }>('/cases', {
        title: f.get('title'),
        incidentType: f.get('incidentType'),
        description: f.get('description'),
        voiceConsent: f.get('voiceConsent') === 'on',
      });
      nav(`/cases/${r.case.id}/upload`);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AppShell>
      <Link to="/cases" className="back">← Cases</Link>
      <PageHead eyebrow="New case" title={<>Open a case file <span className="muted">in a minute</span></>} />
      <div className="two-col">
        <form onSubmit={submit} className="card stack" style={{ gap: 22 }}>
          <label className="field">Title<input name="title" required maxLength={200} placeholder="e.g. Messages from unknown number, March" /></label>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ marginBottom: 8 }}>Type of incident</legend>
            <div className="seg">
              {TYPES.map((t) => (
                <label key={t}>
                  <input type="radio" name="incidentType" value={t} defaultChecked={t === 'other'} />
                  <span>{t}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span>Description <span className="hint">· optional</span></span>
            <textarea name="description" maxLength={5000} rows={4} placeholder="Anything you want to remember about this case. You can add more later." />
          </label>
          <div className="field">
            <span>Privacy</span>
            <label className="consent">
              <input type="checkbox" name="voiceConsent" />
              <span>Send voice notes to Sarvam AI, an Indian speech provider, for transcription. Without this, voice notes are transcribed on our server only.</span>
            </label>
          </div>
          {err && <p role="alert" className="err">{err}</p>}
          <div><button className="btn btn-dark" style={{ height: 46 }} disabled={busy}>{busy ? 'Creating…' : 'Create case'}</button></div>
        </form>
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
