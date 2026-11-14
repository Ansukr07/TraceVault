"""End-to-end ML pipeline on the generated demo case (eval/generate_case.py).

extract → nlp/enrich → case/rebuild → case/summarize, exactly as the Node job runner calls them.
"""
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[3]
CASE = ROOT / "eval" / "data" / "priya_case"
FILES = [
    ("WhatsApp Chat with Rahul K.txt", "chat_export", "WhatsApp – Rahul chat"),
    ("screenshot_rahul_demand.png", "image", "Screenshot of demand"),
    ("sbi_statement_may2024.pdf", "pdf", "SBI statement May 2024"),
    ("email_from_rk.eml", "email", "Email from rk.alt"),
]


@pytest.fixture(scope="module")
def api():
    if not (CASE / "ground_truth.json").exists():
        subprocess.run([sys.executable, str(ROOT / "eval" / "generate_case.py")], check=True)
    import os

    os.environ["INTERNAL_SECRET"] = "s3cret"
    os.environ["SARVAM_MOCK"] = "true"
    os.environ.pop("ANTHROPIC_API_KEY", None)
    from app.main import app
    from app.voice import sarvam_client

    sarvam_client.reset_client()
    with TestClient(app, headers={"x-internal-secret": "s3cret"}) as c:
        yield c


def run_pipeline(api, statement: bool = True) -> dict:
    evidence, chunks = [], []
    for idx, (name, kind, label) in enumerate(FILES, start=1):
        r = api.post("/extract", files={"file": (name, (CASE / name).read_bytes())},
                     data={"kind": kind, "filename": name, "translateMode": "off"})
        assert r.status_code == 200, r.text
        out = r.json()
        eid = f"ev{idx}"
        evidence.append({"id": eid, "idx": idx, "kind": kind, "filename": name, "sourceLabel": label, "sha256": f"sha{idx}",
                         "metadata": out["metadata"], "flags": out["flags"], "hashes": out.get("hashes", {})})
        for c in out["chunks"]:
            chunks.append({**c, "id": f"E{idx}:{c['idx']}", "evidenceId": eid, "sourceType": "document"})
    if statement:
        st = (CASE / "statement_text.txt").read_text(encoding="utf-8")
        evidence.append({"id": "ev9", "idx": 9, "kind": "statement", "filename": "statement.webm", "sourceLabel": "Your statement",
                         "sha256": "sha9", "metadata": {}, "flags": []})
        chunks.append({"id": "E9:0", "idx": 0, "evidenceId": "ev9", "text": st, "textEn": st, "lang": "en-IN", "unit": "segment",
                       "refTs": "2024-06-03T10:00:00", "locator": {"startMs": 0, "endMs": 9000}, "sourceType": "self_statement"})
    r = api.post("/nlp/enrich", json={"chunks": [{"id": c["id"], "text": c["text"], "textEn": c.get("textEn"), "refTs": c.get("refTs"),
                                                  "sender": c.get("sender")} for c in chunks]})
    assert r.status_code == 200
    by = {i["id"]: i for i in r.json()["items"]}
    for c in chunks:
        c.update({k: by[c["id"]][k] for k in ("entities", "times", "severity")})
    r = api.post("/case/rebuild", json={"ownerName": "Priya", "evidence": evidence, "chunks": chunks})
    assert r.status_code == 200, r.text
    case = r.json()
    r = api.post("/case/summarize", json={"llmMode": "cloud_redacted", "evidence": evidence, "chunks": chunks,
                                          "entities": case["entities"], "events": case["events"], "inconsistencies": case["inconsistencies"],
                                          "case": {"title": "Priya v. Rahul", "incidentType": "sextortion"}})
    assert r.status_code == 200, r.text
    return {"evidence": evidence, "chunks": chunks, "case": case, "summary": r.json()}


@pytest.fixture(scope="module")
def result(api):
    return run_pipeline(api)


def test_extraction(result):
    chunks = result["chunks"]
    chat = [c for c in chunks if c["evidenceId"] == "ev1"]
    assert len(chat) == 12 and chat[0]["sender"] == "Rahul K"
    shot = [c for c in chunks if c["evidenceId"] == "ev2"]
    assert any("okaxis" in c["text"] for c in shot), [c["text"] for c in shot]
    assert any(c["unit"] == "bubble" and c["sender"] == "Rahul K" for c in shot)
    pdf = [c for c in chunks if c["evidenceId"] == "ev3"]
    assert any("50,000" in c["text"] for c in pdf)
    flags = {f["type"] for f in result["evidence"][1]["flags"]}
    assert "EDITED_FILE" in flags


def test_entity_resolution(result):
    people = [e for e in result["case"]["entities"] if e["type"] == "PERSON"]
    rahul = max(people, key=lambda e: e["mentionCount"])
    assert rahul["name"] in ("Rahul K", "Rahul")
    idents = {v for vs in rahul["identifiers"].values() for v in vs}
    assert "rahul.k@okaxis" in idents
    assert "rk.alt.2024@gmail.com" in idents, rahul  # email display name "Rahul K" merges with the chat Rahul K
    assert {"ev1", "ev2", "ev4"} <= set(rahul["evidenceIds"])
    priya = next(e for e in people if e.get("isOwner"))
    assert priya["name"].startswith("Priya")


def test_events_and_timeline(result):
    events = result["case"]["events"]
    cats = [(e["ts"][:10] if e["ts"] else None, e["category"], e["amount"]) for e in events]
    assert ("2024-05-15", "extortion", 5000) in cats, cats
    assert ("2024-05-16", "payment", 50000) in cats, cats
    assert any(e["sourceType"] == "self_statement" for e in events)
    assert not any(e["amount"] == 42000 for e in events), "salary credit is not an event"
    assert not any("asked for" in e["title"] and e["title"].startswith("Priya") for e in events)
    # Screenshot + chat of the same demand are merged into one corroborated event.
    demand = next(e for e in events if e["ts"] and e["ts"].startswith("2024-05-15T20:30") and e["category"] == "extortion")
    assert set(demand["evidenceIds"]) >= {"ev1", "ev2"} and demand["corroborationCount"] >= 1


def test_planted_inconsistencies(result):
    incs = result["case"]["inconsistencies"]
    types = [(i["type"], i.get("subtype")) for i in incs]
    assert ("EDITED_FILE", None) in types
    assert any(t == "AMOUNT_MISMATCH" for t, _ in types)
    assert ("DATE_CONFLICT", "statement_vs_evidence") in types
    assert len(incs) <= 3 + 3, types  # spec X: all 3 planted, ≤ 3 false positives


def test_graph_mule_cluster(result):
    g = result["case"]["graph"]
    ids = {n["id"]: n for n in g["nodes"]}
    assert "UPI_ID:rahul.k@okaxis" in ids and "UPI_ID:quickcash.77@ybl" in ids
    assert any(e["type"] == "PAID" for e in g["edges"])
    assert any(e["type"] == "THREATENED" for e in g["edges"])
    assert ids["UPI_ID:rahul.k@okaxis"].get("muleCluster") or ids["UPI_ID:quickcash.77@ybl"].get("muleCluster")


def test_summary_cited_and_valid(result):
    s = result["summary"]
    ids = {c["id"] for c in result["chunks"]} | {f"E{e['idx']}" for e in result["evidence"]}
    sents = [x for sec in s["sections"] for x in sec["sentences"]]
    assert len(sents) >= 6
    for x in sents:
        assert x["citations"], x  # S2: 100% of shown sentences carry a citation
        assert set(x["citations"]) <= ids
    assert any("According to the complainant" in x["text"] for x in sents)


def test_ask_retrieval(api, result):
    r = api.post("/case/ask", json={"question": "How much money did Priya pay to rahul.k@okaxis?", "llmMode": "local",
                                    "chunks": result["chunks"], "entities": result["case"]["entities"]})
    body = r.json()
    assert body["sentences"] and all(x["citations"] for x in body["sentences"])
