import { tr, LocalizedError } from './i18n.mjs';
// IrDA SIR framing and Casio discovery, ported from the tested wqv_usb.py.
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// IrLAP PI 0x01 is a little-endian bit set. Discovery always uses 9600;
// connected peers use the fastest rate in the intersection of their offers.
export const SIR_RATES = Object.freeze([9600, 19200, 38400, 57600, 115200]);
export function baudMask(maximum) {
  if (!SIR_RATES.includes(maximum)) throw new RangeError('Unsupported SIR speed: ' + maximum);
  return SIR_RATES.reduce((bits, rate, index) => bits | (rate <= maximum ? 2 << index : 0), 0);
}
export function peerBaudRates(parameters) {
  let rates = null;
  for (let offset = 0; offset < parameters.length;) {
    if (offset + 2 > parameters.length) throw new LocalizedError(tr('Truncated IrLAP connection parameters.'));
    const kind = parameters[offset++], size = parameters[offset++];
    if (!size || offset + size > parameters.length) throw new LocalizedError(tr('Truncated IrLAP connection parameters.'));
    if (kind === 1) {
      if (rates !== null || size > 2) throw new LocalizedError(tr('Invalid IrLAP baud-rate parameter.'));
      rates = parameters[offset] | (size === 2 ? parameters[offset + 1] << 8 : 0);
    }
    offset += size;
  }
  if (!rates) throw new LocalizedError(tr('The watch did not provide any IrLAP baud rates.'));
  return rates;
}
export function selectBaudRate(parameters, localRates) {
  const peerRates = peerBaudRates(parameters), commonRates = peerRates & localRates & 0x3e;
  const baud = SIR_RATES.findLast((_, index) => commonRates & (2 << index));
  if (!baud) throw new LocalizedError(tr('No common IrLAP baud rate.'));
  return { baud, commonRates, peerRates };
}
export function linkParameters(rates, secondary = false) {
  return Uint8Array.of(1, 1, rates, 0x82, 1, 1, 0x83, 1, 0x3f, 0x84, 1, 0x0f,
    0x85, 1, 0x80, 0x86, 2, 0x80, 3, 8, 1, secondary ? 4 : 7);
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x8408 : 0);
  }
  return crc ^ 0xffff;
}

export function encodeFrame(address, control, data = new Uint8Array(), bof = 11) {
  const body = Uint8Array.of(address, control, ...data);
  const crc = crc16(body);
  const wire = Array(bof).fill(0xc0);
  for (const byte of [...body, crc & 255, crc >>> 8]) {
    if ([0xc0, 0xc1, 0x7d].includes(byte)) wire.push(0x7d, byte ^ 0x20);
    else wire.push(byte);
  }
  return Uint8Array.of(...wire, 0xc1);
}

export class FrameDecoder {
  constructor({ recoverFrames = false, recoverBOF = false } = {}) {
    this.recoverFrames = recoverFrames; this.recoverBOF = recoverBOF;
    this.badCRC = 0; this.recoveredFrames = 0; this.recoveredBOF = 0; this.rejectedBOF = 0; this.frames = [];
    this.reset();
  }
  reset() { this.body = null; this.escaped = false; this.pad5Escapes = []; this.emptyReads = 0; this.bofCandidate = false; }
  valid(body) {
    return body.length >= 4 && crc16(body.slice(0, -2)) === (body.at(-2) | (body.at(-1) << 8));
  }
  recover(body, { trailingOnly = false } = {}) {
    // PAD-5 stirusb.sys 1.23: SIR escapes at 0x133e4 and CRC retry at
    // 0x1367e. Its receive-slot flag is unavailable here, so check
    // both edges after an EOF. An idle completion supplies the flag's meaning:
    // only the trailing byte may be a damaged EOF. Reject ambiguous candidates.
    const variants = [body], candidates = new Map();
    if (this.pad5Escapes.length) {
      const alternate = body.slice();
      for (const [offset, byte] of this.pad5Escapes) alternate[offset] = byte;
      variants.push(alternate);
    }
    const check = candidate => {
      if (this.valid(candidate)) candidates.set(hex(candidate), candidate);
    };
    for (const variant of variants) {
      if (variant !== body) check(variant);
      if (variant.length >= 5) {
        if (!trailingOnly) check(variant.slice(1));
        check(variant.slice(0, -1));
      }
    }
    return candidates.size === 1 ? candidates.values().next().value : null;
  }
  finishFrame({ missingEOF = false } = {}) {
    if (this.bofCandidate) {
      // Observed WQV IAS replies: E0/81 [unchanged body + valid FCS] C1.
      // These are only candidates outside an existing frame. Require a real
      // EOF and the original CRC; never combine this with edge-byte removal,
      // alternative escapes, or idle completion. Raw USB bytes stay intact.
      if (!missingEOF && this.body?.length >= 4 && !this.escaped && this.valid(this.body)) {
        const body = this.body;
        this.frames.push({ address: body[0], control: body[1], data: Uint8Array.from(body.slice(2, -2)) });
        this.recoveredFrames++; this.recoveredBOF++;
      } else if (this.body?.length >= 4) this.rejectedBOF++;
      this.reset(); return;
    }
    if (this.body?.length >= 4 && !this.escaped) {
      let body = this.body;
      const badCRC = !this.valid(body);
      if (badCRC) {
        body = this.recoverFrames ? this.recover(body, { trailingOnly: missingEOF }) : null;
        if (!body) this.badCRC++;
      }
      if (body) {
        if (badCRC || missingEOF) this.recoveredFrames++;
        this.frames.push({ address: body[0], control: body[1], data: Uint8Array.from(body.slice(2, -2)) });
      }
    }
    this.reset();
  }
  emptyRead(requiredReads) {
    // PAD-5 0x132d0 / 0x132fa: completion inside SIR data, not after a
    // dangling escape or BOF. The transport supplies the revision/rate rule.
    // Only successful zero-length reads qualify, never a timeout or cancel.
    if (!this.recoverFrames || !requiredReads || !this.body?.length || this.escaped || this.bofCandidate) return;
    if (++this.emptyReads >= requiredReads) this.finishFrame({ missingEOF: true });
  }
  feed(bytes) {
    if (bytes.length) this.emptyReads = 0;
    for (let byte of bytes) {
      if (byte === 0xc0) { this.reset(); this.body = []; continue; }
      if (this.body === null) {
        if (this.recoverFrames && this.recoverBOF && (byte === 0xe0 || byte === 0x81)) {
          this.reset(); this.body = []; this.bofCandidate = true;
        }
        continue;
      }
      if (byte === 0xc1) {
        this.finishFrame(); continue;
      }
      if (this.escaped) {
        if (this.recoverFrames && (byte === 0xf0 || byte === 0xf8)) this.pad5Escapes.push([this.body.length, byte === 0xf0 ? 0xc0 : 0xc1]);
        byte ^= 0x20; this.escaped = false;
      }
      else if (byte === 0x7d) { this.escaped = true; continue; }
      this.body.push(byte);
      if (this.body.length > 4096) this.reset();
    }
  }
}

export function identifyWatch(frame, source) {
  const p = frame.data;
  if (frame.address !== 0xfe || frame.control !== 0xbf || p.length < 15 || p[0] !== 1) return null;
  if (!source.every((byte, i) => byte === p[5 + i])) return null;
  const name = new TextDecoder('ascii').decode(p.subarray(15));
  if (name === 'CASIO WIC 2411/IR') return { model: 'Casio WQV-3', module: 2411, peerId: hex(p.subarray(1, 5)) };
  if (name === 'CASIO WIC 2412/IR') return { model: 'Casio WQV-10', module: 2412, peerId: hex(p.subarray(1, 5)) };
  return null;
}

export async function discover(adapter, { signal, seconds = 10, progress = () => {} } = {}) {
  if (!(seconds > 0 && seconds <= 30)) throw new LocalizedError(tr("Discovery must take between 1 and 30 seconds."));
  const source = crypto.getRandomValues(new Uint8Array(4)).map(b => b & 0x3e);
  adapter.log('info', tr("New discovery request: {0}", hex(source)));
  const deadline = performance.now() + seconds * 1000;
  const check = () => {
    signal?.throwIfAborted();
    if (adapter.readError) throw adapter.readError;
    adapter.assertOpen();
  };
  const inspect = () => {
    while (adapter.decoder.frames.length) {
      const frame = adapter.decoder.frames.shift();
      adapter.log('rx', `IrDA ${hex([frame.address, frame.control])} · ${hex(frame.data)}`);
      const watch = identifyWatch(frame, source);
      if (watch) return watch;
    }
    return null;
  };
  try {
    while (performance.now() < deadline) {
      for (let slot = 0; slot < 6 && performance.now() < deadline; slot++) {
        check();
        const found = inspect();
        if (found) return found;
        const data = Uint8Array.of(1, ...source, 255, 255, 255, 255, 1, slot, 0);
        await adapter.sendFrame(0xff, 0x3f, data);
        const until = Math.min(deadline, performance.now() + 100);
        do {
          check();
          const watch = inspect();
          if (watch) return watch;
          // A frame arriving at 9600 bit/s may span several USB packets.
          if (adapter.decoder.body?.length) {
            const partialUntil = Math.min(deadline, performance.now() + 100);
            while (adapter.decoder.body?.length && performance.now() < partialUntil) {
              await sleep(5); check();
            }
          }
          await sleep(5);
        } while (performance.now() < until);
        progress(Math.min(1, 1 - (deadline - performance.now()) / (seconds * 1000)));
      }
    }
    return inspect();
  } finally {
    if (adapter.opened) await adapter.pauseReader();
  }
}
