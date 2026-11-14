import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { patch, post } from '../lib/api';
import { AppShell, PageHead } from '../ui';

// Two-factor (spec A5): setup shows the secret and otpauth link (any authenticator app), then confirms with a code.
function TwoFactor() {
  const { user } = useAuth();
  const [on, setOn] = useState(!!user?.totpEnabled);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<void>) => { setErr(''); try { await fn(); } catch (x) { setErr((x as Error).message); } };
  return (
    <section className="card stack" style={{ gap: 12 }}>
      <div className="card-title"><h3 style={{ fontSize: 18 }}>Two-factor authentication</h3><span className={`badge ${on ? 'ok' : ''}`}>{on ? 'On' : 'Off'}</span></div>
      {recovery ? (
        <>
          <p style={{ fontSize: 13 }}>Save these recovery codes somewhere safe. Each works once if you lose your phone. They won't be shown again.</p>
          <pre className="mono" style={{ fontSize: 13 }}>{recovery.join('\n')}</pre>
          <button type="button" className="btn btn-dark btn-sm" onClick={() => setRecovery(null)}>I saved them</button>
        </>
      ) : !on && !setup ? (
        <>
          <p className="muted" style={{ fontSize: 13 }}>Ask for a code from an authenticator app each time you sign in.</p>
          <button type="button" className="btn btn-dark btn-sm" onClick={() => run(async () => setSetup(await post('/me/totp/setup')))}>Set up</button>
        </>
      ) : !on && setup ? (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await post<{ recoveryCodes: string[] }>('/me/totp/enable', { code }); setRecovery(r.recoveryCodes); setOn(true); setSetup(null); setCode(''); }); }}>
          <p style={{ fontSize: 13 }}>Add this key to your authenticator app (<a href={setup.otpauthUri}>open in app</a>):</p>
          <code className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret}</code>
          <label className="field">6-digit code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} required /></label>
          <button className="btn btn-dark btn-sm">Turn on</button>
        </form>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/me/totp/disable', { password: pw, code }); setOn(false); setPw(''); setCode(''); }); }}>
          <label className="field">Password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required /></label>
          <label className="field">Code or recovery code<input value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--bad)' }}>Turn off</button>
        </form>
      )}
      {err && <p className="err" role="alert">{err}</p>}
    </section>
  );
}

export function AccountPage() {
  const { user, logout } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [uiLang, setUiLang] = useState(user?.uiLanguage || 'en');
  const [voiceLang, setVoiceLang] = useState(user?.voiceLanguage || 'hi-IN');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setSaved(false);
    try {
      await patch('/me', {
        name,
        uiLanguage: uiLang,
        voiceLanguage: voiceLang,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <PageHead
        eyebrow="Account & Preferences (§6.17 · A5, A6)"
        title={<>Your profile <span className="muted">& regional languages</span></>}
      />

      <div className="split" style={{ alignItems: 'start' }}>
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Personal details</h3>
          </div>

          <form onSubmit={handleSave} className="stack" style={{ gap: 14 }}>
            <label className="field">
              Full Name
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>

            <label className="field">
              Email Address
              <input
                type="email"
                disabled
                value={user?.email || ''}
                style={{ background: 'var(--paper-2)' }}
              />
            </label>

            <label className="field">
              Preferred UI Language
              <select value={uiLang} onChange={(e) => setUiLang(e.target.value)}>
                <option value="en">English (Default)</option>
                <option value="hi">हिन्दी (Hindi)</option>
                <option value="kn">ಕನ್ನಡ (Kannada)</option>
                <option value="ta">தமிழ் (Tamil)</option>
                <option value="te">తెలుగు (Telugu)</option>
              </select>
            </label>

            <label className="field">
              Default Speech & Voice Language (Sarvam AI)
              <select value={voiceLang} onChange={(e) => setVoiceLang(e.target.value)}>
                <option value="hi-IN">Hindi (hi-IN)</option>
                <option value="en-IN">Indian English (en-IN)</option>
                <option value="kn-IN">Kannada (kn-IN)</option>
                <option value="ta-IN">Tamil (ta-IN)</option>
                <option value="te-IN">Telugu (te-IN)</option>
                <option value="mr-IN">Marathi (mr-IN)</option>
                <option value="bn-IN">Bengali (bn-IN)</option>
              </select>
            </label>

            {err && <p className="err">{err}</p>}
            {saved && <p className="badge ok">Preferences saved successfully.</p>}

            <button className="btn btn-dark" style={{ height: 42 }} disabled={busy}>
              {busy ? 'Saving…' : 'Save preferences'}
            </button>
          </form>
        </section>

        <div className="stack" style={{ gap: 16 }}>
        <TwoFactor />
        <section className="card stack" style={{ gap: 14 }}>
          <div className="card-title">
            <h3 style={{ fontSize: 18 }}>Active sessions & security</h3>
          </div>
          <div className="kv" style={{ fontSize: 13 }}>
            <dt>Account Role</dt>
            <dd><span className="chip" style={{ textTransform: 'capitalize' }}>{user?.accountType || 'citizen'}</span></dd>
            <dt>Security Tokens</dt>
            <dd>Argon2id password hash + rotating HTTP-only cookies</dd>
            <dt>Device Session</dt>
            <dd>Active on this browser</dd>
          </div>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-ghost" onClick={logout} style={{ color: 'var(--bad)' }}>
              Sign out of this device
            </button>
          </div>
        </section>
        </div>
      </div>
    </AppShell>
  );
}
