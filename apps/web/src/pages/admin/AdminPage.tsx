import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, patch, post } from '../../lib/api';
import { fmtDate } from '../../lib/case';
import { AppShell, PageHead } from '../../ui';

type AdminUser = {
  id: string;
  email: string;
  name: string;
  accountType: 'citizen' | 'officer' | 'official';
  isAdmin: boolean;
  disabled?: boolean;
  createdAt: string;
  officer?: {
    agency: string;
    unit: string;
    rank?: string;
    badgeId: string;
    verifiedAt?: string;
    rejectedAt?: string;
    rejectReason?: string;
  };
};

type AdminJob = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  runAt: string;
  updatedAt: string;
  error?: string;
};

export function AdminPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'users' | 'officers' | 'jobs' | 'usage' | 'health'>('officers');
  const [userSearch, setUserSearch] = useState('');

  // Queries
  const usersQ = useQuery({
    queryKey: ['adminUsers', userSearch],
    queryFn: () => api<{ users: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(userSearch)}`),
    enabled: tab === 'users',
  });

  const officersQ = useQuery({
    queryKey: ['pendingOfficers'],
    queryFn: () => api<{ officers: AdminUser[] }>('/admin/officers/pending'),
    enabled: tab === 'officers',
  });

  const jobsQ = useQuery({
    queryKey: ['adminJobs'],
    queryFn: () => api<{ jobs: AdminJob[]; counts: Record<string, number> }>('/admin/jobs'),
    enabled: tab === 'jobs',
    refetchInterval: 5000,
  });

  const usageQ = useQuery({
    queryKey: ['adminUsage'],
    queryFn: () => api<{ usage: { day: string; provider: string; calls: number; audioSeconds: number; chars: number }[] }>('/admin/usage?days=14'),
    enabled: tab === 'usage',
  });

  type AdminHealth = {
    db: string;
    gridfs: { status: string; files: number };
    ml: {
      status: string;
      providers?: { sarvam?: { configured: boolean; mock?: boolean; reachable: boolean | null; keyValid: boolean | null }; llm?: { configured: boolean; provider?: string; model?: string } };
      tools?: { ffmpeg?: boolean; tesseract?: boolean };
      models?: { ocr?: { loaded?: boolean }; system1?: { model?: string; loaded?: boolean; hosted?: boolean }; embeddings?: { model?: string; loaded?: boolean } };
      agents?: { enabled: boolean; error?: string };
    };
  };
  const healthQ = useQuery({
    queryKey: ['adminHealth'],
    queryFn: () => api<AdminHealth>('/admin/health'),
    enabled: tab === 'health',
  });

  async function verifyOfficer(uid: string, approve: boolean) {
    let reason: string | undefined = undefined;
    if (!approve) {
      const res = prompt('Enter rejection reason:');
      if (!res) return;
      reason = res;
    }
    try {
      await post(`/admin/officers/${uid}/verify`, { approve, reason });
      qc.invalidateQueries({ queryKey: ['pendingOfficers'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function toggleUserDisabled(uid: string, disabled: boolean) {
    try {
      await patch(`/admin/users/${uid}`, { disabled });
      qc.invalidateQueries({ queryKey: ['adminUsers'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function retryJob(jid: string) {
    try {
      await post(`/admin/jobs/${jid}/retry`);
      qc.invalidateQueries({ queryKey: ['adminJobs'] });
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <AppShell>
      <PageHead
        eyebrow="Platform Operations (§9 · O1–O4)"
        title={<>Admin dashboard <span className="muted">& system telemetry</span></>}
      />

      <nav className="tabs" style={{ marginBottom: 16 }}>
        <button
          type="button"
          className={`tab ${tab === 'officers' ? 'active' : ''}`}
          onClick={() => setTab('officers')}
        >
          Officer Verification Queue
        </button>
        <button
          type="button"
          className={`tab ${tab === 'users' ? 'active' : ''}`}
          onClick={() => setTab('users')}
        >
          User Accounts
        </button>
        <button
          type="button"
          className={`tab ${tab === 'jobs' ? 'active' : ''}`}
          onClick={() => setTab('jobs')}
        >
          Background Pipeline Jobs
        </button>
        <button
          type="button"
          className={`tab ${tab === 'usage' ? 'active' : ''}`}
          onClick={() => setTab('usage')}
        >
          Provider & Sarvam Usage
        </button>
        <button
          type="button"
          className={`tab ${tab === 'health' ? 'active' : ''}`}
          onClick={() => setTab('health')}
        >
          System Health
        </button>
      </nav>

      {/* Officers Verification Tab */}
      {tab === 'officers' && (
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Pending police officer approvals</h3>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {officersQ.data?.officers.length ?? 0} pending
            </span>
          </div>

          {officersQ.isLoading && <p className="muted">Loading officers queue…</p>}

          {officersQ.data?.officers.length === 0 && (
            <p className="muted" style={{ fontSize: 14 }}>
              No officer verification requests pending. All registered officers are reviewed.
            </p>
          )}

          <div className="stack" style={{ gap: 12 }}>
            {officersQ.data?.officers.map((u) => (
              <div key={u.id} className="card" style={{ background: 'var(--white)', padding: 14, border: '1px solid var(--line)' }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <h4 style={{ fontSize: 16, margin: 0 }}>{u.name}</h4>
                    <p className="mono muted" style={{ fontSize: 12 }}>{u.email}</p>
                  </div>
                  <span className="badge warn">Pending Review</span>
                </div>

                <div className="kv" style={{ fontSize: 13, marginBottom: 12 }}>
                  <dt>Department</dt>
                  <dd>{u.officer?.agency}</dd>
                  <dt>Unit / Station</dt>
                  <dd>{u.officer?.unit}</dd>
                  <dt>Rank</dt>
                  <dd>{u.officer?.rank || '—'}</dd>
                  <dt>Badge / ID</dt>
                  <dd className="mono">{u.officer?.badgeId}</dd>
                  <dt>Registered</dt>
                  <dd className="mono">{fmtDate(u.createdAt)}</dd>
                </div>

                <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--bad)' }}
                    onClick={() => verifyOfficer(u.id, false)}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn-dark btn-sm"
                    onClick={() => verifyOfficer(u.id, true)}
                  >
                    Approve Badge
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Users Tab */}
      {tab === 'users' && (
        <section className="card stack" style={{ gap: 16 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ fontSize: 18 }}>Registered accounts</h3>
            <input
              type="text"
              placeholder="Filter by name or email…"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              style={{ width: 260 }}
            />
          </div>

          <div className="table-scroll">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>Name & Email</th>
                  <th>Role</th>
                  <th>Registered</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersQ.data?.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{u.name}</div>
                      <div className="mono muted" style={{ fontSize: 11 }}>{u.email}</div>
                    </td>
                    <td>
                      <span className="chip" style={{ textTransform: 'capitalize' }}>
                        {u.isAdmin ? 'Admin' : u.accountType}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(u.createdAt)}</td>
                    <td>
                      {u.disabled ? <span className="badge bad">Disabled</span> : <span className="badge ok">Active</span>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => toggleUserDisabled(u.id, !u.disabled)}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Jobs Tab */}
      {tab === 'jobs' && (
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Pipeline background jobs</h3>
            <span className="mono muted" style={{ fontSize: 11 }}>Auto-refreshed</span>
          </div>

          <div className="table-scroll">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>Job ID & Type</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Last Update</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {jobsQ.data?.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <span className="mono" style={{ fontWeight: 600 }}>{j.type}</span>
                      <div className="mono muted" style={{ fontSize: 10 }}>{j.id}</div>
                      {j.error && <p className="err" style={{ fontSize: 11, margin: '2px 0 0' }}>{j.error}</p>}
                    </td>
                    <td>
                      <span className={`badge ${j.status === 'completed' || j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'signal'}`}>
                        {j.status}
                      </span>
                    </td>
                    <td className="mono">{j.attempts}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(j.updatedAt)}</td>
                    <td>
                      {j.status === 'failed' && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => retryJob(j.id)}>
                          Retry Job
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Usage Tab */}
      {tab === 'usage' && (
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Provider telemetry & Sarvam quotas</h3>
          </div>
          {usageQ.data?.usage && usageQ.data.usage.length > 0 ? (
            <div className="table-scroll">
              <table className="ev-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Provider</th>
                    <th>Total API Calls</th>
                    <th>Audio Seconds Transcribed</th>
                    <th>Characters Processed</th>
                  </tr>
                </thead>
                <tbody>
                  {usageQ.data.usage.map((row, i) => (
                    <tr key={i}>
                      <td className="mono">{row.day}</td>
                      <td><span className="chip">{row.provider}</span></td>
                      <td className="mono">{row.calls}</td>
                      <td className="mono">{row.audioSeconds}s</td>
                      <td className="mono">{row.chars}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 14 }}>No provider usage recorded in this window.</p>
          )}
        </section>
      )}

      {/* Health Tab */}
      {tab === 'health' && (() => { const h = healthQ.data; const sarvam = h?.ml.providers?.sarvam; return (
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Infrastructure health status</h3>
          </div>
          <div className="kv" style={{ fontSize: 14 }}>
            <dt>Database (MongoDB)</dt>
            <dd><span className={`badge ${h?.db === 'ok' ? 'ok' : 'bad'}`}>{h?.db ?? 'checking…'}</span></dd>
            <dt>GridFS evidence store</dt>
            <dd><span className={`badge ${h?.gridfs.status === 'ok' ? 'ok' : 'bad'}`}>{h ? `${h.gridfs.status} · ${h.gridfs.files} file${h.gridfs.files === 1 ? '' : 's'}` : 'checking…'}</span></dd>
            <dt>ML service</dt>
            <dd><span className={`badge ${h?.ml.status === 'ok' ? 'ok' : 'bad'}`}>{h?.ml.status ?? 'checking…'}</span></dd>
            <dt>Sarvam (speech, translation)</dt>
            <dd>{h && (
              <span className={`badge ${sarvam?.mock ? 'warn' : sarvam?.configured && sarvam.keyValid !== false ? 'ok' : 'warn'}`}>
                {sarvam?.mock ? 'mock mode' : !sarvam?.configured ? 'not configured — using local fallback' : sarvam.keyValid === false ? 'key rejected' : sarvam.reachable === false ? 'unreachable' : 'configured'}
              </span>
            )}</dd>
            <dt>LLM (summaries)</dt>
            <dd>{h && <span className={`badge ${h.ml.providers?.llm?.configured ? 'ok' : 'warn'}`}>{h.ml.providers?.llm?.configured ? `${h.ml.providers.llm.model} · ${h.ml.providers.llm.provider}` : 'not configured — offline fallback'}</span>}</dd>
            <dt>System1 (incident type)</dt>
            <dd>{h && <span className="mono muted" style={{ fontSize: 12 }}>{h.ml.models?.system1?.model ?? 'unknown'} · {h.ml.models?.system1?.loaded ? 'loaded' : 'loads on first use'}{h.ml.models?.system1?.hosted ? ' · HF token set' : ''}</span>}</dd>
            <dt>Search embeddings</dt>
            <dd>{h && <span className="mono muted" style={{ fontSize: 12 }}>{h.ml.models?.embeddings?.model ?? 'unknown'} · {h.ml.models?.embeddings?.loaded ? 'loaded' : 'loads on first use'}</span>}</dd>
            <dt>Investigation agents</dt>
            <dd>{h && <span className={`badge ${h.ml.agents?.enabled ? 'ok' : 'warn'}`}>{h.ml.agents?.enabled ? 'enabled' : `disabled${h.ml.agents?.error ? ` — ${h.ml.agents.error}` : ''}`}</span>}</dd>
            <dt>OCR / transcription tools</dt>
            <dd>{h && (
              <span className="mono muted" style={{ fontSize: 12 }}>
                OCR {h.ml.models?.ocr?.loaded ? 'loaded' : 'missing'} · tesseract {h.ml.tools?.tesseract ? 'found' : 'missing'} · ffmpeg {h.ml.tools?.ffmpeg ? 'found' : 'missing'}
              </span>
            )}</dd>
          </div>
          {healthQ.error && <p role="alert" className="err">{(healthQ.error as Error).message}</p>}
        </section>
      ); })()}
    </AppShell>
  );
}
