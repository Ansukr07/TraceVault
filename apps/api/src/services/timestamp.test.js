import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOts, stamp } from './timestamp.js';

const root = 'ab'.repeat(32);

test('stamp wraps the calendar reply in a valid .ots container', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(url);
    if (url.startsWith('https://down')) return { ok: false };
    assert.equal(opts.body.length, 32, 'only the 32-byte root is sent');
    return { ok: true, arrayBuffer: async () => Uint8Array.from([0xf0, 0x04, 1, 2, 3, 4]).buffer };
  };
  const r = await stamp(root, { fetchFn, calendars: ['https://down.example', 'https://cal.example'] });
  assert.equal(r.calendar, 'https://cal.example');
  assert.equal(calls.length, 2, 'falls through to the next calendar');
  assert.ok(r.ots.subarray(0, 16).equals(Buffer.from('\x00OpenTimestamps\x00', 'latin1')));
  assert.equal(r.ots.subarray(31, 33).toString('hex'), '0108'); // version 1, sha256 op
  assert.equal(r.ots.subarray(33, 65).toString('hex'), root);
  assert.equal(r.ots.subarray(65).toString('hex'), 'f004' + '01020304');
});

test('stamp fails clearly when no calendar answers, and rejects bad roots', async () => {
  await assert.rejects(stamp(root, { fetchFn: async () => ({ ok: false }), calendars: ['https://x'] }), /no timestamp calendar/);
  await assert.rejects(stamp('abcd'), /32-byte/);
  assert.throws(() => buildOts(Buffer.alloc(3), Buffer.alloc(1)));
});
