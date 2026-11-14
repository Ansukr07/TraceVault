import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/case';
import { AppShell, DotGrid, DotText, PageHead } from '../../ui';

type OfficerCaseRow = {
  grantId: string;
  caseId: string;
  title: string;
  incidentType: string;
  caseStatus: string;
  ownerName: string;
  role: string;
  evidenceCount: number;
  scopeType: string;
  sharedAt: string;
  expiresAt: string;
  active: boolean;
  officerStatus: string;
  firNumber?: string;
  lastViewedAt?: string;
  allowDownload: boolean;
};

type OfficerInboxResp = {
  cases: OfficerCaseRow[];
  stats: {
    newShares: number;
    underReview: number;
    expiringSoon: number;
    total: number;
  };
};

export function OfficerInboxPage() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['officerCases'],
    queryFn: () => api<OfficerInboxResp>('/officer/cases'),
  });

  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [search, setSearch] = useState('');

  const cases = q.data?.cases ?? [];
  const stats = q.data?.stats ?? { newShares: 0, underReview: 0, expiringSoon: 0, total: 0 };

  const filtered = cases.filter((c) => {
    if (filterStatus === 'active' && !c.active) return false;
    if (filterStatus === 'received' && c.officerStatus !== 'received') return false;
    if (filterStatus === 'under_review' && !['under_review', 'needs_evidence'].includes(c.officerStatus)) return false;
    if (filterStatus === 'fir_registered' && c.officerStatus !== 'fir_registered') return false;
    if (search) {
      const qLower = search.toLowerCase();
      return c.title.toLowerCase().includes(qLower) || (c.firNumber && c.firNumber.toLowerCase().includes(qLower));
    }
    return true;
  });

  const isUnverified = user?.accountType === 'officer' && !user?.officer?.verified;

  return (
    <AppShell>
      <PageHead
        eyebrow="Police & Legal Console (PS 3.2 · §7)"
        title={<>Officer inbox <span className="muted">& case workspace</span></>}
      />

      {isUnverified && (
        <div className="card" style={{ background: '#fdf6e7', border: '1px solid var(--warn)', padding: 14, marginBottom: 16 }}>
          <strong style={{ color: 'var(--warn)' }}>Pending Verification:</strong> Your police officer credentials are awaiting administrator review. You can review shared cases, but complainants will see your badge as unverified.
        </div>
      )}

      {/* Stats row */}
      <div className="stats" style={{ marginBottom: 20 }}>
        <div className="stat signal">
          <p className="dot stat-n">{stats.newShares}</p>
          <p className="eyebrow">New / Received</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{stats.underReview}</p>
          <p className="eyebrow">Under Review</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{stats.expiringSoon}</p>
          <p className="eyebrow">Expiring &lt; 7 Days</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{stats.total}</p>
          <p className="eyebrow">Total Shared Cases</p>
        </div>
      </div>

      <div className="card stack" style={{ gap: 16 }}>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="filters">
            <input
              type="text"
              placeholder="Search by case title or FIR…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 240 }}
            />
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="active">Active grants only</option>
              <option value="received">New / Received</option>
              <option value="under_review">Under review</option>
              <option value="fir_registered">FIR registered</option>
            </select>
          </div>
          <Link to="/officer/verify" className="btn btn-ghost btn-sm">
            Verify offline bundle →
          </Link>
        </div>

        {q.isLoading && <p className="muted">Loading assigned cases…</p>}

        {filtered.length === 0 && !q.isLoading && (
          <div className="card empty">
            <p className="dot" aria-hidden="true"><DotText>Inbox.</DotText></p>
            <h2 style={{ fontSize: 20 }}>No cases in this view</h2>
            <p className="muted" style={{ maxWidth: 380 }}>
              Cases appear here when a citizen or complainant shares a case file with your official email address.
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="table-scroll">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>Case Title & Incident</th>
                  <th>Shared By</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th>FIR / Ref</th>
                  <th>Access Expiry</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.grantId}>
                    <td>
                      <Link to={`/cases/${r.caseId}`} style={{ fontWeight: 600, color: 'var(--ink)' }}>
                        {r.title}
                      </Link>
                      <div style={{ marginTop: 4 }}>
                        <span className="chip">{r.incidentType}</span>
                        {!r.active && <span className="badge bad" style={{ marginLeft: 6 }}>Expired</span>}
                      </div>
                    </td>
                    <td>{r.ownerName}</td>
                    <td>
                      {r.scopeType === 'case' ? 'Full case' : `${r.evidenceCount} files`}
                    </td>
                    <td>
                      <span className="badge" style={{ background: 'var(--paper-2)', textTransform: 'capitalize' }}>
                        {r.officerStatus.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="mono">{r.firNumber || '—'}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{fmtDate(r.expiresAt)}</td>
                    <td>
                      <Link to={`/cases/${r.caseId}`} className="btn btn-ghost btn-sm">
                        Open File →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
