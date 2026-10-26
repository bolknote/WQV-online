// OTHERS RECEIVE sender. bFTP PUT and SCEP segmentation match offline
// execution of CSI Image Viewer 2.5. A 512-byte segmented upload to WQV-3
// completed at 9600 and 115200 bit/s; multiple PUT remains unconfirmed.
import { IrTranPCSIProbe } from './irtranp-csi.mjs';
import { CSI_PROFILE, scepCommandEnds } from './irtranp-core.mjs';
import { metadataPutCommand, cancellationPDU } from './irtranp-metadata.mjs';
import { b, concat, be16, be32, u16, u32, fromHex as hx, toHex, text, equal,
  putCommand, parseCommand, unpackSCEP, jpegFromUPF, checkWatchJPEG } from './formats.mjs';

const MACHINE = hx(CSI_PROFILE.machineID);
export const PUT_ERRORS = Object.freeze({
  0: 'Undefined error', 1: 'Illegal data', 2: 'Unsupported PID', 0x10: 'Illegal attribute',
  0x11: 'Unsupported command', 0x20: 'File system full', 0x21: 'No corresponding file or directory',
  0x30: 'Low battery', 0x31: 'Command aborted',
});

export function validateSendFile(bytes, filename) {
  if (!(bytes instanceof Uint8Array) || bytes.length > CSI_PROFILE.maxFile) throw new Error('Choose a watch UPF file of at most 128 KiB.');
  if (!/^[A-Z0-9_-]{8}\.UPF$/i.test(filename)) throw new Error('Use an eight-character ASCII filename with the .UPF extension.');
  checkWatchJPEG(jpegFromUPF(bytes));
  return { filename, bytes: bytes.slice() };
}

// Unlike the generic builder, CSI emits 41/SeqNo=0/RestNo=1 for a PUT
// that fits in one PDU. This is reproduced from the original sender worker,
// not inferred from the flag names. No file bytes or JPEG data are rewritten.
export function csiPutPackets(command, maxPDU = 512) {
  if (![512, 1024, 2048, 4096].includes(maxPDU)) throw new RangeError('Invalid CSI PUT PDU size.');
  const capacity = maxPDU - 18, count = Math.ceil(command.length / capacity), packets = [];
  for (let n = 0; n < count; n++) {
    const chunk = command.slice(n * capacity, (n + 1) * capacity);
    const flag = n === 0 ? 0x41 : n === count - 1 ? 0x81 : 1;
    const info = concat(b(0x10, flag), be16(chunk.length), be32(n), be32(count - n), chunk);
    packets.push(concat(b(0, 0x20, 3, 255), be16(info.length), info));
  }
  return packets;
}

export function parseSendCapabilities(capabilities) {
  const body = name => {
    const reply = capabilities[name];
    if (reply?.reply !== 0x40 || typeof reply.attributes?.BDY0 !== 'string') throw new Error('A positive ' + name + ' reply is required before PUT.');
    return hx(reply.attributes.BDY0);
  };
  const image = body('RIMG'), info = body('RINF'), commands = body('RCMD');
  const result = { maxFileBytes: 128 * 1024, originalSize: null, acceptedSizes: null,
    originalSampling: null, acceptedSampling: null,
    memoryKiB: null, batteryMinutes: null, multiplePUT: false, vendorImageDataHex: null };
  let p = 0;
  const need = (data, offset, n) => { if (offset + n > data.length) throw new Error('Truncated IrTran-P capability value.'); };
  while (p < image.length) {
    const tag = image[p++]; let size;
    if (tag === 0 || tag === 3) size = 2;
    else if (tag === 1 || tag === 5) size = 4;
    else if (tag === 2 || tag === 4) { need(image, p, 1); size = 1 + image[p] * (tag === 2 ? 4 : 2); }
    else if (tag === 0xfe || tag === 0xff) { result.vendorImageDataHex = toHex(image.slice(p - 1)); break; }
    else throw new Error('Unknown RIMG tag; original capability bytes saved.');
    need(image, p, size);
    if (tag === 1) result.originalSize = [u16(image, p), u16(image, p + 2)];
    if (tag === 2) result.acceptedSizes = Array.from({ length: image[p] }, (_, i) => [u16(image, p + 1 + i * 4), u16(image, p + 3 + i * 4)]);
    if (tag === 3) result.originalSampling = u16(image, p);
    if (tag === 4) result.acceptedSampling = Array.from({ length: image[p] }, (_, i) => u16(image, p + 1 + i * 2));
    if (tag === 5) result.maxFileBytes = u32(image, p) === 0xffffffff ? null : u32(image, p) * 256;
    p += size;
  }
  for (p = 0; p < info.length; p += 3) {
    need(info, p, 3); const value = u16(info, p + 1);
    if (info[p] === 0x10) result.memoryKiB = value === 0xffff ? null : value;
    else if (info[p] === 0x11) result.batteryMinutes = value === 0xffff ? null : value;
    else throw new Error('Unknown RINF tag; original capability bytes saved.');
  }
  if (commands.length) {
    need(commands, 0, 3);
    const count = u16(commands, 1);
    if (commands[0] !== 0x20 || commands.length !== 3 + count * 2) throw new Error('Invalid RCMD function list.');
    for (p = 3; p < commands.length; p += 2) if (u16(commands, p) === 1) result.multiplePUT = true;
  }
  return result;
}

export function parsePutReply(command, { id, destination, source }) {
  const reply = parseCommand(command);
  if (reply.id !== id || !equal(reply.destination, destination) || !equal(reply.source, source)) throw new Error('PUT reply identity does not match its request.');
  if (u16(command, 22) !== 8 || u16(command, 24) !== 8) throw new Error('Invalid bFTP protocol identifier in PUT reply.');
  if (Object.keys(reply.attributes).length !== 1) throw new Error('Invalid PUT reply attribute count.');
  const wanted = reply.reply === 0x80 ? 'ERR0' : 'RPL0';
  for (let p = 30; p < command.length; p += 8 + u32(command, p + 4)) {
    if (text(command.slice(p, p + 4)) === wanted && (command[p + 8] !== +(wanted === 'RPL0') || command[p + 9] !== 0)) {
      throw new Error('Invalid PUT reply attribute type or flag.');
    }
  }
  if (reply.reply === 0x80) {
    const error = reply.attributes.ERR0;
    if (!error || error.length !== 2) throw new Error('Invalid PUT error reply.');
    const code = u16(error);
    return { accepted: false, errorCode: code, errorMessage: PUT_ERRORS[code] ?? 'Reserved error code', commandHex: toHex(command) };
  }
  if (reply.reply !== 0x40 || !Object.hasOwn(reply.attributes, 'RPL0') ||
      reply.attributes.RPL0.length > 255 || reply.attributes.RPL0.some(v => v < 32 || v > 126)) throw new Error('PUT reply has no valid stored filename.');
  return { accepted: true, storedFilename: text(reply.attributes.RPL0), commandHex: toHex(command) };
}

export class IrTranPSender extends IrTranPCSIProbe {
  constructor(adapter, options = {}) {
    super(adapter, { ...options, linkRecovery: options.linkRecovery ?? true });
    this.sendFile = validateSendFile(options.sendFile?.bytes, options.sendFile?.filename);
    this.copyCount = options.copyCount ?? 1; this.sendPDU = options.sendPDU ?? 512;
    if (![1, 2].includes(this.copyCount)) throw new RangeError('Choose one or two manually requested copies.');
    if (![0, 512].includes(this.sendPDU)) throw new RangeError('Choose 512 bytes or the peer SCEP limit.');
    this.interPutDelayMs = options.interPutDelayMs ?? 0;
    if (!Number.isInteger(this.interPutDelayMs) || this.interPutDelayMs < 0 || this.interPutDelayMs > 5000 ||
        this.interPutDelayMs && this.copyCount !== 2) throw new RangeError('A pause between two PUTs must be 0–5000 milliseconds.');
    this.interPutGaps = []; this.interPutWait = null;
    this.sendFiles = (options.sendFiles ?? [options.sendFile]).map(file => ({ ...validateSendFile(file.bytes, file.filename),
      transferMetadata: structuredClone(file.transferMetadata ?? {}) }));
    if (![1, this.copyCount].includes(this.sendFiles.length)) throw new Error('File count does not match the selected number of PUTs.');
    this.abortMode = options.abortMode ?? 'none';
    if (!['none', 'stp', 'abt'].includes(this.abortMode) || this.abortMode !== 'none' && this.copyCount !== 1) throw new Error('Cancellation tests require one file.');
    this.cancellation = null;
    this.putReplies = []; this.putRequests = 0; this.uploadActive = false; this.policyRejection = null;
    this.completionPhase = 'send-complete';
    Object.assign(this.stats, { putRequests: 0, putAccepted: 0, putRejected: 0, putSegments: 0 });
  }
  async afterCapabilities() {
    const peer = this.sendCapabilities = parseSendCapabilities(this.capabilities);
    this.record('send-capabilities', peer);
    if (peer.maxFileBytes !== null && this.sendFiles.some(file => file.bytes.length > peer.maxFileBytes)) this.policyRejection = 'File exceeds the peer receive limit.';
    else if (peer.memoryKiB === 0) this.policyRejection = 'Peer reports no receive memory.';
    else if (peer.batteryMinutes === 0) this.policyRejection = 'Peer reports a low battery.';
    else if (peer.acceptedSampling && !peer.acceptedSampling.includes(0xc420)) this.policyRejection = 'Peer does not accept JPEG 4:2:0.';
    else if (this.copyCount > 1 && !peer.multiplePUT) this.policyRejection = 'Peer did not advertise multiple PUT operations.';
    if (this.policyRejection) {
      this.record('put-not-sent', { reason: this.policyRejection }); this.disconnectSCEP(hx('003020020001')); return;
    }
    // Casio documents sending back the original watch image. RIMG's generic
    // accepted-size list need not include 176x144; preserve that discrepancy
    // as evidence instead of claiming a positive size negotiation.
    this.record('original-watch-image', { width: 176, height: 144,
      explicitlyAdvertisedSize: Boolean(peer.acceptedSizes?.some(([w, h]) => w === 176 && h === 144)) });
    this.uploadActive = true; this.queuePUT();
  }
  queuePUT() {
    const id = 3 + this.putRequests, file = this.sendFiles[this.sendFiles.length === 1 ? 0 : this.putRequests];
    const command = metadataPutCommand(file, { id, destination: this.peerSCEP.secondaryID, source: MACHINE });
    const maxPDU = this.sendPDU || this.peerSCEP.maxPDU;
    const packets = csiPutPackets(command, Math.min(maxPDU, this.peerSCEP.maxPDU));
    this.putID = id; this.putRequests++; this.stats.putRequests++;
    this.record('put-started', { id, copy: this.putRequests, copyCount: this.copyCount,
      filename: file.filename, fileBytes: file.bytes.length, scepMaxPDU: Math.min(maxPDU, this.peerSCEP.maxPDU), segments: packets.length });
    const chosen = this.abortMode === 'stp' ? packets.slice(0, 1) : packets;
    if (this.abortMode === 'stp' && packets.length < 2) throw new Error('Stop test needs a segmented PUT; no file request was sent.');
    for (const packet of chosen) this.queueCSI(packet, 'csi-put');
    if (this.abortMode !== 'none') {
      this.cancellation = { mode: this.abortMode, id, sent: false, skipped: false, responses: [],
        queuedSegments: chosen.length, totalSegments: packets.length };
      this.queueCSI(cancellationPDU(this.abortMode, { id, destination: this.peerSCEP.secondaryID, source: MACHINE }), 'csi-cancel');
      this.record('scep-cancel-planned', this.cancellation);
    }
    this.stats.putSegments += chosen.length; this.stats.applicationCommands++;
    this.csiState = 'await-put'; this.csiDeadline = performance.now() + 15000; this.stage('send-put');
  }
  async advanceCSI() {
    if (!this.csiQueue.length && this.csiState === 'put-received') {
      if (this.putReplies.at(-1).accepted && this.putRequests < this.copyCount) {
        if (this.interPutDelayMs) {
          const startedAt = this.lastPutReplyAt;
          this.interPutWait = { afterCommandID: this.putID, nextCommandID: this.putID + 1,
            requestedMs: this.interPutDelayMs, startedAt, notBefore: startedAt + this.interPutDelayMs,
            polls: 0, completed: false, elapsedMs: null };
          this.interPutGaps.push(this.interPutWait);
          this.record('put-gap-started', { afterCommandID: this.putID, nextCommandID: this.putID + 1,
            requestedMs: this.interPutDelayMs, connectionKeptOpen: true });
          this.csiState = 'between-put'; this.csiDeadline = this.interPutWait.notBefore + 6000;
          this.stage('send-between-put');
        } else this.queuePUT();
      }
      else this.disconnectSCEP(hx('003020020001'));
    }
    if (this.csiState === 'between-put' && performance.now() >= this.interPutWait.notBefore) {
      const gap = this.interPutWait;
      gap.elapsedMs = performance.now() - gap.startedAt; gap.completed = true;
      this.record('put-gap-ended', { afterCommandID: gap.afterCommandID, nextCommandID: gap.nextCommandID,
        requestedMs: gap.requestedMs, elapsedMs: gap.elapsedMs, polls: gap.polls });
      this.interPutWait = null; this.queuePUT();
    }
    // The normal CSI wait state polls IrLAP and services TinyTP credits.
    // Do not sleep here: that would leave the half-duplex connection idle.
    await super.advanceCSI();
  }
  async poll(purpose) {
    await super.poll(purpose);
    if (this.interPutWait) {
      this.interPutWait.polls++;
      this.record('put-gap-poll', { afterCommandID: this.interPutWait.afterCommandID,
        nextCommandID: this.interPutWait.nextCommandID, poll: this.interPutWait.polls,
        elapsedMs: performance.now() - this.interPutWait.startedAt, purpose });
    }
  }
  async completeTransaction() {
    if (this.transaction?.purpose === 'csi-put') this.csiDeadline = performance.now() + 15000;
    if (this.transaction?.purpose === 'csi-cancel') {
      this.cancelObserveUntil = performance.now() + 1200;
      this.csiState = 'cancel-observe'; this.csiDeadline = this.cancelObserveUntil + 4000;
    }
    await super.completeTransaction();
  }
  async beginTransaction(payload, purpose, wantsReply = true) {
    await super.beginTransaction(payload, purpose, wantsReply);
    if (purpose === 'csi-cancel') {
      this.cancellation.sent = true; this.record('scep-cancel-transmitted', { ...this.cancellation }); this.stage('send-cancel-observe');
    }
  }
  async additionalSCEPPacket(packet) {
    if (this.cancellation?.sent && packet[1] === 0x30) {
      this.record('scep-cancel-peer-disconnect', { dataHex: toHex(packet) });
      this.cancellation.peerSCEPDisconnect = toHex(packet); return;
    }
    if (packet[1] !== 0x20 || !['await-put', 'cancel-observe'].includes(this.csiState)) return super.additionalSCEPPacket(packet);
    const offset = packet[3] === 255 ? 6 : 4;
    if (this.cancellation?.sent && packet[offset + 1] === 0xc2) {
      this.parts = []; this.partBytes = 0;
      this.cancellation.responses.push({ kind: 'stop', dataHex: toHex(packet) });
      this.record('scep-cancel-response', this.cancellation.responses.at(-1)); return;
    }
    this.parts.push(packet); this.partBytes += packet.length;
    if (!scepCommandEnds(packet)) return;
    const command = unpackSCEP(concat(...this.parts)); this.parts = []; this.partBytes = 0;
    const reply = parsePutReply(command, { id: this.putID, destination: MACHINE, source: this.peerSCEP.secondaryID });
    // A reply arriving before all file fragments have gone out is not proof
    // of a complete upload. Reject such a positive response.
    if (this.cancellation?.sent || this.abortMode === 'stp') {
      this.cancellation.responses.push(reply); this.record('scep-cancel-response', reply);
      // A partial request followed by Stop is not a successful complete PUT,
      // even if an unexpected positive response arrives from the peer.
      if (this.abortMode === 'stp') return;
    } else if (this.cancellation && this.csiQueue.every(item => item.purpose === 'csi-cancel')) {
      this.csiQueue = []; this.cancellation.skipped = true;
      this.record('scep-cancel-too-late', { reason: 'PUT reply arrived before cancellation was sent', reply });
    }
    if (reply.accepted && this.csiQueue.length) throw new Error('Premature positive PUT reply while file output is still queued.');
    this.putReplies.push({ id: this.putID, copy: this.putRequests, ...reply });
    this.stats[reply.accepted ? 'putAccepted' : 'putRejected']++;
    this.lastPutReplyAt = performance.now();
    this.record('put-reply', this.putReplies.at(-1));
    if (!reply.accepted) this.csiQueue = []; // Do not continue a rejected transfer or retry the PUT.
    this.csiState = 'put-received'; this.csiDeadline = performance.now() + 6000;
    this.stage(reply.accepted ? 'send-accepted' : 'send-rejected');
  }
  async tick() {
    if (this.csiState === 'cancel-observe' && performance.now() >= this.cancelObserveUntil &&
        this.transaction?.purpose === 'csi-wait' && this.turnIsOurs) {
      this.transaction = null;
      if (this.parts.length) {
        this.record('scep-cancel-incomplete-reply', { bytes: this.partBytes });
        throw new Error('Cancellation left an incomplete application reply; original bytes retained.');
      }
      this.disconnectSCEP(hx('003020020001')); await this.advanceCSI(); return;
    }
    await super.tick();
  }
  summarize(result) {
    super.summarize(result);
    Object.assign(result, { test: 'sender', requestedCopies: this.copyCount, putRequests: this.putRequests,
      interPutDelayMs: this.interPutDelayMs,
      interPutGaps: this.interPutGaps.map(gap => ({ afterCommandID: gap.afterCommandID, nextCommandID: gap.nextCommandID,
        requestedMs: gap.requestedMs, elapsedMs: gap.elapsedMs ?? performance.now() - gap.startedAt,
        polls: gap.polls, completed: gap.completed })),
      putReplies: this.putReplies, sendCapabilities: this.sendCapabilities ?? null, policyRejection: this.policyRejection,
      uploadOutcome: this.putReplies.length === this.copyCount && this.putReplies.every(r => r.accepted) ? 'accepted' :
        this.putReplies.some(r => !r.accepted) || this.policyRejection ? 'rejected' : this.putRequests ? 'unconfirmed' : 'not-sent' });
    if (this.cancellation) result.cancellation = structuredClone(this.cancellation);
    if (!['error', 'interrupted'].includes(result.status)) {
      result.status = !result.complete || !this.disconnected ? (result.uploadOutcome === 'accepted' ? 'sent-incomplete-session' : 'send-incomplete') :
        result.uploadOutcome === 'accepted' ? 'sent' : result.uploadOutcome === 'rejected' ? 'send-rejected' : 'send-incomplete';
      if (this.cancellation?.sent && result.complete && this.disconnected) result.status = 'cancel-observed';
    }
    return result;
  }
}
