import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { scanFile } from './clamav.js';

// A tiny fake clamd: reads the INSTREAM frames and answers FOUND when the payload contains the EICAR marker.
function fakeClamd() {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
        sock.end(buf.includes('EICAR-TEST') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
      }
    });
  });
}

test('scanFile reports clean and infected files', async () => {
  const srv = fakeClamd().listen(0);
  const port = srv.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clam-'));
  try {
    const ok = path.join(dir, 'ok.txt');
    const bad = path.join(dir, 'bad.txt');
    fs.writeFileSync(ok, 'hello');
    fs.writeFileSync(bad, 'xx EICAR-TEST xx');
    assert.deepEqual(await scanFile(ok, { host: '127.0.0.1', port }), { clean: true });
    assert.deepEqual(await scanFile(bad, { host: '127.0.0.1', port }), { clean: false, signature: 'Eicar-Test-Signature' });
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreachable scanner rejects', async () => {
  await assert.rejects(scanFile(import.meta.filename, { host: '127.0.0.1', port: 1, timeoutMs: 500 }));
});
