import { DRIVER_ABI, DRIVER_PROFILES } from './driver-catalog.mjs';
export function compileDriver(record, { signal, progress = () => {}, WorkerClass = globalThis.Worker, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new WorkerClass(new URL('./driver-runtime/compile-worker.mjs', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve({ ...result, abi: DRIVER_ABI });
    };
    const abort = () => finish(signal.reason ?? new DOMException('Build cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Driver compilation timed out. The source is still saved.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = event => {
      if (event.data.progress) progress(event.data.progress);
      else if (event.data.error) finish(new Error(event.data.error));
      else finish(null, event.data.result);
    };
    worker.onerror = event => finish(new Error(event.message || 'The compiler worker failed.'));
    worker.postMessage({ record });
  });
}
export async function referenceDriver(id) {
  if (!DRIVER_PROFILES.some(profile => profile.id === id)) throw new Error('Unknown reference driver.');
  const base = new URL('./driver-runtime/corpus/', import.meta.url);
  const response = await fetch(new URL('sources.json', base));
  if (!response.ok) throw new Error('Cannot load the source catalogue.');
  const manifest = await response.json(), entry = manifest.files[id];
  const source = await fetch(new URL(entry.localPath, base));
  if (!source.ok) throw new Error('Cannot load the reference source.');
  return { filename: entry.path.split('/').at(-1), source: await source.text(), files: {},
    provenance: { url: entry.url, version: entry.tag || manifest.tag, sha256: entry.sha256 } };
}
