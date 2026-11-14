// Optional ClamAV scan on upload (spec V9). Talks to clamd over TCP (INSTREAM). Off unless CLAMAV_HOST is set;
// when on, an unreachable scanner fails closed (the upload is refused) unless CLAMAV_FAIL_OPEN=true.
import fs from 'node:fs';
import net from 'node:net';
import { config } from '../config.js';

export const clamEnabled = () => !!config.CLAMAV_HOST;

export function scanFile(file, { host = config.CLAMAV_HOST, port = config.CLAMAV_PORT, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let out = '';
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(timeoutMs, () => fail(new Error('clamd timed out')));
    sock.on('error', fail);
    sock.on('data', (d) => { out += d; });
    sock.on('end', () => {
      const m = /stream:\s*(.*?)\s*(FOUND|OK|ERROR)\s*\0?$/.exec(out.replace(/\0/g, ''));
      if (!m) return reject(new Error(`unexpected clamd reply: ${out.slice(0, 80)}`));
      if (m[2] === 'OK') return resolve({ clean: true });
      if (m[2] === 'FOUND') return resolve({ clean: false, signature: m[1] });
      reject(new Error(`clamd error: ${m[1]}`));
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      const rs = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
      rs.on('data', (chunk) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      });
      rs.on('end', () => sock.write(Buffer.alloc(4))); // zero-length chunk terminates the stream
      rs.on('error', fail);
    });
  });
}
