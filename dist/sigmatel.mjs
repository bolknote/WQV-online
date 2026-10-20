import { tr, LocalizedError } from './i18n.mjs';
// STIr4200 register sequence / USB framing from the tested native utility.
// Reference: Linux v4.16 drivers/staging/irda/drivers/stir4200.c.
import { FrameDecoder, encodeFrame, hex, sleep } from './irda.mjs';

export const VID = 0x066f, PID = 0x4200;
const SIR_CLOCK = new Map([[9600, 0x77], [19200, 0x3b], [38400, 0x1d], [57600, 0x13], [115200, 0x09]]);

export function withTimeout(promise, ms, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new LocalizedError(tr("Timeout: {0}. Disconnect and reconnect USB.", operation))), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class SigmaTel {
  constructor(device, { log = () => {}, update = () => {}, rawLog = false } = {}) {
    if (device.vendorId !== VID || device.productId !== PID) throw new LocalizedError(tr("A SigmaTel STIr4200 (066f:4200) is required."));
    this.device = device; this.log = log; this.update = update;
    this.rawLog = rawLog;
    this.decoder = new FrameDecoder(); this.rxBytes = 0; this.txFrames = 0; this.switches = 0;
    this.claimed = false; this.configured = false; this.closing = false; this.baud = null;
    this.readerTask = null; this.readerActive = false; this.readPending = false; this.readError = null;
  }
  get opened() { return this.device.opened && this.claimed && !this.closing; }
  assertOpen() { if (!this.opened) throw new DOMException(tr("The adapter connection is closed."), 'AbortError'); }
  async io(promise, operation, ms = 3000) {
    try { return await withTimeout(promise, ms, operation); }
    catch (error) { this.log('error', tr('{0}: {1}', operation, error)); throw error; }
  }
  async open() {
    await this.io(this.device.open(), tr("opening USB"));
    if (this.closing) {
      await this.device.close();
      throw new DOMException(tr("Connection cancelled."), 'AbortError');
    }
    if (this.device.configuration?.configurationValue !== 1) {
      await this.io(this.device.selectConfiguration(1), tr("selecting configuration 1"));
    }
    const iface = this.device.configuration.interfaces.find(i => i.interfaceNumber === 0);
    const alternate = iface?.alternates.find(a => a.alternateSetting === 0);
    const input = alternate?.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
    const output = alternate?.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (!input || !output) throw new LocalizedError(tr("The expected bulk endpoints were not found on interface 0."));
    this.inEndpoint = input.endpointNumber; this.outEndpoint = output.endpointNumber;
    await this.io(this.device.claimInterface(0), tr("claiming USB interface 0"));
    if (this.closing) {
      await this.device.close();
      throw new DOMException(tr("Connection cancelled."), 'AbortError');
    }
    this.claimed = true;
    this.log('ok', tr("Interface 0 opened: OUT {0}, IN {1}.", this.outEndpoint, this.inEndpoint));
    this.description = {
      name: this.device.productName?.trim() || this.device.manufacturerName?.trim() || tr("USB device"),
      usbId: this.device.vendorId.toString(16).padStart(4, '0') + ':' + this.device.productId.toString(16).padStart(4, '0'),
      configuration: 1, interface: 0, interfaceClass: alternate.interfaceClass,
      inEndpoint: this.inEndpoint, outEndpoint: this.outEndpoint, packetSize: input.packetSize,
    };
    await this.registers();
    return this.description;
  }
  async registers(start = 1, count = 9, quiet = false) {
    this.assertOpen();
    const result = await this.io(this.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device', request: 1, value: 0, index: start,
    }, count), tr("reading SigmaTel registers"));
    if (result.status !== 'ok' || !result.data || result.data.byteLength !== count) {
      throw new LocalizedError(tr("Incomplete register reply: {0}, {1}/{2} bytes.", result.status, result.data?.byteLength ?? 0, count));
    }
    const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
    if (!quiet) this.log('info', tr("Registers {0}–{1}: {2}", start, start + count - 1, hex(bytes)));
    return bytes;
  }
  async writeRegister(index, value) {
    this.assertOpen();
    const result = await this.io(this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request: 3, value, index,
    }), tr("writing register {0}", index));
    if (result.status !== 'ok') throw new LocalizedError(tr("Register {0}: {1}.", index, result.status));
  }
  async setupSIR() {
    this.assertOpen();
    if (this.configured) return this.setSIRSpeed(9600);
    await this.pauseReader();
    for (const [direction, endpoint] of [['out', this.outEndpoint], ['in', this.inEndpoint]]) {
      await this.io(this.device.clearHalt(direction, endpoint), tr("clearing USB endpoint {0}", direction));
    }
    for (const [index, value] of [[1, 0x20], [3, 1], [8, 0x15], [2, 0x77], [1, 0x2a],
      [3, 0x80], [3, 0], [4, 0x20], [5, 8], [5, 0]]) await this.writeRegister(index, value);
    this.configured = true; this.baud = 9600;
    this.log('ok', tr("Infrared port configured: SIR, 9600 bit/s."));
    await this.registers();
  }
  async setSIRSpeed(baud) {
    this.assertOpen();
    if (!SIR_CLOCK.has(baud)) throw new RangeError('Unsupported SIR speed: ' + baud);
    if (!this.configured) throw new LocalizedError(tr('The infrared port has not been configured.'));
    if (this.baud === baud) return;
    const resume = Boolean(this.readerTask);
    await this.pauseReader();
    try {
      // Linux stir4200 change_speed(): stop the shared FIFO reader before
      // resetting the modulator, then apply the documented PDCLK divisor.
      for (const [index, value] of [[3, 1], [8, 0x15], [2, SIR_CLOCK.get(baud)],
        [1, 0x2a], [3, 0x80], [3, 0], [4, 0x20]]) await this.writeRegister(index, value);
      const [actual] = await this.registers(2, 1, true);
      if (actual !== SIR_CLOCK.get(baud)) throw new LocalizedError(tr('The SigmaTel baud-rate register did not accept {0} bit/s.', baud));
      this.baud = baud;
      this.decoder.body = null; this.decoder.escaped = false;
      this.log('info', tr('Infrared speed: {0} bit/s.', baud));
      if (resume) this.startReader();
    } catch (error) {
      this.configured = false; this.baud = null;
      throw error;
    } finally { this.update(); }
  }
  startReader() {
    this.assertOpen();
    if (this.readerTask) throw new LocalizedError(tr("The previous USB read has not stopped yet."));
    if (this.readError) throw this.readError;
    this.readerActive = true;
    this.readerTask = (async () => {
      try {
        while (this.readerActive && this.opened) {
          this.readPending = true;
          let result;
          try { result = await this.device.transferIn(this.inEndpoint, 64); }
          finally { this.readPending = false; }
          if (result.data?.byteLength) {
            const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
            this.rxBytes += data.length; this.decoder.feed(data);
            if (this.rawLog) this.log('usb-rx', tr("{0} bytes: {1}", data.length, hex(data)));
            this.update();
          }
          if (result.status !== 'ok') throw new LocalizedError(`USB IN: ${result.status}.`);
          // A final/poll frame hands the half-duplex link back to us. Do not
          // queue another USB read just to cancel it for the next transmit:
          // Chromium can leave that fast resubmission pending after release.
          if (this.decoder.frames.some(frame => frame.control & 0x10)) break;
        }
      } catch (error) {
        // releaseInterface/close explicitly abort the pending endpoint request.
        if (this.readerActive && !this.closing) {
          this.readError = error; this.log('error', tr("USB receive: {0}", error));
        }
      } finally { this.readerActive = false; this.readPending = false; this.readerTask = null; }
    })();
  }
  async pauseReader() {
    const task = this.readerTask;
    if (!task) { if (this.readError) throw this.readError; return; }
    this.readerActive = false;
    if (this.readPending && this.device.opened && this.claimed && !this.closing) {
      const start = performance.now();
      // WebUSB has no cancelTransfer. Release aborts all transfers on this
      // interface; claiming it again does not perform a USB device reset.
      await this.io(this.device.releaseInterface(0), tr("stopping the pending USB read"));
      this.claimed = false;
      await this.io(task, tr("finishing USB read"));
      if (this.closing) return;
      await this.io(this.device.claimInterface(0), tr("reclaiming USB interface"));
      this.claimed = true; this.switches++;
      this.log('switch', tr("Receiver stopped through release/claim in {0} ms.", (performance.now() - start).toFixed(1)));
      this.update();
    } else await this.io(task, tr("finishing USB read"));
    this.readerTask = null;
    if (this.readError) throw this.readError;
  }
  async testTurnaround(signal) {
    await this.setupSIR();
    for (let round = 0; round < 2; round++) {
      signal?.throwIfAborted();
      this.startReader();
      await sleep(100);
      signal?.throwIfAborted();
      await this.pauseReader();
      await this.registers();
      this.log('ok', tr("Receive cycle {0}/2 finished; the adapter responds after stopping the reader.", round + 1));
    }
  }
  async sendFrame(address, control, data, bof = 11) {
    this.assertOpen();
    await this.pauseReader();
    this.assertOpen();
    const wire = encodeFrame(address, control, data, bof);
    if (wire.length + 4 >= 4096) throw new LocalizedError(tr("The packet exceeds the SigmaTel FIFO size."));
    const packet = Uint8Array.of(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
    const result = await this.io(this.device.transferOut(this.outEndpoint, packet), tr("sending USB packet"));
    if (result.status !== 'ok' || result.bytesWritten !== packet.length) {
      throw new LocalizedError(tr("USB OUT: {0}, {1}/{2} bytes.", result.status, result.bytesWritten, packet.length));
    }
    this.txFrames++; this.update();
    this.log('tx', `IrDA ${hex([address, control])} · ${hex(data)}`);
    const deadline = performance.now() + wire.length * 10000 / (this.baud || 9600) + 1000;
    while (performance.now() < deadline) {
      const [status] = await this.registers(5, 3, true);
      if (!(status & 0x10) || (status & 4)) { this.startReader(); return; }
      await sleep(2);
    }
    throw new LocalizedError(tr("The SigmaTel transmit FIFO did not empty."));
  }
  async receiveFrame(timeout = 100) {
    this.assertOpen();
    let deadline = performance.now() + timeout, previous = this.rxBytes;
    const limit = performance.now() + Math.max(timeout, 1000);
    while (true) {
      if (this.readError) throw this.readError;
      if (this.decoder.frames.length) return this.decoder.frames.shift();
      if (performance.now() >= deadline) return null;
      // A caller may need another frame after consuming a final frame (for
      // example when the watch initiates discovery after a role change).
      if (!this.readerTask) this.startReader();
      if (previous !== this.rxBytes && this.decoder.body !== null) {
        deadline = Math.min(limit, Math.max(deadline, performance.now() + 50));
      }
      previous = this.rxBytes;
      await sleep(2); this.assertOpen();
    }
  }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.readerActive = false; this.configured = false;
    this.closeTask = (async () => {
      try {
        if (this.device.opened) await this.io(this.device.close(), tr("closing USB"), 4000);
      } finally { this.claimed = false; this.update(); }
    })();
    return this.closeTask;
  }
}
