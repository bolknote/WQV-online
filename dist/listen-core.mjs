import { FrameDecoder, sleep } from './irda.mjs';
import { toHex } from './formats.mjs';

export const LISTEN_RATES = Object.freeze([9600, 38400, 115200]);
export const LISTEN_MODES = Object.freeze(['watch-send', 'others-send', 'others-receive', 'swan-send', 'swan-receive', 'background']);

export function listenSettings({ baud, watchMode, durationMs }) {
  if (!LISTEN_RATES.includes(baud)) throw new RangeError('Invalid listening speed.');
  if (!LISTEN_MODES.includes(watchMode)) throw new RangeError('Invalid watch mode.');
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) {
    throw new RangeError('The capture window must be between 2 and 120 seconds.');
  }
  return { baud, watchMode, durationMs };
}

// Prepare the receiver before the user activates SEND or RECEIVE on the watch.
// Read bulk IN directly: the normal half-duplex reader stops at a poll/final
// frame, whereas a passive recording must keep reading without replying.
export async function listen(adapter, settings, { signal, record = () => {} } = {}) {
  const { baud, watchMode, durationMs } = listenSettings(settings);
  signal?.throwIfAborted();
  adapter.assertOpen();
  if (!adapter.configured || adapter.baud !== baud || adapter.readerTask) {
    throw new Error('Prepare a receiver at the selected speed before listening.');
  }
  const decoder = new FrameDecoder(); // Strict CRC only; never repair the evidence.
  adapter.decoder = decoder;
  const counters = { rxBytes: 0, readCount: 0, emptyReads: 0, validFrames: 0, badCRC: 0, txFrames: 0, recoveredFrames: 0 };
  adapter.passiveStats = counters;
  const started = performance.now();
  let reason, finish;
  const ended = new Promise(resolve => { finish = cause => { reason ??= cause; resolve({ ended: true }); }; });
  const onAbort = () => finish('interrupted');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => finish('deadline'), durationMs);
  record('listen-start', { baud, watchMode, durationMs, decoder: 'irda-crc-strict', transmitting: false });
  let error = null;
  try {
    while (!reason) {
      adapter.assertOpen();
      // Keep a rejection handler on an outstanding read after Stop/deadline.
      // The caller closes USB to cancel it; captureUSB still records its result.
      const read = adapter.device.transferIn(adapter.inEndpoint, 64).then(
        result => ({ result }), error => ({ error }));
      const outcome = await Promise.race([read, ended]);
      if (outcome.ended) break;
      if (outcome.error) throw outcome.error;
      const { result } = outcome;
      if (result.status !== 'ok' || !result.data) throw new Error(`USB IN: ${result.status}, missing or failed data buffer.`);
      const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      counters.readCount++;
      counters.rxBytes += bytes.length; adapter.rxBytes += bytes.length;
      if (!bytes.length) counters.emptyReads++;
      decoder.feed(bytes);
      counters.badCRC = decoder.badCRC;
      while (decoder.frames.length) {
        const frame = decoder.frames.shift(); counters.validFrames++;
        record('rx-frame', { address: frame.address, control: frame.control, dataHex: toHex(frame.data),
          phase: 'listen', baud, decoder: 'irda-crc-strict', recovered: false });
      }
      // Zero-length USB completions are saved, but cannot complete a frame.
      // Prevent empty completions from spinning; data-bearing reads continue
      // immediately so capture does not add gaps to the receiver's FIFO drain.
      if (!bytes.length) await Promise.race([sleep(2), ended]);
    }
  } catch (caught) {
    if (!reason) { reason = signal?.aborted ? 'interrupted' : 'error'; error = { name: caught.name, message: caught.message }; }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
  }
  const result = {
    status: reason === 'interrupted' ? 'interrupted' : reason === 'error' ? 'error' : counters.rxBytes ? 'captured' : 'no-data',
    baud, watchMode, durationMs, elapsedMs: performance.now() - started, ...counters,
    partialBodyHex: toHex(decoder.body ?? []), error,
  };
  record('listen-finished', result);
  return result;
}
