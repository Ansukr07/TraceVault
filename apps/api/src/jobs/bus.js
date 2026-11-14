import { EventEmitter } from 'node:events';

// Shared in-process event bus: job handlers publish, the Socket.IO layer relays to case rooms.
export const bus = new EventEmitter();
bus.setMaxListeners(100);
