// Public timestamp anchoring of the case Merkle root with OpenTimestamps (spec V7).
// We submit only the 32-byte root (a hash, never content) to public calendar servers and keep the returned
// proof as a standard .ots file. It starts "pending"; it becomes Bitcoin-attested after the calendar's next
// aggregation, which anyone can finish with `ots upgrade` / `ots verify` (https://opentimestamps.org).
export const CALENDARS = ['https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org'];

const MAGIC = Buffer.from('\x00OpenTimestamps\x00\x00Proof\x00\xbf\x89\xe2\xe8\x84\xe8\x92\x94', 'latin1');
const VERSION = 0x01;
const OP_SHA256 = 0x08;

/** Wraps a calendar's reply into a complete .ots file for the given 32-byte digest. */
export function buildOts(digest, fragment) {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  return Buffer.concat([MAGIC, Buffer.from([VERSION, OP_SHA256]), digest, fragment]);
}

export async function stamp(rootHex, { fetchFn = fetch, calendars = CALENDARS, timeoutMs = 15_000 } = {}) {
  const digest = Buffer.from(rootHex, 'hex');
  if (digest.length !== 32) throw new Error('root must be a 32-byte hex string');
  for (const cal of calendars) {
    try {
      const r = await fetchFn(`${cal}/digest`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.opentimestamps.v1', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: digest,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const fragment = Buffer.from(await r.arrayBuffer());
      if (fragment.length) return { calendar: cal, ots: buildOts(digest, fragment) };
    } catch { /* try the next calendar */ }
  }
  throw new Error('no timestamp calendar accepted the request');
}
