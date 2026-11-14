import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import cytoscape, { type Core } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { api, post } from '../../lib/api';
import { fmtDate } from '../../lib/case';
import { CaseShell, Cites, Empty } from '../../components';

cytoscape.use(fcose);

type GNode = { id: string; type: string; label: string; mentions: number; isOwner?: boolean; community?: number | null; muleCluster?: boolean; centrality?: number; betweenness?: number; kind?: string; evidenceId?: string };
type GEdge = { id: string; type: string; source: string; target: string; count: number; firstTs: string | null; lastTs: string | null; citations: string[]; score?: number; reason?: string; label?: string; amount?: number };
type Graph = { nodes: GNode[]; edges: GEdge[]; centralFigures: string[]; timeRange: [string, string] | null };

const COMMUNITY = ['#6b5bd6', '#2f6fb0', '#2f7a55', '#a86a12', '#b5412a', '#7a4f9a', '#3a8f8f'];
const TYPE_SHAPE: Record<string, string> = { PERSON: 'ellipse', UPI_ID: 'round-rectangle', BANK_ACCT: 'round-rectangle', PHONE: 'round-diamond', EMAIL: 'round-diamond', HANDLE: 'round-diamond', LOCATION: 'round-triangle', ORG: 'round-hexagon', EVIDENCE: 'round-rectangle' };
const EDGE_COLOR: Record<string, string> = { MESSAGED: '#8e8d89', THREATENED: '#b5412a', PAID: '#2f7a55', APPEARS_WITH: '#b9b8b3', MENTIONED_IN: '#d6d5d1', SAME_AS_CANDIDATE: '#e2603d', CALLED: '#2f6fb0' };

export function GraphPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['graph', id], queryFn: () => api<{ graph: Graph }>(`/cases/${id}/graph`).then((r) => r.graph) });
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [sel, setSel] = useState<{ kind: 'node'; n: GNode } | { kind: 'edge'; e: GEdge } | null>(null);
  const [slider, setSlider] = useState(100);
  const g = q.data;

  const range = useMemo(() => (g?.timeRange ? g.timeRange.map((t) => new Date(t).getTime()) : null), [g]);
  const cutoff = range ? range[0] + ((range[1] - range[0]) * slider) / 100 : null;

  useEffect(() => {
    if (!g || !box.current) return;
    const nodes = g.nodes.filter((n) => showEvidence || n.type !== 'EVIDENCE');
    const ids = new Set(nodes.map((n) => n.id));
    const maxM = Math.max(1, ...nodes.map((n) => n.mentions));
    const c = cytoscape({
      container: box.current,
      elements: [
        ...nodes.map((n) => ({
          data: {
            ...n, id: n.id, label: n.label,
            size: n.type === 'EVIDENCE' ? 26 : 26 + 34 * Math.sqrt(n.mentions / maxM) + 40 * (n.centrality ?? 0),
            color: n.isOwner ? '#0d0d0d' : n.type === 'EVIDENCE' ? '#d6d5d1' : n.community != null ? COMMUNITY[n.community % COMMUNITY.length] : '#8e8d89',
            shape: TYPE_SHAPE[n.type] ?? 'ellipse',
            border: n.muleCluster && ['UPI_ID', 'BANK_ACCT'].includes(n.type) ? 4 : 0,
          },
        })),
        ...g.edges
          .filter((e) => ids.has(e.source) && ids.has(e.target))
          .map((e) => ({ data: { ...e, color: EDGE_COLOR[e.type] ?? '#b9b8b3', width: Math.min(8, 1.5 + Math.log2(1 + e.count)), dashed: e.type === 'SAME_AS_CANDIDATE' ? 'dashed' : 'solid', elabel: e.type === 'PAID' ? `paid` : e.type === 'THREATENED' ? 'threatened' : '' } })),
      ],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', width: 'data(size)', height: 'data(size)', shape: 'data(shape)' as any, 'font-size': 11, 'font-family': 'Geist, system-ui, sans-serif', color: '#0d0d0d', 'text-valign': 'bottom', 'text-margin-y': 6, 'text-wrap': 'ellipsis', 'text-max-width': '140px', 'border-width': 'data(border)', 'border-color': '#b5412a' } },
        { selector: 'edge', style: { 'line-color': 'data(color)', width: 'data(width)', 'curve-style': 'bezier', 'target-arrow-shape': 'triangle', 'target-arrow-color': 'data(color)', 'line-style': 'data(dashed)' as any, label: 'data(elabel)', 'font-size': 9, color: '#8e8d89', 'text-rotation': 'autorotate' } },
        { selector: 'edge[type = "MENTIONED_IN"], edge[type = "APPEARS_WITH"], edge[type = "SAME_AS_CANDIDATE"]', style: { 'target-arrow-shape': 'none' } },
        { selector: ':selected', style: { 'overlay-color': '#e2603d', 'overlay-opacity': 0.18, 'overlay-padding': 6 } },
        { selector: '.faded', style: { opacity: 0.12 } },
      ],
      layout: { name: 'fcose', animate: false, randomize: true, nodeRepulsion: 9000, idealEdgeLength: 110, nodeSeparation: 80 } as any,
      wheelSensitivity: 0.3,
    });
    c.on('tap', 'node', (ev) => setSel({ kind: 'node', n: ev.target.data() }));
    c.on('tap', 'edge', (ev) => setSel({ kind: 'edge', e: ev.target.data() }));
    c.on('tap', (ev) => { if (ev.target === c) setSel(null); });
    cy.current = c;
    return () => { c.destroy(); cy.current = null; };
  }, [g, showEvidence]);

  // G3: time slider hides edges that start after the cutoff.
  useEffect(() => {
    const c = cy.current;
    if (!c || cutoff == null) return;
    c.edges().forEach((e) => {
      const first = e.data('firstTs');
      e.toggleClass('faded', !!first && new Date(first).getTime() > cutoff);
    });
  }, [cutoff, g, showEvidence]);

  async function decide(kind: 'merge' | 'split', a: string, b: string) {
    await post(`/cases/${id}/entities/${kind}`, { a, b });
    setSel(null);
    setTimeout(() => qc.invalidateQueries({ queryKey: ['graph', id] }), 2500);
  }

  if (q.isLoading) return <CaseShell><p className="muted">Loading…</p></CaseShell>;
  if (!g || g.nodes.length === 0) return <CaseShell><Empty title="No graph yet">The graph appears once people and identifiers are found in the evidence.</Empty></CaseShell>;
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const connected = sel?.kind === 'node' ? g.edges.filter((e) => e.source === sel.n.id || e.target === sel.n.id) : [];
  const candidates = g.edges.filter((e) => e.type === 'SAME_AS_CANDIDATE');

  return (
    <CaseShell>
      <div className="filters">
        <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={showEvidence} onChange={(e) => setShowEvidence(e.target.checked)} /> Evidence layer</label>
        {range && (
          <label className="row" style={{ gap: 8, fontSize: 13 }}>
            Up to <input type="range" min={0} max={100} value={slider} onChange={(e) => setSlider(Number(e.target.value))} aria-label="Time slider" style={{ width: 180 }} />
            <span className="mono">{fmtDate(new Date(cutoff!).toISOString(), 'day')}</span>
          </label>
        )}
        {g.centralFigures.length > 0 && <span className="muted" style={{ fontSize: 13 }}>Central figures: {g.centralFigures.map((k) => nodeById.get(k)?.label).join(', ')}</span>}
      </div>
      <div className="split" style={{ gridTemplateColumns: undefined }}>
        <div className="graph-box"><div className="cy" ref={box} aria-label="Relationship graph" role="img" /></div>
        <aside className="stack">
          {!sel && (
            <section className="card">
              <h3 style={{ marginBottom: 10 }}>How to read this</h3>
              <ul className="muted" style={{ fontSize: 13, paddingLeft: 18, display: 'grid', gap: 4 }}>
                <li>Size = mentions and centrality. Colour = community.</li>
                <li>Red border = UPI / account in a money-mule cluster.</li>
                <li>Red line = threatened · green = paid · dashed orange = possibly the same person.</li>
                <li>Click any node or line for the messages behind it.</li>
              </ul>
            </section>
          )}
          {sel?.kind === 'node' && (
            <section className="card stack" style={{ gap: 10 }}>
              <p className="eyebrow">{sel.n.type.replace('_', ' ')}{sel.n.isOwner ? ' · complainant' : ''}</p>
              <h3 style={{ fontSize: 20 }}>{sel.n.label}</h3>
              <p className="muted" style={{ fontSize: 13 }}>{sel.n.mentions} mentions{sel.n.muleCluster ? ' · in a cluster with several payment identifiers' : ''}</p>
              <ul className="list">
                {connected.filter((e) => e.type !== 'MENTIONED_IN').slice(0, 12).map((e) => {
                  const other = nodeById.get(e.source === sel.n.id ? e.target : e.source);
                  return (
                    <li key={e.id}>
                      <div className="row"><span>{e.type.replace(/_/g, ' ').toLowerCase()} {e.source === sel.n.id ? '→' : '←'} {other?.label}</span><span className="mono muted">{e.count}×</span></div>
                      {e.citations.length > 0 && <Cites ids={e.citations.slice(0, 6)} caseId={id} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {sel?.kind === 'edge' && (
            <section className="card stack" style={{ gap: 10 }}>
              <p className="eyebrow">{sel.e.type.replace(/_/g, ' ')}</p>
              <h3 style={{ fontSize: 18 }}>{nodeById.get(sel.e.source)?.label} → {nodeById.get(sel.e.target)?.label}</h3>
              <p className="muted" style={{ fontSize: 13 }}>{sel.e.count} time(s){sel.e.firstTs ? ` · ${fmtDate(sel.e.firstTs, 'day')} – ${fmtDate(sel.e.lastTs, 'day')}` : ''}{sel.e.reason ? ` · ${sel.e.reason}` : ''}</p>
              {sel.e.citations.length > 0 && <div><span className="eyebrow">Messages</span> <Cites ids={sel.e.citations} caseId={id} /></div>}
              {sel.e.type === 'SAME_AS_CANDIDATE' && (
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  <button type="button" className="btn btn-dark btn-sm" onClick={() => decide('merge', sel.e.source, sel.e.target)}>Same person — merge</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide('split', sel.e.source, sel.e.target)}>Different people</button>
                </div>
              )}
            </section>
          )}
          {candidates.length > 0 && (
            <section className="card">
              <h3 style={{ marginBottom: 8 }}>Possible matches ({candidates.length})</h3>
              <ul className="list">
                {candidates.map((e) => (
                  <li key={e.id}>
                    <span>{nodeById.get(e.source)?.label} ≟ {nodeById.get(e.target)?.label} <span className="mono muted">{Math.round((e.score ?? 0) * 100)}%</span></span>
                    <span className="muted" style={{ fontSize: 12 }}>{e.reason}</span>
                    <div className="row" style={{ justifyContent: 'flex-start' }}>
                      <button type="button" className="btn btn-dark btn-sm" onClick={() => decide('merge', e.source, e.target)}>Merge</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide('split', e.source, e.target)}>Not the same</button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </CaseShell>
  );
}
