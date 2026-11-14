"""Rules from inconsistency-flag-spec.md (§4.1, §4.2, §8)."""
from app.case.inconsistency import _close_enough, detect


def _chunk(cid, eid, sender, text, idx=0):
    return {"id": cid, "evidenceId": eid, "sender": sender, "text": text, "idx": idx, "entities": [], "unit": "message"}


def _run(pairs, owner=None):
    chunks, members = [], []
    for i, (s1, s2, text) in enumerate(pairs):
        a, b = _chunk(f"a{i}", "E7", s1, text, i), _chunk(f"b{i}", "E3", s2, text, i)
        chunks += [a, b]
        members.append({"kind": "cross_modal", "members": [{"chunkId": a["id"]}, {"chunkId": b["id"]}]})
    ents = [{"key": "PERSON:ananya", "name": "Ananya", "isOwner": True}] if owner else []
    resolved = {"aliasToEntity": {"PERSON:ananya": "PERSON:ananya", "PERSON:karthik": "PERSON:karthik"}, "entities": ents, "mentions": {}}
    ev = [{"id": "E7", "filename": "chat.txt"}, {"id": "E3", "filename": "shot.png"}]
    return detect(ev, chunks, {"groups": members, "contradictions": []}, resolved, [])


LONG = "Please do not do this I will pay just delete everything"


def test_me_resolves_to_owner_no_flag():
    assert _run([("Ananya", "Me", LONG)], owner=True) == []


def test_short_generic_message_ignored():
    assert _run([("Karthik", "Me", "ok thanks")], owner=True) == []


def test_real_sender_conflict_flagged():
    out = _run([("Karthik", "Me", LONG)], owner=True)
    assert len(out) == 1 and out[0]["type"] == "SENDER_MISMATCH" and out[0]["severity"] == 2


def test_unknown_owner_collapses_to_one_low_flag():
    out = _run([("Ananya", "Me", LONG + f" {i}") for i in range(5)])
    assert len(out) == 1 and out[0]["severity"] == 1


def test_bulk_flip_collapses_even_with_owner():
    out = _run([("Karthik", "Me", LONG + f" {i}") for i in range(5)], owner=True)
    assert len(out) == 1 and out[0]["subtype"] == "speaker_labels"


def test_amount_tolerance():
    assert _close_enough({15000}, {15010})
    assert not _close_enough({15000}, {25000})
