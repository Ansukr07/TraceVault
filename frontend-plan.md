# Frontend Plan — TraceVault

Plan for every frontend page of TraceVault, derived from **PS 3.2** (AI-Powered Digital Evidence Intelligence
Platform), **spec.md §11** (pages, UX principles) and the feature specs it references (§5, §6). It adds an
**Officer Console** for police officers and an **Oversight dashboard** for government officials.

> **Design rule — applies to every page in this plan:** build only with `apps/web/design.md` and the tokens in
> `src/styles.css`. Paper + ink + one signal orange (at most 1–2 uses per screen), Doto for display numerals and
> hero words only, Geist for reading, Geist Mono for labels, hashes and metadata. No hard-coded colours, fonts
> or radii in components. Light-only. If a page needs something the system doesn't have, add it to `design.md`
> first, then build it.

---

## 1. PS 3.2 → where each requirement lives

| PS 3.2 requirement | Spec | Page(s) |
|---|---|---|
| Upload and organise evidence across formats | E1–E11 | Upload, Evidence library |
| OCR, NLP, speech-to-text, ML extraction | I1–I8, §6.1 | Viewer (OCR boxes, transcript, entity highlights) |
| Extract entities | N1, N3 | Viewer, Overview (top entities), Graph |
| Identify contextual relationships | N8, G1–G6 | Graph |
| Detect duplicate evidence | N4, E4 | Upload (exact-dup warning), Evidence library (grouping) |
| Reconstruct chronological timelines | N5, T1–T9 | Timeline, Overview (mini timeline) |
| Highlight inconsistencies across sources | N7, X1–X5 | Inconsistencies, Overview (count), Timeline (flags) |
| Structured summaries with direct references to evidence | N9, S1–S8 | Summary (citation chips → Viewer) |
| Visualise people, conversations, events | G1–G7 | Graph, Insights |
| Preserve original files | E5, V5 | Viewer (original pane), Evidence library (no edit/delete) |
| Cryptographic integrity verification | V1, V3, V4 | Audit & integrity, Viewer (hash badge + verify), Officer verify |
| Tamper-evident audit logs | V2, V6 | Audit & integrity |
| Secure storage, traceability | V5, V8, P | Case settings (privacy modes), every "view source" link |
| Controlled sharing with authorised parties | H1–H5 | Sharing, Accept invite, **Officer Console** |

---

## 2. Users and surfaces

Roles come from spec §2. The officer and official surfaces below are new; they **reuse those roles instead of
weakening them**.

| Surface | Who | Role(s) | Sees case content? |
|---|---|---|---|
| **Public** | Anyone | — | No |
| **Complainant app** | Victim, trusted helper | Owner, Collaborator | Own / invited cases |
| **Officer Console** | Police cyber-cell officer, investigating officer | Investigator (+ Legal for lawyers, NGO counsellors) | **Only cases a victim shared with them**, scoped, until the grant expires |
| **Oversight dashboard** | Government official, SP / nodal officer, station head | Official (new account flag) | **No.** Aggregates only, small counts suppressed |
| **Platform admin** | TraceVault operator | Admin | No (spec §2: no case content unless the Owner grants it) |

**Non-negotiable:** being a police officer or official does **not** grant access to any case. Content only reaches
an officer through an Owner-created share grant (H1–H4): scoped, expiring, watermarked (H5) and audited on every
view. The Oversight dashboard is built only from aggregate counts.

---

## 3. Route map

Status: **Built** = a route and page exist in `src/main.tsx` today (still to be checked against this plan) ·
**To build** = no page yet. Priority follows spec P0/P1/P2.

### 3.1 Public

| Route | Page | Status | P |
|---|---|---|---|
| `/` | Landing | Built | P0 |
| `/login`, `/register` | Auth (+ one-click demo in dev) | Built | P0 |
| `/share/accept?token=` | Accept invite | To build | P0 |
| `/verify` | Public file / bundle verifier (no login) | To build | P1 |

### 3.2 Complainant app

| Route | Page | Status | P |
|---|---|---|---|
| `/cases` | Case list | Built | P0 |
| `/cases/new` | New case (+ privacy consent step) | Built — add consent step and "start with voice" | P0 |
| `/cases/:id` | Overview | Built | P0 |
| `/cases/:id/upload` | Upload | Built | P0 |
| `/cases/:id/statement` | Voice statement | To build | P1 |
| `/cases/:id/evidence` | Evidence library | Built | P0 |
| `/cases/:id/evidence/:eid` | Viewer | Built | P0 |
| `/cases/:id/timeline` | Timeline | Built | P0 |
| `/cases/:id/graph` | Graph | Built (fix the `cytoscape-fcose` type error) | P0 |
| `/cases/:id/inconsistencies` | Inconsistencies | Built | P0 |
| `/cases/:id/summary` | Summary + Q&A | Built | P0 |
| `/cases/:id/insights` | Insights | Built | P1 |
| `/cases/:id/audit` | Audit & integrity | Built | P0 |
| `/cases/:id/share` | Sharing | To build | P0 |
| `/cases/:id/export` | Export | To build | P0 |
| `/cases/:id/settings` | Case settings | Built | P0 |
| `/account` | Profile & languages | To build | P1 |

### 3.3 Officer Console (new)

| Route | Page | Status | P |
|---|---|---|---|
| `/officer` | Officer inbox (shared cases) | To build | P0 |
| `/officer/cases/:id` | Case workspace (read-only, scoped) + action rail | To build | P0 |
| `/officer/cases/:id/*` | Same tabs as the complainant app, in scoped read-only mode | Reuse | P0 |
| `/officer/verify` | Verify an exported bundle or a single file | To build | P1 |
| `/officer/profile` | Officer profile, station, verification status | To build | P1 |

### 3.4 Oversight and platform admin (new)

| Route | Page | Status | P |
|---|---|---|---|
| `/oversight` | Government / supervisory dashboard (aggregates only) | To build | P1 |
| `/admin` | Platform ops: users, officer verification, jobs, provider usage, health | To build | P1 |

---

## 4. Shared foundation (build first)

Everything below goes in `src/ui.tsx` / `src/components.tsx`, styled in `styles.css` / `app.css` with design.md
tokens only.

| Component | Use | Design notes |
|---|---|---|
| `AppShell`, `Nav` | All signed-in pages | Floating white nav (design.md §5). Nav links change by surface: Cases · Officer · Oversight · Admin |
| `CaseShell` + tabs | All case pages | Tabs filtered by role: e.g. Investigator gets no Upload / Settings / Share. Eyebrow shows `incident · role` |
| `RoleGate` | Route guard | Wraps `Private`. Unknown or forbidden case → render 404 (spec: 404, not 403) |
| `PageHead` | Every page | Eyebrow + two-tone H1 + right-side actions |
| `CitationChip` | Summary, timeline drawer, Q&A, graph | Mono chip `[E3:12]`; hover preview (image crop / audio snippet / chat bubble); click → Viewer at the locator; "restricted" state for out-of-scope evidence |
| `HashBadge` | Viewer, library, audit, export | Mono, truncated SHA-256, copy button, `verify` action → ok / bad badge |
| `VerifyReport` | Audit, viewer, officer verify | Green (`--ok`) / red (`--bad`) report naming the first broken entry or file. The only place large status colour is allowed |
| `SeverityTag` | Timeline, inconsistencies, overview | Badges `ok` / `warn` / `bad`; severity 3 → content warning first |
| `ContentGuard` | Images, sev-3 text, audio | Blur / mask until click (W8). Remembered per session, never by default |
| `AiLabel` | Any AI output | "Transcribed by Sarvam · Hindi · 92%", "Summary · Claude · cloud_redacted". Mono, muted |
| `Watermark` | Shared viewers, exports | `Viewed by {email} · {ts} · Case {id}` diagonal, `--muted` at low opacity (H5) |
| `LiveStatus` | Overview, upload, library | Socket.IO `processing.*` → progress bar (`.progress`) and badges |
| `EmptyState`, `ErrorState`, `Skeleton` | Every list or data page | Doto word + one line + one action (pattern from Cases "Empty.") |
| `DataTable` | Library, audit, officer inbox, admin | Hairline rows, mono numerals, sticky header, keyboard row focus |
| `StatTile` | Overview, officer, oversight, admin | Mono eyebrow + Doto numeral + Geist caption (design.md "Stat") |

Cross-cutting rules for every page:
- **States**: loading (skeleton), empty, error (with retry), restricted (scoped share), and processing (live).
- **Trauma-informed**: calm copy, content warnings before severity-3 content, skippable voice prompts, no gamified words.
- **Traceable**: every AI insight has "view source" → Viewer locator.
- **i18n**: all strings through i18next (`en`, `hi`); original text always next to any translation.
- **Accessibility**: works at 360 px, full keyboard paths, visible focus (`--signal` ring), WCAG AA, `aria-live` for progress.

---

## 5. Page specs — Public

### 5.1 Landing `/` · Built
Hero (dot-matrix headline + connector diagram), guarantees band, intro with ASCII flower, closing, footer health.
**Add:** a "For police & officials" link to `/login?as=officer`, and a section that names the four roles.

### 5.2 Auth `/login`, `/register` · Built
**Add:** Zod-validated fields with inline errors; `?next=` redirect (e.g. back to `/share/accept`); after login,
route by role: complainant → `/cases`, officer → `/officer`, official → `/oversight`, admin → `/admin`.
Officer registration: extra fields (agency, station, badge / employee ID) → account starts **unverified**
until an admin verifies it (§8).

### 5.3 Accept invite `/share/accept?token=` · To build · P0 (H2)
- Token shown as invalid / expired / already used / valid.
- Valid: card with case title, who shared it, role (Legal / Investigator), scope (whole case / N items), expiry,
  download allowed. Primary: **Accept** (binds grant to the user; requires login → `?next=` back here).
- After accepting → `/officer/cases/:id` (Investigator / Legal) with a toast "Access until {date}".
- Design: centred auth-card layout; Doto word `Shared.`; facts as mono key/value rows.

### 5.4 Public verifier `/verify` · To build · P1 (R2, V3)
Drop an evidence bundle ZIP (or a file + its claimed SHA-256): hash in a Web Worker in the browser, check
`manifest.json`, recompute the audit chain and Merkle root, show a `VerifyReport`. Nothing is uploaded. Lets a
court clerk or defence counsel check integrity without an account.

---

## 6. Page specs — Complainant app

### 6.1 Cases `/cases` · Built
Case cards (type chip, status badge, Doto evidence count, last activity). **Add:** a "Shared with" avatars row per
case (active grants) and a filter for draft / processing / ready.

### 6.2 New case `/cases/new` · Built → extend
Two steps: (1) title, incident type (segmented), description; (2) **privacy consent screen** (spec §5.12 AC): the
defaults `llmMode=cloud_redacted`, `voiceMode=sarvam`, `translateMode=sarvam_redacted` explained on one screen,
with the explicit Sarvam voice consent checkbox. CTA choice: "Upload evidence" or "Start with a voice statement".

### 6.3 Overview `/cases/:id` · Built (C2)
StatTiles: evidence, people, events, inconsistencies, duplicates. Live processing progress. Key moments
(top 5 by severity × confidence) with citations. Mini timeline. Top entities. Insights preview.

### 6.4 Upload `/cases/:id/upload` · Built (E1–E4, E11)
Dropzone, per-file client SHA-256 (Web Worker) shown **before** upload, progress, `HASH_MISMATCH` and
exact-duplicate warnings, source label input, accepted formats as chips.

### 6.5 Voice statement `/cases/:id/statement` · To build · P1 (§6.4)
- Guided prompts ("When did it start?", "Who is involved?"), each **skippable**; language picker.
- Recorder: big ink record button, live level meter in dots, timer; pause/resume; re-record a segment.
- Transcript (original language) with an English toggle; `AiLabel`.
- Draft narrative editor (versioned, autosave); suggestion chips to prefill dates/names from evidence
  (apply → `POST /statements/:sid/suggestions/apply`).
- Statement-vs-evidence conflicts (X5) surface as inline `warn` notes linking to Inconsistencies.

### 6.6 Evidence library `/cases/:id/evidence` · Built (E6, E8, E9)
Grid / table toggle; filters: kind, source label, person, date, severity; duplicates collapsed under the canonical
item with an "N duplicates" chip; per-item status badge and `HashBadge`. No edit / delete actions on originals.

### 6.7 Viewer `/cases/:id/evidence/:eid` · Built (W1–W9)
Original left, extracted right. Images: OCR boxes ↔ text; PDFs: pages + OCR'd marker; audio: waveform +
synced transcript, speakers, language badge, translation toggle; chats: chat-bubble UI. Metadata panel with red
flags. `HashBadge` + verify. `ContentGuard` defaults. `Watermark` for shared users.

### 6.8 Timeline `/cases/:id/timeline` · Built (T1–T9)
Lanes by source / person / "Your account"; severity colours via status tokens; approximate times as range bars;
filters; event drawer (description, actors, citations, confidence, "corroborated by N sources"); edit event
(audited); audio events play the exact segment.

### 6.9 Graph `/cases/:id/graph` · Built (G1–G7)
fcose layout, layer toggles, time slider, centrality sizing, community colours drawn from a **muted categorical
set added to design.md** (orange stays reserved for the selected node), merge suggestions, click → cited messages,
export PNG.

### 6.10 Inconsistencies `/cases/:id/inconsistencies` · Built (X1–X5)
Side-by-side source cards, type badge, severity, one-line AI explanation (`AiLabel`), dismiss / explain with a note.

### 6.11 Summary `/cases/:id/summary` · Built (S1–S8)
Sections (Overview, Parties, Chronology, Threats & harm, Financial loss, Inconsistencies & gaps); every sentence
ends in `CitationChip`s; ⚠ "not fully supported" badge; language picker; Listen (TTS); regenerate (owner);
Q&A box with text + mic, answers with citations.

### 6.12 Insights `/cases/:id/insights` · Built (N11)
Escalation chart, day × hour heatmap (ink-density cells, not a rainbow), first contact, peak hours, response gaps.

### 6.13 Audit & integrity `/cases/:id/audit` · Built (V1–V6)
Chain table (seq, time, actor, role, action, hash prefix); **Verify** button → `VerifyReport`; Merkle root;
signed checkpoints; filter by actor role (so the owner can see every officer view).

### 6.14 Sharing `/cases/:id/share` · To build · P0 (H1–H5)
- Grant form: recipient email, role (Legal / Investigator), scope (whole case or pick evidence from a checklist),
  expiry (7 / 30 / 90 days / custom), allow download. Plain-language preview: "Inspector X will see 4 of 6 files
  until 14 Dec. Every view is logged."
- Active grants table: recipient, role, scope, expiry countdown, accepted?, **view count**, last viewed, revoke
  (confirm dialog). Officer status updates (§7.2) shown per grant.
- Invite link: copy once, shown only at creation (token not retrievable later).
- Owner only. Collaborators see the tab hidden.

### 6.15 Export `/cases/:id/export` · To build · P0 (R1–R5)
Three cards: **Report PDF** (summary, timeline, inconsistencies with explanations, evidence index with SHA-256,
Merkle root, audit head, signed checkpoint), **Evidence bundle ZIP** (originals, manifest, audit.jsonl, public key,
`verify.py`), **Section 63 BSA certificate draft** (clearly labelled "draft to assist"). Options: transcripts
appendix, regional-language summary copy. Progress → download. Every export is audited and watermarked.

### 6.16 Case settings `/cases/:id/settings` · Built (C3–C5, P)
Privacy modes with consequences explained; voice consent; timezone; delete case (type the title to confirm;
explains crypto-shred and that hashes stay in the audit log).

### 6.17 Account `/account` · To build · P1 (A6, A5)
Name, UI language, voice language, (P2) TOTP 2FA, active sessions with "sign out everywhere".

---

## 7. Officer Console — police officers

For an **Investigator** (police cyber cell / investigating officer) and, with the same layout, **Legal** users.
Design: same paper/ink system, but denser — tables over cards, mono metadata, no marketing type. Orange is used
only for "new / unacknowledged".

### 7.1 Officer inbox `/officer` · P0
- **StatTiles**: New shares · Under review · Access expiring in 7 days · Integrity checks run.
- **Inbox table** (`DataTable`): case title, complainant display name (as the owner chose), incident type chip,
  evidence count, scope ("4 of 6 files"), shared on, **access expires** (countdown, `warn` when < 7 days),
  officer status badge, last viewed. Row → `/officer/cases/:id`.
- Filters: status, incident type, expiring soon; search by title / reference number.
- Empty state: Doto `Inbox.` — "Cases appear here when a complainant shares them with you."
- **Unverified officer** banner: "Your officer account is pending verification. You can accept shares, but
  complainants will see you as unverified."

### 7.2 Case workspace `/officer/cases/:id` · P0
Reuses every case page through `CaseShell` in **scoped read-only mode**:
- Tabs: Overview, Evidence, Timeline, Graph, Inconsistencies, Summary, Insights, Integrity. **No** Upload,
  Statement, Settings or Share. Out-of-scope evidence shows "restricted" everywhere (H3).
- `Watermark` on every viewer; banner: "Shared by {owner} · Investigator access until {date} · Every view is logged."
- **Action rail** (right column on desktop, bottom sheet on mobile):
  - Officer status: `Received → Under review → FIR registered → Closed` (+ "Needs more evidence").
    Status changes are audited and **visible to the owner** on their Sharing page.
  - FIR / complaint reference number field.
  - **Verify integrity** → `VerifyReport` (V3), recorded in the audit log.
  - **Export** report PDF / bundle ZIP / Section 63 draft (only if the grant allows download).
  - **Request more evidence**: a message to the owner ("Please add the bank statement for June"), delivered as
    a notification on the owner's case. No free-form chat in MVP.
  - Officer notes: private to the officer, stored separately from evidence, never in exports unless chosen.

### 7.3 Verify `/officer/verify` · P1
Same engine as `/verify`, plus "Compare with a shared case": checks a bundle received offline against the live
case's Merkle root.

### 7.4 Officer profile `/officer/profile` · P1
Agency, station / unit, rank, badge or employee ID, official email, verification status and who verified it.

---

## 8. Oversight dashboard — government officials

`/oversight` · P1. For a supervising officer, district nodal officer or department official who needs the
picture **without reading anyone's evidence**.

- **No case content, no complainant identities, no case titles.** Only aggregate counts from grants and officer
  status events. Any count < 5 shows as "<5" (small-number suppression).
- **StatTiles**: Cases shared with officers (period) · Median time to acknowledge · Median time to FIR ·
  Integrity verifications run · Expired-without-action grants.
- **Charts** (dataviz rules: muted ink ramp, orange only for the highlighted series):
  - Shares over time by incident type (stacked bars).
  - Status funnel: Received → Under review → FIR → Closed.
  - Time-to-acknowledge distribution by unit / station.
  - Integrity outcomes (ok vs broken) — a broken result is shown as a count only and alerts the platform admin.
- **Units table**: station / unit, verified officers, open shares, overdue (> N days in "Received"), median
  response time. Row → unit detail (still aggregates).
- Filters: date range, district / unit, incident type. Export CSV of aggregates.

---

## 9. Platform admin

`/admin` · P1 (O1–O4). Tabs:
- **Users**: list, search, disable (O1); **officer verification queue** (approve / reject with reason, audited).
- **Jobs**: queued / running / failed, retry, per-step timings (O2) — job IDs and step names only, no content.
- **Provider usage**: Sarvam seconds / characters per day vs soft cap, Claude calls (O4).
- **Health**: API, DB, GridFS, ML models, GPU, Sarvam / Claude / Ollama reachability (O3), as status rows.

---

## 10. API needed by this plan (not in the API today)

The current API has auth, cases, evidence, case data (overview, timeline, graph, summary, ask, verify, settings,
audit). Needed for the pages above:

| Endpoint | For |
|---|---|
| `POST/GET /cases/:id/shares`, `DELETE /shares/:gid` | Sharing page (H1, H4) |
| `GET /share/preview?token=`, `POST /share/accept` | Accept invite (H2) |
| `GET /officer/cases` | Officer inbox (cases where `members.role ∈ {investigator, legal}` for this user and the grant is active) |
| `PATCH /officer/cases/:id/status` `{status, firNumber?}` | Officer status (audited, visible to owner) |
| `POST /officer/cases/:id/requests` · `GET /cases/:id/requests` | Request more evidence |
| `GET/PUT /officer/cases/:id/notes` | Officer private notes |
| `POST /cases/:id/export` `{type: report|bundle|certificate}` → job → download URL | Export (R1–R3) |
| `GET /cases/:id/statements`, `PATCH /statements/:sid`, `POST /statements/:sid/suggestions/apply` | Statement (spec §10.1) |
| `GET /oversight/summary?from&to&unit&type` | Oversight (aggregates, suppression server-side) |
| `GET /admin/users`, `PATCH /admin/users/:uid`, `GET /admin/officers/pending`, `POST /admin/officers/:uid/verify` | Admin users and officer verification |
| `GET /admin/jobs`, `POST /admin/jobs/:jid/retry`, `GET /admin/usage` | Admin (spec §10.1) |

**Data model additions:** `User.accountType: 'citizen' | 'officer' | 'official'`, `User.officer {agency, unit,
rank, badgeId, verifiedAt, verifiedBy}`; `ShareGrant {caseId, recipientEmail, role, scope, expiresAt,
allowDownload, tokenHash, acceptedBy, views[], officerStatus, firNumber}`. All status changes are audit-chain
entries.

---

## 11. Build order

| Phase | Pages / work | Why first |
|---|---|---|
| **0. Foundation** | Shared components (§4), role-aware `CaseShell` tabs, `RoleGate`, role-based post-login routing, fix `Graph.tsx` types | Everything depends on it |
| **1. Close the P0 loop** | Sharing, Accept invite, Export, New-case consent step | PS 3.2 "controlled sharing with authorised parties" |
| **2. Officer Console** | Officer inbox, scoped workspace + action rail, watermark, officer registration fields | Police use of the case file |
| **3. Oversight + Admin** | Oversight dashboard, Admin (users, officer verification, jobs, usage, health) | Government / operator view |
| **4. P1 polish** | Voice statement, Account, `/verify` + officer verify, i18n `hi`, content guards, Insights refinements | Depth and accessibility |
| **5. QA** | 360 px pass, keyboard pass, AA contrast check, demo-script run (spec §16.1) with the seeded demo account | Demo readiness |

**Definition of done for any page:** design.md tokens only; loading / empty / error / restricted states; keyboard
reachable; works at 360 px; strings in i18next; AI output labelled; every insight links to its source; role
checks on both route and API.

---

## 12. Open questions

1. **Officer identity:** who verifies officer accounts in the demo — a seeded admin, or a domain allowlist
   (e.g. official `.gov.in` / `.nic.in` emails)?
2. **Oversight scope:** is "unit / station" a free-text field on the officer profile, or a fixed list we seed?
3. **Owner visibility:** should the complainant see the officer's FIR number and status changes in real time
   (proposed: yes, on the Sharing page and Overview)?
4. **Demo data:** seed one verified officer with an active grant on the demo case, plus one official account, so
   the Officer Console and Oversight dashboard have data to show.
