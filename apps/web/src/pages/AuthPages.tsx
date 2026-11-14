import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DEMO } from '../lib/demo';
import { DotGrid, DotText, Nav } from '../ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr('');
    try {
      const email = String(f.get('email'));
      const password = String(f.get('password'));
      if (isLogin) await login(email, password);
      else await register(email, String(f.get('name')), password);
      nav('/cases');
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function demo() {
    if (!DEMO) return;
    setBusy(true);
    setErr('');
    try {
      await login(DEMO.email, DEMO.password);
      nav('/cases');
    } catch (x) {
      setErr(`Demo account unavailable: ${(x as Error).message}`);
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
            <p className="muted" style={{ fontSize: 14, marginBottom: 24 }}>
              {isLogin ? 'Your evidence stays sealed and only visible to you and people you share with.' : 'Only you can see your cases until you choose to share them.'}
            </p>
            <form onSubmit={submit} className="stack">
              {!isLogin && <label className="field">Name<input name="name" required autoComplete="name" /></label>}
              <label className="field">Email<input name="email" type="email" required autoComplete="email" /></label>
              <label className="field">
                <span>Password {!isLogin && <span className="hint">· at least 10 characters</span>}</span>
                <input name="password" type="password" required minLength={isLogin ? 1 : 10} autoComplete={isLogin ? 'current-password' : 'new-password'} />
              </label>
              {err && <p role="alert" className="err">{err}</p>}
              <button className="btn btn-dark" style={{ height: 46, marginTop: 4 }} disabled={busy}>
                {busy ? 'Please wait…' : isLogin ? 'Sign in' : 'Create account'}
              </button>
            </form>
            {DEMO && (
              <>
                <p className="eyebrow" style={{ textAlign: 'center', margin: '20px 0 12px' }}>or</p>
                <button type="button" className="btn btn-light" style={{ width: '100%', justifyContent: 'center' }} onClick={demo} disabled={busy}>
                  <span className="tile"><DotGrid /></span>Try the demo account
                </button>
              </>
            )}
          </div>
          <p className="muted" style={{ fontSize: 14, textAlign: 'center', marginTop: 20 }}>
            {isLogin ? <>No account? <Link to="/register" className="ink">Create one</Link></> : <>Have an account? <Link to="/login" className="ink">Sign in</Link></>}
          </p>
        </div>
      </main>
    </>
  );
}
