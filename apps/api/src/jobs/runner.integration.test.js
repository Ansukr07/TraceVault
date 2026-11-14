// Needs a MongoDB (Atlas ok). Skipped when unreachable. Uses a throwaway database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Job, Runner, backoffMs, debounceCaseJob, enqueue } from './runner.js';

const base = process.env.MONGO_TEST_URI ?? process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
let skip = false;
const oid = () => new mongoose.Types.ObjectId();
const until = async (fn, ms = 8000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};

before(async () => {
  try {
    await mongoose.connect(base, { dbName: `tracevault_jobs_${Date.now()}`, serverSelectionTimeoutMS: 2500 });
    await Job.init();
  } catch (e) {
    skip = e.message;
  }
});
after(async () => {
  if (!skip) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('backoff doubles from 10s', () => {
  assert.deepEqual([1, 2, 3].map(backoffMs), [10000, 20000, 40000]);
});

test('enqueue is idempotent per key', async (t) => {
  if (skip) return t.skip(skip);
  const evidenceId = oid();
  const a = await enqueue({ type: 'ocr', evidenceId });
  const b = await enqueue({ type: 'ocr', evidenceId });
  assert.equal(String(a._id), String(b._id));
  assert.equal(await Job.countDocuments({ evidenceId }), 1);
  await enqueue({ type: 'ocr', evidenceId, version: 2 }); // new generator version => new job
  assert.equal(await Job.countDocuments({ evidenceId }), 2);
});

test('runs a job, records result and emits events', async (t) => {
  if (skip) return t.skip(skip);
  const events = [];
  const r = new Runner({ hello: async (_j, ctx) => { await ctx.progress(50); return { ok: 1 }; } }, { pollMs: 30, onEvent: (e) => events.push(e) });
  const job = await enqueue({ type: 'hello', evidenceId: oid() });
  await r.start();
  assert.ok(await until(async () => (await Job.findById(job._id)).status === 'done'));
  await r.stop();
  const done = await Job.findById(job._id);
  assert.deepEqual(done.result, { ok: 1 });
  assert.deepEqual(events.map((e) => e.status), ['running', 'done']);
});

test('failure retries with backoff, then marks failed after maxAttempts; others unaffected', async (t) => {
  if (skip) return t.skip(skip);
  const r = new Runner({ boom: async () => { throw new Error('nope'); }, fine: async () => 'ok' }, { pollMs: 30 });
  const bad = await enqueue({ type: 'boom', evidenceId: oid() });
  const good = await enqueue({ type: 'fine', evidenceId: oid() });
  await r.start();
  assert.ok(await until(async () => (await Job.findById(good._id)).status === 'done'));
  assert.ok(await until(async () => (await Job.findById(bad._id)).attempts === 1));
  let j = await Job.findById(bad._id);
  assert.equal(j.status, 'queued');
  assert.ok(j.runAt.getTime() > Date.now() + 5000, 'backed off');
  // Skip the wait: pretend backoff elapsed for the remaining attempts.
  for (let i = 0; i < 2; i++) {
    await Job.updateOne({ _id: bad._id }, { runAt: new Date() });
    await until(async () => (await Job.findById(bad._id)).attempts === i + 2);
  }
  assert.ok(await until(async () => (await Job.findById(bad._id)).status === 'failed'));
  await r.stop();
  j = await Job.findById(bad._id);
  assert.equal(j.attempts, 3);
  assert.equal(j.error, 'nope');
});

test('per-type concurrency cap is respected', async (t) => {
  if (skip) return t.skip(skip);
  let running = 0, peak = 0;
  const r = new Runner({ transcribe_local: async () => { running++; peak = Math.max(peak, running); await new Promise((x) => setTimeout(x, 150)); running--; } }, { pollMs: 20 });
  const jobs = await Promise.all([1, 2, 3].map(() => enqueue({ type: 'transcribe_local', evidenceId: oid() })));
  await r.start();
  assert.ok(await until(async () => (await Job.countDocuments({ _id: { $in: jobs.map((j) => j._id) }, status: 'done' })) === 3));
  await r.stop();
  assert.equal(peak, 1); // transcribe_local: 1
});

test('debounce: a burst of calls yields one job whose runAt keeps moving forward', async (t) => {
  if (skip) return t.skip(skip);
  const caseId = oid();
  const first = await debounceCaseJob({ type: 'case_rebuild', caseId, delayMs: 1000 });
  await new Promise((r) => setTimeout(r, 30));
  const second = await debounceCaseJob({ type: 'case_rebuild', caseId, delayMs: 1000 });
  assert.equal(String(first._id), String(second._id));
  assert.ok(second.runAt > first.runAt);
  assert.equal(await Job.countDocuments({ caseId }), 1);
  // After it finishes, a later call re-arms the same job rather than creating a second one.
  await Job.updateOne({ _id: first._id }, { status: 'done' });
  const third = await debounceCaseJob({ type: 'case_rebuild', caseId, delayMs: 1000 });
  assert.equal(String(third._id), String(first._id));
  assert.equal(third.status, 'queued');
});

test('crash recovery requeues expired running jobs on start', async (t) => {
  if (skip) return t.skip(skip);
  const j = await Job.create({ type: 'ghost', key: `x:${Date.now()}`, status: 'running', lockedBy: 'dead', lockedUntil: new Date(Date.now() - 1000), attempts: 1 });
  const r = new Runner({}, { pollMs: 1000 });
  await r.start();
  await r.stop();
  assert.equal((await Job.findById(j._id)).status, 'queued');
});
