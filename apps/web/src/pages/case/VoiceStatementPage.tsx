import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getToken, patch, post } from '../../lib/api';
import { hashFile } from '../../lib/hashFile';
import { fmtDate, fmtMoney, fmtMs, langName, useCase } from '../../lib/case';
import { CaseShell, Cites, Empty } from '../../components';

const PROMPTS = [
  'When did it start, and on what app or number?',
  'Who is involved? Share any names, numbers or usernames you know.',
  'Did anyone ask you for money, or did you pay anything?',
  'Where did it happen, or where were you asked to go?',
];

type Sugg = { value: unknown; text: string; type: string; chunkId: string };
type Statement = {
  id: string; evidenceId: string; version: number; versions: { id: string; version: number; createdAt: string; edited: boolean }[];
  lang?: string; textNative: string; textEn: string; sentences: { text: string; citations: string[] }[];
  suggestions: { incidentType: { value: string; confidence: number }; people: Sugg[]; phones: Sugg[]; payments: Sugg[]; handles: Sugg[]; amounts: Sugg[]; dates: Sugg[]; locations: Sugg[] };
  appliedSuggestions: string[]; generator: { name: string; provider?: string; model?: string }; edited: boolean; createdAt: string;
};
type Row = { evidenceId: string; evidence: { idx: number; filename: string; status: string; error?: string; durationMs?: number; provider?: string; detectedLang?: string; createdAt: string }; statement: Statement | null };
type Transcript = { transcript: { segments: { startMs: number; endMs: number; text: string; textEn?: string; lang?: string; failed?: boolean }[]; provider: string; model?: string } };

/** Recorder: start / pause / resume / stop, live level meter, timer, listen back, re-record before saving (§6.4). */
function Recorder({ caseId, disabled, onSaved }: { caseId: string; disabled?: boolean; onSaved: () => void }) {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const tick = useRef(0);
  const [state, setState] = useState<'idle' | 'recording' | 'paused' | 'recorded' | 'saving'>('idle');
  const [level, setLevel] = useState(0);
  const [secs, setSecs] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [pct, setPct] = useState(0);

  useEffect(() => () => { cancelAnimationFrame(raf.current); clearInterval(tick.current); stream.current?.getTracks().forEach((t) => t.stop()); }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  async function start() {
    setErr('');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      stream.current = s;
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 80));
        raf.current = requestAnimationFrame(loop);
      };
      loop();
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined;
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        cancelAnimationFrame(raf.current);
        clearInterval(tick.current);
        s.getTracks().forEach((t) => t.stop());
        ctx.close();
        const b = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        setBlob(b);
        setUrl(URL.createObjectURL(b));
        setLevel(0);
        setState('recorded');
      };
      r.start(1000);
      rec.current = r;
      setSecs(0);
      setState('recording');
      tick.current = window.setInterval(() => setSecs((x) => (rec.current?.state === 'recording' ? x + 1 : x)), 1000);
    } catch {
      setErr('The microphone is not available. Check the browser permission, or add an audio file on the Add evidence tab.');
    }
  }
  const pause = () => { rec.current?.pause(); setState('paused'); setLevel(0); };
  const resume = () => { rec.current?.resume(); setState('recording'); };
  const stop = () => rec.current?.stop();
  const discard = () => { setBlob(null); setUrl(null); setSecs(0); setState('idle'); };

  async function save() {
    if (!blob) return;
    setState('saving');
    setErr('');
    try {
      const file = new File([blob], `statement-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.webm`, { type: 'audio/webm' });
      const sha = await hashFile(file, setPct);
      const fd = new FormData();
      fd.set('clientSha256', sha);
      fd.set('kind', 'statement');
      fd.set('sourceLabel', 'Your voice statement');
      fd.set('file', file);
      await api(`/cases/${caseId}/evidence`, { method: 'POST', body: fd });
      discard();
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message);
      setState('recorded');
    }
  }

  const mm = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', gap: 14, background: 'var(--white)', padding: 24 }}>
      <p className="eyebrow">{state === 'recording' ? 'Recording' : state === 'paused' ? 'Paused' : state === 'recorded' ? 'Ready to save' : state === 'saving' ? 'Sealing your statement' : 'Record your statement'}</p>
      <div className="mono" style={{ fontSize: 34, letterSpacing: '0.04em' }} aria-live="off">{mm}</div>
      <div aria-hidden="true" style={{ width: 220, height: 8, background: 'var(--paper-2)', borderRadius: 8, overflow: 'hidden' }}>
        <i style={{ display: 'block', height: '100%', width: `${Math.round(level * 100)}%`, background: 'var(--signal)', transition: 'width 0.08s' }} />
      </div>
      {state === 'idle' && <button type="button" className="btn btn-dark" onClick={start} disabled={disabled} style={{ height: 48, padding: '0 22px' }}>🎙 Start recording</button>}
      {(state === 'recording' || state === 'paused') && (
        <div className="row" style={{ justifyContent: 'center' }}>
          {state === 'recording' ? <button type="button" className="btn btn-ghost" onClick={pause}>Pause</button> : <button type="button" className="btn btn-ghost" onClick={resume}>Resume</button>}
          <button type="button" className="btn btn-dark" onClick={stop}>■ Finish</button>
        </div>
      )}
      {(state === 'recorded' || state === 'saving') && url && (
        <>
          <audio controls src={url} style={{ width: '100%', maxWidth: 360 }} />
          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn btn-ghost" onClick={discard} disabled={state === 'saving'}>Re-record</button>
            <button type="button" className="btn btn-dark" onClick={save} disabled={state === 'saving'}>{state === 'saving' ? `Sealing… ${Math.round(pct * 100)}%` : 'Save statement'}</button>
          </div>
        </>
      )}
      <p className="muted" style={{ fontSize: 12, maxWidth: 360 }}>Speak in any language you like. You can pause, listen back and start again before saving. Nothing is sent until you save.</p>
      {err && <p role="alert" className="err">{err}</p>}
    </div>
  );
}

function Transcript({ evidenceId }: { evidenceId: string }) {
  const q = useQuery({ queryKey: ['transcript', evidenceId], queryFn: () => api<Transcript>(`/evidence/${evidenceId}/transcript`), retry: false });
  const segs = q.data?.transcript.segments ?? [];
  if (!segs.length) return <p className="muted" style={{ fontSize: 13 }}>{q.isLoading ? 'Loading transcript…' : 'No transcript yet.'}</p>;
  return (
    <div className="transcript">
      {segs.map((s, i) => (
        <div key={i} className="seg-row" style={{ cursor: 'default' }}>
          <span className="t">{fmtMs(s.startMs)}</span>
          <span>{s.failed ? <span className="muted">[untranscribed]</span> : s.text}
            {s.textEn && s.textEn !== s.text && <span className="muted" style={{ display: 'block', fontSize: 13 }}>{s.textEn} <span className="mt-label">· machine translation</span></span>}
            {s.lang && <span className="mono muted" style={{ fontSize: 10.5 }}> {langName(s.lang)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Draft({ caseId, row, canEdit, isOwner }: { caseId: string; row: Row; canEdit: boolean; isOwner: boolean }) {
  const qc = useQueryClient();
  const s = row.statement!;
  const [sents, setSents] = useState(s.sentences);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [incident, setIncident] = useState(false);
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [summaryToo, setSummaryToo] = useState(false);
  useEffect(() => { setSents(s.sentences); }, [s.id, s.sentences]);
  const dirty = JSON.stringify(sents) !== JSON.stringify(s.sentences);
  const g = s.suggestions;
  const tagOptions = [
    ...g.people.map((p) => ({ k: String(p.text), label: `Person: ${p.text}` })),
    ...g.phones.map((p) => ({ k: String(p.value), label: `Phone: ${p.value}` })),
    ...g.payments.map((p) => ({ k: String(p.value), label: `Payment ID: ${p.value}` })),
    ...g.handles.map((p) => ({ k: String(p.value), label: `Account: ${p.value}` })),
  ].filter((t) => t.k.length <= 40);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await patch(`/statements/${s.id}`, { sentences: sents.filter((x) => x.text.trim()).map((x) => ({ text: x.text.trim(), citations: x.citations })) });
      setMsg({ tone: 'ok', text: 'Saved as a new version. The earlier version is kept.' });
      qc.invalidateQueries({ queryKey: ['statements', caseId] });
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await post<{ applied: string[] }>(`/statements/${s.id}/suggestions/apply`, {
        ...(incident ? { incidentType: g.incidentType.value } : {}), ...(tags.size ? { tags: [...tags] } : {}), ...(summaryToo ? { appendSummary: true } : {}),
      });
      setMsg({ tone: 'ok', text: `Applied ${r.applied.length} item(s) to the case.` });
      setTags(new Set()); setIncident(false); setSummaryToo(false);
      qc.invalidateQueries({ queryKey: ['statements', caseId] });
      qc.invalidateQueries({ queryKey: ['case', caseId] });
    } catch (e) { setMsg({ tone: 'bad', text: (e as Error).message }); } finally { setBusy(false); }
  }

  const applied = new Set(s.appliedSuggestions);
  return (
    <div className="split">
      <section className="card stack" style={{ gap: 14 }}>
        <div className="card-title">
          <h3 style={{ fontSize: 18 }}>Written statement <span className="mono muted" style={{ fontSize: 12 }}>v{s.version}{s.edited ? ' · edited' : ''}</span></h3>
          <span className="badge">{s.generator.name === 'llm' ? `${s.generator.provider} draft` : 'from your words'}</span>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>
          Read each sentence and fix anything that is wrong. Each one points to the part of your recording it came from. This is your own account, so it is shown as “according to the complainant” and does not count as proof by itself.
        </p>
        <div className="stack" style={{ gap: 10 }}>
          {sents.map((x, i) => (
            <div key={i} className="stack" style={{ gap: 4 }}>
              <textarea rows={2} value={x.text} disabled={!canEdit} onChange={(e) => setSents((cur) => cur.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} aria-label={`Sentence ${i + 1}`} />
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <Cites ids={x.citations} caseId={caseId} />
                {canEdit && <button type="button" className="btn-text muted" style={{ fontSize: 12 }} onClick={() => setSents((cur) => cur.filter((_, j) => j !== i))}>Remove sentence</button>}
              </div>
            </div>
          ))}
          {sents.length === 0 && <p className="muted">No sentences. Re-record or add evidence.</p>}
        </div>
        {s.textNative && s.textNative !== s.textEn && (
          <details><summary className="eyebrow" style={{ cursor: 'pointer' }}>In your own language ({langName(s.lang)})</summary><p className="hl" style={{ marginTop: 8 }}>{s.textNative}</p></details>
        )}
        {msg && <p role="status" className={`badge ${msg.tone}`} style={{ whiteSpace: 'normal' }}>{msg.text}</p>}
        {canEdit && (
          <div className="row" style={{ justifyContent: 'flex-start' }}>
            <button type="button" className="btn btn-dark" onClick={save} disabled={busy || !dirty}>{dirty ? 'Save changes' : 'No changes'}</button>
            {s.versions.length > 1 && <span className="mono muted" style={{ fontSize: 11 }}>{s.versions.length} versions kept</span>}
          </div>
        )}
      </section>

      <div className="stack">
        <section className="card stack" style={{ gap: 12 }}>
          <h3 style={{ fontSize: 18 }}>Suggestions for the case</h3>
          <p className="muted" style={{ fontSize: 13 }}>Taken from what you said. Nothing changes until you choose it and press Apply.</p>
          {isOwner ? (
            <>
              <label className="consent"><input type="checkbox" checked={incident} onChange={(e) => setIncident(e.target.checked)} disabled={applied.has(`incidentType:${g.incidentType.value}`)} />
                <span>Set incident type to <strong>{g.incidentType.value}</strong> <span className="muted">({Math.round(g.incidentType.confidence * 100)}% sure)</span></span></label>
              {tagOptions.length > 0 && (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="eyebrow">Add as tags</span>
                  {tagOptions.map((t) => (
                    <label key={t.label} className="row" style={{ justifyContent: 'flex-start', gap: 8, fontSize: 14 }}>
                      <input type="checkbox" checked={tags.has(t.k) || applied.has(`tag:${t.k}`)} disabled={applied.has(`tag:${t.k}`)} onChange={(e) => setTags((cur) => { const n = new Set(cur); e.target.checked ? n.add(t.k) : n.delete(t.k); return n; })} />{t.label}
                    </label>
                  ))}
                </div>
              )}
              <label className="consent"><input type="checkbox" checked={summaryToo} onChange={(e) => setSummaryToo(e.target.checked)} /><span>Add the start of this statement to the case description</span></label>
              <div><button type="button" className="btn btn-dark" onClick={apply} disabled={busy || (!incident && !tags.size && !summaryToo)}>Apply selected</button></div>
            </>
          ) : <p className="muted" style={{ fontSize: 13 }}>Only the case owner can apply suggestions.</p>}
          <dl className="kv">
            {g.amounts.length > 0 && <><dt>amounts</dt><dd>{g.amounts.map((a) => fmtMoney(Number(a.value))).join(', ')}</dd></>}
            {g.dates.length > 0 && <><dt>dates</dt><dd>{g.dates.map((d) => fmtDate(String(d.value), d.type === 'DATE' ? 'day' : 'exact')).join('; ')}</dd></>}
            {g.locations.length > 0 && <><dt>places</dt><dd>{g.locations.map((l) => l.text).join(', ')}</dd></>}
          </dl>
        </section>
        <section className="card stack" style={{ gap: 10 }}>
          <div className="card-title"><h3 style={{ fontSize: 18 }}>Transcript</h3>
            <span className="mono muted" style={{ fontSize: 11 }}>{row.evidence.provider === 'sarvam' ? 'Sarvam' : row.evidence.provider === 'local_whisper' ? 'local model' : row.evidence.provider ?? ''} · {langName(row.evidence.detectedLang)}</span></div>
          <Transcript evidenceId={row.evidenceId} />
          <Link to={`/cases/${caseId}/evidence/${row.evidenceId}`} className="btn-text">Open recording with playback →</Link>
        </section>
      </div>
    </div>
  );
}

export function VoiceStatementPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const c = useCase(id);
  const [prompt, setPrompt] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const q = useQuery({
    queryKey: ['statements', id],
    queryFn: () => api<{ statements: Row[] }>(`/cases/${id}/statements`).then((r) => r.statements),
    refetchInterval: (query) => (query.state.data?.some((r) => !r.statement && r.evidence.status !== 'failed') ? 3000 : false),
  });
  const incs = useQuery({ queryKey: ['inconsistencies', id], queryFn: () => api<{ items: { subtype?: string; status: string }[] }>(`/cases/${id}/inconsistencies`).then((r) => r.items) });
  const conflicts = (incs.data ?? []).filter((i) => i.subtype === 'statement_vs_evidence' && i.status === 'open').length;
  const role = c.data?.role;
  const canRecord = role === 'owner' || role === 'collaborator';
  const voiceOn = c.data?.settings.voiceMode === 'sarvam';

  async function speak() {
    setSpeaking(true);
    try {
      const r = await fetch(`/api/v1/cases/${id}/summary/speak`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'en-IN', text: PROMPTS[prompt] }) });
      if (r.ok) { const a = new Audio(URL.createObjectURL(await r.blob())); a.onended = () => setSpeaking(false); await a.play(); return; }
    } catch { /* fall through */ }
    setSpeaking(false);
  }
  const refresh = () => { qc.invalidateQueries({ queryKey: ['statements', id] }); qc.invalidateQueries({ queryKey: ['evidence', id] }); };

  return (
    <CaseShell>
      <div>
        <p className="eyebrow">Your account</p>
        <h2 style={{ fontSize: 26, marginTop: 8 }}>Tell what happened, <span className="muted">in your own words</span></h2>
      </div>
      {conflicts > 0 && (
        <div className="cw" role="status"><span><strong>{conflicts} place{conflicts > 1 ? 's' : ''} where your statement and the evidence disagree.</strong> Check them before filing.</span><Link to={`/cases/${id}/inconsistencies`} className="btn btn-ghost btn-sm">Review</Link></div>
      )}
      {canRecord && (
        <div className="split">
          <section className="card stack" style={{ gap: 14 }}>
            <div className="card-title"><h3 style={{ fontSize: 18 }}>Questions to help you</h3><span className="mono muted" style={{ fontSize: 11 }}>{prompt + 1} of {PROMPTS.length} · all optional</span></div>
            <div className="card" style={{ background: 'var(--paper-2)', padding: 16 }}>
              <p style={{ fontSize: 16, fontWeight: 500 }}>{PROMPTS[prompt]}</p>
            </div>
            <div className="row">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrompt((p) => Math.max(0, p - 1))} disabled={prompt === 0}>← Back</button>
              {voiceOn && <button type="button" className="btn btn-ghost btn-sm" onClick={speak} disabled={speaking}>{speaking ? 'Reading…' : '🔊 Read aloud'}</button>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPrompt((p) => (p + 1) % PROMPTS.length)}>Skip →</button>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              {voiceOn ? 'Your recording is sent to Sarvam AI for transcription, as you agreed in this case’s privacy settings.' : 'Your recording is transcribed on this server only. To transcribe in more languages, an owner can allow Sarvam AI in Settings.'}
            </p>
          </section>
          <Recorder caseId={id} onSaved={refresh} />
        </div>
      )}
      {!canRecord && <p className="muted">Only the case owner or a collaborator can record a statement.</p>}

      {q.data?.length === 0 && canRecord && <Empty title="No statements yet">Record one above. You can add more later.</Empty>}
      {q.data?.map((row) => (
        <div key={row.evidenceId} className="stack" style={{ gap: 12 }}>
          <div className="row">
            <h3 style={{ fontSize: 18 }}>Statement E{row.evidence.idx} <span className="mono muted" style={{ fontSize: 12 }}>{fmtDate(row.evidence.createdAt)}{row.evidence.durationMs ? ` · ${fmtMs(row.evidence.durationMs)}` : ''}</span></h3>
            {!row.statement && <span className={`badge ${row.evidence.status === 'failed' ? 'bad' : 'signal'}`}>{row.evidence.status === 'failed' ? 'failed' : 'transcribing and drafting…'}</span>}
          </div>
          {row.evidence.error && <p className="err">{row.evidence.error}</p>}
          {row.statement && <Draft caseId={id} row={row} canEdit={canRecord} isOwner={role === 'owner'} />}
        </div>
      ))}
    </CaseShell>
  );
}
