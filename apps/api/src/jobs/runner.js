import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { Schema } = mongoose;

const jobSchema = new Schema(
  {
    type: { type: String, required: true },
    caseId: Schema.Types.ObjectId,
    evidenceId: Schema.Types.ObjectId,
    key: { type: String, required: true, unique: true }, // idempotency: {evidenceId|caseId}:{step}:{generatorVersion}
    status: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued' },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 3 },
    runAt: { type: Date, default: Date.now },
    lockedBy: String,
    lockedUntil: Date,
    progress: { type: Number, default: 0 },
    payload: Schema.Types.Mixed,
    error: String,
    result: Schema.Types.Mixed,
  },
  { timestamps: true },
);
jobSchema.index({ status: 1, runAt: 1, type: 1 });
export const Job = mongoose.models.Job ?? mongoose.model('Job', jobSchema);

// Spec 3.3 concurrency per type; anything else gets the default.
export const CONCURRENCY = { ocr: 4, transcribe: 3, transcribe_local: 1, nlp: 4 };
const DEFAULT_CONCURRENCY = 8;
const LOCK_MS = 5 * 60_000;

/** Enqueue once per key. Re-enqueueing an existing key is a no-op (returns the existing job). */
export async function enqueue({ type, caseId, evidenceId, step = type, version = 1, payload, runAt = new Date() }) {
  const key = `${evidenceId ?? caseId}:${step}:${version}`;
  try {
    return await Job.findOneAndUpdate({ key }, { $setOnInsert: { type, caseId, evidenceId, key, payload, runAt } }, { upsert: true, new: true });
  } catch (e) {
    if (e.code === 11000) return Job.findOne({ key }); // lost an upsert race
    throw e;
  }
}

/**
 * Debounced case-level job: every call pushes runAt forward, so N uploads in a burst trigger one rebuild.
 * If the previous rebuild already finished or failed it is re-armed.
 */
export async function debounceCaseJob({ type, caseId, delayMs = 5000 }) {
  const key = `${caseId}:${type}:debounced`;
  const runAt = new Date(Date.now() + delayMs);
  // Don't disturb a running job: it gets re-armed (below) once it finishes.
  const pushed = await Job.findOneAndUpdate({ key, status: 'queued' }, { $set: { runAt } }, { new: true });
  if (pushed) return pushed;
  try {
    return await Job.findOneAndUpdate(
      { key, status: { $in: ['done', 'failed'] } },
      { $set: { status: 'queued', runAt, attempts: 0, error: null, lockedBy: null, lockedUntil: null } },
      { new: true, upsert: false },
    ) ?? (await Job.create({ type, caseId, key, runAt }));
  } catch (e) {
    if (e.code === 11000) return Job.findOne({ key }); // a running job exists; caller's next call re-arms
    throw e;
  }
}

export const backoffMs = (attempts) => 2 ** attempts * 5000;

export class Runner {
  /**
   * @param {Record<string, (job, ctx) => Promise<any>>} handlers  type -> handler
   * @param {{ pollMs?: number, onEvent?: (e:object)=>void }} opts
   */
  constructor(handlers, { pollMs = 1000, onEvent = () => {} } = {}) {
    this.handlers = handlers;
    this.pollMs = pollMs;
    this.onEvent = onEvent;
    this.id = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    this.active = new Map(); // type -> count
    this.caseLocks = new Set(); // case-level jobs: one per case at a time
    this.timer = null;
    this.stopped = true;
  }

  async start() {
    this.stopped = false;
    // Crash recovery: expired locks go back to the queue.
    await Job.updateMany({ status: 'running', lockedUntil: { $lt: new Date() } }, { $set: { status: 'queued', lockedBy: null, lockedUntil: null } });
    const loop = async () => {
      if (this.stopped) return;
      try {
        while (await this.tick()) { /* drain while there is capacity */ }
      } catch (e) {
        console.error('job runner tick failed', e);
      }
      this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    while ([...this.active.values()].some((n) => n > 0)) await new Promise((r) => setTimeout(r, 50));
  }

  /** Claim and launch at most one job. Returns true if one was started. */
  async tick() {
    const types = Object.keys(this.handlers).filter((t) => (this.active.get(t) ?? 0) < (CONCURRENCY[t] ?? DEFAULT_CONCURRENCY));
    if (!types.length) return false;
    const job = await Job.findOneAndUpdate(
      { status: 'queued', runAt: { $lte: new Date() }, type: { $in: types } },
      { $set: { status: 'running', lockedBy: this.id, lockedUntil: new Date(Date.now() + LOCK_MS) }, $inc: { attempts: 1 } },
      { sort: { runAt: 1 }, new: true },
    );
    if (!job) return false;
    this.active.set(job.type, (this.active.get(job.type) ?? 0) + 1);
    this.run(job).finally(() => this.active.set(job.type, this.active.get(job.type) - 1));
    return true;
  }

  async run(job) {
    const ctx = {
      progress: async (pct) => {
        await Job.updateOne({ _id: job._id }, { $set: { progress: pct, lockedUntil: new Date(Date.now() + LOCK_MS) } });
        this.onEvent({ caseId: job.caseId, evidenceId: job.evidenceId, step: job.type, status: 'running', pct });
      },
    };
    try {
      const result = await this.handlers[job.type](job, ctx);
      await Job.updateOne({ _id: job._id }, { $set: { status: 'done', progress: 100, result: result ?? null, lockedBy: null, lockedUntil: null } });
      this.onEvent({ caseId: job.caseId, evidenceId: job.evidenceId, step: job.type, status: 'done', pct: 100 });
    } catch (e) {
      const final = job.attempts >= job.maxAttempts;
      await Job.updateOne(
        { _id: job._id },
        {
          $set: {
            status: final ? 'failed' : 'queued',
            error: String(e?.message ?? e).slice(0, 1000),
            runAt: final ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
            lockedBy: null,
            lockedUntil: null,
          },
        },
      );
      // A failed step never blocks the rest of the case.
      this.onEvent({ caseId: job.caseId, evidenceId: job.evidenceId, step: job.type, status: final ? 'failed' : 'retrying', error: String(e?.message ?? e) });
    }
  }
}
