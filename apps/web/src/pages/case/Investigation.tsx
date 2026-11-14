import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../../lib/api';
import { fmtDate, useCase } from '../../lib/case';
import { CaseShell, CitationChip, Cites, Empty, PageLoading, Stat } from '../../components';

type Incident = { labels: string[]; scores: Record<string, number>; primary: string; confidence: number; needsOwnerReview: boolean; provider: string; warnings: string[] };
type Flag = { code: string; agent: string | null; message: string };
type PlanStep = { step: number; agent: string; purpose: string };
type Investigation = {
  objective: string;
  plan: { plan: PlanStep[]; selectedAgents: string[]; incidentLabels: string[] };
  results: Record<string, any>;
  system1: Incident | null;
  system1Review: { status: string; flags: Flag[]; declaredLabels?: string[] } | null;
  counts: { evidence: number; chunks: number; events: number };
  durationMs: number;
  ranAt: string;
  scoped: boolean;
};
type Hit = { chunkId: string; textEn: string; sourceText: string; score: number | null };

const LABEL_NAMES: Record<string, string> = { harassment: 'Harassment', financial_fraud: 'Financial fraud', scams: 'Scam', upi_bank_fraud: 'UPI / bank fraud' };
const AGENT_NAMES: Record<string, string> = {
  evidence_quality: 'Evidence quality', financial_investigation: 'Financial investigation', knowledge_graph: 'Knowledge graph',
  evidence_gap: 'Evidence gaps', rag_investigation: 'Cited retrieval', investigation_replay: 'Investigation replay', report_generation: 'Report draft',
};
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function InvestigationPage() {
  const { id = '' } = useParams();
  const c = useCase(id);
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const [fresh, setFresh] = useState<Investigation | null>(null);
  const q = useQuery({ queryKey: ['investigation', id], queryFn: () => api<{ investigation: Investigation | null; stale?: boolean; running?: boolean; scoped?: boolean }>(`/cases/${id}/investigation`) });
  const run = useMutation({
    mutationFn: (objective?: string) => post<{ investigation: Investigation }>(`/cases/${id}/investigation`, objective ? { objective } : {}),
    onSuccess: (r) => { setErr(''); setFresh(r.investigation); qc.invalidateQueries({ queryKey: ['investigation', id] }); },
    onError: (x) => setErr((x as Error).message),
  });
  const inv = fresh ?? q.data?.investigation ?? null;
  const canIndex = c.data?.role === 'owner' || c.data?.role === 'collaborator';

  function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const objective = String(new FormData(e.currentTarget).get('objective') ?? '').trim();
    run.mutate(objective || undefined);
  }

  if (q.isLoading) return <CaseShell><PageLoading variant="cards" label="Loading investigation" /></CaseShell>;
  return (
    <CaseShell>
      <form className="card stack" style={{ gap: 12 }} onSubmit={start}>
        <div className="row">
          <div>
            <h2 style={{ fontSize: 20 }}>Agentic investigation</h2>
            <p className="muted" style={{ fontSize: 14 }}>
              A planner picks read-only agents for this case; System1 (an open-source model) scores the incident type and reviews what the agents found.
              Every finding cites the evidence it came from. Agents only see {q.data?.scoped || inv?.scoped ? 'the evidence shared with you' : 'this case'}.
            </p>
          </div>
          {inv && <span className={`badge ${q.data?.stale && !fresh ? 'bad' : 'ok'}`}>{q.data?.stale && !fresh ? 'New evidence since last run' : `Ran ${fmtDate(inv.ranAt)}`}</span>}
        </div>
        <label className="field">Objective (optional)<input name="objective" placeholder="e.g. Who demanded money, when, and what was paid?" maxLength={1000} /></label>
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <button className="btn btn-dark" disabled={run.isPending || q.data?.running}>{run.isPending ? 'Running agents… (up to a minute)' : inv ? 'Run again' : 'Run investigation'}</button>
          {inv && <span className="muted" style={{ fontSize: 13 }}>{inv.counts.evidence} files · {inv.counts.chunks} passages · {inv.counts.events} events · {(inv.durationMs / 1000).toFixed(1)} s</span>}
        </div>
        {err && <p className="err">{err}</p>}
      </form>

      {!inv ? (
        <Empty title="No investigation yet">Run one once evidence has finished processing. It takes from a few seconds to about a minute, depending on case size.</Empty>
      ) : (
        <>
          <div className="grid-2">
            <System1Card incident={inv.system1} />
            <section className="card stack" style={{ gap: 10 }}>
              <h2 style={{ fontSize: 18 }}>Plan</h2>
              <p className="muted" style={{ fontSize: 13 }}>{inv.objective}</p>
              <ol className="list" style={{ paddingLeft: 18 }}>
                {inv.plan.plan.map((p) => (
                  <li key={p.agent}><span><strong>{AGENT_NAMES[p.agent] ?? p.agent}</strong> — <span className="muted">{p.purpose}</span> {inv.results[p.agent]?.error && <span className="badge bad">failed</span>}</span></li>
                ))}
              </ol>
              {inv.plan.incidentLabels.length > 0 && <p style={{ fontSize: 13 }}>Incident types used: {inv.plan.incidentLabels.map((l) => LABEL_NAMES[l] ?? l).join(', ')}</p>}
            </section>
          </div>

          {inv.system1Review && inv.system1Review.flags.length > 0 && (
            <section className="card stack" style={{ gap: 8 }}>
              <h2 style={{ fontSize: 18 }}>System1 review of the agents</h2>
              <p className="muted" style={{ fontSize: 13 }}>Advisory checks. They never change agent output.</p>
              <ul className="list">{inv.system1Review.flags.map((f, i) => <li key={i}><span><span className="badge">{f.code.replaceAll('_', ' ').toLowerCase()}</span> {f.message}</span></li>)}</ul>
            </section>
          )}

          <Financial r={inv.results.financial_investigation} caseId={id} />
          <div className="grid-2">
            <Quality r={inv.results.evidence_quality} caseId={id} />
            <Gaps r={inv.results.evidence_gap} />
          </div>
          <Replay r={inv.results.investigation_replay} caseId={id} />
          <GraphFacts r={inv.results.knowledge_graph} />
        </>
      )}

      <div className="grid-2">
        <SemanticSearch caseId={id} canIndex={canIndex} />
        <AskAgent caseId={id} />
      </div>
    </CaseShell>
  );
}

function System1Card({ incident }: { incident: Incident | null }) {
  if (!incident) return <section className="card"><h2 style={{ fontSize: 18 }}>Incident type (System1)</h2><p className="muted">Not available for this run.</p></section>;
  const scores = Object.entries(incident.scores).sort((a, b) => b[1] - a[1]);
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <div className="card-title row">
        <h2 style={{ fontSize: 18 }}>Incident type (System1)</h2>
        {incident.needsOwnerReview ? <span className="badge">Needs your review</span> : <span className="badge ok">{LABEL_NAMES[incident.primary] ?? incident.primary}</span>}
      </div>
      {scores.length === 0 && <p className="muted">The model could not score this case.</p>}
      {scores.map(([label, v]) => (
        <div key={label} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 44px', alignItems: 'center', gap: 8, fontSize: 14 }}>
          <span>{LABEL_NAMES[label] ?? label}</span>
          <span style={{ background: 'var(--paper-2)', borderRadius: 4, height: 8, overflow: 'hidden' }}><span style={{ display: 'block', height: '100%', width: `${Math.round(v * 100)}%`, background: incident.labels.includes(label) ? 'var(--signal)' : 'var(--ink-2)' }} /></span>
          <span className="mono" style={{ textAlign: 'right' }}>{v.toFixed(2)}</span>
        </div>
      ))}
      <p className="muted" style={{ fontSize: 12 }}>
        Model: Laya ({incident.provider === 'hf-inference' ? 'Hugging Face hosted' : 'on this server'}). Scores are indicators, not a legal classification.
        {incident.needsOwnerReview && ' Labels are assigned only after the model is calibrated; until then you decide the incident type.'}
      </p>
    </section>
  );
}

function Financial({ r, caseId }: { r: any; caseId: string }) {
  if (!r || r.error) return null;
  const debits = (r.ledger ?? []) as any[];
  return (
    <section className="card stack" style={{ gap: 12 }}>
      <h2 style={{ fontSize: 18 }}>Money trail</h2>
      <div className="stats">
        <Stat n={inr(r.lossTotal ?? 0)} label="Debited in statements" tone="signal" />
        <Stat n={debits.length} label="Payment events" />
        <Stat n={debits.filter((x) => x.matched).length} label="Matched to a bank row" />
        <Stat n={(r.muleCandidates ?? []).length} label="Repeat UPI receivers" />
      </div>
      {debits.length > 0 && (
        <div className="table-scroll">
          <table className="ev-table">
            <thead><tr><th>Amount in evidence</th><th>Bank row</th><th>Sources</th></tr></thead>
            <tbody>
              {debits.map((x, i) => (
                <tr key={i}>
                  <td>{x.amount != null ? inr(Number(x.amount)) : x.transaction?.amount ? inr(Number(x.transaction.amount)) : '—'}</td>
                  <td>{x.matched ? <span>{x.transaction?.upiId} · {inr(Number(x.transaction?.amount))}</span> : <span className="muted">no matching row</span>}</td>
                  <td><Cites ids={x.citations ?? []} caseId={caseId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ fontSize: 12 }}>Amounts are matched exactly; a demand that differs from what was paid shows as unmatched and in Inconsistencies.</p>
    </section>
  );
}

function Quality({ r, caseId }: { r: any; caseId: string }) {
  if (!r || r.error) return null;
  const findings = (r.findings ?? []) as any[];
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <h2 style={{ fontSize: 18 }}>Evidence quality</h2>
      {findings.length === 0 ? <p className="muted">No readability or context problems found in {r.reviewedEvidenceIds?.length ?? 0} files.</p> : (
        <ul className="list">
          {findings.slice(0, 12).map((f, i) => (
            <li key={i}><span><span className={`badge ${f.priority === 'medium' ? 'bad' : ''}`}>{f.priority}</span> <CitationChip id={f.evidenceId} caseId={caseId} /> {f.observation} <span className="muted">{f.suggestedNextStep}</span></span></li>
          ))}
        </ul>
      )}
      {(r.limitations ?? []).map((l: string) => <p key={l} className="muted" style={{ fontSize: 12 }}>{l}</p>)}
    </section>
  );
}

function Gaps({ r }: { r: any }) {
  if (!r || r.error) return null;
  const gaps = (r.gaps ?? []) as any[];
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <h2 style={{ fontSize: 18 }}>Evidence gaps</h2>
      {gaps.length === 0 ? (
        <p className="muted">No checklist yet: set the case's incident type, or wait until System1 is calibrated to suggest one.</p>
      ) : (
        <ul className="list">{gaps.map((g, i) => <li key={i}><span><span className={`badge ${g.status === 'gap' ? 'bad' : 'ok'}`}>{g.status}</span> {g.what} <span className="muted">({LABEL_NAMES[g.incidentType] ?? g.incidentType})</span></span></li>)}</ul>
      )}
      <p className="muted" style={{ fontSize: 12 }}>A checklist to organise the record. Not legal advice.</p>
    </section>
  );
}

function Replay({ r, caseId }: { r: any; caseId: string }) {
  if (!r || r.error || !(r.items ?? []).length) return null;
  return (
    <section className="card stack" style={{ gap: 8 }}>
      <h2 style={{ fontSize: 18 }}>Investigation replay</h2>
      <ul className="list">
        {(r.items as any[]).map((it) => (
          <li key={it.id}><span><span className="mono muted">{fmtDate(it.timestamp)}</span> {it.title} <Cites ids={it.sourceIds ?? []} caseId={caseId} /></span></li>
        ))}
      </ul>
      {(r.untimedEventIds ?? []).length > 0 && <p className="muted" style={{ fontSize: 12 }}>{r.untimedEventIds.length} events have no time and are left out.</p>}
    </section>
  );
}

function GraphFacts({ r }: { r: any }) {
  if (!r || r.error) return null;
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <h2 style={{ fontSize: 18 }}>Knowledge graph</h2>
      <div className="stats">
        <Stat n={r.nodes?.length ?? 0} label="Nodes" />
        <Stat n={r.edges?.length ?? 0} label="Links" />
        <Stat n={(r.samePersonCandidates ?? []).length} label="Same-person candidates" />
        <Stat n={r.citationsValid ? 'Yes' : 'No'} label="All links cited" tone={r.citationsValid ? undefined : 'signal'} />
      </div>
      {(r.centralFigures ?? []).length > 0 && (
        <p style={{ fontSize: 14 }}>Most involved: {(r.centralFigures as any[]).slice(0, 3).map((f) => `${(r.nodes ?? []).find((n: any) => n.id === f.entityId)?.label ?? f.entityId} (${f.eventDegree} events)`).join(', ')}</p>
      )}
    </section>
  );
}

function SemanticSearch({ caseId, canIndex }: { caseId: string; canIndex: boolean }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (question.length < 2) return;
    setBusy(true); setMsg('');
    try { setHits((await post<{ hits: Hit[] }>(`/cases/${caseId}/semantic-search`, { question })).hits); } catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  }
  async function reindex() {
    setBusy(true); setMsg('');
    try { const r = await post<{ indexed: number; chunks: number }>(`/cases/${caseId}/semantic-index`); setMsg(`Indexed ${r.indexed} of ${r.chunks} passages.`); } catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <h2 style={{ fontSize: 18 }}>Search by meaning</h2>
      <p className="muted" style={{ fontSize: 13 }}>Finds passages that mean the same thing in any language, e.g. “ಹಣ ಕಳುಹಿಸಿ” finds “send the payment”. Runs on this server.</p>
      <form className="row" onSubmit={search} style={{ flexWrap: 'nowrap' }}>
        <input name="q" placeholder="Ask in English, Hindi, Kannada…" style={{ flex: 1 }} />
        <button className="btn btn-dark btn-sm" disabled={busy}>{busy ? '…' : 'Search'}</button>
      </form>
      {hits && hits.length === 0 && <p className="muted">No matches. {canIndex && 'If this case was processed before search existed, rebuild the index.'}</p>}
      {hits && hits.length > 0 && (
        <ul className="list">
          {hits.map((h) => <li key={h.chunkId}><span><CitationChip id={h.chunkId} caseId={caseId} /> {h.textEn || h.sourceText} {h.score != null && <span className="muted mono">{h.score.toFixed(2)}</span>}</span></li>)}
        </ul>
      )}
      {msg && <p className="muted" style={{ fontSize: 13 }}>{msg}</p>}
      {canIndex && <div><button type="button" className="btn-text" onClick={reindex} disabled={busy}>Rebuild search index</button></div>}
    </section>
  );
}

function AskAgent({ caseId }: { caseId: string }) {
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function ask(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const question = String(new FormData(e.currentTarget).get('q') ?? '').trim();
    if (question.length < 2) return;
    setBusy(true); setMsg('');
    try { setOut((await post(`/cases/${caseId}/investigation/ask`, { question })).result); } catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  }
  const snippets = (out?.retrievalSnippets ?? []) as { citation: string; text: string }[];
  return (
    <section className="card stack" style={{ gap: 10 }}>
      <h2 style={{ fontSize: 18 }}>Find the evidence for a question</h2>
      <p className="muted" style={{ fontSize: 13 }}>The retrieval agent returns cited passages only, never an invented answer. For a written answer use the question box on the Summary tab.</p>
      <form className="row" onSubmit={ask} style={{ flexWrap: 'nowrap' }}>
        <input name="q" placeholder="Who threatened to send private photos?" style={{ flex: 1 }} />
        <button className="btn btn-dark btn-sm" disabled={busy}>{busy ? '…' : 'Find'}</button>
      </form>
      {out && snippets.length === 0 && <p className="muted">{out.reason ?? 'Nothing found.'}</p>}
      {snippets.length > 0 && <ul className="list">{snippets.map((s) => <li key={s.citation}><span><CitationChip id={s.citation} caseId={caseId} /> {s.text}</span></li>)}</ul>}
      {msg && <p className="err">{msg}</p>}
    </section>
  );
}
