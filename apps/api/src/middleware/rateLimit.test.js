import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.RL_LLM_PER_MIN = '3';
const { llmLimiter } = await import('./rateLimit.js');

test('llm limiter is per user and returns RATE_LIMITED', async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { _id: req.headers['x-user'] }; next(); });
  app.post('/ask', llmLimiter, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const hit = (u) => fetch(`http://127.0.0.1:${server.address().port}/ask`, { method: 'POST', headers: { 'x-user': u } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await hit('a')).status, 200);
    const blocked = await hit('a');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
    assert.equal((await hit('b')).status, 200, 'another user is unaffected');
  } finally {
    server.close();
  }
});
