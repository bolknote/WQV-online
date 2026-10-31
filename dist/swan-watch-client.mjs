import { b, concat, toHex } from './formats.mjs';
import { encodeKingsun, KingsunCounter } from './kingsun.mjs';
import { WQV12Decoder } from './wqv12-formats.mjs';
import { sleep } from './irda.mjs';
import { SwanWatchClient } from './swan-watch-core.mjs';
import { SWAN_BAUD, SWAN_PREFIX, checkSwanRecord } from './swan-watch-formats.mjs';

// SUM16 counter qualification for SWAN. A3's four bytes are a challenge,
// not necessarily a valid clock. A sender's B3 requires two valid greetings.
export class SwanKingsunStream {
  constructor(counter = null, record = () => {}) {
    this.counter = counter; this.record = record; this.pending = []; this.size = 0;
    if (!counter) this.candidates = Array.from({ length: 256 }, (_, phase) => ({ phase,
      counter: new KingsunCounter(phase), decoder: new WQV12Decoder(), greetings: 0, qualified: false }));
  }
  feed(raw) {
    if (this.counter) return this.counter.feed(raw);
    if (this.size + raw.length > 16384) throw new Error('Could not synchronize the KS-959 SWAN counter. Reconnect USB.');
    if (!raw.length) return raw;
    this.pending.push(raw.slice()); this.size += raw.length;
    for (const c of this.candidates) {
      c.decoder.feed(c.counter.feed(raw));
      for (const f of c.decoder.frames.splice(0)) {
        if (f.address === 255 && f.control === 0xa3 && f.data.length === 4) c.qualified = true;
        if (f.address === 255 && f.control === 0xb3 && !f.data.length && ++c.greetings >= 2) c.qualified = true;
      }
    }
    const qualified = this.candidates.filter(c => c.qualified);
    if (qualified.length !== 1) return b();
    this.counter = new KingsunCounter(qualified[0].phase);
    const clear = concat(...this.pending.map(part => this.counter.feed(part)));
    this.record('swan-kingsun-sync', { initialPhase: qualified[0].phase, phase: this.counter.phase, rawBytes: this.size });
    this.pending = []; this.candidates = null; return clear;
  }
}

const isKS = a => a.description?.driver === 'KingSun KS-959';
export async function prepareSwan(adapter, signal) {
  signal?.throwIfAborted();
  await adapter.pauseReader(); await adapter.setupSIR(); await adapter.setSIRSpeed(SWAN_BAUD);
  signal?.throwIfAborted(); adapter.assertOpen();
  adapter.decoder.reset(); adapter.decoder.frames.length = 0;
  // Keep the measured WQV-3 threshold. RXDSNS 6 did not eliminate errors
  // at 38400 in the adapter bench; it is not a SWAN default.
  if (!isKS(adapter)) {
    const regs = await adapter.registers(1, 9, true);
    if (regs[0] !== 0x2a || regs[1] !== 0x1d || (regs[3] & 0xf8) !== 0x20 || regs[7] !== 0x15) throw new Error('SWAN receiver settings did not match register readback.');
  }
}

function rawTransport(a, record) {
  const oldRead = a.readSIR, oldWrite = a.writeSIR;
  const stream = isKS(a) ? new SwanKingsunStream(a.stream.counter, record) : null;
  a.readSIR = async () => {
    const result = await a.io(stream ? a.device.controlTransferIn({ requestType: 'class', recipient: 'interface', request: 1, value: 0x200, index: 0 }, 2048) : a.device.transferIn(a.inEndpoint, 64), 'reading SWAN USB');
    if (result.status !== 'ok' || !result.data) throw new Error('SWAN USB read failed.');
    const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
    const clear = stream ? stream.feed(raw) : raw;
    if (raw.length) record('swan-usb-rx', { rawHex: toHex(raw), sirHex: toHex(clear), phase: stream?.counter?.phase ?? null });
    return clear;
  };
  a.writeSIR = async wire => {
    a.assertOpen();
    if (stream) {
      for (const part of encodeKingsun(wire)) {
        record('swan-usb-tx-attempt', { encodedHex: toHex(part.data), usefulBytes: part.length });
        const r = await a.io(a.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 9, value: part.length, index: 0 }, part.data), 'sending SWAN USB');
        if (r.status !== 'ok' || r.bytesWritten !== part.data.length) throw new Error('Incomplete KS-959 SWAN write.');
      }
    } else {
      const packet = concat(b(0x55, 0xaa, wire.length & 255, wire.length >>> 8), wire);
      record('swan-usb-tx-attempt', { packetHex: toHex(packet) });
      const r = await a.io(a.device.transferOut(a.outEndpoint, packet), 'sending SWAN USB');
      if (r.status !== 'ok' || r.bytesWritten !== packet.length) throw new Error('Incomplete SigmaTel SWAN write.');
      const until = performance.now() + 1000 + wire.length * 10000 / a.baud;
      let drained = false;
      while (performance.now() < until) {
        const [status] = await a.registers(5, 3, true);
        if (!(status & 0x10) || status & 4) { drained = true; break; }
        await sleep(2);
      }
      if (!drained) { await a.abortFIFO(); throw new Error('SWAN transmit FIFO did not drain.'); }
    }
    return { status: 'ok', bytesWritten: wire.length };
  };
  return () => {
    // Continue the same physical XOR stream when switching back to PC or
    // OTHERS; changing protocols does not reset the dongle's counter.
    if (stream?.counter) a.stream.counter = stream.counter;
    if (oldRead) a.readSIR = oldRead; else delete a.readSIR;
    if (oldWrite) a.writeSIR = oldWrite; else delete a.writeSIR;
  };
}

export async function transferSwan(adapter, { direction, bytes, signal, record = () => {}, progress = () => {}, durationMs, challenge } = {}) {
  if (!['receive', 'send'].includes(direction)) throw new RangeError('Unknown SWAN transfer direction.');
  if (direction === 'send') checkSwanRecord(bytes);
  signal?.throwIfAborted();
  const restore = rawTransport(adapter, record);
  try {
    // The successful KS-959 native preparation: one discovery at 9600,
    // then a bare working-rate prefix. Only done after the user's Start.
    progress('starting');
    await adapter.setSIRSpeed(9600); signal?.throwIfAborted();
    const id = crypto.getRandomValues(new Uint8Array(4));
    await adapter.sendFrame(255, 0x3f, concat(b(1), id, b(255, 255, 255, 255, 1, 0, 0)), 11, { receive: false });
    await adapter.setSIRSpeed(SWAN_BAUD); signal?.throwIfAborted();
    await adapter.writeSIR(SWAN_PREFIX); signal?.throwIfAborted();
    record('swan-ready', { baud: SWAN_BAUD });
    return await new SwanWatchClient(adapter, { signal, record, progress, challenge }).run({ direction, bytes, durationMs });
  } finally { restore(); }
}

export function swanOutcome(summary) {
  if (summary.fileCount) return summary.photoTransferComplete ? 'received' : 'received-incomplete';
  if (summary.direction === 'send') {
    if (summary.uploadOutcome === 'rejected') return 'rejected';
    if (summary.finalAccepted) return summary.photoTransferComplete ? 'accepted' : 'unconfirmed';
    if (summary.uploadOutcome === 'unconfirmed') return 'unconfirmed';
  }
  if (summary.status === 'interrupted') return 'cancelled';
  return 'error';
}
