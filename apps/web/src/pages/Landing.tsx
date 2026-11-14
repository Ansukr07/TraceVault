import { Link } from 'react-router-dom';
import { FlowerField } from '../FlowerField';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { DotArrow, DotText, LightButton, LogoMark, Nav } from '../ui';

/* ---------- hero connector diagram ---------- */
const W = 980;
const H = 300;
const PATHS = {
  tl: 'M0 40 H320 C362 40 372 52 404 84',
  tr: `M${W} 40 H660 C618 40 608 52 576 84`,
  mr: `M${W} 150 H586`,
  bl: `M0 260 H320 C362 260 372 248 404 216`,
  br: `M${W} 260 H660 C618 260 608 248 576 216`,
};
const PULSE_S = 4;
const DOTS: [number, number][] = [[40, 40], [290, 40], [310, 260], [690, 40], [690, 150], [690, 260]];
const CHIPS: { label: string; x: number; y: number }[] = [
  { label: 'WhatsApp', x: 112, y: 40 },
  { label: 'Screenshot', x: 206, y: 40 },
  { label: 'Voice note', x: 125, y: 260 },
  { label: 'Email', x: 220, y: 260 },
  { label: 'Sealed', x: 810, y: 40 },
  { label: 'Timeline', x: 810, y: 150 },
  { label: 'Cited report', x: 810, y: 260 },
];

function Pulse({ path, dur, begin, out }: { path: string; dur: number; begin: number; out?: boolean }) {
  return (
    <circle className="pulse" r="2.4" opacity="0">
      <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={path} {...(out ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})} />
      <animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.1;0.85;1" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
    </circle>
  );
}

function Diagram() {
  return (
    <div className="diagram" aria-hidden="true">
      <svg className="lines" viewBox={`0 0 ${W} ${H}`} fill="none">
        {Object.values(PATHS).map((d) => <path key={d} d={d} stroke="var(--line-strong)" strokeWidth="1" />)}
        {DOTS.map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="3.5" fill="var(--ink)" />)}
        {/* every dot starts together, same speed, always left → right */}
        <Pulse path={PATHS.tl} dur={PULSE_S} begin={0} />
        <Pulse path={PATHS.bl} dur={PULSE_S} begin={0} />
        <Pulse path={PATHS.tr} dur={PULSE_S} begin={0} out />
        <Pulse path={PATHS.mr} dur={PULSE_S} begin={0} out />
        <Pulse path={PATHS.br} dur={PULSE_S} begin={0} out />
      </svg>
      {CHIPS.map((c) => (
        <span key={c.label} className="chip" style={{ left: `${(c.x / W) * 100}%`, top: `${(c.y / H) * 100}%` }}>{c.label}</span>
      ))}
      <div className="core">
        <div><LogoMark size={96} /></div>
      </div>
    </div>
  );
}

/* ---------- page ---------- */
export function Landing() {
  const { user } = useAuth();
  const health = useQuery<{ db: string; ml: string }>({
    queryKey: ['health'],
    refetchInterval: 10000,
    queryFn: async () => (await fetch('/api/v1/health')).json(),
  });
  const start = user ? '/cases/new' : '/register';
  const up = (s?: string) => (s === 'ok' || s === 'up' ? 'up' : s ? 'down' : '');

  return (
    <>
      <Nav variant="marketing" />
      <main>
        <section className="hero wrap" id="how">
          <h1 className="dot hero-word" aria-label="Collect. Seal. Prove.">
            <DotText>Collect. Seal.</DotText>
          </h1>
          <Diagram />
          <p className="dot hero-word" aria-hidden="true"><DotText>Prove.</DotText></p>
          <p className="hero-sub">TraceVault turns scattered chats, screenshots and voice notes into one sealed case file, cited line by line.</p>
          <div className="row" style={{ justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Link to={start} className="btn btn-cta">
              <span className="tile"><DotArrow /></span>
              Start a case
            </Link>
            <Link to="/login?as=officer" className="btn btn-ghost" style={{ alignSelf: 'center', fontSize: 13, textDecoration: 'none' }}>
              For police & officials →
            </Link>
          </div>
        </section>

        <section className="band" id="integrity" aria-label="Guarantees">
          <div>
            <p className="eyebrow">◆ Cited summaries</p>
            <p className="dot stat-num">100%</p>
            <p className="stat-cap">Of summary sentences link to their source</p>
          </div>
          <div>
            <p className="eyebrow">◆ Sealed originals</p>
            <p className="dot stat-num">0 bytes</p>
            <p className="stat-cap">Changed in the files you upload</p>
          </div>
          <div>
            <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--ink-2)' }}>
              Upload your evidence. Our models read, link and date-order chats, images, voice notes and email, in English, Hindi and Hinglish.
            </p>
            <div><LightButton to={start}>Sign up</LightButton></div>
          </div>
        </section>

        <section className="wrap intro" id="languages">
          <div className="copy">
            <h2>
              Introducing the case file<br />
              <span className="muted">One timeline rebuilt </span>
              <span className="muted">from </span>everything<br />you saved
            </h2>
            <div className="stack" style={{ gap: 24 }}>
              <p className="lede">A sealed record that links people, dates and amounts across every source, and flags what doesn't add up.</p>
              <div><LightButton to={start}>Read more</LightButton></div>
            </div>
          </div>
          <FlowerField />
        </section>

        <section className="wrap closing" id="sharing">
          <h2>Trace any claim down to a single message, <span className="muted">and make sure it holds up</span></h2>
          <p>Share a case with a lawyer or police for a limited time, with every hash attached.</p>
        </section>
      </main>
      <footer className="footer">
        <div className="wrap row">
          <span className="row" style={{ gap: 10 }}><LogoMark size={20} /> TraceVault</span>
          <span className="mono" style={{ fontSize: 11 }}>
            <span className={`status-dot ${up(health.data?.db)}`} />DB {health.data?.db ?? '…'}
            <span style={{ display: 'inline-block', width: 16 }} />
            <span className={`status-dot ${up(health.data?.ml)}`} />ML {health.data?.ml ?? '…'}
          </span>
        </div>
      </footer>
    </>
  );
}
