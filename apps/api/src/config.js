import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/tracevault?replicaSet=rs0'),
  MONGO_DB_NAME: z.string().optional(), // overrides the database in MONGO_URI (e.g. a scratch DB for smoke runs)
  ML_BASE_URL: z.string().default('http://127.0.0.1:8000'),
  ML_INTERNAL_SECRET: z.string().default('change-me'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0), // proxy hops in front of the API (Vercel + host LB = 2)
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  WORKER_IN_PROCESS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  MAX_UPLOAD_MB: z.coerce.number().default(200),
  // Daily Sarvam audio cap in seconds (spec O4); beyond it new transcription jobs fall back to local. 0 disables.
  SARVAM_DAILY_AUDIO_SEC_CAP: z.coerce.number().default(7200),
  // Optional ClamAV (clamd over TCP) scan of every upload (spec V9). Unset = no scanning.
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().default(3310),
  CLAMAV_FAIL_OPEN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  MAX_FILES_PER_CASE: z.coerce.number().default(50),
  JWT_ACCESS_SECRET: z.string().min(8).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(8).default('dev-refresh-secret-change-me'),
  MASTER_KEK_BASE64: z.string().default(''),
  // Oversight dashboard: counts below this are shown as "<N" (small-number suppression). Dev default 1 so demo data shows.
  OVERSIGHT_MIN_CELL: z.coerce.number().int().min(1).default(process.env.NODE_ENV === 'production' ? 5 : 1),
  // F2 trusted timestamping. Empty TSA_PRIMARY_URL = feature off (nothing leaves the server). Only SHA-256 hashes are sent.
  TSA_PRIMARY_URL: z.string().default(''),
  TSA_FALLBACK_URL: z.string().default(''),
  TSA_TRUST_PEM_PATH: z.string().default(''),
  TIMESTAMP_ANCHOR_EVERY_N: z.coerce.number().int().min(1).default(50),
  // Skeleton-only escape hatch: run the API without MongoDB (health reports it as down).
  ALLOW_NO_DB: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const config = schema.parse(process.env);

// WEB_ORIGIN may be a comma-separated list. Outside production any localhost / 127.0.0.1 port is allowed too,
// so a second Vite instance (e.g. :5174) doesn't trip CORS.
const allowed = config.WEB_ORIGIN.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
const localDev = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export const corsOrigin = (origin, cb) => cb(null, !origin || allowed.includes(origin) || (config.NODE_ENV !== 'production' && localDev.test(origin)));

export function getKek() {
  const kek = Buffer.from(config.MASTER_KEK_BASE64, 'base64');
  if (kek.length !== 32) throw new Error('MASTER_KEK_BASE64 must be 32 bytes (run: npm run keys:generate)');
  return kek;
}
