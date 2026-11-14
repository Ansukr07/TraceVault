import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fmtDate, fmtSize, langName, useEvidence, type Evidence } from '../../lib/case';
import { CaseShell, Empty, SeverityTag } from '../../components';

const KINDS = ['chat_export', 'image', 'audio', 'statement', 'pdf', 'email', 'archive'];
const STATUS_TONE: Record<string, string> = { done: 'ok', processing: 'signal', uploaded: 'signal', failed: 'bad' };

export function EvidenceLibraryPage() {
  const { id = '' } = useParams();
  const ev = useEvidence(id);
  const [kind, setKind] = useState('');
  const [minSev, setMinSev] = useState(0);
  const [q, setQ] = useState('');
  const [showDups, setShowDups] = useState(false);

  const rows = useMemo(() => {
    const all = ev.data ?? [];
    const dupsOf = new Map<string, Evidence[]>();
    all.filter((e) => e.duplicateOf).forEach((e) => dupsOf.set(e.duplicateOf!, [...(dupsOf.get(e.duplicateOf!) ?? []), e]));
    const match = (e: Evidence) =>
      (!kind || e.kind === kind) && (e.maxSeverity ?? 0) >= minSev && (!q || `${e.filename} ${e.sourceLabel}`.toLowerCase().includes(q.toLowerCase()));
    // Duplicates collapse under their canonical item; archive/email children sit under their parent.
    const top = all.filter((e) => !e.duplicateOf && !e.parentEvidenceId);
    const out: { e: Evidence; depth: number; dupCount: number }[] = [];
    const push = (e: Evidence, depth: number) => {
      if (match(e)) out.push({ e, depth, dupCount: dupsOf.get(e.id)?.length ?? 0 });
      all.filter((c) => c.parentEvidenceId === e.id && !c.duplicateOf).forEach((c) => push(c, depth + 1));
      if (showDups) dupsOf.get(e.id)?.forEach((d) => match(d) && out.push({ e: d, depth: depth + 1, dupCount: 0 }));
    };
    top.forEach((e) => push(e, 0));
    return out;
  }, [ev.data, kind, minSev, q, showDups]);

  return (
    <CaseShell>
      <section className="card">
        <div className="card-title">
          <h2 style={{ fontSize: 20 }}>Evidence library</h2>
          <Link to={`/cases/${id}/upload`} className="btn btn-dark btn-sm">Add evidence</Link>
        </div>
        <div className="filters" style={{ marginBottom: 16 }}>
          <input placeholder="Search file or label" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search evidence" />
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
            <option value="">All kinds</option>
            {KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
          </select>
          <select value={minSev} onChange={(e) => setMinSev(Number(e.target.value))} aria-label="Minimum severity">
            <option value={0}>Any severity</option>
            <option value={1}>Concerning+</option>
            <option value={2}>Harmful+</option>
            <option value={3}>Severe</option>
          </select>
          <label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={showDups} onChange={(e) => setShowDups(e.target.checked)} /> Show duplicates</label>
        </div>
        {ev.data && ev.data.length === 0 && <Empty title="Nothing here yet" />}
        <div className="table-scroll">
          <table className="ev-table">
            <thead>
              <tr><th>#</th><th>Item</th><th>Kind</th><th>Language</th><th>Severity</th><th>Status</th><th>Added</th></tr>
            </thead>
            <tbody>
              {rows.map(({ e, depth, dupCount }) => (
                <tr key={e.id} className={depth ? 'child' : ''}>
                  <td className="mono muted">E{e.idx}</td>
                  <td style={{ paddingLeft: 10 + depth * 18 }}>
                    <Link to={`/cases/${id}/evidence/${e.id}`}>{e.sourceLabel || e.filename}</Link>
                    {e.sourceLabel && <div className="mono muted" style={{ fontSize: 11 }}>{e.filename}</div>}
                    {e.duplicateOf && <span className="badge warn" style={{ marginTop: 4 }}>Duplicate</span>}
                    {dupCount > 0 && <span className="chip" style={{ marginTop: 4 }}>+{dupCount} duplicate{dupCount > 1 ? 's' : ''}</span>}
                    {e.flags?.some((f) => ['EDITED_FILE', 'METADATA_MISMATCH'].includes(f.type)) && <span className="badge bad" style={{ marginTop: 4, marginLeft: 4 }}>Metadata flag</span>}
                  </td>
                  <td><span className="chip">{e.kind.replace('_', ' ')}</span></td>
                  <td className="mono" style={{ fontSize: 12 }}>{e.detectedLang ? langName(e.detectedLang) : '—'}</td>
                  <td>{(e.maxSeverity ?? 0) > 0 ? <SeverityTag score={e.maxSeverity!} /> : <span className="muted">—</span>}</td>
                  <td><span className={`badge ${STATUS_TONE[e.status] ?? ''}`}>{e.status}</span>{e.error && <div className="err" style={{ maxWidth: 220 }}>{e.error.slice(0, 120)}</div>}</td>
                  <td className="mono muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtDate(e.createdAt, 'day')}<div>{fmtSize(e.size)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </CaseShell>
  );
}
