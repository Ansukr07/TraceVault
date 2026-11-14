// RFC 3161 time-stamp protocol: build requests, parse and verify responses (future spec F2).
// Pure functions, no network and no database, and no dependencies beyond node:crypto.
// Only a SHA-256 hash is ever sent to a time-stamp authority (TSA), never content.
import crypto from 'node:crypto';

// ---------- minimal DER ----------
const lenBytes = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), lenBytes(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const derInt = (buf) => {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const derOid = (dotted) => {
  const n = dotted.split('.').map(Number);
  const out = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) enc.unshift((x & 0x7f) | 0x80);
    out.push(...enc);
  }
  return tlv(0x06, Buffer.from(out));
};

/** Read one TLV at `off`. Returns { tag, start, hdr, len, end, value }. */
export function readTLV(buf, off = 0) {
  if (off + 2 > buf.length) throw new Error('DER: truncated');
  const tag = buf[off];
  let len = buf[off + 1];
  let hdr = 2;
  if (len === 0x80) throw new Error('DER: indefinite length (BER) is not supported');
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || off + 2 + n > buf.length) throw new Error('DER: bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[off + 2 + i];
    hdr = 2 + n;
  }
  const end = off + hdr + len;
  if (end > buf.length) throw new Error('DER: length exceeds buffer');
  return { tag, start: off, hdr, len, end, value: buf.subarray(off + hdr, end), raw: buf.subarray(off, end) };
}

export function children(node) {
  const out = [];
  for (let o = 0; o < node.value.length; ) {
    const c = readTLV(node.value, o);
    out.push(c);
    o = c.end;
  }
  return out;
}

const oidString = (v) => {
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  for (let i = 1, acc = 0; i < v.length; i++) {
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join('.');
};
const intHex = (v) => v.toString('hex').replace(/^(00)+(?=.)/, '').toUpperCase();

const OID = {
  sha256: '2.16.840.1.101.3.4.2.1', sha384: '2.16.840.1.101.3.4.2.2', sha512: '2.16.840.1.101.3.4.2.3', sha1: '1.3.14.3.2.26',
  signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4', messageDigest: '1.2.840.113549.1.9.4',
  rsaPss: '1.2.840.113549.1.1.10', timeStamping: '1.3.6.1.5.5.7.3.8',
};
const HASH_BY_OID = { [OID.sha256]: 'sha256', [OID.sha384]: 'sha384', [OID.sha512]: 'sha512', [OID.sha1]: 'sha1' };

// ---------- request ----------
/** Build a DER TimeStampReq for a SHA-256 hash (hex). certReq=true so the TSA embeds its certificate chain. */
export function buildQuery(hashHex, nonce = crypto.randomBytes(8)) {
  if (!/^[0-9a-f]{64}$/i.test(hashHex)) throw new Error('hash must be a 64-char SHA-256 hex string');
  const imprint = seq(seq(derOid(OID.sha256), Buffer.from([0x05, 0x00])), tlv(0x04, Buffer.from(hashHex, 'hex')));
  const nonceBuf = Buffer.from(nonce);
  return { der: seq(derInt(Buffer.from([1])), imprint, derInt(nonceBuf), tlv(0x01, Buffer.from([0xff]))), nonce: nonceBuf.toString('hex') };
}

/** POST a query to a TSA. The URL comes from server config only (never user input), which prevents SSRF. */
export async function requestToken(url, hashHex, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('TSA url must be http(s)');
  const q = buildQuery(hashHex);
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: q.der, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`TSA responded HTTP ${r.status}`);
  const resp = Buffer.from(await r.arrayBuffer());
  const parsed = parseResponse(resp); // throws if rejected / malformed
  return { response: resp, nonce: q.nonce, ...parsed.summary };
}

// ---------- response ----------
const STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];

/** Parse a TimeStampResp (or a bare ContentInfo token). Returns the pieces verification needs. */
export function parseResponse(buf) {
  const top = readTLV(buf, 0);
  if (top.tag !== 0x30) throw new Error('not a DER SEQUENCE');
  const kids = children(top);
  let token;
  if (kids[0]?.tag === 0x30 && kids[0].value[0] === 0x02) {
    // TimeStampResp { PKIStatusInfo, timeStampToken }
    const st = Number(BigInt('0x' + (children(kids[0])[0].value.toString('hex') || '0')));
    if (st > 1) throw new Error(`TSA rejected the request (status ${STATUS[st] ?? st})`);
    if (!kids[1]) throw new Error('TSA response has no token');
    token = kids[1];
  } else {
    token = top; // already a ContentInfo
  }
  const [ctOid, ctBody] = children(token);
  if (oidString(ctOid.value) !== OID.signedData) throw new Error('token is not CMS SignedData');
  const sd = children(readTLV(ctBody.value, 0)); // [0] EXPLICIT SignedData
  // SignedData: version, digestAlgorithms, encapContentInfo, [0] certs?, [1] crls?, signerInfos
  const encap = sd[2];
  const [eType, eWrap] = children(encap);
  if (oidString(eType.value) !== OID.tstInfo) throw new Error('encapsulated content is not TSTInfo');
  const tstOctets = readTLV(eWrap.value, 0); // OCTET STRING holding TSTInfo DER
  const tst = readTLV(tstOctets.value, 0);
  const certsNode = sd.find((n) => n.tag === 0xa0 && n !== ctBody);
  const signerInfos = sd.at(-1);
  const t = children(tst); // version, policy, messageImprint, serial, genTime, ...
  const [alg, digest] = children(t[2]);
  const hashOid = oidString(children(alg)[0].value);
  const rest = t.slice(5);
  const nonceNode = rest.find((n) => n.tag === 0x02);
  const gen = t[4].value.toString('ascii');
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(gen);
  if (!m) throw new Error('unparseable genTime');
  const genTime = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ''}Z`);
  return {
    tstOctets: tstOctets.value,
    certs: certsNode ? children(certsNode).map((c) => c.raw) : [],
    signerInfo: children(children(signerInfos)[0]),
    summary: {
      hashAlg: HASH_BY_OID[hashOid] ?? hashOid,
      imprint: digest.value.toString('hex'),
      serial: intHex(t[3].value),
      genTime,
      nonce: nonceNode ? nonceNode.value.toString('hex').replace(/^0+(?=.)/, '') : null,
      policy: oidString(t[1].value),
    },
  };
}

const stripZeros = (h) => (h || '').toLowerCase().replace(/^0+(?=.)/, '');

/**
 * Verify a stored response against the hash it should stamp.
 *   checks: imprint equals hash, nonce (if given), CMS messageDigest, CMS signature by an embedded cert,
 *           and, when `trustPem` is supplied, a path from the signer to a trusted root.
 * Returns { ok, signatureValid, trust: 'trusted'|'untrusted'|'unchecked', genTime, serial, tsaName, errors[] }.
 * `ok` means "the token proves this hash existed at genTime, as signed by the embedded certificate".
 * Whether to trust that certificate is reported separately in `trust`.
 */
export function verifyToken(responseBytes, expectedHashHex, { nonce, trustPem } = {}) {
  const errors = [];
  let p;
  try {
    p = parseResponse(responseBytes);
  } catch (e) {
    return { ok: false, signatureValid: false, trust: 'unchecked', errors: [`malformed token: ${e.message}`] };
  }
  const s = p.summary;
  if (s.hashAlg !== 'sha256') errors.push(`unsupported imprint algorithm ${s.hashAlg}`);
  if (stripZeros(s.imprint) !== stripZeros(expectedHashHex)) errors.push('time-stamped hash does not match the record');
  if (nonce && stripZeros(s.nonce) !== stripZeros(nonce)) errors.push('nonce mismatch (response is not for this request)');

  // SignerInfo { version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature }
  const si = p.signerInfo;
  const sid = si[1];
  const digestAlg = HASH_BY_OID[oidString(children(si[2])[0].value)];
  const signedAttrs = si.find((n) => n.tag === 0xa0);
  const sigAlg = children(si.find((n, i) => i > 2 && n.tag === 0x30 && n !== signedAttrs));
  const signature = si.at(-1).value;
  let signatureValid = false;
  let signer = null;
  let tsaName = null;
  if (!digestAlg || !signedAttrs) {
    errors.push('unsupported SignerInfo');
  } else {
    const md = children(signedAttrs)
      .map((a) => children(a))
      .find((a) => oidString(a[0].value) === OID.messageDigest);
    const mdVal = md ? readTLV(children(md[1])[0].raw, 0).value : null;
    const calc = crypto.createHash(digestAlg).update(p.tstOctets).digest();
    if (!mdVal || !calc.equals(mdVal)) errors.push('CMS messageDigest does not match the time-stamp info');
    // Signature covers the DER of signedAttrs encoded as a SET (tag 0x31), per RFC 5652 5.4.
    const toVerify = Buffer.from(signedAttrs.raw);
    toVerify[0] = 0x31;
    const certs = p.certs.map((der) => { try { return new crypto.X509Certificate(der); } catch { return null; } }).filter(Boolean);
    const sidSerial = sid.tag === 0x30 ? stripZeros(intHex(children(sid)[1].value)) : null;
    const candidates = sidSerial ? certs.filter((c) => stripZeros(c.serialNumber) === sidSerial) : certs;
    const isPss = oidString(sigAlg[0].value) === OID.rsaPss;
    for (const c of candidates.length ? candidates : certs) {
      try {
        const opts = isPss ? { key: c.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO } : c.publicKey;
        if (crypto.verify(digestAlg, toVerify, opts, signature)) { signatureValid = true; signer = c; break; }
      } catch { /* try next */ }
    }
    if (!signatureValid) errors.push('CMS signature is invalid or the signer certificate is missing');
    if (signer) {
      tsaName = (/CN=([^\n]+)/.exec(signer.subject) ?? [])[1] ?? signer.subject.replace(/\n/g, ', ');
      if (signer.keyUsage && !signer.keyUsage.includes(OID.timeStamping)) errors.push('signer certificate is not valid for time stamping');
      if (new Date(signer.validFrom) > s.genTime || new Date(signer.validTo) < s.genTime) errors.push('signer certificate was not valid at the time-stamp time');
    }
  }

  let trust = 'unchecked';
  if (signer && trustPem) trust = chainTrusted(signer, p.certs, trustPem) ? 'trusted' : 'untrusted';

  return { ok: errors.length === 0, signatureValid, trust, genTime: s.genTime, serial: s.serial, tsaName, policy: s.policy, errors };
}

/** Walk signer -> issuers using embedded certs until a certificate in the trust bundle is reached. */
function chainTrusted(signer, embeddedDer, trustPem) {
  const roots = (trustPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((pem) => new crypto.X509Certificate(pem));
  const pool = embeddedDer.map((d) => { try { return new crypto.X509Certificate(d); } catch { return null; } }).filter(Boolean);
  let cur = signer;
  for (let depth = 0; depth < 6; depth++) {
    for (const r of roots) {
      if (r.fingerprint256 === cur.fingerprint256) return true;
      if (cur.checkIssued(r) && cur.verify(r.publicKey)) return true;
    }
    const parent = pool.find((c) => c.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!parent) return false;
    cur = parent;
  }
  return false;
}
