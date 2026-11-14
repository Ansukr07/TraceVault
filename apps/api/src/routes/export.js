// Exports (spec §5.14): report PDF, evidence bundle ZIP, Section 63 BSA certificate draft.
//   owner: all · legal: report + certificate · investigator: all, bundle needs a grant that allows downloads.
import crypto from 'node:crypto';
import { Router } from 'express';
import archiver from 'archiver';
import { ah, httpError, requireAuth, requireCaseRole } from '../middleware/index.js';
import { audit } from '../services/audit.js';
import { Timestamp } from '../models/index.js';
import { trustPem } from '../services/timestamps.js';
import { readPlain } from '../services/evidence-store.js';
import { mlJson } from '../services/ml-client.js';
import {
  VERIFY_PY, auditJsonl, bundleManifest, certificateHtml, collect, fileHash, reportHtml, safeName, signCheckpoint,
} from '../services/export.js';

export const exportRouter = Router({ mergeParams: true });
exportRouter.use(requireAuth);

export async function renderPdf(html, { title, footer, header }) {
  const r = await fetch(`${process.env.ML_BASE_URL ?? 'http://127.0.0.1:8000'}/report/pdf`, {
    method: 'POST',
    headers: { 'X-Internal-Secret': process.env.ML_INTERNAL_SECRET ?? 'change-me', 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, title, footer, header }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!r.ok) throw httpError(502, 'RENDER_FAILED', `PDF rendering failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

export const send = (res, buf, name, type) => {
  res.set({ 'Content-Type': type, 'Content-Length': buf.length, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
};

// What is available to this viewer: drives the Export page.
exportRouter.get(
  '/',
  requireCaseRole('owner', 'legal', 'investigator'),
  ah(async (req, res) => {
    const d = await collect(req);
    const shared = req.role === 'legal' || req.role === 'investigator';
    res.json({
      evidenceCount: d.evidence.length,
      merkleRoot: d.merkle,
      auditHead: d.auditHead,
      auditCount: d.audits.length,
      chainOk: d.chain.ok,
      scope: d.scope ? 'shared-evidence' : 'whole-case',
      available: {
        report: true,
        certificate: true,
        bundle: req.role === 'owner' || (req.role === 'investigator' && (!shared || req.grant?.allowDownload)),
      },
      bundleBlockedReason: req.role === 'legal' ? 'Bundles are for owners and investigators.' : req.role === 'investigator' && !req.grant?.allowDownload ? 'The owner did not allow downloads for this share.' : null,
      hasSigningKey: !!signCheckpoint({}).signature,
    });
  }),
);

exportRouter.get(
  '/report.pdf',
  requireCaseRole('owner', 'legal', 'investigator'),
  ah(async (req, res) => {
    const d = await collect(req, { lang: typeof req.query.lang === 'string' ? req.query.lang : undefined });
    const html = await reportHtml(d, { transcripts: req.query.transcripts !== '0' });
    const pdf = await renderPdf(html, { title: `Report: ${d.c.title}`, footer: d.stamp, header: 'TraceVault · digital evidence report' });
    await audit(d.c._id, { actorId: req.user._id, actorRole: req.role, action: 'REPORT_EXPORTED', target: String(d.c._id), payload: { sha256: fileHash(pdf), merkleRoot: d.merkle, auditHead: d.auditHead } });
    send(res, pdf, `tracevault-report-${String(d.c._id).slice(-6)}.pdf`, 'application/pdf');
  }),
);

exportRouter.get(
  '/certificate.pdf',
  requireCaseRole('owner', 'legal', 'investigator'),
  ah(async (req, res) => {
    const d = await collect(req);
    const pdf = await renderPdf(certificateHtml(d), { title: 'Section 63 BSA certificate (draft)', footer: `DRAFT TO ASSIST · ${d.stamp}`, header: 'TraceVault · Section 63 certificate (draft)' });
    await audit(d.c._id, { actorId: req.user._id, actorRole: req.role, action: 'CERTIFICATE_EXPORTED', target: String(d.c._id), payload: { sha256: fileHash(pdf), merkleRoot: d.merkle } });
    send(res, pdf, `tracevault-section63-draft-${String(d.c._id).slice(-6)}.pdf`, 'application/pdf');
  }),
);

exportRouter.get(
  '/bundle.zip',
  requireCaseRole('owner', 'investigator'),
  ah(async (req, res) => {
    if (req.grant && !req.grant.allowDownload) throw httpError(403, 'DOWNLOAD_NOT_ALLOWED', 'The owner did not allow downloads for this share');
    const d = await collect(req);
    if (!d.chain.ok) throw httpError(409, 'INTEGRITY_FAILED', `The audit log breaks at entry #${d.chain.brokenAtSeq} (${d.chain.reason}). A bundle would carry a signature over altered records, so it was not created.`);
    const exportedAt = new Date().toISOString();
    // Decrypt each original from GridFS; a file that fails authentication aborts the export instead of shipping bad bytes.
    const files = [];
    const blobs = [];
    for (const e of d.evidence) {
      if (e.redacted?.at) continue;
      const buf = await readPlain(e).catch(() => null);
      if (!buf || fileHash(buf) !== e.sha256) throw httpError(409, 'INTEGRITY_FAILED', `E${e.idx} ${e.filename} no longer matches its sealed hash. Run Verify on the Integrity page.`);
      const p = `originals/E${e.idx}_${safeName(e.filename)}`;
      files.push({ evidenceId: String(e._id), idx: e.idx, path: p, filename: e.filename, sha256: e.sha256, size: buf.length, mime: e.mime, kind: e.kind });
      blobs.push([p, buf]);
    }
    const manifestBytes = Buffer.from(JSON.stringify(bundleManifest({ ...d, merkle: d.merkle }, files, exportedAt), null, 2));
    const checkpoint = signCheckpoint({
      caseId: String(d.c._id), merkleRoot: d.merkle, auditHead: d.auditHead, auditCount: d.audits.length, manifestSha256: fileHash(manifestBytes), exportedAt,
    });
    const readme = `TraceVault evidence bundle\n==========================\nCase: ${d.c.title}\nExported: ${exportedAt}\n\noriginals/      the unmodified files as uploaded (their SHA-256 is in manifest.json)\nmanifest.json   file list, Merkle root, audit head\naudit.jsonl     the hash-chained audit log\ncheckpoint.json Ed25519-signed summary of the above\npublic_key.pem  verifies the signature\ntimestamps/     RFC 3161 time-stamp tokens (independent proof of when each hash existed)\nverify.py       offline check, Python 3 only:  python verify.py\n\nThis bundle was generated for: ${req.user.email}\n`;

    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="tracevault-bundle-${String(d.c._id).slice(-6)}.zip"`, 'Cache-Control': 'no-store' });
    const zip = archiver('zip', { zlib: { level: 6 } });
    const hash = crypto.createHash('sha256');
    zip.on('data', (c) => hash.update(c));
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);
    for (const [p, buf] of blobs) zip.append(buf, { name: p });
    zip.append(manifestBytes, { name: 'manifest.json' });
    zip.append(auditJsonl(d.audits), { name: 'audit.jsonl' });
    zip.append(JSON.stringify(checkpoint, null, 2), { name: 'checkpoint.json' });
    if (checkpoint.publicKeyPem) zip.append(checkpoint.publicKeyPem, { name: 'public_key.pem' });
    // F2: RFC 3161 tokens + an index so verify.py can check them offline.
    const stampIndex = [];
    for (const t of await Timestamp.find({ _id: { $in: d.timestamps.map((x) => x._id) } })) {
      const file = `timestamps/${t.subject.type}_${safeName(t.subject.ref)}_${t._id.toString().slice(-6)}.tsr`;
      zip.append(t.token, { name: file });
      stampIndex.push({ file, type: t.subject.type, ref: t.subject.ref, hash: t.subject.hash, genTime: t.genTime, tsa: t.tsa?.name, serial: t.serial });
    }
    if (stampIndex.length) {
      zip.append(JSON.stringify(stampIndex, null, 2), { name: 'timestamps/index.json' });
      if (trustPem()) zip.append(trustPem(), { name: 'timestamps/trust.pem' });
    }
    zip.append(VERIFY_PY, { name: 'verify.py' });
    zip.append(readme, { name: 'README.txt' });
    await zip.finalize();
    await audit(d.c._id, { actorId: req.user._id, actorRole: req.role, action: 'BUNDLE_EXPORTED', target: String(d.c._id), payload: { files: files.length, merkleRoot: d.merkle, zipSha256: hash.digest('hex'), signed: !!checkpoint.signature } });
  }),
);
