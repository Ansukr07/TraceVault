# Inconsistency Flag Spec

Practical rules for when the system may, and may not, raise an inconsistency flag.
Goal: every flag is something an investigator would act on. A flag that is noise
trains users to dismiss everything.

## 0. Core principle

**An inconsistency is two or more *independent* sources disagreeing about the same fact.**

If the sources are not independent, or they are not about the same fact, there is no
inconsistency. Two copies of the same thing agreeing is a **duplicate**, not a conflict.

Each flag must answer: *which fact*, *which sources*, *what does each say*, *why does it matter*.

---

## 1. Pre-flight gates (run before any rule)

A candidate flag is **dropped** unless it passes all of these.

| # | Gate | Rule |
|---|------|------|
| G1 | Independence | The two sides must come from different evidence items **and** different content hashes. Same file uploaded twice, or an exact copy, is never a conflict. |
| G2 | Not a duplicate pair | If the evidence items are in the same DuplicateGroup (exact hash, or perceptual-hash/near-dup above threshold), do not compare them against each other. Compare the group's **canonical** item against other groups once. |
| G3 | Same fact | Both sides must resolve to the same normalised subject (same person, same identifier, same transaction, same date). Fuzzy topical similarity is not enough. |
| G4 | Both values present | Both sides must have a parsed, non-empty value. "Missing in B" is a **coverage gap**, not a conflict (see §6). |
| G5 | Different values after normalisation | Normalise first (§2). If values are equal after normalisation, there is no conflict. |
| G6 | One flag per fact | Collapse repeats (§3) before emitting. |

---

## 2. Normalise before comparing

Most false flags come from comparing un-normalised strings.

- **Text:** NFKC, lowercase, collapse whitespace, strip zero-width chars, strip quotes/emoji-variation selectors, normalise smart quotes and dashes.
- **Amounts:** parse `₹15,000`, `15000`, `15,000.00`, `Rs 15k`, `15 thousand` to a decimal plus currency. Compare as numbers. Different currency = different fact unless a rate is given.
- **Dates/times:** parse to UTC with the source's timezone if known. Treat date-only vs datetime as equal if the dates match. Allow format variants (`23/09/2024`, `2024-09-23`, `23 Sep 24`). Ambiguous `dd/mm` vs `mm/dd`: try both and only flag if **neither** reading matches.
- **Identifiers (UPI, phone, email, account):** lowercase, strip spaces/dashes/country-code prefix (`+91`, `91`, leading `0`). Mask-aware: `XXXX1234` matches `...1234`.
- **Sender names:** see §4.2, do not compare raw strings.

---

## 3. Dedup & grouping of flags

- **Fingerprint** every flag: `type + subtype + normalised subject + sorted(evidenceIds)`. Same fingerprint = same flag; keep one.
- **Many-to-one collapse:** if one source disagrees with N other sources about the same fact (e.g. one edited screenshot vs a chat export), emit **one flag** with N refs, not N flags.
- **Burst collapse:** if a single pair of evidence items produces more than **3** flags of the same subtype, emit one **parent flag** ("5 messages attributed differently between E7 and E3") with the individual items as children/refs. The user dismisses the parent once.
- **Don't flag both directions.** A vs B and B vs A are one flag.
- **Dismissal is sticky.** A dismissed fingerprint must not reappear on re-run unless one of its evidence items changed.

---

## 4. Rules by type

Each rule lists **fires when**, **does not fire when**, **severity**, **confidence**.

### 4.1 Amount mismatch

**Fires when**
- The same transaction (same normalised counterparty identifier **and** dates within ±2 days) has different amounts in two independent sources, e.g. a chat demand vs a bank statement debit.

**Does not fire when**
- Amounts differ but they are plausibly **different transactions**: different dates more than 2 days apart, or the statement has multiple debits to that identifier and one of them matches. (Match against *any* debit before flagging.)
- The chat amount is a demand/request and the statement shows a **partial or split payment** (sum of debits to that identifier within 7 days equals the demand).
- A fee/tax difference under **2%** or ₹10, whichever is larger, unless the source states an exact figure.
- One side is an estimate ("around", "approx", "~", "k" shorthand with ≤ 5% gap).

**Severity**
- `severe` if difference ≥ 20% **and** both sides are first-hand records (bank statement, receipt, signed doc).
- `moderate` if one side is hearsay/chat.
- `low` otherwise.

**Confidence**
- Base 0.5. +0.2 same identifier exact match. +0.1 dates within same day. +0.1 only one candidate debit exists. −0.2 multiple candidate transactions. Cap 0.95.

### 4.2 Sender / speaker mismatch

The same message text is attributed to different people.

**Fires when**
- Text matches (normalised, ≥ 0.95 similarity, ≥ 4 words) **and** the two sources give **different speakers after alias resolution**, **and** the timestamps (if both exist) are within 5 min.

**Does not fire when** (the current false-positive source)
- **Perspective flip.** "Me" in a screenshot means the *phone owner*; in a chat export it means the named account. Resolve "Me/You/Self" to the device owner from the evidence metadata before comparing. If "Me" resolves to the same person as the other side, there is no conflict.
- Aliases match: contact name vs phone number vs saved name vs display name (resolve through the Speaker table).
- Text is a very short or generic message ("ok", "yes", "thanks", "hi", emoji only, under 4 words). These repeat naturally.
- Both sources are **duplicates of each other** (G2).
- The speaker label is missing or `unknown` on either side.

**Severity**: `severe` only if perspective cannot explain it **and** one source is an image with edit indicators; otherwise `moderate`.

**Confidence**: 0.5 base. +0.2 timestamps agree. +0.15 long unique message (≥ 10 words). −0.3 if perspective flip not ruled out.

**Burst rule:** if more than 3 messages between the same two sources all flip the same way, it is almost certainly a perspective/alias problem. Emit **one** parent flag: "Speaker labels are inverted between E7 and E3 (N messages)" at `low`/`moderate` and ask the user to confirm who "Me" is, instead of N severe flags.

### 4.3 Date / time mismatch

**Fires when**
- The same event is dated differently in two independent sources by more than **24 h** (after timezone normalisation), or
- A source's content date contradicts its own metadata (screenshot shows 22 Sep, EXIF says 5 Oct).

**Does not fire when**
- Difference is explained by timezone (±14 h window) or by midnight rollover.
- File creation / modified time vs content date. Those routinely differ (copy, download, export). Only **capture/EXIF original date** counts as metadata truth.
- Export date vs message date. An export made later is expected.
- The date is a deadline, due date or scheduled time, not an occurrence.

**Severity**: `harmful` if metadata capture date is **earlier** than the content date (impossible), or the gap is > 7 days. `moderate` otherwise.

### 4.4 Edited / manipulated file

**Fires when**
- Metadata shows editing software (Photoshop, Snapseed, GIMP, Canva, etc.), **or**
- ELA / structural analysis exceeds threshold, **or**
- Error-level or font/compression inconsistencies localised to a region.

**Does not fire when**
- Software is a benign screenshot/OS tool (Screenshot, Preview, Android/iOS system tools, WhatsApp, Telegram recompression).
- A crop or resize only, with no pixel-level anomalies.
- Filename contains "edited" and nothing else supports it. The filename is a hint (+0.05 confidence), never evidence.

**Severity**: `harmful` for editing software confirmed in metadata. `moderate` for analysis-only. Always show the evidence snippet (software tag, region).

### 4.5 Metadata mismatch

**Fires when** two metadata fields of the **same file** contradict (EXIF capture vs content date, device model vs claimed device, GPS vs claimed location).

**Does not fire when**
- Only filesystem timestamps differ.
- Metadata is absent (stripped by the messaging app). Missing metadata is a note, not a conflict.

### 4.6 Identity / identifier mismatch

**Fires when**
- The same person is linked to two different identifiers in the same role (two different phone numbers for the same named sender in the same thread), **and** neither is flagged as an alias.

**Does not fire when**
- The person is known to have multiple numbers/handles (marked in the case).
- Identifiers differ only by formatting (§2).

### 4.7 Statement conflict (witness / chat claims)

**Fires when**
- Same speaker makes two **mutually exclusive factual claims** about the same event (location, time, presence, payment made/not made), and both are first-person assertions.

**Does not fire when**
- Claims are opinions, questions, sarcasm, hypotheticals, or quoted from someone else.
- Claims are about different times.
- Confidence of extraction < 0.6.

---

## 5. Never flag as an inconsistency

- Exact or near-duplicate files (belong to **Duplicates**, not Inconsistencies).
- The same fact stated identically in multiple sources.
- Differences in formatting, casing, spacing, punctuation, emoji, language/transliteration of the same name.
- Values that differ only by rounding (≤ 1% or ≤ ₹1).
- A message present in one source and absent in another (coverage, §6).
- Chat export vs screenshot where the screenshot is a **subset** of the export.
- Anything involving a low-confidence OCR/ASR extraction (< 0.6) unless a second independent extraction agrees.
- System/automated messages ("Messages are end-to-end encrypted", "You deleted this message", call logs) unless the conflict is about the call itself.

## 6. Coverage gaps (separate, quieter category)

"Present in A, absent in B" is **not** a conflict. Surface it as an info-level
**Coverage note** only when it is investigatively meaningful, e.g. a screenshot message
that does *not* appear in the full chat export (possible fabrication). Rules:
- Only when the export covers the screenshot's time window and the message is ≥ 6 words.
- Fuzzy-match the entire export first (OCR errors, edits, deleted messages).
- Never `severe`; cap at `moderate`; wording: "Not found in…" and never "conflicts with".

---

## 7. OCR / extraction hygiene

- Do not compare OCR-derived values unless extraction confidence ≥ 0.6.
- Amount OCR commonly confuses `5/6/8`, `1/7`, `0/O`; if two amounts differ by a single character swap of this kind, mark `low` and add "possible OCR error".
- Prefer structured sources (PDF text layer, chat export) over OCR when both exist.

---

## 8. Scoring

```
confidence = clamp(base + Σ boosts − Σ penalties, 0.05, 0.95)
```

- **Emit threshold:** confidence ≥ **0.55**. Between 0.40 and 0.55, store but show under "Low confidence" collapsed by default. Below 0.40, drop.
- **Severity** is about impact, **confidence** is about certainty. Never derive one from the other.
- `severe` requires: confidence ≥ 0.7, both sides first-hand or one side verified-edited, and not explained by any exclusion in §4.
- Cap flags per case shown by default at **25**, sorted by severity then confidence; the rest sit behind "Show more".

## 9. What every flag must contain

- `type`, `subtype`, `severity`, `confidence`
- `fingerprint` (stable across re-runs)
- `subject` (normalised: person / identifier / transaction / date)
- `sides[]`: for each side: `evidenceId`, `locator` (page/line/timestamp), `rawQuote`, `normalisedValue`
- `reasonChecked`: list of exclusions that were evaluated and ruled out (e.g. "not a perspective flip", "not a duplicate", "no matching debit within ±2 days"). This lets the user trust the flag.
- `suggestedAction`: one line (e.g. "Confirm who 'Me' is in E3").

## 10. Test cases (must pass)

| Scenario | Expected |
|---|---|
| Same screenshot uploaded twice | No flag; one Duplicate group |
| Chat export "Ananya: X" vs screenshot "Me: X", Me = Ananya | No flag |
| Chat export "Ananya: X" vs screenshot "Me: X", Me = Karthik | One flag, `moderate`+ |
| 5 messages all flipped between same two sources | One parent flag, not 5 |
| Chat demand ₹15,000, statement shows ₹15,000 and ₹25,000 to same UPI | No flag (a debit matches) |
| Chat demand ₹15,000, only debit ₹25,000 same UPI within 2 days | Amount mismatch, `severe` |
| "ok" / "thanks" same text, different sender | No flag |
| EXIF software = "Snapseed" | Edited file, `harmful` |
| EXIF software = "Screenshot" | No flag |
| File name contains "EDITED" only | No flag (hint only) |
| Screenshot dated 22 Sep, EXIF 5 Oct | Metadata mismatch, `harmful` |
| File mtime differs from content date | No flag |
| `₹15,000` vs `15000` | No flag |
| Dismissed flag, re-run with no evidence changes | Stays dismissed |
| Screenshot message missing from full export | Coverage note, never `severe` |
