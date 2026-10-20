// IrDA SIR framing and Casio discovery, ported from the tested wqv_usb.py.
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  constructor() { this.body = null; this.escaped = false; this.badCRC = 0; this.frames = []; }
  feed(bytes) {
    for (let byte of bytes) {
      if (byte === 0xc0) { this.body = []; this.escaped = false; continue; }
      if (this.body === null) continue;
      if (byte === 0xc1) {
        if (this.body.length >= 4 && !this.escaped) {
          const b = this.body;
          if (crc16(b.slice(0, -2)) === (b.at(-2) | (b.at(-1) << 8))) {
            this.frames.push({ address: b[0], control: b[1], data: Uint8Array.from(b.slice(2, -2)) });
          } else this.badCRC++;
        }
        this.body = null; this.escaped = false; continue;
      }
      if (this.escaped) { byte ^= 0x20; this.escaped = false; }
      else if (byte === 0x7d) { this.escaped = true; continue; }
      this.body.push(byte);
      if (this.body.length > 4096) { this.body = null; this.escaped = false; }
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
  if (!(seconds > 0 && seconds <= 30)) throw new Error('Поиск должен длиться от 1 до 30 секунд.');
  const source = crypto.getRandomValues(new Uint8Array(4)).map(b => b & 0x3e);
  adapter.log('info', `Новый запрос обнаружения: ${hex(source)}`);
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
