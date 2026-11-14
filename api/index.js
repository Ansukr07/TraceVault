// Vercel serverless entrypoint: the whole Express API as one function (see vercel.json rewrites).
import { createApp } from '../apps/api/src/app.js';
import { connectMongo } from '../apps/api/src/db.js';
import '../apps/api/src/jobs/kick.js'; // registers the enqueue hook that runs background jobs after the response

let app;

export default async function handler(req, res) {
  try {
    await connectMongo();
  } catch (e) {
    console.error('mongo connect failed', e.message);
    res.status(503).json({ error: { code: 'DB_UNAVAILABLE', message: 'Database unavailable, try again shortly' } });
    return;
  }
  app ??= createApp();
  return app(req, res);
}
