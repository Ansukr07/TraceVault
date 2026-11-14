import http from 'node:http';
import mongoose from 'mongoose';
import pino from 'pino';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { attachSockets } from './sockets/index.js';
import { Runner } from './jobs/runner.js';
import { bus, handlers } from './jobs/pipeline.js';

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
if (dbUp && (config.WORKER_IN_PROCESS || workerOnly)) {
  runner = new Runner(handlers, {
    onEvent: (e) => {
      if (!e.caseId) return;
      const event = e.status === 'failed' ? 'processing.error' : 'processing.progress';
      bus.emit('case', { caseId: String(e.caseId), event, data: { evidenceId: e.evidenceId ? String(e.evidenceId) : null, step: e.step, status: e.status, pct: e.pct, error: e.error } });
    },
  });
  await runner.start();
  log.info({ id: runner.id }, 'job runner started');
}

if (!workerOnly) {
  const app = createApp();
  const server = http.createServer(app);
  const io = new SocketServer(server, { cors: { origin: config.WEB_ORIGIN, credentials: true } });
  attachSockets(io);
  server.listen(config.PORT, () => log.info(`api listening on :${config.PORT}`));
}

const shutdown = async () => {
  await runner?.stop();
  await mongoose.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
