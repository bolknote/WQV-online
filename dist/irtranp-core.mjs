// Standalone OTHERS SEND receiver. The SCEP profile was extracted from
// CSI Image Viewer 2.5's MIPS IrTranP.dll; lower IrDA layers use our own stack.
import { b, ascii, text, concat, equal, starts, fromHex as hx, toHex, u16, u32,
  parseCommand, makeCommand, attribute, packSCEP, pduSize, unpackSCEP, jpegFromUPF } from './formats.mjs';
import { sleep, baudMask, selectBaudRate, linkParameters } from './irda.mjs';
import { xidFrame, parseXID } from './discovery-core.mjs';
import { readSIR } from './transport.mjs';

export const CSI_PROFILE = Object.freeze({
  machineID: '0800740100000000', name: 'CASSIOPEIA', maxPDU: 4096, maxFile: 128 * 1024,
  capabilities: Object.freeze({ RIMG: '00010101028001e003c4200500000200', RINF: '10ffff11ffff', RCMD: '2000010001' }),
});
// Only the image capability response changes. This does not emulate Nokia's
// device identity, MachineIDs or the system IrCOMM driver.
export const IMAGE_CAPABILITIES = Object.freeze({
  csi: CSI_PROFILE.capabilities,
  'nokia-original': Object.freeze({ ...CSI_PROFILE.capabilities, RIMG: '0201ffffffff05ffffffff' }),
});
const BROADCAST = hx('ffffffff'), LSAP = 9;
const identity = concat(hx('842500'), ascii(CSI_PROFILE.name));
const validID = id => id.length === 4 && !equal(id, BROADCAST) && id.some(v => v);

export function csiXID(source, options) {
  const frame = xidFrame(source, options);
  if (options.response || options.slot === 255) frame.data = concat(frame.data.slice(0, 12), identity);
  return frame;
}

export function parseConnect(packet) {
  if (packet.length < 28 || !starts(packet, hx('0010000101')) || packet[6] !== 0x10 ||
      packet.length !== 10 + packet[5] || packet[5] < 18 || !equal(packet.slice(-4), hx('10020000'))) {
    throw new Error('Invalid SCEP Connect.');
  }
  const negotiation = packet.slice(24, -4), tags = Object.create(null);
  if (negotiation[0] === 0x11) {
    for (const line of text(negotiation.slice(1)).split('\r\n')) {
      const match = /^(fr|id):\s*(.*)$/.exec(line);
      if (match) tags[match[1]] = match[2];
    }
  }
  const sizes = { 1: 512, 2: 1024, 3: 2048, 4: 4096 };
  return { primaryID: packet.slice(16, 24), secondaryID: packet.slice(8, 16),
    maxPDU: sizes[tags.fr] ?? 512, name: tags.id ?? null };
}

export function csiCack(primaryID) {
  if (primaryID.length !== 8) throw new RangeError('Invalid SCEP MachineID.');
  const info = concat(hx('1004'), primaryID, hx(CSI_PROFILE.machineID), ascii('\x11fr:4\r\nid:CASSIOPEIA\r\n'));
  return concat(hx('001101'), b(info.length), info);
}

export function compactSCEP(command, maxPDU = 512) {
  return packSCEP(command, maxPDU).map(packet => u16(packet, 4) < 255 ?
    concat(packet.slice(0, 3), b(u16(packet, 4)), packet.slice(6)) : packet);
}

export function takeSCEP(buffer) {
  if (buffer.length < 4) return null;
  let size;
  if (buffer[0] === 0 && buffer[1] === 0x10) {
    if (buffer.length < 6) return null;
    size = 10 + buffer[5];
  } else if (buffer[0] === 0 && [0x11, 0x30].includes(buffer[1])) size = 4 + buffer[3];
  else size = pduSize(buffer);
  if (size === null || buffer.length < size) return null;
  if (size > CSI_PROFILE.maxPDU) throw new Error('SCEP packet exceeds the advertised receive size.');
  return { packet: buffer.slice(0, size), rest: buffer.slice(size) };
}

export function scepCommandEnds(packet) {
  const offset = packet[3] === 255 ? 6 : 4, flag = packet[offset + 1];
  if (packet[offset] !== 0x10 || ![0xc1, 0x41, 1, 0x81].includes(flag)) throw new Error('Invalid SCEP command element.');
  if (flag === 0xc1) return true;
  if (packet.length < offset + 12) throw new Error('Truncated SCEP segment header.');
  // CSI's original PUT sender uses 41/SeqNo=0/RestNo=1 for one segment.
  // A final-marker or RestNo=1 triggers full unpackSCEP validation; it is
  // not permission to ignore sequence, length, MachineID or command checks.
  return flag === 0x81 || u32(packet, offset + 8) === 1;
}

// Actual IAS names are inspected, rather than replying to queries by position.
export function csiIAS(data) {
  if (data.length < 5 || data[0] !== 0 || data[2] !== 0x84) throw new Error('Unsupported IAS request.');
  const classEnd = 4 + data[3], attrEnd = classEnd + 1 + data[classEnd];
  if (classEnd >= data.length || attrEnd !== data.length) throw new Error('Truncated IAS request.');
  const className = text(data.slice(4, classEnd)), name = text(data.slice(classEnd + 1));
  let value = null;
  if (className === 'IrDA:IrCOMM') {
    if (name === 'IrDA:TinyTP:LsapSel') value = concat(b(1, 0, 0, 0), b(LSAP));
    else if (name === 'Parameters') value = hx('020006000106010101');
    else if (name === 'IrDA:IrLMP:InstanceName') value = concat(b(3, 0, 8), ascii('IrTran-P'));
  } else if (className === 'Device' && name === 'DeviceName') {
    value = concat(b(3, 0, CSI_PROFILE.name.length), ascii(CSI_PROFILE.name));
  }
  const reply = value ? concat(b(data[1] & 127, 0, 0x84, 0, 0, 1, 0, 5), value) :
    b(data[1] & 127, 0, 0x84, className === 'IrDA:IrCOMM' || className === 'Device' ? 2 : 1, 0, 0);
  return { className, name, found: Boolean(value), reply };
}

export function csiCommand(command, capabilities = CSI_PROFILE.capabilities) {
  const request = parseCommand(command), attrs = request.attributes;
  if (request.reply || !equal(request.destination, hx(CSI_PROFILE.machineID))) throw new Error('Unexpected bFTP destination or response.');
  const options = { id: request.id, reply: 0x40, destination: request.source, source: hx(CSI_PROFILE.machineID) };
  if (equal(attrs.CMD0 ?? b(), hx('00010040'))) {
    const name = text(attrs.WHT0 ?? b());
    if (!Object.hasOwn(capabilities, name)) throw new Error('Unsupported bFTP query: ' + name);
    return { name, reply: makeCommand([attribute('BDY0', hx(capabilities[name]))], options) };
  }
  if (equal(attrs.CMD0 ?? b(), b(0, 0, 0, 0))) {
    const filename = text(attrs.FIL0 ?? b());
    if (!/^[A-Za-z0-9_-]{1,8}\.[A-Za-z0-9]{1,3}$/.test(filename)) throw new Error('Invalid received 8.3 filename.');
    const body = attrs.BDY0;
    if (!body || body.length > CSI_PROFILE.maxFile) throw new Error('Missing file body or file exceeds 128 KiB.');
    return { name: 'PUT', file: { filename, bytes: body },
      reply: makeCommand([attribute('RPL0', ascii(filename), true)], options) };
  }
  throw new Error('Unsupported bFTP command. Original bytes have been recorded.');
}

// One read at a time, transmit between reads. No background reader is started:
// release/claim cancellation of rapid empty reads can wedge Chromium's USB pipe.
export class IrTranPReceiver {
  constructor(adapter, { record = () => {}, progress = () => {}, onFile = async () => {}, signal,
    localID = crypto.getRandomValues(new Uint8Array(4)), maxBaud = 115200, imageProfile = 'csi', frameRecovery = 'auto' } = {}) {
    if (!validID(localID)) throw new RangeError('Invalid local IrDA device address.');
    if (!Object.hasOwn(IMAGE_CAPABILITIES, imageProfile)) throw new RangeError('Unknown image capability profile.');
    if (!['auto', 'strict', 'pad5', 'pad5-bof'].includes(frameRecovery)) throw new RangeError('Unknown frame recovery mode.');
    if (frameRecovery !== 'auto') {
      adapter.decoder.recoverFrames = frameRecovery !== 'strict';
      adapter.decoder.recoverBOF = frameRecovery === 'pad5-bof';
    }
    this.frameRecovery = frameRecovery;
    this.imageProfile = imageProfile;
    this.adapter = adapter; this.record = record; this.progress = progress; this.onFile = onFile; this.signal = signal;
    this.localID = localID.slice(); this.rates = baudMask(maxBaud); this.maxBaud = maxBaud;
    this.acceptingConnections = true; this.initiateConnection = false;
    this.phase = 'discovery'; this.peerID = null; this.linkAddress = null; this.peerSAP = null;
    this.vs = 0; this.vr = 0; this.unacked = null; this.outgoing = [];
    this.txCredits = 0; this.rxCredits = 0; this.creditQueued = false;
    this.application = b(); this.parts = []; this.partBytes = 0; this.files = [];
    this.peerSCEP = null; this.scepClosedAt = null; this.lastRX = -Infinity;
    this.replied = new Map(); this.slot = null; this.nextSearch = performance.now() + 500;
    this.stats = adapter.irtranpStats = { validFrames: 0, xidCommands: 0, xidResponses: 0, xidRepliesSent: 0,
      completedCycles: 0, connectionRequests: 0, duplicates: 0, retransmissions: 0, iasQueries: 0, queries: 0, files: 0, processedReads: 0 };
  }
  // Chromium can resolve USBDevice.close() without settling a pending IN.
  // Stop/deadline must end our wait independently of the USB promise. Keep
  // both handlers on that promise so a late completion/error is still captured.
  wait(promise) {
    const signal = this.runSignal ?? this.signal;
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => { cleanup(); reject(signal.reason); };
      Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }
  check() { (this.runSignal ?? this.signal)?.throwIfAborted(); }
  stage(phase) { this.phase = phase; this.record('irtranp-phase', { phase }); this.progress(phase); }
  async transmit(frame, purpose) {
    this.check(); this.adapter.assertOpen();
    const gap = (this.minimumTurnMs ?? 5) - (performance.now() - this.lastRX);
    if (gap > 0) await this.wait(sleep(gap));
    this.check(); this.adapter.assertOpen();
    this.record('frame-send-attempt', { ...frame, data: undefined, dataHex: toHex(frame.data), phase: this.phase, purpose });
    this.transmitting = true;
    try { await this.wait(this.adapter.sendFrame(frame.address, frame.control, frame.data, 11, { receive: false })); }
    finally { this.transmitting = false; }
    this.record('tx-frame', { address: frame.address, control: frame.control, dataHex: toHex(frame.data),
      phase: this.phase, purpose, baud: this.adapter.baud });
  }
  enqueue(data, { credit = false, grant = 0 } = {}) { this.outgoing.push({ data, credit, grant }); }
  queueApplication(bytes) {
    this.record('application-tx-queued', { dataHex: toHex(bytes) });
    for (let p = 0; p < bytes.length; p += this.chunkSize) {
      this.enqueue(concat(b(this.peerSAP, LSAP, 0, 0), bytes.slice(p, p + this.chunkSize)), { credit: true });
    }
  }
  async answerPoll() {
    if (this.unacked) {
      if (++this.unacked.retries > 3) throw new Error('Peer did not acknowledge an IrLAP frame.');
      this.stats.retransmissions++;
      await this.transmit(this.unacked.frame, 'irlap-retransmission'); return;
    }
    const eligible = this.outgoing.findIndex(item => !item.credit || this.txCredits > 0);
    if (eligible >= 0) {
      const item = this.outgoing.splice(eligible, 1)[0], data = item.data.slice();
      if (item.credit) {
        this.txCredits--;
        if (this.rxCredits <= 6 && !this.creditQueued) { data[2] = 6; this.rxCredits += 6; }
      }
      if (item.grant) { this.rxCredits += item.grant; this.creditQueued = false; }
      const frame = { address: this.linkAddress, control: (this.vr << 5) | 0x10 | (this.vs << 1), data };
      this.vs = (this.vs + 1) & 7; this.unacked = { frame, retries: 0 };
      await this.transmit(frame, 'secondary-response');
    } else await this.transmit({ address: this.linkAddress, control: (this.vr << 5) | 0x11, data: b() }, 'receiver-ready');
  }
  async applicationBytes(bytes) {
    this.record('application-rx', { dataHex: toHex(bytes) });
    this.application = concat(this.application, bytes);
    if (this.application.length + this.partBytes > CSI_PROFILE.maxFile + 65536) throw new Error('Application receive limit reached.');
    let next;
    while ((next = takeSCEP(this.application))) {
      this.application = next.rest;
      const packet = next.packet;
      this.record('scep-rx', { dataHex: toHex(packet) });
      if (packet[1] === 0x10) {
        if (this.peerSCEP) throw new Error('Unexpected second SCEP Connect.');
        this.peerSCEP = parseConnect(packet);
        if (this.peerSCEP.secondaryID.some(v => v) && !equal(this.peerSCEP.secondaryID, hx(CSI_PROFILE.machineID))) throw new Error('SCEP Connect is addressed to another receiver.');
        this.record('scep-peer', { name: this.peerSCEP.name, primaryMachineID: toHex(this.peerSCEP.primaryID), maxPDU: this.peerSCEP.maxPDU });
        this.queueApplication(csiCack(this.peerSCEP.primaryID)); this.stage('scep');
      } else if (packet[1] === 0x30) {
        if (this.parts.length) throw new Error('SCEP disconnected during an incomplete file.');
        this.scepClosedAt = performance.now(); this.record('scep-disconnected', { dataHex: toHex(packet) });
      } else {
        if (!this.peerSCEP) throw new Error('SCEP command arrived before Connect.');
        this.parts.push(packet); this.partBytes += packet.length;
        if (!scepCommandEnds(packet)) continue;
        const command = unpackSCEP(concat(...this.parts)); this.parts = []; this.partBytes = 0;
        if (!equal(parseCommand(command).source, this.peerSCEP.primaryID)) throw new Error('bFTP source does not match SCEP Connect.');
        const result = csiCommand(command, IMAGE_CAPABILITIES[this.imageProfile]);
        this.record('bftp-command', { name: result.name, commandHex: toHex(command) });
        if (result.file) {
          const file = { ...result.file, index: this.files.length, jpeg: null, previewError: null };
          this.record('irtranp-file', { filename: file.filename, dataHex: toHex(file.bytes), index: file.index });
          try { file.jpeg = jpegFromUPF(file.bytes); } catch (error) { file.previewError = String(error); }
          await this.wait(this.onFile(file)); this.check(); this.files.push(file); this.stats.files++;
          this.stage('file-received');
        } else this.stats.queries++;
        for (const reply of compactSCEP(result.reply, this.peerSCEP.maxPDU)) this.queueApplication(reply);
      }
    }
  }
  async payload(data) {
    if (!data.length) return;
    if (data.length >= 4 && (data[0] & 0x80)) {
      const destination = data[0] & 127, source = data[1] & 127;
      if (data[2] === 1 && destination === 0) {
        this.enqueue(b(0x80 | source, 0, 0x81, 0)); this.stage('ias'); return;
      }
      if (data[2] === 1 && destination === LSAP && data.length >= 5) {
        if (this.peerSAP !== null) throw new Error('Unexpected second IrCOMM connection.');
        if (data[4] & 0x80) throw new Error('TinyTP SAR negotiation is not implemented; original request saved.');
        this.peerSAP = source; this.txCredits = data[4] & 127; this.rxCredits = 14;
        this.enqueue(b(0x80 | source, LSAP, 0x81, 0, 14)); this.stage('ircomm'); return;
      }
      if (data[2] === 2) { this.record('irlmp-disconnect', { dataHex: toHex(data) }); return; }
      throw new Error('Unsupported IrLMP connection request.');
    }
    if (data[0] === 0 && data[2] === 0x84) {
      const result = csiIAS(data); this.stats.iasQueries++;
      this.record('ias-query', { className: result.className, name: result.name, found: result.found });
      this.enqueue(result.reply); return;
    }
    if (this.peerSAP === null || data[0] !== LSAP || data[1] !== this.peerSAP || data.length < 3) throw new Error('Unexpected IrCOMM channel.');
    this.txCredits += data[2] & 127;
    if (this.txCredits > 127 || data[2] & 0x80) throw new Error('Invalid TinyTP credits or unsupported SAR packet.');
    if (data.length === 3) return;
    if (--this.rxCredits < 0) throw new Error('Peer exceeded TinyTP receive credits.');
    const controls = data[3];
    if (data.length < 4 + controls) throw new Error('Truncated IrCOMM controls.');
    if (controls) this.record('ircomm-controls', { dataHex: toHex(data.slice(4, 4 + controls)) });
    if (data.length > 4 + controls) await this.applicationBytes(data.slice(4 + controls));
    if (this.rxCredits <= 6 && !this.creditQueued) {
      this.enqueue(b(this.peerSAP, LSAP, 6), { grant: 6 }); this.creditQueued = true;
    }
  }
  async frame(frame) {
    this.stats.validFrames++;
    this.record('rx-frame', { address: frame.address, control: frame.control, dataHex: toHex(frame.data), phase: this.phase, baud: this.adapter.baud });
    const xid = parseXID(frame);
    if (this.linkAddress === null && xid) {
      if (equal(xid.source, this.localID) || !equal(xid.destination, this.localID) && !equal(xid.destination, BROADCAST)) return;
      this.stats[xid.response ? 'xidResponses' : 'xidCommands']++;
      this.record('peer-xid', { source: toHex(xid.source), name: xid.name, slot: xid.slot, response: xid.response });
      if (!xid.response) {
        this.slot = null; this.nextSearch = performance.now() + (xid.slots + 1) * 100 + 500;
        const key = toHex(xid.source), prev = this.replied.get(key);
        if (xid.slot === 255) { this.replied.delete(key); this.nextSearch = performance.now() + 2000; }
        else {
          if (!prev || performance.now() - prev.at > 2500 || xid.slot < prev.slot) {
            await this.transmit(csiXID(this.localID, { destination: xid.source, slots: xid.slots, slot: xid.slot, response: true }), 'xid-reply');
            this.stats.xidRepliesSent++;
          }
          this.replied.set(key, { slot: xid.slot, at: performance.now() });
        }
      }
      return;
    }
    if (this.linkAddress === null && frame.address === 255 && frame.control === 0x93 && frame.data.length >= 12 &&
        equal(frame.data.slice(4, 8), this.localID) && validID(frame.data.slice(0, 4))) {
      const { baud, commonRates } = selectBaudRate(frame.data.slice(9), this.rates);
      const address = frame.data[8];
      if (address < 2 || address > 0xfc || address & 1) throw new Error('Invalid IrLAP connection address.');
      this.stats.connectionRequests++; this.peerID = frame.data.slice(0, 4); this.linkAddress = address;
      // Negotiate a payload size, but use small transmit fragments for the first experiment.
      let sizes = 1;
      for (let p = 9; p < frame.data.length; p += 2 + frame.data[p + 1]) if (frame.data[p] === 0x83) sizes = frame.data[p + 2] & 0x3f;
      if (!sizes) throw new Error('No common IrLAP data size.');
      const maxData = [64, 128, 256, 512, 1024, 2048].findLast((_, i) => sizes & (1 << i));
      this.chunkSize = Math.min(128, maxData - 4);
      const params = linkParameters(commonRates, true); params[8] = sizes;
      await this.transmit({ address, control: 0x73, data: concat(this.localID, this.peerID, params) }, 'accept-irlap');
      await this.wait(this.adapter.setSIRSpeed(baud)); this.check(); this.stage('irlap');
      this.record('irlap-connected', { peerID: toHex(this.peerID), address, baud, maxData, chunkSize: this.chunkSize }); return;
    }
    if (this.linkAddress === null || frame.address !== this.linkAddress + 1) return;
    if (frame.control === 0x53) {
      await this.transmit({ address: this.linkAddress, control: 0x73, data: b() }, 'disconnect-ua');
      // The watch may close IrLAP directly after SCEP Disconnect, without
      // acknowledging a final, data-free TinyTP credit grant. That grant
      // has no application payload to deliver on the closed connection.
      const creditOnly = item => item?.frame?.data.length === 3 && item.frame.data[0] === this.peerSAP &&
        item.frame.data[1] === LSAP && item.frame.data[2] > 0 && item.frame.data[2] < 128;
      if (this.scepClosedAt !== null && creditOnly(this.unacked)) {
        this.record('credit-retired-on-disconnect', { dataHex: toHex(this.unacked.frame.data) });
        this.unacked = null;
      }
      this.closed = true; return;
    }
    const numbered = !(frame.control & 1) || (frame.control & 3) === 1;
    if (!numbered) { this.record('ignored-link-frame', { control: frame.control }); return; }
    const nr = (frame.control >>> 5) & 7;
    if (this.unacked && nr === this.vs) this.unacked = null;
    if (!(frame.control & 1)) {
      const ns = (frame.control >>> 1) & 7;
      if (ns === this.vr) { this.vr = (this.vr + 1) & 7; await this.payload(frame.data); }
      else if (ns === (this.vr + 7) % 8) this.stats.duplicates++;
      else throw new Error('Out-of-order IrLAP frame.');
    }
    if (frame.control & 0x10) {
      if ((frame.control & 15) === 5) await this.transmit({ address: this.linkAddress, control: (this.vr << 5) | 0x11, data: b() }, 'peer-busy');
      else await this.answerPoll();
    }
  }
  async tick() {
    if (this.linkAddress !== null || performance.now() < this.nextSearch || performance.now() - this.lastRX < 100) return;
    this.slot ??= 0;
    await this.transmit(csiXID(this.localID, { slot: this.slot }), 'xid-search');
    if (this.slot === 255) { this.stats.completedCycles++; this.slot = null; this.nextSearch = performance.now() + 2000; }
    else { this.slot = this.slot === 5 ? 255 : this.slot + 1; this.nextSearch = performance.now() + 100; }
  }
  summarize(result) { return result; }
  async run(durationMs = 60000) {
    if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) throw new RangeError('Invalid receive window.');
    const a = this.adapter; this.signal?.throwIfAborted(); a.assertOpen();
    if (!a.configured || a.baud !== 9600 || a.readerTask) throw new Error('Prepare the infrared adapter at 9600 before starting.');
    if (this.runSignal) throw new Error('Start a fresh receiver for each attempt.');
    const cancellation = new AbortController(); this.runSignal = cancellation.signal;
    const started = performance.now(); this.nextSearch = started + 500;
    let ending = null, error = null;
    const end = reason => {
      if (ending) return;
      ending = reason;
      if (reason === 'deadline' && this.transmitting) {
        ending = 'error'; error = { name: 'USBTransmitTimeout', message: 'USB transmission did not complete before the receive deadline.' };
      }
      this.record('irtranp-ending', { reason: ending, pendingUSBRead: a.readPending, transmitting: Boolean(this.transmitting) });
      cancellation.abort(new DOMException('IrTran-P capture ended: ' + reason, 'AbortError'));
      a.close().catch(caught => this.record('cleanup-error', { error: String(caught) }));
    };
    const abort = () => end('interrupted');
    this.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => end('deadline'), durationMs);
    this.record('irtranp-start', { profile: { ...CSI_PROFILE, capabilities: IMAGE_CAPABILITIES[this.imageProfile] }, imageProfile: this.imageProfile,
      durationMs, localID: toHex(this.localID), maxBaud: this.maxBaud,
      localBaudMask: this.rates, acceptingConnections: this.acceptingConnections, initiateConnection: this.initiateConnection,
      frameRecovery: this.frameRecovery, transportProfile: this.transportProfile ?? 'current', linkRecovery: this.linkRecovery ?? false,
      recoverFrames: Boolean(a.decoder.recoverFrames),
      recoverBOF: Boolean(a.decoder.recoverBOF), damagedBOFMarkers: a.decoder.recoverBOF ? [0xe0, 0x81] : [] });
    this.progress('discovery');
    try {
      while (!ending && !this.closed) {
        this.signal?.throwIfAborted(); a.assertOpen();
        const frame = a.decoder.frames.shift();
        if (frame) { this.lastRX = performance.now(); await this.frame(frame); continue; }
        if (this.scepClosedAt !== null && performance.now() - this.scepClosedAt > 2000) break;
        await this.tick();
        if (ending) break;
        a.readPending = true;
        let result;
        const read = readSIR(a);
        read.then(() => { a.readPending = false; }, () => { a.readPending = false; });
        result = await this.wait(read);
        if (ending) break;
        if (result.status !== 'ok' || !result.data) throw new Error('USB receive failed: ' + result.status);
        this.stats.processedReads++;
        const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        a.rxBytes += bytes.length;
        if (bytes.length) { this.lastRX = performance.now(); a.decoder.feed(bytes); }
        else {
          a.decoder.emptyRead(a.revision === null ? 0 : a.revision <= 6 ? 1 : a.baud > 9600 ? 2 : 0);
          await this.wait(sleep(2));
        }
      }
    } catch (caught) {
      if (!ending) { ending = this.signal?.aborted ? 'interrupted' : 'error'; error = { name: caught.name, message: caught.message }; }
    } finally { clearTimeout(timer); this.signal?.removeEventListener('abort', abort); }
    const complete = Boolean(this.closed || this.scepClosedAt !== null) && !this.application.length && !this.parts.length && !this.outgoing.length && !this.unacked;
    const status = ending === 'interrupted' || ending === 'error' ? ending :
      complete && this.files.length ? 'received' : complete ? 'session-closed' : this.files.length ? 'received-incomplete-session' :
      this.linkAddress !== null ? 'session-timeout' : a.rxBytes ? 'data-no-connection' : !this.stats.processedReads ? 'usb-read-timeout' : 'no-data';
    const result = { status, phase: this.phase,
      elapsedMs: performance.now() - started, baud: a.baud, rxBytes: a.rxBytes, txFrames: a.txFrames,
      ...this.stats, badCRC: a.decoder.badCRC, recoveredFrames: a.decoder.recoveredFrames,
      recoveredBOF: a.decoder.recoveredBOF ?? 0, rejectedBOF: a.decoder.rejectedBOF ?? 0,
      complete, error, pendingBytes: this.application.length + this.partBytes };
    result.pendingUSBRead = a.readPending;
    result.fileCount = this.stats.files; result.files = this.files.map(f => ({ filename: f.filename, bytes: f.bytes.length, jpegBytes: f.jpeg?.length ?? 0, previewError: f.previewError }));
    const summary = this.summarize(result);
    this.record('irtranp-finished', summary); return summary;
  }
}
