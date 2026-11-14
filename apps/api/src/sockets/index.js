// Socket.IO namespace /cases, room case:{id} (spec §10.1). Clients authenticate with the access JWT
// and may only join rooms of cases they are members of.
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { Case } from '../models/index.js';
import { bus } from '../jobs/pipeline.js';

export function attachSockets(io) {
  const nsp = io.of('/cases');
  nsp.use((socket, next) => {
    try {
      const p = jwt.verify(socket.handshake.auth?.token ?? '', config.JWT_ACCESS_SECRET);
      socket.data.userId = p.sub;
      next();
    } catch {
      next(new Error('UNAUTHENTICATED'));
    }
  });
  nsp.on('connection', (socket) => {
    socket.on('join', async (caseId, ack) => {
      const ok =
        mongoose.isValidObjectId(caseId) && (await Case.exists({ _id: caseId, deletedAt: null, 'members.userId': socket.data.userId }));
      if (ok) socket.join(`case:${caseId}`);
      ack?.({ ok: !!ok });
    });
    socket.on('leave', (caseId) => socket.leave(`case:${caseId}`));
  });
  bus.on('case', ({ caseId, event, data }) => nsp.to(`case:${caseId}`).emit(event, { caseId, ...data }));
  return nsp;
}
