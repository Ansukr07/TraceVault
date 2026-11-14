// Starts the ML service inside services/ml/.venv (cross-platform).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const mlDir = path.join(root, 'services', 'ml');
const win = process.platform === 'win32';
const py = path.join(mlDir, '.venv', win ? 'Scripts/python.exe' : 'bin/python');

if (!fs.existsSync(py)) {
  console.error('ML venv missing. Run: cd services/ml && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt');
  process.exit(1);
}
const p = spawn(py, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000', '--reload'], {
  cwd: mlDir,
  stdio: 'inherit',
});
p.on('exit', (c) => process.exit(c ?? 0));
