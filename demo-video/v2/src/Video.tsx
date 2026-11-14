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
    <div style={{ position: 'absolute', left: 56, bottom: 150, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}>
      {items.map((t, i) => {
        const s = spring({ frame: f - start - i * gap, fps: FPS, config: { damping: 18, stiffness: 140 } });
        return (
          <div key={t} style={{
            opacity: s, transform: `translateX(${(1 - s) * -40}px)`, background: INK, color: '#fff', fontFamily: FONT, fontWeight: 600,
            fontSize: 30, padding: '12px 22px', borderRadius: 14, boxShadow: '0 8px 24px rgba(0,0,0,.25)', display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <span style={{ width: 12, height: 12, borderRadius: 6, background: ACCENT, display: 'inline-block' }} />
            {t}
          </div>
        );
      })}
    </div>
  );
};

const Caption: React.FC<{ text: string; delay: number }> = ({ text, delay }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [delay, delay + 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity: o }}>
      <div style={{ maxWidth: 1560, background: 'rgba(10,10,10,.82)', color: '#fff', fontFamily: FONT, fontSize: 34, lineHeight: 1.3, padding: '14px 28px', borderRadius: 16, textAlign: 'center' }}>{text}</div>
    </div>
  );
};

const TeamBox: React.FC = () => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 12, 150, 170], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const rows: [string, string][] = [['Team Lead', 'Shashank G'], ['Member 1', 'Ansu Kumar'], ['Member 2', 'Aman Raj']];
  return (
    <div style={{ position: 'absolute', left: 56, bottom: 150, opacity: o, transform: `translateY(${(1 - o) * 20}px)`, background: '#fff', borderRadius: 18, padding: '20px 30px', boxShadow: '0 10px 30px rgba(0,0,0,.18)', fontFamily: FONT, minWidth: 420, border: `2px solid ${INK}` }}>
      <div style={{ fontFamily: MONO, letterSpacing: 4, fontSize: 24, color: ACCENT, fontWeight: 700 }}>TEAM</div>
      <div style={{ fontSize: 56, fontWeight: 800, color: INK, lineHeight: 1.05, marginBottom: 12 }}>ModiFY</div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ fontSize: 28, color: INK, lineHeight: 1.5 }}><span style={{ color: '#777', display: 'inline-block', width: 150 }}>{k}:</span><b>{v}</b></div>
      ))}
    </div>
  );
};

/** wraps a scene: fade in/out + voice-over + caption */
const SceneShell: React.FC<{ frames: number; voKey?: VoKey; voDelay?: number; children: React.ReactNode; captionText?: string }> = ({ frames, voKey, voDelay = 8, children, captionText }) => {
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 8, frames - 8, frames], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: o, background: BG }}>
      {children}
      {voKey && <Sequence from={voDelay}><Audio src={staticFile(`vo/${voKey}.wav`)} /></Sequence>}
      {voKey && <Caption text={captionText ?? vo[voKey]} delay={voDelay} />}
    </AbsoluteFill>
  );
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
          const s = spring({ frame: f - 10 - i * 7, fps: FPS, config: { damping: 20, stiffness: 120 } });
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
  const s = spring({ frame: f - delay, fps: FPS, config: { damping: 20, stiffness: 120 } });
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
  const p = interpolate(f, [delay, delay + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
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
      <Box x={60} y={730} w={470} h={150} delay={28} title="Chroma vector index" sub="case-scoped BGE-M3 search" />
      <Box x={1310} y={730} w={560} h={150} delay={32} title="External AI" items={['Sarvam AI · Google Vision / Translate · LLM API']} />
      <Arrow x1={530} y1={340} x2={640} y2={340} label="REST + JWT" delay={20} />
      <Arrow x1={1200} y1={340} x2={1310} y2={340} label="jobs" delay={28} />
      <Arrow x1={920} y1={660} x2={920} y2={730} delay={34} />
      <Arrow x1={1590} y1={660} x2={1590} y2={730} delay={38} />
      <Arrow x1={1310} y1={560} x2={530} y2={780} delay={42} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 34, display: 'flex', justifyContent: 'center', opacity: t, transform: `translateY(${(1 - t) * 16}px)` }}>
        <div style={{ background: INK, color: '#fff', borderRadius: 18, padding: '16px 40px', fontSize: 40, fontWeight: 700 }}>
          TraceVault <span style={{ color: ACCENT }}>·</span> From scattered screenshots to a case that holds up
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ---------- timeline ---------- */

const fr = (key: VoKey, pad = 0.9, min = 0) => Math.max(Math.round(((dur as Record<string, number>)[key] + pad) * FPS), Math.round(min * FPS));

type SceneDef = { id: string; frames: number; node: (frames: number) => React.ReactNode; voKey?: VoKey; voDelay?: number; captionText?: string };

const scenes: SceneDef[] = [
  {
    id: 'hook', voKey: 'v1', frames: fr('v1', 1.0),
    node: (n) => (<>
      <OffthreadVideo src={staticFile('hook.mp4')} playbackRate={7 / (n / FPS)} muted style={{ width: 1920, height: 1080 }} />
      <TeamBox />
    </>),
  },
  {
    id: 'upload', voKey: 'v2', frames: fr('v2', 1.1),
    node: (n) => (<>
      <OffthreadVideo src={staticFile('upload.mp4')} playbackRate={9 / (n / FPS)} muted style={{ width: 1920, height: 1080 }} />
      <Chips items={['SHA-256 hashing in the browser', 'AES-256-GCM encryption', 'Hash-chained audit log']} />
    </>),
  },
  {
    id: 'ocr-settings', voKey: 'v3a', frames: fr('v3a', 0.8),
    node: (n) => (<>
      <Pan src="settings.png" total={n} keys={[[0, 1480], [1, 1760]]} />
      <Chips items={['Two OCR pipelines', 'RapidOCR on-device (PaddleOCR / ONNX)', 'Sarvam Vision for Indic scripts', 'Privacy modes: local / auto / cloud']} gap={22} />
    </>),
  },
  {
    id: 'ocr-viewer', voKey: 'v3b', frames: fr('v3b', 1.2, 6.2),
    node: (n) => {
      const Cross: React.FC = () => {
        const f = useCurrentFrame();
        const o = interpolate(f, [28, 40], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return <Img src={staticFile('viewer-blur.png')} style={{ position: 'absolute', left: 0, top: 0, width: 1920, opacity: o, transform: 'translateY(-330px)' }} />;
      };
      return (<>
        <Pan src="viewer-open.png" total={n} keys={[[0, 330], [0.35, 330], [1, 1250]]} />
        <Cross />
        <Chips items={['OCR with line boxes', 'Sarvam Translate: labelled machine translation', 'Authenticity check (ELA)']} gap={20} />
      </>);
    },
  },
  {
    id: 'graph', voKey: 'v4', frames: fr('v4', 1.2, 5.5),
    node: (n) => (<>
      <Pan src="graph.png" total={n} keys={[[0, 0], [1, 120]]} zoom={[1, 1.06]} />
      <Chips items={['Entity resolution across sources', 'Knowledge graph (networkx + Cytoscape)', 'Money-mule cluster detection']} gap={18} />
    </>),
  },
  {
    id: 'investigate', voKey: 'v5', frames: fr('v5', 1.0),
    node: (n) => (<>
      <Pan src="investigate.png" total={n} keys={[[0, 690], [0.3, 700], [0.5, 1640], [0.75, 2420], [1, 2950]]} />
      <Chips items={['System1 (Laya) incident classifier', 'LangGraph read-only agents', 'Cited retrieval (BGE-M3 + Chroma)', 'Financial + evidence-gap agents']} gap={26} />
    </>),
  },
  {
    id: 'inconsistencies', voKey: 'v6a', frames: fr('v6a', 1.1, 5.5),
    node: (n) => (<>
      <Pan src="inconsistencies.png" total={n} keys={[[0, 330], [1, 1330]]} />
      <Chips items={['Inconsistency detection', 'Edited-file + amount-mismatch flags']} gap={20} />
    </>),
  },
  {
    id: 'export', voKey: 'v6b', frames: fr('v6b', 1.4),
    node: (n) => (<>
      <Pan src="export.png" total={n} keys={[[0, 180], [1, 650]]} />
      <Chips items={['Section 63 BSA certificate', 'Evidence bundle + offline verify.py', 'OpenTimestamps + RFC 3161']} gap={16} />
    </>),
  },
  {
    id: 'features', voKey: 'v7a', frames: fr('v7a', 1.0, 8),
    node: () => <FeaturesCard />,
  },
  {
    id: 'arch', voKey: 'v7b', voDelay: 100, frames: 100 + fr('v7b', 1.8),
    node: () => <ArchCard taglineAt={100} />,
    captionText: vo.v7b,
  },
];

const starts: number[] = [];
let acc = 0;
for (const s of scenes) { starts.push(acc); acc += s.frames; }
export const TOTAL_FRAMES = acc;

export const Video: React.FC = () => (
  <AbsoluteFill style={{ background: BG }}>
    {scenes.map((s, i) => (
      <Sequence key={s.id} from={starts[i]} durationInFrames={s.frames}>
        <SceneShell frames={s.frames} voKey={s.voKey} voDelay={s.voDelay ?? 10} captionText={s.captionText}>
          {s.node(s.frames)}
        </SceneShell>
      </Sequence>
    ))}
  </AbsoluteFill>
);
