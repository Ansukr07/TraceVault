# Demo case: *Ananya Rao v. Karthik Menon* (synthetic)

Cyber-stalking, harassment, defamation and extortion over 4 weeks (2-28 Sep 2024).
**Everything is fictional**: people, handles, phone numbers, UPI IDs, bank rows. Regenerate with:

```bash
services/ml/.venv/Scripts/python eval/generate_harassment_case.py
```

Files land in `eval/data/ananya_case/`.

## Cast

| Who | Details |
|---|---|
| **Ananya Rao** (victim, 27) | Product designer, Nimbus Labs, Indiranagar, Bengaluru. Parents in Mysuru. Lives in a PG on 12th Main. |
| **Karthik Menon** (accused, 30) | Ex-colleague. Identities: WhatsApp "Karthik Menon" (+91 98450 01234), second SIM +91 70190 55555, IG `@karthik.clicks`, fake IG `@anu.exposed`, email `anon.truth.blr@proton.me`. UPI `karthik.menon@okicici`, `ktk.pay88@ybl`. |

## Evidence files (upload order for the demo)

| # | File | Date | What it shows |
|---|---|---|---|
| 1 | `01_whatsapp_persistent_contact.png` | 2-9 Sep | Escalation from friendly to repeated calls ("REPLY"), waiting near her office, her clear "please stop", then block |
| 2 | `02_instagram_dm_after_block.png` | 10 Sep | Block evasion on a new handle, knows her bus and clothes |
| 3 | `03_sms_surveillance.png` | 14 Sep | Unknown number; knows metro, jacket, PG gate; "nobody will believe you" |
| 4 | `04_whatsapp_threats_second_sim.png` | 18 Sep | Threat to send private photos to HR and parents; English, Hinglish and **Kannada** |
| 5 | `05_instagram_fake_account.png` | 21 Sep | Public defamatory story, 412 views, comments from strangers |
| 6 | `06_whatsapp_demand_EDITED.png` | 22 Sep | Demand of Rs 15,000 to `karthik.menon@okicici`. **Planted: EXIF says Snapseed + 5 Oct** |
| 7 | `07_telegram_second_demand.png` | 26 Sep | Second demand Rs 30,000 to `ktk.pay88@ybl` ("the 25k was just interest") |
| 8 | `WhatsApp Chat with Karthik Menon.txt` | 2-22 Sep | Text export of the same chat as #1, #4, #6 (**cross-format duplicate test**) |
| 9 | `email_from_anon.eml` | 28 Sep | Throwaway address, new threat for Rs 30,000, references her new PG |
| 10 | `hdfc_statement_sep2024.pdf` | Sep | Debits: Rs 25,000 on 23 Sep to `okicici`, Rs 10,000 on 27 Sep to `ybl` |
| 11 | `statement_text.txt` (or speak it in Voice Statement) | n/a | Ananya's own account. **Planted: says she paid on 25 Sep** |

Optional: record the Voice Statement page live in Hindi or Kannada using the text in #11.

## What the platform should find (`ground_truth.json`)

- **One identity** for Karthik across 2 phone numbers, 3 handles, 1 email, 2 UPI IDs.
- **Mule cluster**: `karthik.menon@okicici` + `ktk.pay88@ybl` both receive money.
- **3 planted inconsistencies**
  1. `EDITED_FILE`: screenshot #6 (Snapseed, modified 5 Oct, but chat is 22 Sep)
  2. `AMOUNT_MISMATCH`: Rs 15,000 demanded in chat vs Rs 25,000 debited in the bank
  3. `DATE_CONFLICT`: statement says paid 25 Sep, bank says 23 Sep
- **Duplicates**: export `.txt` vs screenshots #1, #4, #6.
- **Timeline** (12 events): contact, stalking, consent withdrawal (9 Sep), block evasion, threat, defamation, extortion, payment, second extortion, payment, email threat.

## 10-minute presentation script

| Min | Screen | Say / do |
|---|---|---|
| 0:00 | Slide | "Ananya has 7 screenshots, a chat export, an email, a bank PDF and a messy memory. Today that is a folder she cannot hand to police." |
| 1:00 | Case create | New case, type *harassment / extortion*. Show consent for voice. |
| 2:00 | Upload | Drag in all files. Point at SHA-256 shown in the browser and the audit log starting. |
| 3:30 | Processing | OCR on screenshots, Kannada line read and translated, export parsed. |
| 4:30 | Entities / graph | One Karthik node linked to both SIMs, three handles, both UPI IDs. Highlight mule cluster. |
| 5:30 | Timeline | Scroll 2-28 Sep. Click the 9 Sep "please stop": every later contact is after refusal. |
| 6:30 | Inconsistencies | Open the 3 flags. Explain #6 (edited) honestly: Ananya re-cropped it, the platform tells her *before* a lawyer or officer finds it. |
| 7:30 | Summary | Cited narrative; click a sentence to jump to the source. Optionally read-aloud in Kannada. |
| 8:30 | Share | Time-limited link to a lawyer (role view), then to an officer. Show scope and expiry. |
| 9:15 | Export | Report PDF + draft Section 63 BSA certificate + offline-verifiable bundle; open Verify page. |
| 9:50 | Close | "Preserve, extract, link, reconstruct, flag, cite, share." |

## Indicative offences (for the legal-view talking point, not legal advice)

Stalking (BNS s.78), criminal intimidation (s.351), extortion (s.308), defamation (s.356), plus IT Act provisions for the
fake-account and image-misuse angle. Verify section numbers with counsel before showing them as final.

## Safety notes

- Names and handles are invented; `+91 98450 01234` and `+91 70190 55555` are not meant to be real subscribers. Keep the
  "synthetic demo data" label visible if you show the screenshots outside the app.
- `anu.exposed` post text contains no actual private images; the threat is the *claim*.
