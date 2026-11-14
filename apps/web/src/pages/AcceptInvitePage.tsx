import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/case';
import { DotText, LogoMark, Nav } from '../ui';

type PreviewResp = {
  state: 'valid' | 'expired' | 'revoked' | 'accepted';
  role: 'investigator' | 'legal';
  expiresAt: string;
  allowDownload: boolean;
  scope: { type: 'case' | 'evidence'; count: number };
  recipientEmailMasked: string;
  owner?: string;
  case?: { title: string; incidentType: string } | null;
};

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const { user } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ['sharePreview', token],
    queryFn: () => api<PreviewResp>(`/share/preview?token=${encodeURIComponent(token)}`),
    enabled: token.length > 20,
    retry: false,
  });

  async function handleAccept() {
    if (!token) return;
    setBusy(true);
    setErr('');
    try {
      const res = await post<{ caseId: string; role: string; expiresAt: string }>('/share/accept', { token });
      if (res.role === 'investigator' || res.role === 'legal') {
        nav(`/cases/${res.caseId}`);
      } else {
        nav(`/cases/${res.caseId}`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const p = q.data;

  return (
    <>
      <Nav />
      <main className="auth">
        <div className="auth-card">
          <p className="dot" aria-hidden="true"><DotText>Shared.</DotText></p>
          <div className="card">
            <p className="eyebrow" style={{ marginBottom: 10 }}>Evidence File Invite</p>
            <h1 style={{ fontSize: 24, marginBottom: 8 }}>Case access invitation</h1>

            {!token || token.length < 20 ? (
              <div className="stack" style={{ gap: 12 }}>
                <p className="err">Invalid or missing invite link token.</p>
                <Link to="/login" className="btn btn-ghost">Go to Login</Link>
              </div>
            ) : q.isLoading ? (
              <p className="muted">Validating invite token…</p>
            ) : q.error ? (
              <div className="stack" style={{ gap: 12 }}>
                <p className="err">{(q.error as Error).message || 'This invite is not valid.'}</p>
                <Link to="/login" className="btn btn-ghost">Sign in to check cases</Link>
              </div>
            ) : p?.state !== 'valid' ? (
              <div className="stack" style={{ gap: 12 }}>
                <p className="badge bad" style={{ alignSelf: 'flex-start' }}>
                  {p?.state === 'expired' ? 'Invite expired' : p?.state === 'revoked' ? 'Invite revoked by owner' : 'Invite already used'}
                </p>
                <p className="muted" style={{ fontSize: 14 }}>
                  This invitation link is no longer active. Contact the complainant to request a new share link.
                </p>
                <Link to="/" className="btn btn-ghost">Home</Link>
              </div>
            ) : (
              <div className="stack" style={{ gap: 16 }}>
                <div style={{ background: 'var(--paper-2)', padding: 14, borderRadius: 'var(--r-md)' }}>
                  <p className="eyebrow" style={{ marginBottom: 4 }}>Case</p>
                  <p style={{ fontWeight: 600, fontSize: 16, marginBottom: 2 }}>{p.case?.title}</p>
                  <p className="muted" style={{ fontSize: 12 }}>Type: {p.case?.incidentType} · Shared by {p.owner ?? 'Complainant'}</p>
                </div>

                <div className="kv" style={{ fontSize: 13 }}>
                  <dt>Role granted</dt>
                  <dd><span className="chip" style={{ textTransform: 'capitalize' }}>{p.role}</span></dd>
                  <dt>Scope</dt>
                  <dd>{p.scope.type === 'case' ? 'Entire case file' : `${p.scope.count} specific evidence item(s)`}</dd>
                  <dt>Access expires</dt>
                  <dd className="mono">{fmtDate(p.expiresAt)}</dd>
                  <dt>Downloads</dt>
                  <dd>{p.allowDownload ? 'Allowed' : 'View only (downloads disabled)'}</dd>
                  <dt>Invited recipient</dt>
                  <dd className="mono">{p.recipientEmailMasked}</dd>
                </div>

                <p className="muted" style={{ fontSize: 12 }}>
                  Every view and action in this case is recorded in the cryptographically chained audit log.
                </p>

                {err && <p role="alert" className="err">{err}</p>}

                {user ? (
                  <button type="button" className="btn btn-dark" style={{ height: 46 }} onClick={handleAccept} disabled={busy}>
                    {busy ? 'Accepting…' : 'Accept case invitation'}
                  </button>
                ) : (
                  <div className="stack" style={{ gap: 8 }}>
                    <p className="badge warn" style={{ alignSelf: 'flex-start' }}>Sign in required</p>
                    <p className="muted" style={{ fontSize: 13 }}>
                      You must sign in with the email address ({p.recipientEmailMasked}) this invitation was addressed to.
                    </p>
                    <Link
                      to={`/login?next=${encodeURIComponent(`/share/accept?token=${token}`)}`}
                      className="btn btn-dark"
                      style={{ height: 44, justifyContent: 'center' }}
                    >
                      Sign in to accept
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
