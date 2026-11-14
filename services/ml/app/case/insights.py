"""Pattern insights (spec N11): escalation trend, day×hour heatmap, first contact, peak hours, response gaps."""
from __future__ import annotations

from collections import defaultdict

from .common import parse_ts


def build(chunks: list[dict], owner_names: set[str]) -> dict:
    msgs = []
    for c in chunks:
        t = parse_ts(c.get("refTs"))
        if c.get("unit") in ("message", "bubble") and t and not c.get("tsInferred"):
            msgs.append((t, c))
    msgs.sort(key=lambda x: x[0])
    heat = [[0] * 24 for _ in range(7)]
    weekly: dict[str, list[int]] = defaultdict(list)
    hours = defaultdict(int)
    for t, c in msgs:
        heat[t.weekday()][t.hour] += 1
        hours[t.hour] += 1
        if (c.get("sender") or "").lower() not in owner_names:
            iso = t.isocalendar()
            weekly[f"{iso[0]}-W{iso[1]:02d}"].append((c.get("severity") or {}).get("score", 0))
    escalation = [{"week": w, "messages": len(v), "avgSeverity": round(sum(v) / len(v), 2), "maxSeverity": max(v),
                   "severe": sum(1 for s in v if s >= 2)} for w, v in sorted(weekly.items())]
    trend = None
    if len(escalation) >= 2:
        n = len(escalation)
        xs = range(n)
        ys = [e["avgSeverity"] for e in escalation]
        mx, my = (n - 1) / 2, sum(ys) / n
        den = sum((x - mx) ** 2 for x in xs)
        trend = round(sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den, 3) if den else 0.0
    first = next(((t, c) for t, c in msgs if (c.get("sender") or "").lower() not in owner_names), None)
    gaps = []
    for (t1, c1), (t2, c2) in zip(msgs, msgs[1:]):
        gaps.append({"from": t1.isoformat(), "to": t2.isoformat(), "hours": round((t2 - t1).total_seconds() / 3600, 1),
                     "afterChunkId": c1["id"], "beforeChunkId": c2["id"]})
    gaps.sort(key=lambda g: -g["hours"])
    return {
        "escalation": escalation, "escalationSlope": trend, "escalating": bool(trend and trend > 0.05),
        "heatmap": heat, "peakHours": [h for h, _ in sorted(hours.items(), key=lambda kv: -kv[1])[:3]],
        "firstContact": {"ts": first[0].isoformat(), "chunkId": first[1]["id"], "sender": first[1].get("sender")} if first else None,
        "responseGaps": gaps[:3], "messageCount": len(msgs),
    }
