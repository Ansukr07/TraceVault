import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, getToken } from '../../lib/api';
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
  const downloadReport = () => download(`report.pdf${includeAudioTranscripts ? '' : '?transcripts=0'}`, 'report.pdf', setPdfGenerating);
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
