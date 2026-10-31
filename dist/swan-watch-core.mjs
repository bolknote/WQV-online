// WQV-3 SWAN photo transfer. Port of the hardware-verified native receiver
// and window-one sender; framing is shared with WQV-1/2, not IrLAP CRC.
import { b, concat, equal, toHex } from './formats.mjs';
import { WQV12Client } from './wqv12-core.mjs';
import { encodeWQV12 } from './wqv12-formats.mjs';
import { sleep } from './irda.mjs';
import { SWAN_BAUD, SWAN_PREFIX, SWAN_RECORD_BYTES, SWAN_BLOCK_BYTES, checkSwanRecord } from './swan-watch-formats.mjs';

export class SwanWatchClient extends WQV12Client {
  constructor(adapter, { record = () => {}, progress = () => {}, challenge, ...options } = {}) {
    super(adapter, { ...options, replyMs: 750, retries: 4,
      record: (kind, details) => record(kind.replace(/^wqv12-/, 'swan-'), details), progress });
    const now = new Date();
    this.challenge = challenge ?? b(now.getHours(), now.getMinutes(), now.getSeconds(), Math.floor(now.getMilliseconds() * 256 / 1000));
    if (!(this.challenge instanceof Uint8Array) || this.challenge.length !== 4) throw new RangeError('Invalid SWAN challenge.');
    this.baud = SWAN_BAUD; this.disconnected = false; this.finalAccepted = false;
    this.bytesAcknowledged = 0; this.imageBlocks = 0; this.offered = false; this.closeError = null;
    Object.defineProperty(this.stats, 'badChecksum', { enumerable: true, get: () => this.decoder.badChecksum });
    adapter.swanStats = this.stats;
  }
  async send(address, control, data = b()) {
    this.check();
    if (this.adapter.readerTask || this.adapter.readPending) throw new Error('Stop the USB reader before SWAN transmission.');
    while (this.lastReceivedAt + this.turnaroundMs > performance.now()) await this.wait(sleep(Math.max(0, this.lastReceivedAt + this.turnaroundMs - performance.now())));
    this.check();
    const wire = concat(SWAN_PREFIX, encodeWQV12(address, control, data));
    this.record('swan-tx-attempt', { address, control, dataHex: toHex(data), wireHex: toHex(wire) });
    await this.wait(this.adapter.writeSIR(wire));
    this.stats.txFrames++; this.adapter.txFrames++;
    this.record('swan-tx', { address, control, dataHex: toHex(data), wireHex: toHex(wire) });
  }
  async exchange(address, control, data, want, { timeout = this.replyMs, tries = this.retries } = {}) {
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) { this.stats.retries++; this.record('swan-retry', { address, control, dataHex: toHex(data), attempt }); }
      await this.send(address, control, data);
      const frame = await this.receive(performance.now() + timeout, f => {
        if (address !== 255 && f.address !== address) return false;
        if (want(f)) return true;
        if (address !== 255 && [0x43, 0x53].includes(f.control) && !f.data.length) throw new Error('The watch closed the SWAN connection.');
        return false;
      });
      if (frame) return frame;
    }
    throw new Error(`No SWAN reply to ${control.toString(16)} after ${tries} attempts.`);
  }
  async peer(want, timeout = 5000) {
    const frame = await this.receive(performance.now() + timeout, want);
    if (!frame) throw new Error('The watch stopped sending SWAN data.');
    return frame;
  }
  async answer(request, control, data = b(), address = this.address ?? 255) {
    this.lastAnswer = { request, address, control, data };
    await this.send(address, control, data);
  }
  async receivePhoto() {
    this.stage('waiting-watch');
    const hello = await this.peer(f => f.address === 255 && f.control === 0xb3 && !f.data.length, 60000);
    await this.answer(hello, 0xa3, this.challenge);
    let repeated = 0;
    // Repeated handshake requests get the same challenge/UA, never a new
    // challenge in the middle of a session.
    const next = async want => {
      while (true) {
        const f = await this.peer(() => true), previous = this.lastAnswer;
        if (previous && f.address === previous.request.address && f.control === previous.request.control && equal(f.data, previous.request.data)) {
          if (++repeated > 3) throw new Error('SWAN handshake retry limit reached.');
          this.stats.duplicates++; await this.send(previous.address, previous.control, previous.data); continue;
        }
        repeated = 0;
        if (want(f)) return f;
        throw new Error('Unexpected SWAN handshake frame.');
      }
    };
    const connect = await next(f => f.address === 255 && f.control === 0x93 && f.data.length === 5 && equal(f.data.slice(0, 4), this.challenge) && f.data[4] !== 255);
    this.address = connect.data[4]; await this.answer(connect, 0x63);
    const ready = await next(f => f.address === this.address && f.control === 0x11 && !f.data.length);
    await this.answer(ready, 1); this.connected = true; this.stage('connected', { baud: SWAN_BAUD });
    let rxNext = 0, txNext = 0, lastRX = null, unacked = null, duplicateCount = 0, pending = [];
    const rr = () => this.send(this.address, (rxNext << 5) | 1);
    const ack = (nr, stale = false) => {
      if (unacked && nr === ((unacked.ns + 1) & 7)) {
        txNext = nr; if (unacked.reason === 'end') this.finalAccepted = true; unacked = null;
      } else if (nr !== (unacked?.ns ?? txNext) && !stale) throw new Error('SWAN acknowledgement is outside the transmit window.');
    };
    while (!this.disconnected) {
      const f = await this.peer(() => true), { address, control, data } = f;
      if (address !== this.address) throw new Error('Unexpected SWAN connection address.');
      if (control === 0x53 && !data.length) {
        await this.send(address, 0x63); this.disconnected = true;
        if (this.received.length < SWAN_RECORD_BYTES || !this.endSent) throw new Error('SWAN disconnected before the photo was complete.');
        this.stage('closed'); break;
      }
      if (control === 0x11 && !data.length && rxNext === 0 && !this.offered) { await rr(); continue; }
      const nr = control >>> 5, ns = (control >>> 1) & 7;
      if (!(control & 1)) {
        if (lastRX && ns === ((rxNext + 7) & 7) && ns === lastRX.ns && equal(data, lastRX.data)) {
          if (++duplicateCount > 3) throw new Error('SWAN data retry limit reached.');
          this.stats.duplicates++; ack(nr, true); if (control & 0x10) await rr(); continue;
        }
        if (ns !== rxNext) throw new Error('Unexpected SWAN receive sequence.');
        ack(nr); rxNext = (rxNext + 1) & 7; lastRX = { ns, data }; duplicateCount = 0;
        if (data.length === 4 && data[0] === 0x10 && data[1] === 0xfa) {
          if (this.offered || (data[2] << 8 | data[3]) !== SWAN_RECORD_BYTES) throw new Error('Unexpected SWAN image header.');
          this.offered = true; pending.push('header'); this.stage('photos', { received: 0, total: SWAN_RECORD_BYTES });
        } else if (this.offered && data[0] === 0x11 && data.length >= 2 && data.length <= SWAN_BLOCK_BYTES + 1 && this.received.length < SWAN_RECORD_BYTES) {
          this.received = concat(this.received, data.slice(1)); this.imageBlocks++;
          if (this.received.length >= SWAN_RECORD_BYTES) pending.push('end');
          this.progress('photos', { received: Math.min(this.received.length, SWAN_RECORD_BYTES), total: SWAN_RECORD_BYTES });
        } else throw new Error('Unexpected SWAN application data.');
        if (control & 0x10) await rr();
      } else if ((control & 15) === 1 && !data.length) {
        ack(nr);
        if (!(control & 0x10)) continue;
        if (unacked) {
          if (++unacked.retries > 3) throw new Error('SWAN reply retry limit reached.');
          this.stats.retries++;
        } else if (pending.length) unacked = { ns: txNext, reason: pending.shift(), retries: 0 };
        if (unacked) {
          await this.send(address, (rxNext << 5) | (unacked.ns << 1), b(0x0d));
          if (unacked.reason === 'end') { this.endSent = true; this.stage('finishing'); }
        } else await rr();
      } else throw new Error('Unexpected SWAN link frame.');
    }
  }
  async sendPhoto(bytes) {
    checkSwanRecord(bytes); this.payload = bytes;
    this.stage('waiting-watch');
    const hello = await this.exchange(255, 0xb3, b(), f => f.address === 255 && f.control === 0xa3 && f.data.length === 4, { tries: 48 });
    await this.exchange(255, 0x93, concat(hello.data, b(7)), f => f.address === 7 && f.control === 0x63 && !f.data.length);
    this.address = 7;
    await this.exchange(7, 0x11, b(), f => f.control === 1 && !f.data.length);
    this.connected = true; this.stage('connected', { baud: SWAN_BAUD });
    const isApp = (f, ns, nr) => !(f.control & 1) && ((f.control >>> 1) & 7) === ns && (f.control >>> 5) === nr && f.data.length > 0;
    this.offered = true;
    let header = await this.exchange(7, 0x10, b(0x10, 0xfa, 0x63, 0x1d), f => ([0x21, 0x31].includes(f.control) && !f.data.length) || isApp(f, 0, 1));
    if (!isApp(header, 0, 1)) header = await this.exchange(7, 0x11, b(), f => isApp(f, 0, 1));
    if (!equal(header.data, b(0x0d))) { this.rejected = true; throw new Error('The watch refused the SWAN image offer.'); }
    let txNext = 1, final = null;
    this.stage('photos', { received: 0, total: bytes.length });
    for (let offset = 0; offset < bytes.length;) {
      const block = bytes.slice(offset, offset + SWAN_BLOCK_BYTES), next = (txNext + 1) & 7;
      const reply = await this.exchange(7, 0x30 | (txNext << 1), concat(b(0x11), block), f => {
        const nr = f.control >>> 5;
        if ((f.control & 15) === 1 && !f.data.length) {
          if (nr === txNext) return false;
          if (nr !== next) throw new Error('SWAN data acknowledgement is outside the transmit window.');
          return true;
        }
        if (isApp(f, 0, nr) && equal(f.data, b(0x0d)) && [txNext, next].includes(nr)) return nr === next;
        if (offset + block.length === bytes.length && isApp(f, 1, next) && equal(f.data, b(0x0d))) { final = f; return true; }
        throw new Error('Unexpected SWAN data acknowledgement.');
      });
      offset += block.length; this.bytesAcknowledged = offset; this.imageBlocks++; txNext = reply.control >>> 5;
      this.progress('photos', { received: offset, total: bytes.length });
    }
    this.stage('finishing');
    if (!final) final = await this.exchange(7, 0x31, b(), f => isApp(f, 1, txNext) && equal(f.data, b(0x0d)));
    this.finalAccepted = true;
    this.record('swan-photo-accepted', { bytes: bytes.length, watchStorageVerified: false });
    await this.exchange(7, 0x51, b(), f => (f.control & 15) === 1 && (f.control >>> 5) === txNext && !f.data.length);
    this.finalAckConfirmed = true;
    this.stage('disconnect');
    try {
      await this.exchange(7, 0x53, b(), f => f.control === 0x63 && !f.data.length);
      this.disconnected = true;
    } catch (error) { this.check(); this.closeError = error.message; }
  }
  async run({ direction, bytes, durationMs = 120000, signal = this.signal } = {}) {
    if (!['receive', 'send'].includes(direction) || !Number.isFinite(durationMs) || durationMs < 1 || durationMs > 180000) throw new RangeError('Invalid SWAN direction or deadline.');
    if (direction === 'send') checkSwanRecord(bytes);
    const a = this.adapter;
    if (this.used || !a.configured || a.baud !== SWAN_BAUD || a.readerTask || a.readPending) throw new Error('Prepare an idle SWAN adapter at 38400.');
    signal?.throwIfAborted(); this.used = true;
    const cancellation = new AbortController(); this.runSignal = cancellation.signal;
    const end = reason => { cancellation.abort(reason); a.close().catch(() => {}); };
    const abort = () => end(signal.reason), timer = setTimeout(() => end(new Error('SWAN transfer timed out.')), durationMs);
    signal?.addEventListener('abort', abort, { once: true });
    const started = performance.now(); let error = null;
    try { if (direction === 'send') await this.sendPhoto(bytes); else await this.receivePhoto(); }
    catch (caught) { error = { name: caught.name, message: caught.message }; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    const file = direction === 'receive' && this.received.length >= SWAN_RECORD_BYTES ? this.received.slice(0, SWAN_RECORD_BYTES) : null;
    const photoTransferComplete = direction === 'receive' ? Boolean(file && this.endSent) : Boolean(this.finalAccepted && this.finalAckConfirmed);
    const result = { direction, protocol: 'swan', baud: SWAN_BAUD,
      status: signal?.aborted ? 'interrupted' : photoTransferComplete ? direction === 'send' ? 'sent' : 'received' : 'error',
      phase: this.phase, complete: photoTransferComplete && this.disconnected && !error,
      photoTransferComplete, linkCloseConfirmed: this.disconnected, connected: this.connected,
      finalAccepted: this.finalAccepted, watchStorageVerified: false, closeError: this.closeError,
      uploadOutcome: direction !== 'send' ? null : this.finalAccepted ? 'accepted' : this.rejected ? 'rejected' : this.offered ? 'unconfirmed' : 'not-sent',
      imageBlocks: this.imageBlocks, bytesAcknowledged: this.bytesAcknowledged,
      fileCount: file ? 1 : 0, file, ...this.stats, badChecksum: this.decoder.badChecksum,
      pendingUSBRead: Boolean(a.readPending), error, elapsedMs: performance.now() - started };
    a.swanStats = result;
    this.record('swan-finished', { ...result, file: undefined }); return result;
  }
}
