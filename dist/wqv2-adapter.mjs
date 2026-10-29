import { createAdapter, describeUSBDevice } from './adapters.mjs';
import { KingsunBridgeDevice } from './kingsun-bridge.mjs';
import { KingsunCounter, encodeKingsun } from './kingsun.mjs';
import { WQV12Decoder, isWQV12ClockReply } from './wqv12-formats.mjs';
import { prepareWQV12 } from './wqv12-core.mjs';

const copy = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
const hex = bytes => Array.from(bytes, v => v.toString(16).padStart(2, '0')).join('');

// WQV-2 has SUM16 rather than IrLAP CRC. A valid, uniquely decoded clock
// greeting qualifies the counter before the client can echo that clock in 93.
// Requiring an unrelated CRC frame here would deadlock the old PC handshake.
export class WQV2KingsunStream {
  constructor(onSync = () => {}, mode = 'pc') { this.onSync = onSync; this.counter = null; this.mode = mode; this.restart(); }
  setMode(mode) {
    if (!['pc', 'others'].includes(mode)) throw new RangeError('Unknown WQV-2 mode.');
    if (mode !== this.mode) { this.mode = mode; if (!this.counter) this.restart(); }
  }
  restart() {
    this.pending = []; this.pendingBytes = 0;
    this.candidates = Array.from({ length: 256 }, (_, phase) => ({ phase,
      counter: new KingsunCounter(phase), decoder: new WQV12Decoder(), qualified: false, greetings: 0 }));
  }
  feed(raw) {
    if (this.counter) return this.counter.feed(raw);
    if (!raw.length) return raw;
    if (this.pendingBytes + raw.length > 16384) this.restart();
    if (raw.length > 16384) throw new RangeError('Unexpected KS-959 receive buffer size.');
    this.pending.push(raw.slice()); this.pendingBytes += raw.length;
    for (const candidate of this.candidates) {
      candidate.decoder.feed(candidate.counter.feed(raw));
      for (const frame of candidate.decoder.frames.splice(0)) {
        if (this.mode === 'pc' && isWQV12ClockReply(frame)) candidate.qualified = true;
        if (this.mode === 'others' && frame.address === 255 && frame.control === 0xb3 && !frame.data.length) {
          candidate.greetings++;
          if (candidate.greetings >= 2) candidate.qualified = true;
        }
      }
    }
    const qualified = this.candidates.filter(candidate => candidate.qualified);
    if (qualified.length !== 1) return new Uint8Array();
    const selected = qualified[0]; this.counter = new KingsunCounter(selected.phase);
    const parts = this.pending.map(part => this.counter.feed(part));
    const clear = new Uint8Array(parts.reduce((count, part) => count + part.length, 0));
    let offset = 0; for (const part of parts) { clear.set(part, offset); offset += part.length; }
    this.onSync({ initialPhase: selected.phase, phase: this.counter.phase,
      qualification: this.mode === 'pc' ? 'unique-valid-sum16-clock' : 'two-valid-sum16-watch-greetings', rawBytes: this.pendingBytes });
    this.pending = []; this.pendingBytes = 0; this.candidates = null;
    return clear;
  }
}

export function createWQV2Adapter(device, { record = () => {}, raw = () => {}, log, update } = {}) {
  const info = describeUSBDevice(device);
  const native = info.driver === 'KingSun KS-959' ? new KingsunBridgeDevice(device) : device;
  // Keep USB payloads as binary instead of creating one JSON event per
  // received byte. Some WQV-2 replies arrive one byte per USB completion.
  const traced = new Proxy(native, { get(target, property) {
    if (property === 'transferIn') return async (...args) => {
      const result = await target.transferIn(...args);
      if (result.data?.byteLength) raw('usb-rx', copy(result.data));
      return result;
    };
    if (property === 'transferOut') return async (endpoint, data) => {
      const bytes = copy(data); raw('usb-tx-attempt', bytes);
      const result = await target.transferOut(endpoint, data);
      record('wqv2-usb-write', { status: result.status, bytesWritten: result.bytesWritten, expected: bytes.length });
      return result;
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const adapter = createAdapter(traced, { log, update, record });
  if (info.driver === 'KingSun KS-959') {
    adapter.stream = new WQV2KingsunStream(details => record('wqv2-kingsun-sync', details));
    adapter.readSIR = async () => {
      const result = await adapter.io(native.controlTransferIn({ requestType: 'class', recipient: 'interface',
        request: 1, value: 0x200, index: 0 }, 2048), 'reading USB');
      if (result.status !== 'ok' || !result.data) throw new Error('KS-959 USB reception failed.');
      const encoded = copy(result.data); if (encoded.length) raw('usb-rx', encoded);
      const clear = adapter.stream.feed(encoded); if (clear.length) raw('sir-rx', clear);
      return clear;
    };
    adapter.writeSIR = async wire => {
      adapter.assertOpen();
      for (const fragment of encodeKingsun(wire)) {
        const result = await adapter.io(native.controlTransferOut({ requestType: 'class', recipient: 'interface',
          request: 9, value: fragment.length, index: 0 }, fragment.data), 'sending USB packet');
        record('wqv2-kingsun-write', { usefulBytes: fragment.length, encodedHex: hex(fragment.data),
          status: result.status, bytesWritten: result.bytesWritten });
        if (result.status !== 'ok' || result.bytesWritten !== fragment.data.length) throw new Error('KS-959 USB write did not complete.');
      }
      return { status: 'ok', bytesWritten: wire.length };
    };
  }
  adapter.prepareWQV2 = async (signal, { mode = 'pc' } = {}) => {
    await adapter.pauseReader(); signal?.throwIfAborted();
    if (info.driver === 'SigmaTel STIr4200') {
      // Reset the idle FIFO and select the verified WQV-2 threshold each run.
      // The WQV-3 adapter's defaults are not changed.
      adapter.configured = false;
      return prepareWQV12(adapter, signal, { rxSensitivity: 6 });
    }
    adapter.stream.setMode(mode);
    await adapter.setupSIR(); await adapter.setSIRSpeed(115200); signal?.throwIfAborted();
    return { baud: 115200, driver: info.driver };
  };
  return adapter;
}
