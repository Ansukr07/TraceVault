export function hashFile(file: File, onProgress?: (p: number) => void): Promise<string> {
  const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      if (e.data.progress !== undefined) onProgress?.(e.data.progress);
      else if (e.data.error) { worker.terminate(); reject(new Error(e.data.error)); }
      else { worker.terminate(); resolve(e.data.sha256); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
    worker.postMessage({ id, file });
  });
}
