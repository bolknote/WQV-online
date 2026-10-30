// WQV-1/2 PC client and OTHERS receiver. SigmaTel uses its native FIFO;
// other prepared transports can supply readSIR/writeSIR for raw wire bytes.
// Photo reads and explicit clock setting; no upload or delete commands.
import { b, concat, toHex } from './formats.mjs';
import { sleep } from './irda.mjs';
import { WQV12Decoder, encodeWQV12, decodeWQV12Record, WQV12_RECORD_BYTES, isWQV12ClockReply } from './wqv12-formats.mjs';
import { wqv12ClockPayload } from './wqv12-clock.mjs';

export async function prepareWQV12(adapter, signal, { rxSensitivity = 1, fastRX = true, rxLongp = 1, record = () => {} } = {}) {
  if (!Number.isInteger(rxSensitivity) || rxSensitivity < 0 || rxSensitivity > 6) throw new RangeError('SigmaTel RX threshold must be an integer from 0 to 6.');
  if (typeof fastRX !== 'boolean') throw new TypeError('SigmaTel FASTRXEN must be a boolean.');
  if (![1, 2].includes(rxLongp)) throw new RangeError('SigmaTel LONGP comparison must be 1 (current) or 2 (reset value).');
  signal?.throwIfAborted();
  await adapter.pauseReader(); await adapter.setupSIR(); await adapter.setSIRSpeed(115200);
  signal?.throwIfAborted(); adapter.assertOpen();
  if (adapter.readerTask || adapter.readPending) throw new Error('Stop the USB reader before configuring the WQV-1/2 receiver.');
  const before = await adapter.registers(1, 9, true);
  if (before[0] !== 0x2a || before[1] !== 9 || before[2] !== 0 || before[7] !== 0x15 || before[8] !== 0) throw new Error('Unexpected SigmaTel SIR setup. Prepare the adapter again.');
  // STIr4200 table 16: RXDSNS bits 7:5 select 4, 8, ... 28 pulse
  // samples. This changes reception only; TX pulse width and speed stay put.
  const requested = rxSensitivity << 5;
  if ((before[3] & 0xf8) !== requested) await adapter.writeRegister(4, requested);
  // STIr4200 table 12: FASTRXEN permits simultaneous reads/writes of the
  // receive FIFO. The comparison changes only that bit, not SIR modulation,
  // clock, pulse width or the optical input. It is not a proven WQV-2 fix.
  const modeRegister = fastRX ? 0x2a : 0x22;
  if (before[0] !== modeRegister) await adapter.writeRegister(1, modeRegister);
  // STIr4200 table 20: LONGP (bits 1:0) tunes the receive pulse detector.
  // Compare the Linux setting 1 with reset value 2, retaining DPCNT bits
  // 7:2. Those upper bits concern FIR, not this fixed-speed SIR experiment.
  const dpllRegister = (before[7] & 0xfc) | rxLongp;
  if (before[7] !== dpllRegister) await adapter.writeRegister(8, dpllRegister);
  signal?.throwIfAborted();
  const after = await adapter.registers(1, 9, true);
  const unchanged = [1, 2, 8].every(i => before[i] === after[i]);
  const settings = { baud: 115200, rxSensitivity, rxSamples: 4 * (rxSensitivity + 1),
    fastRX, modeRegister, rxLongp, dpllRegister, beforeHex: toHex(before), afterHex: toHex(after),
    verified: unchanged && after[0] === modeRegister && after[7] === dpllRegister && (after[3] & 0xf8) === requested };
  record('wqv12-receiver-settings', settings);
  if (!settings.verified) throw new Error('SigmaTel receiver settings did not match the register readback. No infrared frame has been sent.');
  return settings;
}

export class WQV12Client {
  constructor(adapter, { signal, record = () => {}, progress = () => {}, onImage = async () => {},
    replyMs = 800, helloMs = 200, retries = 4, turnaroundMs = 10 } = {}) {
    if (![replyMs, helloMs].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(retries) || retries < 1 || retries > 10) throw new RangeError('Invalid WQV-1/2 retry settings.');
    if (!Number.isFinite(turnaroundMs) || turnaroundMs < 0 || turnaroundMs > 1000) throw new RangeError('Invalid WQV-1/2 turnaround time.');
    Object.assign(this, { adapter, signal, record, progress, onImage, replyMs, helloMs, retries, turnaroundMs });
    this.decoder = new WQV12Decoder({ rejected: details => this.record('wqv12-rejected-frame', { phase: this.phase, ...details }) });
    this.address = null; this.images = []; this.clockHex = null; this.connected = false;
    this.received = b(); this.padding = b(); this.packetCount = 0; this.used = false;
    this.lastReceivedAt = -Infinity;
    this.stats = { txFrames: 0, rxBytes: 0, reads: 0, validFrames: 0, retries: 0, unexpectedFrames: 0, duplicates: 0 };
  }
  stage(phase, details = {}) { this.phase = phase; this.record('wqv12-phase', { phase, ...details }); this.progress(phase, details); }
  check() { this.runSignal?.throwIfAborted(); this.adapter.assertOpen(); }
  wait(promise) {
    return new Promise((resolve, reject) => {
      const signal = this.runSignal;
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
      Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async send(address, control, data = b()) {
    this.check(); const adapter = this.adapter;
    if (adapter.readPending || adapter.readerTask) throw new Error('The USB reader must finish before a WQV-1/2 transmission.');
    // Original WQV Link 1.0.1 ComDll.dll: 10005a60 timestamps each received
    // byte; 10005aa0 waits until that timestamp + 10 ms before writing.
    // Include rejected/noise bytes, and recheck after a timer's early wakeup.
    while (this.lastReceivedAt + this.turnaroundMs > performance.now()) {
      await this.wait(sleep(Math.max(0, this.lastReceivedAt + this.turnaroundMs - performance.now()))); this.check();
    }
    const wire = encodeWQV12(address, control, data), rawSIR = typeof adapter.writeSIR === 'function';
    this.record('wqv12-tx-attempt', { address, control, dataHex: toHex(data), wireHex: toHex(wire),
      minimumTurnaroundMs: this.turnaroundMs,
      sinceLastUSBReceiveMs: Number.isFinite(this.lastReceivedAt) ? performance.now() - this.lastReceivedAt : null });
    let result, requested;
    if (rawSIR) {
      requested = wire.length;
      result = await this.wait(adapter.writeSIR(wire));
    } else {
      const packet = concat(b(0x55, 0xaa, wire.length & 255, wire.length >>> 8), wire);
      requested = packet.length;
      result = await this.wait(adapter.io(adapter.device.transferOut(adapter.outEndpoint, packet), 'sending WQV-1/2 frame'));
    }
    if (result.status !== 'ok' || result.bytesWritten !== requested) throw new Error('WQV-1/2 write did not complete.');
    this.stats.txFrames++; adapter.txFrames++;
    this.record('wqv12-tx', { address, control, dataHex: toHex(data), wireHex: toHex(wire) });
    // KS-959 control OUT completes the write. Its documented protocol has no
    // SigmaTel FIFO/register calls; those must never be sent to that adapter.
    if (rawSIR) return;
    const until = performance.now() + 1000 + wire.length * 10000 / this.baud;
    let previous = Infinity;
    while (performance.now() < until) {
      this.check();
      const [status, low, high] = await this.wait(adapter.registers(5, 3, true));
      if (!(status & 0x10) || (status & 4)) return;
      const count = low | ((high & 31) << 8);
      if (count > previous) break;
      previous = count; await this.wait(sleep(2));
    }
    await this.wait(adapter.abortFIFO());
    throw new Error('WQV-1/2 transmit FIFO did not drain.');
  }
  async receive(until, want) {
    const adapter = this.adapter;
    while (performance.now() < until) {
      this.check();
      while (this.decoder.frames.length) {
        const frame = this.decoder.frames.shift();
        this.stats.validFrames++;
        this.record('wqv12-rx', { ...frame, data: undefined, dataHex: toHex(frame.data) });
        if (want(frame)) return frame;
        this.stats.unexpectedFrames++;
      }
      adapter.readPending = true;
      const rawSIR = typeof adapter.readSIR === 'function';
      const pending = rawSIR ? adapter.readSIR() : adapter.device.transferIn(adapter.inEndpoint, 64);
      pending.then(() => { adapter.readPending = false; }, () => { adapter.readPending = false; });
      const result = await this.wait(pending);
      if (rawSIR ? !(result instanceof Uint8Array) : result.status !== 'ok' || !result.data) throw new Error('WQV-1/2 reception failed.');
      const bytes = rawSIR ? result : new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      if (bytes.length) this.lastReceivedAt = performance.now();
      this.stats.reads++; this.stats.rxBytes += bytes.length; adapter.rxBytes += bytes.length;
      this.decoder.feed(bytes);
      if (!bytes.length) await this.wait(sleep(2));
    }
    return null;
  }
  async exchange(address, control, data, want, { timeout = this.replyMs, tries = this.retries } = {}) {
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) { this.stats.retries++; this.record('wqv12-retry', { address, control, dataHex: toHex(data), attempt }); }
      await this.send(address, control, data);
      const frame = await this.receive(performance.now() + timeout, frame => {
        if (address !== 255 && frame.address !== address) return false;
        if (want(frame)) return true;
        if (address !== 255 && frame.control === 0x43 && !frame.data.length) {
          this.stats.unexpectedFrames++;
          this.record('wqv12-peer43', { phase: this.phase, address, awaitingControl: control });
          throw new Error(`Watch returned 43 while waiting for ${control.toString(16)}; stopped this exchange.`);
        }
        return false;
      });
      if (frame) return frame;
    }
    throw new Error(`No valid WQV-1/2 reply to ${control.toString(16)} after ${tries} attempts.`);
  }
  async connect() {
    this.stage('hello');
    const hello = await this.exchange(255, 0xb3, b(), isWQV12ClockReply,
      { timeout: this.helloMs, tries: 150 });
    this.clockHex = toHex(hello.data);
    this.record('wqv12-clock', { rawHex: this.clockHex, hour: hello.data[0], minute: hello.data[1], second: hello.data[2], fraction256: hello.data[3] });
    this.stage('connect');
    const accepted = await this.exchange(255, 0x93, concat(hello.data, b(2)), f => f.address === 2 && f.control === 0x63);
    this.address = accepted.address;
    await this.exchange(this.address, 0x11, b(), f => f.control === 1);
    this.connected = true;
    this.stage('connected', { address: this.address, clockHex: this.clockHex, baud: this.baud });
  }
  async disconnect() {
    this.stage('disconnect');
    await this.exchange(this.address, 0x53, b(), f => f.control === 0x63);
    this.address = null; this.stage('closed');
  }
  async setClock(payload, value) {
    const adr = this.address;
    this.clockUpdate = { requested: value, payloadHex: toHex(payload), secondsChanged: false, outcome: 'unconfirmed' };
    this.stage('set-clock', { requested: value });
    await this.exchange(adr, 0x10, payload, f => f.control === 0x21);
    const reply = await this.exchange(adr, 0x11, b(), f => f.control === 0x20 && f.data.length > 0);
    this.clockUpdate.replyHex = toHex(reply.data);
    if (reply.data[0] !== 6) {
      if (reply.data[0] === 8) this.clockUpdate.outcome = 'rejected';
      throw new Error(`WQV-2 did not acknowledge the clock update: ${toHex(reply.data)}.`);
    }
    this.clockUpdate.outcome = 'accepted';
    this.record('wqv12-clock-accepted', this.clockUpdate);
    this.stage('clock-finish');
    // Original Palm deal_pread1 handles OP_ACK (06) by sending OP_ERROR
    // with status 00. This ends the request successfully; it is not a
    // second clock command. N(S)=1, N(R)=1 gives control 32.
    await this.exchange(adr, 0x32, b(8, 0), f => f.control === 0x41);
  }
  async download(current) {
    const adr = this.address; this.stage('header');
    await this.exchange(adr, 0x10, b(current ? 0 : 1), f => f.control === 0x21);
    const { data: header } = await this.exchange(adr, 0x11, b(), f => f.control === 0x20 && f.data.length >= 5);
    const size = (header[2] << 8) | header[3], count = header[4];
    this.record('wqv12-header', { dataHex: toHex(header), recordBytes: size, count, requestedCurrent: current });
    if (header[0] !== 7 || header[1] !== 0xfa || size !== WQV12_RECORD_BYTES || count > 100) throw new Error('Unexpected WQV-1/2 image header; original bytes have been recorded.');
    this.offeredCount = count;
    await this.exchange(adr, 0x32, b(6), f => f.control === 0x41);
    const total = size * count;
    this.stage('photos', { count, total });
    while (this.received.length < total) {
      const index = this.packetCount, poll = (((index + 1) & 7) << 5) | 0x11, reply = 0x40 | (((index + 1) & 7) << 1);
      const frame = await this.exchange(adr, poll, b(), f => f.control === reply && f.data.length > 1 && f.data[0] === 5 && f.data.length <= 129);
      this.received = concat(this.received, frame.data.slice(1)); this.packetCount++;
      while (this.images.length < count && this.received.length >= (this.images.length + 1) * size) {
        const image = decodeWQV12Record(this.received.slice(this.images.length * size, (this.images.length + 1) * size));
        image.index = this.images.length; this.images.push(image);
        this.record('wqv12-image', { index: image.index, dataHex: toHex(image.bytes), title: image.title, dateHex: image.dateHex });
        await this.wait(this.onImage(image));
      }
      this.progress('photos', { count, received: Math.min(this.received.length, total), total, images: this.images.length });
    }
    this.padding = this.received.slice(total); this.received = this.received.slice(0, total);
    this.stage('finish');
    const control = (((this.packetCount + 1) & 7) << 5) | 0x14;
    const ack = f => (f.control & 15) === 1 || f.control === 0x43;
    try { await this.exchange(adr, control, b(6), ack, { tries: 2 }); }
    catch (error) {
      this.check();
      if (control === 0x54) throw error;
      this.record('wqv12-close-fallback', { computedControl: control });
      await this.exchange(adr, 0x54, b(6), ack, { tries: 2 });
    }
  }
  async peerRequest(want, label, timeout = 5000) {
    const until = performance.now() + timeout;
    while (performance.now() < until) {
      const frame = await this.receive(until, () => true);
      if (!frame) break;
      const previous = this.lastPeerExchange;
      if (previous && frame.address === previous.request.address && frame.control === previous.request.control &&
          frame.data.length === previous.request.data.length && frame.data.every((byte, i) => byte === previous.request.data[i])) {
        this.stats.duplicates++;
        this.record('wqv12-peer-request-repeated', { phase: this.phase, address: frame.address, control: frame.control });
        await this.send(previous.address, previous.control, previous.data);
        continue;
      }
      if (want(frame)) return frame;
      this.stats.unexpectedFrames++;
      if (this.address !== null && frame.address === this.address && frame.control === 0x43) {
        throw new Error(`Watch returned 43 while waiting for ${label}.`);
      }
    }
    throw new Error(`No valid WQV-1/2 OTHERS ${label} received.`);
  }
  async answerPeer(request, control, data = b(), address = this.address ?? 255) {
    await this.send(address, control, data);
    this.lastPeerExchange = { request, address, control, data };
  }
  async receiveOthers() {
    // molefrog/casio-wqv-rcv was tested with WQV-2 OTHERS SEND. The watch
    // initiates the same SUM16 family, with our client acting as the receiver.
    // No discovery frame is transmitted before a valid watch B3 is received.
    this.stage('others-listen');
    const hello = await this.peerRequest(f => f.address === 255 && f.control === 0xb3 && !f.data.length, 'greeting B3', 45000);
    const date = new Date(), clock = b(date.getHours(), date.getMinutes(), date.getSeconds(), Math.floor(date.getMilliseconds() * 256 / 1000));
    this.localClockHex = toHex(clock);
    this.record('wqv12-local-challenge', { rawHex: this.localClockHex, purpose: 'handshake-only; not clock setting' });
    await this.answerPeer(hello, 0xa3, clock, 255);
    this.stage('others-connect');
    const connect = await this.peerRequest(f => f.address === 255 && f.control === 0x93 && f.data.length === 5, 'connection 93');
    if (!clock.every((byte, i) => connect.data[i] === byte) || connect.data[4] === 255) throw new Error('Unexpected WQV-1/2 OTHERS challenge echo or address.');
    this.address = connect.data[4];
    await this.answerPeer(connect, 0x63);
    const ready = await this.peerRequest(f => f.address === this.address && f.control === 0x11 && !f.data.length, 'ready 11');
    await this.answerPeer(ready, 1); this.connected = true;
    this.stage('others-header');
    const request = await this.peerRequest(f => f.address === this.address && f.control === 0x10, 'image request 10');
    this.record('wqv12-peer-image-request', { dataHex: toHex(request.data) });
    if (request.data.length !== 4 || request.data[0] !== 4 || request.data[1] !== 0xfa ||
        ((request.data[2] << 8) | request.data[3]) !== WQV12_RECORD_BYTES) throw new Error('Unexpected WQV-1/2 OTHERS image size or request; raw bytes retained.');
    this.offeredCount = 1;
    await this.answerPeer(request, 0x21);
    const poll = await this.peerRequest(f => f.address === this.address && f.control === 0x11 && !f.data.length, 'header poll 11');
    await this.answerPeer(poll, 0x20, b(6));
    this.stage('others-photos', { count: 1, total: WQV12_RECORD_BYTES });
    while (true) {
      const expected = 0x30 | (((this.packetCount + 1) & 7) << 1);
      const frame = await this.peerRequest(f => f.address === this.address && (f.control === expected || f.control === 0x31), 'image data or end 31');
      if (frame.control === 0x31) {
        if (frame.data.length || this.received.length < WQV12_RECORD_BYTES) throw new Error('WQV-1/2 OTHERS ended before a complete image record.');
        this.stage('others-finish'); await this.answerPeer(frame, 0x42, b(6)); break;
      }
      if (frame.data.length < 2 || frame.data.length > 129 || frame.data[0] !== 5 ||
          this.received.length + frame.data.length - 1 > WQV12_RECORD_BYTES + 127) throw new Error('Unexpected WQV-1/2 OTHERS image-data length.');
      this.received = concat(this.received, frame.data.slice(1)); this.packetCount++;
      await this.answerPeer(frame, (((this.packetCount + 1) & 7) << 5) | 1);
      if (!this.images.length && this.received.length >= WQV12_RECORD_BYTES) {
        const image = decodeWQV12Record(this.received.slice(0, WQV12_RECORD_BYTES)); image.index = 0; this.images.push(image);
        this.record('wqv12-image', { index: 0, dataHex: toHex(image.bytes), title: image.title, dateHex: image.dateHex });
        await this.wait(this.onImage(image));
      }
      this.progress('photos', { count: 1, received: Math.min(this.received.length, WQV12_RECORD_BYTES), total: WQV12_RECORD_BYTES, images: this.images.length });
    }
    this.padding = this.received.slice(WQV12_RECORD_BYTES); this.received = this.received.slice(0, WQV12_RECORD_BYTES);
    const end = await this.peerRequest(f => f.address === this.address && !f.data.length && [0x51, 0x53].includes(f.control), 'disconnect 53 or final poll 51');
    let disconnect = end;
    if (end.control === 0x51) {
      await this.answerPeer(end, 0x41);
      disconnect = await this.peerRequest(f => f.address === this.address && f.control === 0x53 && !f.data.length, 'disconnect 53');
    }
    await this.answerPeer(disconnect, 0x63); this.address = null; this.stage('closed');
  }
  async listenOnly(listenMs) {
    this.stage('listen', { durationMs: listenMs, infraredTransmission: false });
    this.greetings = 0;
    const until = performance.now() + listenMs;
    while (performance.now() < until) {
      const frame = await this.receive(until, () => true);
      if (!frame) break;
      if (frame.address === 255 && frame.control === 0xb3 && !frame.data.length) this.greetings++;
      this.progress('listen', { address: frame.address, control: frame.control, dataHex: toHex(frame.data),
        validFrames: this.stats.validFrames, greetings: this.greetings });
    }
    this.stage('captured', { greetings: this.greetings, infraredTransmission: false });
  }
  async run({ mode = 'probe', listenMs = 30000, baud = 115200, clockValue,
    durationMs = mode === 'listen' ? listenMs + 2000 : mode === 'all' ? 1200000 : mode === 'others' ? 120000 : mode === 'current' ? 90000 : 35000 } = {}) {
    if (!['probe', 'current', 'all', 'others', 'listen', 'set-clock'].includes(mode) || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 1200000 ||
        !Number.isFinite(listenMs) || listenMs < 1 || listenMs > 120000 || mode === 'listen' && durationMs <= listenMs) throw new RangeError('Invalid WQV-1/2 read mode or deadline.');
    const requestedClock = mode === 'set-clock' ? wqv12ClockPayload(clockValue) : null;
    const adapter = this.adapter;
    if (![9600, 19200, 38400, 57600, 115200].includes(baud) || !['others', 'listen'].includes(mode) && baud !== 115200) throw new RangeError('PC mode uses 115200; a diagnostic baud override is available only for OTHERS or listen.');
    if ((typeof adapter.readSIR === 'function') !== (typeof adapter.writeSIR === 'function')) throw new Error('A raw SIR transport must provide both readSIR and writeSIR.');
    if (this.used || !adapter.configured || adapter.baud !== baud || adapter.readerTask || adapter.readPending) throw new Error(`Prepare an idle SIR adapter at ${baud} and start a fresh WQV-1/2 client.`);
    this.signal?.throwIfAborted(); this.used = true; this.baud = baud;
    const controller = new AbortController(); this.runSignal = controller.signal;
    const stop = () => { controller.abort(this.signal.reason); adapter.close().catch(() => {}); };
    const timer = setTimeout(() => { controller.abort(new Error('WQV-1/2 test deadline reached.')); adapter.close().catch(() => {}); }, durationMs);
    this.signal?.addEventListener('abort', stop, { once: true });
    const started = performance.now(); let error = null;
    this.record('wqv12-start', { mode, durationMs, baud, diagnosticRate: baud !== 115200, checksum: 'sum16-be', readOnly: mode !== 'set-clock', minimumTurnaroundMs: this.turnaroundMs });
    try {
      if (mode === 'listen') await this.listenOnly(listenMs);
      else if (mode === 'others') await this.receiveOthers();
      else {
        await this.connect();
        if (mode === 'set-clock') await this.setClock(requestedClock, clockValue);
        else if (mode !== 'probe') await this.download(mode === 'current');
        await this.disconnect();
      }
    }
    catch (caught) { error = { name: caught.name, message: caught.message }; }
    finally { clearTimeout(timer); this.signal?.removeEventListener('abort', stop); }
    const result = { mode, status: !error ? mode === 'listen' ? this.stats.rxBytes ? 'captured' : 'no-data' : mode === 'probe' ? 'connected-and-closed' : mode === 'set-clock' ? 'clock-set' : mode === 'others' ? 'received' : 'downloaded' : this.signal?.aborted ? 'interrupted' : 'error',
      complete: !error && this.address === null, connected: this.connected, disconnected: this.connected && this.address === null,
      phase: this.phase, clockHex: this.clockHex, localClockHex: this.localClockHex ?? null, clockUpdate: this.clockUpdate ?? null,
      role: mode === 'listen' ? 'passive' : mode === 'others' ? 'receiver' : 'initiator',
      greetings: this.greetings ?? null, infraredTransmission: this.stats.txFrames > 0, baud, diagnosticRate: baud !== 115200, minimumTurnaroundMs: this.turnaroundMs,
      elapsedMs: performance.now() - started, offeredCount: this.offeredCount ?? null, imageCount: this.images.length,
      receivedBytes: this.received.length, paddingHex: toHex(this.padding),
      ...this.stats, badChecksum: this.decoder.badChecksum, malformed: this.decoder.malformed,
      unframedBytes: this.decoder.unframedBytes, abandonedFrames: this.decoder.abandonedFrames,
      partialFrameHex: this.decoder.body === null ? null : toHex(this.decoder.body), error };
    this.record('wqv12-finished', result); return result;
  }
}
