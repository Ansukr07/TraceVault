// Report, Section 63 BSA certificate draft and evidence bundle (spec R1–R4, V4, V6, H5).
// Everything is built from the viewer's own scope: a scoped share never exports evidence outside its grant.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { translatedSummary } from './summary-translate.js';
import {
  AuditEntry, Chunk, Decision, DerivedArtifact, Entity, Evidence, Inconsistency, Summary, TimelineEvent, Timestamp, User,
} from '../models/index.js';
import { canonicalJSON, genesisHash, verifyChain } from './audit-chain.js';
import { merkleRoot } from './merkle.js';
import { citationAllowed, restrictCitations, scopeFor } from './scope.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rupees = (v) => (v == null ? '' : `₹${Number(v).toLocaleString('en-IN')}`);
const when = (ts, prec = 'exact') => {
  if (!ts) return 'Unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  return prec === 'exact' && (d.getHours() || d.getMinutes()) ? `${date}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : date;
};
const LANG = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'hi-Latn': 'Hinglish', 'kn-IN': 'Kannada', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'mr-IN': 'Marathi', 'bn-IN': 'Bengali' };
const SEV = ['Benign', 'Concerning', 'Harmful', 'Severe'];

/** Ed25519 signing for checkpoints (V6). The key is created by `npm run keys:generate`. */
function loadKey() {
  const root = path.resolve(import.meta.dirname, '../../../..');
  // Serverless has no key file: ED25519_PRIVATE_KEY_PEM holds the PEM inline (newlines may be written as \n).
  const inline = process.env.ED25519_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  const p = path.resolve(root, process.env.ED25519_PRIVATE_KEY_PEM_PATH ?? './keys/audit_ed25519.pem');
  if (!inline && !fs.existsSync(p)) return null;
  const privateKey = crypto.createPrivateKey(inline ?? fs.readFileSync(p));
  return { privateKey, publicPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) };
}

export function signCheckpoint(payload) {
  const key = loadKey();
  if (!key) return { payload, signature: null, publicKeyPem: null, note: 'No signing key configured (run: npm run keys:generate)' };
  const signature = crypto.sign(null, Buffer.from(canonicalJSON(payload)), key.privateKey).toString('base64');
  return { payload, signature, publicKeyPem: key.publicPem, algorithm: 'Ed25519' };
}

/** R5: optional regional-language copy of the summary (machine translation; the English text stays authoritative). */
async function nativeSummary(c, summary, scope, lang) {
  if (!summary || !lang || lang.startsWith('en')) return null;
  const tr = await translatedSummary(c, summary, lang);
  return scope ? { ...tr, sections: tr.sections.map((s) => ({ ...s, sentences: s.sentences.map((x) => ({ ...x, citations: restrictCitations(scope, x.citations) })) })) } : tr;
}

/** Everything the exports need, restricted to the viewer's scope. */
export async function collect(req, { lang } = {}) {
  const c = req.case;
  const cid = c._id;
  const scope = await scopeFor(req);
  const evFilter = scope ? { _id: { $in: [...scope.ids] } } : {};
  const [evidence, entities, events, incs, decisions, summary, audits, ownerUser, stamps] = await Promise.all([
    Evidence.find({ caseId: cid, ...evFilter }).sort({ idx: 1 }).lean(),
    Entity.find({ caseId: cid }).sort({ mentionCount: -1 }).lean(),
    TimelineEvent.find({ caseId: cid }).sort({ ts: 1 }).lean(),
    Inconsistency.find({ caseId: cid }).sort({ severity: -1 }).lean(),
    Decision.find({ caseId: cid, kind: 'inconsistency_status' }).lean(),
    Summary.findOne({ caseId: cid, lang: 'en-IN' }).sort({ version: -1 }).lean(),
    AuditEntry.find({ caseId: String(cid) }).sort({ seq: 1 }).lean(),
    User.findById(c.members.find((m) => m.role === 'owner')?.userId, 'name').lean(),
    Timestamp.find({ caseId: cid, token: { $exists: true } }, '-token').sort({ genTime: 1 }).lean(),
  ]);
  const inScope = (ids = []) => !scope || ids.some((i) => scope.ids.has(String(i)));
  const status = new Map(decisions.map((d) => [d.key, d.data]));
  const visibleIncs = incs.filter((i) => !scope || i.refs.every((r) => scope.ids.has(String(r.evidenceId)))).map((i) => ({ ...i, st: status.get(i.key) ?? { status: 'open' } }));
  return {
    c, scope, owner: ownerUser?.name ?? 'Complainant', evidence,
    entities: entities.filter((e) => inScope(e.evidenceIds)),
    events: events.filter((e) => inScope(e.evidenceIds)).map((e) => ({ ...e, citations: restrictCitations(scope, e.citations) })),
    incs: visibleIncs,
    summary: summary && scope ? { ...summary, sections: summary.sections.map((s) => ({ ...s, sentences: s.sentences.map((x) => ({ ...x, citations: restrictCitations(scope, x.citations) })) })) } : summary,
    summaryNative: await nativeSummary(c, summary, scope, lang),
    audits,
    // F2: only time-stamps for evidence inside the viewer's scope (case-level anchors are always safe to show).
    timestamps: stamps.filter((t) => t.subject.type !== 'evidence' || !scope || scope.ids.has(t.subject.ref)),
    chain: verifyChain(String(cid), audits),
    merkle: merkleRoot(evidence.map((e) => e.sha256)),
    auditHead: audits.at(-1)?.hash ?? genesisHash(String(cid)),
    stamp: `Viewed by ${req.user.email} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · Case ${cid}`,
  };
}

export const CSS = `<style>
body { font-family: sans-serif; font-size: 9.5pt; color: #1a1a18; line-height: 1.35; }
h1 { font-size: 20pt; margin: 0 0 2pt 0; } h2 { font-size: 13pt; margin: 16pt 0 5pt 0; border-bottom: 1px solid #b9b8b3; padding-bottom: 2pt; }
h3 { font-size: 10.5pt; margin: 9pt 0 3pt 0; } p { margin: 0 0 5pt 0; }
table { border-collapse: collapse; width: 100%; } th { text-align: left; font-size: 8pt; color: #6b6a66; border-bottom: 1px solid #b9b8b3; padding: 3pt 4pt; }
td { padding: 3pt 4pt; border-bottom: 1px solid #e6e5e1; vertical-align: top; font-size: 8.8pt; }
.mono { font-family: monospace; font-size: 7.6pt; color: #4a4a47; } .muted { color: #6b6a66; } .small { font-size: 8pt; }
.box { border: 1px solid #b9b8b3; padding: 6pt 8pt; margin: 6pt 0; } .warn { background-color: #fbf1dc; border: 1px solid #e0c58a; padding: 6pt 8pt; margin: 6pt 0; }
.bad { color: #b5412a; } .cite { font-family: monospace; font-size: 7.5pt; color: #6b6a66; }
</style>`;

const cites = (ids = []) => (ids.length ? ` <span class="cite">${ids.map((c) => `[${esc(c)}]`).join('')}</span>` : '');
const evLabel = (e) => esc(e.sourceLabel || e.filename);

function transcriptsAppendix(artifacts, evidence) {
  const out = [];
  for (const a of artifacts) {
    const e = evidence.find((x) => String(x._id) === String(a.evidenceId));
    if (!e) continue;
    const t = a.data ?? {};
    out.push(`<h3>E${e.idx} · ${evLabel(e)}</h3><p class="small muted">Language: ${esc(LANG[t.lang] ?? t.lang ?? 'unknown')} · Provider: ${esc(a.generator?.name ?? t.provider ?? '?')} ${esc(t.model ?? '')} · ${(t.segments ?? []).length} segments. Machine transcription and translation: check against the original audio.</p>`);
    out.push('<table><tr><th width="10%">Time</th><th>Original</th><th>English (machine translation)</th></tr>');
    for (const s of t.segments ?? []) {
      const ts = `${Math.floor(s.startMs / 60000)}:${String(Math.floor((s.startMs % 60000) / 1000)).padStart(2, '0')}`;
      out.push(`<tr><td class="mono">${ts}${s.speaker ? `<br/>${esc(s.speaker)}` : ''}</td><td>${esc(s.text)}</td><td>${esc(s.textEn && s.textEn !== s.text ? s.textEn : '')}</td></tr>`);
    }
    out.push('</table>');
  }
  return out.join('\n');
}

const STAMP_LABEL = { evidence: 'Original file', audit_head: 'Audit log head', merkle_root: 'Evidence set (Merkle root)' };
const TRUST_LABEL = { trusted: 'authority trusted', untrusted: 'authority NOT in the trust list', unchecked: 'authority not checked' };

/** F2: independent RFC 3161 time-stamps. Each row proves the hash existed at that time, per the named authority. */
function timestampsSection(stamps, evidence) {
  const idx = new Map(evidence.map((e) => [String(e._id), e.idx]));
  const rows = stamps.map((t) => {
    const what = t.subject.type === 'evidence' ? `${STAMP_LABEL.evidence} E${idx.get(t.subject.ref) ?? '?'}` : `${STAMP_LABEL[t.subject.type]}${t.subject.type === 'audit_head' ? ` (entry #${esc(t.subject.ref)})` : ''}`;
    return `<tr><td>${what}</td><td class="mono">${esc(t.genTime ? new Date(t.genTime).toISOString().slice(0, 19).replace('T', ' ') : '')} UTC</td><td>${esc(t.tsa?.name ?? '')}<br/><span class="small muted">serial ${esc(t.serial ?? '')} · ${esc(TRUST_LABEL[t.trust] ?? t.trust)}</span></td><td class="mono small">${esc(t.subject.hash)}</td></tr>`;
  });
  return `<p class="small muted">Each row is an RFC 3161 time-stamp issued by an independent authority over the SHA-256 shown. It proves that hash existed no later than the stated time. Tokens are in the evidence bundle and can be checked offline.</p><table><tr><th width="22%">Stamped item</th><th width="20%">Time</th><th width="22%">Authority</th><th>SHA-256</th></tr>${rows.join('')}</table>`;
}

/** R1 + R4: the case report. */
export async function reportHtml(d, { transcripts = true } = {}) {
  const { c, evidence } = d;
  const audioIds = evidence.filter((e) => e.kind === 'audio' || e.kind === 'statement').map((e) => e._id);
  const artifacts = transcripts && audioIds.length ? await DerivedArtifact.find({ evidenceId: { $in: audioIds }, type: 'transcript' }).lean() : [];
  const kinds = {};
  evidence.forEach((e) => (kinds[e.kind] = (kinds[e.kind] ?? 0) + 1));
  const open = d.incs.filter((i) => i.st.status !== 'dismissed');
  const people = d.entities.filter((e) => e.type === 'PERSON');
  const money = d.events.filter((e) => e.category === 'payment' && e.amount);
  const h = [];
  h.push(`<html><head>${CSS}</head><body>`);
  h.push(`<p class="muted small">TRACEVAULT · DIGITAL EVIDENCE REPORT</p><h1>${esc(c.title)}</h1>`);
  h.push(`<p class="muted">${esc(c.incidentType)} · Complainant: ${esc(d.owner)} · Case ${esc(String(c._id))} · Generated ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC</p>`);
  if (!d.chain.ok) h.push(`<div class="warn small bad"><b>Integrity warning.</b> The audit log does not verify: it breaks at entry #${d.chain.brokenAtSeq} (${esc(d.chain.reason)}). Records in this case may have been altered. Treat this report with caution and run Verify on the Integrity page.</div>`);
  if (d.scope) h.push(`<div class="warn small"><b>Shared extract.</b> This report covers only the ${evidence.length} evidence item(s) the complainant shared with you. Other evidence in the case is not shown.</div>`);
  h.push(`<div class="box small"><b>Integrity.</b> ${evidence.length} original files sealed with SHA-256 (${Object.entries(kinds).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}).<br/>Merkle root over evidence hashes: <span class="mono">${d.merkle}</span><br/>Audit log head (${d.audits.length} entries): <span class="mono">${d.auditHead}</span></div>`);

  if (d.summary) {
    h.push('<h2>1. Summary</h2>');
    const note = d.summary.generator?.name === 'llm' ? `Written by ${esc(d.summary.generator.provider)} (${esc(d.summary.generator.model)}) from the cited evidence.` : 'Built directly from the structured evidence.';
    h.push(`<p class="small muted">${note} Each sentence cites its source chunk [E#:#]. “Not fully supported” marks sentences the checker could not confirm.</p>`);
    for (const s of d.summary.sections.filter((x) => x.sentences.length)) {
      h.push(`<h3>${esc(s.title)}</h3>`);
      for (const x of s.sentences) h.push(`<p>${esc(x.text)}${x.supported === false ? ' <span class="bad small">[not fully supported]</span>' : ''}${cites(x.citations)}</p>`);
    }
  }

  if (d.summaryNative) {
    h.push(`<h2>1a. Summary (${esc(LANG[d.summaryNative.lang] ?? d.summaryNative.lang)})</h2><p class="small muted">Machine translation (Sarvam) of the English summary above. The English text is the authoritative version; citations are unchanged.</p>`);
    for (const s of d.summaryNative.sections.filter((x) => x.sentences.length)) {
      h.push(`<h3>${esc(s.title)}</h3>`);
      for (const x of s.sentences) h.push(`<p>${esc(x.text)}${cites(x.citations)}</p>`);
    }
  }

  h.push('<h2>2. Timeline</h2>');
  h.push('<table><tr><th width="17%">When</th><th>Event</th><th width="9%">Severity</th><th width="16%">Sources</th></tr>');
  for (const e of d.events) {
    h.push(`<tr><td>${esc(when(e.ts, e.tsPrecision))}${e.tsPrecision === 'approx' ? '<br/><span class="small muted">approximate</span>' : ''}</td><td><b>${esc(e.title)}</b>${e.sourceType === 'self_statement' ? ' <span class="small muted">(complainant’s account)</span>' : ''}<br/><span class="small muted">${esc(e.description)}</span>${e.userEdited ? '<br/><span class="small muted">edited by a case member</span>' : ''}</td><td>${SEV[e.severity] ?? ''}</td><td class="cite">${e.citations.map((x) => `[${esc(x)}]`).join(' ')}${e.corroborationCount ? `<br/>${e.corroborationCount + 1} sources` : ''}</td></tr>`);
  }
  h.push('</table>');

  h.push('<h2>3. People and identifiers</h2><table><tr><th>Name / identifier</th><th>Type</th><th>Linked identifiers</th><th>Mentions</th></tr>');
  for (const p of d.entities.slice(0, 40)) {
    const ids = Object.values(p.identifiers ?? {}).flat().join(', ');
    h.push(`<tr><td>${esc(p.name)}${p.aliases?.length > 1 ? `<br/><span class="small muted">also: ${esc(p.aliases.filter((a) => a !== p.name).join(', '))}</span>` : ''}</td><td>${esc(p.type.toLowerCase().replace('_', ' '))}${p.isOwner ? ' (complainant)' : ''}</td><td class="small">${esc(ids)}</td><td>${p.mentionCount}</td></tr>`);
  }
  h.push('</table>');

  h.push(`<h2>4. Inconsistencies (${open.length} open, ${d.incs.length - open.length} dismissed)</h2>`);
  if (!d.incs.length) h.push('<p class="muted">None detected.</p>');
  for (const i of d.incs) {
    h.push(`<div class="box"><b>${esc(i.title)}</b> <span class="small muted">· ${esc(i.type.replace(/_/g, ' ').toLowerCase())} · ${SEV[i.severity]} · ${Math.round(i.confidence * 100)}% confidence · status: ${esc(i.st.status)}</span><p class="small">${esc(i.explanation)}</p>`);
    for (const r of i.refs) h.push(`<p class="small"><span class="muted">${r.chunkId ? `[${esc(r.chunkId)}]` : esc(r.field ?? '')}:</span> “${esc(r.quote)}”${r.quoteEn ? ` <span class="muted">(${esc(r.quoteEn)} — machine translation)</span>` : ''}</p>`);
    if (i.st.note) h.push(`<p class="small"><b>Complainant’s explanation:</b> ${esc(i.st.note)}</p>`);
    h.push('</div>');
  }

  if (money.length) {
    h.push(`<h2>5. Financial transactions in documents</h2><table><tr><th>Date</th><th>Detail</th><th>Amount</th></tr>`);
    for (const m of money) h.push(`<tr><td>${esc(when(m.ts, m.tsPrecision))}</td><td>${esc(m.title)}${cites(m.citations)}</td><td>${rupees(m.amount)}</td></tr>`);
    h.push(`<tr><td></td><td><b>Total</b></td><td><b>${rupees(money.reduce((s, m) => s + m.amount, 0))}</b></td></tr></table>`);
  }

  h.push('<h2>6. Evidence index</h2><table><tr><th width="5%">#</th><th>Item</th><th width="9%">Kind</th><th width="8%">Size</th><th>SHA-256</th></tr>');
  for (const e of evidence) {
    h.push(`<tr><td class="mono">E${e.idx}</td><td>${evLabel(e)}<br/><span class="small muted">${esc(e.filename)} · uploaded ${esc(when(e.createdAt, 'day'))}${e.duplicateOf ? ' · duplicate' : ''}</span>${(e.flags ?? []).length ? `<br/><span class="bad small">⚑ ${esc(e.flags.map((f) => f.type.replace(/_/g, ' ').toLowerCase()).join(', '))}</span>` : ''}</td><td>${esc(e.kind.replace('_', ' '))}</td><td class="small">${(e.size / 1024).toFixed(1)} KB</td><td class="mono">${e.sha256}</td></tr>`);
  }
  h.push('</table>');

  let sec = 7;
  if (d.timestamps?.length) h.push(`<h2>${sec++}. Trusted timestamps</h2>${timestampsSection(d.timestamps, evidence)}`);
  if (artifacts.length) h.push(`<h2>${sec++}. Transcripts appendix</h2>${transcriptsAppendix(artifacts, evidence)}`);

  const tail = d.audits.slice(-12);
  h.push(`<h2>${sec}. Audit log (last ${tail.length} of ${d.audits.length} entries)</h2><table><tr><th width="5%">#</th><th width="22%">Time (UTC)</th><th>Action</th><th>Entry hash</th></tr>`);
  for (const a of tail) h.push(`<tr><td class="mono">${a.seq}</td><td class="mono">${esc(a.ts.slice(0, 19).replace('T', ' '))}</td><td>${esc(a.actorRole ?? 'system')} · ${esc(a.action)}</td><td class="mono">${a.hash.slice(0, 40)}…</td></tr>`);
  h.push('</table>');
  h.push(`<div class="warn small"><b>About this report.</b> It is generated from sealed originals and machine-derived text (OCR, speech-to-text, translation, entity extraction). Machine output can contain errors: check any quoted passage against the original file, whose SHA-256 is listed above. This report assists a complaint; it is not legal advice and does not itself establish admissibility.</div>`);
  h.push('</body></html>');
  return h.join('\n');
}

/** R3: Section 63 BSA certificate draft. Wording is deliberately conservative: a draft for a lawyer to review. */
export function certificateHtml(d) {
  const { c, evidence } = d;
  const rows = evidence.map((e) => `<tr><td class="mono">E${e.idx}</td><td>${esc(e.filename)}<br/><span class="small muted">${esc(e.mime)} · ${e.size} bytes</span></td><td class="mono">${e.sha256}</td></tr>`).join('');
  return `<html><head>${CSS}</head><body>
<p class="muted small">TRACEVAULT · DRAFT TO ASSIST — NOT A FILED OR SIGNED DOCUMENT</p>
<h1>Certificate under Section 63(4), Bharatiya Sakshya Adhiniyam, 2023</h1>
<div class="warn small"><b>Draft.</b> This prefilled draft only saves typing. A lawyer should check it against the current text of Section 63 and the Schedule certificate format before use. Fields marked ______ cannot be known to this platform and must be completed by the person signing. This draft makes no claim that the records are admissible.</div>
<h2>Case</h2>
<p>${esc(c.title)} (${esc(c.incidentType)}). Case reference: <span class="mono">${esc(String(c._id))}</span>. Evidence integrity: ${evidence.length} file(s); Merkle root over their SHA-256 hashes <span class="mono">${d.merkle}</span>; audit log head <span class="mono">${d.auditHead}</span>.</p>
<h2>Part A — to be completed by the party producing the record</h2>
<p>I, ______________________ (name), son/daughter of ______________________, resident of ______________________, do hereby solemnly affirm and state:</p>
<p>1. I am the complainant (${esc(d.owner)}) / a person in lawful control of the device or account described below, and I make this certificate in that capacity.</p>
<p>2. The electronic records listed below were produced by the computer / communication device or account identified here: Device / account: ______________________ (make, model, number, account name); Operating system / app: ______________________.</p>
<p>3. During the period in which the records were created, the device / account was in regular use for the purpose of ______________________ and was operating properly, to the best of my knowledge. If it was not, the respect in which it was not is: ______________________.</p>
<p>4. The records were exported or captured on ____ / ____ / ________ and were uploaded to the TraceVault platform, which computed the SHA-256 value shown against each item in the browser and again on its server, and sealed an unmodified copy of the original file. The platform kept a hash-chained audit log of every access and action.</p>
<h2>Electronic records and hash values</h2>
<table><tr><th width="6%">#</th><th>Record</th><th>SHA-256</th></tr>${rows}</table>
<p class="small muted">Hash algorithm: SHA-256 (FIPS 180-4). Anyone holding a copy of a record can recompute its hash and compare it with the value above.</p>
<p>5. Text, transcripts, translations and extracted entities shown in the accompanying report were generated by software and are not part of the original records.</p>
<p>Date: ____ / ____ / ________ &nbsp;&nbsp;&nbsp; Place: ______________________ &nbsp;&nbsp;&nbsp; Signature: ______________________</p>
<h2>Part B — to be completed by an expert, if one is engaged</h2>
<p>I, ______________________ (name, designation, qualification), have examined the records above and the process described. To the best of my knowledge: the hash values are consistent with the records examined; ______________________. Date: ____ / ____ / ________ &nbsp;&nbsp;&nbsp; Signature: ______________________</p>
</body></html>`;
}

const VERIFY_PY = `#!/usr/bin/env python3
"""Offline verifier for a TraceVault evidence bundle. Python 3.8+, standard library only.

    python verify.py [bundle_dir]

Checks: (1) every original's SHA-256 against manifest.json, (2) the Merkle root, (3) the hash-chained audit log in
audit.jsonl, (4) the Ed25519 signature on checkpoint.json (needs the optional 'cryptography' package),
(5) RFC 3161 time-stamps in timestamps/ (the stamped hash must match the bundle; the authority's signature is
checked too when openssl and timestamps/trust.pem are available).
Exit code 0 = everything verified, 1 = something is wrong.
"""
import base64, calendar, hashlib, json, os, shutil, subprocess, sys, time

root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
fails = []


def sha(b):
    return hashlib.sha256(b).hexdigest()


def canon(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canon(v[k]) for k in sorted(v) if v[k] is not None) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def read(name, mode="rb"):
    with open(os.path.join(root, name), mode) as f:
        return f.read()


def merkle(hashes):
    if not hashes:
        return sha(b"")
    leaf = lambda h: hashlib.sha256(b"\\x00" + bytes.fromhex(h)).digest()
    level = [leaf(h) for h in sorted(hashes)]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            r = level[i + 1] if i + 1 < len(level) else level[i]
            nxt.append(hashlib.sha256(b"\\x01" + level[i] + r).digest())
        level = nxt
    return level[0].hex()


manifest_bytes = read("manifest.json")
manifest = json.loads(manifest_bytes)
print("Case", manifest["caseId"], "exported", manifest["exportedAt"])

print("\\n[1] Original files")
for f in manifest["files"]:
    p = os.path.join(root, f["path"])
    if not os.path.exists(p):
        fails.append("missing file " + f["path"]); print("  MISSING", f["path"]); continue
    ok = sha(open(p, "rb").read()) == f["sha256"]
    print("  ", "ok  " if ok else "FAIL", f["path"])
    if not ok:
        fails.append("hash mismatch " + f["path"])

print("\\n[2] Merkle root")
root_ok = merkle([f["sha256"] for f in manifest["files"]]) == manifest["merkleRoot"]
print("  ", "ok  " if root_ok else "FAIL", manifest["merkleRoot"])
if not root_ok:
    fails.append("merkle root mismatch")

print("\\n[3] Audit log hash chain")
prev = sha(("TRACEVAULT_GENESIS:" + manifest["caseId"]).encode())
count = 0
for line in read("audit.jsonl", "r").splitlines():
    e = json.loads(line)
    count += 1
    entry = {k: e.get(k) for k in ("caseId", "seq", "ts", "actorId", "actorRole", "action", "target", "payloadHash")}
    if e["seq"] != count or e["prevHash"] != prev or sha((prev + canon(entry)).encode()) != e["hash"]:
        fails.append("audit chain breaks at entry %d" % count); print("   FAIL chain breaks at entry", count); break
    prev = e["hash"]
else:
    print("   ok  ", count, "entries; head", prev)
if count != manifest["auditCount"] or (not fails and prev != manifest["auditHead"]):
    fails.append("audit head differs from manifest")

print("\\n[4] Signed checkpoint")
cp = json.loads(read("checkpoint.json"))
if cp.get("payload", {}).get("manifestSha256") != sha(manifest_bytes):
    fails.append("manifest.json was changed after signing"); print("   FAIL manifest changed after signing")
elif not cp.get("signature"):
    print("   skipped: bundle was not signed")
else:
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        key = load_pem_public_key(cp["publicKeyPem"].encode())
        key.verify(base64.b64decode(cp["signature"]), canon(cp["payload"]).encode())
        print("   ok   Ed25519 signature valid")
    except ImportError:
        print("   skipped: pip install cryptography to verify the signature")
    except Exception as ex:  # noqa: BLE001
        fails.append("signature invalid"); print("   FAIL signature invalid:", type(ex).__name__)

def der(b, o=0):
    tag, n, h = b[o], b[o + 1], 2
    if n & 0x80:
        k = n & 0x7F
        n, h = int.from_bytes(b[o + 2:o + 2 + k], "big"), 2 + k
    return tag, b[o + h:o + h + n], o + h + n


def der_kids(v):
    out, o = [], 0
    while o < len(v):
        tag, val, o = der(v, o)
        out.append((tag, val))
    return out


def read_tsr(b):
    ks = der_kids(der(b)[1])
    content = ks[1][1] if ks[0][0] == 0x30 else der(b)[1]
    sd = der_kids(der(der_kids(content)[1][1])[1])
    encap = der_kids(sd[2][1])
    tst = der_kids(der(der(encap[1][1])[1])[1])
    return der_kids(tst[2][1])[1][1].hex(), tst[4][1].decode()


print("\\n[5] Trusted timestamps")
if not os.path.exists(os.path.join(root, "timestamps", "index.json")):
    print("   none in this bundle")
else:
    audit_hash = {}
    for line in read("audit.jsonl", "r").splitlines():
        a = json.loads(line)
        audit_hash[a["seq"]] = a["hash"]
    file_hash = {f["evidenceId"]: f["sha256"] for f in manifest["files"]}
    trust = os.path.join(root, "timestamps", "trust.pem")
    ossl = shutil.which("openssl")
    for s in json.loads(read("timestamps/index.json")):
        try:
            imprint, gen = read_tsr(read(s["file"]))
        except Exception:  # noqa: BLE001
            fails.append("unreadable timestamp " + s["file"]); print("   FAIL unreadable", s["file"]); continue
        bad = []
        if imprint != s["hash"]:
            bad.append("token was issued for a different hash")
        if s["type"] == "evidence" and s["ref"] in file_hash and file_hash[s["ref"]] != s["hash"]:
            bad.append("the original changed after it was time-stamped")
        if s["type"] == "audit_head" and audit_hash.get(int(s["ref"]), s["hash"]) != s["hash"]:
            bad.append("audit entry " + s["ref"] + " changed after it was time-stamped")
        if s["type"] == "merkle_root" and manifest.get("scope") == "whole-case" and int(s["ref"]) == len(manifest["files"]) and s["hash"] != manifest["merkleRoot"]:
            bad.append("the evidence set changed after it was time-stamped")
        sig = "authority signature not checked"
        if not bad and ossl and os.path.exists(trust):
            when = calendar.timegm(time.strptime(gen[:14], "%Y%m%d%H%M%S"))
            r = subprocess.run([ossl, "ts", "-verify", "-in", os.path.join(root, s["file"]), "-digest", s["hash"], "-CAfile", trust, "-attime", str(when)], capture_output=True, text=True)
            if r.returncode == 0:
                sig = "authority signature ok"
            else:
                bad.append("authority signature check failed: " + (r.stderr.strip().splitlines() or ["openssl error"])[-1][:120])
        label = s["type"] + " " + s["ref"] + " at " + gen[:14]
        if bad:
            fails.append("timestamp " + s["file"] + ": " + "; ".join(bad)); print("   FAIL", label, "-", "; ".join(bad))
        else:
            print("   ok  ", label, "(" + sig + ")")

print("\\n" + ("VERIFIED: nothing was altered." if not fails else "NOT VERIFIED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
`;

export { VERIFY_PY };

export function bundleManifest(d, files, exportedAt) {
  return {
    format: 'tracevault-bundle/1',
    caseId: String(d.c._id),
    title: d.c.title,
    exportedAt,
    scope: d.scope ? 'shared-evidence' : 'whole-case',
    files,
    merkleRoot: d.merkle,
    auditHead: d.auditHead,
    auditCount: d.audits.length,
  };
}

export const auditJsonl = (audits) => audits.map(({ _id, ...a }) => JSON.stringify(a)).join('\n') + '\n';
export const fileHash = sha256;
export const safeName = (s) => String(s).replace(/[^\w.\- ()]+/g, '_').slice(0, 120);
