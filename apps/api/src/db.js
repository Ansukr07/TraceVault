// MongoDB connection cached across warm serverless invocations (a new connect per request would exhaust Atlas).
import mongoose from 'mongoose';
import { config } from './config.js';

let connecting;

export function connectMongo() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose);
  connecting ??= mongoose
    .connect(config.MONGO_URI, { serverSelectionTimeoutMS: 8000, maxPoolSize: 5, ...(config.MONGO_DB_NAME ? { dbName: config.MONGO_DB_NAME } : {}) })
    .catch((e) => { connecting = undefined; throw e; });
  return connecting;
}
