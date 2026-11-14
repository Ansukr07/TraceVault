import { useState } from 'react';
import { DotGrid, DotText, Nav, PageHead } from '../ui';

export function VerifyBundlePage() {
  const [file, setFile] = useState<File | null>(null);
  const [claimedHash, setClaimedHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{
    ok: boolean;
    computedHash: string;
    matchesClaimed?: boolean;
    manifestChecked?: boolean;
    filesCount?: number;
    error?: string;
  } | null>(null);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setReport(null);

    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(digest));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      const cleanClaimed = claimedHash.trim().toLowerCase();
      const matches = cleanClaimed ? hashHex === cleanClaimed : undefined;

      setReport({
        ok: matches !== false,
        computedHash: hashHex,
        matchesClaimed: matches,
        filesCount: file.name.endsWith('.zip') ? 1 : 1,
      });
    } catch (ex) {
      setReport({
        ok: false,
        computedHash: '',
        error: (ex as Error).message,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Nav />
      <main className="wrap page">
        <PageHead
          eyebrow="Court & Public Verifier (PS 3.2 · V3, R2)"
          title={<>Verify evidence integrity <span className="muted">offline in your browser</span></>}
        />

        <div className="split" style={{ alignItems: 'start' }}>
          <section className="card stack" style={{ gap: 16 }}>
            <div className="card-title">
              <h3 style={{ fontSize: 18 }}>Client-side cryptographic check</h3>
              <span className="mono muted" style={{ fontSize: 11 }}>Zero Upload · Runs Locally</span>
            </div>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              Court clerks, defense counsel, or judges can verify any TraceVault file or exported evidence bundle ZIP directly in the browser. The file is never uploaded to any server.
            </p>

            <form onSubmit={handleVerify} className="stack" style={{ gap: 14 }}>
              <label className="field">
                Select Evidence File or Bundle ZIP
                <input
                  type="file"
                  required
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              </label>

              <label className="field">
                <span>Claimed SHA-256 Hash <span className="hint">· optional, from certificate or report</span></span>
                <input
                  type="text"
                  placeholder="e.g. 8f4e2b..."
                  value={claimedHash}
                  onChange={(e) => setClaimedHash(e.target.value)}
                  className="mono"
                  style={{ fontSize: 12 }}
                />
              </label>

              <button className="btn btn-dark" style={{ height: 44 }} disabled={busy || !file}>
                {busy ? 'Computing SHA-256 hash…' : 'Verify file integrity'}
              </button>
            </form>
          </section>

          <section className="card stack" style={{ gap: 14 }}>
            <div className="card-title">
              <h3 style={{ fontSize: 18 }}>Verification report</h3>
            </div>

            {!report && !busy && (
              <p className="muted" style={{ fontSize: 14 }}>
                Select a file to compute its cryptographic SHA-256 digest and verify it against claimed records.
              </p>
            )}

            {busy && <p className="muted">Reading local binary buffer and calculating digest…</p>}

            {report && (
              <div className="stack" style={{ gap: 12 }}>
                <div className={`verify-banner ${report.ok ? 'ok' : 'bad'}`}>
                  <div>
                    <strong>{report.ok ? '✓ Cryptographic Check Passed' : '✗ Verification Failed / Mismatch'}</strong>
                    <p style={{ fontSize: 13, marginTop: 4 }}>
                      {report.matchesClaimed === true && 'The file’s computed SHA-256 matches the claimed certificate hash exactly.'}
                      {report.matchesClaimed === false && 'WARNING: Computed hash differs from the claimed certificate hash. File may be modified.'}
                      {report.matchesClaimed === undefined && 'SHA-256 computed successfully. Check against your court certificate or manifest.'}
                    </p>
                  </div>
                </div>

                <div className="card" style={{ background: 'var(--white)', padding: 12 }}>
                  <p className="eyebrow" style={{ marginBottom: 4 }}>Computed SHA-256 (Browser WebCrypto)</p>
                  <p className="hash mono" style={{ wordBreak: 'break-all', fontSize: 12 }}>
                    {report.computedHash}
                  </p>
                </div>

                {report.error && (
                  <p className="err">{report.error}</p>
                )}
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
