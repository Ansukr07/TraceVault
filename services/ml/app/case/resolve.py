"""Entity resolution across sources (spec N3).

People are clustered from names (chat senders, email display names, self-identification,
in-text mentions) and the identifiers they own (phone, email, UPI, handle, account).
Score ≥ 0.85 → merged; 0.65–0.85 → SAME_AS_CANDIDATE. Manual must-link / cannot-link
constraints (by alias key) always win and survive rebuilds.
"""
from __future__ import annotations

import re
from collections import defaultdict
from itertools import combinations

from rapidfuzz import fuzz

from .common import IDENTIFIER_TYPES, PLACE_TYPES, norm_name

AUTO_MERGE = 0.85
CANDIDATE = 0.65

# "my number", "pay on X", "send to X", "mera number", "call me on" — sender owns the identifier.
_OWN_CUE = re.compile(
    r"\b(my|mera|meri|mere|apna|pay\s+(?:on|to|at|me)|send\s+(?:on|to|it\s+to|money\s+to)|bhej(?:o|na|do)?\s+(?:on|pe|par)?|"
    r"transfer\s+(?:to|on)|call\s+me|whatsapp\s+me|dm\s+me|follow\s+me|contact\s+me|email\s+me|reach\s+me|pe\s+bhej|par\s+bhej|is\s+number)\b",
    re.IGNORECASE,
)
_PAY_TO = re.compile(r"\b(send|pay|paid|transfer|bhej\w*|deposit|daal\w*|dal\w*)\b[^.!?\n]{0,30}\b(on|to|pe|par|at|in)\s*$", re.IGNORECASE)
_SELF_ALIASES = {"me", "you", "i", "myself", "complainant"}


class UF:
    def __init__(self):
        self.p: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[max(ra, rb)] = min(ra, rb)


def _name_score(a: str, b: str) -> float:
    if a == b:
        return 1.0
    ta, tb = a.split(), b.split()
    if not ta or not tb:
        return 0.0
    # "rahul" vs "rahul k" / "rahul kumar": same first name, one extends the other with an initial/surname.
    if ta[0] == tb[0] and len(ta[0]) >= 3:
        short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if all(any(l.startswith(s) or s.startswith(l) for l in long_) for s in short):
            return 0.88 if len(short) == 1 else 0.92
    r = fuzz.token_sort_ratio(a, b) / 100
    if r >= 0.92:
        return 0.9
    if r >= 0.8:
        return 0.7
    return 0.0


def _ident_matches_name(ident_norm: str, name: str) -> bool:
    local = re.split(r"[@]", ident_norm.lstrip("@"))[0]
    parts = [p for p in re.split(r"[\W_\d]+", local.lower()) if p]
    toks = [t for t in name.split() if len(t) >= 3]
    return bool(toks) and toks[0] in parts or (bool(toks) and local.lower().startswith(toks[0]))


def resolve(chunks: list[dict], *, owner_name: str | None = None, constraints: dict | None = None) -> dict:
    constraints = constraints or {}
    owner = norm_name(owner_name) if owner_name else None
    names: dict[str, dict] = {}  # alias key -> {display, mentions:set(chunkId), evidence:set}
    owned: dict[str, set[str]] = defaultdict(set)  # identifier key -> alias keys that own it
    ident: dict[str, dict] = {}  # identifier/place key -> info
    mentions: dict[str, list[dict]] = defaultdict(list)  # chunkId -> [{aliasKey|key, start, end, type}]

    def alias(display: str) -> str | None:
        n = norm_name(display)
        if not n:
            return None
        if n in _SELF_ALIASES and owner:
            n = owner
        elif n in _SELF_ALIASES:
            n = "complainant"
        return f"PERSON:{n}"

    for c in chunks:
        cid, eid = c["id"], c["evidenceId"]
        speaker = c.get("sender") or c.get("speakerName")
        sender_key = alias(speaker) if speaker else None
        if sender_key:
            rec = names.setdefault(sender_key, {"display": speaker if norm_name(speaker) not in _SELF_ALIASES else (owner_name or "Complainant"),
                                                "mentions": set(), "evidence": set()})
            rec["mentions"].add(cid)
            rec["evidence"].add(eid)
        for e in c.get("entities", []):
            t = e["type"]
            if t == "PERSON":
                k = alias(str(e["norm"]))
                if not k:
                    continue
                rec = names.setdefault(k, {"display": str(e["norm"]), "mentions": set(), "evidence": set()})
                rec["mentions"].add(cid)
                rec["evidence"].add(eid)
                mentions[cid].append({"key": k, "start": e["start"], "end": e["end"], "type": t})
                if e.get("selfId") and sender_key and sender_key != k:
                    # "main Rahul bol raha hoon" from an unnamed sender/speaker: same person.
                    owned[f"ALIAS:{k}"].add(sender_key)
            elif t in IDENTIFIER_TYPES or t in PLACE_TYPES:
                k = f"{t}:{e['norm']}"
                info = ident.setdefault(k, {"type": t, "value": str(e["norm"]), "display": e["text"], "mentions": set(), "evidence": set()})
                info["mentions"].add(cid)
                info["evidence"].add(eid)
                mentions[cid].append({"key": k, "start": e["start"], "end": e["end"], "type": t})
                if t in IDENTIFIER_TYPES and sender_key:
                    window = c["text"][max(0, e["start"] - 40): e["start"]]
                    if _OWN_CUE.search(window) or _PAY_TO.search(window):
                        owned[k].add(sender_key)
        # Email header: "From: Rahul K <rk.alt@gmail.com>" — display name owns the address.
        if c.get("unit") == "header":
            m = re.search(r"From:\s*\"?([^\"<\n]+?)\"?\s*<([^>]+)>", c["text"])
            if m:
                k = alias(m[1])
                if k:
                    names.setdefault(k, {"display": m[1].strip(), "mentions": set(), "evidence": set()})
                    names[k]["mentions"].add(cid)
                    names[k]["evidence"].add(eid)
                    owned[f"EMAIL:{m[2].strip().lower()}"].add(k)

    # ---------------- scoring
    uf = UF()
    for k in names:
        uf.find(k)
    cannot = {frozenset(p) for p in constraints.get("cannotLink", [])}
    must = [tuple(p) for p in constraints.get("mustLink", [])]
    pair_scores: dict[frozenset, tuple[float, str]] = {}

    def score(a: str, b: str, s: float, why: str) -> None:
        key = frozenset((a, b))
        if a == b or key in cannot:
            return
        if s > pair_scores.get(key, (0, ""))[0]:
            pair_scores[key] = (s, why)

    keys = list(names)
    for a, b in combinations(keys, 2):
        s = _name_score(a.split(":", 1)[1], b.split(":", 1)[1])
        if s:
            score(a, b, s, "name similarity")
    for ik, owners in owned.items():
        for a, b in combinations(sorted(owners), 2):
            score(a, b, 0.95 if not ik.startswith("ALIAS:") else 0.9, f"both use {ik.split(':', 1)[1]}")
        if ik.startswith("ALIAS:"):
            for o in owners:
                score(ik[6:], o, 0.9, "self-identification")
    # Unowned identifiers whose local part contains a person's first name → candidate (e.g. @rahul_k_official).
    ident_candidates = []
    for ik, info in ident.items():
        if info["type"] in ("EMAIL", "HANDLE", "UPI_ID") and not owned.get(ik):
            for pk in keys:
                if _ident_matches_name(info["value"], pk.split(":", 1)[1]):
                    ident_candidates.append({"a": pk, "b": ik, "score": 0.7, "reason": f"name appears in {info['value']}"})

    # Merge: must-links first, then auto-merge by descending score, never violating cannot-links.
    def would_violate(a: str, b: str) -> bool:
        ra, rb = uf.find(a), uf.find(b)
        ga = [k for k in keys if uf.find(k) == ra]
        gb = [k for k in keys if uf.find(k) == rb]
        return any(frozenset((x, y)) in cannot for x in ga for y in gb)

    for a, b in must:
        uf.find(a), uf.find(b)
        if a in names and b in names:
            uf.union(a, b)
    candidates = []
    for pair, (s, why) in sorted(pair_scores.items(), key=lambda kv: -kv[1][0]):
        a, b = sorted(pair)
        if s >= AUTO_MERGE and not would_violate(a, b):
            uf.union(a, b)
        elif s >= CANDIDATE and uf.find(a) != uf.find(b):
            candidates.append({"a": a, "b": b, "score": round(s, 2), "reason": why})

    # Identifier ownership attaches identifiers to the merged person.
    groups: dict[str, list[str]] = defaultdict(list)
    for k in keys:
        groups[uf.find(k)].append(k)

    entities = []
    alias_to_entity: dict[str, str] = {}
    for root, aliases in groups.items():
        aliases.sort()
        ekey = aliases[0]
        for a in aliases:
            alias_to_entity[a] = ekey
        disp = names[max(aliases, key=lambda a: (len(names[a]["mentions"]), len(names[a]["display"])))]["display"]
        idents = defaultdict(list)
        for ik, owners in owned.items():
            if not ik.startswith("ALIAS:") and owners & set(aliases):
                t, v = ik.split(":", 1)
                idents[t].append(v)
        ment = set().union(*(names[a]["mentions"] for a in aliases))
        evs = set().union(*(names[a]["evidence"] for a in aliases))
        entities.append({
            "key": ekey, "type": "PERSON", "name": disp, "aliases": sorted({names[a]["display"] for a in aliases}),
            "aliasKeys": aliases, "identifiers": dict(idents), "mentionChunkIds": sorted(ment), "mentionCount": len(ment),
            "evidenceIds": sorted(evs), "isOwner": bool(owner) and f"PERSON:{owner}" in aliases,
        })
    for ik, info in ident.items():
        owners = {alias_to_entity.get(o) for o in owned.get(ik, set()) if alias_to_entity.get(o)}
        entities.append({
            "key": ik, "type": info["type"], "name": info["value"] if info["type"] not in PLACE_TYPES else info["display"],
            "aliases": [info["display"]], "aliasKeys": [ik], "ownerKeys": sorted(owners),
            "mentionChunkIds": sorted(info["mentions"]), "mentionCount": len(info["mentions"]), "evidenceIds": sorted(info["evidence"]),
        })

    def ent(k: str) -> str:
        return alias_to_entity.get(k, k)

    for cid, ms in mentions.items():
        for m in ms:
            m["entityKey"] = ent(m.pop("key"))
    cand = [{"a": ent(c["a"]), "b": ent(c["b"]), "score": c["score"], "reason": c["reason"], "aliasA": c["a"], "aliasB": c["b"]}
            for c in candidates + ident_candidates if ent(c["a"]) != ent(c["b"])]
    # One candidate per entity pair (highest score).
    best: dict[frozenset, dict] = {}
    for c in cand:
        k = frozenset((c["a"], c["b"]))
        if k not in best or c["score"] > best[k]["score"]:
            best[k] = c
    entities.sort(key=lambda e: (-e["mentionCount"], e["key"]))
    return {"entities": entities, "mentions": dict(mentions), "candidates": list(best.values()), "aliasToEntity": alias_to_entity}
