import fs from 'node:fs/promises';
import path from 'node:path';
import { fileTypeFromFile } from 'file-type';

const IMAGE = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_EXT = new Set(['mp3', 'ogg', 'opus', 'm4a', 'wav', 'webm']);

async function looksLikeText(file) {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.includes(0)) return false;
    // Must be valid UTF-8 (a multibyte char cut at the 8KB edge is tolerated).
    const s = new TextDecoder('utf-8', { fatal: false }).decode(head);
    return !s.slice(0, -3).includes('�');
  } finally {
    await fh.close();
  }
}

/**
 * Detect evidence kind from content (magic bytes), never from the extension alone.
 * Extension is only used to disambiguate formats with no magic bytes (text) or containers (webm/ogg/mp4 audio).
 * Returns { kind, mime } or null when unsupported.
 */
export async function detectEvidence(file, originalName) {
  const ext = path.extname(originalName).slice(1).toLowerCase();
  const ft = await fileTypeFromFile(file);

  if (ft) {
    if (IMAGE.has(ft.mime)) return { kind: 'image', mime: ft.mime };
    if (ft.mime === 'application/pdf') return { kind: 'pdf', mime: ft.mime };
    if (ft.mime === 'application/zip') return ext === 'zip' ? { kind: 'archive', mime: ft.mime } : null;
    if (ft.mime.startsWith('audio/')) return { kind: 'audio', mime: ft.mime };
    // Containers that may hold audio-only content (voice notes recorded in a browser or by WhatsApp).
    if (['video/webm', 'video/mp4', 'application/ogg'].includes(ft.mime) && AUDIO_EXT.has(ext)) {
      return { kind: 'audio', mime: ft.mime === 'video/webm' ? 'audio/webm' : ft.mime.replace('video/', 'audio/') };
    }
    return null;
  }

  // Telegram / Instagram JSON exports (spec I9, I10): the ML parser rejects JSON that isn't a chat.
  if (ext === 'json' && (await looksLikeText(file))) {
    const fh = await fs.open(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8').replace(/^﻿/, '').trimStart();
      if (/^[{[]/.test(head) && head.includes('"messages"')) return { kind: 'chat_export', mime: 'application/json' };
    } finally {
      await fh.close();
    }
    return null;
  }

  if ((ext === 'txt' || ext === 'eml') && (await looksLikeText(file))) {
    return ext === 'txt' ? { kind: 'chat_export', mime: 'text/plain' } : { kind: 'email', mime: 'message/rfc822' };
  }
  return null;
}
