import { Router } from 'express';
import mongoose from 'mongoose';
import { config } from '../config.js';

export const healthRouter = Router();

async function mlHealth() {
  try {
    const r = await fetch(`${config.ML_BASE_URL}/health`, {
      headers: { 'X-Internal-Secret': config.ML_INTERNAL_SECRET },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok ? await r.json() : { status: 'down', httpStatus: r.status };
  } catch (e) {
    return { status: 'down', error: e.cause?.code ?? e.message };
  }
}

async function dbHealth() {
  if (mongoose.connection.readyState !== 1) return { status: 'down' };
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    return { status: hello.setName ? 'ok' : 'degraded', replicaSet: hello.setName ?? null };
  } catch (e) {
    return { status: 'down', error: e.message };
  }
}

// Public: no detail. Admin detail comes with auth in a later milestone.
healthRouter.get('/health', async (_req, res) => {
  const [db, ml] = await Promise.all([dbHealth(), mlHealth()]);
  const ok = db.status === 'ok' && ml.status === 'ok';
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db: db.status, ml: ml.status });
});
