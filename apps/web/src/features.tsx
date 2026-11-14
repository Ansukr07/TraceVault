// Demo-facing features from the future-advancement spec:
//   F1 authenticity (panel + "needs attention" queue), F5 safety (escalation gauge, quick exit, discreet mode).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { CitationChip } from './components';
import { LANGS, currentLang, giveConsent, hasConsent, startTranslation, switchLang } from './lib/gtranslate';

// ---------------------------------------------------------------- gauge
const LEVEL = {
  low: { color: 'var(--ok)', label: 'Low', icon: '●' },
  elevated: { color: 'var(--warn)', label: 'Elevated', icon: '▲' },
  high: { color: 'var(--bad)', label: 'High', icon: '◆' },
} as const;
type Level = keyof typeof LEVEL;

/** Half-circle gauge. Colour is never the only signal: the level is also written out with an icon. */
export function Gauge({ value, level, caption }: { value: number; level: Level; caption: string }) {
  const L = LEVEL[level];
  const len = Math.PI * 90;
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const t = requestAnimationFrame(() => setShown(value)); // animate from empty on mount
    return () => cancelAnimationFrame(t);
  }, [value]);
  const angle = -90 + (Math.min(100, Math.max(0, shown)) / 100) * 180;
  return (
    <figure className="gauge" role="img" aria-label={`${caption}: ${L.label}, ${value} out of 100`}>
      <svg viewBox="0 0 200 112" width="100%">
        <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke="var(--line)" strokeWidth="14" strokeLinecap="round" />
        <path d="M 10 100 A 90 90 0 0 1 190 100" fill="none" stroke={L.color} strokeWidth="14" strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - shown / 100)} style={{ transition: 'stroke-dashoffset 900ms cubic-bezier(.2,.8,.2,1)' }} />
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '100px 100px', transition: 'transform 900ms cubic-bezier(.2,.8,.2,1)' }}>
          <line x1="100" y1="100" x2="100" y2="28" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
        </g>
        <circle cx="100" cy="100" r="7" fill="var(--ink)" />
      </svg>
      <figcaption>
        <span className="gauge-num" style={{ color: L.color }}>{value}</span>
        <span className="gauge-level" style={{ color: L.color }}><span aria-hidden>{L.icon}</span> {L.label}</span>
        <span className="eyebrow">{caption}</span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------- F5 escalation risk
type Risk = {
  score: number; level: Level; disclaimer: string;
  signals: { id: string; label: string; weight: number; detail: string; citations: string[] }[];
  resources: { verifyBeforeLaunch: boolean; items: { name: string; phone: string; url?: string; note: string }[] } | null;
};

export function RiskCard({ caseId, role }: { caseId: string; role?: string }) {
  const allowed = role === 'owner' || role === 'collaborator';
  const q = useQuery({ queryKey: ['risk', caseId], queryFn: () => api<{ risk: Risk }>(`/cases/${caseId}/risk`).then((r) => r.risk), enabled: allowed, retry: false });
  if (!allowed || !q.data) return null;
  const r = q.data;
  const max = Math.max(1, ...r.signals.map((s) => s.weight));
  return (
    <section className={`card risk risk-${r.level}`} aria-label="Escalation risk">
      <div className="card-title">
        <h2 style={{ fontSize: 18 }}>How serious is this getting?</h2>
        <span className="eyebrow">Private to you</span>
      </div>
      <div className="risk-grid">
        <Gauge value={r.score} level={r.level} caption="Escalation indicator" />
        <div className="stack" style={{ gap: 10 }}>
          {r.signals.length === 0 && <p className="muted">No higher-risk patterns found in the evidence so far.</p>}
          {r.signals.map((s) => (
            <div key={s.id} className="signal-row">
              <div className="row" style={{ gap: 8 }}>
                <strong style={{ fontWeight: 500, fontSize: 14 }}>{s.label}</strong>
                <span className="mono muted" style={{ fontSize: 11 }}>+{s.weight}</span>
              </div>
              <div className="signal-bar"><i style={{ width: `${(s.weight / max) * 100}%` }} /></div>
              <p className="muted" style={{ fontSize: 12.5 }}>{s.detail} {s.citations.map((c) => <CitationChip key={c} id={c} caseId={caseId} />)}</p>
            </div>
          ))}
        </div>
      </div>
      {r.resources && (
        <div className="help">
          <p className="eyebrow">If you need help now</p>
          <ul>
            {r.resources.items.map((h) => (
              <li key={h.phone}>
                <a className="help-num" href={`tel:${h.phone}`}>{h.phone}</a>
                <span><strong style={{ fontWeight: 500 }}>{h.name}</strong><br /><span className="muted" style={{ fontSize: 12 }}>{h.note}{h.url && <> · <a href={h.url} target="_blank" rel="noreferrer noopener">{h.url.replace('https://', '')}</a></>}</span></span>
              </li>
            ))}
          </ul>
          {r.resources.verifyBeforeLaunch && <p className="muted" style={{ fontSize: 11 }}>Numbers are shown for the demo and must be re-verified by an advocate before real use.</p>}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>{r.disclaimer}</p>
    </section>
  );
}

// ---------------------------------------------------------------- F1 authenticity
type Check = { id: string; status: 'pass' | 'warn' | 'fail' | 'info' | 'not_applicable'; title: string; summary: string; score?: number };
export type Authenticity = { riskIndicator: number; band: 'low' | 'medium' | 'high'; checks: Check[]; regions: { bbox: number[]; label: string }[]; heatmap: string | null; disclaimer: string; software?: string | null };
const BAND = { low: { label: 'Low', level: 'low' }, medium: { label: 'Medium', level: 'elevated' }, high: { label: 'High', level: 'high' } } as const;
const ST = { pass: ['✓', 'ok'], warn: ['!', 'warn'], fail: ['✕', 'bad'], info: ['i', 'muted'], not_applicable: ['–', 'muted'] } as const;

export const useAuthenticity = (evidenceId: string) =>
  useQuery({ queryKey: ['authenticity', evidenceId], queryFn: () => api<{ authenticity: Authenticity }>(`/evidence/${evidenceId}/authenticity`).then((r) => r.authenticity), retry: false, staleTime: 5 * 60_000 });

export function AuthenticityPanel({ evidenceId, opacity, setOpacity }: { evidenceId: string; opacity: number; setOpacity: (n: number) => void }) {
  const q = useAuthenticity(evidenceId);
  if (q.isLoading) return <section className="card"><div className="card-title"><h3>Authenticity</h3></div><p className="muted">Analysing file…</p></section>;
  if (q.error || !q.data) return <section className="card"><div className="card-title"><h3>Authenticity</h3></div><p className="muted">Could not analyse this file.</p></section>;
  const a = q.data;
  const B = BAND[a.band];
  return (
    <section className="card auth" aria-label="Authenticity indicators">
      <div className="card-title"><h3>Authenticity</h3><span className={`badge ${a.band === 'high' ? 'bad' : a.band === 'medium' ? 'warn' : 'ok'}`}>{B.label} risk of alteration</span></div>
      <div className="risk-grid" style={{ gridTemplateColumns: 'minmax(120px, 170px) 1fr' }}>
        <Gauge value={a.riskIndicator} level={B.level} caption="Indicator" />
        <ul className="checks">
          {a.checks.map((c) => (
            <li key={c.id}>
              <span className={`ck ${ST[c.status][1]}`} aria-label={c.status}>{ST[c.status][0]}</span>
              <span><strong style={{ fontWeight: 500 }}>{c.title}</strong><br /><span className="muted" style={{ fontSize: 12.5 }}>{c.summary}</span></span>
            </li>
          ))}
        </ul>
      </div>
      {a.heatmap && (
        <label className="heat-slider">
          <span className="eyebrow">Original</span>
          <input type="range" min={0} max={100} value={Math.round(opacity * 100)} onChange={(e) => setOpacity(Number(e.target.value) / 100)} aria-label="Blend between the original and the error-level heatmap" />
          <span className="eyebrow">Error-level heatmap</span>
        </label>
      )}
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>{a.disclaimer}</p>
    </section>
  );
}

type Rollup = { counts: { high: number; medium: number; low: number }; items: { evidenceId: string; idx: number; filename: string; kind: string; riskIndicator: number | null; band: string; reason: string | null }[] };

/** Overview card: which files most need a second look. */
export function AttentionCard({ caseId }: { caseId: string }) {
  const q = useQuery({ queryKey: ['authenticity-rollup', caseId], queryFn: () => api<Rollup>(`/cases/${caseId}/authenticity`), retry: false, staleTime: 60_000 });
  if (!q.data || q.data.items.length === 0) return null;
  const d = q.data;
  const flagged = d.items.filter((i) => i.band === 'high' || i.band === 'medium');
  return (
    <section className="card" aria-label="Evidence needing attention">
      <div className="card-title">
        <h2 style={{ fontSize: 18 }}>Evidence needing attention</h2>
        <span className="row" style={{ gap: 6 }}>
          {d.counts.high > 0 && <span className="badge bad">{d.counts.high} high</span>}
          {d.counts.medium > 0 && <span className="badge warn">{d.counts.medium} medium</span>}
          <span className="badge ok">{d.counts.low} look consistent</span>
        </span>
      </div>
      {flagged.length === 0 && <p className="muted">No file shows signs of editing in its metadata or compression.</p>}
      <ul className="list">
        {flagged.map((i) => (
          <li key={i.evidenceId}>
            <div className="row">
              <Link to={`/cases/${caseId}/evidence/${i.evidenceId}`}><span className="mono muted">E{i.idx}</span> {i.filename}</Link>
              <span className={`badge ${i.band === 'high' ? 'bad' : 'warn'}`}>{i.riskIndicator}</span>
            </div>
            {i.reason && <p className="muted" style={{ fontSize: 13 }}>{i.reason}</p>}
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Indicators only: they tell you where to look, not what is true.</p>
    </section>
  );
}

// ---------------------------------------------------------------- F5 quick exit + discreet mode
const EXIT_URL = 'https://www.google.com';
const store = {
  get: () => { try { return localStorage.getItem('tv_discreet') === '1'; } catch { return false; } },
  set: (v: boolean) => { try { localStorage.setItem('tv_discreet', v ? '1' : '0'); } catch { /* storage blocked */ } },
};

function quickExit() {
  try { sessionStorage.clear(); } catch { /* ignore */ }
  window.location.replace(EXIT_URL); // replace(): the case page is not left in the Back-button history
}

const CONSENT_TEXT = [
  'Google Translate will translate the page labels and buttons.',
  'The text of this page is sent to Google to do that. To protect your evidence, messages, transcripts, names, identifiers, summaries and timeline events are NOT sent: they stay in the original language (use the built-in translation next to each item).',
  'Choose OK to continue. English never contacts Google.',
].join('\n\n');

/** Language picker. Nothing contacts Google until a non-English language is chosen and this notice is accepted. */
function LanguageSwitch() {
  const [lang] = useState(currentLang);
  useEffect(() => startTranslation(), []);
  const pick = (code: string) => {
    if (code === lang) return;
    if (code !== 'en' && !hasConsent()) {
      if (!window.confirm(CONSENT_TEXT)) return;
      giveConsent();
    }
    switchLang(code);
  };
  return (
    <label className="sb-lang notranslate" translate="no">
      <span aria-hidden>🌐</span>
      <select value={lang} onChange={(e) => pick(e.target.value)} aria-label="Language">
        {LANGS.map(([c, l]) => <option key={c} value={c}>{l}</option>)}
      </select>
    </label>
  );
}

/** Floating controls. Language for everyone; Quick exit and Discreet mode once signed in. */
export function SafetyBar({ signedIn = true }: { signedIn?: boolean }) {
  const [discreet, setDiscreet] = useState(store.get);
  useEffect(() => {
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const now = Date.now();
      if (now - last < 600) quickExit();
      last = now;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const original = document.title;
    if (discreet) {
      document.title = 'Notes';
      document.documentElement.dataset.discreet = '1';
    } else {
      delete document.documentElement.dataset.discreet;
    }
    const keep = new MutationObserver(() => { if (discreet && document.title !== 'Notes') document.title = 'Notes'; });
    keep.observe(document.querySelector('title') ?? document.head, { childList: true, subtree: true, characterData: true });
    return () => { keep.disconnect(); if (discreet) document.title = original; };
  }, [discreet]);
  return (
    <div className="safety-bar" role="region" aria-label="Safety controls">
      <LanguageSwitch />
      {signedIn && <>
      <button type="button" className={`sb-toggle${discreet ? ' on' : ''}`} aria-pressed={discreet} title="Shows a neutral tab title and hides the product name" onClick={() => { store.set(!discreet); setDiscreet(!discreet); }}>
        {discreet ? 'Discreet: on' : 'Discreet mode'}
      </button>
      <button type="button" className="sb-exit" onClick={quickExit} title="Leave immediately (or press Esc twice)">Quick exit <kbd>Esc Esc</kbd></button>
      </>}
      {currentLang() !== 'en' && <span className="sb-note notranslate" translate="no">Translated by Google Translate</span>}
    </div>
  );
}
