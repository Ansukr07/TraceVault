// Per-user rate limits for expensive routes (spec A4). Run after requireAuth so the key is the user, not a shared NAT IP.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const make = (limit, windowMs = 60_000) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user ? `u:${req.user._id}` : ipKeyGenerator(req.ip)),
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down and try again shortly' } }),
  });

export const uploadLimiter = make(Number(process.env.RL_UPLOAD_PER_MIN) || 60);
export const voiceLimiter = make(Number(process.env.RL_VOICE_PER_MIN) || 20); // STT / TTS / voice questions (Sarvam cost)
export const llmLimiter = make(Number(process.env.RL_LLM_PER_MIN) || 20); // Q&A and summary regeneration (LLM cost)
