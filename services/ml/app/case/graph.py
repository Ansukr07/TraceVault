"""Relationship graph + analytics (spec N8, G1–G6)."""
from __future__ import annotations

from collections import defaultdict

import networkx as nx

from .common import parse_ts


def build(chunks: list[dict], evidence: list[dict], resolved: dict, events: list[dict]) -> dict:
    ents = {e["key"]: e for e in resolved["entities"]}
    alias = resolved["aliasToEntity"]
    nodes: dict[str, dict] = {}
    edges: dict[tuple, dict] = {}

    def node(key: str) -> None:
        if key in nodes or key not in ents:
            return
        e = ents[key]
        nodes[key] = {"id": key, "type": e["type"], "label": e["name"], "mentions": e["mentionCount"],
                      "isOwner": e.get("isOwner", False), "evidenceIds": e["evidenceIds"]}

    def edge(t: str, a: str, b: str, chunk: dict | None = None, **extra) -> None:
        if not a or not b or a == b:
            return
        node(a), node(b)
        if a not in nodes or (b not in nodes and not b.startswith("EVIDENCE:")):
            return
        k = (t, a, b)
        e = edges.setdefault(k, {"id": f"{t}|{a}|{b}", "type": t, "source": a, "target": b, "count": 0,
                                 "firstTs": None, "lastTs": None, "citations": [], **extra})
        e["count"] += 1
        if chunk:
            ts = chunk.get("refTs")
            if ts:
                e["firstTs"] = min(filter(None, [e["firstTs"], ts]))
                e["lastTs"] = max(filter(None, [e["lastTs"], ts]))
            if len(e["citations"]) < 25:
                e["citations"].append(chunk["id"])

    from .events import _alias_key

    participants: dict[str, set[str]] = defaultdict(set)
    for c in chunks:
        if c.get("sender"):
            participants[c["evidenceId"]].add(alias.get(_alias_key(c["sender"], resolved), ""))
    owner = next((e["key"] for e in resolved["entities"] if e.get("isOwner")), None)

    for c in chunks:
        s = alias.get(_alias_key(c["sender"], resolved)) if c.get("sender") else None
        if s:
            others = participants[c["evidenceId"]] - {s, ""}
            if not others and owner and owner != s:
                others = {owner}
            for o in others:
                edge("MESSAGED", s, o, c)
            sev = (c.get("severity") or {})
            if sev.get("score", 0) >= 2 and set(sev.get("labels", [])) & {"threat", "extortion", "sexual"}:
                for o in others:
                    edge("THREATENED", s, o, c)
        for m in resolved["mentions"].get(c["id"], []):
            k = m["entityKey"]
            if s and k != s and m["type"] in ("PHONE", "EMAIL", "UPI_ID", "HANDLE", "BANK_ACCT", "LOCATION"):
                edge("APPEARS_WITH", s, k, c)
    # Identifier ownership (from resolution) → APPEARS_WITH labelled "uses".
    for e in resolved["entities"]:
        for o in e.get("ownerKeys", []):
            edge("APPEARS_WITH", o, e["key"], None, label="uses")
    # Payments recorded in documents: complainant → recipient identifier.
    for ev in events:
        if ev["category"] == "payment" and owner:
            for ik in ev["identifiers"]:
                if ik.startswith(("UPI_ID:", "BANK_ACCT:")):
                    edge("PAID", owner, ik, {"id": ev["citations"][0], "refTs": ev["ts"]}, amount=ev["amount"])
    # Evidence nodes + MENTIONED_IN (people and identifiers only, to keep the graph readable).
    ev_by_id = {e["id"]: e for e in evidence}
    for k, n in list(nodes.items()):
        for eid in ents[k]["evidenceIds"]:
            ek = f"EVIDENCE:{eid}"
            if ek not in nodes and eid in ev_by_id:
                ev = ev_by_id[eid]
                nodes[ek] = {"id": ek, "type": "EVIDENCE", "kind": ev["kind"], "label": ev.get("sourceLabel") or ev["filename"],
                             "evidenceId": eid, "mentions": 1}
            if ek in nodes:
                edges.setdefault(("MENTIONED_IN", k, ek), {"id": f"MENTIONED_IN|{k}|{ek}", "type": "MENTIONED_IN", "source": k,
                                                           "target": ek, "count": 1, "citations": [], "firstTs": None, "lastTs": None})
    for c in resolved["candidates"]:
        node(c["a"]), node(c["b"])
        if c["a"] in nodes and c["b"] in nodes:
            edges[("SAME_AS_CANDIDATE", c["a"], c["b"])] = {"id": f"SAME_AS_CANDIDATE|{c['a']}|{c['b']}", "type": "SAME_AS_CANDIDATE",
                                                            "source": c["a"], "target": c["b"], "count": 1, "score": c["score"],
                                                            "reason": c["reason"], "citations": [], "firstTs": None, "lastTs": None}

    # Analytics on the non-evidence graph.
    g = nx.Graph()
    for k, n in nodes.items():
        if n["type"] != "EVIDENCE":
            g.add_node(k)
    for e in edges.values():
        if e["type"] not in ("MENTIONED_IN", "SAME_AS_CANDIDATE") and g.has_node(e["source"]) and g.has_node(e["target"]):
            w = g.get_edge_data(e["source"], e["target"], {}).get("weight", 0) + e["count"]
            g.add_edge(e["source"], e["target"], weight=w)
    if g.number_of_nodes():
        cent = nx.degree_centrality(g)
        try:
            between = nx.betweenness_centrality(g, weight=None) if g.number_of_nodes() < 400 else {}
        except Exception:  # noqa: BLE001
            between = {}
        comms = nx.community.louvain_communities(g, weight="weight", seed=7) if g.number_of_edges() else [{n} for n in g]
        for i, cm in enumerate(sorted(comms, key=len, reverse=True)):
            money_nodes = [n for n in cm if nodes[n]["type"] in ("UPI_ID", "BANK_ACCT")]
            for n in cm:
                nodes[n]["community"] = i if len(cm) > 1 else None
                nodes[n]["muleCluster"] = len(money_nodes) >= 2
        for n in g:
            nodes[n]["centrality"] = round(cent.get(n, 0), 4)
            nodes[n]["betweenness"] = round(between.get(n, 0), 4)
    central = sorted((n for n in nodes.values() if n["type"] == "PERSON" and not n.get("isOwner")),
                     key=lambda n: -(n.get("centrality", 0) + n.get("betweenness", 0)))[:3]
    times = [parse_ts(e["firstTs"]) for e in edges.values() if e.get("firstTs")]
    return {
        "nodes": list(nodes.values()), "edges": list(edges.values()),
        "centralFigures": [n["id"] for n in central],
        "timeRange": [min(times).isoformat(), max(times).isoformat()] if times else None,
    }
