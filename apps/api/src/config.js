import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  MONGO_URI: z.string().default('mongodb://127.0.0.1:27017/tracevault?replicaSet=rs0'),
  MONGO_DB_NAME: z.string().optional(), // overrides the database in MONGO_URI (e.g. a scratch DB for smoke runs)
  ML_BASE_URL: z.string().default('http://127.0.0.1:8000'),
  ML_INTERNAL_SECRET: z.string().default('change-me'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  WORKER_IN_PROCESS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  MAX_UPLOAD_MB: z.coerce.number().default(200),
  MAX_FILES_PER_CASE: z.coerce.number().default(50),
  JWT_ACCESS_SECRET: z.string().min(8).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(8).default('dev-refresh-secret-change-me'),
  MASTER_KEK_BASE64: z.string().default(''),
  // Skeleton-only escape hatch: run the API without MongoDB (health reports it as down).
  ALLOW_NO_DB: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const config = schema.parse(process.env);

export function getKek() {
  const kek = Buffer.from(config.MASTER_KEK_BASE64, 'base64');
  if (kek.length !== 32) throw new Error('MASTER_KEK_BASE64 must be 32 bytes (run: npm run keys:generate)');
  return kek;
}
