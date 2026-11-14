"""Generate the synthetic demo case "Ananya" (cyber-stalking, harassment and extortion) into eval/data/ananya_case/.

Everything here is FICTIONAL: people, handles, phone numbers (not real subscribers), UPI IDs and bank rows.

Evidence produced
  01_whatsapp_persistent_contact.png   WhatsApp (light)   2-9 Sep   unwanted persistent contact, "please stop"
  02_instagram_dm_after_block.png      Instagram DM (dark) 10 Sep   block evasion, new handle
  03_sms_surveillance.png              SMS                 14 Sep   stalking, knows her location
  04_whatsapp_threats_second_sim.png   WhatsApp (dark)     18 Sep   threats in English/Hinglish/Kannada, defamation, photos
  05_instagram_fake_account.png        Instagram story+DMs 21 Sep   fake "exposed" account, public shaming
  06_whatsapp_demand_EDITED.png        WhatsApp (light)    22 Sep   Rs 15,000 demand; EXIF says Snapseed + 5 Oct (planted)
  07_telegram_second_demand.png        Telegram            26 Sep   Rs 30,000 to a second UPI ID (mule cluster)
  WhatsApp Chat with Karthik Menon.txt WhatsApp export of the same chat as 01/04/06 (cross-format duplicate test)
  email_from_anon.eml                  Email               28 Sep   throwaway address, ties back to Karthik
  hdfc_statement_sep2024.pdf           Bank statement      Rs 25,000 on 23 Sep (planted amount + date mismatch)
  statement_text.txt                   Victim statement     says she paid on 25 Sep (planted date conflict)
  ground_truth.json                    what the pipeline should find

Run:  services/ml/.venv/Scripts/python eval/generate_harassment_case.py
"""
from __future__ import annotations

import html
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "ananya_case"

W, H = 540, 1170  # CSS px, rendered at 2x -> 1080 x 2340 phone screenshot

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

# ---------------------------------------------------------------------------------------------------------------------
# Shared story data
# ---------------------------------------------------------------------------------------------------------------------
ME = "Ananya"
HIM = "Karthik Menon"
PH_1 = "+91 98450 01234"  # Karthik, first number (fictional)
PH_2 = "+91 70190 55555"  # Karthik, second SIM
UPI_1 = "karthik.menon@okicici"
UPI_2 = "ktk.pay88@ybl"

# Messages: (side, text, time)  side: "in" = from Karthik, "out" = from Ananya, "day" = date divider
WA1 = [
    ("day", "2 September 2024"),
    ("in", "Hi Ananya! Saw the Nimbus launch post. Proud of you 🎉", "10:12 am"),
    ("in", "Coffee this weekend? Just us, like old times", "10:13 am"),
    ("out", "Thanks Karthik! Busy with the release this weekend, sorry", "11:40 am"),
    ("day", "4 September 2024"),
    ("in", "You replied to everyone's stories except mine", "11:05 pm"),
    ("in", "Why are you ignoring me?", "11:06 pm"),
    ("in", "Missed call", "11:20 pm"),
    ("in", "Missed call", "11:21 pm"),
    ("in", "Missed call", "11:24 pm"),
    ("day", "7 September 2024"),
    ("in", "I waited near your office today. You left early?", "7:48 pm"),
    ("in", "Reply. Ananya. REPLY.", "7:49 pm"),
    ("day", "9 September 2024"),
    ("out", "Karthik, I am not interested. Please stop messaging and calling me. This is making me very uncomfortable.", "9:02 am"),
    ("in", "Haan toh? Main kuch galat nahi kar raha, tu overreact kar rahi hai", "9:05 am"),
    ("out", "I am blocking this number.", "9:07 am"),
]

IG = [
    ("day", "10 Sep 2024"),
    ("in", "blocking me on whatsapp won't help 🙂", "8:15 am"),
    ("in", "this is my new insta btw. you can't block everything", "8:16 am"),
    ("in", "I know you take the 8:20 bus from Indiranagar. Blue kurta today, nice", "8:21 am"),
    ("out", "I will report this account.", "8:30 am"),
    ("in", "report karo. Mujhe fark nahi padta", "8:31 am"),
]

SMS = [
    ("day", "Sat, 14 Sep"),
    ("in", "Saw you at Indiranagar metro today. Black jacket looks good on you.", "6:12 pm"),
    ("in", "Your PG is on 12th Main, the green gate. I know.", "6:14 pm"),
    ("in", "Don't get any ideas about police. Nobody will believe you.", "6:15 pm"),
]

WA4 = [
    ("day", "18 September 2024"),
    ("in", "You changed your number? Lol. Found you anyway.", "9:30 pm"),
    ("in", "I still have the photos from the Goa team trip. The private ones.", "9:31 pm"),
    ("in", "Imagine if HR at Nimbus and your parents in Mysuru got them", "9:32 pm"),
    ("out", "Delete them. That was a private moment and you know it.", "9:40 pm"),
    ("in", "Delete? Haha. Pehle mujhse baat kar, phir sochunga", "9:41 pm"),
    ("in", "ನಿನ್ನ ಅಪ್ಪ-ಅಮ್ಮನಿಗೆ ಎಲ್ಲಾ ಗೊತ್ತಾಗುತ್ತೆ, ನೋಡ್ತಿರು", "9:43 pm"),
    ("in", "I will tell everyone you slept your way into the promotion", "9:44 pm"),
    ("out", "That is a lie. I will report you.", "9:50 pm"),
    ("in", "Report karke dekh. Teri career khatam kar dunga", "9:51 pm"),
]

IG_FAKE_STORY = {
    "handle": "anu.exposed",
    "caption": "Ananya Rao (Nimbus Labs) is NOT who you think she is. Full story coming. Ask me for the pics 👀",
    "views": "412 views",
    "comments": [
        ("priyam.r_", "wait is this the Nimbus designer??"),
        ("blr_techgossip", "dm me the pics pls"),
        ("anu.exposed", "Rest goes live tomorrow, watch this space"),
    ],
}

WA6 = [
    ("day", "22 September 2024"),
    ("in", "Story is live. 400 views already 🙂", "8:30 pm"),
    ("in", "Send 15000 to karthik.menon@okicici and I take it down. Tonight.", "8:31 pm"),
    ("in", "Warna kal subah sab leak. Tera choice.", "8:32 pm"),
    ("out", "Please don't do this. I will pay, just delete everything.", "8:55 pm"),
    ("in", "Screenshot bhej payment ka. 10 baje tak", "8:56 pm"),
]

TG = [
    ("day", "26 September 2024"),
    ("in", "Story is down. You think that's the end? 😂", "7:02 pm"),
    ("in", "Rent is due. Send 30000 to ktk.pay88@ybl", "7:03 pm"),
    ("in", "Ya photos Instagram pe daal dunga, sab followers ke saamne", "7:04 pm"),
    ("out", "You already took 25,000. Stop.", "7:30 pm"),
    ("in", "Rs 25,000? That was just the interest 😂", "7:31 pm"),
    ("in", "You have till Sunday.", "7:31 pm"),
]

WHATSAPP_EXPORT = """02/09/24, 10:12 am - Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.
02/09/24, 10:12 am - Karthik Menon: Hi Ananya! Saw the Nimbus launch post. Proud of you 🎉
02/09/24, 10:13 am - Karthik Menon: Coffee this weekend? Just us, like old times
02/09/24, 11:40 am - Ananya: Thanks Karthik! Busy with the release this weekend, sorry
04/09/24, 11:05 pm - Karthik Menon: You replied to everyone's stories except mine
04/09/24, 11:06 pm - Karthik Menon: Why are you ignoring me?
07/09/24, 7:48 pm - Karthik Menon: I waited near your office today. You left early?
07/09/24, 7:49 pm - Karthik Menon: Reply. Ananya. REPLY.
09/09/24, 9:02 am - Ananya: Karthik, I am not interested. Please stop messaging and calling me. This is making me very uncomfortable.
09/09/24, 9:05 am - Karthik Menon: Haan toh? Main kuch galat nahi kar raha, tu overreact kar rahi hai
18/09/24, 9:30 pm - Karthik Menon: You changed your number? Lol. Found you anyway.
18/09/24, 9:31 pm - Karthik Menon: I still have the photos from the Goa team trip. The private ones.
18/09/24, 9:32 pm - Karthik Menon: Imagine if HR at Nimbus and your parents in Mysuru got them
18/09/24, 9:40 pm - Ananya: Delete them. That was a private moment and you know it.
18/09/24, 9:41 pm - Karthik Menon: Delete? Haha. Pehle mujhse baat kar, phir sochunga
18/09/24, 9:43 pm - Karthik Menon: ನಿನ್ನ ಅಪ್ಪ-ಅಮ್ಮನಿಗೆ ಎಲ್ಲಾ ಗೊತ್ತಾಗುತ್ತೆ, ನೋಡ್ತಿರು
18/09/24, 9:44 pm - Karthik Menon: I will tell everyone you slept your way into the promotion
18/09/24, 9:50 pm - Ananya: That is a lie. I will report you.
18/09/24, 9:51 pm - Karthik Menon: Report karke dekh. Teri career khatam kar dunga
22/09/24, 8:30 pm - Karthik Menon: Story is live. 400 views already 🙂
22/09/24, 8:31 pm - Karthik Menon: Send 15000 to karthik.menon@okicici and I take it down. Tonight.
22/09/24, 8:32 pm - Karthik Menon: Warna kal subah sab leak. Tera choice.
22/09/24, 8:55 pm - Ananya: Please don't do this. I will pay, just delete everything.
22/09/24, 8:56 pm - Karthik Menon: Screenshot bhej payment ka. 10 baje tak
"""

STATEMENT_ROWS = [
    ("02/09/2024", "SALARY CREDIT NIMBUS LABS PVT LTD", "", "68,000.00", "91,420.00"),
    ("12/09/2024", "UPI/DR/425512340011/Swiggy/Food", "640.00", "", "90,780.00"),
    ("23/09/2024", "UPI/DR/426612349911/karthik.menon@okicici/Payment", "25,000.00", "", "65,780.00"),
    ("27/09/2024", "UPI/DR/426912340077/ktk.pay88@ybl/Payment", "10,000.00", "", "55,780.00"),
]

STATEMENT_TEXT = (
    "My name is Ananya Rao, I work at Nimbus Labs in Bengaluru. Karthik Menon is a former colleague. "
    "Since early September he has been messaging and calling me repeatedly even after I told him to stop. "
    "He followed me, knew where I live, and when I blocked him he used new numbers and an Instagram account. "
    "On 18 September he threatened to send private photos to my office and my parents. "
    "On 22 September he demanded Rs 15,000 to take down a fake story about me. "
    "I paid Rs 25,000 on 25 September because I was scared. He then asked for Rs 30,000 more."
)

EMAIL_BODY = (
    "Ananya,\n\nYou think moving PG will stop me? 14th Cross is not far from Indiranagar either.\n\n"
    "Pay the 30k by Sunday. Otherwise the pics go to hr@nimbuslabs.example and your father's WhatsApp.\n\n"
    "Don't bother with the police, I use new SIMs every time. Tell Priya from design I said hi too.\n\n"
    "- K  (anon.truth.blr@proton.me)\n"
)


# ---------------------------------------------------------------------------------------------------------------------
# HTML rendering (chat UIs)
# ---------------------------------------------------------------------------------------------------------------------
BASE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:%dpx;height:%dpx;overflow:hidden}
body{font-family:'Segoe UI','Segoe UI Emoji','Nirmala UI','Noto Sans','Noto Sans Kannada',sans-serif;font-size:16px;position:relative}
.status{height:30px;display:flex;justify-content:space-between;align-items:center;padding:0 22px;font-size:13px;font-weight:600}
.msgs{position:absolute;top:0;left:0;right:0;bottom:0;padding:0 12px 16px;display:flex;flex-direction:column;justify-content:flex-end;gap:6px}
.row{display:flex}.row.in{justify-content:flex-start}.row.out{justify-content:flex-end}
.b{max-width:78%%;padding:7px 10px 6px;line-height:1.32;font-size:16px;position:relative}
.t{font-size:11px;opacity:.6;margin-left:10px;float:right;margin-top:6px}
.day{align-self:center;font-size:12px;padding:4px 10px;border-radius:8px;margin:8px 0 2px}
""" % (W, H)


def _bubbles(items, cls_in="in", cls_out="out") -> str:
    out = []
    for it in items:
        if it[0] == "day":
            out.append(f'<div class="day">{html.escape(it[1])}</div>')
        else:
            side, text, t = it
            out.append(f'<div class="row {side}"><div class="b {side}">{html.escape(text)}<span class="t">{t}</span></div></div>')
    return "\n".join(out)


def page_whatsapp(items, name, sub, dark: bool) -> str:
    bg = "#0b141a" if dark else "#efeae2"
    hdr = "#202c33" if dark else "#008069"
    inb = "#202c33" if dark else "#ffffff"
    outb = "#005c4b" if dark else "#d9fdd3"
    txt = "#e9edef" if dark else "#111b21"
    day_bg = "#182229" if dark else "#ffffffcc"
    day_fg = "#8696a0" if dark else "#54656f"
    css = BASE_CSS + f"""
body{{background:{bg};color:{txt}}}
.top{{position:absolute;top:0;left:0;right:0;background:{hdr};color:#fff;z-index:5}}
.title{{display:flex;align-items:center;gap:10px;padding:6px 14px 10px}}
.av{{width:38px;height:38px;border-radius:50%;background:#6b7c85;display:flex;align-items:center;justify-content:center;font-weight:700}}
.nm{{font-size:17px;font-weight:600}}.sb{{font-size:12px;opacity:.8}}
.msgs{{top:96px}}
.b.in{{background:{inb};border-radius:0 9px 9px 9px}}.b.out{{background:{outb};border-radius:9px 0 9px 9px}}
.day{{background:{day_bg};color:{day_fg}}}
.inbar{{position:absolute;left:0;right:0;bottom:0;height:0}}
"""
    return f"""<html><head><meta charset="utf-8"><style>{css}</style></head><body>
<div class="top"><div class="status"><span>9:41</span><span>5G ▂▄▆ 87%</span></div>
<div class="title"><div class="av">{html.escape(name[0])}</div><div><div class="nm">{html.escape(name)}</div><div class="sb">{html.escape(sub)}</div></div></div></div>
<div class="msgs">{_bubbles(items)}</div></body></html>"""


def page_instagram_dm(items, handle) -> str:
    css = BASE_CSS + """
body{background:#000;color:#f5f5f5}
.top{position:absolute;top:0;left:0;right:0;background:#000;border-bottom:1px solid #262626;z-index:5}
.title{display:flex;align-items:center;gap:10px;padding:8px 14px 10px}
.av{width:36px;height:36px;border-radius:50%;background:linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7);display:flex;align-items:center;justify-content:center;font-weight:700}
.nm{font-size:15px;font-weight:600}.sb{font-size:12px;color:#a8a8a8}
.msgs{top:96px}
.b{border-radius:20px}.b.in{background:#262626}.b.out{background:#3797f0;color:#fff}
.day{color:#a8a8a8}
"""
    return f"""<html><head><meta charset="utf-8"><style>{css}</style></head><body>
<div class="top"><div class="status"><span>8:34</span><span>5G ▂▄▆ 64%</span></div>
<div class="title"><div class="av">k</div><div><div class="nm">{html.escape(handle)}</div><div class="sb">Instagram · Active 2m ago</div></div></div></div>
<div class="msgs">{_bubbles(items)}</div></body></html>"""


def page_sms(items, number) -> str:
    css = BASE_CSS + """
body{background:#fff;color:#1f1f1f}
.top{position:absolute;top:0;left:0;right:0;background:#f1f3f4;z-index:5;border-bottom:1px solid #dadce0}
.title{padding:6px 14px 12px}.nm{font-size:18px;font-weight:600}.sb{font-size:12px;color:#5f6368}
.msgs{top:96px}
.b{border-radius:18px}.b.in{background:#e8eaed}.b.out{background:#d3e3fd}
.day{color:#5f6368}
.warn{align-self:center;font-size:12px;color:#5f6368;margin-bottom:6px}
"""
    return f"""<html><head><meta charset="utf-8"><style>{css}</style></head><body>
<div class="top"><div class="status"><span>6:20</span><span>4G ▂▄▆ 41%</span></div>
<div class="title"><div class="nm">{html.escape(number)}</div><div class="sb">Unknown sender · SMS</div></div></div>
<div class="msgs"><div class="warn">Not in your contacts</div>{_bubbles(items)}</div></body></html>"""


def page_telegram(items, name) -> str:
    css = BASE_CSS + """
body{background:linear-gradient(160deg,#cfe7c8,#9fc7a1);color:#000}
.top{position:absolute;top:0;left:0;right:0;background:#fff;z-index:5}
.title{padding:6px 14px 10px}.nm{font-size:17px;font-weight:600}.sb{font-size:12px;color:#8a8a8a}
.msgs{top:96px}
.b{border-radius:14px}.b.in{background:#fff}.b.out{background:#eeffde}
.day{background:#00000040;color:#fff}
"""
    return f"""<html><head><meta charset="utf-8"><style>{css}</style></head><body>
<div class="top"><div class="status"><span>7:33</span><span>5G ▂▄▆ 72%</span></div>
<div class="title"><div class="nm">{html.escape(name)}</div><div class="sb">last seen recently · {PH_2}</div></div></div>
<div class="msgs">{_bubbles(items)}</div></body></html>"""


def page_fake_story(d, dm_items) -> str:
    css = BASE_CSS + """
body{background:#111;color:#fff}
.story{position:absolute;top:34px;left:0;right:0;height:520px;background:linear-gradient(135deg,#3a0ca3,#7209b7 55%,#f72585);padding:22px}
.bar{height:3px;background:#ffffff80;border-radius:2px;margin-bottom:12px}
.who{display:flex;gap:8px;align-items:center;font-weight:600;font-size:14px;margin-bottom:56px}
.av{width:30px;height:30px;border-radius:50%;background:#fff;color:#7209b7;display:flex;align-items:center;justify-content:center;font-weight:800}
.cap{font-size:26px;font-weight:800;line-height:1.25;text-shadow:0 2px 8px #0006}
.views{position:absolute;bottom:14px;left:22px;font-size:13px;opacity:.9}
.com{position:absolute;top:570px;left:0;right:0;padding:0 16px}
.com h4{font-size:13px;color:#a8a8a8;margin-bottom:10px;font-weight:600}
.c{margin-bottom:12px;font-size:14px}.c b{margin-right:6px}
"""
    comments = "".join(f'<div class="c"><b>{html.escape(u)}</b>{html.escape(t)}</div>' for u, t in d["comments"])
    return f"""<html><head><meta charset="utf-8"><style>{css}</style></head><body>
<div class="status"><span>9:12</span><span>5G ▂▄▆ 55%</span></div>
<div class="story"><div class="bar"></div><div class="who"><div class="av">a</div>{html.escape(d['handle'])} · 21 Sep, 9:05 pm</div>
<div class="cap">{html.escape(d['caption'])}</div><div class="views">👁 {html.escape(d['views'])}</div></div>
<div class="com"><h4>Replies &amp; comments</h4>{comments}</div></body></html>"""


def find_chrome() -> str:
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    found = shutil.which("chrome") or shutil.which("google-chrome") or shutil.which("msedge")
    if found:
        return found
    sys.exit("No Chrome/Edge found for rendering the screenshots.")


def render(html_text: str, out_png: Path, tmp: Path) -> None:
    src = tmp / (out_png.stem + ".html")
    src.write_text(html_text, encoding="utf-8")
    subprocess.run(
        [find_chrome(), "--headless=new", f"--user-data-dir={tmp / 'profile'}", "--no-first-run", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}",
         "--force-device-scale-factor=2", f"--screenshot={out_png}", src.as_uri()],
        check=True, capture_output=True, timeout=90,
    )
    if not out_png.exists():
        raise RuntimeError(f"screenshot not written: {out_png}")


def stamp_exif(path: Path, *, software: str | None = None, taken: str | None = None, modified: str | None = None) -> None:
    from PIL import Image

    img = Image.open(path).convert("RGB")
    exif = Image.Exif()
    if software:
        exif[0x0131] = software
    if modified:
        exif[0x0132] = modified
    if taken:
        exif[0x8769] = {0x9003: taken}
    img.save(path, "PNG", exif=exif.tobytes())


# ---------------------------------------------------------------------------------------------------------------------
# Other evidence
# ---------------------------------------------------------------------------------------------------------------------
def make_statement_pdf(path: Path) -> None:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((50, 60), "HDFC BANK - Account Statement (Demo)", fontsize=15)
    page.insert_text((50, 85), "Account holder: Ananya Rao    A/c no: XXXXXXX9035    Branch: Indiranagar, Bengaluru", fontsize=9)
    page.insert_text((50, 100), "Period: 01/09/2024 to 30/09/2024", fontsize=9)
    y = 140
    for r in STATEMENT_ROWS:
        page.insert_text((50, y), f"{r[0]}   {r[1]}   Debit: {r[2] or '-'}   Credit: {r[3] or '-'}   Balance: {r[4]}", fontsize=9)
        y += 40
    doc.set_metadata({"producer": "Demo Statement Generator 1.0", "creationDate": "D:20241001093000", "modDate": "D:20241001093000",
                      "title": "Account Statement Sep 2024"})
    doc.save(path)


def make_email(path: Path) -> None:
    m = EmailMessage()
    m["From"] = "Anonymous <anon.truth.blr@proton.me>"
    m["To"] = "Ananya Rao <ananya.rao.blr@gmail.com>"
    m["Subject"] = "last chance"
    m["Date"] = "Sat, 28 Sep 2024 22:41:00 +0530"
    m["Message-ID"] = "<demo-ananya-1@proton.me>"
    m.set_content(EMAIL_BODY)
    path.write_bytes(bytes(m))


def ground_truth() -> dict:
    return {
        "victim": {"name": "Ananya Rao", "aliases": ["Ananya", "Ananya Rao", "Me"], "owner": True},
        "persons": [
            {"name": "Karthik Menon", "aliases": ["Karthik Menon", "Karthik", "@karthik.clicks", "@anu.exposed", "anon.truth.blr@proton.me"],
             "identifiers": [PH_1, PH_2, UPI_1, UPI_2, "karthik.clicks", "anu.exposed", "anon.truth.blr@proton.me"]},
        ],
        "muleCluster": [UPI_1, UPI_2],
        "inconsistencies": [
            {"type": "EDITED_FILE", "file": "06_whatsapp_demand_EDITED.png", "note": "Snapseed in EXIF; DateTimeOriginal 5 Oct vs chat 22 Sep"},
            {"type": "AMOUNT_MISMATCH", "values": [15000, 25000], "identifier": UPI_1, "note": "demand in chat vs debit in bank"},
            {"type": "DATE_CONFLICT", "subtype": "statement_vs_evidence", "statementDate": "2024-09-25", "evidenceDate": "2024-09-23"},
        ],
        "duplicates": [
            {"export": "WhatsApp Chat with Karthik Menon.txt", "screenshots": ["01_whatsapp_persistent_contact.png", "04_whatsapp_threats_second_sim.png", "06_whatsapp_demand_EDITED.png"]},
        ],
        "events": [
            {"ts": "2024-09-04T23:06:00", "category": "harassment", "note": "repeated messages and missed calls"},
            {"ts": "2024-09-07T19:48:00", "category": "stalking", "note": "waited near office"},
            {"ts": "2024-09-09T09:02:00", "category": "consent_withdrawal", "note": "victim says stop, blocks"},
            {"ts": "2024-09-10T08:15:00", "category": "block_evasion"},
            {"ts": "2024-09-14T18:12:00", "category": "stalking", "note": "knows metro and PG location"},
            {"ts": "2024-09-18T21:31:00", "category": "threat", "note": "private photos, HR, parents"},
            {"ts": "2024-09-21T21:05:00", "category": "defamation", "note": "fake story @anu.exposed"},
            {"ts": "2024-09-22T20:31:00", "category": "extortion", "amount": 15000},
            {"ts": "2024-09-23", "category": "payment", "amount": 25000},
            {"ts": "2024-09-26T19:03:00", "category": "extortion", "amount": 30000},
            {"ts": "2024-09-27", "category": "payment", "amount": 10000},
            {"ts": "2024-09-28T22:41:00", "category": "threat", "note": "email from throwaway address"},
        ],
        "statementText": STATEMENT_TEXT,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as t:
        tmp = Path(t)
        jobs = [
            ("01_whatsapp_persistent_contact.png", page_whatsapp(WA1, HIM, "last seen today at 9:04 am", dark=False)),
            ("02_instagram_dm_after_block.png", page_instagram_dm(IG, "karthik.clicks")),
            ("03_sms_surveillance.png", page_sms(SMS, PH_2)),
            ("04_whatsapp_threats_second_sim.png", page_whatsapp(WA4, PH_2 + " ~Karthik", "online", dark=True)),
            ("05_instagram_fake_account.png", page_fake_story(IG_FAKE_STORY, [])),
            ("06_whatsapp_demand_EDITED.png", page_whatsapp(WA6, PH_2 + " ~Karthik", "online", dark=False)),
            ("07_telegram_second_demand.png", page_telegram(TG, "ktk")),
        ]
        for name, doc in jobs:
            render(doc, OUT / name, tmp)
            print("  rendered", name)
    # Honest screenshots carry phone-like EXIF; #6 is "edited": Snapseed + a date that disagrees with the chat.
    stamp_exif(OUT / "06_whatsapp_demand_EDITED.png", software="Snapseed 2.0", modified="2024:10:05 18:20:11", taken="2024:10:05 18:19:40")
    for n, d in [("01_whatsapp_persistent_contact.png", "2024:09:09 09:10:03"), ("02_instagram_dm_after_block.png", "2024:09:10 08:34:12"),
                 ("03_sms_surveillance.png", "2024:09:14 18:20:45"), ("04_whatsapp_threats_second_sim.png", "2024:09:18 21:55:30"),
                 ("05_instagram_fake_account.png", "2024:09:21 21:12:09"), ("07_telegram_second_demand.png", "2024:09:26 19:33:18")]:
        stamp_exif(OUT / n, taken=d, modified=d)

    (OUT / "WhatsApp Chat with Karthik Menon.txt").write_text(WHATSAPP_EXPORT, encoding="utf-8")
    make_statement_pdf(OUT / "hdfc_statement_sep2024.pdf")
    make_email(OUT / "email_from_anon.eml")
    (OUT / "statement_text.txt").write_text(STATEMENT_TEXT, encoding="utf-8")
    (OUT / "ground_truth.json").write_text(json.dumps(ground_truth(), indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
