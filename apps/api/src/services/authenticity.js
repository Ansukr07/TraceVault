// Authenticity indicators for one evidence item (future spec F1). Indicators only: never a verdict.
// Images go through the ML service (ELA heatmap + metadata checks). Other kinds get the metadata red flags the
// extractor already recorded. Results depend only on the bytes, so they are cached by SHA-256.
import { mlMultipart } from './ml-client.js';
import { readPlain } from './evidence-store.js';

const DISCLAIMER = 'Indicators only. This is not a forensic conclusion and does not prove a file is genuine or altered.';
const cache = new Map();
const CACHE_MAX = 64;

const band = (r) => (r >= 60 ? 'high' : r >= 30 ? 'medium' : 'low');

/** Metadata-only result for non-image files (PDF, email, chat export) from the flags recorded at extraction. */
export function fromFlags(e) {
  let risk = 0;
  const checks = [];
  for (const f of e.flags ?? []) {
    if (f.type === 'EDITED_FILE') {
      risk += 60;
      checks.push({ id: 'editing_software', status: 'fail', title: 'Editing software recorded', summary: `The file's metadata names ${f.value}, which edits or re-saves files.` });
    } else if (f.type === 'METADATA_MISMATCH') {
      risk += 20;
      checks.push({ id: 'timestamps', status: 'warn', title: 'Metadata dates differ', summary: f.value });
    }
  }
  if (!checks.length) checks.push({ id: 'metadata', status: 'pass', title: 'Metadata', summary: 'No editing-software signature or date conflict found in the file metadata.' });
  risk = Math.min(100, risk);
  return { riskIndicator: risk, band: band(risk), checks, regions: [], heatmap: null, disclaimer: DISCLAIMER, generator: { name: 'authenticity-metadata', version: '0.1', provider: 'local' } };
}

/** Returns { authenticity, computed } for one evidence document. */
export async function authenticityFor(e) {
  const hit = cache.get(e.sha256);
  if (hit) return { authenticity: hit, computed: false };
  let out;
  if (e.kind === 'image') {
    out = await mlMultipart('/authenticity/image', { file: await readPlain(e), filename: e.filename }, { timeoutMs: 120_000 });
  } else {
    out = fromFlags(e);
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(e.sha256, out);
  return { authenticity: out, computed: true };
}
