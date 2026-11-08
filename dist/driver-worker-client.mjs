export class DriverWorkerClient {
  constructor(backend, { data = () => {}, event = () => {}, WorkerClass = globalThis.Worker } = {}) {
    this.backend = backend; this.data = data; this.event = event; this.WorkerClass = WorkerClass; this.pending = new Map(); this.sequence = 0;
  }
  async load(bytes, profile) {
    if (typeof WebAssembly.Suspending !== 'function') throw new Error('This browser cannot run C drivers. Use a current Chromium browser with WebAssembly JSPI.');
    this.worker = new this.WorkerClass(new URL('./driver-runtime/device-worker.mjs', import.meta.url), { type: 'module' });
    this.worker.onmessage = async ({ data }) => {
      if (data.usb) {
        try {
          const method = data.usb.method;
          if (!['open', 'control', 'rpc', 'cancel', 'close'].includes(method)) throw new Error('Unsupported runtime USB request.');
          const result = await this.backend[method](...(data.usb.args ?? []));
          this.worker?.postMessage({ usbReply: data.usb.id, result });
        } catch (error) { this.worker?.postMessage({ usbReply: data.usb.id, error: error.message }); }
      } else if (data.bytes) this.data(new Uint8Array(data.bytes), data.packet);
      else if (data.event) this.event(data.event);
      else if (data.reply) {
        const task = this.pending.get(data.reply); if (!task) return;
        this.pending.delete(data.reply); clearTimeout(task.timer);
        data.error ? task.reject(new Error(data.error)) : task.resolve(data.result);
      }
    };
    this.worker.onerror = error => { void this.abort(new Error(error.message || 'The driver worker stopped.')).catch(() => {}); };
    await this.call('load', [new Uint8Array(bytes).slice(), profile]);
  }
  call(method, args = [], timeout = 6000) {
    if (!this.worker) return Promise.reject(new DOMException('Driver is closed.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Driver operation timed out: ' + method);
        this.pending.delete(id); reject(error); void this.abort(error).catch(() => {});
      }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, method, args });
    });
  }
  open() { return this.call('open'); }
  speed(baud) { return this.call('speed', [baud]); }
  send(bytes) { return this.call('send', [bytes], 10000); }
  abort(error = new DOMException('Driver operation cancelled.', 'AbortError')) {
    const worker = this.worker; this.worker = null; worker?.terminate();
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(error); }
    this.pending.clear();
    // Concurrent abort/close callers share cleanup. Background handlers may
    // observe the rejection, but close() must still receive its actual result.
    if (!this.cleanupTask) this.cleanupTask = Promise.resolve().then(() => this.backend.close()).catch(error => {
      this.cleanupError = error; this.event({ kind: 'usb-cleanup-failed', message: error.message }); throw error;
    });
    return this.cleanupTask;
  }
  async close() {
    let driverError;
    try {
      if (this.worker) {
        this.backend.prepareClose?.();
        await this.call('close', [], 4000);
      }
    } catch (error) { driverError = error; }
    try { await this.abort(); }
    catch (error) {
      if (driverError && driverError !== error) throw new AggregateError([driverError, error], driverError.message + '; USB cleanup failed: ' + error.message);
      throw error;
    }
    if (driverError) throw driverError;
  }
}
