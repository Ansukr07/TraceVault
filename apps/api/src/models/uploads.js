import mongoose from 'mongoose';

const { Schema } = mongoose;
const DAY = 24 * 60 * 60;

// Chunked uploads: serverless request bodies are capped (~4.5 MB), so large files arrive as numbered chunks,
// are parked here, then assembled and sealed on /complete. Abandoned uploads expire after a day.
const session = new Schema(
  {
    caseId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    filename: { type: String, required: true },
    size: { type: Number, required: true },
    clientSha256: { type: String, required: true },
    sourceLabel: { type: String, default: '' },
    kind: String,
    chunkSize: { type: Number, required: true },
    total: { type: Number, required: true },
    createdAt: { type: Date, default: Date.now, expires: DAY },
  },
  { versionKey: false },
);
export const UploadSession = mongoose.models.UploadSession ?? mongoose.model('UploadSession', session);

const chunk = new Schema(
  {
    uploadId: { type: Schema.Types.ObjectId, required: true },
    n: { type: Number, required: true },
    data: { type: Buffer, required: true },
    createdAt: { type: Date, default: Date.now, expires: DAY },
  },
  { versionKey: false },
);
chunk.index({ uploadId: 1, n: 1 }, { unique: true });
export const UploadChunk = mongoose.models.UploadChunk ?? mongoose.model('UploadChunk', chunk);
