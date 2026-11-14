import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/case';
import { AppShell, DotText, PageHead } from '../../ui';

type Row = {
  grantId: string; caseId: string; title: string; incidentType: string; ownerName: string; role: string; evidenceCount: number;
  scopeType: string; sharedAt: string; expiresAt: string; active: boolean; lastViewedAt?: string; allowDownload: boolean;
};
type Filter = 'active' | 'expired' | 'all';

const daysLeft = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

function Tile({ label, n, hint, live }: { label: string; n: number; hint: string; live?: boolean }) {
  return (
    <div className={`dash-tile${live ? ' live' : ''}`}>
      <p className="eyebrow">{label}</p>
      <p className="dot dash-n">{n}</p>
      <p className="dash-hint">{hint}</p>
    </div>
  );
}

/**
 * Legal role (spec §2): lawyer / NGO counsellor. Read-only, scoped access to cases a complainant shared,
 * expiring. They can annotate, explain inconsistencies and export the report inside the case.
 */
export function SharedWithMePage() {
  const q = useQuery({ queryKey: ['officerCases'], queryFn: () => api<{ cases: Row[] }>('/officer/cases') });
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');

  const rows = useMemo(() => (q.data?.cases ?? []).filter((r) => r.role === 'legal'), [q.data]);
  const active = rows.filter((r) => r.active);
  const soon = active.filter((r) => daysLeft(r.expiresAt) <= 7);
  const shown = rows
    .filter((r) => (filter === 'all' ? true : filter === 'active' ? r.active : !r.active))
    .filter((r) => !search.trim() || `${r.title} ${r.ownerName}`.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => +new Date(a.expiresAt) - +new Date(b.expiresAt));

  return (
    <AppShell>
      <PageHead eyebrow="Legal · shared with you" title={<>Cases shared with you <span className="muted">for a limited time</span></>} />

      <section className="dash-tiles" aria-label="Summary">
        <Tile label="Active shares" n={active.length} hint="You can open these now" />
        <Tile label="Expiring soon" n={soon.length} hint="Within 7 days" live={soon.length > 0} />
        <Tile label="Download allowed" n={active.filter((r) => r.allowDownload).length} hint="Report and bundle export" />
        <Tile label="All shares" n={rows.length} hint="Including expired" />
      </section>

      <section className="dash-panel" aria-label="Shared cases">
        <div className="dash-panel-head">
          <h2>Shared cases</h2>
          <span className="mono muted">{shown.length} of {rows.length}</span>
        </div>
        <div className="dash-toolbar">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by case or complainant" aria-label="Search shared cases" />
          <div className="seg" role="group" aria-label="Filter by access">
            {(['active', 'expired', 'all'] as Filter[]).map((f) => (
              <label key={f}><input type="radio" name="legal-filter" checked={filter === f} onChange={() => setFilter(f)} /><span>{f}</span></label>
            ))}
          </div>
        </div>

        {q.isLoading && <p className="muted dash-empty">Loading…</p>}
        {q.error && <p role="alert" className="err">{(q.error as Error).message}</p>}
        {q.data && rows.length === 0 && (
          <div className="dash-empty">
            <p className="dot" aria-hidden="true"><DotText>Nothing yet.</DotText></p>
            <h3>No cases shared with you</h3>
            <p className="muted" style={{ maxWidth: 380 }}>When a complainant shares a case with your email address, open their invite link and it appears here. Access is scoped and expires.</p>
          </div>
        )}
        {q.data && rows.length > 0 && shown.length === 0 && <p className="muted dash-empty">No cases match.</p>}

        {shown.length > 0 && (
          <ul className="dash-rows">
            <li className="dash-row dash-row-head legal-row" aria-hidden="true"><span>Case</span><span>Access</span><span>Scope</span><span>Last viewed</span><span /></li>
            {shown.map((r) => {
              const d = daysLeft(r.expiresAt);
              return (
                <li key={r.grantId}>
                  <Link to={r.active ? `/cases/${r.caseId}` : '#'} className="dash-row legal-row" aria-disabled={!r.active} onClick={(e) => { if (!r.active) e.preventDefault(); }}>
                    <span className="dash-case">
                      <strong>{r.title}</strong>
                      <span className="meta"><span className="chip">{r.incidentType}</span><span className="muted" style={{ fontSize: 13 }}>from {r.ownerName}</span></span>
                    </span>
                    <span>
                      {r.active
                        ? <span className={`badge ${d <= 7 ? 'warn' : 'ok'}`}>{d <= 0 ? 'ends today' : `${d} day${d === 1 ? '' : 's'} left`}</span>
                        : <span className="badge">expired</span>}
                      <span className="mono muted" style={{ display: 'block', marginTop: 6 }}>until {fmtDate(r.expiresAt)}</span>
                    </span>
                    <span className="mono">{r.scopeType === 'evidence' ? `${r.evidenceCount} files` : `Whole case · ${r.evidenceCount}`}{r.allowDownload ? ' · ↓' : ''}</span>
                    <span className="mono muted">{r.lastViewedAt ? fmtDate(r.lastViewedAt) : 'Never'}</span>
                    <span className="dash-go" aria-hidden="true">{r.active ? '→' : ''}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>Every time you open a shared case it is logged and visible to the complainant. You can read, annotate and explain inconsistencies; you cannot change or delete evidence.</p>
      </section>
    </AppShell>
  );
}
