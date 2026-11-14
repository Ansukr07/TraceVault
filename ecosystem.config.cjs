// pm2 process file for a demo / production box: `pm2 start ecosystem.config.cjs` (spec section 13.3).
// Runs the same three processes as `npm run dev`, restarting any that crash. MongoDB runs separately.
const path = require('node:path');
const win = process.platform === 'win32';
const py = path.join(__dirname, 'services', 'ml', '.venv', win ? 'Scripts/python.exe' : 'bin/python');

module.exports = {
  apps: [
    {
      name: 'tv-api',
      cwd: __dirname,
      script: 'apps/api/src/index.js',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production', WORKER_IN_PROCESS: 'true' },
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      name: 'tv-ml',
      cwd: path.join(__dirname, 'services', 'ml'),
      script: py,
      args: '-m uvicorn app.main:app --host 127.0.0.1 --port 8000',
      interpreter: 'none',
      max_restarts: 20,
      restart_delay: 2000,
    },
    {
      // Static build of the SPA served by Vite preview; run `npm run build -w apps/web` first.
      name: 'tv-web',
      cwd: path.join(__dirname, 'apps', 'web'),
      script: 'npx',
      args: 'vite preview --host 0.0.0.0 --port 5173',
      interpreter: 'none',
    },
  ],
};
