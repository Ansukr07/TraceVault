// Serverless job execution. There is no always-on worker on Vercel, so work runs inside function invocations:
//  - routes that enqueue jobs call kickJobs() via the enqueue hook (runs after the response, via waitUntil)
//  - GET /cases/:id/jobs (polled by the UI while a case is open) kicks when work is pending
//  - the daily cron (routes/internal.js) is the backstop
import { waitUntil } from '@vercel/functions';
import { Runner, setEnqueueHook } from './runner.js';
import { handlers } from './pipeline.js';
import { timestampHandlers } from '../services/timestamps.js';

export const serverless = !!process.env.VERCEL;

let current = null;

export function kickJobs() {
  if (!serverless || current) return;
  const runner = new Runner({ ...handlers, ...timestampHandlers });
  current = runner
    .drain({ claimBudgetMs: Number(process.env.JOB_CLAIM_BUDGET_MS) || 150_000 })
    .catch((e) => console.error('job drain failed', e))
    .finally(() => { current = null; });
  waitUntil(current);
}

setEnqueueHook(kickJobs);
