// Loads the lawyer-editable legal data files in data/legal/ (spec: regional-states-india-spec.md §4, §10).
// The files are read once; `catalogueSha256` goes into every regional export so a reader can tell which law table produced it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(import.meta.dirname, '../../../../../data/legal');
const FILES = ['offences', 'metros', 'crosswalk', 'procedure'];

let cache = null;

export function loadLegal({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const raw = {};
  const parsed = {};
  for (const name of FILES) {
    raw[name] = fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8');
    parsed[name] = JSON.parse(raw[name]);
  }
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  cache = {
    ...parsed,
    fileHashes: Object.fromEntries(FILES.map((n) => [n, sha(raw[n])])),
    catalogueSha256: sha(FILES.map((n) => raw[n]).join('\n')),
    catalogueVersion: parsed.offences.version,
  };
  return cache;
}

/** For tests: swap the data in memory. */
export function setLegalForTest(data) {
  cache = data;
}
