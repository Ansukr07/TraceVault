import json

from app.parsers import extract as ex
from app.parsers.json_chat import parse_json_chat


def test_telegram_export():
    doc = {"messages": [
        {"id": 1, "type": "message", "date": "2024-05-12T21:41:00", "from": "Rahul", "text": "pay me 5000 or else"},
        {"id": 2, "type": "message", "date": "2024-05-12T21:42:10", "from": "Priya", "text": ["see ", {"type": "link", "text": "http://x.co"}]},
        {"id": 3, "type": "service", "date": "2024-05-12T21:43:00", "action": "pin_message"},
    ]}
    chat = parse_json_chat(json.dumps(doc).encode())
    assert [m.sender for m in chat.messages] == ["Rahul", "Priya", None]
    assert chat.messages[1].text == "see http://x.co"
    assert chat.participants == ["Rahul", "Priya"]


def test_instagram_export_is_chronological_and_fixes_mojibake():
    hindi = "मैं आ रहा हूँ".encode("utf-8").decode("latin-1")
    doc = {"participants": [{"name": "a"}], "messages": [
        {"sender_name": "rahul_k", "timestamp_ms": 1715550000000, "content": "second"},
        {"sender_name": "rahul_k", "timestamp_ms": 1715540000000, "content": hindi},
    ]}
    chat = parse_json_chat(json.dumps(doc).encode())
    assert chat.messages[0].text == "मैं आ रहा हूँ" and chat.messages[1].text == "second"
    assert chat.messages[0].ts < chat.messages[1].ts


def test_unrecognised_json_is_not_a_chat():
    assert parse_json_chat(b'{"hello": 1}') is None
    assert parse_json_chat(b"not json") is None


def test_extract_chat_routes_json_and_still_handles_whatsapp():
    tg = json.dumps({"messages": [{"id": 1, "type": "message", "date": "2024-05-12T21:41:00", "from": "R", "text": "hi"}]}).encode()
    out = ex.extract_chat(tg)
    assert out["chunks"][0]["sender"] == "R" and out["chunks"][0]["refTs"].startswith("2024-05-12T21:41")
    wa = b"12/05/24, 9:41 pm - Rahul: hello there\n"
    assert ex.extract_chat(wa)["chunks"][0]["sender"] == "Rahul"
