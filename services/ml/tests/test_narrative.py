import os

from fastapi.testclient import TestClient

SEGS = [
    {"id": "E9:0", "text": "Um, main Priya bol rahi hoon. Rahul ne mujhe 12 May ko WhatsApp pe message kiya.",
     "textEn": "Um, I am Priya speaking. Rahul messaged me on WhatsApp on 12 May.", "lang": "hi-IN"},
    {"id": "E9:1", "text": "Usne photos viral karne ki dhamki di, 50,000 Rs rahul.k@okaxis pe maange.",
     "textEn": "He threatened to make my photos viral and asked for Rs 50,000 on rahul.k@okaxis.", "lang": "hi-IN"},
    {"id": "E9:2", "text": "[untranscribed]", "textEn": None, "lang": None},
    {"id": "E9:3", "text": "Mera number 98765 43210 hai.", "textEn": "My number is 98765 43210.", "lang": "hi-IN"},
]


def client():
    os.environ["INTERNAL_SECRET"] = "s3cret"
    for k in ("LLM_API_KEY", "GROQ_API_KEY"):
        os.environ.pop(k, None)
    from app.main import app

    return TestClient(app, headers={"x-internal-secret": "s3cret"})


def test_narrative_is_cited_cleaned_and_never_invents():
    r = client().post("/case/narrative", json={"segments": SEGS, "lang": "hi-IN", "llmMode": "local", "refTs": "2024-06-03T10:00:00"})
    assert r.status_code == 200, r.text
    d = r.json()
    ids = {s["id"] for s in SEGS}
    assert d["generator"]["name"] == "transcript-cleanup" and d["untranscribed"] == 1 and d["segments"] == 3
    assert d["sentences"] and all(s["citations"] and set(s["citations"]) <= ids - {"E9:2"} for s in d["sentences"])
    assert "Um," not in d["textEn"]
    # Everything in the English draft comes from the transcript: no new numbers or names appear.
    for tok in ("50,000", "rahul.k@okaxis", "98765"):
        assert tok in d["textEn"]
    g = d["suggestions"]
    assert g["incidentType"]["value"] == "sextortion"
    assert [x["value"] for x in g["amounts"]] == [50000]
    assert any(x["value"] == "rahul.k@okaxis" for x in g["payments"])
    assert any(x["value"] == "+919876543210" for x in g["phones"])
    assert any(x["text"].lower().startswith("priya") for x in g["people"])
    assert any(x["type"] == "DATE" for x in g["dates"])


def test_empty_statement_is_safe():
    r = client().post("/case/narrative", json={"segments": [{"id": "E9:0", "text": "[untranscribed]"}], "llmMode": "local"})
    assert r.status_code == 200
    d = r.json()
    assert d["sentences"] == [] and d["suggestions"]["incidentType"]["value"] == "other"
