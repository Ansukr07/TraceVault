// Complaint wizard (future spec F3). Builds a reviewable, cited complaint from the case. Nothing is filed anywhere:
// the complainant copies it into the portal or hands it to a lawyer. Personal details are typed here and stay in this
// browser tab; they are never sent to the server.
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDate, fmtMoney } from '../../lib/case';
import { CaseShell, CitationChip, Empty, PageLoading } from '../../components';
import { PageHead } from '../../ui';
import { RegionalPanel } from './RegionalPanel';

type Ident = { kind: string; value: string };
type Draft = {
  case: { id: string; title: string; incidentType: string };
  incident: { from: string | null; to: string | null; category: string; eventCount: number };
  accused: { name: string; aliases: string[]; identifiers: Ident[]; mentions: number }[];
  looseIdentifiers: Ident[];
  money: { lossInr: number | null; demands: { amount: number; citations: string[] }[] };
  narrative: { title: string; sentences: { text: string; citations: string[]; supported: boolean }[] }[];
  offences: { id: string; act: string; section: string; title: string; rationale: string; citations: string[]; strength: 'strong' | 'possible' }[];
  offenceNote: string;
  offencesReviewedBy: string | null;
  checks: { field: string; ok: boolean; message: string }[];
};

const STEPS = ['Your details', 'The accused', 'What happened', 'Offences', 'Review & export'] as const;
const STATES = ['Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'West Bengal', 'Other'];

const cites = (c: string[]) => (c.length ? ` [${c.join(', ')}]` : '');
const when = (iso: string | null) => (iso ? fmtDate(iso, 'day') : '—');

type Form = {
  name: string; phone: string; email: string; address: string; state: string;
  accused: Record<string, boolean>; narrative: string; offences: Record<string, boolean>; reviewed: boolean;
};

function initialNarrative(d: Draft) {
  return d.narrative.map((s) => `${s.title}\n${s.sentences.map((x) => `${x.text}${cites(x.citations)}`).join(' ')}`).join('\n\n');
}

/** The plain-text complaint, assembled from the form. Used for copy, .txt and print. */
function complaintText(d: Draft, f: Form) {
  const acc = d.accused.filter((a) => f.accused[a.name] !== false);
  const loose = d.looseIdentifiers.filter((i) => f.accused[`id:${i.value}`] !== false);
  const off = d.offences.filter((o) => f.offences[o.id]);
  const L: string[] = [];
  L.push('COMPLAINT DRAFT (prepared with TraceVault; for the complainant and a lawyer to review)', '');
  L.push('1. Complainant', `Name: ${f.name || '________'}`, `Phone: ${f.phone || '________'}`, `Email: ${f.email || '________'}`, `Address: ${f.address || '________'}`, `State: ${f.state || '________'}`, '');
  L.push('2. Nature of incident', `${d.incident.category} (${when(d.incident.from)} to ${when(d.incident.to)})`, '');
  L.push('3. Accused (as identified from the evidence)');
  acc.forEach((a) => L.push(`- ${a.name}${a.aliases.length ? ` (also: ${a.aliases.join(', ')})` : ''}`, ...a.identifiers.map((i) => `    ${i.kind}: ${i.value}`)));
  loose.forEach((i) => L.push(`- ${i.kind}: ${i.value}`));
  if (!acc.length && !loose.length) L.push('- ________');
  L.push('');
  if (d.money.lossInr) L.push('4. Financial loss', `Rs ${d.money.lossInr.toLocaleString('en-IN')} debited (see bank statement in the evidence list).`, '');
  L.push(`${d.money.lossInr ? '5' : '4'}. Statement of facts`, f.narrative.trim() || '________', '');
  if (off.length) {
    L.push(`${d.money.lossInr ? '6' : '5'}. Provisions that may apply (for a lawyer to confirm)`);
    off.forEach((o) => L.push(`- ${o.act}, s.${o.section}: ${o.title}`));
    L.push('');
  }
  L.push('Evidence is sealed with SHA-256 hashes; sources in [E#:#] brackets refer to the evidence index in the TraceVault report.', '', `Date: ____/____/______     Place: __________     Signature: __________`);
  return L.join('\n');
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch { /* clipboard blocked */ } }}>
      {ok ? 'Copied ✓' : label}
    </button>
  );
}

export function ComplaintPage() {
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['complaint-draft', id], queryFn: () => api<{ draft: Draft }>(`/cases/${id}/complaint-draft`).then((r) => r.draft), retry: false, staleTime: Infinity });
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>({ name: '', phone: '', email: '', address: '', state: '', accused: {}, narrative: '', offences: {}, reviewed: false });
  const d = q.data;

  useEffect(() => {
    if (d) setF((p) => ({ ...p, narrative: p.narrative || initialNarrative(d), offences: Object.keys(p.offences).length ? p.offences : Object.fromEntries(d.offences.map((o) => [o.id, o.strength === 'strong'])) }));
  }, [d]);

  const text = useMemo(() => (d ? complaintText(d, f) : ''), [d, f]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v, reviewed: k === 'reviewed' ? (v as boolean) : false }));

  if (q.isLoading) return <CaseShell><PageLoading variant="cards" label="Preparing your complaint draft" /></CaseShell>;
  if (q.error || !d) return <CaseShell><Empty title="No draft yet">{(q.error as Error)?.message ?? 'Process some evidence first, then come back.'}</Empty></CaseShell>;
  const failing = d.checks.filter((c) => !c.ok);
  const fields: [string, string][] = [
    ['Incident category', d.incident.category],
    ['Date range', `${when(d.incident.from)} to ${when(d.incident.to)}`],
    ['Accused details', d.accused.filter((a) => f.accused[a.name] !== false).map((a) => `${a.name}: ${a.identifiers.map((i) => i.value).join(', ')}`).join('\n')],
    ...(d.money.lossInr ? [['Amount lost (Rs)', String(d.money.lossInr)] as [string, string]] : []),
    ['Incident description', f.narrative.trim()],
  ];

  return (
    <CaseShell>
      <PageHead eyebrow="Complaint helper" title={<>Your complaint, <span className="muted">ready to review</span></>} />
      <div className="banner" role="note">
        <strong>This is a draft, not a filing.</strong> It organises what your evidence shows. Nothing is sent to the police or any portal; you copy it yourself. It is not legal advice.
      </div>

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <button type="button" onClick={() => setStep(i)} aria-current={i === step ? 'step' : undefined}><span className="dot">{i < step ? '✓' : i + 1}</span><span className="lbl">{s}</span></button>
          </li>
        ))}
      </ol>

      <section className="card stack wiz" style={{ gap: 16 }}>
        {step === 0 && (
          <>
            <h2 style={{ fontSize: 20 }}>Your details</h2>
            <p className="muted" style={{ fontSize: 13 }}>Typed here only. These stay in this browser tab and are not saved or sent to our servers.</p>
            <div className="grid-2">
              <label className="field">Full name<input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" /></label>
              <label className="field">Phone<input className="input" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" /></label>
              <label className="field">Email<input className="input" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" /></label>
              <label className="field">State<select className="input" value={f.state} onChange={(e) => set('state', e.target.value)}><option value="">Select…</option>{STATES.map((s) => <option key={s}>{s}</option>)}</select></label>
            </div>
            <label className="field">Address<textarea className="input" rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} autoComplete="street-address" /></label>
          </>
        )}

        {step === 1 && (
          <>
            <h2 style={{ fontSize: 20 }}>The accused</h2>
            <p className="muted" style={{ fontSize: 13 }}>Found in your evidence. Untick anything that is wrong or that you do not want in the complaint.</p>
            {d.accused.length === 0 && d.looseIdentifiers.length === 0 && <p className="err">No accused person or identifier was found. Process more evidence, or fill this in by hand after exporting.</p>}
            {d.accused.map((a) => (
              <label key={a.name} className="pick" translate="no">
                <input type="checkbox" checked={f.accused[a.name] !== false} onChange={(e) => setF((p) => ({ ...p, accused: { ...p.accused, [a.name]: e.target.checked }, reviewed: false }))} />
                <span><strong style={{ fontWeight: 500 }}>{a.name}</strong>{a.aliases.length > 0 && <span className="muted"> · also {a.aliases.join(', ')}</span>}
                  <span className="idents">{a.identifiers.map((i) => <span key={i.value} className="chip">{i.kind}: <span className="mono">{i.value}</span></span>)}</span></span>
              </label>
            ))}
            {d.looseIdentifiers.map((i) => (
              <label key={i.value} className="pick" translate="no">
                <input type="checkbox" checked={f.accused[`id:${i.value}`] !== false} onChange={(e) => setF((p) => ({ ...p, accused: { ...p.accused, [`id:${i.value}`]: e.target.checked }, reviewed: false }))} />
                <span><span className="chip">{i.kind}: <span className="mono">{i.value}</span></span> <span className="muted">not linked to a named person</span></span>
              </label>
            ))}
            {d.money.lossInr != null && <p className="badge ok" style={{ alignSelf: 'flex-start' }}>Money lost: {fmtMoney(d.money.lossInr)}</p>}
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={{ fontSize: 20 }}>What happened</h2>
            <p className="muted" style={{ fontSize: 13 }}>Built from the cited summary. Every sentence keeps its source in [E#:#] brackets. Edit freely; you are the author.</p>
            {d.narrative.some((s) => s.sentences.some((x) => !x.supported)) && <p className="badge warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>Some sentences could not be fully confirmed from the evidence. Check them against the originals.</p>}
            <textarea className="input narr" translate="no" rows={14} value={f.narrative} onChange={(e) => set('narrative', e.target.value)} aria-label="Statement of facts" />
            <p className="muted" style={{ fontSize: 12 }}>Sources: {Array.from(new Set(d.narrative.flatMap((s) => s.sentences.flatMap((x) => x.citations)))).slice(0, 8).map((c) => <CitationChip key={c} id={c} caseId={id} />)}</p>
          </>
        )}

        {step === 3 && (
          <>
            <h2 style={{ fontSize: 20 }}>Provisions that may apply</h2>
            <div className="banner warn" role="note">
              <strong>Suggestions for a lawyer to confirm.</strong> {d.offenceNote} {d.offencesReviewedBy ? `Reviewed by ${d.offencesReviewedBy}.` : 'This list has not yet been reviewed by a lawyer.'}
            </div>
            {d.offences.length === 0 && <p className="muted">Nothing in the evidence clearly matches a listed provision.</p>}
            {d.offences.map((o) => (
              <label key={o.id} className={`pick offence ${o.strength}`}>
                <input type="checkbox" checked={!!f.offences[o.id]} onChange={(e) => setF((p) => ({ ...p, offences: { ...p.offences, [o.id]: e.target.checked }, reviewed: false }))} />
                <span>
                  <strong style={{ fontWeight: 500 }}>{o.title}</strong> <span className="chip">{o.act.replace(', 2023', '').replace(', 2000', '')} · s.{o.section}</span> <span className={`badge ${o.strength === 'strong' ? 'ok' : ''}`}>{o.strength === 'strong' ? 'several matching messages' : 'possible'}</span>
                  <br /><span className="muted" style={{ fontSize: 13 }}>{o.rationale} {o.citations.map((c) => <CitationChip key={c} id={c} caseId={id} />)}</span>
                </span>
              </label>
            ))}
          </>
        )}

        {step === 4 && (
          <>
            <h2 style={{ fontSize: 20 }}>Review & export</h2>
            {failing.length > 0 && <ul className="list">{failing.map((c) => <li key={c.field}><span className="badge warn">Missing</span> {c.message}</li>)}</ul>}
            <pre className="preview" translate="no" tabIndex={0} aria-label="Complaint preview">{text}</pre>
            <label className="pick">
              <input type="checkbox" checked={f.reviewed} onChange={(e) => set('reviewed', e.target.checked)} />
              <span>I have read every line above and it is accurate to the best of my knowledge.</span>
            </label>
            <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-dark" disabled={!f.reviewed} onClick={() => window.print()}>Print / save as PDF</button>
              <button type="button" className="btn btn-ghost" disabled={!f.reviewed} onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); a.download = 'complaint-draft.txt'; a.click(); }}>Download .txt</button>
              <CopyButton text={text} label="Copy everything" />
            </div>
            <RegionalPanel caseId={id} complainant={{ name: f.name, phone: f.phone, email: f.email, address: f.address }} />
            <div>
              <p className="eyebrow" style={{ margin: '8px 0' }}>Field by field (for the cybercrime portal)</p>
              <ul className="list">
                {fields.map(([k, v]) => (
                  <li key={k}><div className="row"><strong style={{ fontWeight: 500, fontSize: 14 }}>{k}</strong>{f.reviewed ? <CopyButton text={v} /> : <span className="muted" style={{ fontSize: 12 }}>review first</span>}</div><p className="muted" translate="no" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{v || '—'}</p></li>
                ))}
              </ul>
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 4 }}>
          <button type="button" className="btn btn-ghost" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
          {step < STEPS.length - 1 && <button type="button" className="btn btn-dark" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]} →</button>}
        </div>
      </section>

      <div className="print-sheet" aria-hidden><pre>{text}</pre></div>
    </CaseShell>
  );
}
