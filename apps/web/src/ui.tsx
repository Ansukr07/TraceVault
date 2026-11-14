import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { DEMO } from './lib/demo';
import { homeFor } from './lib/roles';

/**
 * TraceVault mark: an ink squircle holding a 5×5 dot grid. A "V" of dots (vault, verify)
 * converges on one orange dot, the point every trace resolves to. Same geometry in
 * /public/favicon.svg.
 */
const V_DOTS: [number, number][] = [[0, 0], [0, 4], [1, 0], [1, 4], [2, 1], [2, 3], [3, 1], [3, 3]];
export function LogoMark({ size = 28, color = 'var(--ink)', hole = '#ffffff', accent = 'var(--signal)' }: { size?: number; color?: string; hole?: string; accent?: string }) {
  const P = 4.6, O = 16 - 2 * P; // grid pitch and origin
  const pos = (r: number, c: number) => ({ cx: O + c * P, cy: O + r * P });
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9.5" fill={color} />
      {[0, 1, 2, 3, 4].flatMap((r) => [0, 1, 2, 3, 4].map((c) => <circle key={`g${r}${c}`} {...pos(r, c)} r="0.7" fill={hole} opacity="0.22" />))}
      {V_DOTS.map(([r, c]) => <circle key={`v${r}${c}`} {...pos(r, c)} r="1.6" fill={hole} />)}
      <circle {...pos(4, 2)} r="1.9" fill={accent} />
    </svg>
  );
}

/** 3×3 dot grid used inside light-button tiles. */
export function DotGrid({ color = '#fff' }: { color?: string }) {
  const pts = [0, 1, 2, 3, 4];
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {pts.flatMap((r) => pts.map((c) => <circle key={`${r}${c}`} className="dg" style={{ animationDelay: `${(r + c) * 55}ms` }} cx={1.8 + c * 3.6} cy={1.8 + r * 3.6} r={(r + c) % 2 ? 0.75 : 1.05} fill={color} opacity={(r === 2 || c === 2) ? 1 : 0.55} />))}
    </svg>
  );
}

/** Dotted arrow used in the orange CTA tile. */
export function DotArrow() {
  const dots: [number, number][] = [[2, 9], [5, 9], [8, 9], [11, 9], [14, 9], [11, 6], [11, 12], [8, 3], [8, 15], [9.5, 4.5], [9.5, 13.5]];
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {dots.map(([x, y], i) => <circle key={i} className="da" style={{ animationDelay: `${i * 40}ms` }} cx={x} cy={y} r="1.05" fill="#fff" />)}
    </svg>
  );
}

/** Dot-matrix text where "." renders as one round dot (Doto's period glyph reads as a cross). */
export function DotText({ children }: { children: string }) {
  const parts = children.split('.');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>{p}{i < parts.length - 1 && <span className="pd" aria-hidden="true" />}</span>
      ))}
    </>
  );
}

export function LightButton({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="btn btn-light">
      <span className="tile"><DotGrid /></span>
      {children}
    </Link>
  );
}

const SECTIONS = [['how', 'How it works'], ['integrity', 'Integrity'], ['languages', 'Languages'], ['sharing', 'Sharing']] as const;

export function Nav({ variant = 'app' }: { variant?: 'marketing' | 'app' }) {
  const { user, login, logout } = useAuth();
  const { pathname } = useLocation();
  const go = useNavigate();
  // Lawyers / NGO counsellors are ordinary accounts; show their inbox only once something is shared with them.
  const shared = useQuery({
    queryKey: ['officerCases'],
    queryFn: () => api<{ cases: { role: string }[] }>('/officer/cases'),
    enabled: !!user && (user.accountType ?? 'citizen') === 'citizen',
    staleTime: 60_000,
  });
  const hasLegalShares = !!shared.data?.cases.some((c) => c.role === 'legal');
  const [demoBusy, setDemoBusy] = useState(false);
  async function tryDemo() {
    if (!DEMO) return;
    setDemoBusy(true);
    try {
      await login(DEMO.email, DEMO.password);
      go('/cases');
    } catch {
      go('/login'); // demo account missing: fall back to the form, which shows the error path
    } finally {
      setDemoBusy(false);
    }
  }
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [active, setActive] = useState('');
  const shell = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(close, [pathname]);

  // lift the bar once the page scrolls
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);

  // highlight the section in view (landing page)
  useEffect(() => {
    if (variant !== 'marketing') return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: '-35% 0px -55% 0px' },
    );
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [variant]);

  // Esc / outside click closes the mobile menu
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const away = (e: PointerEvent) => { if (shell.current && !shell.current.contains(e.target as Node)) close(); };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', away);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', away); };
  }, [open]);

  const links = (
    <>
      {variant === 'marketing'
        ? SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className={active === id ? 'active' : ''} aria-current={active === id ? 'true' : undefined} onClick={close}>{label}</a>
          ))
        : user && (
            <>
              {user.accountType === 'officer' ? (
                <>
                  <NavLink to="/officer" end onClick={close}>Officer Inbox</NavLink>
                  <NavLink to="/officer/verify" onClick={close}>Verify</NavLink>
                  <NavLink to="/officer/profile" onClick={close}>Profile</NavLink>
                </>
              ) : user.accountType === 'official' ? (
                <>
                  <NavLink to="/oversight" end onClick={close}>Oversight</NavLink>
                  <NavLink to="/cases" onClick={close}>Cases</NavLink>
                </>
              ) : (
                <>
                  <NavLink to="/cases" end onClick={close}>Cases</NavLink>
                  <NavLink to="/cases/new" onClick={close}>New case</NavLink>
                  {hasLegalShares && <NavLink to="/legal" onClick={close}>Shared with me</NavLink>}
                </>
              )}
              {user.isAdmin && <NavLink to="/admin" onClick={close}>Admin</NavLink>}
              <NavLink to="/account" onClick={close}>Account</NavLink>
            </>
          )}
    </>
  );
  const hasLinks = variant === 'marketing' || !!user;

  return (
    <div ref={shell} className={`nav-shell${scrolled ? ' scrolled' : ''}`}>
      <nav className="nav" aria-label="Main">
        <Link to="/" className="nav-logo" aria-label="TraceVault home">
          <LogoMark />
          <span>TraceVault</span>
        </Link>
        <div className="nav-links">{links}</div>
        <div className="nav-right">
          {user ? (
            <>
              <span className="who">{user.name}</span>
              {variant === 'marketing' ? (
                <Link to={homeFor(user)} className="btn btn-dark">{user.accountType === 'officer' ? 'Open inbox' : user.accountType === 'official' ? 'Open dashboard' : user.isAdmin ? 'Open admin' : 'Open cases'}</Link>
              ) : (
                <button className="btn btn-ghost" onClick={logout}>Sign out</button>
              )}
            </>
          ) : (
            <>
              {DEMO && <button type="button" className="btn btn-ghost hide-sm" onClick={tryDemo} disabled={demoBusy}>{demoBusy ? 'Signing in…' : 'Try demo'}</button>}
              <Link to="/login" className="btn-text hide-sm" style={{ textDecoration: 'none' }}>Log in</Link>
              <Link to="/register" className="btn btn-dark">Get started</Link>
            </>
          )}
          {(hasLinks || !user) && (
            <button
              type="button"
              className="nav-toggle"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="nav-menu"
              onClick={() => setOpen((o) => !o)}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                {open ? <path d="M4 4l10 10M14 4L4 14" /> : <path d="M3 5h12M3 9h12M3 13h12" />}
              </svg>
            </button>
          )}
        </div>
      </nav>
      <div id="nav-menu" className={`nav-menu${open ? ' open' : ''}`}>
        {links}
        {!user && (
          <div className="menu-actions">
            {DEMO && <button type="button" className="btn btn-dark" onClick={() => { close(); tryDemo(); }} disabled={demoBusy}>Try demo</button>}
            <Link to="/login" className="btn btn-ghost" onClick={close}>Log in</Link>
          </div>
        )}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <Nav />
      <main className="wrap page">{children}</main>
    </>
  );
}

export function PageHead({ eyebrow, title, actions }: { eyebrow: string; title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}
