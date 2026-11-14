import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { del, patch } from '../../lib/api';
import { useCase } from '../../lib/case';
import { CaseShell } from '../../components';

const LLM = [
  ['cloud_redacted', 'Claude, with names and numbers replaced by placeholders before sending (recommended)'],
  ['cloud', 'Claude, full text'],
  ['local', 'Local model only: nothing leaves this server'],
];
const TRANSLATE = [
  ['sarvam_redacted', 'Sarvam Translate, with personal details replaced first (recommended)'],
  ['sarvam', 'Sarvam Translate, full text'],
  ['off', 'No translation'],
];

export function SettingsPage() {
  const { id = '' } = useParams();
  const c = useCase(id);
  const qc = useQueryClient();
  const nav = useNavigate();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState('');
  const s = c.data?.settings;
  const owner = c.data?.role === 'owner';

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr('');
    setMsg('');
    const voiceConsent = f.get('voiceConsent') === 'on';
    try {
      await patch(`/cases/${id}/settings`, {
        llmMode: f.get('llmMode'),
        translateMode: f.get('translateMode'),
        voiceMode: voiceConsent ? 'sarvam' : 'local',
        voiceConsent,
        timezone: f.get('timezone'),
      });
      setMsg('Saved. The change is recorded in the audit log.');
      qc.invalidateQueries({ queryKey: ['case', id] });
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function remove() {
    try {
      await del(`/cases/${id}`, { confirmTitle: confirm });
      nav('/cases');
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  if (!c.data || !s) return <CaseShell><p className="muted">Loading…</p></CaseShell>;
  return (
    <CaseShell>
      <form className="card stack" style={{ gap: 22 }} onSubmit={save} key={JSON.stringify(s)}>
        <div>
          <h2 style={{ fontSize: 20 }}>Privacy</h2>
          <p className="muted" style={{ fontSize: 14 }}>Choose which providers may see this case. Only the owner can change this.</p>
        </div>
        <fieldset className="field" disabled={!owner} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 8 }}>Summaries & questions (AI model)</legend>
          {LLM.map(([v, label]) => <label key={v} className="consent"><input type="radio" name="llmMode" value={v} defaultChecked={s.llmMode === v} /><span>{label}</span></label>)}
        </fieldset>
        <fieldset className="field" disabled={!owner} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 8 }}>Voice notes</legend>
          <label className="consent">
            <input type="checkbox" name="voiceConsent" defaultChecked={s.voiceMode === 'sarvam' && !!s.voiceConsentAt} />
            <span>
              Send voice notes to <strong>Sarvam AI</strong>, an Indian speech provider, for transcription, translation and read-aloud. Audio can’t be anonymised
              before transcription. Without this, voice notes are transcribed on this server only, with no translation or read-aloud.
            </span>
          </label>
        </fieldset>
        <fieldset className="field" disabled={!owner} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ marginBottom: 8 }}>Translating non-English text</legend>
          {TRANSLATE.map(([v, label]) => <label key={v} className="consent"><input type="radio" name="translateMode" value={v} defaultChecked={s.translateMode === v} /><span>{label}</span></label>)}
        </fieldset>
        <label className="field">Case timezone<input name="timezone" defaultValue={c.data.timezone} disabled={!owner} /></label>
        {msg && <p className="badge ok">{msg}</p>}
        {err && <p className="err">{err}</p>}
        {owner && <div><button className="btn btn-dark">Save settings</button></div>}
      </form>

      {owner && (
        <section className="card stack" style={{ gap: 12 }}>
          <h2 style={{ fontSize: 20, color: 'var(--bad)' }}>Delete case</h2>
          <p className="muted" style={{ fontSize: 14 }}>Derived data is removed and the case disappears for everyone it was shared with. The audit log keeps a deletion record with the evidence hashes.</p>
          <label className="field">Type the case title to confirm<input value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          <div><button type="button" className="btn btn-danger" disabled={confirm !== c.data.title} onClick={remove}>Delete this case</button></div>
        </section>
      )}
    </CaseShell>
  );
}
