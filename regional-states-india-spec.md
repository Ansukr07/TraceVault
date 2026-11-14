# REGIONAL SPEC — Indian metro cities: offence rules, jurisdiction and report export

Status: draft v0.1 · 2026-11-14 · extends `future-advancement-spec.md` F3 (complaint pre-fill and offence mapping), F3.8 (jurisdiction hint) and `spec.md` §5.14 (reports and export).

> **Read this first — legal accuracy.** The statute list below was written from general knowledge of the Bharatiya Nyaya Sanhita 2023 (BNS), Bharatiya Nagarik Suraksha Sanhita 2023 (BNSS), Bharatiya Sakshya Adhiniyam 2023 (BSA) and the Information Technology Act 2000 (IT Act). It was **not** checked against the gazette text. Every record in the legal data files ships with `status: "unverified"` and is **not shown to users as a legal mapping until a lawyer has reviewed it and set `reviewedBy`**. Section numbers, cognizability, bail status and punishments must be copied from the official text (India Code, egazette.gov.in), never typed from this document. Police units, portals and helplines change; each record carries `verifiedAt` and `source`.

> **Implementation status (2026-11-14):** Phase 1 (build-plan days 1–5, minus items below) is in the repo. Data: `data/legal/{offences,metros,crosswalk,procedure}.json`. Engine: `apps/api/src/services/regional/` (`data.js`, `rules.js`, `profile.js`, `templates.js`, `regional.test.js`). Routes: `routes/legal.js`, `routes/regional.js`. UI: `pages/case/RegionalPanel.tsx` inside the Complaint wizard. `complaint.js` now reads `offences.json` and its output is unchanged (regression-tested).
> **Deviations:** (1) Complainant details are sent in the POST body for one render and are **not stored** (safer than the encrypted storage in §7). (2) RG1–RG4 are PDF only; **DOCX is not built** (needs the `docx` dependency). (3) RG5–RG8 stay on the existing Export page endpoints. (4) Admin upload/review endpoints are **not built**: a lawyer edits the JSON files directly and sets `reviewedBy`, `verifiedAt` and `source`. (5) `platforms.json` is not built; RG3 never prints a platform address. (6) For development, `LEGAL_ALLOW_UNREVIEWED=1` shows unreviewed rows to non-admins (flagged UNREVIEWED). (7) Routes were not exercised against MongoDB: the integration tests were skipped in this environment.

---

## 1. Purpose and scope

TraceVault already turns a processed case into a cited complaint draft (`apps/api/src/services/complaint.js`, `OFFENCE_RULES`). That table is a single national list. This spec adds the **regional layer**:

1. A maintained **legal catalogue**: offences (BNS, IT Act and a few related Acts) for cyber harassment, stalking, sexual harassment online, extortion/sextortion, impersonation, financial fraud and defamation, each with the evidence signals that support it.
2. A **metro registry**: for each major city, which police body takes the complaint, which cyber unit handles it, which portal or helpline applies, which languages to offer, and city-specific procedural notes.
3. A **report engine** that, for a chosen city and recipient, renders and exports the right report: police complaint, cyber-cell cover note, platform takedown request, bank/fraud freeze request, lawyer brief, Section 63 BSA certificate (already built) and an evidence bundle.

**In scope (v1):** eight metros: Delhi, Mumbai, Kolkata, Chennai, Bengaluru, Hyderabad, Ahmedabad, Pune. **Phase 2:** Gurugram, Noida, Lucknow, Jaipur, Surat, Kochi, Nagpur, Chandigarh. Outside the registry the engine falls back to the **national** profile (NCRP + nearest police station + Zero FIR).

**Out of scope:** filing anything on the user's behalf, legal advice, predicting the outcome, deciding guilt, any automated submission to a police portal. TraceVault produces a draft the complainant reviews and files themselves.

---

## 2. Guardrails (apply to every feature here)

| # | Rule |
|---|------|
| G1 | **Candidate, not conclusion.** Offences are shown as "provisions that may apply, matched from evidence", with strength `possible` / `strong` and the cited evidence. Never "you were a victim of section X". |
| G2 | **Lawyer gate.** A mapping or city record with `reviewedBy == null` is hidden from end users and rendered only for admins/lawyers, behind a visible "UNREVIEWED" tag. Exports refuse to include unreviewed provisions unless the exporting user is an admin who ticks "include unreviewed". |
| G3 | **Effective dates.** Every provision has `effectiveFrom` / `effectiveTo`. Events before **1 July 2024** map to the old IPC section (see §5.4), events on or after map to BNS. A case spanning the date shows both. |
| G4 | **Struck-down law guard.** Section 66A of the IT Act was struck down (*Shreya Singhal v. Union of India*, 2015). It must never appear in output. Keep it in the data as `status: "struck_down"` so the engine can detect and suppress it, and so a test can assert it. |
| G5 | **Minors.** If any party is a minor, the case switches to the POCSO/Juvenile profile: no automatic forwarding of imagery, mandatory-reporting notice shown, report export restricted to owner and lawyer. Do not generate templates for sexual content involving minors; show the helpline and stop. |
| G6 | **Privacy.** Complaint exports carry only what the user selected. The city/recipient choice never changes what is stored. Complainant address and ID numbers are user-entered, encrypted, and excluded from the evidence bundle by default. |
| G7 | **Same integrity rules as `spec.md`:** every export is audited (`REPORT_EXPORTED` with SHA-256), carries the viewer watermark, and is refused with `INTEGRITY_FAILED` when the chain does not verify. |
| G8 | **No fabricated specifics.** If the registry lacks a verified unit name, portal URL or phone, the report says "your nearest police station / cybercrime.gov.in" rather than inventing one. |

---

## 3. Jurisdiction model

### 3.1 How complaints reach the right office

- **Zero FIR / any station (BNSS s.173).** A cognizable offence can be reported at *any* police station irrespective of where it happened; the station records it and transfers it. Reports must say this so the user is never turned away for "wrong jurisdiction".
- **e-FIR / electronic information (BNSS s.173).** Information given electronically must be signed by the informant within the period the Sanhita prescribes (commonly cited as three days) for the FIR to be registered. The report's checklist includes "sign the e-FIR at the station within the time limit".
- **Preliminary enquiry window.** For offences in the 3–7 year band, BNSS s.173(3) allows a preliminary enquiry before registration with an officer-rank permission. The report advises citing the cognizable offence and asking for a written reason if registration is deferred.
- **Cyber offences, IT Act.** Investigation is by an officer of Inspector rank or above (IT Act s.78) and the Act reaches offences committed outside India that affect a computer in India (s.75). Offences under s.66C, 66D, 66E and 67 are generally cognizable and bailable-or-not depending on the section; **lawyer to confirm per row**.
- **Online financial fraud.** National cybercrime portal (**cybercrime.gov.in**) and the **1930** helpline are the fastest route to freeze a transfer. They sit in every city profile.
- **Commissionerate vs district police.** In the eight metros the police are organised as a **Commissionerate** (Commissioner of Police), which changes the names of units and the officers who take complaints. The registry stores the body type so the cover note addresses the right authority ("Commissioner of Police, X" vs "Superintendent of Police, X").

### 3.2 City registry schema (`data/legal/metros.json`)

```jsonc
{
  "schemaVersion": 1,
  "metros": [
    {
      "id": "blr",
      "name": "Bengaluru",
      "state": "Karnataka",
      "stateCode": "KA",
      "policeBody": { "type": "commissionerate", "name": "Bengaluru City Police", "head": "Commissioner of Police, Bengaluru City" },
      "cyberUnits": [
        { "name": "<verified unit name>", "kind": "cyber_ps", "scope": "city", "portalUrl": null, "phone": null, "email": null }
      ],
      "eFir": { "available": true, "url": null, "note": "Which offences accept e-FIR differs by state; verify." },
      "womenSupport": [{ "name": "State/City women's helpline", "phone": null }],
      "languages": ["en", "kn", "hi"],
      "bsaCertificateNote": null,
      "localNotes": [],
      "neighbours": ["<adjacent commissionerates the user may fall under>"],
      "status": "unverified",
      "reviewedBy": null,
      "verifiedAt": null,
      "source": null
    }
  ]
}
```

`cyberUnits[].phone/email/portalUrl` are **null until verified from an official page**; the renderer prints only non-null values.

### 3.3 Seed content per metro (verify every item before enabling)

| id | City | Police body (structure) | Cyber handling to confirm | Report languages | Notes the registry must capture |
|----|------|-------------------------|---------------------------|------------------|----------------------------------|
| del | Delhi | Delhi Police (single Commissionerate, district-wise) | Cyber police stations in districts; **IFSO** (Intelligence Fusion & Strategic Operations) for larger cyber matters | en, hi | Large volume: IFSO vs district cyber PS threshold; Delhi Police e-FIR and e-complaint portal. Capital: Delhi Commission for Women. |
| mum | Mumbai | Mumbai Police (Commissionerate); Navi Mumbai and Thane are **separate** commissionerates | Mumbai Police cyber cell/cyber police station; Maharashtra Cyber at state level | en, mr, hi | Greater Mumbai vs Navi Mumbai/Thane boundary must be asked, not guessed. Maharashtra State Commission for Women. |
| kol | Kolkata | Kolkata Police (Commissionerate); West Bengal Police outside the city | Kolkata Police cyber crime police station; state CID cyber wing | en, bn, hi | City vs district (Howrah, Barrackpore commissionerates) boundary question. |
| maa | Chennai | Greater Chennai Police (Commissionerate) | City cyber crime cell/wing within Crime Branch; Tamil Nadu Cyber Crime Wing at state level | en, ta | Tamil Nadu has a state-level preventive-detention law that has been extended to cyber offenders: **lawyer to confirm** before mentioning it in any template. |
| blr | Bengaluru | Bengaluru City Police (Commissionerate) | Cyber/Economic/Narcotics (CEN) police stations; Karnataka CID cyber unit | en, kn, hi | Karnataka's goondas law was widened to digital offenders: **confirm**. Kannada is the official language of the courts; offer a Kannada summary copy (§8). |
| hyd | Hyderabad | **Three** commissionerates: Hyderabad, Cyberabad, Rachakonda | Hyderabad Cyber Crime PS and the state **Telangana Cyber Security Bureau (TGCSB)** | en, te, hi, ur | The wrong-commissionerate problem is real here: the form asks for locality, not city name, and maps locality → commissionerate. |
| amd | Ahmedabad | Ahmedabad City Police (Commissionerate) | City cyber crime police station; Gujarat CID Crime cyber cell | en, gu, hi | Gujarat state portal for citizen complaints; confirm. |
| pnq | Pune | Pune City and Pimpri-Chinchwad are **separate** commissionerates | Pune City cyber police station; Pimpri-Chinchwad has its own | en, mr, hi | Same boundary question as Mumbai. |

Registry maintenance rule: **no row goes live without `verifiedAt` within the last 180 days** and a `source` URL to an official site. A nightly job flags rows past that age and the Export page falls back to the national profile for them.

---

## 4. Legal catalogue

### 4.1 Data shape (`data/legal/offences.json`)

One file, reviewed by a lawyer, edited without touching code. It replaces the inline `OFFENCE_RULES` table in `complaint.js` (which keeps working through a loader that reads this file).

```jsonc
{
  "schemaVersion": 1,
  "offences": [
    {
      "id": "stalking_cyber",
      "act": "Bharatiya Nyaya Sanhita, 2023",
      "section": "78",
      "title": "Stalking",
      "category": "harassment",
      "effectiveFrom": "2024-07-01",
      "legacy": { "act": "Indian Penal Code, 1860", "section": "354D" },
      "appliesTo": "any",                 // "any" | "woman_victim" | "minor_victim"
      "plainMeaning": "Repeatedly following or contacting a person, or monitoring their online use, despite clear disinterest.",
      "evidenceSignals": ["persistent_contact", "evasion_after_block", "monitoring"],
      "cognizable": null,                 // fill from official text: true | false
      "bailable": null,
      "punishment": null,                 // paste official wording; do not paraphrase
      "exportWording": {
        "en": "Repeated unwanted contact despite being blocked, as recorded in items {citations}.",
        "hi": null
      },
      "status": "unverified",
      "reviewedBy": null,
      "verifiedAt": null,
      "source": null
    }
  ]
}
```

Fields left `null` are intentional: they are filled from the gazette, never guessed.

### 4.2 Offence list by harm type (candidates for review)

**A. Online harassment, threats, stalking**

| id | Provision | What it is about | Typical evidence signal |
|----|-----------|------------------|--------------------------|
| intimidation | BNS 351 (IPC 503/506) | Criminal intimidation: threat of harm to person, reputation or property | `threat` label on messages |
| insult_provoke | BNS 352 (IPC 504) | Intentional insult to provoke breach of the peace | abusive messages |
| stalking | BNS 78 (IPC 354D) | Stalking incl. monitoring internet/email/electronic use | repeated contact, new accounts after block |
| modesty_word | BNS 79 (IPC 509) | Word, gesture or act insulting the modesty of a woman | `sexual` label on messages to a woman |
| sexual_harassment | BNS 75 (IPC 354A) | Sexual harassment incl. unwelcome contact, demands, showing pornography, sexually coloured remarks | explicit remarks, demands for favours |
| voyeurism | BNS 77 (IPC 354C) | Watching/capturing/sharing a private act of a woman without consent | intimate image/video evidence |
| obscene | BNS 294–296 | Obscene material/acts | explicit media |
| public_mischief | BNS 353 | Statements conducing to public mischief | circulated false claims |
| enmity | BNS 196 | Promoting enmity between groups | hate content (rare in personal cases) |
| conspiracy | BNS 61 | Criminal conspiracy | multiple coordinated accounts |

**B. Extortion, sextortion, blackmail**

| id | Provision | Notes |
|----|-----------|-------|
| extortion | BNS 308 (IPC 383–389) | Putting a person in fear to obtain money or valuables; the `extortion` label plus a demanded `amount` |
| sextortion | BNS 308 + IT Act 66E / 67 / 67A | Threat to share intimate images unless paid. The report stresses **preserve, do not pay, do not delete** |
| intimidation | BNS 351 | Threat component |

**C. Impersonation, identity and fraud**

| id | Provision | Notes |
|----|-----------|-------|
| identity_theft | IT Act 66C | Dishonest use of another's password, e-signature or unique identifier |
| personation | IT Act 66D | Cheating by personation using a computer resource |
| cheating | BNS 318 (IPC 420) | Cheating and dishonestly inducing delivery of property |
| cheating_personation | BNS 319 (IPC 416/419) | Cheating by personation |
| forgery | BNS 335, 336, 340 (IPC 463–471) | Forged documents/electronic records, using a forged record as genuine |
| computer_offences | IT Act 66, 43 | Dishonest/fraudulent unauthorised access, data damage |
| cbt | BNS 316 | Criminal breach of trust |
| theft_data | BNS 303 / IT Act 66B | Stolen device or resource |

**D. Privacy and reputation**

| id | Provision | Notes |
|----|-----------|-------|
| privacy | IT Act 66E | Capturing/publishing/transmitting a private area image without consent |
| obscene_electronic | IT Act 67, 67A | Publishing/transmitting obscene or sexually explicit material electronically |
| child_imagery | IT Act 67B + POCSO | **Minor profile only** (G5) |
| defamation | BNS 356 (IPC 499/500) | False statements harming reputation, incl. via social media |
| confidentiality | IT Act 72, 72A | Breach of confidentiality/privacy; disclosure in breach of a lawful contract |
| dpdp | Digital Personal Data Protection Act 2023 | Not a criminal complaint route; used for the **data-erasure / grievance** letter to a platform, if the Act's relevant provisions are in force at export time: **confirm in-force status** |

**E. Guard rows (never emitted)**

| id | Why it exists |
|----|---------------|
| it_66a | Struck down. Suppress always (G4). |
| ipc_after_cutoff | An IPC section may not be cited for conduct after 1 July 2024. |

### 4.3 Procedural and evidence provisions (cited in reports, not mapped from evidence)

| Provision | Used for |
|-----------|----------|
| BSA s.61, s.62, s.63 | Admissibility of electronic records; **s.63 certificate** (Part A by the party, Part B by the expert, with hash values). Already built as the draft certificate. |
| BSA s.57 | Primary evidence: the original electronic record |
| BNSS s.173 | FIR, Zero FIR, e-FIR |
| BNSS s.94 | Notice/summons to produce documents or electronic communication, used when asking an investigator to request platform data |
| BNSS s.105 | Audio-video recording of search and seizure (report tells the user to ask for it) |
| IT Act s.65B equivalent | Replaced by BSA s.63; if the court case predates BSA, the old s.65B(4) certificate is used: **the exporter must pick by case date** |
| IT (Intermediary Guidelines) Rules 2021, rule 3(2)(b) | Platform removal of non-consensual intimate imagery within the stated hours; used in the takedown template |

### 4.4 IPC ↔ BNS crosswalk (for old complaints and old evidence)

| Old (IPC) | New (BNS) | Subject |
|-----------|-----------|---------|
| 354 | 74 | Assault or criminal force to outrage modesty |
| 354A | 75 | Sexual harassment |
| 354C | 77 | Voyeurism |
| 354D | 78 | Stalking |
| 509 | 79 | Insulting modesty of a woman |
| 503, 506 | 351 | Criminal intimidation |
| 504 | 352 | Intentional insult |
| 383–389 | 308 | Extortion |
| 415, 420 | 318 | Cheating |
| 416, 419 | 319 | Cheating by personation |
| 463–471 | 335, 336, 340 | Forgery and use of forged documents |
| 499, 500 | 356 | Defamation |
| 120B | 61 | Criminal conspiracy |

Stored as `crosswalk.json`; reviewed by a lawyer like every other file. The complaint shows the BNS section by default and the legacy IPC section in brackets for events before the cutover date.

---

## 5. Rule engine

### 5.1 Inputs

Everything already produced by the pipeline: events (with `labels`, `category`, `amount`, `citations`), entities and identifiers, summary sections, insights (`messageCount`, `escalation`), plus new complainant-provided fields: `victimGender`, `victimIsMinor`, `incidentCity`, `complainantCity`, `locality`, `preferredLanguage`.

### 5.2 Algorithm

```
resolveProfile(case)
  1. city      = resolveCity(locality, incidentCity, complainantCity)   // §3.3 boundary questions
  2. profile   = metros[city] if reviewed and fresh else national
  3. date-cut  = splitEventsAtCutover(events, 2024-07-01)
  4. offences  = for each offence in catalogue:
                   skip if status in {struck_down} or (reviewedBy == null and !admin)
                   skip if appliesTo does not match victim facts
                   match evidenceSignals against case context
                   attach citations and strength (strong >= 2 independent items, else possible)
  5. recipients = recipientsFor(profile, offences)      // §6
  6. checks     = completeness checks (accused identifier, dates, narrative, victim facts)
```

`appliesTo: "woman_victim"` rules (BNS 74, 75, 77, 79) are emitted **only if the user supplied `victimGender`**. They are never inferred from a name or pronoun.

### 5.3 Signal vocabulary

The existing labels (`threat`, `sexual`, `extortion`) plus new ones from the ML service, each with a unit test and a fixture:

`persistent_contact`, `evasion_after_block`, `monitoring`, `impersonation_profile`, `public_shaming`, `intimate_media_threat`, `payment_demand`, `payment_made`, `forged_document`, `unauthorised_access`.

### 5.4 Rule table format

A rule is `{ offenceId, when: <signals expression>, minCitations }`, stored as JSON and compiled at load, so a lawyer edits JSON, not JavaScript. The current inline `test: (c) => ...` lambdas in `complaint.js` migrate to this format in one step; the old lambdas stay as a test oracle until the outputs match on the three demo cases.

---

## 6. Reports and export

### 6.1 Report types

| Code | Report | Audience | Format | Built on |
|------|--------|----------|--------|----------|
| RG1 | **Police complaint draft** (city-addressed) | Station / cyber PS | PDF + DOCX (editable) | F3 complaint |
| RG2 | **Cyber cell cover note** | Cyber PS / IFSO / TGCSB | PDF | New, one page |
| RG3 | **Platform takedown / preservation request** | Instagram, WhatsApp, X, Telegram, Facebook, etc. | PDF + plain text | New, per platform |
| RG4 | **Bank / UPI fraud freeze letter** | Bank nodal officer, with 1930 reference box | PDF | New |
| RG5 | **Lawyer brief** | Advocate | PDF | Existing `legal` report + offence table |
| RG6 | **Section 63 BSA certificate draft** | Court | PDF | Existing |
| RG7 | **Evidence bundle ZIP** with `verify.py` | Anyone | ZIP | Existing, plus a `regional/` folder holding the city profile and report inputs used |
| RG8 | **Regional-language summary copy** | Station staff / complainant | PDF | Existing R5, extended to the metro languages |

### 6.2 Content of the police complaint (RG1)

1. Addressed to the authority from the city profile (e.g. "The Commissioner of Police, Hyderabad" or "The Station House Officer, ___"), with `Zero FIR` request line.
2. Complainant block (user-entered; address optional).
3. Accused block: names, aliases, identifiers (phone, UPI, handle, email) with the evidence item each came from.
4. Incident period and place (online platform; city of the complainant).
5. **Narrative**: cited sentences only; unsupported sentences are dropped with a visible count, as in the existing complaint.
6. **Provisions that may apply** table: act, section, plain meaning, strength, citations. Legacy IPC in brackets for events before the cutover.
7. Losses and demands (`money`).
8. Evidence index with SHA-256, Merkle root, audit head, timestamp proof.
9. Preservation requests the user can ask the police to send (platform data, CDR, subscriber details, bank KYC), phrased as "request", not as legal instruction.
10. Declaration and signature line, labelled **DRAFT, prepared by TraceVault, to be reviewed by the complainant**.
11. Annex: the city checklist (§6.4).

### 6.3 Recipient resolver

`recipientsFor(profile, offences)` returns an ordered list the Export page shows as tabs:

1. If any offence category is `fraud` and a payment exists: **1930 / cybercrime.gov.in** first, with the elapsed-time notice ("report quickly; funds can sometimes be held if reported early").
2. The city's cyber unit (RG1/RG2).
3. Any station (Zero FIR) as the fallback.
4. Platform grievance officers (RG3) per platform found in the evidence.
5. Bank nodal officers (RG4) per bank/UPI handle found.
6. Women's/child-help channels when `victimGender`/`victimIsMinor` match.
7. Legal-aid contact per state, from the registry.

### 6.4 City checklist annex (data-driven)

Generated from the registry + procedure rules, for example:

- Carry original device and a photo ID; ask for the complaint receipt number.
- Ask for the FIR copy; if refused, ask for the written reason.
- If the e-FIR was used, sign it at the station within the permitted time.
- Do not delete chats, do not pay, do not reply to the accused.
- Keep the bundle and the `verify.py` output; note the date you uploaded.
- City note: e.g. Hyderabad "confirm which commissionerate covers your locality".

### 6.5 Rendering and export mechanics

- Reuse `services/export.js` and the PyMuPDF `/report/pdf` renderer. New templates live in `apps/api/src/services/regional/templates/*.js` as functions of `(caseData, profile, offences, lang)`.
- Each template has a **fixed stamp**: report code, case id, generation time, profile id and version, catalogue version, hash of the catalogue file, so a reader can tell which law table produced the page.
- DOCX output uses the `docx` library so the user can edit before filing; the PDF is the immutable, hashed copy. Only the PDF is added to the audit chain.
- Both outputs carry the viewer watermark. Both are audited: `REGIONAL_REPORT_EXPORTED` with `{ code, profileId, catalogueHash, sha256 }`.
- **Offline determinism:** the report must render with no network. The registry is a local JSON file.

### 6.5.1 Language handling

Complaint text is authored in **English** (authoritative). A machine-translated copy in the city's language (hi, mr, bn, ta, kn, te, gu, ur) is appended using the existing Sarvam translate path, with the labelled note "Machine-translated; the English text controls" (extends R5). Offence names are **not** machine-translated: they come from `exportWording[lang]` in the catalogue, filled by a lawyer, or fall back to English.

---

## 7. Data model additions (MongoDB)

```js
// legalCatalogue (versioned, admin-only writes)
{ _id, kind: 'offences'|'metros'|'crosswalk'|'procedure', version, sha256, body, status, reviewedBy, reviewedAt, createdAt }

// cases (new optional fields)
{ ..., regional: { complainantCity, incidentCity, locality, profileId, preferredLanguage, victimGender?, victimIsMinor? } }

// regionalExports
{ _id, caseId, code, profileId, catalogueVersion, catalogueSha256, lang, fileSha256, format, exportedBy, exportedAt }
```

New `AUDIT_EVENT_TYPES`: `REGIONAL_PROFILE_SET`, `REGIONAL_REPORT_EXPORTED`, `LEGAL_CATALOGUE_PUBLISHED`, `LEGAL_CATALOGUE_REVIEWED`.

---

## 8. API (Node, under the existing `/api`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/legal/metros` | List active, reviewed, fresh metro profiles (id, name, state, languages) |
| GET | `/legal/metros/:id` | One profile (cyber units, portals, notes) |
| GET | `/legal/offences` | Catalogue (reviewed only for non-admin) |
| GET | `/legal/crosswalk` | IPC ↔ BNS table |
| PUT | `/cases/:id/regional` | Set city/locality/language/victim facts (owner) |
| GET | `/cases/:id/regional/resolve` | Profile, offences, recipients, checks |
| GET | `/cases/:id/regional/reports` | Report types available for this city and case |
| GET | `/cases/:id/regional/report/:code.pdf?lang=` | Render RG1–RG6, RG8 |
| GET | `/cases/:id/regional/report/:code.docx?lang=` | Editable copy (RG1, RG3, RG4) |
| POST | `/admin/legal/:kind` | Upload a new catalogue file (admin; lands as `unverified`) |
| POST | `/admin/legal/:id/review` | Set `reviewedBy`, flips `status` to `reviewed` (lawyer role only) |

Role rules follow the existing matrix: owner all reports; investigator RG1/RG2/RG5–RG7 only with a grant; shared viewers never get RG1–RG4 (they contain complainant details).

---

## 9. Frontend

- **Case → Complaint tab (existing):** add a city picker at the top ("Where are you?"), then the provisions table, then a "Choose recipient" tab strip fed by §6.3.
- **Case → Export tab (existing):** new "Regional reports" card listing RG1–RG8 for the resolved city, with language picker and DOCX/PDF toggle.
- **Unreviewed banner:** whenever the profile or any provision is unreviewed, a persistent banner says so and the export buttons for end users are disabled.
- **Admin → Legal catalogue:** upload, diff against current version, mark reviewed. Shows rows older than 180 days in amber.
- Accessibility: city picker and recipient tabs are keyboard operable; Indic language previews use the embedded Noto fonts the PDF service already falls back to.

---

## 10. Repository additions

```
data/legal/
  offences.json          # §4
  metros.json            # §3
  crosswalk.json         # §4.4
  procedure.json         # §4.3, §6.4
  platforms.json         # takedown contacts/process per platform (verified, dated)
apps/api/src/services/regional/
  profile.js             # resolveProfile, resolveCity
  rules.js               # compile JSON rules, evaluate
  recipients.js          # recipientsFor
  templates/             # rg1.js ... rg8.js
apps/api/src/routes/legal.js
apps/api/src/routes/regional.js
apps/web/src/pages/case/RegionalReports.tsx
apps/web/src/pages/admin/LegalCatalogue.tsx
```

`complaint.js` keeps its signature; its `OFFENCE_RULES` becomes a thin loader over `offences.json` so Phase 1 ships without a UI change.

---

## 11. Acceptance criteria

| # | Criterion |
|---|-----------|
| 1 | For each of the 8 metros, a demo case exports RG1 addressed to that city's authority and lists the city language in the language picker. |
| 2 | An unreviewed catalogue row never appears in an end-user export; it appears for an admin with the UNREVIEWED tag. |
| 3 | Section 66A never appears in any output, asserted by a unit test that seeds a matching signal. |
| 4 | Events dated before 2024-07-01 show the IPC section first, BNS in brackets; later events the reverse. |
| 5 | `appliesTo: woman_victim` provisions do not appear unless `victimGender` is supplied. |
| 6 | A profile past 180 days or with no `source` falls back to the national profile and says so. |
| 7 | `victimIsMinor` switches to the minor profile: RG3/RG4 are disabled and the helpline notice is shown. |
| 8 | Every export is audited with the SHA-256 and `catalogueSha256`; changing the catalogue changes the stamp. |
| 9 | RG1 DOCX opens in Word and LibreOffice with the same content as the PDF. |
| 10 | The report renders with the network disabled. |
| 11 | Hindi, Marathi, Bengali, Tamil, Kannada, Telugu and Gujarati summary copies render without tofu glyphs. |
| 12 | Offence matching on the three demo cases equals the output of the current `OFFENCE_RULES` (regression oracle). |

---

## 12. Build plan (~5 dev-days + legal review)

| Day | Work |
|-----|------|
| 1 | Move `OFFENCE_RULES` into `offences.json`; loader; crosswalk; regression test (criterion 12); guard rows (66A, cutover) |
| 2 | `metros.json` schema and the 8 seeds as `unverified`; `resolveProfile`; boundary questions (Mumbai/Navi Mumbai/Thane, Hyderabad, Pune); fallback to national |
| 3 | Templates RG1, RG2, RG5; stamp; audit events; role gating |
| 4 | RG3, RG4 templates; recipient resolver; city checklist; DOCX |
| 5 | Frontend: city picker, regional card, unreviewed banner; admin catalogue page; translation copies |
| Parallel | **A lawyer reviews `offences.json`, `crosswalk.json`, `procedure.json` and each metro row**, with sources, and fills `cognizable`, `bailable`, `punishment`. Nothing ships to end users before this. |

---

## 13. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Wrong or outdated section number misleads a victim | Lawyer gate (G2), `verifiedAt` freshness check, "candidate" language, official-text fields never typed by us |
| Police unit renamed or restructured | 180-day freshness rule; fallback to national profile; `source` URL on every row |
| User is told the wrong commissionerate | Ask for locality, show the boundary question, always offer Zero FIR |
| Report read as legal advice | Fixed disclaimers on every page; no outcome predictions; wording "may apply" |
| Machine translation errors in legal wording | English controls; offence names from lawyer-filled `exportWording` only |
| Sensitive data leaks through exports | Complainant details excluded from the bundle by default; role gating; audit of every export |
| Law changes (new rules, amendments, court rulings) | Versioned catalogue; hash in every export; admin upload and review workflow |

---

## 14. Open questions for the product owner and the reviewing lawyer

1. Which lawyer or clinic will review the catalogue, and what turnaround is acceptable for the demo?
2. Should v1 include the state-level preventive-detention references (Tamil Nadu, Karnataka, Telangana), or leave them out until reviewed?
3. Do we want one `platforms.json` entry per platform with a grievance address, or only a generic template until each is verified?
4. Is a minor-victim flow in scope for v1, or only the guard that stops generation (G5)?
5. Which tier of the DPDP Act provisions is in force on the demo date, and do we want the erasure letter in v1?
6. Phase 2 cities: which five first?
