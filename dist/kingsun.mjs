// KS-959 USB protocol facts documented in Linux ks959-sir.c. Independent
// implementation; research source/function vectors are credited in docs.
import { FrameDecoder, encodeFrame, hex, sleep } from './irda.mjs';
import { withTimeout } from './sigmatel.mjs';
import { tr, LocalizedError } from './i18n.mjs';

export const VID = 0x07d0, PID = 0x4959;
const RATES = [9600, 19200, 38400, 57600, 115200];
const KEY = new TextEncoder().encode('wangshuofei19710');
const bytes = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();

export function encodeKingsun(wire) {
  if (!(wire instanceof Uint8Array) || !wire.length || wire.length > 2048) throw new RangeError('Invalid KS-959 infrared frame size.');
  const fragments = [];
  for (let p = 0; p < wire.length; p += 240) {
    const clear = wire.subarray(p, p + 240), data = new Uint8Array(Math.ceil(clear.length / 8) * 8 + 16);
    const mask = KEY[(clear.length & 15) ^ 6] ^ 0x55;
    for (let i = 0; i < clear.length; i++) data[i] = clear[i] ^ mask;
    fragments.push({ length: clear.length, data });
  }
  return fragments;
}

export class KingsunCounter {
  constructor(phase = 0) {
    if (!Number.isInteger(phase) || phase < 0 || phase > 255) throw new RangeError('Invalid KS-959 receive counter.');
    this.phase = phase; this.skipped = 0; this.unexpectedMarkers = 0;
  }
  feed(raw) {
    const clear = [];
    for (const value of raw) {
      this.phase = (this.phase + 1) & 255;
      const byte = value ^ this.phase ^ 0x55;
      if (this.phase) clear.push(byte);
      else { this.skipped++; if (byte !== 0x95) this.unexpectedMarkers++; }
    }
    return Uint8Array.from(clear);
  }
}

// WebUSB has no physical-connection ID for this serial-less device. Do not
// assume its counter resets on open, configuration, or baud changes. Require
// an echoed discovery nonce plus valid FCS, or two valid frames, and uniqueness.
export class KingsunStream {
  constructor(onSync = () => {}) { this.onSync = onSync; this.counter = null; this.source = null; this.restart(); }
  restart() {
    this.pending = []; this.pendingBytes = 0;
    this.candidates = Array.from({ length: 256 }, (_, phase) => ({ phase, counter: new KingsunCounter(phase), decoder: new FrameDecoder(), valid: 0, nonce: false }));
  }
  expectDiscovery(source) { this.source = source.slice(); }
  feed(raw) {
    if (this.counter) return this.counter.feed(raw);
    if (!raw.length) return raw;
    if (this.pendingBytes + raw.length > 16384) this.restart();
    this.pending.push(raw.slice()); this.pendingBytes += raw.length;
    for (const candidate of this.candidates) {
      candidate.decoder.feed(candidate.counter.feed(raw));
      for (const frame of candidate.decoder.frames.splice(0)) {
        candidate.valid++;
        if (this.source && frame.address === 0xfe && frame.control === 0xbf && frame.data.length >= 12 && frame.data[0] === 1 &&
            this.source.every((value, i) => frame.data[5 + i] === value)) candidate.nonce = true;
      }
    }
    const nonceMatches = this.candidates.filter(c => c.nonce);
    const qualified = nonceMatches.length ? nonceMatches : this.candidates.filter(c => c.valid >= 2);
    if (qualified.length !== 1) return new Uint8Array();
    const selected = qualified[0];
    this.counter = new KingsunCounter(selected.phase);
    const clear = this.pending.map(part => this.counter.feed(part));
    const result = new Uint8Array(clear.reduce((n, part) => n + part.length, 0));
    let p = 0; for (const part of clear) { result.set(part, p); p += part.length; }
    this.onSync({ initialPhase: selected.phase, phase: this.counter.phase, validFrames: selected.valid,
      discoveryNonce: selected.nonce, rawBytes: this.pendingBytes });
    this.pending = []; this.pendingBytes = 0; this.candidates = null;
    return result;
  }
}

export class Kingsun {
  constructor(device, { log = () => {}, update = () => {}, rawLog = false, record = () => {} } = {}) {
    if (device.vendorId !== VID || device.productId !== PID) throw new LocalizedError(tr('A KingSun KS-959 (07d0:4959) is required.'));
    Object.assign(this, { device, log, update, rawLog, record });
    this.decoder = new FrameDecoder();
    this.stream = new KingsunStream(details => { this.record('kingsun-synchronized', details); this.log('info', tr('KS-959 receive stream synchronized.')); });
    this.claimed = false; this.closing = false; this.configured = false; this.baud = null; this.revision = null;
    this.readerTask = null; this.readerActive = false; this.readPending = false; this.readTask = null; this.readError = null;
    this.rxBytes = 0; this.rawRxBytes = 0; this.txFrames = 0; this.switches = 0; this.fifoRecoveries = 0;
    this.inEndpoint = null; this.outEndpoint = null;
  }
  get opened() { return this.device.opened && this.claimed && !this.closing; }
  assertOpen() { if (!this.opened) throw new DOMException(tr('The adapter connection is closed.'), 'AbortError'); }
  async io(promise, operation) { return withTimeout(promise, 3000, operation); }
  async open() {
    await this.io(this.device.open(), tr('opening USB'));
    if (this.closing) { await this.device.close(); throw new DOMException('Connection cancelled.', 'AbortError'); }
    if (this.device.configuration?.configurationValue !== 1) await this.io(this.device.selectConfiguration(1), tr('selecting configuration 1'));
    const alternate = this.device.configuration?.interfaces.find(i => i.interfaceNumber === 0)?.alternates.find(a => a.alternateSetting === 0);
    if (!alternate) throw new LocalizedError(tr('USB interface 0 was not found.'));
    await this.io(this.device.claimInterface(0), tr('claiming USB interface 0'));
    if (this.closing) { await this.device.close(); throw new DOMException('Connection cancelled.', 'AbortError'); }
    this.claimed = true;
    this.description = { name: this.device.productName?.trim() || this.device.manufacturerName?.trim() || 'KingSun KS-959',
      usbId: '07d0:4959', configuration: 1, interface: 0, interfaceClass: alternate.interfaceClass,
      controlEndpoint: 0, driver: 'KingSun KS-959' };
    return this.description;
  }
  async speedCommand(baud) {
    this.assertOpen();
    const data = new Uint8Array(8); new DataView(data.buffer).setUint32(0, baud, true); data[4] = 3;
    const result = await this.io(this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 9, value: 0x200, index: 1 }, data), tr('setting infrared speed'));
    if (result.status !== 'ok' || result.bytesWritten !== 8) throw new LocalizedError(tr('The KS-959 speed command did not complete.'));
    this.baud = baud; this.record('kingsun-speed', { baud });
  }
  async setupSIR() {
    if (this.configured) return this.setSIRSpeed(9600);
    await this.pauseReader(); await this.speedCommand(9600); this.configured = true;
  }
  async setSIRSpeed(baud) {
    this.assertOpen();
    if (!RATES.includes(baud)) throw new RangeError('Unsupported SIR speed: ' + baud);
    if (!this.configured) throw new LocalizedError(tr('The infrared port has not been configured.'));
    if (this.baud === baud) return;
    const resume = Boolean(this.readerTask); await this.pauseReader();
    try { await this.speedCommand(baud); this.decoder.reset(); if (resume) this.startReader(); }
    catch (error) { this.configured = false; throw error; }
    finally { this.update(); }
  }
  async readRaw() {
    this.assertOpen();
    if (this.readTask) throw new Error('KS-959 USB read already pending.');
    this.readPending = true;
    this.readTask = (async () => {
      const result = await this.io(this.device.controlTransferIn({ requestType: 'class', recipient: 'interface', request: 1, value: 0x200, index: 0 }, 2048), tr('reading USB'));
      if (result.status !== 'ok' || !result.data) throw new Error('KS-959 USB IN: ' + result.status);
      const raw = bytes(result.data), clear = this.stream.feed(raw); this.rawRxBytes += raw.length;
      if (raw.length) this.record('kingsun-rx', { rawHex: hex(raw).replaceAll(' ', ''), clearHex: hex(clear).replaceAll(' ', ''),
        synchronized: Boolean(this.stream.counter), phase: this.stream.counter?.phase ?? null });
      if (this.rawLog && raw.length) this.log('usb-rx', tr('{0} bytes: {1}', clear.length, hex(clear)));
      return { status: 'ok', data: new DataView(clear.buffer, clear.byteOffset, clear.length) };
    })();
    try { return await this.readTask; }
    finally { this.readTask = null; this.readPending = false; }
  }
  startReader() {
    this.assertOpen();
    if (this.readerTask) throw new Error('The previous USB read has not stopped yet.');
    if (this.readError) throw this.readError;
    this.readerActive = true;
    this.readerTask = (async () => {
      try {
        while (this.readerActive && this.opened) {
          const result = await this.readRaw(), data = bytes(result.data);
          if (!this.opened) break;
          this.rxBytes += data.length; this.decoder.feed(data);
          if (data.length) this.update();
          if (this.decoder.frames.some(frame => frame.control & 0x10)) break;
          if (!data.length) await sleep(2);
        }
      } catch (error) { if (!this.closing) { this.readError = error; this.log('error', error); } }
      finally { this.readerActive = false; this.readerTask = null; }
    })();
  }
  async pauseReader() {
    this.readerActive = false;
    if (this.readerTask) await this.io(this.readerTask, tr('finishing USB read'));
    if (this.readTask) await this.io(this.readTask, tr('finishing USB read'));
    if (this.readError && !this.closing) throw this.readError;
  }
  async sendFrame(address, control, data = new Uint8Array(), bof = 11, { receive = true } = {}) {
    this.assertOpen(); await this.pauseReader(); this.assertOpen();
    if (address === 0xff && control === 0x3f && data.length >= 12 && data[0] === 1) this.stream.expectDiscovery(data.slice(1, 5));
    const wire = encodeFrame(address, control, data, bof);
    for (const fragment of encodeKingsun(wire)) {
      const result = await this.io(this.device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 9, value: fragment.length, index: 0 }, fragment.data), tr('sending USB packet'));
      if (result.status !== 'ok' || result.bytesWritten !== fragment.data.length) throw new Error('KS-959 USB OUT did not complete.');
    }
    this.txFrames++; this.update(); this.log('tx', `IrDA ${hex([address, control])} · ${hex(data)}`);
    if (receive) this.startReader();
  }
  async receiveFrame(timeout = 100) {
    const until = performance.now() + timeout;
    while (performance.now() < until) {
      this.assertOpen(); if (this.readError) throw this.readError;
      if (this.decoder.frames.length) return this.decoder.frames.shift();
      if (!this.readerTask) this.startReader();
      await sleep(2);
    }
    return this.decoder.frames.shift() ?? null;
  }
  async testTurnaround(signal) {
    await this.setupSIR();
    for (let round = 0; round < 2; round++) {
      signal?.throwIfAborted(); this.startReader(); await sleep(100); await this.pauseReader();
      signal?.throwIfAborted(); await this.speedCommand(9600);
    }
  }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.readerActive = false; this.configured = false;
    this.closeTask = (async () => {
      try { if (this.device.opened) await this.io(this.device.close(), tr('closing USB')); }
      finally { this.claimed = false; this.update(); }
    })();
    return this.closeTask;
  }
}
