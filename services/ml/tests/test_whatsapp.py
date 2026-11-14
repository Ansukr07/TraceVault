from datetime import datetime

from app.ingestion.whatsapp import parse_whatsapp

ANDROID = """12/05/24, 9:41 pm - Messages and calls are end-to-end encrypted.
12/05/24, 9:42 pm - Rahul: kal raat 9 baje milna
warna photos viral kar dunga
13/05/24, 10:05 am - Priya: <attached: IMG-0001.jpg>
13/05/24, 10:06 am - Rahul: send 5000 on rahul@upi
"""

IOS = """‎[25/12/2023, 21:41:23] Rahul: hello
[25/12/2023, 21:42:00] Priya: IMG-9.jpg (file attached)
"""

US = """5/14/24, 9:41 AM - A: hi
5/15/24, 9:41 PM - B: yo
"""


def test_android_multiline_media_system():
    c = parse_whatsapp(ANDROID)
    assert [m.sender for m in c.messages] == [None, "Rahul", "Priya", "Rahul"]
    assert c.messages[0].is_system
    assert c.messages[1].text == "kal raat 9 baje milna\nwarna photos viral kar dunga"
    assert c.messages[1].ts == datetime(2024, 5, 12, 21, 42)
    assert c.messages[2].media == "IMG-0001.jpg"
    assert c.messages[3].line_no == 5
    assert c.participants == ["Priya", "Rahul"]


def test_ios_24h_and_file_attached():
    c = parse_whatsapp(IOS)
    assert c.messages[0].ts == datetime(2023, 12, 25, 21, 41, 23)
    assert c.messages[1].media == "IMG-9.jpg"


def test_mdy_detected_from_day_over_12():
    c = parse_whatsapp(US)
    assert c.date_order == "MDY"
    assert c.messages[0].ts == datetime(2024, 5, 14, 9, 41)
    assert c.messages[1].ts == datetime(2024, 5, 15, 21, 41)


def test_ambiguous_defaults_to_dmy():
    c = parse_whatsapp("01/02/24, 9:00 am - A: x\n")
    assert c.date_order == "DMY"
    assert c.messages[0].ts == datetime(2024, 2, 1, 9, 0)


def test_midnight_and_noon_12h():
    c = parse_whatsapp("01/02/24, 12:05 am - A: x\n01/02/24, 12:05 pm - A: y\n")
    assert [m.ts.hour for m in c.messages] == [0, 12]
