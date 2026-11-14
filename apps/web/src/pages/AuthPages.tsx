import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DEMOS, type DemoAccount } from '../lib/demo';
import { homeFor } from '../lib/roles';
import { DotGrid, DotText, Nav } from '../ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const roleParam = params.get('as');

  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  const [accountType, setAccountType] = useState<'citizen' | 'officer'>(roleParam === 'officer' ? 'officer' : 'citizen');

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr('');
    try {
      const email = String(f.get('email')).trim();
      const password = String(f.get('password'));
      let user;
      if (isLogin) {
        user = await login(email, password);
      } else {
        const name = String(f.get('name')).trim();
        const extra = accountType === 'officer' ? {
          accountType: 'officer' as const,
          officer: {
            agency: String(f.get('agency')).trim(),
            unit: String(f.get('unit')).trim(),
            rank: String(f.get('rank') || '').trim(),
            badgeId: String(f.get('badgeId')).trim(),
          }
        } : { accountType: 'citizen' as const };
        user = await register(email, name, password, extra);
      }

      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(user));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function demo(d: DemoAccount) {
    setBusy(true);
    setErr('');
    try {
      const user = await login(d.email, d.password);
      // Land on the role's own home (a lawyer is an ordinary account, so homeFor() alone can't tell).
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : d.home || homeFor(user));
    } catch (x) {
      setErr(`The ${d.label.toLowerCase()} demo isn't set up yet (${(x as Error).message}). Run "npm run ${d.seed}" once, then try again.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="auth">
        <div className="auth-card">
          <p className="dot" aria-hidden="true"><DotText>{isLogin ? 'Welcome back.' : 'Begin.'}</DotText></p>
          <div className="card">
            <p className="eyebrow" style={{ marginBottom: 10 }}>{isLogin ? 'Sign in' : 'Create account'}</p>
            <h1 style={{ fontSize: 26, marginBottom: 6 }}>{isLogin ? 'Open your case files' : 'Start a private case file'}</h1>
            <p className="muted" style={{ fontSize: 14, marginBottom: 20 }}>
              {isLogin ? 'Your evidence stays sealed and only visible to you and people you share with.' : 'Only you can see your cases until you choose to share them.'}
            </p>

            {!isLogin && (
              <div className="seg" style={{ marginBottom: 18 }}>
                <label>
                  <input type="radio" name="accTypeToggle" checked={accountType === 'citizen'} onChange={() => setAccountType('citizen')} />
                  <span>Citizen / Complainant</span>
                </label>
                <label>
                  <input type="radio" name="accTypeToggle" checked={accountType === 'officer'} onChange={() => setAccountType('officer')} />
                  <span>Police / Officer</span>
                </label>
              </div>
            )}

            <form onSubmit={submit} className="stack">
              {!isLogin && <label className="field">Name<input name="name" required autoComplete="name" /></label>}
              <label className="field">Email<input name="email" type="email" required autoComplete="email" /></label>
              <label className="field">
                <span>Password {!isLogin && <span className="hint">· at least 10 characters</span>}</span>
                <input name="password" type="password" required minLength={isLogin ? 1 : 10} autoComplete={isLogin ? 'current-password' : 'new-password'} />
              </label>

              {!isLogin && accountType === 'officer' && (
                <div className="card" style={{ background: 'var(--paper-2)', padding: 14, marginTop: 4 }}>
                  <p className="eyebrow" style={{ marginBottom: 8 }}>Official credentials</p>
                  <label className="field" style={{ marginBottom: 8 }}>Agency / Department<input name="agency" required placeholder="e.g. Bangalore City Police / Cyber Crime" /></label>
                  <label className="field" style={{ marginBottom: 8 }}>Police Station / Unit<input name="unit" required placeholder="e.g. Cyber Cell Division 1" /></label>
                  <div className="two-col" style={{ gap: 8 }}>
                    <label className="field">Rank / Designation<input name="rank" placeholder="e.g. Inspector" /></label>
                    <label className="field">Badge / Employee ID<input name="badgeId" required placeholder="e.g. BCP-89241" /></label>
                  </div>
                  <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>Officer accounts start pending verification by the platform admin before unverified badges clear.</p>
                </div>
              )}

              {err && <p role="alert" className="err">{err}</p>}
              <button className="btn btn-dark" style={{ height: 46, marginTop: 4 }} disabled={busy}>
                {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
              </button>
            </form>
            {DEMOS && (
              <section aria-label="Demo accounts">
                <p className="eyebrow" style={{ textAlign: 'center', margin: '22px 0 12px' }}>or try a demo as</p>
                <div className="demo-roles">
                  {DEMOS.map((d) => (
                    <button key={d.key} type="button" className="demo-role" onClick={() => demo(d)} disabled={busy}>
                      <span className="tile"><DotGrid /></span>
                      <span className="demo-role-text"><strong>{d.label}</strong><span>{d.hint}</span></span>
                      <span aria-hidden="true" className="dash-go">→</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
          <p className="muted" style={{ fontSize: 14, textAlign: 'center', marginTop: 20 }}>
            {isLogin ? (
              <>No account? <Link to={next ? `/register?next=${encodeURIComponent(next)}` : '/register'} className="ink">Create one</Link></>
            ) : (
              <>Have an account? <Link to={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} className="ink">Sign in</Link></>
            )}
          </p>
        </div>
      </main>
    </>
  );
}
