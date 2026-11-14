import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { healthRouter } from './routes/health.js';
import { authRouter, meRouter } from './routes/auth.js';
import { casesRouter } from './routes/cases.js';
import { caseEvidenceRouter, evidenceRouter } from './routes/evidence.js';
import { caseDataRouter } from './routes/case-data.js';
import { errorHandler } from './middleware/index.js';

export function createApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { directives: { 'frame-ancestors': ["'none'"] } } }));
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api/v1', healthRouter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/cases', casesRouter);
  app.use('/api/v1/cases/:id/evidence', caseEvidenceRouter);
  app.use('/api/v1/cases/:id', caseDataRouter);
  app.use('/api/v1/evidence', evidenceRouter);
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  app.use(errorHandler);
  return app;
}
