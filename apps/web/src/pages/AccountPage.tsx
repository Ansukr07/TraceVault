import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { patch } from '../lib/api';
import { AppShell, PageHead } from '../ui';

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
    </AppShell>
  );
}
