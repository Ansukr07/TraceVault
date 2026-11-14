import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getToken, post } from '../../lib/api';
import { fmtDate, LANG_NAME, useCase } from '../../lib/case';
import { CaseShell, Cites, Empty, PageLoading } from '../../components';

type Sentence = { text: string; citations: string[]; supported?: boolean; support?: number; textEn?: string; machineTranslated?: boolean };
type Summary = { version: number; lang: string; sections: { title: string; sentences: Sentence[] }[]; generator: any; stats: { sentences: number; cited: number; unsupported: number }; createdAt: string };
type Answer = { answer: string; sentences: Sentence[]; question?: string; lang?: string; answerNative?: string | null; generator?: any };

const SUMMARY_LANGS = ['en-IN', 'hi-IN', 'kn-IN', 'ta-IN', 'te-IN', 'mr-IN', 'bn-IN'];

function Listen({ caseId, lang, sentences, onSentence }: { caseId: string; lang: string; sentences: number; onSentence: (i: number | null) => void }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [err, setErr] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  async function play() {
    if (state === 'playing') { audio.current?.pause(); setState('idle'); onSentence(null); return; }
    setState('loading');
    try {
      const r = await fetch(`/api/v1/cases/${caseId}/summary/speak`, { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lang }) });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `Read-aloud failed (${r.status})`);
      const timings: { i: number; startMs: number; endMs: number }[] = JSON.parse(r.headers.get('X-Sentence-Timings') ?? '[]');
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      audio.current = a;
      // The first timing may be the spoken content warning; summary sentences follow in order.
      const offset = Math.max(0, timings.length - sentences);
      a.ontimeupdate = () => {
        const ms = a.currentTime * 1000;
        const t = timings.find((x) => x.startMs <= ms && ms < x.endMs);
        onSentence(t ? t.i - offset : null);
      };
      a.onended = () => { setState('idle'); onSentence(null); URL.revokeObjectURL(url); };
      await a.play();
      setState('playing');
    } catch (e) {
      setErr((e as Error).message);
      setState('error');
    }
  }
  return (
    <span className="row" style={{ gap: 8 }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={play} disabled={state === 'loading'}>{state === 'playing' ? '■ Stop' : state === 'loading' ? 'Preparing audio…' : '▶ Listen'}</button>
      {state === 'error' && <span className="err">{err}</span>}
    </span>
  );
}

function VoiceAsk({ caseId, onAnswer }: { caseId: string; onAnswer: (a: Answer) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function start() {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : undefined });
      const parts: Blob[] = [];
      r.ondataavailable = (e) => parts.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setBusy(true);
        const fd = new FormData();
        fd.set('audio', new Blob(parts, { type: r.mimeType }), 'question.webm');
        try {
          onAnswer(await api<Answer>(`/cases/${caseId}/ask/voice`, { method: 'POST', body: fd }));
        } catch (e) {
          setErr(e instanceof ApiError ? e.message : (e as Error).message);
        } finally {
          setBusy(false);
        }
      };
      r.start();
      setRec(r);
      setTimeout(() => r.state === 'recording' && r.stop(), 30_000);
    } catch {
      setErr('Microphone not available');
    }
  }
  const stop = () => { rec?.stop(); setRec(null); };
  return (
    <>
      <button type="button" className="btn btn-ghost" onClick={rec ? stop : start} disabled={busy} aria-label={rec ? 'Stop recording' : 'Ask by voice'}>
        {rec ? '■ Stop' : busy ? '…' : '🎙 Ask by voice'}
      </button>
      {err && <span className="err">{err}</span>}
    </>
  );
}

export function SummaryPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const c = useCase(id);
  const [lang, setLang] = useState('en-IN');
  const [reading, setReading] = useState<number | null>(null);
  const q = useQuery({ queryKey: ['summary', id, lang], queryFn: () => api<{ summary: Summary | null }>(`/cases/${id}/summary?lang=${lang}`).then((r) => r.summary), retry: false });
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [asking, setAsking] = useState(false);
  const s = q.data;
  useEffect(() => setReading(null), [lang]);

  async function regenerate() {
    setBusy(true);
    await post(`/cases/${id}/summary/regenerate`).catch(() => {});
    setBusy(false);
    qc.invalidateQueries({ queryKey: ['summary', id] });
  }
  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAsking(true);
    try {
      const a = await post<Answer>(`/cases/${id}/ask`, { question });
      setAnswers((xs) => [{ ...a, question }, ...xs]);
      setQuestion('');
    } finally {
      setAsking(false);
    }
  }

  const voiceOn = c.data?.settings.voiceMode === 'sarvam';
  let idx = -1;
  return (
    <CaseShell>
      {q.isLoading && <PageLoading variant="text" label="Loading summary" />}
      {q.error && <p className="err">{(q.error as Error).message}</p>}
      {q.data === null && <Empty title="No summary yet">A cited summary is written once evidence has been processed.</Empty>}
      {s && (
        <>
          <div className="row">
            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Summary language" style={{ width: 'auto', minHeight: 36 }}>
                {SUMMARY_LANGS.map((l) => <option key={l} value={l}>{LANG_NAME[l]}</option>)}
              </select>
              {voiceOn && <Listen caseId={id} lang={lang} sentences={s.sections.reduce((n, x) => n + x.sentences.length, 0)} onSentence={setReading} />}
              {c.data?.role === 'owner' && <button type="button" className="btn btn-ghost btn-sm" onClick={regenerate} disabled={busy}>{busy ? 'Regenerating…' : 'Regenerate'}</button>}
            </div>
            <span className="mono muted" style={{ fontSize: 11 }}>
              v{s.version} · {s.stats?.cited}/{s.stats?.sentences} sentences cited{s.stats?.unsupported ? ` · ${s.stats.unsupported} not fully supported` : ''} · {s.generator?.name === 'llm' ? `${s.generator.provider} ${s.generator.model}` : 'built from structured evidence'} · {fmtDate(s.createdAt)}
            </span>
          </div>
          {lang !== 'en-IN' && <p className="badge warn">Machine translation (Sarvam) of the validated English summary. Citations are unchanged.</p>}
          <article className="card stack" style={{ gap: 26 }}>
            {s.sections.filter((x) => x.sentences.length).map((sec) => (
              <section key={sec.title} className="sum-sec">
                <h2>{sec.title}</h2>
                {sec.sentences.map((x, i) => {
                  idx += 1;
                  const n = idx;
                  return (
                    <p key={i} className={reading === n ? 'reading' : ''}>
                      <span className={x.supported === false ? 'unsupported' : ''}>{x.text}</span>
                      {x.supported === false && <span className="warn-mark" title="Not fully supported by the cited evidence — check the sources">⚠</span>}
                      <Cites ids={x.citations} caseId={id} />
                    </p>
                  );
                })}
              </section>
            ))}
          </article>
        </>
      )}

      <section className="card qa">
        <h2 style={{ fontSize: 18 }}>Ask about this case</h2>
        <form onSubmit={ask}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. How much money was paid, and to whom?" aria-label="Question" maxLength={1000} />
          <button className="btn btn-dark" disabled={asking}>{asking ? 'Searching…' : 'Ask'}</button>
          {voiceOn && <VoiceAsk caseId={id} onAnswer={(a) => setAnswers((xs) => [a, ...xs])} />}
        </form>
        <p className="muted" style={{ fontSize: 12 }}>Answers only use your evidence, and every sentence cites its source.</p>
        {answers.map((a, i) => (
          <div key={i} className="inc-side">
            <span className="eyebrow">Q: {a.question}</span>
            {a.answerNative && <p>{a.answerNative} <span className="mt-label">· machine translation</span></p>}
            {a.sentences.map((x, j) => (
              <p key={j}><span className={x.supported === false ? 'unsupported' : ''}>{x.text}</span><Cites ids={x.citations} caseId={id} /></p>
            ))}
            {!a.sentences.length && <p className="muted">{a.answer}</p>}
          </div>
        ))}
      </section>
    </CaseShell>
  );
}
