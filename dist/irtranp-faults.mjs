// Explicit research-only faults. Every mutation is journalled before USB.
import { toHex as hex } from './formats.mjs';

export const FAULT_CASES = Object.freeze(['bad-crc', 'crc-burst', 'truncated', 'drop-ack']);

export function decodeUSBFrame(packet) {
  const bytes = new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
  if (bytes[0] !== 0x55 || bytes[1] !== 0xaa || (bytes[2] | bytes[3] << 8) !== bytes.length - 4) throw new Error('Invalid SigmaTel frame length.');
  let p = 4;
  while (bytes[p] === 0xc0) p++;
  if (bytes.at(-1) !== 0xc1) throw new Error('Expected a complete outgoing frame before fault injection.');
  const body = []; let escaped = false;
  for (const byte of bytes.slice(p, -1)) {
    if (escaped) { body.push(byte ^ 32); escaped = false; }
    else if (byte === 0x7d) escaped = true;
    else body.push(byte);
  }
  if (escaped || body.length < 4) throw new Error('Invalid outgoing SIR frame.');
  return { address: body[0], control: body[1], data: Uint8Array.from(body.slice(2, -2)), body, bof: p - 4 };
}

export class LinkFaults {
  constructor(scenario, record = () => {}, { at = 3 } = {}) {
    if (!FAULT_CASES.includes(scenario)) throw new Error('Unknown link fault.');
    if (!Number.isInteger(at) || at < 1 || at > 256) throw new RangeError('Fault frame index must be 1–256.');
    this.scenario = scenario; this.record = record; this.applied = 0; this.target = null; this.purpose = null;
    this.at = at; this.seenPUTFrames = 0;
    this.required = scenario === 'crc-burst' ? 2 : 1;
  }
  observe(kind, data) { if (kind === 'frame-send-attempt') this.purpose = data.purpose; }
  outgoing(packet) {
    const frame = decodeUSBFrame(packet);
    if (this.applied >= this.required || frame.control & 1) return packet;
    if (!this.target && this.purpose === 'csi-put' && ++this.seenPUTFrames === this.at) this.target = frame;
    if (!this.target || frame.address !== this.target.address || (frame.control & 0x0e) !== (this.target.control & 0x0e) ||
        hex(frame.data) !== hex(this.target.data)) return packet;
    if (this.scenario === 'drop-ack') return packet;
    const original = new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
    let wire;
    if (this.scenario === 'truncated') {
      wire = original.slice(4, 4 + frame.bof + Math.max(3, Math.floor((original.length - 4 - frame.bof) / 2)));
    } else {
      const body = [...frame.body]; body[body.length - 2] ^= 1;
      const encoded = Array(frame.bof).fill(0xc0);
      for (const byte of body) {
        if ([0xc0, 0xc1, 0x7d].includes(byte)) encoded.push(0x7d, byte ^ 32); else encoded.push(byte);
      }
      wire = Uint8Array.of(...encoded, 0xc1);
    }
    const actual = Uint8Array.of(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
    this.applied++;
    this.record('fault-injected', { scenario: this.scenario, direction: 'tx-wire', ordinal: this.applied,
      sendNS: (frame.control >>> 1) & 7, purpose: this.purpose, intendedUSBHex: hex(original), actualUSBHex: hex(actual) });
    return actual;
  }
  discardIncoming(frame) {
    if (this.scenario !== 'drop-ack' || this.applied || !this.target || frame.address !== this.target.address - 1 ||
        (frame.control & 3) === 3 || ((frame.control >>> 5) & 7) !== (((this.target.control >>> 1) + 1) & 7)) return false;
    this.applied++;
    this.record('fault-injected', { scenario: this.scenario, direction: 'rx-discard-after-USB', ordinal: 1,
      address: frame.address, control: frame.control, dataHex: hex(frame.data), rawUSBPreserved: true });
    return true;
  }
  wrapUSB(captured) {
    return new Proxy(captured, { get: (target, key) => {
      if (key === 'transferOut') return async (endpoint, packet) => {
        const actual = this.outgoing(packet);
        const result = await target.transferOut(endpoint, actual);
        // The adapter caller requested a logical complete frame. Keep its
        // completion contract after deliberate wire shortening; captureUSB
        // below this shim retains the actual bytes and actual written count.
        if (actual !== packet && result.status === 'ok' && result.bytesWritten === actual.byteLength) {
          this.record('fault-logical-write-complete', { actualBytes: actual.byteLength, intendedBytes: packet.byteLength });
          return { ...result, bytesWritten: packet.byteLength };
        }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  summary() { return { scenario: this.scenario, atPUTFrame: this.at, planned: this.required,
    applied: this.applied, exercised: this.applied === this.required }; }
}
