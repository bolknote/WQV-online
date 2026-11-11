import { driverStore } from './driver-store.mjs';
import { chooseInstalledDriver, driverProfile } from './driver-catalog.mjs';
import { WebUSBDriverBackend, HelperDriverBackend, classifyDriverOpenFailure } from './driver-usb.mjs';
import { readDriverAccess, rememberDriverAccess, canTryUSBHelper } from './driver-access.mjs';
import { openUSBHelperHelp } from './usb-helper-help.mjs';
import { DriverWorkerClient } from './driver-worker-client.mjs';
import { FrameDecoder, encodeFrame, sleep } from './irda.mjs';
import { KingsunStream } from './kingsun.mjs';
import { tr } from './i18n.mjs';

export function renderDriverHelper(element, device, adapter) {
  const installed = Boolean(adapter?.candidate);
  const needed = installed ? adapter.backend?.transport === 'helper' : device?.vendorId === 0x07d0 && device?.productId === 0x4959;
  element.hidden = !device || !needed;
  const script = !installed && device?.vendorId === 0x07d0 && device?.productId === 0x4959 ? 'kingsun_bridge.py' : 'irda_usb_helper.py';
  const message = installed ? 'Through USB Helper' : 'KS-959 needs the local USB helper. Download it, run it in a terminal, then connect again.';
  const label = element.querySelector('span'); label.dataset.i18n = message; label.textContent = tr(message);
  const link = element.querySelector('a'); link.href = './' + script; link.download = script;
  element.querySelector('code').textContent = 'python3 ' + script;
  for (const node of element.children) if (node.matches('a, code, span[data-i18n="Leave the terminal open while using the adapter."]')) node.hidden = installed;
  for (const button of document.querySelectorAll('[data-usb-helper-help]')) button.dataset.usbHelperHelp = script;
  let help = element.querySelector('[data-helper-details]');
  if (!help) { help = document.createElement('button'); help.type = 'button'; help.dataset.helperDetails = ''; element.append(help); }
  help.dataset.i18n = 'How to start USB Helper…'; help.textContent = tr('How to start USB Helper…');
  help.onclick = () => openUSBHelperHelp(script);
}

// The host only finds the receive counter's phase. The unmodified C driver
// still decodes every delivered USB byte, including counter wrap markers.
class CounterCalibration {
  constructor(stream) { this.stream = stream; this.pending = []; this.length = 0; this.queue = []; }
  input(result) {
    if (this.queue.length) throw new Error('Encoded receive queue was not drained before another USB read.');
    if (this.stream.counter && !this.pending.length) return result;
    if (result.bytes.length) { this.pending.push(result.bytes); this.length += result.bytes.length; this.stream.feed(result.bytes); }
    if (this.length > 16384) throw new Error('KS-959 receive synchronization exceeded 16 KiB.');
    if (!this.stream.counter) return { bytes: new Uint8Array() };
    const start = this.stream.counter.phase - this.pending.reduce((n, part) => n + part.length, 0) & 255;
    const all = new Uint8Array(this.length); let offset = 0;
    for (const part of this.pending) { all.set(part, offset); offset += part.length; }
    for (let p = 0; p < all.length; p += 2048) this.queue.push({ bytes: all.slice(p, p + 2048), ...(p ? {} : { rxCounter: start }) });
    this.pending = []; this.length = 0;
    return this.queue.shift() ?? { bytes: new Uint8Array() };
  }
}

export async function findInstalledAdapter(device, options = {}) {
  // A fresh installation or blocked optional storage keeps built-in drivers usable.
  let records;
  try { records = await driverStore.list(); } catch { return null; }
  const candidate = chooseInstalledDriver(records, device);
  if (!candidate) return null;
  const profile = driverProfile(candidate.record.profile);
  if (profile.infrared === false) throw new Error(tr('This driver provides a serial port. Infrared transfer requires an infrared adapter driver.'));
  if (options.model === 'wqv2' && profile.framing !== 'raw') throw new Error('This driver uses hardware IrDA framing and cannot carry the WQV-1/2 raw SUM16 protocol.');
  if (options.model === 'wqv2' && profile.id === 'kingsun') throw new Error('This driver supports 9600 bit/s only. WQV-1/2 requires 115200 bit/s.');
  return new InstalledDriverAdapter(device, candidate, options);
}

export class InstalledDriverAdapter {
  constructor(device, candidate, { log = () => {}, update = () => {}, record = () => {}, raw = () => {}, model = 'wqv3' } = {}) {
    Object.assign(this, { device, candidate, log, update, record, raw, model });
    this.profile = driverProfile(candidate.record.profile);
    this.maxBaud = this.profile.id === 'kingsun' ? 9600 : 115200;
    this.frameRecovery = this.profile.id === 'sigmatel' ? 'pad5-bof' : 'strict';
    this.decoder = new FrameDecoder({ recoverFrames: this.profile.id === 'sigmatel' });
    this.rxBytes = 0; this.txFrames = 0; this.switches = 0; this.fifoRecoveries = 0; this.revision = null;
    this.configured = false; this.claimed = false; this.closing = false; this.baud = null;
    this.queue = []; this.queueBytes = 0; this.readerTask = null; this.readerActive = false;
    this.readPending = false; this.readError = null; this.waiter = null;
  }
  get opened() { return this.claimed && !this.closing; }
  assertOpen() { if (!this.opened) throw new DOMException('The adapter connection is closed.', 'AbortError'); }
  async open() {
    const { record, match } = this.candidate;
    if (this.profile.id === 'ks959') {
      const stream = this.model === 'wqv2' ? new (await import('./wqv2-adapter.mjs')).WQV2KingsunStream() : new KingsunStream();
      this.calibration = new CounterCalibration(stream);
    }
    const attempt = async method => {
      const Backend = method === 'helper' ? HelperDriverBackend : WebUSBDriverBackend;
      const options = { onTransfer: transfer => this.usbTransfer(transfer),
        onEvent: event => this.record('driver-usb-state', event),
        synchronize: this.calibration ? result => this.calibration.input(result) : null };
      const backend = this.backend = new Backend(this.device, match, options);
      if (this.calibration) {
        const control = backend.control.bind(backend);
        backend.control = (request, bytes) => (request.type & 128) && this.calibration.queue.length
          ? Promise.resolve(this.calibration.queue.shift()) : control(request, bytes);
      }
      const client = this.client = new DriverWorkerClient(backend, {
        event: event => this.record('driver-runtime', event), data: (bytes, packet) => this.input(bytes, packet),
      });
      await client.load(record.artifact.bytes, record.profile);
      try { return await client.open(); }
      catch (error) {
        try { await client.close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], error.message + '; USB cleanup failed: ' + cleanup.message); }
        throw classifyDriverOpenFailure(error, backend);
      }
    };
    try {
      try { this.description = await attempt(readDriverAccess(record, this.device) === 'helper' ? 'helper' : 'direct'); }
      catch (error) {
        if (this.closing || this.backend.transport === 'helper' || !canTryUSBHelper(error)) throw error;
        this.log('info', error.message); this.description = await attempt('helper');
      }
      if (this.closing) throw new DOMException('The adapter connection is closed.', 'AbortError');
      this.description.driver = record.name + ' · C';
      const fields = this.backend.descriptors().fields;
      this.inEndpoint = fields[4] & 15; this.outEndpoint = fields[5] & 15;
      if (this.profile.id === 'ks959') this.description.controlEndpoint = 0;
      this.claimed = true; this.configured = true; this.baud = 9600;
      if (this.profile.id === 'sigmatel') this.revision = (await this.registers(4, 1))[0] & 7;
      rememberDriverAccess(record, this.device, this.backend.transport);
      this.log('info', record.filename + ' · ' + record.sha256 + ' · ' + this.description.transport);
      return this.description;
    } catch (error) {
      try { await this.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], error.message + '; USB cleanup failed: ' + cleanup.message); }
      throw error;
    }
  }
  usbTransfer(transfer) {
    this.record('driver-usb', transfer);
    if (this.profile.id === 'sigmatel' && this.revision !== null && transfer.direction === 'in' &&
        (transfer.request.bulk || transfer.request.transfer === 'bulk') && transfer.dataHex === '') {
      const reads = this.revision <= 6 ? 1 : this.baud > 9600 ? 2 : 0;
      this.decoder.emptyRead(reads);
    }
  }
  input(bytes, packet) {
    if (!bytes.length || this.closing) return;
    if (packet) {
      if (bytes.length < 2) { this.readError = new Error('Incomplete IrDA packet from driver.'); return; }
      bytes = encodeFrame(bytes[0], bytes[1], bytes.slice(2), 1);
    }
    if (this.queueBytes + bytes.length > 262144) { this.readError = new Error('Driver receive queue exceeded 256 KiB.'); void this.client.abort(this.readError).catch(() => {}); return; }
    // As with built-in adapters, the active protocol reader owns RX counts.
    this.queue.push(bytes); this.queueBytes += bytes.length;
    this.raw('sir-rx', bytes); this.waiter?.(); this.update();
  }
  async readRaw() {
    this.assertOpen();
    if (this.readError) throw this.readError;
    if (!this.queue.length) await new Promise(resolve => {
      const timer = setTimeout(() => { this.waiter = null; resolve(); }, 12);
      this.waiter = () => { clearTimeout(timer); this.waiter = null; resolve(); };
    });
    this.assertOpen();
    const bytes = this.queue.shift() ?? new Uint8Array(); this.queueBytes -= bytes.length;
    return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
  async readSIR() { const result = await this.readRaw(); return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength); }
  setReceiveStream(stream, { swan = false } = {}) {
    if (this.profile.id !== 'ks959') throw new Error('Receive counter calibration is available for KS-959 only.');
    this.calibration = new CounterCalibration(stream); this.swanReceive = swan;
    this.queue = []; this.queueBytes = 0;
  }
  async setupSIR() {
    this.assertOpen();
    if (this.swanReceive) this.setReceiveStream(new KingsunStream());
    if (this.baud !== 9600) await this.setSIRSpeed(9600);
  }
  async setSIRSpeed(baud) {
    this.assertOpen(); if (![9600, 19200, 38400, 57600, 115200].includes(baud)) throw new RangeError('Unsupported SIR speed.');
    if (baud > this.maxBaud) throw new RangeError('This driver supports at most ' + this.maxBaud + ' bit/s.');
    await this.pauseReader(); await this.client.speed(baud); this.baud = baud; this.decoder.reset(); this.update();
  }
  async prepareWQV2(signal, { mode = 'pc' } = {}) {
    await this.pauseReader(); signal?.throwIfAborted();
    this.calibration?.stream.setMode?.(mode);
    await this.setSIRSpeed(115200); signal?.throwIfAborted();
    return { baud: 115200, driver: this.description.driver };
  }
  async writeSIR(wire) {
    this.assertOpen(); this.raw('sir-tx-attempt', wire);
    if (this.profile.framing === 'packet') {
      const decoder = new FrameDecoder(); decoder.feed(wire);
      if (decoder.badCRC || decoder.frames.length !== 1) throw new Error('This driver requires one complete CRC-valid IrDA frame per write.');
      const frame = decoder.frames[0];
      await this.client.send(Uint8Array.of(frame.address, frame.control, ...frame.data));
    } else {
      const limit = this.profile.id === 'ks959' && this.baud >= 38400 ? 8 : this.profile.id === 'sigmatel' && this.baud === 115200 ? 32 : 1800;
      for (let offset = 0; offset < wire.length; offset += limit) await this.client.send(wire.slice(offset, offset + limit));
    }
    return { status: 'ok', bytesWritten: wire.length };
  }
  async sendFrame(address, control, data = new Uint8Array(), bof = 11, { receive = true } = {}) {
    await this.pauseReader();
    if (address === 255 && control === 0x3f && data.length >= 5) this.calibration?.stream.expectDiscovery?.(data.slice(1, 5));
    await this.writeSIR(encodeFrame(address, control, data, bof)); this.txFrames++;
    if (receive) this.startReader();
  }
  startReader() {
    this.assertOpen(); if (this.readerTask) return;
    this.readerActive = true;
    this.readerTask = (async () => {
      try {
        while (this.readerActive && this.opened) {
          const bytes = await this.readSIR();
          if (bytes.length) { this.rxBytes += bytes.length; this.decoder.feed(bytes); this.update(); }
          if (this.decoder.frames.some(frame => frame.control & 0x10)) break;
        }
      } catch (error) { if (!this.closing) this.readError = error; }
      finally { this.readerActive = false; this.readerTask = null; }
    })();
  }
  async pauseReader() { this.readerActive = false; this.waiter?.(); if (this.readerTask) await this.readerTask; if (this.readError) throw this.readError; }
  async receiveFrame(timeout = 2000) {
    this.assertOpen(); const end = performance.now() + timeout;
    if (!this.readerTask) this.startReader();
    while (performance.now() < end) {
      if (this.readError) throw this.readError;
      if (this.decoder.frames.length) return this.decoder.frames.shift();
      if (!this.readerTask) this.startReader();
      await sleep(2);
    }
    return null;
  }
  async registers(start = 1, count = 9) {
    if (this.profile.id !== 'sigmatel') throw new Error('Register view is available for SigmaTel only.');
    return (await this.backend.control({ type: 0xc0, request: 1, value: 0, index: start, length: count }, null)).bytes;
  }
  async writeRegister(index, value) {
    if (this.profile.id !== 'sigmatel') throw new Error('Register controls are available for SigmaTel only.');
    return this.backend.control({ type: 0x40, request: 3, value, index, length: 0 }, new Uint8Array());
  }
  async testTurnaround(signal) { this.assertOpen(); signal?.throwIfAborted(); await this.client.speed(this.baud); signal?.throwIfAborted(); }
  io(promise) { return promise; }
  async close() {
    this.closing = true; this.readerActive = false; this.waiter?.();
    try { if (this.client) await this.client.close(); }
    finally { this.claimed = false; this.configured = false; this.queue = []; this.queueBytes = 0; }
  }
}
