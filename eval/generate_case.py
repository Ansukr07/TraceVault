"""Generate the synthetic demo case "Priya" (spec §6.7, §15) into eval/data/priya_case/.

Planted facts (ground_truth.json):
  - Rahul K uses three identities: WhatsApp "Rahul K", email rk.alt.2024@gmail.com, Instagram @rahul_k_official.
  - Two UPI IDs (rahul.k@okaxis, quickcash.77@ybl) receive money → mule cluster.
  - Inconsistencies: (1) screenshot edited in Snapseed and its EXIF date disagrees with the chat date,
    (2) chat asks ₹5,000 but the bank statement shows ₹50,000 to the same UPI ID,
    (3) Priya's statement says the payment was on 20 May, the bank says 16 May (statement vs evidence).
Voice notes are synthesized with Sarvam Bulbul when SARVAM_API_KEY is set (Hindi threat, English demand,
Kannada note); otherwise they are skipped and listed as missing.

Run:  services/ml/.venv/Scripts/python eval/generate_case.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "priya_case"
sys.path.insert(0, str(ROOT.parent / "services" / "ml"))

CHAT = """12/05/24, 9:41 pm - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
12/05/24, 9:41 pm - Rahul K: Hi Priya, I saw your profile on Instagram. Can we be friends?
12/05/24, 9:45 pm - Priya: Who is this?
12/05/24, 9:46 pm - Rahul K: main Rahul bol raha hoon, college senior. Follow me @rahul_k_official
14/05/24, 10:02 pm - Rahul K: Why are you ignoring me? I have your photos.
14/05/24, 10:05 pm - Priya: Please stop messaging me.
15/05/24, 8:30 pm - Rahul K: send 5000 rs on rahul.k@okaxis warna photos viral kar dunga
15/05/24, 8:31 pm - Rahul K: kal raat 9 baje Forum Mall ke paas milna, akeli aana
15/05/24, 8:40 pm - Priya: I will pay, please delete them
16/05/24, 11:15 am - Priya: Sent the money. Now delete everything.
18/05/24, 9:12 pm - Rahul K: Not enough. Send 20,000 to quickcash.77@ybl or you'll regret it
18/05/24, 9:13 pm - Rahul K: <attached: IMG-20240518-WA0007.jpg>
20/05/24, 7:55 am - Rahul K: Last warning. I know where you live, Koramangala. Call me on 98765 43210
"""

STATEMENT_ROWS = [
    ("10/05/2024", "SALARY CREDIT ACME LTD", "", "42,000.00", "61,250.00"),
    ("16/05/2024", "UPI/DR/413712345678/rahul.k@okaxis/Payment", "50,000.00", "", "11,250.00"),
    ("18/05/2024", "POS 4521 BIGBASKET BENGALURU", "1,240.00", "", "10,010.00"),
    ("19/05/2024", "UPI/DR/414012349876/quickcash.77@ybl/Payment", "20,000.00", "", "-9,990.00"),
]

STATEMENT_TEXT = "On 20 May I paid Rs 50,000 to rahul.k@okaxis because he said he would make my photos viral. He also told me to come to Forum Mall."


def _font(size: int):
    from PIL import ImageFont

    for p in ("C:/Windows/Fonts/arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/Library/Fonts/Arial.ttf"):
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size=size)


def make_screenshot(path: Path) -> None:
    """WhatsApp-like screenshot of the 15 May demand, edited (Snapseed) with an EXIF date of 2 June."""
    from PIL import Image, ImageDraw

    w, h = 720, 1280
    img = Image.new("RGB", (w, h), (236, 229, 221))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 150], fill=(7, 94, 84))
    d.text((40, 20), "9:41", fill="white", font=_font(28))
    d.text((120, 70), "Rahul K", fill="white", font=_font(44))
    d.text((120, 120), "online", fill=(220, 240, 230), font=_font(22))
    d.rounded_rectangle([w // 2 - 90, 190, w // 2 + 90, 240], 12, fill=(225, 245, 254))
    d.text((w // 2 - 70, 200), "15 May 2024", fill=(80, 80, 80), font=_font(26))
    bubbles = [
        ("left", ["send 5000 rs on rahul.k@okaxis", "warna photos viral kar dunga"], "8:30 pm"),
        ("left", ["kal raat 9 baje Forum Mall ke", "paas milna, akeli aana"], "8:31 pm"),
        ("right", ["I will pay, please delete them"], "8:40 pm"),
    ]
    y = 290
    f = _font(32)
    for side, lines, t in bubbles:
        bw = max(d.textlength(s, font=f) for s in lines) + 150
        bh = 46 * len(lines) + 40
        x0 = 30 if side == "left" else w - 30 - bw
        d.rounded_rectangle([x0, y, x0 + bw, y + bh], 18, fill="white" if side == "left" else (220, 248, 198))
        for i, s in enumerate(lines):
            d.text((x0 + 22, y + 16 + i * 46), s, fill="black", font=f)
        d.text((x0 + bw - 110, y + bh - 34), t, fill=(120, 120, 120), font=_font(22))
        y += bh + 40
    exif = Image.Exif()
    exif[0x0131] = "Snapseed 2.0"  # Software
    exif[0x0132] = "2024:06:02 18:20:11"  # DateTime (modified)
    exif[0x8769] = {0x9003: "2024:06:02 18:19:40"}  # DateTimeOriginal — 2 June, but the chat is 15 May
    img.save(path, "PNG", exif=exif.tobytes())


def make_statement_pdf(path: Path) -> None:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 60), "STATE BANK OF INDIA - Account Statement", fontsize=15)
    page.insert_text((50, 85), "Account holder: Priya S    A/c no: XXXXXXX4821    Branch: Koramangala, Bengaluru", fontsize=9)
    page.insert_text((50, 100), "Period: 01/05/2024 to 31/05/2024", fontsize=9)
    y = 140
    for row in STATEMENT_ROWS:
        txt = f"{row[0]}   {row[1]}   Debit: {row[2] or '-'}   Credit: {row[3] or '-'}   Balance: {row[4]}"
        page.insert_text((50, y), txt, fontsize=9)
        y += 40  # blank gap → each transaction is its own paragraph chunk
    doc.set_metadata({"producer": "SBI Statement Generator 3.1", "creationDate": "D:20240601100000", "modDate": "D:20240601100000",
                      "title": "Account Statement May 2024"})
    doc.save(path)


def make_email(path: Path) -> None:
    m = EmailMessage()
    m["From"] = "Rahul K <rk.alt.2024@gmail.com>"
    m["To"] = "Priya S <priya.s.blr@gmail.com>"
    m["Subject"] = "you cant hide"
    m["Date"] = "Sun, 19 May 2024 23:05:00 +0530"
    m["Message-ID"] = "<demo-1@mail.gmail.com>"
    m.set_content("Blocking me on WhatsApp won't help. Check my insta @rahul_k_official.\n\n"
                  "Pay the remaining amount by Monday otherwise your pics go to your college group.\n\n- R")
    path.write_bytes(bytes(m))


async def make_voice_notes(out: Path) -> list[str]:
    """Bulbul TTS (spec V-DATA). Needs SARVAM_API_KEY; ffmpeg converts to .opus when available."""
    from app.voice import audio
    from app.voice.sarvam_client import SarvamClient, SarvamConfig

    cfg = SarvamConfig.from_env()
    if not cfg.api_key or cfg.mock:
        return []
    client = SarvamClient(cfg)
    notes = [
        ("PTT-20240515-WA0003", "hi-IN", "कल रात नौ बजे फोरम मॉल आ जाना, वरना तेरी फोटो वायरल कर दूंगा।"),
        ("PTT-20240518-WA0008", "en-IN", "Listen Priya, send twenty thousand rupees today or everyone in your college will see the pictures."),
        ("PTT-20240520-WA0011", "kn-IN", "ನಾಳೆ ಒಳಗೆ ಹಣ ಕಳುಹಿಸು, ಇಲ್ಲದಿದ್ದರೆ ನಿನ್ನ ಫೋಟೋಗಳನ್ನು ಎಲ್ಲರಿಗೂ ಕಳುಹಿಸುತ್ತೇನೆ."),
    ]
    made = []
    for name, lang, text in notes:
        wav = await client.tts(text, lang=lang)
        target = out / f"{name}.wav"
        target.write_bytes(wav)
        if audio.ffmpeg_path():
            import subprocess

            subprocess.run([audio.ffmpeg_path(), "-y", "-loglevel", "error", "-i", str(target), "-c:a", "libopus", str(out / f"{name}.opus")], check=False)
            if (out / f"{name}.opus").exists():
                target.unlink()
                target = out / f"{name}.opus"
        made.append(target.name)
    await client.aclose()
    return made


def ground_truth(voice: list[str]) -> dict:
    return {
        "persons": [
            {"name": "Rahul K", "aliases": ["Rahul K", "Rahul", "rk.alt.2024@gmail.com", "@rahul_k_official"],
             "identifiers": ["rahul.k@okaxis", "quickcash.77@ybl", "+919876543210", "rk.alt.2024@gmail.com", "rahul_k_official"]},
            {"name": "Priya", "aliases": ["Priya", "Priya S", "Me"], "owner": True},
        ],
        "muleCluster": ["rahul.k@okaxis", "quickcash.77@ybl"],
        "inconsistencies": [
            {"type": "EDITED_FILE", "file": "screenshot_rahul_demand.png"},
            {"type": "AMOUNT_MISMATCH", "values": [5000, 50000], "identifier": "rahul.k@okaxis"},
            {"type": "DATE_CONFLICT", "subtype": "statement_vs_evidence", "statementDate": "2024-05-20", "evidenceDate": "2024-05-16"},
        ],
        "events": [
            {"ts": "2024-05-15T20:30:00", "category": "extortion", "amount": 5000},
            {"ts": "2024-05-16", "category": "payment", "amount": 50000},
            {"ts": "2024-05-18T21:12:00", "category": "extortion", "amount": 20000},
            {"ts": "2024-05-19", "category": "payment", "amount": 20000},
            {"ts": "2024-05-20T07:55:00", "category": "threat"},
        ],
        "voiceNotes": voice,
        "statementText": STATEMENT_TEXT,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "WhatsApp Chat with Rahul K.txt").write_text(CHAT, encoding="utf-8")
    make_screenshot(OUT / "screenshot_rahul_demand.png")
    make_statement_pdf(OUT / "sbi_statement_may2024.pdf")
    make_email(OUT / "email_from_rk.eml")
    (OUT / "statement_text.txt").write_text(STATEMENT_TEXT, encoding="utf-8")
    voice = asyncio.run(make_voice_notes(OUT))
    (OUT / "ground_truth.json").write_text(json.dumps(ground_truth(voice), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT}  (voice notes: {voice or 'skipped — set SARVAM_API_KEY'})")


if __name__ == "__main__":
    main()
