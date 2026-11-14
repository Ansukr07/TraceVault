import { createSHA256 } from 'hash-wasm';

// Streaming SHA-256 so 200 MB files never sit in memory at once.
self.onmessage = async (e: MessageEvent<{ id: string; file: File }>) => {
  const { id, file } = e.data;
  try {
    const hasher = await createSHA256();
    const reader = file.stream().getReader();
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      hasher.update(value);
      done += value.length;
      self.postMessage({ id, progress: done / (file.size || 1) });
    }
    self.postMessage({ id, sha256: hasher.digest('hex') });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
