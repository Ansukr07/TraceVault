import mongoose from 'mongoose';
import { AuditEntry } from '../models/index.js';
import { buildEntry } from './audit-chain.js';

/**
 * Append an entry to a case's chain. Serialized by the unique (caseId, seq) index:
 * a concurrent writer loses with a duplicate-key error and we retry on the new head.
 * Pass `session` to include the write in a caller's transaction.
 */
export async function audit(caseId, fields, session) {
  const id = String(caseId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const prev = await AuditEntry.findOne({ caseId: id }).sort({ seq: -1 }).session(session ?? null).lean();
    const entry = buildEntry(id, prev, { ...fields, actorId: fields.actorId && String(fields.actorId) });
    try {
      await AuditEntry.create([entry], { session });
      return entry;
    } catch (e) {
      if (e.code === 11000 && !session) continue;
      throw e;
    }
  }
  throw new Error('audit append contention');
}

/** Run fn(session) in a transaction (replica set required). */
export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}
