import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken, post } from '../../lib/api';
import { fmtDate, useCase, useEvidence } from '../../lib/case';
import { CaseShell } from '../../components';
import { DotGrid, PageHead } from '../../ui';

export function ExportPage() {
  const { id = '' } = useParams();
  const c = useCase(id);
  const ev = useEvidence(id);

  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [bundleGenerating, setBundleGenerating] = useState(false);
  const [certGenerating, setCertGenerating] = useState(false);
  const [includeAudioTranscripts, setIncludeAudioTranscripts] = useState(true);

  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const info = useQuery({
    queryKey: ['export', id],
    queryFn: () => api<{ evidenceCount: number; merkleRoot: string; auditHead: string; auditCount: number; chainOk: boolean; scope: string; available: { report: boolean; certificate: boolean; bundle: boolean }; bundleBlockedReason: string | null; hasSigningKey: boolean }>(`/cases/${id}/export`),
  });

  /** Authenticated download: files are never served from a public path. */
  async function download(path: string, fallbackName: string, setBusy: (b: boolean) => void) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/v1/cases/${id}/export/${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `Export failed (${r.status})`);
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMsg({ tone: 'ok', text: `Downloaded ${name}. The export was recorded in the audit log.` });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const qc = useQueryClient();
  const stamps = useQuery({ queryKey: ['timestamps', id], queryFn: () => api<{ timestamps: { index: number; root: string; calendar: string; at: string }[] }>(`/cases/${id}/timestamps`), retry: false });
  const [stamping, setStamping] = useState(false);
  const timestampRoot = async () => {
    if (!window.confirm('Send the 32-byte Merkle root (a hash, no case content) to public OpenTimestamps servers?')) return;
    setStamping(true);
    setMsg(null);
    try {
      await post(`/cases/${id}/timestamp`);
      qc.invalidateQueries({ queryKey: ['timestamps', id] });
      setMsg({ tone: 'ok', text: 'Merkle root submitted. The proof is pending until Bitcoin confirms it (usually hours); download the .ots file and verify it with the OpenTimestamps client.' });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      setStamping(false);
    }
  };
  const [reportLang, setReportLang] = useState('en-IN');
  const downloadReport = () => download(`report.pdf?${[includeAudioTranscripts ? '' : 'transcripts=0', reportLang !== 'en-IN' ? `lang=${reportLang}` : ''].filter(Boolean).join('&')}`, 'report.pdf', setPdfGenerating);
  const generateBundle = () => download('bundle.zip', 'bundle.zip', setBundleGenerating);
  const generateCert = () => download('certificate.pdf', 'section63-draft.pdf', setCertGenerating);

  const caseData = c.data;
  const evidenceList = ev.data ?? [];

  return (
    <CaseShell>
      <PageHead
        eyebrow="Court & Legal Exports (PS 3.2 · R1–R5)"
        title={<>Forensic reports <span className="muted">& evidence bundles</span></>}
      />

      {msg && <p role="status" className={`badge ${msg.tone}`} style={{ marginBottom: 12, whiteSpace: 'normal' }}>{msg.text}</p>}
      {info.data && !info.data.chainOk && <p role="alert" className="err" style={{ marginBottom: 12 }}>The audit log does not verify. The bundle is blocked and reports carry a warning. Open the Integrity tab.</p>}
      <div className="grid-3" style={{ alignItems: 'stretch' }}>
        {/* Card 1: Case Report PDF */}
        <div className="card stack" style={{ justifyContent: 'space-between', gap: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            <p className="eyebrow">R1 · Official PDF Report</p>
            <h3 style={{ fontSize: 20 }}>Forensic Case Summary</h3>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Court-ready PDF compiling the full chronological timeline, entity network, planted and detected inconsistencies, full audit trail hashes, and line-by-line evidence citations.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8 }}>
              <input
                type="checkbox"
                checked={includeAudioTranscripts}
                onChange={(e) => setIncludeAudioTranscripts(e.target.checked)}
              />
              <span>Include full multilingual audio transcripts appendix</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginTop: 8 }}>
              <span>Also include the summary in</span>
              <select value={reportLang} onChange={(e) => setReportLang(e.target.value)} aria-label="Report summary language">
                <option value="en-IN">English only</option>
                <option value="hi-IN">Hindi</option>
                <option value="kn-IN">Kannada</option>
                <option value="ta-IN">Tamil</option>
                <option value="te-IN">Telugu</option>
                <option value="mr-IN">Marathi</option>
                <option value="bn-IN">Bengali</option>
              </select>
            </label>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-dark"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={downloadReport}
              disabled={pdfGenerating}
            >
              {pdfGenerating ? 'Rendering report…' : 'Download report (PDF)'}
            </button>
          </div>
        </div>

        {/* Card 2: Offline Evidence Bundle */}
        <div className="card stack" style={{ justifyContent: 'space-between', gap: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            <p className="eyebrow">R2 · Verifiable Bundle</p>
            <h3 style={{ fontSize: 20 }}>Evidence Bundle ZIP</h3>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Complete standalone ZIP containing untouched encrypted originals, cryptographic <code className="mono">manifest.json</code>, append-only <code className="mono">audit.jsonl</code>, and an offline <code className="mono">verify.py</code> script for defense or judicial inspection without platform access.
            </p>
            <p className="mono muted" style={{ fontSize: 11 }}>Contains {info.data?.evidenceCount ?? evidenceList.length} evidence file(s) · open with <code>python verify.py</code></p>
            {info.data?.bundleBlockedReason && <p className="err" style={{ fontSize: 12 }}>{info.data.bundleBlockedReason}</p>}
          </div>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={generateBundle}
              disabled={bundleGenerating || info.data?.available.bundle === false}
            >
              {bundleGenerating ? 'Packing ZIP…' : 'Download evidence ZIP'}
            </button>
          </div>
        </div>

        {/* Card 3: Section 63 BSA Certificate */}
        <div className="card stack" style={{ justifyContent: 'space-between', gap: 16 }}>
          <div className="stack" style={{ gap: 10 }}>
            <p className="eyebrow">R3 · Bharatiya Sakshya Adhiniyam</p>
            <h3 style={{ fontSize: 20 }}>Section 63 Certificate</h3>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Prefilled draft electronic evidence certificate under Section 63 of the Bharatiya Sakshya Adhiniyam (BSA, 2023), including device hash tables, hash algorithm statements, and custody timeline.
            </p>
            <span className="badge warn" style={{ alignSelf: 'flex-start' }}>Draft to assist</span>
          </div>
          <div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={generateCert}
              disabled={certGenerating}
            >
              {certGenerating ? 'Preparing draft…' : 'Download Section 63 draft (PDF)'}
            </button>
          </div>
        </div>
      </div>

      <section className="card stack" style={{ marginTop: 24, gap: 10 }}>
        <div className="card-title"><h3 style={{ fontSize: 18 }}>Public timestamp (OpenTimestamps)</h3></div>
        <p className="muted" style={{ fontSize: 13 }}>Anchors the evidence Merkle root so anyone can later show these files existed at this time. Only the hash is sent.</p>
        {(stamps.data?.timestamps ?? []).map((t) => (
          <div key={t.index} className="row" style={{ fontSize: 13 }}>
            <span><span className="mono">{t.root.slice(0, 16)}…</span> · {fmtDate(t.at)}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(`../timestamps/${t.index}.ots`, 'proof.ots', () => {})}>Download .ots</button>
          </div>
        ))}
        {c.data?.role === 'owner' && <div><button type="button" className="btn btn-ghost" disabled={stamping} onClick={timestampRoot}>{stamping ? 'Submitting…' : 'Timestamp the Merkle root'}</button></div>}
      </section>

      <TrustedTimestamps caseId={id} isOwner={c.data?.role === 'owner'} download={download} />

      {/* Printable Report Section (Formatted for window.print()) */}
      <section className="card" style={{ marginTop: 24, background: 'var(--white)' }}>
        <div className="card-title">
          <h3 style={{ fontSize: 18 }}>Report preview & certificate details</h3>
          <span className="mono muted" style={{ fontSize: 11 }}>Case ID: {id}</span>
        </div>
        <div className="kv" style={{ fontSize: 13 }}>
          <dt>Case Title</dt>
          <dd>{caseData?.title}</dd>
          <dt>Incident Type</dt>
          <dd style={{ textTransform: 'capitalize' }}>{caseData?.incidentType}</dd>
          <dt>Registered Date</dt>
          <dd className="mono">{caseData ? fmtDate(caseData.createdAt) : '—'}</dd>
          <dt>Cryptographic Hashes</dt>
          <dd className="mono">{info.data?.evidenceCount ?? evidenceList.length} files hashed via SHA-256</dd>
          {info.data && <><dt>Merkle root</dt><dd className="hash">{info.data.merkleRoot}</dd><dt>Audit head</dt><dd className="hash">{info.data.auditHead}</dd></>}
          <dt>Watermark Policy</dt>
          <dd>Every export page is stamped with the viewer’s email, time and case ID</dd>
        </div>
      </section>
    </CaseShell>
  );
}

type Stamp = { id: string; type: 'evidence' | 'audit_head' | 'merkle_root'; ref: string; evidenceIdx: number | null; hash: string; tsa: string | null; genTime: string | null; serial: string | null; status: 'pending' | 'issued' | 'verified' | 'failed'; trust: 'trusted' | 'untrusted' | 'unchecked'; lastError: string | null; hasToken: boolean };
type StampList = { enabled: boolean; authorities: string[]; summary: { total: number; issued: number; pending: number; failed: number }; timestamps: Stamp[] };
type StampCheck = { verified: number; failed: number; timestamps: (Stamp & { check: { ok: boolean; errors: string[] } })[] };

const STAMP_WHAT = { evidence: 'Original file', audit_head: 'Audit log head', merkle_root: 'All evidence (Merkle root)' } as const;

/** F2: independent RFC 3161 time-stamps over evidence hashes and the audit chain. */
function TrustedTimestamps({ caseId, isOwner, download }: { caseId: string; isOwner: boolean; download: (path: string, name: string, busy: (b: boolean) => void) => Promise<void> }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tsr', caseId], queryFn: () => api<StampList>(`/cases/${caseId}/trusted-timestamps`), retry: false, refetchInterval: (q) => (q.state.data?.summary.pending ? 5000 : false) });
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<StampCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const verify = () => run(async () => { setCheck(await post<StampCheck>(`/cases/${caseId}/trusted-timestamps/verify`)); qc.invalidateQueries({ queryKey: ['tsr', caseId] }); });
  const anchor = () => run(async () => { await post(`/cases/${caseId}/trusted-timestamps/anchor`); qc.invalidateQueries({ queryKey: ['tsr', caseId] }); });

  const d = list.data;
  const verdict = new Map((check?.timestamps ?? []).map((t) => [t.id, t.check]));
  return (
    <section className="card stack" style={{ marginTop: 24, gap: 10 }}>
      <div className="card-title"><h3 style={{ fontSize: 18 }}>Trusted timestamps (RFC 3161)</h3></div>
      <p className="muted" style={{ fontSize: 13 }}>
        An independent time-stamp authority signs each evidence hash and the audit-log head, so you can show these records existed at that moment even if this platform’s own log were rebuilt. Only hashes are sent. The tokens are included in the evidence bundle and are checked offline by <code className="mono">verify.py</code>.
      </p>
      {err && <p role="alert" className="err">{err}</p>}
      {d && !d.enabled && <p className="badge warn" style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>No time-stamp authority is configured on this server (set TSA_PRIMARY_URL).</p>}
      {d?.enabled && (
        <>
          <p className="mono muted" style={{ fontSize: 11 }}>
            {d.summary.issued} issued · {d.summary.pending} pending · {d.summary.failed} failed · authority: {d.authorities.join(', ')}
          </p>
          {d.timestamps.slice(0, 12).map((t) => {
            const v = verdict.get(t.id);
            return (
              <div key={t.id} className="row" style={{ fontSize: 13, gap: 8, flexWrap: 'wrap' }}>
                <span>
                  <b>{t.type === 'evidence' && t.evidenceIdx ? `E${t.evidenceIdx}` : STAMP_WHAT[t.type]}</b>
                  {t.type === 'audit_head' && <span className="muted"> #{t.ref}</span>}
                  {' · '}
                  <span className="mono">{t.genTime ? fmtDate(t.genTime) : 'waiting for the authority…'}</span>
                  {t.tsa && <span className="muted"> · {t.tsa}</span>}
                </span>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span className={`badge ${t.status === 'failed' || v?.ok === false ? 'bad' : t.status === 'pending' ? 'warn' : 'ok'}`} title={v?.errors.join('; ') || t.lastError || undefined}>
                    {v ? (v.ok ? 'verified' : 'check failed') : t.status}
                  </span>
                  {t.status !== 'pending' && t.trust !== 'trusted' && <span className="badge warn" title="The signing certificate is not in this server's trust list">{t.trust === 'untrusted' ? 'authority not trusted' : 'authority unchecked'}</span>}
                  {t.hasToken && <button type="button" className="btn btn-ghost btn-sm" onClick={() => download(`../../../trusted-timestamps/${t.id}/token`, 'timestamp.tsr', () => {})}>.tsr</button>}
                </span>
              </div>
            );
          })}
          {d.timestamps.length > 12 && <p className="muted" style={{ fontSize: 12 }}>Showing 12 of {d.timestamps.length}. All are in the evidence bundle.</p>}
          {check && <p role="status" className={`badge ${check.failed ? 'bad' : 'ok'}`} style={{ alignSelf: 'flex-start', whiteSpace: 'normal' }}>{check.failed ? `${check.failed} time-stamp(s) failed verification. The records may have changed since they were stamped.` : `${check.verified} time-stamp(s) verified against the current records.`}</p>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-ghost" disabled={busy || !d.summary.issued} onClick={verify}>{busy ? 'Working…' : 'Verify all now'}</button>
            {isOwner && <button type="button" className="btn btn-ghost" disabled={busy} onClick={anchor}>Stamp the audit log and evidence set now</button>}
          </div>
        </>
      )}
    </section>
  );
}
