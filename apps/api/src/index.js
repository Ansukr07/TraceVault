import http from 'node:http';
import dns from 'node:dns';
import mongoose from 'mongoose';
import pino from 'pino';
import { Server as SocketServer } from 'socket.io';
import { config, corsOrigin } from './config.js';
import { createApp } from './app.js';
import { attachSockets } from './sockets/index.js';
import { Runner } from './jobs/runner.js';
import { bus, handlers } from './jobs/pipeline.js';
import { timestampHandlers, timestampSweep } from './services/timestamps.js';

// Some home/mobile-hotspot resolvers reject SRV lookups (mongodb+srv). Opt-in override.
if (process.env.DNS_SERVERS) dns.setServers(process.env.DNS_SERVERS.split(',').map((x) => x.trim()));

const log = pino({ redact: ['req.headers.authorization', 'req.headers.cookie', '*.password'] });

async function connectDb() {
  try {
    await mongoose.connect(config.MONGO_URI, { serverSelectionTimeoutMS: 5000, ...(config.MONGO_DB_NAME ? { dbName: config.MONGO_DB_NAME } : {}) });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) {
      throw new Error(
        'MongoDB is not a replica set (needed for audit-chain transactions). Fix: add "replication: replSetName: rs0" to mongod.cfg, restart, then run: mongosh --eval "rs.initiate()"',
      );
    }
    log.info({ replicaSet: hello.setName }, 'mongo connected');
    return true;
  } catch (e) {
    if (config.ALLOW_NO_DB) {
      log.warn({ err: e.message }, 'running WITHOUT database (ALLOW_NO_DB=true)');
      return false;
    }
    log.fatal({ err: e.message }, 'database check failed');
    process.exit(1);
  }
}

const dbUp = await connectDb();
const workerOnly = process.argv.includes('--worker');

let runner;
let sweepTimer;
if (dbUp && (config.WORKER_IN_PROCESS || workerOnly)) {
  runner = new Runner({ ...handlers, ...timestampHandlers }, {
    onEvent: (e) => {
      if (!e.caseId || e.step === 'timestamp_issue') return; // time-stamping is background work, not case processing
      const event = e.status === 'failed' ? 'processing.error' : 'processing.progress';
      bus.emit('case', { caseId: String(e.caseId), event, data: { evidenceId: e.evidenceId ? String(e.evidenceId) : null, step: e.step, status: e.status, pct: e.pct, error: e.error } });
    },
  });
  await runner.start();
  // F2 maintenance: retry exhausted time-stamps, anchor active cases daily. No-op when no TSA is configured.
  sweepTimer = setInterval(() => timestampSweep().catch((e) => log.warn({ err: e.message }, 'timestamp sweep failed')), 15 * 60_000);
  log.info({ id: runner.id }, 'job runner started');
}

if (!workerOnly) {
  const app = createApp();
  const server = http.createServer(app);
  const io = new SocketServer(server, { cors: { origin: corsOrigin, credentials: true } });
  attachSockets(io);
  server.listen(config.PORT, () => log.info(`api listening on :${config.PORT}`));
}

const shutdown = async () => {
  clearInterval(sweepTimer);
  await runner?.stop();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
