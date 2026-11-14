# TraceVault: Phase 1 Demo Workflow (Ansu)

Case used: **Ananya Rao v. Karthik Menon** (synthetic). Cyber-stalking, harassment, defamation and extortion, 2–28 Sep 2024.
Files: `eval/data/ananya_case/`. Regenerate with `services/ml/.venv/Scripts/python eval/generate_harassment_case.py`.
All names, numbers, handles and UPI IDs are fictional. Keep the "synthetic demo data" label visible.

Total time: about 10 minutes. Every step below has: **Screen**, **Do**, **Say**, **Point at**, and **If it fails**.

---

## 0. Before you go on stage (checklist)

- [ ] Start all three services: MongoDB, the Node API (`apps/api`), the Python ML service (`services/ml`), plus the web app.
- [ ] `.env` has `SARVAM_API_KEY` (or `SARVAM_MOCK=true`) and `ANTHROPIC_API_KEY` (or Ollama running). Without these, voice and the cited summary will not work.
- [ ] Seeded role accounts exist (run `scripts/seed-roles.js`): owner, legal, investigator, admin, official. Note the demo emails and passwords on a card beside you.
- [ ] Do one full dry run with the real Ananya files so you know processing time. Then delete that case, or keep a pre-processed copy as a backup.
- [ ] Files ready in one folder, in upload order (see section 3).
- [ ] Open two browser windows: one signed in as the owner, one as the lawyer (for the share step).
- [ ] Known untested areas: **collaborator flow** and **officer approve/reject buttons**. Do not demo these live.

---

## 1. Landing and login (0:00–0:30)

**Screen:** Landing page, then Sign in.
**Do:** Click Sign in. Log in as the owner (Ananya).
**Say:** "Ananya has 7 screenshots, a chat export, an email and a bank PDF. Today that is a folder she cannot hand to police. Let's turn it into a case."
**Point at:** After login, the app routes by role, so the owner lands on the cases list.
**Behind the scenes:** Argon2id password check, short-lived JWT access token, refresh token in an httpOnly cookie.
**If it fails:** Use the backup session already logged in on the second window.

## 2. Create the case and give consent (0:30–1:00)

**Screen:** New case.
**Do:**
1. Title: "Ananya Rao – harassment and extortion".
2. Incident type: harassment / extortion.
3. Add a one-line description.
4. On the consent step, accept the notice that voice audio may be sent to Sarvam AI.
**Say:** "Before any audio leaves the machine, she has to consent. If Sarvam is down, it falls back to a local engine."
**Point at:** The consent checkbox, and the case appearing in the list.
**If it fails:** If the case does not save, check the API is running (`/health`).

## 3. Upload the evidence (1:00–2:15)

**Screen:** Upload page for the case.
**Do:** Drag in all files in this order:

| # | File | What it is |
|---|---|---|
| 1 | `01_whatsapp_persistent_contact.png` | Escalating contact 2–9 Sep, "please stop", then block |
| 2 | `02_instagram_dm_after_block.png` | Block evasion on a new handle |
| 3 | `03_sms_surveillance.png` | Unknown number, knows her metro and PG gate |
| 4 | `04_whatsapp_threats_second_sim.png` | Threats in English, Hinglish and Kannada |
| 5 | `05_instagram_fake_account.png` | Fake account, public defamation, 412 views |
| 6 | `06_whatsapp_demand_EDITED.png` | Rs 15,000 demand. **Planted: edited with Snapseed, modified 5 Oct** |
| 7 | `07_telegram_second_demand.png` | Second demand, Rs 30,000 |
| 8 | `WhatsApp Chat with Karthik Menon.txt` | Same chat as #1, #4, #6 (duplicate test) |
| 9 | `email_from_anon.eml` | Throwaway email, new threat |
| 10 | `hdfc_statement_sep2024.pdf` | Bank debits of Rs 25,000 and Rs 10,000 |
| 11 | `statement_text.txt` | Ananya's own account. **Planted: says she paid on 25 Sep** |

**Say:** "The browser fingerprints each file with SHA-256 before it uploads. The server recomputes the hash and only seals the file if they match."
**Point at:** The hash shown per file, the "sealed" status, and the first audit entry (`EVIDENCE_UPLOADED`).
**Behind the scenes:** Originals are immutable. There is no update endpoint for them. Every action is an entry in a hash-chained audit log.
**If it fails:** If a hash mismatch appears, re-upload that file. Do not explain it away on stage; it proves the check works.

## 4. Processing (2:15–3:15)

**Screen:** Live progress on the case.
**Do:** Wait while it runs. Do not click away.
**Say:** "Screenshots go through OCR. The Kannada threat is read in its own script and translated to an English working copy, but the original is always kept and cited. The chat export is parsed message by message."
**Point at:** Progress messages such as OCR 3/7 and "Linking entities…". They arrive live over Socket.IO.
**Behind the scenes (one sentence each):**
- OCR gives text with bounding boxes (English and Hindi).
- Entity extraction pulls PERSON, PHONE, UPI_ID, MONEY, DATE and more.
- Dates like "yesterday at 9" are resolved against the message's own timestamp.
- Duplicate detection runs in tiers, including screenshot-versus-export.
**If it is slow:** Fill the time with the "why" of each stage, or jump to the backup pre-processed case.

## 5. Evidence viewer (3:15–3:45)

**Screen:** Evidence library, then open `04_whatsapp_threats_second_sim.png`.
**Do:** Open it. Show the original beside the extracted text. Hover entity highlights.
**Say:** "The original is never changed. Next to it is what the system read, with every extracted phone number, amount and date highlighted."
**Point at:** The Kannada line and its translation. The highlighted amount.
**If it fails:** Open the `.txt` export instead; it is the simplest viewer case.

## 6. Entity graph (3:45–4:30)

**Screen:** Graph tab.
**Do:** Click the Karthik node. Show linked items. Highlight the two UPI IDs.
**Say:** "The system decided these are one person: two SIMs, three handles, one email. And two UPI IDs both receive money, which marks a payment-collection cluster."
**Point at:**
- One Karthik node linked to +91 98450 01234 and +91 70190 55555.
- Handles `@karthik.clicks`, `@anu.exposed` and `anon.truth.blr@proton.me`.
- UPI IDs `karthik.menon@okicici` and `ktk.pay88@ybl`.
**Why it matters:** Ananya could not have connected these by hand across 11 files.
**If it fails:** The graph page had type fixes planned in `frontend-plan.md`. Check the browser console and fall back to the Insights page.

## 7. Timeline (4:30–5:30)

**Screen:** Timeline tab.
**Do:** Scroll 2 Sep to 28 Sep. Click the 9 Sep event "please stop".
**Say:** "One chronological story built from 11 sources. Every event links back to the exact message or line it came from."
**Point at (what the platform actually shows for this case, 14 events):**
- 10 Sep: Instagram contact near Indiranagar (block evasion, as a place event)
- 12 Sep: payment of ₹640
- 18 Sep: Karthik named Nimbus (threat period)
- 22 Sep: ₹15,000 demand to `karthik.menon@okicici`; extortion demand; Ananya's replies
- 23 Sep: payment of ₹25,000 to `karthik.menon@okicici`
- 26 Sep: ₹30,000 demand via `ktk.pay88@ybl`; ₹25,000 demand
- 27 Sep: payment of ₹10,000 to `ktk.pay88@ybl`
- 28 Sep: anonymous extortion demand; place event (Indiranagar)

Click any event to see its source evidence.

**Known gaps to say honestly or fix before the demo:**
- No "consent withdrawal (9 Sep)" event, and no explicit "stalking", "defamation" or "block evasion" events. The timeline is built from messages with severity ≥ 1, money, or a place. The "please stop" message is not extracted as its own event.
- Some events are noise: "Active 2m ago" from an Instagram profile is tagged as a place, and "Priya replied about payment" is a misattributed name.
- The 14 events differ from the 12 in `eval/data/ananya_case/ground_truth.json`. Don't describe the timeline as matching the ground truth until G3 (Kendall's τ) is measured.

**Why it matters:** Order and consent are the core of a stalking complaint, so this is the step to prepare most carefully.
**If it fails:** If an event is misdated, show the correct-a-date option and point out that corrections are audited.

## 8. Inconsistencies (5:30–6:45)

**Screen:** Inconsistencies tab.
**Do:** Open each of the three flags.

| Flag | What the system found |
|---|---|
| `EDITED_FILE` | Screenshot #6 has Snapseed in its metadata and a modified date of 5 Oct, but the chat is from 22 Sep |
| `AMOUNT_MISMATCH` | Chat demands Rs 15,000; the bank shows Rs 25,000 debited |
| `DATE_CONFLICT` | Ananya's statement says she paid on 25 Sep; the bank says 23 Sep |

**Say:** "This is the honest part. Ananya re-cropped that screenshot, so it shows as edited. The platform tells her before a lawyer or an officer finds it. That is the difference between a surprise in court and a note in her file."
**Point at:** Each flag links to both conflicting sources. Show the dismiss/explain option.
**If it fails:** If one flag is missing, name the three expected ones anyway and open the sources to show the conflict by eye.

## 9. Cited summary (6:45–7:30)

**Screen:** Summary tab.
**Do:** Click one sentence. It jumps to the source evidence. Optionally use read-aloud in Kannada.
**Say:** "Every sentence cites its source. If a sentence cannot be supported, it is flagged, not hidden."
**Point at:** Citation markers, the AI-generated label, and any warning on unsupported text.
**If it fails:** Summary needs an LLM key. If it errors, skip to Share and say it runs on a configured model.

## 10. Share with a lawyer (7:30–8:30)

**Screen:** Share page (owner window), then the lawyer window.
**Do:**
1. Create a grant: lawyer's email, role **Legal**, scope (whole case or selected evidence), expiry, downloads on or off.
2. Copy the invite link, switch to the lawyer window and accept it.
3. Show the lawyer's "Shared with me" list and the scoped case view.
4. Back in the owner window, show that the lawyer's views appear in the log.
**Say:** "Access is limited by scope and expiry. Every view is logged. The lawyer can read and export the report, but cannot reshare the case."
**Point at:** The expiry date, the scope, and the access log.
**Role contrast (one sentence):** An investigator can verify and export the bundle; admin and official accounts get no case content at all.
**If it fails:** Skip the live second window and describe the roles using `role.md`.

## 11. Export and verify (8:30–9:30)

**Screen:** Export page, then Verify page.
**Do:**
1. Download the **report PDF**: summary, timeline, inconsistencies, evidence index with SHA-256 hashes, audit head hash, and the draft Section 63 BSA certificate.
2. Download the **evidence bundle ZIP** (originals, `manifest.json`, `audit.jsonl`).
3. Open the Verify page and upload the bundle. It reports that everything matches.
4. Optional: change one byte of a file in a copy and verify again, so it fails.
**Say:** "Anyone can check this bundle offline. Change one byte and verification fails."
**Point at:** The hashes in the report and the verified or failed result.
**If it fails:** Have a prebuilt bundle and the tampered copy ready on the desktop.

## 12. Close (9:30–10:00)

**Say:** "Preserve, extract, link, reconstruct, flag, cite, share. That is Phase 1."

---

## Feature status for this demo

**Works (built, and role-checked in `role.md` where noted):**
- Login with role-based access (34 allow/refuse checks passed)
- Case creation and consent
- Upload with client and server hashing, sealed originals, audit chain
- Processing pipeline: OCR, WhatsApp, PDF, email, entities, dedup, resolution
- Evidence viewer, graph, timeline, inconsistencies, cited summary
- Sharing with expiry and scope, invite acceptance
- Report PDF, bundle ZIP, Verify page

**Depends on configuration:** voice statement and read-aloud (Sarvam key), cited summary (LLM key).

**Not yet verified:** collaborator flow, officer approve/reject. Avoid in the live demo.

## Backup plan

- Keep a pre-processed copy of the Ananya case and a prebuilt bundle.
- Keep screenshots of each tab in a slide deck as a last resort.
- If the ML service is down, show the pre-processed case and skip the Processing step.
