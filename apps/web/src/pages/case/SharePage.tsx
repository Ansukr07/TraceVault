import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, del, post } from '../../lib/api';
import { fmtDate, useEvidence } from '../../lib/case';
import { CaseShell } from '../../components';
import { DotGrid, PageHead } from '../../ui';

type ShareGrant = {
  id: string;
  recipientEmail: string;
  role: 'legal' | 'investigator' | 'collaborator';
  scope: { type: 'case' | 'evidence'; evidenceIds: string[] };
  allowDownload: boolean;
  createdAt: string;
  expiresAt: string;
  accepted: boolean;
  acceptedAt?: string;
  revoked: boolean;
  active: boolean;
  viewCount: number;
  lastViewedAt?: string;
  officerStatus?: string;
  statusAt?: string;
  firNumber?: string;
  recipient?: { name: string; officer?: { agency: string; unit: string; verified: boolean } };
  requests: { at: string; message: string }[];
};

export function SharePage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const ev = useEvidence(id);

  const q = useQuery({
    queryKey: ['shares', id],
    queryFn: () => api<{ grants: ShareGrant[] }>(`/cases/${id}/shares`),
  });

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'legal' | 'investigator' | 'collaborator'>('investigator');
  const [scopeType, setScopeType] = useState<'case' | 'evidence'>('case');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [allowDownload, setAllowDownload] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newInvite, setNewInvite] = useState<{ token: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setNewInvite(null);
    try {
      const res = await post<{ grant: ShareGrant; inviteToken: string; invitePath: string }>(`/cases/${id}/shares`, {
        email: email.trim(),
        role,
        scope: {
          type: scopeType,
          evidenceIds: scopeType === 'evidence' ? selectedIds : [],
        },
        expiresInDays: Number(expiresInDays),
        allowDownload,
      });

      const fullLink = `${window.location.origin}${res.invitePath}`;
      setNewInvite({ token: res.inviteToken, link: fullLink });
      setEmail('');
      setSelectedIds([]);
      qc.invalidateQueries({ queryKey: ['shares', id] });
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(gid: string) {
    if (!confirm('Are you sure you want to revoke this share grant? Access will be immediately cut off.')) return;
    try {
      await del(`/cases/${id}/shares/${gid}`);
      qc.invalidateQueries({ queryKey: ['shares', id] });
    } catch (ex) {
      alert((ex as Error).message);
    }
  }

  function toggleEvidence(eid: string) {
    setSelectedIds((prev) =>
      prev.includes(eid) ? prev.filter((x) => x !== eid) : [...prev, eid]
    );
  }

  function copyLink(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const grants = q.data?.grants ?? [];
  const evidenceList = ev.data ?? [];

  return (
    <CaseShell>
      <PageHead
        eyebrow="Controlled Sharing (PS 3.2 · H1–H5)"
        title={<>Authorised shares <span className="muted">& police coordination</span></>}
      />

      <div className="split" style={{ alignItems: 'start' }}>
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Grant scoped access</h3>
            <span className="mono muted" style={{ fontSize: 11 }}>Time-limited & Audited</span>
          </div>

          <form onSubmit={handleCreate} className="stack" style={{ gap: 14 }}>
            <label className="field">
              Recipient Email Address
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="officer@cybercrime.gov.in or advocate@chamber.in"
              />
            </label>

            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 6 }}>Authorised Role</legend>
              <div className="seg">
                <label>
                  <input
                    type="radio"
                    name="shareRole"
                    checked={role === 'investigator'}
                    onChange={() => setRole('investigator')}
                  />
                  <span>Investigating Officer (Police)</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="shareRole"
                    checked={role === 'legal'}
                    onChange={() => setRole('legal')}
                  />
                  <span>Legal Counsel / NGO</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="shareRole"
                    checked={role === 'collaborator'}
                    onChange={() => setRole('collaborator')}
                  />
                  <span>Trusted helper (Collaborator)</span>
                </label>
              </div>
              {role === 'collaborator' && (
                <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                  A friend or family member who can upload, annotate and tidy up this case with you. They can’t share, export or change privacy settings. Access lasts until you remove it.
                </p>
              )}
            </fieldset>

            {role !== 'collaborator' && (<>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ marginBottom: 6 }}>Scope of Evidence</legend>
              <div className="seg">
                <label>
                  <input
                    type="radio"
                    name="scopeType"
                    checked={scopeType === 'case'}
                    onChange={() => setScopeType('case')}
                  />
                  <span>Entire Case File</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="scopeType"
                    checked={scopeType === 'evidence'}
                    onChange={() => setScopeType('evidence')}
                  />
                  <span>Selected Files Only</span>
                </label>
              </div>
            </fieldset>

            {scopeType === 'evidence' && (
              <div className="card" style={{ background: 'var(--paper-2)', padding: 12, maxHeight: 180, overflowY: 'auto' }}>
                <p className="eyebrow" style={{ marginBottom: 6 }}>Pick evidence to include</p>
                {evidenceList.map((item) => (
                  <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '4px 0', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggleEvidence(item.id)}
                    />
                    <span>E{item.idx} · {item.sourceLabel || item.filename}</span>
                  </label>
                ))}
              </div>
            )}
            </>)}

            <div className="two-col" style={{ gap: 12 }}>
              <label className="field">
                {role === 'collaborator' ? 'Invite valid for' : 'Access expires in'}
                <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value))}>
                  <option value={7}>7 Days</option>
                  <option value={30}>30 Days</option>
                  <option value={90}>90 Days</option>
                  <option value={180}>180 Days</option>
                </select>
              </label>

              <label className="field" style={{ justifyContent: 'center', display: role === 'collaborator' ? 'none' : undefined }}>
                <span style={{ marginBottom: 4 }}>Downloads</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allowDownload}
                    onChange={(e) => setAllowDownload(e.target.checked)}
                  />
                  <span>Allow bundle export</span>
                </label>
              </label>
            </div>

            <div className="card" style={{ background: 'var(--white)', padding: 10, fontSize: 12, color: 'var(--muted)' }}>
              <strong>Plain-language guarantee:</strong>{' '}
              {role === 'collaborator'
                ? `${email || 'The recipient'} can open the invite for ${expiresInDays} days. Once they accept, they work on the whole case until you remove them. Their changes are stamped into your audit chain.`
                : <>{email || 'The recipient'} will see {scopeType === 'case' ? 'the full case' : `${selectedIds.length} chosen file(s)`} for {expiresInDays} days. Every view is watermarked with their identity and stamped into your audit chain.</>}
            </div>

            {err && <p role="alert" className="err">{err}</p>}

            <button className="btn btn-dark" style={{ height: 42 }} disabled={busy}>
              {busy ? 'Generating share grant…' : 'Create share link'}
            </button>
          </form>

          {newInvite && (
            <div className="card" style={{ background: '#e3efe8', border: '1px solid var(--ok)', padding: 14 }}>
              <p className="eyebrow" style={{ color: 'var(--ok)', marginBottom: 6 }}>Single-Use Invite Link Generated</p>
              <p className="mono" style={{ fontSize: 12, wordBreak: 'break-all', marginBottom: 8, background: 'var(--white)', padding: 8, borderRadius: 6 }}>
                {newInvite.link}
              </p>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyLink(newInvite.link)}>
                  {copied ? '✓ Copied' : 'Copy link'}
                </button>
                <span className="muted" style={{ fontSize: 11 }}>This secret token is never shown again.</span>
              </div>
            </div>
          )}
        </section>

        <section className="card stack" style={{ gap: 14 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Active & historical grants ({grants.length})</h3>
          </div>

          {q.isLoading && <p className="muted">Loading grants…</p>}

          {grants.length === 0 && !q.isLoading && (
            <p className="muted" style={{ fontSize: 14 }}>
              No shares yet. Share this case with an investigating officer or lawyer to allow secure, verifiable access.
            </p>
          )}

          <div className="stack" style={{ gap: 12 }}>
            {grants.map((g) => (
              <div
                key={g.id}
                className="card"
                style={{
                  background: g.active ? 'var(--white)' : 'var(--paper-2)',
                  opacity: g.revoked || !g.active ? 0.75 : 1,
                  padding: 14,
                  border: '1px solid var(--line)',
                }}
              >
                <div className="row" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{g.recipientEmail}</span>
                    {g.recipient?.officer && (
                      <p className="muted" style={{ fontSize: 12 }}>
                        {g.recipient.officer.agency} · {g.recipient.officer.unit}
                        {g.recipient.officer.verified ? ' (Verified Officer)' : ' (Unverified)'}
                      </p>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="chip" style={{ textTransform: 'capitalize' }}>{g.role}</span>
                    {g.revoked ? (
                      <span className="badge bad">Revoked</span>
                    ) : !g.active ? (
                      <span className="badge">Expired</span>
                    ) : g.accepted ? (
                      <span className="badge ok">Accepted</span>
                    ) : (
                      <span className="badge warn">Pending accept</span>
                    )}
                  </div>
                </div>

                <div className="kv" style={{ fontSize: 12, marginBottom: 8 }}>
                  <dt>Scope</dt>
                  <dd>{g.scope.type === 'case' ? 'Entire case' : `${g.scope.evidenceIds.length} files`}</dd>
                  <dt>Expires</dt>
                  <dd className="mono">{fmtDate(g.expiresAt)}</dd>
                  <dt>Activity</dt>
                  <dd>{g.viewCount} view(s){g.lastViewedAt ? ` · last ${fmtDate(g.lastViewedAt)}` : ''}</dd>
                  {g.officerStatus && g.role !== 'collaborator' && (
                    <>
                      <dt>Officer status</dt>
                      <dd>
                        <span className="badge" style={{ background: 'var(--paper-2)', textTransform: 'capitalize' }}>
                          {g.officerStatus.replace('_', ' ')}
                        </span>
                        {g.firNumber && <span className="mono" style={{ marginLeft: 6 }}>FIR: {g.firNumber}</span>}
                      </dd>
                    </>
                  )}
                </div>

                {g.requests && g.requests.length > 0 && (
                  <div style={{ background: '#fdf6e7', padding: 8, borderRadius: 6, marginBottom: 8, fontSize: 12 }}>
                    <strong>Officer requested more evidence:</strong>
                    {g.requests.map((r, i) => (
                      <p key={i} style={{ margin: '4px 0 0' }}>“{r.message}” <span className="muted mono">({fmtDate(r.at)})</span></p>
                    ))}
                  </div>
                )}

                {g.active && (
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ color: 'var(--bad)' }}
                      onClick={() => handleRevoke(g.id)}
                    >
                      Revoke access
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </CaseShell>
  );
}
