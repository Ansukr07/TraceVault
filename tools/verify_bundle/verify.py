#!/usr/bin/env python3
"""Offline verifier for a TraceVault evidence bundle. Python 3.8+, standard library only.

    python verify.py [bundle_dir]

Checks: (1) every original's SHA-256 against manifest.json, (2) the Merkle root, (3) the hash-chained audit log in
audit.jsonl, (4) the Ed25519 signature on checkpoint.json (needs the optional 'cryptography' package),
(5) RFC 3161 time-stamps in timestamps/ (the stamped hash must match the bundle; the authority's signature is
checked too when openssl and timestamps/trust.pem are available).
Exit code 0 = everything verified, 1 = something is wrong.
"""
import base64, calendar, hashlib, json, os, shutil, subprocess, sys, time

root = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
fails = []


def sha(b):
    return hashlib.sha256(b).hexdigest()


def canon(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canon(v[k]) for k in sorted(v) if v[k] is not None) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canon(x) for x in v) + "]"
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def read(name, mode="rb"):
    with open(os.path.join(root, name), mode) as f:
        return f.read()


def merkle(hashes):
    if not hashes:
        return sha(b"")
    leaf = lambda h: hashlib.sha256(b"\x00" + bytes.fromhex(h)).digest()
    level = [leaf(h) for h in sorted(hashes)]
    while len(level) > 1:
        nxt = []
        for i in range(0, len(level), 2):
            r = level[i + 1] if i + 1 < len(level) else level[i]
            nxt.append(hashlib.sha256(b"\x01" + level[i] + r).digest())
        level = nxt
    return level[0].hex()


manifest_bytes = read("manifest.json")
manifest = json.loads(manifest_bytes)
print("Case", manifest["caseId"], "exported", manifest["exportedAt"])

print("\n[1] Original files")
for f in manifest["files"]:
    p = os.path.join(root, f["path"])
    if not os.path.exists(p):
        fails.append("missing file " + f["path"]); print("  MISSING", f["path"]); continue
    ok = sha(open(p, "rb").read()) == f["sha256"]
    print("  ", "ok  " if ok else "FAIL", f["path"])
    if not ok:
        fails.append("hash mismatch " + f["path"])

print("\n[2] Merkle root")
root_ok = merkle([f["sha256"] for f in manifest["files"]]) == manifest["merkleRoot"]
print("  ", "ok  " if root_ok else "FAIL", manifest["merkleRoot"])
if not root_ok:
    fails.append("merkle root mismatch")

print("\n[3] Audit log hash chain")
prev = sha(("TRACEVAULT_GENESIS:" + manifest["caseId"]).encode())
count = 0
for line in read("audit.jsonl", "r").splitlines():
    e = json.loads(line)
    count += 1
    entry = {k: e.get(k) for k in ("caseId", "seq", "ts", "actorId", "actorRole", "action", "target", "payloadHash")}
    if e["seq"] != count or e["prevHash"] != prev or sha((prev + canon(entry)).encode()) != e["hash"]:
        fails.append("audit chain breaks at entry %d" % count); print("   FAIL chain breaks at entry", count); break
    prev = e["hash"]
else:
    print("   ok  ", count, "entries; head", prev)
if count != manifest["auditCount"] or (not fails and prev != manifest["auditHead"]):
    fails.append("audit head differs from manifest")

print("\n[4] Signed checkpoint")
cp = json.loads(read("checkpoint.json"))
if cp.get("payload", {}).get("manifestSha256") != sha(manifest_bytes):
    fails.append("manifest.json was changed after signing"); print("   FAIL manifest changed after signing")
elif not cp.get("signature"):
    print("   skipped: bundle was not signed")
else:
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_public_key
        key = load_pem_public_key(cp["publicKeyPem"].encode())
        key.verify(base64.b64decode(cp["signature"]), canon(cp["payload"]).encode())
        print("   ok   Ed25519 signature valid")
    except ImportError:
        print("   skipped: pip install cryptography to verify the signature")
    except Exception as ex:  # noqa: BLE001
        fails.append("signature invalid"); print("   FAIL signature invalid:", type(ex).__name__)

def der(b, o=0):
    tag, n, h = b[o], b[o + 1], 2
    if n & 0x80:
        k = n & 0x7F
        n, h = int.from_bytes(b[o + 2:o + 2 + k], "big"), 2 + k
    return tag, b[o + h:o + h + n], o + h + n


def der_kids(v):
    out, o = [], 0
    while o < len(v):
        tag, val, o = der(v, o)
        out.append((tag, val))
    return out


def read_tsr(b):
    ks = der_kids(der(b)[1])
    content = ks[1][1] if ks[0][0] == 0x30 else der(b)[1]
    sd = der_kids(der(der_kids(content)[1][1])[1])
    encap = der_kids(sd[2][1])
    tst = der_kids(der(der(encap[1][1])[1])[1])
    return der_kids(tst[2][1])[1][1].hex(), tst[4][1].decode()


print("\n[5] Trusted timestamps")
if not os.path.exists(os.path.join(root, "timestamps", "index.json")):
    print("   none in this bundle")
else:
    audit_hash = {}
    for line in read("audit.jsonl", "r").splitlines():
        a = json.loads(line)
        audit_hash[a["seq"]] = a["hash"]
    file_hash = {f["evidenceId"]: f["sha256"] for f in manifest["files"]}
    trust = os.path.join(root, "timestamps", "trust.pem")
    ossl = shutil.which("openssl")
    for s in json.loads(read("timestamps/index.json")):
        try:
            imprint, gen = read_tsr(read(s["file"]))
        except Exception:  # noqa: BLE001
            fails.append("unreadable timestamp " + s["file"]); print("   FAIL unreadable", s["file"]); continue
        bad = []
        if imprint != s["hash"]:
            bad.append("token was issued for a different hash")
        if s["type"] == "evidence" and s["ref"] in file_hash and file_hash[s["ref"]] != s["hash"]:
            bad.append("the original changed after it was time-stamped")
        if s["type"] == "audit_head" and audit_hash.get(int(s["ref"]), s["hash"]) != s["hash"]:
            bad.append("audit entry " + s["ref"] + " changed after it was time-stamped")
        if s["type"] == "merkle_root" and manifest.get("scope") == "whole-case" and int(s["ref"]) == len(manifest["files"]) and s["hash"] != manifest["merkleRoot"]:
            bad.append("the evidence set changed after it was time-stamped")
        sig = "authority signature not checked"
        if not bad and ossl and os.path.exists(trust):
            when = calendar.timegm(time.strptime(gen[:14], "%Y%m%d%H%M%S"))
            r = subprocess.run([ossl, "ts", "-verify", "-in", os.path.join(root, s["file"]), "-digest", s["hash"], "-CAfile", trust, "-attime", str(when)], capture_output=True, text=True)
            if r.returncode == 0:
                sig = "authority signature ok"
            else:
                bad.append("authority signature check failed: " + (r.stderr.strip().splitlines() or ["openssl error"])[-1][:120])
        label = s["type"] + " " + s["ref"] + " at " + gen[:14]
        if bad:
            fails.append("timestamp " + s["file"] + ": " + "; ".join(bad)); print("   FAIL", label, "-", "; ".join(bad))
        else:
            print("   ok  ", label, "(" + sig + ")")

print("\n" + ("VERIFIED: nothing was altered." if not fails else "NOT VERIFIED: " + "; ".join(fails)))
sys.exit(1 if fails else 0)
