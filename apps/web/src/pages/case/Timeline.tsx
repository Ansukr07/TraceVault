import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, patch } from '../../lib/api';
import { fmtDate, fmtMoney, fmtMs, useEvidenceBlob, type TEvent } from '../../lib/case';
import { CaseShell, Cites, Empty, SeverityTag } from '../../components';

const SEV_COLOR = ['#b9b8b3', '#a86a12', '#e2603d', '#b5412a'];
const CATEGORIES = ['extortion', 'threat', 'sexual', 'abuse', 'financial_request', 'payment', 'meeting', 'contact'];

function AudioSnippet({ evidenceId, startMs, endMs }: { evidenceId: string; startMs: number; endMs: number }) {
  const blob = useEvidenceBlob(evidenceId);
  const ref = useRef<HTMLAudioElement>(null);
  const play = () => {
    const a = ref.current;
    if (!a) return;
    a.currentTime = startMs / 1000;
    a.play();
    const stop = () => { if (a.currentTime * 1000 >= endMs) { a.pause(); a.removeEventListener('timeupdate', stop); } };
    a.addEventListener('timeupdate', stop);
  };
  return (
    <div className="row" style={{ justifyContent: 'flex-start' }}>
      <button type="button" className="btn btn-dark btn-sm" onClick={play} disabled={!blob.data}>▶ Play {fmtMs(startMs)}–{fmtMs(endMs)}</button>
      {blob.data && <audio ref={ref} src={blob.data} preload="auto" />}
    </div>
  );
}

function EditEvent({ caseId, ev, onDone }: { caseId: string; ev: TEvent; onDone: () => void }) {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const ts = String(f.get('ts') || '');
      await patch(`/cases/${caseId}/events/${ev.key}`, {
        title: f.get('title'),
        category: f.get('category'),
        ...(ts ? { ts: ts.length === 16 ? `${ts}:00` : ts, tsPrecision: f.get('precision') } : {}),
      });
      qc.invalidateQueries({ queryKey: ['timeline', caseId] });
      onDone();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="stack" style={{ gap: 10 }}>
      <label className="field">Title<input name="title" defaultValue={ev.title} maxLength={300} /></label>
      <label className="field">When<input name="ts" type="datetime-local" defaultValue={ev.ts?.slice(0, 16)} /></label>
      <label className="field">Precision
        <select name="precision" defaultValue={ev.tsPrecision}><option value="exact">exact</option><option value="day">day</option><option value="approx">approximate</option></select>
      </label>
      <label className="field">Category
        <select name="category" defaultValue={ev.category}>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select>
      </label>
      {err && <p className="err">{err}</p>}
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button className="btn btn-dark btn-sm">Save (audited)</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function TimelinePage() {
  const { id = '' } = useParams();
  const [laneBy, setLaneBy] = useState<'source' | 'person'>('source');
  const [minSev, setMinSev] = useState(0);
  const [cat, setCat] = useState('');
  const [person, setPerson] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['timeline', id], queryFn: () => api<{ events: TEvent[]; people: { key: string; name: string; isOwner?: boolean }[] }>(`/cases/${id}/timeline`) });
  const names = useMemo(() => new Map(q.data?.people.map((p) => [p.key, p.name])), [q.data]);

  const events = useMemo(
    () =>
      (q.data?.events ?? []).filter(
        (e) =>
          e.severity >= minSev && (!cat || e.category === cat) && (!person || e.actors.includes(person) || e.targets.includes(person)) &&
          (!from || (e.ts ?? '') >= from) && (!to || (e.ts ?? '') <= `${to}T23:59:59`),
      ),
    [q.data, minSev, cat, person, from, to],
  );
  const dated = events.filter((e) => e.ts);
  const lanes = useMemo(() => {
    const key = (e: TEvent) =>
      e.sourceType === 'self_statement' ? 'Your account' : laneBy === 'source' ? e.lane : names.get(e.actors[0]) ?? 'Unknown';
    const order: string[] = [];
    dated.forEach((e) => { const k = key(e); if (!order.includes(k)) order.push(k); });
    order.sort((a, b) => (a === 'Your account' ? 1 : b === 'Your account' ? -1 : 0));
    return { order, key };
  }, [dated, laneBy, names]);

  const selected = events.find((e) => e.key === sel) ?? null;
  const t = dated.map((e) => new Date(e.ts!).getTime());
  const min = Math.min(...t);
  const max = Math.max(...t, min + 3600_000);
  const W = Math.max(900, dated.length * 26);
  const LANE_H = 54;
  const LEFT = 150;
  const x = (ms: number) => LEFT + ((ms - min) / (max - min)) * (W - LEFT - 30);
  const ticks = Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5);

  return (
    <CaseShell>
      {q.data && q.data.events.length === 0 && <Empty title="No events yet">Events appear once evidence is processed.</Empty>}
      {q.data && q.data.events.length > 0 && (
        <>
          <div className="filters">
            <div className="seg" role="radiogroup" aria-label="Lanes">
              {(['source', 'person'] as const).map((l) => (
                <label key={l}><input type="radio" name="lanes" checked={laneBy === l} onChange={() => setLaneBy(l)} /><span>by {l}</span></label>
              ))}
            </div>
            <select value={minSev} onChange={(e) => setMinSev(Number(e.target.value))} aria-label="Minimum severity">
              <option value={0}>All severities</option><option value={1}>Concerning+</option><option value={2}>Harmful+</option><option value={3}>Severe</option>
            </select>
            <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
              <option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
            </select>
            <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
              <option value="">Everyone</option>{q.data.people.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
          </div>
          <div className="legend">
            {['benign', 'concerning', 'harmful', 'severe'].map((s, i) => <span key={s} className={`sev-${i}`}><i />{s}</span>)}
            <span>▭ bar = approximate time</span>
          </div>

          {dated.length > 0 && (
            <div className="tl" role="figure" aria-label="Timeline">
              <svg width={W} height={lanes.order.length * LANE_H + 34}>
                {lanes.order.map((l, i) => (
                  <g key={l}>
                    <rect x={0} y={i * LANE_H} width={W} height={LANE_H} fill={i % 2 ? '#fbfbfa' : '#ffffff'} />
                    <text x={14} y={i * LANE_H + LANE_H / 2 + 4} className="lane-label">{l.length > 20 ? `${l.slice(0, 19)}…` : l}</text>
                  </g>
                ))}
                {ticks.map((tk, i) => (
                  <g key={i}>
                    <line x1={x(tk)} x2={x(tk)} y1={0} y2={lanes.order.length * LANE_H} stroke="#eeedea" />
                    <text x={x(tk)} y={lanes.order.length * LANE_H + 18} className="axis" textAnchor="middle">{new Date(tk).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</text>
                  </g>
                ))}
                {dated.map((e) => {
                  const lane = lanes.order.indexOf(lanes.key(e));
                  const cy = lane * LANE_H + LANE_H / 2;
                  const x0 = x(new Date(e.ts!).getTime());
                  const approx = e.tsPrecision !== 'exact' && e.tsEnd;
                  const x1 = approx ? Math.max(x0 + 10, x(new Date(e.tsEnd!).getTime())) : x0;
                  return (
                    <g key={e.key} className={`ev${sel === e.key ? ' on' : ''}`} onClick={() => { setSel(e.key); setEditing(false); }} tabIndex={0} role="button" aria-label={`${fmtDate(e.ts, e.tsPrecision)}: ${e.title}`} onKeyDown={(k) => k.key === 'Enter' && setSel(e.key)}>
                      <title>{`${fmtDate(e.ts, e.tsPrecision)} — ${e.title}`}</title>
                      {approx ? (
                        <rect x={x0} y={cy - 7} width={x1 - x0} height={14} rx={7} fill={SEV_COLOR[e.severity]} opacity={0.55} />
                      ) : (
                        <circle cx={x0} cy={cy} r={6 + e.severity * 1.5} fill={SEV_COLOR[e.severity]} />
                      )}
                      {e.corroborationCount > 0 && <circle cx={x0} cy={cy} r={12 + e.severity * 1.5} fill="none" stroke={SEV_COLOR[e.severity]} strokeDasharray="2 2" />}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}

          <div className="split">
            <ul className="ev-list" aria-label="Events in order">
              {events.map((e) => (
                <li key={e.key}>
                  <button type="button" className={`ev-item sev-${e.severity}${sel === e.key ? ' on' : ''}`} onClick={() => { setSel(e.key); setEditing(false); }}>
                    <span className="bar" />
                    <span>
                      <span className="mono muted" style={{ fontSize: 11 }}>{fmtDate(e.ts, e.tsPrecision)}{e.sourceType === 'self_statement' ? ' · your account' : ''}{e.userEdited ? ' · edited' : ''}</span>
                      <br />
                      <span style={{ fontWeight: 500 }}>{e.title}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <aside className="drawer">
              {!selected && <div className="card muted">Select an event to see its sources.</div>}
              {selected && (
                <section className="card stack" style={{ gap: 12 }}>
                  <div className="row"><span className="mono muted" style={{ fontSize: 12 }}>{fmtDate(selected.ts, selected.tsPrecision)}</span><SeverityTag score={selected.severity} labels={selected.labels} /></div>
                  <h3 style={{ fontSize: 20 }}>{selected.title}</h3>
                  {editing ? (
                    <EditEvent caseId={id} ev={selected} onDone={() => setEditing(false)} />
                  ) : (
                    <>
                      <p className="hl">{selected.description}</p>
                      {selected.descriptionEn && <p className="muted" style={{ fontSize: 13 }}>{selected.descriptionEn} <span className="mt-label">· machine translation</span></p>}
                      <dl className="kv">
                        <dt>category</dt><dd>{selected.category.replace('_', ' ')}</dd>
                        {selected.actors.length > 0 && <><dt>who</dt><dd>{selected.actors.map((a) => names.get(a) ?? a).join(', ')}</dd></>}
                        {selected.targets.length > 0 && <><dt>to</dt><dd>{selected.targets.map((a) => names.get(a) ?? a).join(', ')}</dd></>}
                        {selected.amount ? <><dt>amount</dt><dd>{fmtMoney(selected.amount)}</dd></> : null}
                        {selected.location && <><dt>place</dt><dd>{selected.location}</dd></>}
                        {selected.identifiers.length > 0 && <><dt>identifiers</dt><dd>{selected.identifiers.map((i) => i.split(':')[1]).join(', ')}</dd></>}
                        <dt>confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd>
                        <dt>corroboration</dt><dd>{selected.sourceType === 'self_statement' ? 'complainant’s own account (not corroboration)' : selected.corroborationCount > 0 ? `corroborated by ${selected.corroborationCount + 1} sources` : 'single source'}</dd>
                      </dl>
                      {selected.audio && <AudioSnippet evidenceId={selected.audio.evidenceId} startMs={selected.audio.startMs} endMs={selected.audio.endMs} />}
                      <div><span className="eyebrow">Sources</span> <Cites ids={selected.citations} caseId={id} /></div>
                      <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit event</button></div>
                    </>
                  )}
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </CaseShell>
  );
}
