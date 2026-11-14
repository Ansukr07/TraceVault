# Roles and what each can do — TraceVault

Sources: **spec.md §2** (roles), **§5** (features, with IDs such as E1, T5), **§5.12–5.15** (privacy, sharing,
export, admin), **§10.1** (API roles), **§11** (pages); **prd.md §3, §12.1** (route-by-role table). The
*Official* role is not in the spec. It comes from `frontend-plan.md` (PS 3.2 government oversight) and is
marked as an extension below.

Rules that apply to every role:
- RBAC is enforced **twice**: route middleware (`requireCaseRole(...)`) and query filtering
  (`caseId ∈ user.accessibleCases`, plus evidence scope for shared users).
- A user with no role on a case gets **404, not 403**, so case IDs can't be probed.
- Shared access (**Legal**, **Investigator**) is **scoped, time-limited and revocable**. Every view is audited,
  watermarked (`Viewed by {email} · {timestamp} · Case {id}`), and the owner sees view counts.
- **Admin never sees case content** unless an Owner grants it.
- Originals are immutable for everyone. No role can edit or delete a sealed original.

---

## 1. At a glance

| Role | Who | Gets in by | Home page |
|---|---|---|---|
| **Owner** | Victim / complainant | Registers; creates the case | `/cases` |
| **Collaborator** | Trusted friend or family member | Invited by the Owner to one case | `/cases` |
| **Legal** | Lawyer / NGO counsellor | Owner's share link (expires) | `/legal` |
| **Investigator** | Police cyber cell | Officer account + Owner's share link (expires) | `/officer` |
| **Admin** | Platform operator | Admin flag | `/admin` |
| **Official** *(extension)* | Government / supervising officer | Created by an Admin | `/oversight` |

## 2. Capability matrix

✔ = allowed · — = not allowed · ◐ = limited (see notes)

| Capability | Owner | Collaborator | Legal | Investigator | Admin | Official |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Register / sign in, edit own profile (A1–A6) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Create a case (C1) | ✔ | — | — | — | — | — |
| Edit title / type / description / tags | ✔ | ✔ | — | — | — | — |
| Delete a case (crypto-shred, C5) | ✔ | — | — | — | — | — |
| Change privacy modes and voice consent (C3, §5.12) | ✔ | — | — | — | — | — |
| Upload evidence (E1–E4) | ✔ | ✔ | — | — | — | — |
| Record a voice statement (§6.4) | ✔ | ✔ | — | — | — | — |
| Reprocess evidence (E10) | ✔ | — | — | — | — | — |
| Read the case: overview, library, viewer, timeline, graph, summary, insights | ✔ | ✔ | ◐ | ◐ | — | — |
| Ask questions about the case, typed or by voice (S6, S7) | ✔ | ✔ | ◐ | ◐ | — | — |
| Annotate evidence (E9) | ✔ | ✔ | ✔ | — | — | — |
| Edit timeline events (T5) | ✔ | ✔ | — | — | — | — |
| Merge / split entities (N3, G6) | ✔ | ✔ | — | — | — | — |
| Set duplicate verdicts (N4) | ✔ | ✔ | — | — | — | — |
| Dismiss / explain an inconsistency (X4) | ✔ | ✔ | ✔ | — | — | — |
| Regenerate the summary (S5) | ✔ | — | — | — | — | — |
| View the audit log and **verify integrity** (V2, V3) | ✔ | ◐ | ✔ | ✔ | — | — |
| Export the report PDF (R1) | ✔ | — | ✔ | ✔ | — | — |
| Export the evidence bundle ZIP (R2) | ✔ | — | — | ✔ | — | — |
| Section 63 BSA certificate draft (R3) | ✔ | — | ◐ | ✔ | — | — |
| Create / list / revoke share grants (H1–H4) | ✔ | — | — | — | — | — |
| Accept a share invite (H2) | ✔ | ✔ | ✔ | ✔ | — | — |
| Set case status as police (Received → … → FIR registered) | — | — | — | ✔ | — | — |
| Request more evidence from the Owner | — | — | ✔ | ✔ | — | — |
| Private notes on a shared case | — | — | ✔ | ✔ | — | — |
| Manage users, verify officers, jobs, usage, health (O1–O4) | — | — | — | — | ✔ | — |
| Read aggregate oversight statistics | — | — | — | — | ◐ | ✔ |

Notes on ◐:
- **Collaborator audit/verify:** may view and verify within the invited case; cannot change anything about sharing or privacy.
- **Legal / Investigator reading:** only inside the **scope** of the grant (whole case or selected evidence). Out-of-scope evidence shows as "restricted" everywhere, including summary citations and the graph (H3).
- **Legal certificate:** spec lists "export the report" for Legal; the certificate draft is part of the report package, so treat it as read-only, report-attached.
- **Admin oversight:** an Admin can open `/oversight` because it holds no case content.

---

## 3. Owner (victim / complainant)

Full control of their own cases. Everything below is theirs by default.

| Area | Features (spec IDs) |
|---|---|
| Account | Email + password, short-lived JWT with rotating refresh token, profile with UI and voice language (A1, A2, A6); optional TOTP 2FA (A5, P2) |
| Cases | Create, list, view, update, delete; overview dashboard with counts, progress, key moments, mini timeline, top entities (C1, C2); privacy modes and consent (C3); timezone (C4); crypto-shred delete with title confirmation (C5); seal / addendum (C6, P2) |
| Evidence | Multi-file drag and drop (E1); client-side SHA-256 shown before upload (E2); server re-hash and sealing (E3); exact-duplicate warning (E4); library with filters and duplicate grouping (E6); source labels (E8); notes and tags (E9); reprocess (E10); live per-file status (E11) |
| Understanding | Viewer with OCR boxes, transcript, chat view, metadata red flags, hash badge, content guards (W1–W9); timeline lanes, filters, event drawer, edit (T1–T9); relationship graph with merge suggestions (G1–G7); inconsistencies with dismiss / explain (X1–X5); cited summary, regenerate, translate, listen, Q&A (S1–S9); insights (N11) |
| Voice | "Tell what happened" statement recorder with guided prompts, transcript and draft narrative editor (§6.4); voice Q&A and read-aloud (§6.5, §6.6) |
| Integrity | View audit chain, run **Verify** (green / red report), Merkle root, signed checkpoints (V1–V6) |
| Sharing | Grant form: recipient email, role (Legal or Investigator), scope, expiry, allow download; invite link shown once; active grants with view counts and the officer's status; revoke (H1–H5) |
| Export | Report PDF, evidence bundle ZIP, Section 63 BSA certificate draft, transcripts appendix (R1–R4) |
| Safety UX | Blur images and mask abusive words by default; content warning before severity-3 content (W8); AI output labelled with provider and confidence; every insight links to its source |

## 4. Collaborator

A trusted helper on **one invited case**. Works alongside the Owner, but cannot widen who sees the case.

- **Can:** read the case; upload evidence and record statements (E1, §6.4); annotate (E9); merge / split entities (N3, G6); edit timeline events (T5); set duplicate verdicts (N4); dismiss or explain inconsistencies (X4); ask questions (S6); view integrity (V3).
- **Cannot:** share, export, change privacy settings, change voice consent, regenerate the summary, delete the case, reprocess.
- **Pages:** the case tabs except Share, Export and Settings. Tab bar: Overview, Evidence, Timeline, Graph, Inconsistencies, Summary, Insights, Integrity, Add evidence.
- **Needs:** an invite flow from the Owner (not in the spec's share types, which only list Legal and Investigator; see *Gaps*).

## 5. Legal (lawyer / NGO counsellor)

Read-only, scoped, expiring access to cases an Owner shared.

- **Can:** read inside the grant's scope; annotate (E9); explain or dismiss inconsistencies with a note (X4); view the audit log and verify integrity (V2, V3); export the report PDF (R1); ask questions (S6); request more evidence from the Owner; keep private notes (never in exports unless chosen).
- **Cannot:** upload, edit events, merge entities, regenerate the summary, change privacy, share onward, export the evidence bundle, or set police case status.
- **Access:** the invite is accepted with the **same email** it was sent to; it expires; the Owner can revoke it at any time. Each open of the case is logged and shown to the Owner.
- **Pages:** `/legal` ("Shared with me" dashboard: active, expiring, download allowed, all shares) → the case tabs (Overview … Integrity, Export) with an access banner and a panel for requesting evidence and notes.

## 6. Investigator (police cyber cell)

Scoped, expiring access plus the case-handling workflow. Needs an **officer account**; unverified officers can accept shares but the Owner sees them as unverified until an Admin approves them.

- **Can:** everything Legal can read; **verify integrity** (V3); export the **report and the evidence bundle** (R1, R2) and the Section 63 certificate draft (R3) when the grant allows download; set case status (**Received → Under review → FIR registered → Closed**, plus *Needs more evidence*) with an FIR / complaint number; request more evidence; keep private notes.
- **Cannot:** upload, annotate, edit events, merge entities, change privacy, share onward.
- **Pages:** `/officer` (inbox: new shares, under review, expiring soon, total; search by title or FIR number; filters) → case workspace with the officer action panel; `/officer/verify` (offline bundle check); `/officer/profile` (agency, unit, rank, badge ID, verification status).
- **Visibility to the Owner:** status changes, FIR number, evidence requests and view counts appear on the Owner's Sharing page and are in the audit chain.

## 7. Admin (platform operator)

Runs the platform. **No access to case content** unless an Owner grants it.

- **Can:** list, search and disable users (O1); verify or reject officer accounts with a reason; create Official accounts; jobs dashboard with retry (O2); `/health` detail for API, DB, GridFS, ML models, GPU, Sarvam / Claude / Ollama (O3); provider usage meter for Sarvam and Claude by day (O4); open the Oversight dashboard (aggregates only).
- **Cannot:** read evidence, timelines, summaries or case titles; act as a case member.
- **Pages:** `/admin` with tabs Officer verification queue, Users, Background jobs, Provider usage, System health.

## 8. Official (government / supervising officer) — extension

Not in the spec. Added for PS 3.2's "traceability and controlled sharing with authorised parties" at institutional level.

- **Can:** see **aggregates only**: cases shared with police, median time to accept and to FIR, integrity checks run, grants that expired without action, status funnel, shares by incident type, per-unit table.
- **Privacy rule:** no case content, no complainant identities, no case titles; counts below the threshold (5 in production) are suppressed.
- **Cannot:** open any case, even one shared with their own jurisdiction.
- **Pages:** `/oversight`.

---

## 9. Page access by role

| Route | Owner | Collab. | Legal | Investig. | Admin | Official |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `/`, `/login`, `/register`, `/verify` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/share/accept` | ✔ | ✔ | ✔ | ✔ | — | — |
| `/cases`, `/cases/new` | ✔ | ◐ list only | ◐ list only | ◐ list only | — | — |
| `/cases/:id` overview, evidence, timeline, graph, inconsistencies, summary, insights, audit | ✔ | ✔ | ✔ scoped | ✔ scoped | — | — |
| `/cases/:id/upload`, `/statement` | ✔ | ✔ | — | — | — | — |
| `/cases/:id/share`, `/settings` | ✔ | — | — | — | — | — |
| `/cases/:id/export` | ✔ | — | ✔ report | ✔ report + bundle | — | — |
| `/legal` | — | — | ✔ | — | — | — |
| `/officer`, `/officer/verify` | — | — | — | ✔ | — | — |
| `/officer/profile` | — | — | — | ✔ | — | — |
| `/oversight` | — | — | — | — | ✔ | ✔ |
| `/admin` | — | — | — | — | ✔ | — |
| `/account` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

## 10. API roles (spec §10.1 / PRD §12.1)

| Endpoint | Roles |
|---|---|
| `POST /cases` | any signed-in user |
| `PATCH /cases/:id` | owner (spec) · owner + collaborator (PRD edit title/type/tags) |
| `DELETE /cases/:id`, `PATCH /cases/:id/settings`, `POST /evidence/:eid/reprocess`, `POST /cases/:id/summary/regenerate` | owner |
| `POST /cases/:id/evidence`, `PATCH /events/:evtId`, entity merge / split, `PATCH /duplicates/:gid` | owner, collaborator |
| `PATCH /inconsistencies/:iid` | owner, collaborator, legal |
| `GET /cases/:id/audit` | owner, legal, investigator |
| `POST /cases/:id/verify`, all `GET` read routes, `POST /cases/:id/ask` | any member (scoped) |
| `POST /cases/:id/shares`, `GET /cases/:id/shares`, `DELETE /shares/:sid` | owner |
| `POST /shares/accept` | authenticated recipient |
| `POST /cases/:id/export/report` | owner, legal, investigator |
| `POST /cases/:id/export/bundle` | owner, investigator |
| `GET /admin/*`, `POST /admin/jobs/:jid/retry` | admin |
| `GET /health` detail | admin (public gets status only) |

---

## 11. Verification log

Checked against the running local app with the five demo accounts (34 allow / refuse checks, all as the
matrix says): reading a case (owner, legal, investigator allowed; admin and official get 404), sharing,
privacy settings, delete, summary regenerate and upload (owner-only; legal and investigator refused),
report PDF (legal allowed), bundle ZIP (legal refused, investigator allowed), police status (investigator
only), oversight (official and admin only), admin routes (admin only). Not yet checked: **Collaborator**
(needs an accepted invite) and the officer approve / reject buttons.

## 12. Known gaps and conflicts to resolve

1. ~~**Collaborator invites.**~~ **Done:** the Sharing page now has a "Trusted helper (Collaborator)" option using the same invite link. It is whole-case, no export, and access lasts until the Owner removes it (the expiry only bounds how long the link can be accepted).
2. **Legal vs Investigator wording.** Spec §2 says Legal can "annotate, explain inconsistencies, export the report"; PRD §3 omits annotate for Investigator. This file follows the spec: Investigator verifies and exports, but does not annotate.
3. **Audit access for Collaborator.** PRD lists `GET /audit` for owner, legal, investigator only; Collaborator is read-only on integrity in this file. Confirm.
4. **Official role** is an extension, not spec. Keep or drop it; if kept, add it to spec §2.
5. **Officer verification** (admin approves badge IDs) is an extension for the Investigator role; spec does not define it.
6. **Admin + Owner grant.** Spec allows an Owner to grant an Admin content access; no UI or API for that exists in the plan.
