// Vercel Cron target (see vercel.json). Backstop for the on-demand job drains: picks up stuck/retrying jobs,
// retries exhausted time-stamps and anchors active cases. Vercel sends "Authorization: Bearer $CRON_SECRET".
import crypto from 'node:crypto';
import { Router } from 'express';
import { ah, httpError } from '../middleware/index.js';
import { Runner } from '../jobs/runner.js';
import { handlers } from '../jobs/pipeline.js';
import { timestampHandlers, timestampSweep } from '../services/timestamps.js';

export const internalRouter = Router();

const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

internalRouter.get(
  '/cron',
  ah(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw httpError(503, 'CRON_DISABLED', 'CRON_SECRET is not set');
    if (!safeEq(req.headers.authorization ?? '', `Bearer ${secret}`)) throw httpError(401, 'UNAUTHENTICATED', 'Bad cron credentials');
    await timestampSweep();
    await new Runner({ ...handlers, ...timestampHandlers }).drain({ claimBudgetMs: 200_000 });
    res.json({ ok: true });
  }),
);
