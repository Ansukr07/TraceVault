# FUTURE ADVANCEMENT SPEC — TraceVault

> Companion to [spec.md](spec.md) (current build) and [prd.md](prd.md).
> Status: **draft v0.1** · Last updated: 2026-11-14
> Purpose: a build-ready spec for the features that come **after** the hackathon MVP. Each feature can be picked up on its own.
> Conventions reused from `spec.md`: `requireCaseRole(...)` RBAC, the hash-chained audit log, `chunks` / `derivedArtifacts` / `jobs` collections, the Python ML service on `127.0.0.1` with `X-Internal-Secret`, Socket.IO namespace `/cases`, Sarvam client with local fallback.

---

## 0. How to use this document

Every feature (`F1`…`F14`) has the same sections, so you can implement top to bottom:

1. **Goal and user value**: why it exists.
2. **Scope**: in, and explicitly out.
3. **Functional requirements**: numbered, testable. `P0` = ships first, `P1` = should have, `P2` = stretch.
4. **Data model**: new or changed MongoDB collections.
5. **API**: Node public routes and Python ML routes.
6. **ML / processing design**: algorithms and thresholds.
7. **UI**: pages and components.
8. **Security, privacy, audit**.
9. **Acceptance criteria**: what "done" means.
10. **Effort and dependencies**.

### 0.1 Roadmap and priority

| Wave | Features | Why this order |
|------|----------|----------------|
| **Wave 1: trust and credibility** (next) | F1 Authenticity detection · F2 Trusted timestamping · F3 Complaint pre-fill | Strengthens what a court or police officer sees. Mostly extends existing code. |
| **Wave 2: reach and safety** | F4 Mobile capture PWA · F5 Safety mode and risk score · F6 Full multilingual UI · F7 More importers | Gets the product into victims' hands safely. |
| **Wave 3: scale and network effects** | F8 Cross-case pattern linking · F9 Preservation and takedown letters · F10 Semantic search · F11 Collaboration threads | Needs more users and data to pay off. |
| **Wave 4: new channels** | F12 Live call capture · F13 IVR / phone intake | Highest regulatory and infra burden. |
| **Continuous** | F14 Production hardening | Do before any real-user launch, regardless of wave. |

### 0.3 Implementation status

| Feature | Status | Notes |
|---------|--------|-------|
| **F2 Trusted timestamping** | **Built (P0 + F2.4, F2.8 partly)**, 2026-11-14 | RFC 3161 request/verify in `services/tsp.js` (no new dependencies); service + jobs in `services/timestamps.js`; routes in `routes/timestamps.js`; bundle `timestamps/` + `verify.py` step [5]; report section; Export-page panel. |
| **F1 Authenticity** (images + metadata) | **Built (demo scope)** | ELA heatmap, editing-software and date checks, risk band, viewer panel, "needs attention" list. No C2PA, PDF forensics, copy-move or audio checks yet. |
| **F3 Complaint helper** | **Built (demo scope)** | 5-step wizard, cited narrative, candidate offences (not lawyer-reviewed), copy/print/.txt. Not yet: .docx, voice read-aloud, state helpline directory. |
| **F5 Safety** | **Built (demo scope)** | Escalation gauge with named, cited signals, helplines, Quick exit (Esc Esc), Discreet mode. Not yet: auto-lock, panic wipe, session list, trusted-contact alert. |
| **F6 Multilingual UI** | **Built differently from the spec** | Uses the Google Translate page widget (`lib/gtranslate.ts`), not react-i18next. Loads only after the user picks a language and accepts a notice; evidence-derived text is marked `translate="no"`. See note below. |
| F4, F7–F14 | Not started | |

**F2 deviations from the text below (decided while building):**
- **Route prefix is `/trusted-timestamps`**, not `/timestamps`. OpenTimestamps (spec V7) already owns `GET /cases/:id/timestamps` and `/:i.ots` in `routes/cases.js`, so F2.5 (OpenTimestamps) is **already done** and stays untouched on `Case.timestamps`. RFC 3161 tokens live in their own `timestamps` collection (`Timestamp` model).
- **Off by default.** With `TSA_PRIMARY_URL` empty nothing is created or sent. Set it (and ideally `TSA_TRUST_PEM_PATH`) to enable; see `.env.example`.
- Anchoring runs when `TIMESTAMP_ANCHOR_EVERY_N` audit entries accumulate after an evidence stamp, daily via a 15-minute sweep (which ignores `TIMESTAMP_*` entries so a quiet case does not re-anchor forever), or on demand. The sweep also re-queues stamps whose 8 retries were exhausted.
- Signature checks use the embedded signer certificate. `trust` is reported separately: `trusted` only when a chain to `TSA_TRUST_PEM_PATH` exists, else `unchecked`/`untrusted`. Offline, `verify.py` always checks the stamped hash against the bundle and, when `openssl` and `timestamps/trust.pem` are present, the authority's signature too.
- **Tested:** 9 unit tests against genuine openssl TSA tokens, and 5 end-to-end tests that run the shipped `verify.py` on a real bundle (tamper cases fail). The 8 MongoDB integration tests in `services/timestamps.integration.test.js` are written but **have not been run yet** (no reachable MongoDB in the build environment); run `npm test` in `apps/api` against a replica set. The HTTP routes and the Export panel were type-checked/syntax-checked only, not exercised against a live server.

**F6 note (Google Translate widget).** Chosen for zero cost and no API key. Trade-offs: page text is sent to Google, so the protected-content list (`PROTECT` in `lib/gtranslate.ts`) must be kept in step with any new screen that shows evidence, names or summaries; quality on legal wording is unreviewed; the widget needs network access to Google. English never contacts Google. Verified in a browser: the picker, consent flow, cookie and widget load, a Hindi translation of the interface, and that the case title, key moments and complaint text carry `translate="no"` before the widget loads. **Not verified together** in a single run: late in testing Google's widget stopped issuing translation requests in the test browser, so "translated labels + untouched evidence text" has not been seen on one screen.

**Kannada / Indic text from evidence (added after F6).** The bundled RapidOCR models are Chinese/English, so Kannada and Hindi screenshots were not read. Added: `app/lang/google_cloud.py` (official Cloud Translation v2 + Vision `DOCUMENT_TEXT_DETECTION`, API key), OCR provider modes `local` (default) | `auto` (Vision only when the local result is poor) | `google`, a translation provider chooser (`TRANSLATE_PROVIDER`), a per-case `settings.ocrMode` (`local` | `cloud`, default local) with a Settings control, and `ocrProvider` recorded on each OCR artifact. Tested with mocked Google responses (17 unit + 2 end-to-end through `/extract`); **never run against live Google** (no key available). Google's unofficial keyless translate endpoint returned HTTP 429 and is deliberately not used. Fully offline Kannada OCR (Tesseract `kan` or a RapidOCR Kannada recognition model) is the alternative if images must never leave the server; it needs a model download.

### 0.2 Cross-cutting rules (apply to every feature)

- **Originals are never modified.** New features write to `derivedArtifacts`, never over `evidence`.
- **Every state change is an audit event.** Add the new event types listed per feature to the `AUDIT_EVENT_TYPES` list.
- **Every AI output is labelled** with `generator { name, version, model, provider }` and can be re-run (`/reprocess`).
- **No legal conclusions.** The UI says "indicators" and "possible", never "forged", "guilty" or "admissible". Legal text references must carry "verify the current text before relying on it".
- **Privacy modes still apply.** Any feature that sends content to a cloud provider must respect `case.settings.llmMode`, `voiceMode`, `translateMode`, and show consent first.
- **Fallbacks.** Every external dependency needs a local or degraded path and a `provider.fallback` socket event.
- **Tests.** Each feature adds unit tests (Node: `*.test.js`, Python: `services/ml/tests/`), plus at least one integration test, plus an entry in the `eval/` harness if it produces a score.

---

# WAVE 1: Trust and credibility

---

## F1. Evidence authenticity and manipulation detection

### 1. Goal and user value
Today the system catches an edited screenshot only through metadata (e.g. Snapseed in EXIF, a modified time after the claimed event). Real cases involve AI-generated images, spliced chats and cloned voices, on both sides: a victim must know her own evidence will survive challenge, and an investigator must know what is suspect. F1 adds **technical authenticity indicators** with explanations, never a verdict.

### 2. Scope
**In:** image analysis, PDF structure analysis, audio spoof/edit indicators, C2PA content-credential reading, a per-evidence "authenticity report" and case-level rollup.
**Out:** deepfake *video* detection, forensic-grade courtroom certification, anything labelled as proof of forgery.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F1.1 | **Error Level Analysis (ELA)** on JPEG/PNG: produce an ELA heatmap and a numeric `elaScore` plus up to 5 flagged regions (bbox) | P0 |
| F1.2 | **C2PA / Content Credentials** reader: if a manifest exists, show issuer, signature validity, edit history, "AI-generated" assertion | P0 |
| F1.3 | **EXIF consistency checks**: software tag (editors), missing EXIF on a claimed camera photo, thumbnail ≠ main image, timestamp ordering (created ≤ modified), GPS vs. claimed location | P0 |
| F1.4 | **Screenshot structure checks**: compare the screenshot's device frame (status bar, resolution, font rendering) with known phone/app templates; flag mismatched fonts or pixel-grid artefacts in message bubbles | P1 |
| F1.5 | **Copy-move / splice detection** (keypoint matching, e.g. ORB + RANSAC) for duplicated regions inside one image | P1 |
| F1.6 | **PDF forensics**: incremental-update count, producer/creator mismatch, font substitution, text-layer vs. rendered-page mismatch, hidden layers | P0 |
| F1.7 | **Audio indicators**: edit-point detection (abrupt spectral discontinuity, re-encoding history, inconsistent noise floor) and a **synthetic-speech likelihood** from a pluggable detector | P1 |
| F1.8 | **Cross-evidence checks**: a screenshot of a chat that does not match the same message in the chat export (text, time, sender) is flagged as `content_mismatch` (builds on the existing cross-modal dedup) | P0 |
| F1.9 | Output a **0–100 `riskIndicator`** per item with a reasons list; never show a single "fake / real" label | P0 |
| F1.10 | Add authenticity findings to `/inconsistencies` and to the exported report with the wording "indicators, not proof" | P0 |
| F1.11 | Reprocess endpoint to re-run F1 when the detector version changes; old results are kept as prior versions | P1 |

### 4. Data model
```js
// derivedArtifacts — new type
{ type: 'authenticity', evidenceId, caseId,
  generator: { name: 'authenticity', version, model, provider: 'local' },
  riskIndicator: 0..100,
  checks: [{
    id: 'ela'|'c2pa'|'exif'|'screenshot_frame'|'copy_move'|'pdf_structure'|'audio_edit'|'audio_synthetic'|'content_mismatch',
    status: 'pass'|'warn'|'fail'|'not_applicable'|'error',
    score?: Number, summary: String,                      // human sentence
    details: Object,                                       // raw numbers
    regions?: [{ page?, bbox:[x,y,w,h], label }],
    artifactRef?: GridFSId                                 // heatmap image
  }],
  disclaimer: 'Indicators only. Not a forensic conclusion.' }

// inconsistencies — new kinds
{ kind: ... | 'authenticity_flag' | 'content_mismatch', evidenceIds, authenticityRef }
```
Index: `derivedArtifacts.caseId+type`, `derivedArtifacts.evidenceId+type+version`.

### 5. API
| Method | Path | Notes | Roles |
|--------|------|-------|-------|
| GET | `/evidence/:eid/authenticity` | Latest report | member (scoped) |
| POST | `/evidence/:eid/authenticity/run` | Re-run `{checks?}` | owner, investigator |
| GET | `/cases/:id/authenticity` | Rollup: counts by risk band, worst items | member |
| GET | `/evidence/:eid/authenticity/heatmap/:checkId` | PNG | member (scoped) |

ML (Python): `POST /authenticity/image`, `/authenticity/pdf`, `/authenticity/audio` — input multipart `file`, output the `checks` array above plus `usage[]`.

### 6. ML / processing design
- **ELA:** re-save JPEG at quality 90, take per-pixel absolute difference, amplify, blur, threshold at mean + 3σ. Flag connected regions > 0.5% of the area. Re-compressed images naturally look uniform; treat PNGs as `not_applicable` for ELA and say why.
- **C2PA:** use the `c2pa-python` library (or `c2patool` as a subprocess). Validate the signature chain and report trust-list status.
- **Audio synthetic likelihood:** wrap a replaceable detector behind `SpoofDetector.predict(wav) -> {score, model}`; ship with a baseline (e.g. an AASIST-style model) and mark the score "experimental". Short clips (< 3 s) return `not_applicable`.
- **Rollup:** `riskIndicator = clamp(max(check weights × scores))` with weights in a config file, not hard-coded. Calibrate on `eval/data/` including the planted edited screenshot.
- Run as a new pipeline step **after** `extract` and **before** `link`, so findings feed the inconsistency detector.

### 7. UI
- Evidence viewer: new **"Authenticity"** tab with the risk band (Low / Medium / High, colour **and** icon), a list of checks with one-line explanations, and a heatmap overlay toggle on the image.
- Case overview: "Evidence needing attention" card.
- Inconsistencies page: authenticity findings grouped under their own filter.
- Always render the disclaimer under the score.

### 8. Security, privacy, audit
Local-only by default (no cloud calls). Audit events: `AUTHENTICITY_RUN`, `AUTHENTICITY_VIEWED_BY_SHARED_USER`. Heatmaps are derived artifacts and follow evidence scope.

### 9. Acceptance criteria
- The planted edited screenshot (`06_whatsapp_demand_EDITED.png`) gets `riskIndicator ≥ 60` with an EXIF software reason.
- A pristine original photo gets `≤ 25`.
- An image from a C2PA-signed test file shows a valid signature; a tampered copy shows `fail`.
- No check ever outputs the words "fake", "forged" or "proof".
- Processing adds ≤ 5 s per image on CPU.

### 10. Effort and dependencies
~8–10 dev-days. Depends on: existing metadata parser, dedup, inconsistency detector. New libs: `c2pa-python`, `opencv-python-headless`, `numpy`, `librosa`.

---

## F2. Trusted timestamping and external anchoring

### 1. Goal and user value
The audit chain proves *internal* order, but the operator could rebuild the whole chain. An **independent time witness** proves that a given case state existed at a given time, which strengthens a Section 63 BSA certificate.

### 2. Scope
**In:** RFC 3161 timestamps for sealed evidence and audit-chain heads; optional OpenTimestamps (Bitcoin) anchoring; offline verification.
**Out:** running our own blockchain; holding a TSA private key ourselves.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F2.1 | On evidence seal, request an **RFC 3161 timestamp token** over the evidence SHA-256 from a configurable TSA; store the token | P0 |
| F2.2 | Every N audit entries (default 50) or every 24 h, timestamp the **audit-chain head hash** and the **Merkle root** of all evidence hashes | P0 |
| F2.3 | Verification: validate the token's signature, certificate chain and that the hash in the token equals the recorded hash | P0 |
| F2.4 | Support multiple TSAs; if the primary fails, queue a retry job and try the next | P1 |
| F2.5 | OpenTimestamps: submit the Merkle root to calendar servers, upgrade proofs later when confirmed | P2 |
| F2.6 | Include `timestamps/` (tokens + chain certs) in the evidence bundle; extend `verify.py` to check them **offline** | P0 |
| F2.7 | Report PDF shows each timestamp: time, TSA name, serial number, verification status | P0 |
| F2.8 | Admin health shows the TSA reachability and pending timestamp jobs | P1 |

### 4. Data model
```js
// timestamps (new)
{ caseId, subject: { type: 'evidence'|'audit_head'|'merkle_root', ref, hash },
  protocol: 'rfc3161'|'opentimestamps',
  tsa: { name, url }, token: Buffer, genTime: Date, serial: String,
  status: 'pending'|'issued'|'verified'|'failed', attempts: Number, lastError?,
  createdAt }
```
Index: `timestamps.caseId+subject.type`, `timestamps.status`.

### 5. API
| Method | Path | Notes | Roles |
|--------|------|-------|-------|
| GET | `/cases/:id/timestamps` | List with status | owner, legal, investigator |
| POST | `/cases/:id/timestamps/anchor` | Force anchor now | owner |
| POST | `/cases/:id/timestamps/verify` | Re-verify all | member |
| GET | `/timestamps/:tid/token` | Download `.tsr` | member |

### 6. Design
- Build a `TimestampRequest` with SHA-256 and `certReq=true`, nonce random, POST to the TSA as `application/timestamp-query`.
- Jobs of type `timestamp.issue` and `timestamp.upgrade` on the existing MongoDB job runner, with idempotent `key = caseId:subject:hash`.
- Verify with `openssl ts -verify` equivalent in code (Node: `pkijs`/`asn1js`) and in `verify.py`.
- **Privacy:** only a hash leaves the system. Never send content.

### 7. UI
Evidence viewer shows "Timestamped by `<TSA>` on `<date>`" with a green tick; Audit page shows anchor points on the chain; Verify page (`VerifyBundlePage`) lists timestamp results.

### 8. Security, privacy, audit
Events: `TIMESTAMP_ISSUED`, `TIMESTAMP_FAILED`, `TIMESTAMP_VERIFIED`. TSA URLs are config, not user input (prevents SSRF).

### 9. Acceptance criteria
- Uploading a file produces an `issued` timestamp within 30 s when the TSA is reachable.
- Altering one byte of the evidence makes offline `verify.py` fail on the timestamp check.
- With the TSA unreachable, uploads still succeed and a retry job is queued; the UI shows "timestamp pending".

### 10. Effort and dependencies
~5–6 dev-days. Depends on: audit chain, Merkle service, export bundle. Pick a free TSA for dev (e.g. FreeTSA) and a paid or government-accredited TSA for production; **verify which TSAs a court in the target jurisdiction would accept.**

---

## F3. Complaint pre-fill and offence mapping

### 1. Goal and user value
Victims often do not know what to write in a complaint, or which offences apply. F3 turns the cited summary into a **structured complaint draft** ready for the National Cybercrime Reporting Portal or a police station, in the victim's language.

### 2. Scope
**In:** a guided complaint draft, suggested offence categories, a printable PDF, a copy-paste "field-by-field" helper, a victim-reviewed checklist.
**Out:** automatic submission to government portals (no public API, and filing must be the victim's deliberate act); legal advice; picking charges.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F3.1 | Generate a **complaint draft** from the case: complainant details (entered by user), incident category, date range, accused identifiers (phones, handles, UPI IDs, URLs), loss amount, narrative, evidence list with hashes | P0 |
| F3.2 | **Field-by-field helper**: show the portal's fields in order with a copy button per field and a "done" tick; no scraping or automation of the portal | P0 |
| F3.3 | **Offence suggestions**: map case features (threats, extortion, stalking, impersonation, intimate images, financial fraud) to a *candidate list* of provisions (Bharatiya Nyaya Sanhita, IT Act) with the matching evidence items | P1 |
| F3.4 | Every suggestion is shown as **"possible, for a lawyer to confirm"** with a link back to the supporting evidence | P0 |
| F3.5 | Narrative is generated in the user's language and English; every sentence keeps its citation; user must review and accept before export | P0 |
| F3.6 | **Completeness check**: list missing mandatory fields (accused identifiers, dates, amount) before export | P0 |
| F3.7 | Export: PDF + `.docx` + plain text; also "police station copy" with an index of evidence | P1 |
| F3.8 | Optional **helpline/jurisdiction hint**: from the victim's state, show the relevant cyber cell contact and national helpline, from a maintained JSON file (not an API) | P2 |
| F3.9 | Voice flow: read the draft aloud and accept edits by voice (reuses V-TTS and V-INTAKE) | P2 |

### 4. Data model
```js
// complaints (new)
{ caseId, version, status: 'draft'|'reviewed'|'exported',
  channel: 'ncrp'|'police_station'|'other', lang,
  complainant: { name, phone?, email?, address?, state? },    // user-entered, encrypted
  incident: { category, subCategory?, from, to, lossAmountInr? },
  accused: [{ entityId, kind: 'phone'|'handle'|'upi'|'email'|'url'|'name', value }],
  narrative: { textNative, textEn, sentences: [{ text, citations: [chunkId] }] },
  offenceCandidates: [{ code, title, rationale, evidenceIds: [], confidence }],
  checks: [{ field, ok, message }], reviewedBy?, reviewedAt?, createdAt }
```

### 5. API
| Method | Path | Roles |
|--------|------|-------|
| POST | `/cases/:id/complaints` | owner |
| GET | `/cases/:id/complaints` · `/complaints/:cid` | owner, legal |
| PATCH | `/complaints/:cid` (new version) | owner |
| POST | `/complaints/:cid/review` | owner |
| GET | `/complaints/:cid/export?format=pdf|docx|txt` | owner, legal |

ML: `POST /case/complaint` → `{narrative, accused, offenceCandidates, checks}`.

### 6. Design
- Offence mapping is a **rules table** (`services/ml/app/case/offences.json`: feature → provisions → description) plus LLM only for *explaining* the match. **The provisions list must be written and reviewed by a lawyer; the spec does not hard-code legal text.**
- Reuse `summarize.py` validator so unsupported sentences are flagged.
- Redaction: when `llmMode=cloud_redacted`, run `lang/redact.py` before sending.

### 7. UI
New "Complaint" tab: stepper (Details → Accused → Narrative → Offences → Review → Export). Offence cards use neutral language and a persistent banner: "Suggestions only. A lawyer should confirm."

### 8. Security, privacy, audit
Complainant details are encrypted at rest; excluded from shared views unless the owner ticks "include". Events: `COMPLAINT_DRAFTED`, `COMPLAINT_EDITED`, `COMPLAINT_REVIEWED`, `COMPLAINT_EXPORTED`.

### 9. Acceptance criteria
- On the Ananya demo case the draft lists all accused identifiers found, both loss amounts (Rs 25,000 and Rs 10,000), and 100% of narrative sentences carry citations.
- Export is blocked until the user presses "Reviewed".
- A lawyer reviewing the rules table signs off before release (tracked in the repo as `offences.json` `reviewedBy`).

### 10. Effort and dependencies
~7–9 dev-days plus legal review time. Depends on summarizer, entity resolution, export service, voice TTS.

---

# WAVE 2: Reach and safety

---

## F4. Mobile capture PWA with capture-time hashing

### 1. Goal and user value
Evidence is strongest when hashed **at the moment of capture**. A phone-first, installable web app lets a victim capture a screen recording, photo, voice note, or share a file from another app straight into a case, hashed and timestamped on the device.

### 2. Scope
**In:** installable PWA, Web Share Target, offline queue, on-device hashing, capture metadata, camera/mic capture.
**Out:** native iOS/Android apps, screen recording of other apps (browsers cannot), device-forensics.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F4.1 | PWA manifest + service worker; installable on Android and iOS; works on a 360 px viewport | P0 |
| F4.2 | **Web Share Target**: "Share to TraceVault" from the gallery, WhatsApp, Files; opens a case picker then uploads | P0 |
| F4.3 | **Capture-time hash**: compute SHA-256 with Web Crypto in a Web Worker before any network call; store `{hash, capturedAt, deviceClock, tzOffset}` in IndexedDB | P0 |
| F4.4 | **Offline queue**: uploads retry with backoff; resumable chunked upload (tus-style); the queue survives restarts | P0 |
| F4.5 | In-app camera and voice recorder (MediaRecorder); attach geolocation **only with explicit per-capture consent** | P1 |
| F4.6 | **Clock-skew check**: send the device time with each capture; the server records `serverReceivedAt` and flags a skew > 5 min | P0 |
| F4.7 | Server issues the F2 timestamp on receipt and returns it to the device | P1 |
| F4.8 | App lock (PIN/biometric via WebAuthn) before the app opens | P1 |
| F4.9 | Low-data mode: image downscale is **never** applied to originals; only the preview is downscaled | P0 |

### 4. Data model
```js
// evidence — added
{ ..., capture: { channel: 'web'|'pwa_capture'|'pwa_share', capturedAt?, deviceClock?, tzOffsetMin?,
                  clientHash, hashAlgo: 'sha-256', skewMs?, geo?: { lat, lng, accuracyM, consent: true },
                  userAgent, appVersion } }
// uploads (new) — resumable sessions
{ uploadId, caseId, userId, size, received, clientHash, status, expiresAt }
```

### 5. API
| Method | Path | Notes |
|--------|------|-------|
| POST | `/cases/:id/uploads` | Create resumable session |
| PATCH | `/uploads/:uid` | Append chunk (`Upload-Offset` header) |
| POST | `/uploads/:uid/complete` | Server verifies hash, seals |
| GET | `/me/cases?fields=id,title` | Light list for the share-target picker |

### 6. Design
- Service worker handles the `share_target` POST and stores files in IndexedDB until a case is chosen.
- Hash with streaming `crypto.subtle.digest` over `Blob.stream()` chunks (use a WASM SHA-256 where streaming digest is unavailable).
- Background Sync API where supported; otherwise retry on app open. Note iOS limits: document the behaviour in the UI.

### 7. UI
Bottom-nav mobile layout; big "Capture" button; queue screen with per-file status (hashing, waiting, uploading, sealed, timestamped); clear offline banner.

### 8. Security, privacy, audit
Encrypt IndexedDB payloads with a key derived from the app-lock secret where feasible. Events: `EVIDENCE_CAPTURED`, `UPLOAD_RESUMED`, `CLOCK_SKEW_FLAGGED`.

### 9. Acceptance criteria
- Share a 40 MB video from Android gallery with flight mode on, restore connectivity, and the file appears sealed with a matching hash and `pwa_share` channel.
- Killing the app mid-upload resumes at the last chunk.
- A device clock set 1 h wrong produces a visible skew flag.

### 10. Effort and dependencies
~10–12 dev-days. Depends on F2 for the receipt timestamp (optional). New libs: `workbox`, `idb`, `tus-js-client` (or custom).

---

## F5. Safety mode and risk assessment

### 1. Goal and user value
Victims of stalking and domestic abuse may be **monitored by the abuser**. The app itself must not become a danger, and the product should surface when a situation is escalating.

### 2. Scope
**In:** discreet-use features, a transparent escalation/risk indicator, and safety resources.
**Out:** automatic reporting to authorities, predicting violence, any diagnosis.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F5.1 | **Quick exit** button (and `Esc` ×2) that navigates to a neutral site and clears the history entry via `location.replace` | P0 |
| F5.2 | **Discreet mode**: neutral app name/icon/title (e.g. "Notes"), no revealing notification text, no case titles in the document title | P0 |
| F5.3 | **Auto-lock** after N minutes of inactivity and on tab hide (configurable) | P0 |
| F5.4 | **Panic wipe (local)**: clear local storage, IndexedDB, service-worker caches and sign out. Server data stays | P0 |
| F5.5 | **Session and device list** with remote sign-out; alert on a new-device login (email to a *second* address the user chooses) | P1 |
| F5.6 | **Escalation indicator**: from existing severity + frequency + proximity signals produce `Low / Elevated / High` with reasons; shown to the owner only, never as a prediction | P1 |
| F5.7 | **Signals considered:** rising message frequency, threats with weapons/self-harm/location knowledge, block evasion, in-person proximity mentions, financial coercion, new accounts | P1 |
| F5.8 | **Resources panel**: national and state helplines and NGOs from a maintained JSON; one tap to call; offered when the indicator is `High` | P1 |
| F5.9 | Safe-sharing: a "trusted contact" can receive a **non-content** alert ("Review needed") with no case details | P2 |

### 4. Data model
```js
// users — added
{ safety: { discreetMode: Boolean, autoLockMin: Number, secondaryAlertEmail?: String (encrypted) } }
// sessions (new)
{ userId, deviceLabel, ip (truncated), userAgent, createdAt, lastSeenAt, revokedAt? }
// riskAssessments (new)
{ caseId, computedAt, level: 'low'|'elevated'|'high',
  signals: [{ id, label, weight, evidenceIds }], modelVersion, disclaimer }
```

### 5. API
| Method | Path | Roles |
|--------|------|-------|
| GET/PATCH | `/me/safety` | any |
| GET | `/me/sessions` · DELETE `/me/sessions/:sid` | any |
| GET | `/cases/:id/risk` | owner (and legal if owner allows) |

### 6. Design
Risk is a **transparent weighted rules model** (config file), not a black-box ML score. Each signal lists its evidence. Recompute after the pipeline `insights` step. Wording: "Signals in this case match patterns that advocates treat as higher-risk. This is not a prediction."

### 7. UI
Persistent small "Exit" control; settings page "Safety" section with a plain-language explanation of each option and what it does **not** protect against (e.g. browser history on a shared computer).

### 8. Security, privacy, audit
Risk is private by default; share only if the owner opts in. Events: `SAFETY_SETTINGS_CHANGED`, `SESSION_REVOKED`, `RISK_COMPUTED`. Do not log secondary alert addresses in plain text.

### 9. Acceptance criteria
- Quick exit lands on the neutral site in < 300 ms and the back button does not return to the app.
- With discreet mode on, no tab title, notification or manifest name contains "TraceVault" or case text.
- A case with escalating threats plus block evasion is rated `High` with at least two cited signals; a benign case is `Low`.
- Review by a domestic-violence/cyber-harassment advocate before launch is a release gate.

### 10. Effort and dependencies
~8 dev-days plus advocate review. Depends on severity classifier, insights job, sessions model.

---

## F6. Full multilingual UI

### 1. Goal
The processing handles many Indian languages, but the UI is English-first. F6 localises the interface and the generated documents.

### 2. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F6.1 | i18n framework (`react-i18next`), all strings externalised; no hard-coded UI text | P0 |
| F6.2 | Languages in order: English, Hindi, Kannada, Tamil, Telugu, Bengali, Marathi, Gujarati, Malayalam, Punjabi, Odia | P0 (en, hi) / P1 (rest) |
| F6.3 | Language picker in header, saved to `/me.uiLanguage`; auto-detected from the browser on first visit | P0 |
| F6.4 | Fonts: bundle Noto Sans families per script with `font-display: swap`; verify no tofu glyphs | P0 |
| F6.5 | Locale-aware dates/numbers/currency (`Intl`, INR lakh/crore grouping), timezone from `case.timezone` | P0 |
| F6.6 | Generated artifacts (summary, complaint, report PDF) in the chosen language; PDF embeds the needed fonts | P1 |
| F6.7 | **Translation workflow**: `locales/*.json` extracted by a script; machine-translate drafts with Sarvam, mark `needsReview`, a human reviews before release | P1 |
| F6.8 | Pseudo-locale and long-string test to catch overflow; RTL not required for current languages but keep logical CSS properties | P1 |

### 3. Design
- Keys namespaced by page: `case.timeline.title`. Plurals via ICU.
- CI job fails when a key exists in `en` but is missing in a shipped locale, or when strings are hard-coded (lint rule).
- Legal/disclaimer strings are **human-translated only**.

### 4. Acceptance criteria
- Switching to Hindi changes 100% of visible static strings on Landing, Upload, and all `case/*` pages; no layout break at 360 px.
- The PDF report renders Devanagari and Kannada correctly.
- A missing-key build check is in CI.

### 5. Effort
~6–8 dev-days of engineering plus translation review time per language.

---

## F7. Additional importers and sources

### 1. Goal
Cover more of where victims' evidence lives so they do not need workarounds.

### 2. Functional requirements
| ID | Source | Input | P |
|----|--------|-------|---|
| F7.1 | Telegram | Desktop JSON export | P0 |
| F7.2 | Instagram / Facebook | "Download your information" JSON/HTML (messages, login activity) | P1 |
| F7.3 | SMS backup | Android XML backup (`SMS Backup & Restore`) | P0 |
| F7.4 | Call logs | CSV/XML export, with duration and direction | P1 |
| F7.5 | Bank/UPI statements | CSV and PDF from major Indian banks; extract UPI refs, payee VPAs, amounts, timestamps | P0 |
| F7.6 | Signal | Plain-text/JSON export where available | P2 |
| F7.7 | Email | `.mbox` and `.msg` in addition to `.eml`, with full header analysis (SPF/DKIM/Received chain) | P1 |
| F7.8 | Archives | `.zip` containing the above; recursively processed, each child its own `evidence` with `parentEvidenceId` | P0 |
| F7.9 | Screen recordings | MP4: sample frames at 1 fps, OCR frames, dedupe consecutive frames, build chat-like chunks with frame timestamps | P2 |

### 3. Design
- Each importer is a module in `services/ml/app/parsers/` with the signature `parse(bytes, ctx) -> {chunks, entities?, metadata, warnings}` and is registered in a **parser registry** keyed by sniffed content type, not by file extension alone.
- Email header analysis feeds the inconsistency detector: mismatched `From` / `Return-Path`, DKIM fail, hop-time anomalies.
- Bank parsers are **template-driven** (YAML templates per bank + a generic LLM fallback flagged `lowConfidence`).
- Zip safety: cap depth (3), total uncompressed size, file count; reject path traversal and zip bombs.

### 4. Acceptance criteria
- Each importer has a sample fixture in `eval/data/` and a test asserting message count, first/last timestamp, and sender set.
- Malformed files produce `warnings`, never a crash; the job ends `partial`, not `failed`.
- A zip bomb fixture is rejected within 1 s with a clear error.

### 5. Effort
~2–3 dev-days per importer; email + bank are the largest.

---

# WAVE 3: Scale and network effects

---

## F8. Cross-case pattern linking (consent-based)

### 1. Goal and user value
The same harasser, phone number, UPI ID or scam script often targets many victims. Linking cases (with consent and strong privacy) helps NGOs and police see a **pattern**, which carries far more weight than a single complaint.

### 2. Scope
**In:** opt-in matching on **hashed identifiers**, pattern alerts for owners, an aggregated view for an authorised Organisation role.
**Out:** exposing one victim's content to another, any matching without explicit opt-in, global search of identities.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F8.1 | Per-case, explicit, revocable opt-in: "Help detect repeat offenders". Default **off** | P0 |
| F8.2 | When opted in, derive **blind index tokens** for accused identifiers (phone, UPI, email, handle, URL domain): `HMAC-SHA256(normalizedValue, orgKey)`. **Raw values are never stored in the pattern index** | P0 |
| F8.3 | A match is found when ≥ 2 opted-in cases share a token. Owners get a message: "Another opted-in case involves the same identifier." with **no** details of the other case | P0 |
| F8.4 | **Organisation role** (NGO/police unit) can see a match graph: cases (anonymous IDs), shared tokens (type only), counts, date ranges, incident categories | P1 |
| F8.5 | To go further, the org can send a **contact request**; each owner decides separately to accept, which reveals only what they choose | P1 |
| F8.6 | **Style/script matching** (P2): MinHash/embedding similarity of threat messages and scam scripts across opted-in cases, shown as "similar wording", threshold-tuned to avoid false links | P2 |
| F8.7 | Revoking consent removes the case's tokens within 24 h and logs the event | P0 |
| F8.8 | Matching is **advisory**; every link shows the match basis and a false-positive warning (shared numbers, recycled SIMs, common names) | P0 |
| F8.9 | Rate-limit and audit every Organisation query; no free-text search over tokens | P0 |

### 4. Data model
```js
// patternTokens (new) — separate collection, no raw values
{ token: String (HMAC), type: 'phone'|'upi'|'email'|'handle'|'domain',
  caseRef: String (random per-case pseudonym, not caseId), firstSeen: Date, category }
// patternLinks (new)
{ token, caseRefs: [String], count, firstSeen, lastSeen, categories: [String] }
// organisations (new)
{ name, kind: 'ngo'|'police', verifiedAt, verifiedBy, memberUserIds, keyId }
// consents (new)
{ caseId, userId, scope: 'pattern_matching', grantedAt, revokedAt? }
```
Index: `patternTokens.token`, `patternLinks.token` (unique).

### 5. API
| Method | Path | Roles |
|--------|------|-------|
| PUT | `/cases/:id/consents/pattern` | owner |
| GET | `/cases/:id/pattern-alerts` | owner |
| GET | `/org/patterns` · `/org/patterns/:token` | organisation |
| POST | `/org/contact-requests` | organisation |
| POST | `/contact-requests/:rid/respond` | owner |

### 6. Design
- **Key management:** the HMAC key is held by the Organisation/platform in a KMS; rotating it re-derives tokens from a background job that needs raw values, so tokens are re-computed **at consent time from the live entities**, not from a stored copy. Document this trade-off.
- Normalise identifiers exactly as entity resolution does (E.164 phone, lowercase email, UPI ID, stripped `@`).
- Pseudonym `caseRef` is random, so an org cannot map back to a case without the owner's consent.
- Differential-disclosure rule: do not show counts below 2; suppress tiny categories.

### 7. UI
Settings: a clear, plain-language consent screen with a "what is shared / not shared" diagram. Case overview: a dismissible "Possible repeat offender" banner. Org dashboard: matches table and a small cluster graph.

### 8. Security, privacy, audit
Legal review (DPDP Act 2023 or its current rules) before launch; data-protection impact assessment. Events: `PATTERN_CONSENT_GRANTED/REVOKED`, `PATTERN_MATCH_CREATED`, `ORG_PATTERN_VIEWED`, `CONTACT_REQUEST_*`.

### 9. Acceptance criteria
- Two synthetic opted-in cases sharing a phone number both receive an alert; neither can see the other's evidence.
- A case that did not opt in never produces tokens (test asserts zero rows).
- Revoking removes tokens and the match disappears for the other owner within the SLA.
- Security review confirms tokens cannot be reversed without the key.

### 10. Effort and dependencies
~12–15 dev-days plus legal. Depends on entity resolution and an Organisation role with verified onboarding.

---

## F9. Preservation and takedown request generator

### 1. Goal
Platforms delete data on a schedule, and intimate-image abuse needs quick takedown. F9 generates **ready-to-send letters and platform-specific report packs** from the case.

### 2. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F9.1 | Templates: **data-preservation request** (to a platform, via police/lawyer), **content takedown** (non-consensual intimate imagery, impersonation, defamation), **notice to a telecom/bank** to freeze or flag | P0 |
| F9.2 | Pre-fill from the case: offending URLs/handles/phones/UPI IDs, dates, evidence hashes, screenshot references | P0 |
| F9.3 | **Platform directory** (JSON): per platform the correct report URL, grievance-officer contact, required fields and typical turnaround; maintained by hand and dated | P1 |
| F9.4 | **URL capture**: for public URLs, fetch and archive a snapshot (HTML + rendered screenshot + hash + timestamp) as new evidence with `capture.channel = 'url_snapshot'` | P1 |
| F9.5 | Status tracker per request: Drafted → Sent → Acknowledged → Actioned/Rejected, with reference numbers and due dates | P1 |
| F9.6 | Output PDF/DOCX/plain text; **never auto-sends email**; the user or lawyer sends it | P0 |
| F9.7 | Special handling for sexual imagery: **never render the image** in generated letters; reference by hash and evidence ID, and blur by default in the UI | P0 |

### 3. Data model
```js
// requests (new)
{ caseId, kind: 'preservation'|'takedown'|'financial_freeze', target: { platform, urls: [], accounts: [] },
  body: { text, lang }, evidenceIds: [], status, refNumber?, sentAt?, dueAt?, events: [{ at, status, note }] }
// evidence — added capture.channel: 'url_snapshot'
```

### 4. Design / safety
- URL snapshot runs in an **isolated headless browser** (Playwright) with SSRF protection: block private IP ranges, limit redirects, time-box, disallow `file:` and non-HTTP(S).
- Legal citations in templates come from a lawyer-reviewed file; keep it separate from code.
- Do not fetch content that looks like CSAM; if detected, stop, do not store, and show reporting guidance. (Legal review required for the detection approach.)

### 5. Acceptance criteria
- A takedown letter for a fake Instagram account (demo item 05) pre-fills handle, URL, dates, view count and the evidence hash.
- A snapshot of a public test page is stored with hash + F2 timestamp.
- The SSRF test suite (private IPs, DNS rebinding, redirect to localhost) is rejected.

### 6. Effort
~7–9 dev-days. Depends on F2 (timestamps), export service.

---

## F10. Semantic search and conversational case exploration

### 1. Goal
Replace manual scrolling with "find where he mentioned my office" across languages, and make Q&A faster and more accurate.

### 2. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F10.1 | **Hybrid search**: keyword (Mongo text / BM25) + vector similarity over `chunks`, merged with reciprocal rank fusion | P0 |
| F10.2 | Multilingual embeddings so a Hindi query finds English/Kannada chunks (e.g. `multilingual-e5` or `bge-m3`, run locally) | P0 |
| F10.3 | Filters: evidence, speaker, entity, date range, severity, language | P0 |
| F10.4 | Results show a highlighted snippet and **jump to the exact locator** (bbox, audio ms, message index) in the viewer | P0 |
| F10.5 | Q&A (`/ask`) switches to retrieval-augmented: top-k chunks only, with every sentence cited and validated | P0 |
| F10.6 | Saved searches and "pin to timeline" for a result | P1 |
| F10.7 | Incremental indexing: new chunks are embedded by a job; deletions/redactions remove vectors | P0 |
| F10.8 | Respect scope: shared users only search within their granted evidence | P0 |

### 3. Design
- Store vectors in MongoDB Atlas Vector Search if available, otherwise `sqlite-vec`/`faiss` on the ML side with a per-case index file, **encrypted at rest** like other case data.
- The embedding model runs locally to avoid leaking content; cloud embeddings only when `llmMode=cloud` and the user agreed.
- Chunk → embedding job type `index.embed`, idempotent on `(chunkId, modelVersion)`.
- Crypto-shred: deleting a case deletes its vector index.

### 4. API
`GET /cases/:id/search?q=&filters=` · `POST /cases/:id/ask` (extended) · `POST /cases/:id/search/saved`.

### 5. Acceptance criteria
- Query "threat about my hostel" returns the Kannada/Hinglish threat chunk in the top 3 on the demo case.
- Scoped user cannot retrieve any chunk outside their scope (test with two grants).
- p95 search latency ≤ 500 ms on a 5,000-chunk case.

### 6. Effort
~8–10 dev-days.

---

## F11. Collaboration: comments, tasks and legal review workflow

### 1. Goal
Lawyers and the owner need to discuss evidence **inside** the case, with a record of who said what.

### 2. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F11.1 | Threaded **comments** anchored to an evidence locator, a timeline event, an inconsistency, or a summary sentence | P0 |
| F11.2 | `@mentions` with in-app and email notifications that contain **no content**, only "You have a new comment" | P0 |
| F11.3 | Comment visibility: `all members` or `legal only` (private lawyer notes the victim cannot edit but can see per policy, configurable) | P1 |
| F11.4 | **Review workflow** for inconsistencies and summary: `open → explained → accepted/disputed`, with who and when | P1 |
| F11.5 | **Tasks/checklist** ("Get bank certificate", "File complaint") with due dates and assignee | P1 |
| F11.6 | Real-time presence and updates over Socket.IO; optimistic UI with conflict resolution (last-write-wins for text, merge for lists) | P1 |
| F11.7 | Comments and review decisions are part of the audit chain and included in the report appendix | P0 |
| F11.8 | Expired share grants hide the user's future access but **keep their past comments** with a "(access ended)" label | P0 |

### 3. Data model
```js
// comments (new)
{ caseId, anchor: { type:'evidence'|'event'|'inconsistency'|'summary_sentence', id, locator? },
  parentId?, authorId, role, body, mentions: [userId], visibility, createdAt, editedAt?, deletedAt? }
// tasks (new)
{ caseId, title, assigneeId?, dueAt?, status, createdBy, linkedAnchor? }
```
Soft-delete only; keep an audit row for edits and deletes.

### 4. Acceptance criteria
- A legal user comments on one summary sentence; the owner sees it live within 2 s and the audit chain contains the event.
- A user whose grant expired cannot read or post but their old comments remain.

### 5. Effort
~6–8 dev-days.

---

# WAVE 4: New channels

---

## F12. Live call capture and real-time transcription

### 1. Goal
Capture **threatening calls as they happen** (with lawful consent) and get a live transcript, preserved as sealed evidence.

### 2. Scope and legal
**In:** in-browser/PWA recording of a call the user is a party to; live streaming STT; sealing on end.
**Out:** recording calls the user is not a party to; covert interception; bypassing OS limits on call recording.
**Legal gate:** consent-to-record rules for calls differ by jurisdiction. **Get legal sign-off and show a consent notice** before enabling. Disable by default behind a feature flag.

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F12.1 | **Speakerphone capture**: record via mic while the call is on speaker; show a clear guide because browsers cannot read call audio directly | P0 |
| F12.2 | WebSocket streaming of 16 kHz PCM chunks to the API; API relays to Sarvam streaming STT; partial and final transcripts come back live | P0 |
| F12.3 | Live captions panel with language detection and optional live English translation | P1 |
| F12.4 | On stop, assemble the full audio, hash, seal as `evidence(kind='audio', capture.channel='live_call')`, run the normal pipeline (diarization, NER, etc.) | P0 |
| F12.5 | **Live threat cue**: when severity rises above a threshold, show a calm banner with safety resources (F5) and a "mark moment" button that adds a timeline pin | P2 |
| F12.6 | Network loss: keep recording locally, upload on reconnect, mark the gap | P0 |
| F12.7 | Provider fallback: if the streaming STT fails, keep recording and transcribe in batch afterwards | P0 |
| F12.8 | Hard time cap (e.g. 60 min) and a visible recording indicator at all times | P0 |

### 4. Data model
```js
// liveSessions (new)
{ caseId, userId, startedAt, endedAt?, status:'streaming'|'finalizing'|'sealed'|'failed',
  provider, gaps: [{ fromMs, toMs, reason }], evidenceId?, consentAckAt }
```

### 5. API
- WebSocket `wss://…/api/v1/cases/:id/live` (auth via short-lived ticket from `POST /cases/:id/live/ticket`).
- ML: `WS /stt/stream` proxying Sarvam streaming; heartbeat every 10 s; backpressure drop policy documented.

### 6. Acceptance criteria
- End-to-end caption latency ≤ 2 s on a stable connection.
- Killing the network for 20 s yields a recording with a logged 20 s gap and a complete sealed file after reconnect.
- The audit log shows consent acknowledgement before recording started.

### 7. Effort
~10–12 dev-days plus legal review. Depends on F4 (PWA), voice service, F5.

---

## F13. Phone-line (IVR) intake

### 1. Goal
Reach victims without smartphones or data: call a number, speak in their language, and have the account recorded and drafted.

### 2. Scope
**In:** an inbound number via a telephony provider (e.g. Exotel, Twilio, or an Indian CPaaS), voice menu, recording, a case created from the call, SMS follow-up with a secure link.
**Out:** outbound unsolicited calls; handling emergencies (the menu must route to emergency numbers first).

### 3. Functional requirements
| ID | Requirement | P |
|----|-------------|---|
| F13.1 | Greeting in a chosen language (DTMF 1–9 for language), with the **emergency number advisory first** | P0 |
| F13.2 | Explicit **consent prompt** before recording; "press 1 to agree" | P0 |
| F13.3 | Record up to N minutes; webhook delivers the recording to the API when the call ends | P0 |
| F13.4 | Create a **pending intake** linked to the caller's number (hashed) and run the V-INTAKE pipeline (STT → narrative → suggestions) | P0 |
| F13.5 | **SMS link** to the caller to claim the case on the web with a one-time code; until claimed, data is auto-deleted after 30 days | P0 |
| F13.6 | Caller verification: call-back or OTP before any data is attached to an account | P1 |
| F13.7 | Voicemail-style fallback and abuse controls: per-number rate limit, blocklist | P1 |

### 4. Data model
```js
// intakes (new)
{ callerHash, language, recordingEvidenceId, status:'recorded'|'drafted'|'claimed'|'expired',
  claimCodeHash, claimExpiresAt, caseId? }
```

### 5. Risks
Recording-consent law; telecom regulation; costs per minute; abuse/spam; PII in call metadata. Needs a data-processing agreement with the telephony provider.

### 6. Acceptance criteria
- A test call in Hindi creates a pending intake with a transcript and a drafted narrative within 3 min of hangup.
- An unclaimed intake is purged at 30 days (job test with a time shift).
- No recording is stored if the caller does not give consent.

### 7. Effort
~10–14 dev-days plus provider setup. Depends on V-INTAKE and F12 (shared STT code).

---

# CONTINUOUS

---

## F14. Production hardening

These are required before real victims use the system. Not optional features, but a checklist.

| ID | Area | Requirement | P |
|----|------|-------------|---|
| F14.1 | Storage | GridFS → **S3/R2 with Object Lock (compliance mode)** for sealed originals; keep the `storage.backend` abstraction | P0 |
| F14.2 | Keys | Envelope encryption with a **KMS** (per-case DEK wrapped by a master key); documented crypto-shred on delete | P0 |
| F14.3 | Auth | TOTP 2FA (A4), WebAuthn passkeys, account recovery without email dependence, breach-password check | P0 |
| F14.4 | Rate limits | Per-IP and per-user on auth, upload, `/ask`, and share-link redemption | P0 |
| F14.5 | Observability | Structured logs with **no content**, OpenTelemetry traces across Node↔ML, metrics (queue depth, STT latency, fallback rate), alerts | P0 |
| F14.6 | Reliability | Job runner: dead-letter queue, poison-job quarantine, per-type concurrency, graceful shutdown; backups + restore drills for MongoDB | P0 |
| F14.7 | Security testing | SAST/DAST in CI, dependency audit, file-upload fuzzing, a pen-test before launch | P0 |
| F14.8 | Compliance | DPDP Act readiness: consent records, data-subject export/delete, retention schedule, breach runbook, grievance officer | P0 |
| F14.9 | Multi-tenancy | Organisation entity (NGO, police unit), SSO (OIDC/SAML) for orgs, per-org audit exports | P1 |
| F14.10 | Scale | Horizontal ML workers, GPU queue, model warm-up, streaming uploads, pagination on every list endpoint | P1 |
| F14.11 | Accessibility | WCAG 2.2 AA audit, screen-reader pass, keyboard-only flows, captions for any video help | P0 |
| F14.12 | Deployment | Repeatable deploy (IaC), staging that mirrors production, blue/green, secrets in a vault (no `.env` in prod) | P1 |

**Acceptance:** an external security review with no critical/high open findings, a successful restore drill, and a documented incident-response runbook.

---

# Appendix A. Shared contracts

### A.1 New audit event types
`AUTHENTICITY_RUN` · `TIMESTAMP_ISSUED` · `TIMESTAMP_FAILED` · `TIMESTAMP_VERIFIED` · `COMPLAINT_DRAFTED` · `COMPLAINT_EDITED` · `COMPLAINT_REVIEWED` · `COMPLAINT_EXPORTED` · `EVIDENCE_CAPTURED` · `UPLOAD_RESUMED` · `CLOCK_SKEW_FLAGGED` · `SAFETY_SETTINGS_CHANGED` · `SESSION_REVOKED` · `RISK_COMPUTED` · `PATTERN_CONSENT_GRANTED` · `PATTERN_CONSENT_REVOKED` · `PATTERN_MATCH_CREATED` · `ORG_PATTERN_VIEWED` · `REQUEST_DRAFTED` · `REQUEST_STATUS_CHANGED` · `URL_SNAPSHOT_TAKEN` · `COMMENT_ADDED` · `COMMENT_EDITED` · `COMMENT_DELETED` · `LIVE_SESSION_STARTED` · `LIVE_SESSION_SEALED` · `INTAKE_RECEIVED` · `INTAKE_CLAIMED`

### A.2 New job types (MongoDB job runner)
`authenticity.run` · `timestamp.issue` · `timestamp.upgrade` · `complaint.draft` · `index.embed` · `snapshot.url` · `pattern.tokenize` · `risk.compute` · `intake.expire`

### A.3 New socket events (namespace `/cases`)
`authenticity.ready` · `timestamp.issued` · `complaint.ready` · `risk.updated` · `pattern.alert` · `comment.added` · `live.caption` · `live.sealed`

### A.4 New roles
| Role | Added by | Notes |
|------|----------|-------|
| **Organisation member** | F8 / F14.9 | Aggregate pattern views only; never case content without owner consent |

### A.5 Config additions (`.env.example`)
```
# F2 timestamping
TSA_PRIMARY_URL=
TSA_FALLBACK_URL=
TIMESTAMP_ANCHOR_EVERY_N=50
# F1 authenticity
AUTHENTICITY_ENABLED=true
SPOOF_DETECTOR_MODEL=
# F8 pattern linking
PATTERN_HMAC_KEY_ID=
# F9 snapshots
SNAPSHOT_ALLOWED_PORTS=80,443
# F10 search
EMBEDDING_MODEL=bge-m3
VECTOR_BACKEND=atlas|faiss
# F12/F13 telephony
LIVE_CALL_ENABLED=false
IVR_PROVIDER=
IVR_WEBHOOK_SECRET=
```

---

# Appendix B. Open questions to resolve before building

1. **Legal review:** which offences table (F3), recording-consent rules (F12, F13), and takedown citations (F9) are authoritative? Who signs them off?
2. **TSA choice (F2):** which timestamp authority will be accepted in the intended courts?
3. **Organisation onboarding (F8):** who verifies an NGO or police unit, and who holds the HMAC key?
4. **Hosting region and DPDP obligations:** data residency for audio sent to Sarvam and any cloud LLM.
5. **Authenticity thresholds (F1):** needs a labelled set of genuine and manipulated samples; where does it come from?
6. **Safety review (F5):** which advocacy organisation reviews the risk signals and wording?
7. **Budget:** per-minute telephony (F13), TSA fees (F2), GPU for embeddings and spoof detection.

---

# Appendix C. Suggested build order inside each wave

**Wave 1:** F2.1 → F2.3 → F1.2/1.3/1.6/1.8 → F1.1 → F3.1/3.2/3.5/3.6 → F2.6/2.7 → F1.7 → F3.3.
**Wave 2:** F6.1 (do early, it touches everything) → F7.1/7.3/7.5/7.8 → F5.1–5.4 → F4.1–4.4 → F5.6–5.8 → F7.2/7.4/7.7 → F4.5–4.8.
**Wave 3:** F10 (unlocks better Q&A) → F11 → F9 → F8.
**Wave 4:** F12 shared STT streaming → F13.
**Continuous:** F14.1–F14.4 and F14.8 before any real-user pilot.
