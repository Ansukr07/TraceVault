import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API_TARGET lets a second stack run side by side (e.g. API_TARGET=http://127.0.0.1:4100 WEB_PORT=5174).
const api = process.env.API_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': api,
      '/socket.io': { target: api, ws: true },
    },
  },
});
