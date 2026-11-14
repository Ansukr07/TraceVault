import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDate, fmtMoney, useCase, useEvidence, type TEvent } from '../../lib/case';
import { CaseShell, Cites, Empty, PageLoading, SeverityTag, Stat } from '../../components';
import { AttentionCard, RiskCard } from '../../features';

type Overview = {
  counts: { evidence: number; processed: number; failed: number; people: number; events: number; inconsistencies: number; duplicates: number };
  status: string;
  progress: { type: string; evidenceId: string | null; status: string; progress: number; error: string | null }[];
  keyMoments: TEvent[];
  miniTimeline: { key: string; ts: string | null; severity: number; category: string }[];
  topEntities: { key: string; type: string; name: string; mentionCount: number }[];
  insights: { escalating: boolean; firstContact: { ts: string; sender: string } | null; peakHours: number[] } | null;
  summaryVersion: number | null;
  builtAt: string | null;
};

function MiniTimeline({ items }: { items: Overview['miniTimeline'] }) {
  const dated = items.filter((i) => i.ts).map((i) => ({ ...i, t: new Date(i.ts!).getTime() }));
  if (dated.length < 2) return null;
  const min = Math.min(...dated.map((d) => d.t));
  const max = Math.max(...dated.map((d) => d.t));
  const W = 1000;
  const x = (t: number) => 12 + ((t - min) / Math.max(1, max - min)) * (W - 24);
  const colors = ['var(--line-strong)', 'var(--warn)', 'var(--signal)', 'var(--bad)'];
  return (
    <svg viewBox={`0 0 ${W} 54`} width="100%" height="54" role="img" aria-label="Events over time, coloured by severity">
      <line x1="12" x2={W - 12} y1="27" y2="27" stroke="var(--line)" />
      {dated.map((d) => <circle key={d.key} cx={x(d.t)} cy={27 - d.severity * 5} r={4 + d.severity * 1.5} fill={colors[d.severity]} opacity="0.85" />)}
      <text x="12" y="52" className="axis" fontSize="10" fill="var(--muted)">{fmtDate(new Date(min).toISOString(), 'day')}</text>
      <text x={W - 12} y="52" textAnchor="end" fontSize="10" fill="var(--muted)">{fmtDate(new Date(max).toISOString(), 'day')}</text>
    </svg>
  );
}

export function OverviewPage() {
  const { id = '' } = useParams();
  const ov = useQuery({ queryKey: ['overview', id], queryFn: () => api<Overview>(`/cases/${id}/overview`), refetchInterval: (q) => (q.state.data?.status === 'processing' ? 4000 : false) });
  const ev = useEvidence(id);
  const role = useCase(id).data?.role;
  const d = ov.data;
  const names = new Map(ev.data?.map((e) => [e.id, e.sourceLabel || e.filename]));

  return (
    <CaseShell>
      {ov.isLoading && <PageLoading variant="cards" label="Loading case overview" />}
      {d && d.counts.evidence === 0 && (
        <Empty title="No evidence yet">
          Add chats, screenshots, voice notes, PDFs or emails. <Link to={`/cases/${id}/upload`}>Add evidence →</Link>
        </Empty>
      )}
      {d && d.counts.evidence > 0 && (
        <>
          <div className="stats">
            <Stat n={d.counts.evidence} label="Evidence items" />
            <Stat n={d.counts.people} label="People" />
            <Stat n={d.counts.events} label="Events" />
            <Stat n={d.counts.inconsistencies} label="Inconsistencies" tone={d.counts.inconsistencies ? 'signal' : ''} />
            <Stat n={d.counts.duplicates} label="Duplicates" />
          </div>

          {(d.status === 'processing' || d.progress.length > 0 || d.counts.failed > 0) && (
            <section className="card" aria-live="polite">
              <div className="card-title">
                <h2 style={{ fontSize: 18 }}>Processing</h2>
                <span className="mono muted">{d.counts.processed}/{d.counts.evidence} files</span>
              </div>
              <div className="progress"><i style={{ width: `${(d.counts.processed / Math.max(1, d.counts.evidence)) * 100}%` }} /></div>
              <ul className="list" style={{ marginTop: 12 }}>
                {d.progress.map((p, i) => (
                  <li key={i}>
                    <div className="row">
                      <span>{p.evidenceId ? names.get(p.evidenceId) ?? 'File' : 'Case analysis'} · <span className="mono muted">{p.type}</span></span>
                      <span className={`badge ${p.status === 'failed' ? 'bad' : 'signal'}`}>{p.status}{p.status === 'running' ? ` ${p.progress}%` : ''}</span>
                    </div>
                    {p.error && <p className="err">{p.error}</p>}
                  </li>
                ))}
              </ul>
              {d.counts.failed > 0 && <p className="err" style={{ marginTop: 8 }}>{d.counts.failed} file(s) failed to process. Open them in Evidence to retry.</p>}
            </section>
          )}

          {d.counts.processed > 0 && <RiskCard caseId={id} role={role} />}
          {d.counts.processed > 0 && <AttentionCard caseId={id} />}

          <section className="card">
            <div className="card-title"><h2 style={{ fontSize: 18 }}>Timeline at a glance</h2><Link to={`/cases/${id}/timeline`} className="btn-text">Open timeline →</Link></div>
            <MiniTimeline items={d.miniTimeline} />
          </section>

          <div className="grid-2">
            <section className="card">
              <div className="card-title"><h2 style={{ fontSize: 18 }}>Key moments</h2><span className="eyebrow">by severity × confidence</span></div>
              {d.keyMoments.length === 0 && <p className="muted">No harmful content detected yet.</p>}
              <ul className="list no-gt">
                {d.keyMoments.map((e) => (
                  <li key={e.key}>
                    <div className="row"><strong style={{ fontWeight: 500 }}>{e.title}</strong><SeverityTag score={e.severity} labels={e.labels} /></div>
                    <div className="meta">
                      <span className="mono">{fmtDate(e.ts, e.tsPrecision)}</span>
                      {e.amount ? <span className="chip">{fmtMoney(e.amount)}</span> : null}
                      {e.corroborationCount > 0 && <span className="chip">corroborated by {e.corroborationCount + 1} sources</span>}
                      <Cites ids={e.citations.slice(0, 3)} caseId={id} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="card">
              <div className="card-title"><h2 style={{ fontSize: 18 }}>Top people & identifiers</h2><Link to={`/cases/${id}/graph`} className="btn-text">Graph →</Link></div>
              <ul className="list no-gt">
                {d.topEntities.map((e) => (
                  <li key={e.key}>
                    <div className="row"><span>{e.name}</span><span className="mono muted" style={{ fontSize: 12 }}>{e.type.toLowerCase().replace('_', ' ')} · {e.mentionCount} mentions</span></div>
                  </li>
                ))}
              </ul>
              {d.insights && (
                <div className="meta" style={{ marginTop: 16, fontSize: 13 }}>
                  {d.insights.escalating && <span className="badge bad">Escalating</span>}
                  {d.insights.firstContact && <span>First contact {fmtDate(d.insights.firstContact.ts)} by {d.insights.firstContact.sender}</span>}
                  {d.insights.peakHours?.length > 0 && <span>Peak hours: {d.insights.peakHours.map((h) => `${h}:00`).join(', ')}</span>}
                </div>
              )}
            </section>
          </div>
          {d.builtAt && <p className="mono muted" style={{ fontSize: 11 }}>Analysis built {fmtDate(d.builtAt)}{d.summaryVersion ? ` · summary v${d.summaryVersion}` : ''}</p>}
        </>
      )}
    </CaseShell>
  );
}
