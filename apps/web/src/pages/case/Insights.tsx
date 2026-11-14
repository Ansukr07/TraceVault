import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDate } from '../../lib/case';
import { CaseShell, CitationChip, Empty, PageLoading } from '../../components';

type Insights = {
  escalation: { week: string; messages: number; avgSeverity: number; maxSeverity: number; severe: number }[];
  escalationSlope: number | null; escalating: boolean; heatmap: number[][]; peakHours: number[];
  firstContact: { ts: string; chunkId: string; sender: string } | null;
  responseGaps: { from: string; to: string; hours: number; afterChunkId: string; beforeChunkId: string }[]; messageCount: number;
};
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function InsightsPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['insights', id], queryFn: () => api<{ insights: Insights | null }>(`/cases/${id}/insights`).then((r) => r.insights) });
  const d = q.data;
  if (q.isLoading) return <CaseShell><PageLoading variant="cards" label="Loading insights" /></CaseShell>;
  if (!d || d.messageCount === 0) return <CaseShell><Empty title="Not enough messages yet">Patterns appear once chats or screenshots with timestamps are processed.</Empty></CaseShell>;
  const maxHeat = Math.max(1, ...d.heatmap.flat());
  const maxSev = 3;
  return (
    <CaseShell>
      <div className="grid-2">
        <section className="card">
          <div className="card-title"><h2 style={{ fontSize: 18 }}>Escalation by week</h2>{d.escalating ? <span className="badge bad">Escalating</span> : <span className="badge">Stable</span>}</div>
          <div className="bars" role="img" aria-label="Average severity of messages from others, per week">
            {d.escalation.map((w) => (
              <div key={w.week} title={`${w.week}: ${w.messages} messages, avg severity ${w.avgSeverity}, ${w.severe} harmful`}>
                <i className={`sev-${Math.round(w.avgSeverity)}`} style={{ height: `${(w.avgSeverity / maxSev) * 100}%` }} />
                <span>{w.week.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Average severity of messages from others (0 benign – 3 severe).</p>
        </section>
        <section className="card stack" style={{ gap: 14 }}>
          <h2 style={{ fontSize: 18 }}>Key facts</h2>
          {d.firstContact && <p>First contact: <strong>{d.firstContact.sender}</strong> on {fmtDate(d.firstContact.ts)} <CitationChip id={d.firstContact.chunkId} caseId={id} /></p>}
          <p>Peak hours: {d.peakHours.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}</p>
          <p>{d.messageCount} timestamped messages analysed.</p>
          {d.responseGaps.length > 0 && (
            <div>
              <p className="eyebrow" style={{ marginBottom: 6 }}>Longest silences</p>
              <ul className="list">
                {d.responseGaps.map((g, i) => (
                  <li key={i}><span>{g.hours} h — from {fmtDate(g.from)} <CitationChip id={g.afterChunkId} caseId={id} /> to {fmtDate(g.to)} <CitationChip id={g.beforeChunkId} caseId={id} /></span></li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
      <section className="card">
        <h2 style={{ fontSize: 18, marginBottom: 12 }}>When messages arrive (day × hour)</h2>
        <div className="table-scroll">
          <div className="heat" role="img" aria-label="Message frequency heatmap">
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ textAlign: 'center' }}>{h % 3 === 0 ? h : ''}</span>)}
            {d.heatmap.map((row, di) => [
              <span key={`d${di}`}>{DAYS[di]}</span>,
              ...row.map((v, h) => <span key={`${di}-${h}`} className="c" title={`${DAYS[di]} ${h}:00 — ${v} messages`} style={v ? { background: `rgba(226, 96, 61, ${0.15 + 0.85 * (v / maxHeat)})` } : undefined} />),
            ])}
          </div>
        </div>
      </section>
    </CaseShell>
  );
}
