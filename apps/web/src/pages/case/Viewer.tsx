import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtMs, fmtSize, langName, useEvidence, useEvidenceBlob, type Chunk, type Evidence } from '../../lib/case';
import { Bilingual, CaseShell, ContentWarning, HashBadge, SeverityTag } from '../../components';

type Extracted = { evidence: Evidence; artifact: { type: string; generator: any; data: any } | null; chunks: Chunk[] };

const FLAG_FIELDS = new Set(['software', 'Software', 'producer', 'creator']);

function MetadataPanel({ e }: { e: Evidence }) {
  const flagged = new Set(e.flags.map((f) => (f.field ?? '').toLowerCase()));
  const rows = Object.entries(e.metadata ?? {}).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object');
  if (e.metadata?.gps) rows.push(['gps', `${e.metadata.gps.lat}, ${e.metadata.gps.lon}`]);
  return (
    <section className="card">
      <div className="card-title"><h3>Metadata</h3>{e.flags.length > 0 && <span className="badge bad">{e.flags.length} red flag{e.flags.length > 1 ? 's' : ''}</span>}</div>
      {e.flags.map((f, i) => (
        <p key={i} className="flag" style={{ fontSize: 13, marginBottom: 6 }}>⚑ {f.type.replace(/_/g, ' ').toLowerCase()}: {f.value}</p>
      ))}
      <table className="meta-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}><td>{k}</td><td className={flagged.has(k.toLowerCase()) || FLAG_FIELDS.has(k) && e.flags.some((f) => f.field === k) ? 'flag' : ''}>{String(v)}</td></tr>
          ))}
          <tr><td>file</td><td>{e.filename} · {e.mime} · {fmtSize(e.size)}</td></tr>
          <tr><td>uploaded</td><td>{fmtDate(e.createdAt)}</td></tr>
        </tbody>
      </table>
    </section>
  );
}

function ImageOriginal({ e, chunks, artifact, active, onPick }: { e: Evidence; chunks: Chunk[]; artifact: any; active: string | null; onPick: (cid: string) => void }) {
  const blob = useEvidenceBlob(e.id);
  const [reveal, setReveal] = useState(false);
  const W = artifact?.width ?? 1;
  const H = artifact?.height ?? 1;
  return (
    <div className={`img-wrap${reveal ? '' : ' blurred'}`}>
      {blob.data && <img src={blob.data} alt={`Evidence ${e.filename}`} />}
      {blob.isLoading && <p className="muted">Decrypting original…</p>}
      {blob.error && <p className="err">{(blob.error as Error).message}</p>}
      {reveal && chunks.map((c) => c.locator?.bbox && (
        <button
          key={c.cid}
          type="button"
          className={`ocr-box${active === c.cid ? ' on' : ''}${c.lowConfidence ? ' low' : ''}`}
          style={{ left: `${(c.locator.bbox[0] / W) * 100}%`, top: `${(c.locator.bbox[1] / H) * 100}%`, width: `${((c.locator.bbox[2] - c.locator.bbox[0]) / W) * 100}%`, height: `${((c.locator.bbox[3] - c.locator.bbox[1]) / H) * 100}%` }}
          onClick={() => onPick(c.cid)}
          aria-label={`Text block ${c.cid}`}
        />
      ))}
      {!reveal && blob.data && (
        <div className="blur-cover"><button type="button" className="btn btn-dark btn-sm" onClick={() => setReveal(true)}>Show image</button></div>
      )}
    </div>
  );
}

function AudioOriginal({ e, chunks, active, onPick, seekTo }: { e: Evidence; chunks: Chunk[]; active: string | null; onPick: (cid: string) => void; seekTo: number | null }) {
  const blob = useEvidenceBlob(e.id);
  const box = useRef<HTMLDivElement>(null);
  const ws = useRef<any>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!blob.data || !box.current) return;
    let destroyed = false;
    import('wavesurfer.js').then(({ default: WaveSurfer }) => {
      if (destroyed || !box.current) return;
      ws.current = WaveSurfer.create({ container: box.current, url: blob.data!, height: 72, waveColor: '#b9b8b3', progressColor: '#e2603d', cursorColor: '#0d0d0d', barWidth: 2, barGap: 1, barRadius: 2 });
      ws.current.on('timeupdate', (s: number) => setT(s * 1000));
      ws.current.on('play', () => setPlaying(true));
      ws.current.on('pause', () => setPlaying(false));
      ws.current.on('ready', () => { if (seekTo != null) { ws.current.setTime(seekTo / 1000); } });
    });
    return () => { destroyed = true; ws.current?.destroy(); ws.current = null; };
  }, [blob.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (seekTo != null && ws.current) { ws.current.setTime(seekTo / 1000); } }, [seekTo]);
  const current = chunks.find((c) => (c.locator.startMs ?? 0) <= t && t < (c.locator.endMs ?? 0));
  const seek = (c: Chunk) => { onPick(c.cid); ws.current?.setTime((c.locator.startMs ?? 0) / 1000); ws.current?.play(); };
  return (
    <div className="stack">
      {blob.isLoading && <p className="muted">Decrypting original…</p>}
      <div ref={box} className="wave" />
      <div className="row" style={{ justifyContent: 'flex-start' }}>
        <button type="button" className="btn btn-dark btn-sm" onClick={() => ws.current?.playPause()} disabled={!blob.data}>{playing ? 'Pause' : 'Play'}</button>
        <span className="mono muted">{fmtMs(t)}{e.durationMs ? ` / ${fmtMs(e.durationMs)}` : ''}</span>
        {e.provider && <span className="chip">{e.provider === 'sarvam' ? 'Transcribed by Sarvam' : e.provider === 'local_whisper' ? 'Local transcription' : e.provider}</span>}
      </div>
      <div className="transcript" role="list">
        {chunks.map((c) => (
          <button key={c.cid} type="button" role="listitem" className={`seg-row${current?.cid === c.cid || active === c.cid ? ' on' : ''}`} onClick={() => seek(c)}>
            <span className="t">{fmtMs(c.locator.startMs ?? 0)}{c.speaker ? <><br />{c.speaker}</> : null}</span>
            <span>{c.failed ? <span className="muted">[untranscribed]</span> : <Bilingual text={c.text} textEn={c.textEn} lang={c.lang} entities={c.entities} translation={c.translation} />}
              {c.lang && <span className="mono muted" style={{ fontSize: 10.5, marginLeft: 6 }}>{langName(c.lang)}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatOriginal({ artifact, chunks, active, children }: { artifact: any; chunks: Chunk[]; active: string | null; children: Evidence[] }) {
  const { user } = useAuth();
  const me = (artifact?.participants ?? []).find((p: string) => user?.name && p.toLowerCase().startsWith(user.name.toLowerCase().split(' ')[0]));
  const byMsg = new Map(chunks.map((c) => [c.locator.messageIdx, c]));
  const childByName = new Map(children.map((c) => [c.filename, c]));
  return (
    <div className="chat">
      {(artifact?.messages ?? []).map((m: any) => {
        if (m.system) return <p key={m.idx} className="sysmsg">{m.text}</p>;
        const c = byMsg.get(m.idx);
        const media = m.media && childByName.get(m.media);
        return (
          <div key={m.idx} id={c ? `c-${c.cid}` : undefined} className={`bubble${m.sender === me ? ' me' : ''}${c && active === c.cid ? ' on' : ''}`}>
            {m.sender !== me && <div className="who">{m.sender}</div>}
            {c ? <Bilingual text={c.text} textEn={c.textEn} lang={c.lang} entities={c.entities} translation={c.translation} /> : m.text}
            {media && <div><Link to={`../evidence/${media.id}`} relative="path">Open attachment {media.filename} →</Link></div>}
            <div className="when">{fmtDate(m.ts)}{c ? ` · ${c.cid}` : ''}</div>
          </div>
        );
      })}
    </div>
  );
}

export function ViewerPage() {
  const { id = '', eid = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['extracted', eid], queryFn: () => api<Extracted>(`/evidence/${eid}/extracted`) });
  const all = useEvidence(id);
  const active = sp.get('chunk');
  const setActive = (cid: string) => setSp((p) => { p.set('chunk', cid); return p; }, { replace: true });
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const children = useMemo(() => (all.data ?? []).filter((x) => x.parentEvidenceId === eid), [all.data, eid]);
  const maxSev = Math.max(0, ...(d?.chunks ?? []).map((c) => c.severity?.score ?? 0));
  const activeChunk = d?.chunks.find((c) => c.cid === active);

  useEffect(() => {
    if (!active) return;
    const el = document.getElementById(`c-${active}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [active, d]);

  async function reprocess(voiceProvider?: string) {
    setBusy(true);
    await post(`/evidence/${eid}/reprocess`, voiceProvider ? { voiceProvider } : {}).catch(() => {});
    setBusy(false);
    qc.invalidateQueries({ queryKey: ['extracted', eid] });
    qc.invalidateQueries({ queryKey: ['evidence', id] });
  }

  if (q.isLoading) return <CaseShell><p className="muted">Loading…</p></CaseShell>;
  if (q.error || !d) return <CaseShell><p className="err">{(q.error as Error)?.message ?? 'Not found'}</p></CaseShell>;
  const e = d.evidence;
  const kind = e.kind;

  return (
    <CaseShell>
      <div className="row">
        <div>
          <Link to={`/cases/${id}/evidence`} className="back" style={{ marginBottom: 6 }}>← Evidence</Link>
          <h2 style={{ fontSize: 22 }}><span className="mono muted" style={{ fontSize: 14 }}>E{e.idx}</span> {e.sourceLabel || e.filename}</h2>
        </div>
        <div className="row">
          {maxSev > 0 && <SeverityTag score={maxSev} />}
          <span className={`badge ${e.status === 'done' ? 'ok' : e.status === 'failed' ? 'bad' : 'signal'}`}>{e.status}</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reprocess()}>Reprocess</button>
          {(kind === 'audio' || kind === 'statement') && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => reprocess(e.provider === 'sarvam' ? 'local' : 'sarvam')}>Re-transcribe with {e.provider === 'sarvam' ? 'local model' : 'Sarvam'}</button>}
        </div>
      </div>
      {e.error && <p className="err">{e.error}</p>}

      <div className="split">
        <section className="viewer-orig">
          <ContentWarning show={maxSev >= 3}>
            {kind === 'image' && <ImageOriginal e={e} chunks={d.chunks} artifact={d.artifact?.data} active={active} onPick={setActive} />}
            {(kind === 'audio' || kind === 'statement') && <AudioOriginal e={e} chunks={d.chunks} active={active} onPick={setActive} seekTo={activeChunk?.locator.startMs ?? null} />}
            {kind === 'chat_export' && <ChatOriginal artifact={d.artifact?.data} chunks={d.chunks} active={active} children={children} />}
            {kind === 'pdf' && <PdfOriginal e={e} />}
            {kind === 'email' && (
              <div className="stack">
                <dl className="kv">{Object.entries(d.artifact?.data?.headers ?? {}).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)}</dl>
              </div>
            )}
            {kind === 'archive' && <p className="muted">Archive unpacked into {children.length} item(s) below.</p>}
          </ContentWarning>
          {children.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="eyebrow" style={{ marginBottom: 8 }}>Contained items</p>
              <ul className="list">{children.map((c) => <li key={c.id}><Link to={`/cases/${id}/evidence/${c.id}`}>E{c.idx} · {c.filename}</Link> <span className="chip">{c.kind}</span></li>)}</ul>
            </div>
          )}
        </section>

        <div className="stack">
          {kind !== 'chat_export' && kind !== 'audio' && kind !== 'statement' && (
            <section className="card">
              <div className="card-title"><h3>Extracted text</h3><span className="mono muted" style={{ fontSize: 11 }}>{d.chunks.length} chunks{d.artifact?.generator?.name ? ` · ${d.artifact.generator.name}` : ''}</span></div>
              {d.chunks.length === 0 && <p className="muted">No text extracted{kind === 'image' ? ' (no readable text in the image)' : ''}.</p>}
              <div className="chunks">
                {d.chunks.map((c) => (
                  <div key={c.cid} id={`c-${c.cid}`} className={`chunk sev-${c.severity?.score ?? 0}${active === c.cid ? ' on' : ''}`} onClick={() => setActive(c.cid)}>
                    <div className="chunk-meta">
                      <span>{c.cid}</span>
                      {c.sender && <span>{c.sender}</span>}
                      {c.refTs && <span>{fmtDate(c.refTs)}</span>}
                      {c.locator.page && <span>page {c.locator.page}</span>}
                      {c.lowConfidence && <span className="badge warn">low OCR confidence</span>}
                      {(c.severity?.score ?? 0) > 0 && <SeverityTag score={c.severity!.score} labels={c.severity!.labels} />}
                    </div>
                    <Bilingual text={c.text} textEn={c.textEn} lang={c.lang} entities={c.entities} translation={c.translation} />
                  </div>
                ))}
              </div>
            </section>
          )}
          <MetadataPanel e={e} />
          <section className="card"><HashBadge evidenceId={e.id} sha256={e.sha256} /></section>
        </div>
      </div>
    </CaseShell>
  );
}

function PdfOriginal({ e }: { e: Evidence }) {
  const blob = useEvidenceBlob(e.id);
  if (blob.isLoading) return <p className="muted">Decrypting original…</p>;
  if (!blob.data) return <p className="err">Could not load the PDF.</p>;
  return (
    <>
      {e.metadata?.ocrPages?.length > 0 && <p className="badge warn" style={{ marginBottom: 8 }}>OCR'd pages: {e.metadata.ocrPages.join(', ')}</p>}
      <iframe className="pdf-frame" src={blob.data} title={`PDF ${e.filename}`} />
    </>
  );
}
