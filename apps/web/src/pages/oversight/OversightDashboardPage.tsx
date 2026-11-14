import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { AppShell, PageHead } from '../../ui';

type OversightCell = { n: number | null; suppressed: boolean };

type OversightResp = {
  minCell: number;
  generatedAt: string;
  tiles: {
    shared: OversightCell;
    medianHoursToAccept: number | null;
    medianHoursToFir: number | null;
    verificationsRun: OversightCell;
    expiredWithoutAction: OversightCell;
  };
  funnel: { label: string; n: number | null; suppressed: boolean }[];
  months: {
    month: string;
    total: OversightCell;
    byType: Record<string, OversightCell>;
  }[];
  types: string[];
  units: {
    unit: string;
    officers: OversightCell;
    shares: OversightCell;
    open: OversightCell;
    overdue: OversightCell;
    medianHoursToAccept: number | null;
  }[];
};

function formatCell(c?: OversightCell, suffix = '') {
  if (!c) return '—';
  if (c.suppressed) return '<5';
  return `${c.n ?? 0}${suffix}`;
}

export function OversightDashboardPage() {
  const [filterType, setFilterType] = useState<string>('');
  const [filterUnit, setFilterUnit] = useState<string>('');

  const queryParams = new URLSearchParams();
  if (filterType) queryParams.set('type', filterType);
  if (filterUnit) queryParams.set('unit', filterUnit);

  const q = useQuery({
    queryKey: ['oversight', filterType, filterUnit],
    queryFn: () => api<OversightResp>(`/oversight/summary?${queryParams.toString()}`),
  });

  const d = q.data;

  return (
    <AppShell>
      <PageHead
        eyebrow="Government Oversight Dashboard (PS 3.2 · §8)"
        title={<>Department analytics <span className="muted">& enforcement statistics</span></>}
      />

      <div className="card" style={{ background: '#f8f8f6', padding: 14, marginBottom: 16 }}>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          <strong>Privacy Guarantee:</strong> Government supervisory officials see aggregates only. No individual case files, victim names, or evidence content can ever be accessed from this dashboard. Small counts (&lt;5) are suppressed to prevent re-identification.
        </p>
      </div>

      {/* Stat tiles */}
      <div className="stats" style={{ marginBottom: 20 }}>
        <div className="stat">
          <p className="dot stat-n">{formatCell(d?.tiles.shared)}</p>
          <p className="eyebrow">Cases Shared with Police</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{d?.tiles.medianHoursToAccept != null ? `${d.tiles.medianHoursToAccept}h` : '—'}</p>
          <p className="eyebrow">Median Hours to Accept</p>
        </div>
        <div className="stat signal">
          <p className="dot stat-n">{d?.tiles.medianHoursToFir != null ? `${d.tiles.medianHoursToFir}h` : '—'}</p>
          <p className="eyebrow">Median Hours to FIR</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{formatCell(d?.tiles.verificationsRun)}</p>
          <p className="eyebrow">Integrity Checks Run</p>
        </div>
        <div className="stat">
          <p className="dot stat-n">{formatCell(d?.tiles.expiredWithoutAction)}</p>
          <p className="eyebrow">Expired Without Action</p>
        </div>
      </div>

      <div className="split" style={{ alignItems: 'start', marginBottom: 20 }}>
        {/* Funnel Card */}
        <section className="card stack" style={{ gap: 14 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Case enforcement progression</h3>
            <span className="mono muted" style={{ fontSize: 11 }}>Status Funnel</span>
          </div>
          <div className="stack" style={{ gap: 10 }}>
            {d?.funnel.map((step) => (
              <div key={step.label} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 50px', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{step.label}</span>
                <div style={{ background: 'var(--paper-2)', height: 12, borderRadius: 6, overflow: 'hidden' }}>
                  <div
                    style={{
                      background: step.label === 'FIR registered' ? 'var(--signal)' : 'var(--ink)',
                      height: '100%',
                      width: step.suppressed ? '20%' : `${Math.min(100, Math.max(8, (step.n ?? 0) * 20))}%`,
                    }}
                  />
                </div>
                <span className="mono" style={{ fontSize: 13, textAlign: 'right' }}>
                  {formatCell(step)}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Breakdown by Incident */}
        <section className="card stack" style={{ gap: 14 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Breakdown by incident category</h3>
          </div>
          {d?.types && d.types.length > 0 ? (
            <div className="stack" style={{ gap: 8 }}>
              {d.types.map((t) => (
                <div key={t} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <span className="chip" style={{ textTransform: 'capitalize' }}>{t}</span>
                  <span className="mono" style={{ fontSize: 13 }}>Recorded in jurisdiction</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>No categorized incident data yet.</p>
          )}
        </section>
      </div>

      {/* Station / Unit Performance Table */}
      <section className="card stack" style={{ gap: 16 }}>
        <div className="card-title">
          <h3 style={{ fontSize: 18 }}>Station & unit performance metrics</h3>
          <span className="mono muted" style={{ fontSize: 11 }}>Aggregated units</span>
        </div>

        {d?.units && d.units.length > 0 ? (
          <div className="table-scroll">
            <table className="ev-table">
              <thead>
                <tr>
                  <th>Police Station / Unit</th>
                  <th>Verified Officers</th>
                  <th>Total Shares</th>
                  <th>Open Inquiries</th>
                  <th>Overdue (&gt;3d)</th>
                  <th>Median Response</th>
                </tr>
              </thead>
              <tbody>
                {d.units.map((u) => (
                  <tr key={u.unit}>
                    <td style={{ fontWeight: 600 }}>{u.unit}</td>
                    <td className="mono">{formatCell(u.officers)}</td>
                    <td className="mono">{formatCell(u.shares)}</td>
                    <td className="mono">{formatCell(u.open)}</td>
                    <td>
                      <span className={`mono ${u.overdue?.n && u.overdue.n > 0 ? 'badge bad' : ''}`}>
                        {formatCell(u.overdue)}
                      </span>
                    </td>
                    <td className="mono">
                      {u.medianHoursToAccept != null ? `${u.medianHoursToAccept} hrs` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 14 }}>No unit statistics reported yet.</p>
        )}
      </section>
    </AppShell>
  );
}
