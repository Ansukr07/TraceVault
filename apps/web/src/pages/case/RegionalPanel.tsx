// Regional routing for the complaint (regional-states-india-spec.md §9): pick the city, state the facts the law
// depends on, see who to send it to, and download the city-addressed drafts. Personal details come from the wizard
// form and go to the server only for the one render; they are not stored.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from '../../lib/api';

type Resolved = {
  input: { complainantCity: string | null; locality: string | null; victimGender: string | null; victimIsMinor: boolean };
  city: { id: string | null; boundary: { question: string; options: string[] } | null };
  profile: { id: string; name: string; policeBody: { name: string; head: string }; cyberUnits: { name: string; phone: string | null; portalUrl: string | null }[]; localNotes: string[]; fellBack: boolean; reason: string | null; unreviewed: boolean };
  offences: { id: string; title: string; display: string; plainMeaning: string; strength: string; unreviewed: boolean; citations: string[] }[];
  offencesHidden: number;
  recipients: { id: string; label: string; report: string | null; urgent?: boolean; note?: string; contacts: { name: string; phone?: string; url?: string }[] }[];
  reports: { code: string; title: string; audience: string }[];
  minorNotice: string | null;
  unreviewed: boolean;
};

export type Complainant = { name: string; phone: string; email: string; address: string };

export function RegionalPanel({ caseId, complainant }: { caseId: string; complainant: Complainant }) {
  const qc = useQueryClient();
  const key = ['regional', caseId];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ regional: Resolved }>(`/cases/${caseId}/regional/resolve`).then((r) => r.regional), retry: false });
  const [city, setCity] = useState('');
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/cases/${caseId}/regional`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const r = q.data;

  async function download(code: string) {
    setBusy(code);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/cases/${caseId}/regional/report/${code}.pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ complainant }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `Could not create the draft (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${code}.pdf`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMsg({ tone: 'ok', text: `Downloaded ${name}. This draft was recorded in the audit log.` });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (q.isLoading) return <p className="muted">Loading regional guidance…</p>;
  if (q.error || !r) return <p className="muted">Regional guidance is not available for this case.</p>;

  return (
    <section className="card stack" style={{ gap: 12 }} aria-label="Where to send this">
      <h3 style={{ fontSize: 17 }}>Where to send this</h3>
      <div className="grid-2">
        <label className="field">Your city<input className="input" value={city || r.input.complainantCity || ''} placeholder="e.g. Bengaluru" onChange={(e) => setCity(e.target.value)} onBlur={() => city && save.mutate({ complainantCity: city })} /></label>
        <label className="field">Your locality (optional)<input className="input" defaultValue={r.input.locality ?? ''} onBlur={(e) => save.mutate({ locality: e.target.value })} /></label>
        <label className="field">The person who was targeted is
          <select className="input" value={r.input.victimGender ?? ''} onChange={(e) => save.mutate({ victimGender: e.target.value || undefined })}>
            <option value="">Prefer not to say</option><option value="female">A woman</option><option value="male">A man</option><option value="other">Another gender</option>
          </select>
        </label>
        <label className="pick" style={{ alignSelf: 'end' }}><input type="checkbox" checked={r.input.victimIsMinor} onChange={(e) => save.mutate({ victimIsMinor: e.target.checked })} /><span>The person targeted is under 18</span></label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>We only use this to choose the right route and the provisions that apply. Nothing is inferred from names.</p>

      {r.minorNotice && <div className="banner warn" role="alert">{r.minorNotice}</div>}
      {r.city.boundary && <div className="banner" role="note"><strong>{r.city.boundary.question}</strong> Put the answer in the locality box above. If you are unsure, any police station can register your complaint.</div>}
      {r.profile.fellBack && r.profile.reason && <div className="banner" role="note">{r.profile.reason} <strong>Any police station can register a Zero FIR</strong>, and you can report online at cybercrime.gov.in.</div>}
      {r.unreviewed && <div className="banner warn" role="note"><strong>Unreviewed.</strong> The legal table or city details below have not been reviewed by a lawyer yet.</div>}

      <div>
        <p className="eyebrow" style={{ margin: '4px 0 8px' }}>Route · {r.profile.name}</p>
        <ul className="list">
          {r.recipients.map((x) => (
            <li key={x.id}>
              <div className="row"><strong style={{ fontWeight: 500 }}>{x.label}</strong>{x.urgent && <span className="badge warn">Do first</span>}</div>
              {x.note && <p className="muted" style={{ fontSize: 13 }}>{x.note}</p>}
              <p style={{ fontSize: 13 }}>{x.contacts.map((c) => (c.url ? <a key={c.name} href={c.url} target="_blank" rel="noreferrer noopener">{c.name}</a> : <span key={c.name}>{c.name}: <strong>{c.phone}</strong> </span>))}</p>
              {x.report && r.reports.some((rep) => rep.code === x.report) && <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => download(x.report!)}>{busy === x.report ? 'Preparing…' : `Download ${r.reports.find((rep) => rep.code === x.report)?.title}`}</button>}
            </li>
          ))}
        </ul>
      </div>

      {r.offences.length > 0 && (
        <div>
          <p className="eyebrow" style={{ margin: '4px 0 8px' }}>Provisions that may apply here</p>
          <ul className="list">{r.offences.map((o) => <li key={o.id}><strong style={{ fontWeight: 500 }}>{o.display}</strong> · {o.title} <span className="badge">{o.strength}</span>{o.unreviewed && <span className="badge warn">unreviewed</span>}<br /><span className="muted" style={{ fontSize: 13 }}>{o.plainMeaning}</span></li>)}</ul>
        </div>
      )}
      {r.offences.length === 0 && r.offencesHidden > 0 && <p className="muted" style={{ fontSize: 13 }}>{r.offencesHidden} possible provision(s) are waiting for a lawyer’s review and are not shown yet.</p>}

      {r.reports.length > 0 && (
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
          {r.reports.map((rep) => <button key={rep.code} type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} title={rep.audience} onClick={() => download(rep.code)}>{busy === rep.code ? 'Preparing…' : rep.title}</button>)}
        </div>
      )}
      {msg && <p className={msg.tone === 'bad' ? 'err' : 'muted'} role="status">{msg.text}</p>}
    </section>
  );
}
