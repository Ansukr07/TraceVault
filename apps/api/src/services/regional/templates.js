// Regional report templates RG1–RG4 (regional-states-india-spec.md §6). Each is a pure function of
// (draft, resolved, complainant) returning HTML for the existing PDF renderer. Drafts only: nothing is filed anywhere.
// Complainant details come from the request body for this one render. They are not stored.
import { CSS, esc } from '../export.js';

const DISCLAIMER = 'DRAFT prepared with TraceVault for the complainant to review. It is not legal advice and has not been filed. Provisions listed are possibilities matched from the evidence for a lawyer to confirm.';
const rupees = (v) => (v == null ? '' : `Rs ${Number(v).toLocaleString('en-IN')}`);
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown');
const cites = (ids = []) => (ids.length ? ` <span class="cite">${ids.map((c) => `[${esc(c)}]`).join('')}</span>` : '');
const blank = (v) => (v ? esc(v) : '________');
const frame = (title, body, resolved) => `<html><head>${CSS}</head><body>
<p class="muted small">TRACEVAULT · ${esc(title.toUpperCase())}</p>
<div class="warn small"><b>Draft.</b> ${esc(DISCLAIMER)}</div>
${resolved.unreviewed ? '<div class="warn small bad"><b>UNREVIEWED.</b> The legal table or city profile used here has not been reviewed by a lawyer.</div>' : ''}
${resolved.profile.fellBack && resolved.profile.reason ? `<div class="box small">${esc(resolved.profile.reason)}</div>` : ''}
${body}
<p class="mono small muted">Law table ${esc(resolved.stamp.catalogueVersion)} · ${esc(resolved.stamp.catalogueSha256.slice(0, 16))} · profile ${esc(resolved.profile.id)}</p>
</body></html>`;

const identRows = (draft) => {
  const rows = [];
  for (const a of draft.accused) {
    rows.push(`<tr><td>${esc(a.name)}${a.aliases.length ? `<br/><span class="small muted">also: ${a.aliases.map(esc).join(', ')}</span>` : ''}</td><td>${a.identifiers.map((i) => `${esc(i.kind)}: ${esc(i.value)}`).join('<br/>') || '—'}</td></tr>`);
  }
  for (const i of draft.looseIdentifiers) rows.push(`<tr><td>Unnamed</td><td>${esc(i.kind)}: ${esc(i.value)}</td></tr>`);
  return rows.length ? `<table><tr><th width="35%">Name</th><th>Identifiers</th></tr>${rows.join('')}</table>` : '<p>________</p>';
};

const complainantBlock = (c = {}) =>
  `<table><tr><td width="25%">Name</td><td>${blank(c.name)}</td></tr><tr><td>Phone</td><td>${blank(c.phone)}</td></tr><tr><td>Email</td><td>${blank(c.email)}</td></tr><tr><td>Address</td><td>${blank(c.address)}</td></tr></table>`;

const provisions = (resolved) =>
  resolved.offences.length
    ? `<table><tr><th width="22%">Provision</th><th>What it is about</th><th width="14%">Strength</th><th width="20%">Evidence</th></tr>${resolved.offences
        .map((o) => `<tr><td>${esc(o.display)}${o.unreviewed ? ' <span class="bad small">unreviewed</span>' : ''}</td><td>${esc(o.title)}<br/><span class="small muted">${esc(o.plainMeaning)}</span></td><td>${esc(o.strength)}</td><td>${cites(o.citations)}</td></tr>`)
        .join('')}</table>`
    : '<p class="muted">No provisions are shown. Either none matched or the legal table is awaiting review.</p>';

const evidenceIndex = (d) =>
  `<table><tr><th width="8%">#</th><th>File</th><th>SHA-256</th></tr>${d.evidence.map((e) => `<tr><td>E${e.idx}</td><td>${esc(e.sourceLabel || e.filename)}</td><td class="mono">${esc(e.sha256)}</td></tr>`).join('')}</table>
<p class="small">Merkle root: <span class="mono">${esc(d.merkle)}</span><br/>Audit log head: <span class="mono">${esc(d.auditHead)}</span></p>`;

/** RG1: police complaint draft, addressed to the authority in the city profile. */
export function rg1({ draft, resolved, d, complainant }) {
  const p = resolved.profile;
  const unit = p.cyberUnits?.[0];
  const narrative = draft.narrative
    .map((s) => `<h3>${esc(s.title)}</h3>${s.sentences.filter((x) => x.supported).map((x) => `<p>${esc(x.text)}${cites(x.citations)}</p>`).join('')}`)
    .join('');
  const dropped = draft.narrative.reduce((n, s) => n + s.sentences.filter((x) => !x.supported).length, 0);
  return frame('Complaint draft', `
<h1>Complaint</h1>
<p>To,<br/><b>${esc(p.policeBody.head)}</b><br/>${esc(unit ? unit.name : p.policeBody.name)}</p>
<p><b>Subject:</b> Complaint regarding ${esc(draft.incident.category)} (online), and request to register an FIR.</p>
<div class="box small">If this is not the right police station for the place of the incident, I request that it be registered as a Zero FIR and transferred, as provided in section 173 of the Bharatiya Nagarik Suraksha Sanhita, 2023.</div>
<h2>1. Complainant</h2>${complainantBlock(complainant)}
<h2>2. Incident</h2><p>Period: ${esc(day(draft.incident.from))} to ${esc(day(draft.incident.to))}. Place: online (${draft.incident.eventCount} events recorded in the evidence).</p>
<h2>3. Accused (as identified from the evidence)</h2>${identRows(draft)}
<h2>4. Statement of facts</h2>${narrative || '<p>________</p>'}${dropped ? `<p class="small muted">${dropped} sentence(s) the checker could not confirm against the evidence were left out.</p>` : ''}
${draft.money.lossInr ? `<h2>5. Financial loss</h2><p>${esc(rupees(draft.money.lossInr))} was debited. Demands recorded: ${draft.money.demands.map((m) => esc(rupees(m.amount))).join(', ') || 'none'}.</p>` : ''}
<h2>${draft.money.lossInr ? '6' : '5'}. Provisions that may apply</h2>${provisions(resolved)}
<h2>${draft.money.lossInr ? '7' : '6'}. Evidence</h2>${evidenceIndex(d)}
<h2>${draft.money.lossInr ? '8' : '7'}. Requests</h2>
<p>1. Register an FIR and give me a free copy.<br/>2. Request the platforms and the banks concerned to preserve and provide the records relating to the identifiers listed above.<br/>3. Please give me a receipt or complaint number for this complaint.</p>
<p><br/>Declaration: the statements above are true to the best of my knowledge.<br/><br/>Signature: ____________________ &nbsp;&nbsp; Date: ____________</p>
<h2>Annex. What to do at the station</h2><ul>${resolved.checklist.map((x) => `<li>${esc(x)}</li>`).join('')}${p.localNotes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`, resolved);
}

/** RG2: one-page cover note for the cyber unit. */
export function rg2({ draft, resolved, d, complainant }) {
  const p = resolved.profile;
  return frame('Cyber cell cover note', `
<h1>Cover note</h1>
<p>To: <b>${esc(p.cyberUnits?.[0]?.name ?? p.policeBody.name)}</b>, ${esc(p.policeBody.head)}</p>
<p>From: ${esc(complainant?.name || 'Complainant')} · ${esc(complainant?.phone || '')}</p>
<p>I am submitting a complaint of <b>${esc(draft.incident.category)}</b> together with digital evidence that has been hashed and sealed. The evidence can be checked independently.</p>
<table><tr><td width="32%">Incident period</td><td>${esc(day(draft.incident.from))} to ${esc(day(draft.incident.to))}</td></tr>
<tr><td>Evidence items</td><td>${d.evidence.length}</td></tr>
<tr><td>Merkle root (SHA-256)</td><td class="mono">${esc(d.merkle)}</td></tr>
<tr><td>Audit chain</td><td>${d.chain.ok ? 'verified, unbroken' : '<span class="bad">does not verify</span>'}, head <span class="mono">${esc(d.auditHead)}</span></td></tr>
<tr><td>Accused identifiers</td><td>${draft.accused.flatMap((a) => a.identifiers).concat(draft.looseIdentifiers).map((i) => `${esc(i.kind)}: ${esc(i.value)}`).join('<br/>') || '—'}</td></tr></table>
<h3>Provisions that may apply</h3>${provisions(resolved)}
<p class="small">The attached bundle contains the original files, a manifest, the audit log, and verify.py to re-check everything offline. A draft certificate under section 63 of the Bharatiya Sakshya Adhiniyam, 2023 is also available.</p>`, resolved);
}

const PLATFORMS = { instagram: 'Instagram', whatsapp: 'WhatsApp', x: 'X', telegram: 'Telegram', facebook: 'Facebook', snapchat: 'Snapchat', other: 'the platform' };

/** RG3: takedown and preservation request. Contact addresses are never invented: the user sends it through the platform’s own report/grievance form. */
export function rg3({ draft, resolved, complainant, platform = 'other', handles = [] }) {
  const name = PLATFORMS[platform] ?? PLATFORMS.other;
  const ids = [...handles, ...draft.accused.flatMap((a) => a.identifiers.filter((i) => ['handle', 'url', 'phone', 'email'].includes(i.kind)).map((i) => i.value))];
  return frame('Platform request', `
<h1>Request for removal and preservation</h1>
<p>To: The Grievance Officer, ${esc(name)}<br/><span class="small muted">Send through ${esc(name)}’s own report or grievance form. Their contact details change; check the current ones in the app.</span></p>
<p>I, ${blank(complainant?.name)}, am reporting content and accounts used to harass me. I request that you:</p>
<ol><li>Remove or disable the content and accounts below.</li><li>Preserve all records relating to them (account details, login and IP logs, messages and posts), so that law enforcement can obtain them.</li><li>Acknowledge this request and tell me the reference number.</li></ol>
<h3>Accounts and identifiers</h3>${ids.length ? `<ul>${[...new Set(ids)].map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : '<p>________</p>'}
<h3>Why</h3><p>The content involves ${esc(draft.incident.category)}. Evidence references: ${cites(draft.offences.flatMap((o) => o.citations).slice(0, 6)) || '—'}</p>
<p class="small">If this concerns intimate images shared without consent, say so clearly when you submit; many platforms have a faster route for it.</p>
<p>Date: ____________ &nbsp;&nbsp; Signature: ____________________</p>`, resolved);
}

/** RG4: bank or UPI fraud freeze letter. */
export function rg4({ draft, resolved, d, complainant, bank = '' }) {
  const pays = d.events.filter((e) => e.category === 'payment' && e.amount);
  const upi = [...draft.accused.flatMap((a) => a.identifiers), ...draft.looseIdentifiers].filter((i) => ['upi', 'bank'].includes(i.kind));
  return frame('Fraud freeze letter', `
<h1>Request to hold funds and preserve records</h1>
<p>To: The Nodal Officer, ${esc(bank || '________ Bank')}</p>
<div class="box">National helpline <b>1930</b> / cybercrime.gov.in acknowledgement number: ____________________<br/><span class="small muted">Report the transfer there first if you have not. Quick reporting can help.</span></div>
<p>I, ${blank(complainant?.name)}, was induced to make the payments below. I request that you hold any funds remaining in the receiving accounts and preserve the account and transaction records for the police.</p>
<h3>Payments</h3>
${pays.length ? `<table><tr><th>Date</th><th>Amount</th><th>Evidence</th></tr>${pays.map((e) => `<tr><td>${esc(day(e.ts))}</td><td>${esc(rupees(e.amount))}</td><td>${cites(e.citations)}</td></tr>`).join('')}</table>` : '<p>________</p>'}
<h3>Receiving accounts (as found in the evidence)</h3>${upi.length ? `<ul>${upi.map((i) => `<li>${esc(i.kind)}: ${esc(i.value)}</li>`).join('')}</ul>` : '<p>________</p>'}
<p>Complainant: ${blank(complainant?.name)}, ${blank(complainant?.phone)}. Complaint or FIR number: ____________________</p>
<p>Date: ____________ &nbsp;&nbsp; Signature: ____________________</p>`, resolved);
}

export const TEMPLATES = { RG1: rg1, RG2: rg2, RG3: rg3, RG4: rg4 };
