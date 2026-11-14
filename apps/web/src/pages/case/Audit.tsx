import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post } from '../../lib/api';
import { fmtDate } from '../../lib/case';
import { CaseShell } from '../../components';

type Entry = { seq: number; ts: string; actorRole?: string; action: string; target?: string; hash: string; prevHash: string };
type AuditResp = { chain: { ok: boolean; brokenAtSeq?: number; reason?: string; head?: string; count?: number }; merkleRoot: string; entries: Entry[] };
type Verify = {
  ok: boolean; chain: AuditResp['chain']; files: { evidenceId: string; idx: number; filename: string; ok: boolean; reason?: string }[];
  firstBrokenFile: { idx: number; filename: string; reason?: string } | null; merkleRoot: string; auditHead: string | null; verifiedAt: string;
};

export function AuditPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['audit', id], queryFn: () => api<AuditResp>(`/cases/${id}/audit`) });
  const [v, setV] = useState<Verify | null>(null);
  const [busy, setBusy] = useState(false);
  async function verify() {
    setBusy(true);
    try {
      setV(await post<Verify>(`/cases/${id}/verify`));
      qc.invalidateQueries({ queryKey: ['audit', id] });
    } finally {
      setBusy(false);
    }
  }
  const broken = v?.chain.ok === false ? v.chain.brokenAtSeq : q.data?.chain.ok === false ? q.data.chain.brokenAtSeq : undefined;
  return (
    <CaseShell>
      <section className="card stack" style={{ gap: 14 }}>
        <div className="row">
          <div>
            <h2 style={{ fontSize: 20 }}>Verify integrity</h2>
            <p className="muted" style={{ fontSize: 14, maxWidth: 560 }}>Re-hashes every sealed original, recomputes the hash-chained audit log, and compares the Merkle root over all evidence hashes.</p>
          </div>
          <button type="button" className="btn btn-dark" onClick={verify} disabled={busy}>{busy ? 'Verifying…' : 'Verify now'}</button>
        </div>
        {v && (
          <div className={`verify-banner ${v.ok ? 'ok' : 'bad'}`} role="status">
            <strong style={{ fontSize: 18 }}>{v.ok ? '✓ Everything verifies' : '✗ Tampering detected'}</strong>
            <span style={{ fontSize: 14 }}>
              {v.ok && `${v.files.length} files and ${v.chain.count} audit entries checked · ${fmtDate(v.verifiedAt)}`}
              {!v.chain.ok && `Audit log breaks at entry #${v.chain.brokenAtSeq} (${v.chain.reason}). `}
              {v.firstBrokenFile && `File E${v.firstBrokenFile.idx} “${v.firstBrokenFile.filename}”: ${v.firstBrokenFile.reason}.`}
            </span>
          </div>
        )}
        <dl className="kv">
          <dt>Merkle root</dt><dd className="hash">{v?.merkleRoot ?? q.data?.merkleRoot}</dd>
          <dt>Audit head</dt><dd className="hash">{v?.auditHead ?? q.data?.chain.head ?? '—'}</dd>
          <dt>Entries</dt><dd>{q.data?.entries.length ?? '…'}</dd>
        </dl>
        {v && v.files.some((f) => !f.ok) && (
          <ul className="list">{v.files.filter((f) => !f.ok).map((f) => <li key={f.evidenceId} className="err">E{f.idx} {f.filename}: {f.reason}</li>)}</ul>
        )}
      </section>

      <section className="card">
        <div className="card-title"><h2 style={{ fontSize: 18 }}>Audit log</h2><span className="eyebrow">append-only · hash-chained</span></div>
        <div className="table-scroll">
          <table className="audit-table">
            <thead><tr><th>#</th><th>When</th><th>Who</th><th>Action</th><th>Hash</th></tr></thead>
            <tbody>
              {(q.data?.entries ?? []).slice().reverse().map((e) => (
                <tr key={e.seq} className={broken === e.seq ? 'broken' : ''}>
                  <td className="mono">{e.seq}</td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtDate(e.ts)}</td>
                  <td>{e.actorRole ?? 'system'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.action}</td>
                  <td className="hash" title={e.hash}>{e.hash.slice(0, 16)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </CaseShell>
  );
}
