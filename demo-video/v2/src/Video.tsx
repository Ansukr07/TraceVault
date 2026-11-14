import React from 'react';
import {
  AbsoluteFill, Audio, Easing, Img, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig,
} from 'remotion';
import vo from './vo.json';
import dur from './vo-durations.json';

const FPS = 30;
const BG = '#edece8';
const INK = '#111';
const ACCENT = '#e2552d';
const FONT = `'Segoe UI', 'Inter', system-ui, sans-serif`;
const MONO = `'Consolas', 'Cascadia Mono', monospace`;

type VoKey = keyof typeof vo;

/* ---------- small building blocks ---------- */

const ease = Easing.bezier(0.45, 0, 0.2, 1);

/** Pan (and optional zoom) over a tall full-page screenshot. keys: [progress 0..1, y px in image space] */
const Pan: React.FC<{ src: string; keys: [number, number][]; total: number; zoom?: [number, number] }> = ({ src, keys, total, zoom = [1, 1] }) => {
  const f = useCurrentFrame();
  const p = Math.min(1, f / total);
  const y = interpolate(p, keys.map((k) => k[0]), keys.map((k) => k[1]), { easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const z = interpolate(p, [0, 1], zoom);
  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: BG }}>
      <Img src={staticFile(src)} style={{ position: 'absolute', left: 0, top: 0, width: 1920, transform: `translateY(${-y}px) scale(${z})`, transformOrigin: `50% ${y + 540}px` }} />
    </AbsoluteFill>
  );
};

const Chips: React.FC<{ items: string[]; start?: number; gap?: number }> = ({ items, start = 6, gap = 14 }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', left: 40, bottom: 150, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      {items.map((t, i) => {
        const s = spring({ frame: f - start - i * gap, fps: FPS, config: { damping: 18, stiffness: 140 } });
        return (
          <div key={t} style={{
            opacity: s * 0.94, transform: `translateX(${(1 - s) * -30}px)`, background: 'rgba(17,17,17,.78)', color: '#fff', fontFamily: FONT, fontWeight: 600,
            fontSize: 19, padding: '6px 13px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 9, backdropFilter: 'blur(4px)',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: ACCENT, display: 'inline-block' }} />
            {t}
          </div>
        );
      })}
    </div>
  );
};

const Caption: React.FC<{ text: string; delay: number; audioFrames?: number }> = ({ text, delay, audioFrames }) => {
  const f = useCurrentFrame();
  const parts = (text.match(/[^.!?]+[.!?]+/g) ?? [text]).map((x) => x.trim()).filter(Boolean);
  let shown = text;
  let local = 0;
  let o = interpolate(f, [delay, delay + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (audioFrames && parts.length > 1) {
    const total = parts.reduce((n, x) => n + x.length, 0);
    let acc = 0;
    let idx = 0;
    const bounds = parts.map((x) => { const st = (acc / total) * audioFrames + delay; acc += x.length; return st; });
    bounds.forEach((st, i) => { if (f >= st - 2) idx = i; });
    shown = parts[idx];
    local = f - bounds[idx];
    o = interpolate(local, [-2, 4], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity: o }}>
      <div style={{ maxWidth: 1560, background: 'rgba(10,10,10,.86)', color: '#fff', fontFamily: FONT, fontSize: 30, lineHeight: 1.3, padding: '10px 24px', borderRadius: 16, textAlign: 'center' }}>{shown}</div>
    </div>
  );
};

const TeamBox: React.FC = () => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 12, 150, 170], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rows: [string, string][] = [['Team Lead', 'Shashank G'], ['Member 1', 'Ansu Kumar'], ['Member 2', 'Aman Raj']];
  return (
    <div style={{ position: 'absolute', left: 40, bottom: 150, opacity: o, transform: `translateY(${(1 - o) * 14}px)`, background: 'rgba(255,255,255,.94)', borderRadius: 12, padding: '10px 16px', boxShadow: '0 6px 18px rgba(0,0,0,.16)', fontFamily: FONT, border: `1.5px solid ${INK}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <span style={{ fontFamily: MONO, letterSpacing: 3, fontSize: 14, color: ACCENT, fontWeight: 700 }}>TEAM</span>
        <span style={{ fontSize: 28, fontWeight: 800, color: INK, lineHeight: 1 }}>ModiFY</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ fontSize: 16, color: INK, lineHeight: 1.45 }}><span style={{ color: '#777', display: 'inline-block', width: 84 }}>{k}:</span><b>{v}</b></div>
      ))}
    </div>
  );
};

/** a visual sub-scene: short fade in/out, no audio */
const SubScene: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 6, frames - 6, frames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: o, background: BG }}>{children}</AbsoluteFill>;
};

/* ---------- end card content ---------- */

const FEATURES: [string, string][] = [
  ['Evidence authenticity check', 'Error Level Analysis, editing-software and date-mismatch checks'],
  ['Trusted timestamping', 'RFC 3161 + OpenTimestamps anchoring, checked offline'],
  ['Complaint helper', 'Cited narrative with candidate BNS / IT Act offences'],
  ['Regional legal layer', '8 metros: police unit, cyber cell, portal, helpline + 5 report types'],
  ['Safety mode & risk score', 'Cited escalation signals, helplines, Quick exit, Discreet mode'],
  ['Trauma-informed personalisation', 'Tone, screens and support adapt to the harm type'],
  ['Multilingual UI', 'Opt-in translation into Indian languages'],
  ['Voice Q&A and read-aloud', 'Ask by voice, hear summaries (Sarvam Bulbul TTS)'],
  ['Investigation replay', 'Step through the case, each step linked to evidence'],
  ['Evaluation harness', 'Synthetic cases scored for extraction and linking accuracy'],
];

const FeaturesCard: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT, padding: '56px 80px' }}>
      <div style={{ fontFamily: MONO, letterSpacing: 5, color: ACCENT, fontSize: 24, fontWeight: 700 }}>BEYOND THE PS BASELINE</div>
      <div style={{ fontSize: 76, fontWeight: 800, color: INK, marginBottom: 28 }}>Additional features we built</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        {FEATURES.map(([t, d], i) => {
          const s = spring({ frame: f - 3 - i * 3, fps: FPS, config: { damping: 20, stiffness: 120 } });
          return (
            <div key={t} style={{ opacity: s, transform: `translateY(${(1 - s) * 24}px)`, background: '#fff', borderRadius: 18, padding: '18px 26px', borderLeft: `8px solid ${i % 2 ? INK : ACCENT}`, boxShadow: '0 4px 14px rgba(0,0,0,.08)' }}>
              <div style={{ fontSize: 33, fontWeight: 700, color: INK }}>{t}</div>
              <div style={{ fontSize: 25, color: '#555', marginTop: 4 }}>{d}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const Box: React.FC<{ x: number; y: number; w: number; h: number; title: string; sub?: string; items?: string[]; dark?: boolean; delay?: number }> = ({ x, y, w, h, title, sub, items, dark, delay = 0 }) => {
  const f = useCurrentFrame();
  const s = spring({ frame: f - delay * 0.45, fps: FPS, config: { damping: 20, stiffness: 120 } });
  return (
    <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, opacity: s, transform: `scale(${0.94 + 0.06 * s})`, background: dark ? INK : '#fff', color: dark ? '#fff' : INK, borderRadius: 20, padding: '18px 22px', boxShadow: '0 6px 20px rgba(0,0,0,.12)', fontFamily: FONT, border: dark ? 'none' : `2px solid ${INK}` }}>
      <div style={{ fontSize: 28, fontWeight: 800 }}>{title}</div>
      {sub && <div style={{ fontFamily: MONO, fontSize: 20, color: dark ? '#bbb' : '#777', marginBottom: 6 }}>{sub}</div>}
      {items && items.map((t) => <div key={t} style={{ fontSize: 22, lineHeight: 1.38, color: dark ? '#ddd' : '#333' }}>• {t}</div>)}
    </div>
  );
};

const Arrow: React.FC<{ x1: number; y1: number; x2: number; y2: number; label?: string; delay?: number }> = ({ x1, y1, x2, y2, label, delay = 0 }) => {
  const f = useCurrentFrame();
  const p = interpolate(f, [delay * 0.45, delay * 0.45 + 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const ex = x1 + (x2 - x1) * p, ey = y1 + (y2 - y1) * p;
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0 }} width={1920} height={1080}>
      <defs><marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill={ACCENT} /></marker></defs>
      <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={ACCENT} strokeWidth={4} markerEnd={p > 0.95 ? 'url(#ah)' : undefined} />
      {label && p > 0.5 && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 12} textAnchor="middle" fontFamily={FONT} fontSize={20} fontWeight={600} fill="#444">{label}</text>}
    </svg>
  );
};

const ArchCard: React.FC<{ taglineAt: number }> = ({ taglineAt }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [taglineAt, taglineAt + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ background: BG, fontFamily: FONT }}>
      <div style={{ position: 'absolute', left: 80, top: 36 }}>
        <div style={{ fontFamily: MONO, letterSpacing: 5, color: ACCENT, fontSize: 24, fontWeight: 700 }}>TECHNICAL ARCHITECTURE</div>
        <div style={{ fontSize: 56, fontWeight: 800, color: INK }}>Three processes, one database, no Docker</div>
      </div>
      <Box x={60} y={190} w={470} h={300} dark title="React SPA" sub="Vite + TypeScript · :5173" items={['Pages (case, graph, investigate)', 'Web Crypto SHA-256 worker', 'MediaRecorder: voice statement / Q&A']} />
      <Box x={640} y={190} w={560} h={470} dark delay={8} title="Node 20 / Express" sub=":4000 · owns users, integrity, storage" items={['Auth + RBAC (JWT, TOTP, argon2)', 'Upload + sealing (AES-256-GCM)', 'Case / evidence API', 'Hash-chained audit log', 'Scoped sharing', 'Reports + bundles', 'Socket.IO live progress', 'Mongo-backed job runner']} />
      <Box x={1310} y={190} w={560} h={470} dark delay={16} title="Python FastAPI" sub=":8000 · stateless, X-Internal-Secret" items={['Ingestion: WhatsApp / chats / PDF / EML', 'OCR: English (RapidOCR) + Indic', 'Voice: Sarvam STT + whisper fallback', 'NER · time · severity · embeddings', 'System1 incident model', 'LangGraph investigation agents', 'Resolve · dedup · graph · inconsistencies']} />
      <Box x={640} y={730} w={560} h={150} delay={24} title="MongoDB replica set" sub="data + GridFS + audit chain + jobs" />
      <Box x={60} y={730} w={470} h={150} delay={28} title="Chroma vector index" sub="case-scoped BGE-M3 search (written by ML)" />
      <Box x={1310} y={730} w={560} h={150} delay={32} title="External AI" items={['Sarvam AI · Google Vision / Translate · LLM API']} />
      <Arrow x1={530} y1={340} x2={640} y2={340} label="REST" delay={20} />
      <Arrow x1={1200} y1={340} x2={1310} y2={340} label="jobs" delay={28} />
      <Arrow x1={920} y1={660} x2={920} y2={730} delay={34} />
      <Arrow x1={1590} y1={660} x2={1590} y2={730} delay={38} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity: t, transform: `translateY(${(1 - t) * 16}px)` }}>
        <div style={{ background: INK, color: '#fff', borderRadius: 18, padding: '16px 40px', fontSize: 40, fontWeight: 700 }}>
          TraceVault <span style={{ color: ACCENT }}>·</span> From scattered screenshots to a case that holds up
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- timeline: 7 voice-over clips (audio/1..7.mp4), each owns one or two visual scenes ---------- */

const AUD: Record<number, number> = { 1: 6.357229, 2: 7.893208, 3: 11.562479, 4: 4.88525, 5: 13.823792, 6: 7.829208, 7: 4.88525 };
const SUB: Record<number, string> = {
  1: vo.v1,
  2: vo.v2,
  3: `${vo.v3a} ${vo.v3b}`,
  4: vo.v4,
  5: vo.v5,
  6: `${vo.v6a} ${vo.v6b}`,
  7: 'TraceVault. From scattered screenshots to a case that holds up.',
};

type Sub = { frac: number; node: (frames: number) => React.ReactNode };
type Group = { n: number; subs: Sub[] };

const ViewerScene: React.FC<{ n: number }> = ({ n }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [20, 32], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (<>
    <Pan src="viewer-open.png" total={n} keys={[[0, 330], [0.3, 330], [1, 1250]]} />
    <Img src={staticFile('viewer-blur.png')} style={{ position: 'absolute', left: 0, top: 0, width: 1920, opacity: o, transform: 'translateY(-330px)' }} />
    <Chips items={['OCR with line boxes', 'Sarvam Translate: labelled machine translation', 'Authenticity check (ELA)']} gap={14} start={4} />
  </>);
};

const groups: Group[] = [
  { n: 1, subs: [{ frac: 1, node: (n) => (<>
    <Pan src="dashboard.png" total={n} keys={[[0, 0], [1, 240]]} zoom={[1, 1.03]} />
    <TeamBox />
  </>) }] },
  { n: 2, subs: [{ frac: 1, node: (n) => (<>
    <OffthreadVideo src={staticFile('upload.mp4')} playbackRate={9 / (n / FPS)} muted style={{ width: 1920, height: 1080 }} />
    <Chips items={['SHA-256 hashing in the browser', 'AES-256-GCM encryption', 'Hash-chained audit log']} gap={16} />
  </>) }] },
  { n: 3, subs: [
    { frac: 0.55, node: (n) => (<>
      <Pan src="settings.png" total={n} keys={[[0, 980], [1, 1180]]} />
      <Chips items={['Two OCR pipelines', 'RapidOCR on-device (PaddleOCR / ONNX)', 'Sarvam Vision for Indic scripts', 'Privacy modes: local / auto / cloud']} gap={16} start={4} />
    </>) },
    { frac: 0.45, node: (n) => <ViewerScene n={n} /> },
  ] },
  { n: 4, subs: [{ frac: 1, node: (n) => (<>
    <Pan src="graph.png" total={n} keys={[[0, 0], [1, 120]]} zoom={[1, 1.06]} />
    <Chips items={['Entity resolution across sources', 'Knowledge graph (networkx + Cytoscape)', 'Money-mule cluster detection']} gap={14} />
  </>) }] },
  { n: 5, subs: [{ frac: 1, node: (n) => (<>
    <Pan src="investigate.png" total={n} keys={[[0, 690], [0.3, 700], [0.5, 1640], [0.75, 2420], [1, 2950]]} />
    <Chips items={['System1 (Laya) incident classifier', 'LangGraph read-only agents', 'Cited retrieval (BGE-M3 + Chroma)', 'Financial + evidence-gap agents']} gap={24} />
  </>) }] },
  { n: 6, subs: [
    { frac: 0.52, node: (n) => (<>
      <Pan src="inconsistencies.png" total={n} keys={[[0, 330], [1, 1330]]} />
      <Chips items={['Inconsistency detection', 'Edited-file + amount-mismatch flags']} gap={14} start={4} />
    </>) },
    { frac: 0.48, node: (n) => (<>
      <Pan src="export.png" total={n} keys={[[0, 180], [1, 650]]} />
      <Chips items={['Section 63 BSA certificate', 'Evidence bundle + offline verify.py', 'OpenTimestamps + RFC 3161']} gap={12} start={4} />
    </>) },
  ] },
  { n: 7, subs: [
    { frac: 0.48, node: () => <ArchCard taglineAt={99999} /> },
    { frac: 0.52, node: () => <FeaturesCard /> },
  ] },
];

const PAD = 0.25;
const gFrames = groups.map((g) => Math.round((AUD[g.n] + PAD) * FPS));
const gStarts: number[] = [];
let acc = 0;
for (const f of gFrames) { gStarts.push(acc); acc += f; }
export const TOTAL_FRAMES = acc;

export const Video: React.FC = () => (
  <AbsoluteFill style={{ background: BG }}>
    {groups.map((g, gi) => {
      const total = gFrames[gi];
      let off = 0;
      return (
        <Sequence key={g.n} from={gStarts[gi]} durationInFrames={total}>
          {g.subs.map((sub, si) => {
            const fr = si === g.subs.length - 1 ? total - off : Math.round(sub.frac * total);
            const from = off; off += fr;
            return (
              <Sequence key={si} from={from} durationInFrames={fr}>
                <SubScene frames={fr}>{sub.node(fr)}</SubScene>
              </Sequence>
            );
          })}
          <Sequence from={2}><Audio src={staticFile(`vo/a${g.n}.mp4`)} /></Sequence>
          <Caption text={SUB[g.n]} delay={2} audioFrames={g.n === 7 ? undefined : Math.round(AUD[g.n] * FPS)} />
        </Sequence>
      );
    })}
  </AbsoluteFill>
);
