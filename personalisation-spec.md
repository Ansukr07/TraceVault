# PERSONALISATION SPEC — Trauma-Informed Case Experience

> **TraceVault · Companion to [spec.md](spec.md)** · Status: v1.0 · 2026-11-14
> **One-line idea:** *The moment a victim creates a case, TraceVault reads what kind of harm happened and reshapes itself — tone, order of screens, safety steps, and support — so the product feels like a calm ally, not a government form.*

---

## 0. Why this exists (read this first)

A person opening TraceVault is rarely having a good day. They may be:

- being **blackmailed with private photos** and afraid to tell anyone,
- **followed online** by someone who keeps making new accounts,
- **cheated of savings** and feeling ashamed,
- **scared that the abuser will see their phone**.

A normal case-management tool treats all of them the same: *"Upload files → Fill form → Submit."* That fails real people. They freeze, abandon the case, or never start.

**Personalisation is not decoration. It is the difference between a victim who finishes their evidence file and one who closes the tab.**

### The promise (five rules every feature below must obey)

| # | Rule | Plain meaning |
|---|------|---------------|
| P1 | **Safety before evidence** | We ask "are you safe right now?" before "upload your files". |
| P2 | **She is in control** | Every sensitive step can be skipped, paused, or undone. Nothing is forced. |
| P3 | **No re-traumatising** | Abusive content is hidden/blurred by default. She never has to re-read it to use the product. |
| P4 | **Never blame, never judge** | Words like "you should have…" or "why did you…" are banned from the UI. |
| P5 | **Small steps** | One gentle action per screen. Progress is celebrated, not graded. |

---

## 1. What "personalisation" means here (beginner explanation)

Imagine walking into a hospital.
A good nurse doesn't hand a crying patient a 12-page form. They **look at what is wrong, then change how they behave**: speak softly, bring water, call the right doctor, fill the form *for* you.

TraceVault does the same in software:

```
 Victim creates a case
        │
        ▼
 1. TraceVault learns the case TYPE   (harassment / fraud / stalking / sextortion / other)
        │
        ▼
 2. It picks a SUPPORT PROFILE         (a bundle of tone + screens + safety tools)
        │
        ▼
 3. The whole app quietly adapts       (wording, order, colours, helplines, defaults)
        │
        ▼
 4. As evidence arrives, it RE-ADAPTS  (if threats appear, safety help rises to the top)
```

> **Key point:** the *evidence handling stays identical and legally strict* (hashing, audit chain, sealing). Only the **experience wrapped around it** changes. Personalisation never weakens integrity.

---

## 2. How the case type is decided

The case model already stores `incidentType` (`harassment | fraud | stalking | sextortion | other`).
Personalisation needs a type on **day one**, before any evidence is uploaded.

### 2.1 Creation flow (the "Gentle Intake")

```
Screen 1  "You're safe here. Take your time."
          [ Start ]   [ I need help right now → Emergency panel ]

Screen 2  "What happened? Pick the closest — you can change this later."
          ○ Someone is threatening to share my private photos/videos
          ○ Someone keeps contacting or following me online
          ○ Someone is abusing, insulting or shaming me online
          ○ Someone took my money or tricked me
          ○ I'm not sure / something else

Screen 3  "Is the person still contacting you?"  ○ Yes  ○ No  ○ Not sure
Screen 4  "Is it safe to use this phone/computer right now?"  → triggers Safe-Device mode (§5.1)
Screen 5  "How would you like to continue?"  ○ Type  ○ Speak in my language  ○ Just upload files
```

- Plain-language options map to the enum (§2.2). **She never sees the words "sextortion" or "stalking" unless she wants to** — labels are human, not legal.
- Every question has a **"Skip"** button (P2).

### 2.2 Mapping: her words → case type → support profile

| She picks… | `incidentType` | Support profile ID |
|---|---|---|
| Threatening to share private photos/videos | `sextortion` | `SP-INTIMATE` 🛡️ |
| Keeps contacting / following me | `stalking` | `SP-STALK` 👁️ |
| Abusing / insulting / shaming me | `harassment` | `SP-ABUSE` 💬 |
| Took my money / tricked me | `fraud` | `SP-MONEY` 💰 |
| Not sure / something else | `other` | `SP-GENERAL` 🤝 |

### 2.3 Auto-reclassification (the system keeps listening)

A victim often picks the wrong box because she is overwhelmed. After ingestion, the existing detection pipeline (`detect.js`, labels such as `threat`, `sexual`, `extortion`, `financial_request`, `impersonation`) can **suggest** a better profile:

> *"We noticed messages about private images. Would you like us to turn on extra privacy protections?"*  **[Yes] [Not now]**

**Rules:** suggestion only — never silently switch (P2). Max one suggestion per session. Dismissed = not asked again for 7 days. Every switch is written to the audit log.

---

## 3. Support Profiles — the core of the spec

Each profile is a **config bundle** (see §8). Below, for each: *what she's going through → what we change → why it helps.*

---

### 3.1 `SP-INTIMATE` 🛡️ — Private images / blackmail (sextortion, image abuse)

**Her reality:** extreme shame and fear. Terrified the images will reach family. Often told "just pay once".

| Feature | What it does (plain English) | Why it helps |
|---|---|---|
| **"It's not your fault" opener** | First screen says: *"Sharing someone's private images without consent is a crime. The shame belongs to the person threatening you."* | Breaks the silence barrier |
| **Blur-by-default viewer** | Any image flagged as intimate/explicit is blurred, with a tap-to-reveal. She can **hide it permanently** and still keep the sealed hash. | She never has to look at it again (P3) |
| **Evidence-without-viewing mode** | Preserve the file (hash + encrypt) **without** displaying a thumbnail. | Proof is safe; her eyes are spared |
| **"Do NOT pay" gentle guide** | Short, calm card: *"Paying often leads to more demands. Keep every message. We'll help you build a record."* + link to takedown guidance | Stops the most damaging mistake |
| **Takedown helper (draft, not auto-send)** | Generates a ready-to-send report text for platforms to remove content, using her case facts | Gives her a *next action* — restores agency |
| **Private-by-default sharing** | Collaborator invites are **off**; sharing requires a second confirmation screen | Prevents accidental exposure to family |
| **Stricter privacy mode** | Defaults to the strongest privacy mode (`local` where available), no cloud AI on intimate content | Fear of leaks is the #1 blocker |
| **Priority helpline card** | Pinned: 1930 (Cyber Crime), 112 (emergency), 181 (Women Helpline) | Immediate human help |

---

### 3.2 `SP-STALK` 👁️ — Stalking / repeated unwanted contact

**Her reality:** hypervigilant, exhausted, tracked across accounts. Fears the stalker knows where she lives.

| Feature | What it does | Why it helps |
|---|---|---|
| **Safety check-in first** | "Does this person know where you live, study or work?" → feeds the existing escalation risk indicator | Surfaces danger early |
| **Pattern view ("It's not in your head")** | Front-and-centre timeline + graph showing *repeated* contact, new accounts, night-time messages | Stalking victims are often disbelieved; **the pattern is the proof** |
| **Block-evasion tracker** | Groups new numbers/accounts into one suspected identity (uses existing entity resolution) | Shows the same person returning |
| **"Don't block yet" tip** | Gentle note: *"Before blocking, let us save everything. We'll tell you when it's done."* | Preserves evidence before it disappears |
| **Safety plan card** | Practical tips: share location with a trusted contact, vary routines, keep phone charged, save helpline | Tangible safety, not just paperwork |
| **Auto-evidence capture reminders** | Optional prompts to export new messages weekly | Keeps the record complete over time |
| **Risk indicator (visible to her only)** | Existing transparent rules model, worded as *"patterns advocates treat as higher-risk — not a prediction"* | Informs without scaring or diagnosing |

---

### 3.3 `SP-ABUSE` 💬 — Online abuse, shaming, impersonation

**Her reality:** humiliated publicly, reading hateful comments on repeat, feeling watched by everyone.

| Feature | What it does | Why it helps |
|---|---|---|
| **Content shield** | Abusive/threatening messages are **collapsed behind a summary** ("14 abusive messages, 3 contain threats"). Tap to expand. | She sees *the shape*, not every cruel word (P3) |
| **Severity-first sorting** | Threats and doxxing float to top; routine abuse sits below | Focus on what matters legally and for safety |
| **Impersonation helper** | Detects fake profiles using her name/photo; offers a report template | Fast action against fake accounts |
| **Reputation-repair checklist** | Steps: report to platform, archive posts, tell a trusted person | Takes back control |
| **Support-circle mode** | A trusted **Collaborator** can upload/organise evidence *for* her (existing role), so she doesn't have to read it | Shares the emotional load |
| **Take-a-break reminder** | After 20 min of reading abusive content: *"You've done a lot. Want to pause? Your work is saved."* | Prevents burnout |

---

### 3.4 `SP-MONEY` 💰 — Online fraud / financial cheating

**Her reality:** guilt, embarrassment, financial panic. Time-critical: banks can sometimes freeze funds if told quickly.

| Feature | What it does | Why it helps |
|---|---|---|
| **"Act fast" panel** | Top card: *"If money was sent in the last few hours, calling 1930 and your bank quickly can help."* + one-tap call | Speed is the real lever in fraud |
| **No-blame language** | *"Scammers are professionals. This can happen to anyone."* | Removes shame (P4) |
| **Money trail view** | Payments (UPI IDs, amounts, dates) auto-collected into a clean ledger; total loss shown calmly | Ready-made for bank/police |
| **Checklist to report** | Bank dispute, cybercrime portal, freeze SIM/UPI — each with a copy-ready summary | Turns panic into steps |
| **Plain-language amounts** | Totals shown as "₹42,000 across 3 payments" — no jargon | Clarity under stress |

---

### 3.5 `SP-GENERAL` 🤝 — Not sure / other

Neutral, warm default. Offers the **gentle triage** again later and unlocks every tool without pushing a path. Auto-reclassification (§2.3) works hardest here.

---

## 4. Universal support layer (every profile gets these)

These are the *always-on* trauma-informed features. Profiles only change their **defaults**.

### 4.1 Emergency & helpline panel — always one tap away
Floating "I need help now" button on every screen.
Shows: **112** (Emergency), **1930** (Cyber Crime Helpline), **181** (Women Helpline).
Built on the existing `RESOURCES` list in `risk.js`. **Must be re-verified by a human advocate before launch** (`verifyBeforeLaunch: true` is already set — keep it).

### 4.2 Speak, don't type — Voice-first (uses Sarvam, spec §6)
Many victims cannot type their story without breaking down, or prefer their mother tongue.
- **"Tell what happened" by voice** in Hindi, English, or a regional language (existing V-INTAKE).
- **Read-aloud summaries** (existing V-TTS) so she can *listen* instead of re-reading.
- Voice is offered on Screen 5 of intake for every profile; **pre-selected** for `SP-INTIMATE` and `SP-ABUSE`.

### 4.3 Calm, human wording (the "Tone Guide")

| ❌ Never say | ✅ Say instead |
|---|---|
| "Victim", "Offender" in UI | "You", "the person contacting you" |
| "Why did you send it?" | "Thank you for sharing this." |
| "Failed to upload" | "That didn't go through. Let's try again — nothing is lost." |
| "Incomplete — 40%" | "You've saved 6 pieces of evidence. Great start." |
| "Required field" | "If you're comfortable, add…" |
| "Delete case" | "Remove this case and its data permanently" (with a clear, calm confirmation) |

All user-visible strings live in a **tone-checked string table** (`copy/<profile>.json`) so wording is reviewed once, not scattered in code.

### 4.4 Visual calm
- Soft, low-contrast palette; **no red alarm colours** except for genuine emergency actions.
- Generous spacing, large tap targets, one primary action per screen.
- `prefers-reduced-motion` respected; no flashing or auto-playing media.
- Dark mode + large-text option remembered per user.

### 4.5 Pace control
- **Pause & resume anywhere**: progress autosaved; "Come back whenever you're ready."
- **Skip-able everything**; optional steps never block sealing or export.
- **Session gentle-timeout**: warns before logging out, never loses work.

---

## 5. Privacy & safety-of-the-victim features (critical)

Her biggest danger is often **the abuser seeing her screen or phone**.

### 5.1 Safe-Device mode (triggered by intake Screen 4)
| Control | Behaviour |
|---|---|
| **Quick-Exit button** | Always visible. One tap (or press `Esc` twice) instantly jumps to a neutral site (e.g. a weather page) and clears the visible session. |
| **Disguised app name** | Optional neutral tab title/icon (e.g. "Notes") instead of "TraceVault". |
| **No sensitive notifications** | No email/SMS/push containing case details; only generic "You have an update." |
| **No history leakage** | Avoids putting case info in URLs; auto-lock after short idle. |
| **Hide from device** | Guidance on private browsing and clearing traces. |

### 5.2 Notification discretion
Default notifications are **generic and sender-neutral**. She chooses channel (email / none) and can turn all off.

### 5.3 She owns deletion
Existing crypto-shred delete is preserved and surfaced kindly in `SP-INTIMATE` ("Remove everything, any time").

### 5.4 Who can see what (profile-aware sharing defaults)

| Profile | Collaborator invites | Lawyer/Police share | Default privacy mode |
|---|---|---|---|
| `SP-INTIMATE` | Off, double-confirm | Allowed, expiring, scoped | Strictest |
| `SP-STALK` | On, optional | Allowed | Standard+ |
| `SP-ABUSE` | **Encouraged** (support circle) | Allowed | Standard |
| `SP-MONEY` | On | Allowed (bank/police fast-path) | Standard |
| `SP-GENERAL` | On, optional | Allowed | Standard |

RBAC from spec §2 is **unchanged**; this only changes *defaults and prompts*.

---

## 6. The "Next Best Step" engine (never leave her stuck)

After each action, show **one** small, relevant next step — chosen by profile + case state.

```
IF   case just created                      → "Add your first piece of evidence (or tell us by voice)."
IF   evidence ≥ 1 and no summary yet        → "We're reading your files. Nothing for you to do."
IF   threats detected and not yet seen help → "Here are people who can help right now."   (pinned)
IF   SP-MONEY and payment detected          → "Let's note the transaction details for your bank."
IF   evidence ≥ 5 and not shared            → "Want a lawyer or officer to see this? You decide."
IF   no activity 7 days                     → (gentle, optional, generic) "Your case is safe whenever you're ready."
```
**Rule:** never more than one nudge per screen; never urgency language ("hurry!", "overdue") unless a genuine time-critical fraud window applies (and then worded calmly).

---

## 7. Edge cases & ethics (we get these right)

| Situation | Behaviour |
|---|---|
| **Minor suspected** | Show child-safety guidance (Childline **1098** — verify before launch) and escalate guidance; avoid storing explicit content viewable by anyone. |
| **Self-harm language in her own statement** | Gentle, non-alarmist card with a crisis helpline; **never** auto-report; she stays in control. *(Helplines verified by an advocate before launch.)* |
| **Wrong classification** | Editable any time in Settings; change is audited; the UI re-adapts instantly. |
| **She is also accused/counter-complaint** | Neutral profile (`SP-GENERAL`); legal-advice pointer, no assumptions. |
| **Abuser has account access** | Safe-Device mode + 2FA (existing TOTP) + session list with "log out everywhere". |
| **Risk indicator wording** | Always advisory, never a prediction or diagnosis (keep existing `DISCLAIMER`). |
| **Legal claims** | The product **prepares evidence and drafts**; it does not give legal advice. A lawyer/NGO reviews before filing. |

> ⚠️ **Honest limits:** personalisation reduces harm; it does not replace human support. Helpline numbers, legal section references and tone copy **must be reviewed by a counsellor/advocate** before any real-world use.

---

## 8. Technical specification

### 8.1 Data model additions (extend `Case`, `apps/api/src/models/index.js`)

```js
case.personalisation = {
  profileId:        { type: String, enum: ['SP-INTIMATE','SP-STALK','SP-ABUSE','SP-MONEY','SP-GENERAL'], default: 'SP-GENERAL' },
  profileSource:    { type: String, enum: ['user','suggested','default'], default: 'default' },
  stillContacted:   { type: String, enum: ['yes','no','unsure'], default: 'unsure' },
  safeDeviceMode:   { type: Boolean, default: false },
  preferredInput:   { type: String, enum: ['text','voice','upload'], default: 'upload' },
  language:         { type: String, default: 'en' },     // BCP-47, drives Sarvam STT/TTS + copy
  contentShield:    { type: Boolean, default: true },    // blur/collapse abusive content
  genericNotifs:    { type: Boolean, default: true },
  lastSuggestionAt: Date,
  dismissedSuggestions: [{ profileId: String, at: Date }],
}
```
`incidentType` remains the source of truth for classification; `profileId` is **derived** from it but can be overridden.

### 8.2 Profile config (server-owned, versioned)

`apps/api/src/personalisation/profiles.js`

```js
export const PROFILES = {
  'SP-INTIMATE': {
    incidentType: 'sextortion',
    tone: 'protective',
    defaults: { contentShield: true, privacyMode: 'strict', collaboratorInvites: false,
                voiceFirst: true, evidenceWithoutViewing: true },
    pinned:  ['helplines', 'doNotPay', 'takedownHelper'],
    screens: ['intake', 'upload', 'timeline', 'share', 'export'],   // order matters
    nextSteps: 'intimate',
  },
  // SP-STALK, SP-ABUSE, SP-MONEY, SP-GENERAL ...
};
```

### 8.3 API

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/cases` | Accepts optional `intake: {incidentType, stillContacted, safeDevice, preferredInput, language}`; derives `profileId` |
| `GET` | `/api/cases/:id/personalisation` | Returns resolved profile (config + case-specific state) for the UI |
| `PATCH` | `/api/cases/:id/personalisation` | User changes profile/toggles (Owner only); audited |
| `POST` | `/api/cases/:id/personalisation/suggestions/:sid/dismiss` | Records dismissal |
| `GET` | `/api/cases/:id/next-step` | Returns the single "Next Best Step" |

All routes use existing `requireCaseRole('owner')` where they change settings; read of next-step is available to Owner and Collaborator.

### 8.4 Frontend

| Piece | Location | Notes |
|---|---|---|
| Gentle Intake wizard | `apps/web/src/pages/UploadPage.tsx` → new `IntakeWizard.tsx` | 5 screens, all skippable |
| `useProfile()` hook | `apps/web/src/lib/case.ts` | Fetches resolved profile, exposes `copy()`, `pinned`, `defaults` |
| Quick-Exit button | `components.tsx` | Global, listens for double-`Esc` |
| Content Shield | `Viewer.tsx`, `Timeline.tsx` | Collapsed summaries + tap-to-reveal |
| Emergency panel | `components.tsx` | Powered by `RESOURCES` |
| Tone strings | `apps/web/src/copy/*.json` | One file per profile, human-reviewed |
| Next-step card | `Overview.tsx` | One card, dismissible |

### 8.5 Auto-reclassification

Runs at the end of the pipeline (`jobs/pipeline.js`) after labels are computed.
```
signals = count(labels) from events
if signals.sexual>=1 && profile != SP-INTIMATE  → suggest SP-INTIMATE
if signals.stalkPattern && profile != SP-STALK  → suggest SP-STALK
if signals.payments>=1 && profile == SP-GENERAL → suggest SP-MONEY
```
Writes a `suggestion` doc; never mutates `profileId`. Respect dismissal window (7 days).

### 8.6 What does NOT change (non-negotiable)

- SHA-256 hashing, encryption, hash-chained audit log, sealing, timestamps.
- Evidence is never altered, blurred **in storage**, or dropped — Content Shield is a **view-layer** feature only.
- RBAC, share scopes, expiry.
- Summaries still cite every sentence.

---

## 9. Requirements table (traceable)

| ID | Requirement | Priority |
|----|-------------|----------|
| PZ-01 | Gentle Intake wizard maps plain-language answers to `incidentType` and a profile | **P0** |
| PZ-02 | Five support profiles with server-owned config | **P0** |
| PZ-03 | Emergency/helpline panel on every screen | **P0** |
| PZ-04 | Quick-Exit button + Safe-Device mode | **P0** |
| PZ-05 | Tone-checked copy table; banned-phrase lint in CI | **P0** |
| PZ-06 | Content Shield (blur/collapse abusive & intimate content, view-layer only) | **P0** |
| PZ-07 | Voice-first intake and read-aloud, pre-selected per profile | P1 |
| PZ-08 | Next-Best-Step engine | P1 |
| PZ-09 | Auto-reclassification suggestions (never silent) | P1 |
| PZ-10 | Profile-aware sharing defaults | P1 |
| PZ-11 | Generic/discreet notifications | P1 |
| PZ-12 | Takedown & report-text helper (drafts only) | P1 |
| PZ-13 | Take-a-break reminders; reduced-motion; large text | P2 |
| PZ-14 | Support-circle (Collaborator does the reading) workflow | P2 |
| PZ-15 | Self-harm / minor-safety cards | P2 |

---

## 10. Acceptance & success metrics

**Definition of done (per profile):** a reviewer creates a case of each type and confirms the wording, pinned cards, defaults, and shield behaviour match §3 — with **zero** banned phrases on any screen.

| Metric | Target | Why |
|---|---|---|
| Intake completion rate (case created → first evidence) | **≥ 70%** | Tells us people don't flee |
| Time to first evidence | **< 5 min** | Small steps work |
| "Felt supported" 1-question survey (optional, anonymous) | **≥ 4 / 5** | The real outcome |
| Banned-phrase count in UI | **0** | Tone safety |
| Quick-Exit time to neutral page | **< 300 ms** | Safety critical |
| Intimate content shown unblurred without explicit tap | **0** | Privacy critical |
| Helpline list verified by advocate | **100% before launch** | Trust |

**Test matrix:** 5 profiles × {text, voice} × {Safe-Device on/off} × {Hindi, English}.

---

## 11. Build plan (fits the existing 30-hour plan)

| Phase | Hours | Output |
|---|---|---|
| 1. Profiles + data model + API | 3 | `profiles.js`, schema, routes |
| 2. Gentle Intake + Emergency + Quick-Exit | 4 | Wizard, global components |
| 3. Content Shield + tone strings | 3 | Viewer/Timeline shield, `copy/*.json`, lint |
| 4. Voice-first + Next-Best-Step | 2 | Sarvam wiring per profile |
| 5. Reclassification + sharing defaults | 2 | Pipeline hook, settings |
| 6. Counsellor review of copy & helplines | — | Human sign-off (external) |

**Demo moment (60 seconds):** create a case → choose *"Someone is threatening to share my photos"* → UI turns calm and protective, helplines pinned, images blurred, Quick-Exit visible → press `Esc Esc` → instantly leaves to a weather page. *Judges feel it before they read it.*

---

## 12. Glossary (beginner-friendly)

| Term | Meaning |
|---|---|
| **Personalisation** | The app adapts its words, order and safety tools to the type of harm. |
| **Support profile** | A ready-made bundle of those adaptations for one situation. |
| **Trauma-informed** | Designed so using the product doesn't cause more distress. |
| **Content Shield** | Hides harmful content behind a summary/blur; evidence is still safely stored. |
| **Quick-Exit** | A button that instantly hides the app if someone walks in. |
| **Safe-Device mode** | Extra discretion for people whose device may be watched. |
| **Sextortion** | Blackmail using threats to share private images. |
| **Crypto-shred** | Permanent deletion by destroying the encryption keys. |
| **Next Best Step** | The one small, helpful thing to do next. |

---

> **Closing principle:** *TraceVault's job is not only to preserve evidence. It is to help a frightened person feel safe enough to bring it.*
