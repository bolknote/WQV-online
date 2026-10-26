// Outgoing OTHERS RECEIVE experiment. Only the three CSI capability queries
// are exposed here; there is no PUT, PC-mode switch or remote watch command.
import { IrTranPIASProbe } from './irtranp-ias.mjs';
import { CE211_RECEIVE_CREDITS } from './irtranp-wince211.mjs';
import { CSI_PROFILE, compactSCEP, takeSCEP, scepCommandEnds } from './irtranp-core.mjs';
import { b, ascii, concat, equal, starts, text, fromHex as hx, toHex,
  attribute, makeCommand, parseCommand, unpackSCEP } from './formats.mjs';

export const CSI_QUERIES = Object.freeze(['RIMG', 'RINF', 'RCMD']);
const LOCAL_SAP = 9, GRANT = 14;
// Primary IrLAP final-bit recovery, confined to this outgoing research path.
// A repeated RR is safe only after the pending I frame was acknowledged.
// Never resend the application bytes: a timed-out PUT may already be stored.
const FINAL_POLL_MS = 1000, MAX_FINAL_REPOLLS = 3;
const machineID = () => hx(CSI_PROFILE.machineID);

export function csiConnect() {
  const info = concat(hx('1004'), b(0, 0, 0, 0, 0, 0, 0, 0), machineID(), ascii('\x11fr:4\r\nid:CASSIOPEIA\r\n'));
  return concat(hx('0010000101'), b(info.length), info, hx('10020000'));
}
export function csiCapabilityQuery(name, destination) {
  const id = CSI_QUERIES.indexOf(name);
  if (id < 0 || destination.length !== 8) throw new RangeError('Invalid CSI capability query.');
  return makeCommand([attribute('CMD0', hx('00010040')), attribute('WHT0', ascii(name), true)],
    { id, destination, source: machineID() });
}
export function ircommServiceTypes(parameters) {
  let services = null;
  for (let p = 0; p < parameters.length;) {
    if (p + 2 > parameters.length) throw new Error('Truncated IrCOMM IAS parameters.');
    const type = parameters[p++], size = parameters[p++];
    if (!size || p + size > parameters.length) throw new Error('Truncated IrCOMM IAS parameters.');
    if (type === 0) {
      if (size !== 1 || services !== null) throw new Error('Invalid IrCOMM service-type parameter.');
      services = parameters[p];
    }
    p += size;
  }
  if (services === null) throw new Error('IAS did not advertise an IrCOMM service type.');
  return services;
}
export function parseCSICack(packet) {
  if (!starts(packet, hx('001101')) || packet.length < 22 || packet.length !== 4 + packet[3] ||
      !equal(packet.slice(4, 6), hx('1004')) || !equal(packet.slice(6, 14), machineID()) ||
      !packet.slice(14, 22).some(v => v)) throw new Error('Invalid CSI SCEP CACK; original bytes saved.');
  const tags = Object.create(null);
  if (packet.length > 22) {
    if (packet[22] !== 0x11) throw new Error('Unsupported SCEP negotiation format.');
    for (const line of text(packet.slice(23)).split('\r\n')) {
      const match = /^(fr|id):\s*(.*)$/.exec(line);
      if (match) {
        if (Object.hasOwn(tags, match[1])) throw new Error('Duplicate SCEP negotiation field.');
        tags[match[1]] = match[2];
      }
    }
  }
  const sizes = { 1: 512, 2: 1024, 3: 2048, 4: 4096 };
  if (tags.fr && !Object.hasOwn(sizes, tags.fr)) throw new Error('Unsupported SCEP receive size.');
  return { secondaryID: packet.slice(14, 22), maxPDU: sizes[tags.fr] ?? 512, name: tags.id ?? null };
}

export class IrTranPCSIProbe extends IrTranPIASProbe {
  constructor(adapter, options = {}) {
    super(adapter, options);
    this.completionPhase = 'csi-complete'; this.csiActive = false; this.csiQueue = [];
    this.ircommConnected = false; this.scepConnected = false; this.capabilityIndex = 0; this.capabilities = {};
    Object.assign(this.stats, { ircommConnections: 0, applicationCommands: 0, capabilityResponses: 0, finalPollRetries: 0 });
  }
  async beginTransaction(payload, purpose, wantsReply = true) {
    await super.beginTransaction(payload, purpose, wantsReply);
    if (this.csiActive) Object.assign(this.transaction, {
      linkAcknowledged: false, finalPollAt: performance.now() + FINAL_POLL_MS, finalPollRetries: 0,
    });
  }
  async poll(purpose = 'ias-poll') {
    await super.poll(purpose);
    if (this.csiActive && this.transaction) {
      this.transaction.finalPollAt = performance.now() + FINAL_POLL_MS;
      if (purpose !== 'csi-final-repoll') this.transaction.finalPollRetries = 0;
    }
  }
  async frame(frame) {
    const transaction = this.transaction;
    await super.frame(frame);
    // The base handler validates address, sequence numbers and frame type.
    // Do not carry an acknowledgement into the next transaction it starts.
    if (this.csiActive && transaction && transaction === this.transaction &&
        frame.address === this.linkAddress && ((frame.control >>> 5) & 7) === this.vs) {
      transaction.linkAcknowledged = true;
    }
  }
  async afterIAS() {
    const parameters = this.iasResults.Parameters, selector = this.iasResults['IrDA:TinyTP:LsapSel'];
    if (!parameters?.found || parameters.values.length !== 1 || parameters.values[0].type !== 2 ||
        !selector?.found || selector.values.length !== 1 || selector.values[0].type !== 1 ||
        selector.values[0].objectID !== parameters.values[0].objectID) throw new Error('IAS did not identify one unambiguous IrCOMM service.');
    const services = ircommServiceTypes(hx(parameters.values[0].hex)), sap = selector.values[0].integer;
    if (!(services & 4)) throw new Error('The watch did not advertise 9-wire IrCOMM.');
    if (!Number.isInteger(sap) || sap < 1 || sap > 0x6f) throw new Error('Invalid IrCOMM TinyTP selector.');
    const grant = this.transportProfile === 'wince211' ? CE211_RECEIVE_CREDITS : GRANT;
    if (this.transportProfile === 'wince211' && !this.linkQoS) throw new Error('Missing negotiated Windows CE 2.11 transport limits.');
    this.peerSAP = sap; this.chunkSize = this.linkQoS?.applicationChunkBytes ?? 60; this.rxCredits = grant;
    this.csiActive = true; this.clientState = 'csi'; this.csiState = 'ircomm-connect'; this.csiDeadline = performance.now() + 6000;
    this.stage('csi-ircomm-connect');
    this.record('ircomm-connect-attempt', { localSAP: LOCAL_SAP, peerSAP: sap, serviceTypes: services, receiveCredits: grant,
      transportProfile: this.transportProfile, applicationChunkBytes: this.chunkSize });
    await this.beginTransaction(b(0x80 | sap, LOCAL_SAP, 1, 0, grant), 'csi-ircomm-connect');
  }
  queueCSI(bytes, purpose, controls = b()) {
    if (bytes.length) this.record('application-tx-queued', { dataHex: toHex(bytes), purpose });
    if (controls.length) this.csiQueue.push({ bytes: b(), controls, purpose });
    for (let p = 0; p < bytes.length; p += this.chunkSize) this.csiQueue.push({ bytes: bytes.slice(p, p + this.chunkSize), controls: b(), purpose });
  }
  async completeTransaction() {
    if (!this.csiActive) return super.completeTransaction();
    this.transaction = null;
    if (this.csiState === 'ircomm-connect') {
      if (!this.ircommConnected) throw new Error('Missing IrCOMM connection confirmation.');
      // Serial settings are taken from our tested PC-mode IrCOMM path. CSI's
      // DLL delegates this lower layer to the WinCE COM3 driver; its bytes
      // are not present in the extracted SCEP fixtures.
      if (this.transportProfile !== 'wince211') {
        this.queueCSI(b(), 'csi-ircomm-service', hx('000104'));
        this.queueCSI(b(), 'csi-ircomm-settings', hx('10040000258011010320010c'));
      }
      this.queueCSI(csiConnect(), 'csi-scep-connect'); this.csiState = 'await-cack';
      this.csiDeadline = performance.now() + 6000; this.stage('csi-scep-connect');
    } else if (this.csiState === 'ircomm-disconnect') {
      this.csiActive = false; await this.closeIrLAP(); return;
    }
    await this.advanceCSI();
  }
  async advanceCSI() {
    if (!this.csiQueue.length && ['cack-received', 'capability-received'].includes(this.csiState)) {
      if (this.capabilityIndex < CSI_QUERIES.length) {
        const name = CSI_QUERIES[this.capabilityIndex], command = csiCapabilityQuery(name, this.peerSCEP.secondaryID);
        this.record('bftp-query-queued', { name, commandHex: toHex(command) });
        for (const packet of compactSCEP(command, this.peerSCEP.maxPDU)) this.queueCSI(packet, 'csi-' + name);
        this.stats.applicationCommands++; this.stats.queries++; this.csiState = 'await-capability';
        this.csiDeadline = performance.now() + 6000; this.stage('csi-capabilities');
      } else {
        await this.afterCapabilities();
      }
    }
    const grant = this.transportProfile === 'wince211' ?
      this.rxCredits === 0 ? CE211_RECEIVE_CREDITS : 0 : this.rxCredits <= 6 ? 6 : 0;
    if (this.csiQueue.length && this.txCredits > 0) {
      const item = this.csiQueue.shift(); this.txCredits--; this.rxCredits += grant;
      await this.beginTransaction(concat(b(this.peerSAP, LOCAL_SAP, grant, item.controls.length), item.controls, item.bytes), item.purpose, false);
    } else if (grant) {
      // A credit grant does not consume a TinyTP data credit, even while a
      // queued application fragment is waiting for the peer's next grant.
      this.rxCredits += grant;
      await this.beginTransaction(b(this.peerSAP, LOCAL_SAP, grant), 'csi-credit-grant', false);
    } else if (!this.csiQueue.length && this.csiState === 'scep-disconnect') {
      this.csiState = 'ircomm-disconnect'; this.stage('csi-ircomm-disconnect');
      await this.beginTransaction(b(0x80 | this.peerSAP, LOCAL_SAP, 2, 1), 'csi-ircomm-disconnect', false);
    } else {
      this.transaction = { purpose: 'csi-wait', response: null, wantsReply: false, polls: 0, deadline: this.csiDeadline,
        linkAcknowledged: true, finalPollRetries: 0, recoveryPolls: 0, recoveryAt: performance.now() + this.linkRetryMs };
      this.turnIsOurs = true; this.nextPollAt = performance.now() + 150;
    }
  }
  async afterCapabilities() { this.disconnectSCEP(); }
  async beforePeerDisconnect() {
    // The peer has withdrawn the connection. Preserve the original queued
    // bytes in the journal, but send no more data or extra file requests.
    this.withheldOutputBytes = this.csiQueue.reduce((n, item) => n + item.bytes.length + item.controls.length, 0);
    this.record('csi-output-withheld', { reason: 'peer-requested-disconnect', bytes: this.withheldOutputBytes });
    this.csiQueue = []; this.csiActive = false;
  }
  disconnectSCEP(packet = hx('0030200100')) {
    this.queueCSI(packet, 'csi-scep-disconnect'); this.csiState = 'scep-disconnect'; this.stage('csi-scep-disconnect');
  }
  async additionalSCEPPacket() {
    throw new Error('Unexpected SCEP packet during CSI capability test; original bytes saved.');
  }
  async consumeTransactionPayload(data) {
    if (!this.csiActive) return super.consumeTransactionPayload(data);
    if (data.length >= 4 && (data[0] & 0x80)) {
      if ((data[0] & 127) !== LOCAL_SAP || data[1] !== this.peerSAP) throw new Error('Unexpected IrLMP service in CSI session.');
      if (data[2] === 2) throw new Error('Watch disconnected IrCOMM; original reason saved.');
      if (this.csiState !== 'ircomm-connect' || this.ircommConnected || data[2] !== 0x81 || data[3] !== 0 || data.length !== 5) {
        throw new Error('Unexpected IrCOMM connection confirmation.');
      }
      if (data[4] & 0x80) throw new Error('TinyTP SAR negotiation is not implemented; original confirmation saved.');
      this.txCredits = data[4]; this.ircommConnected = true; this.stats.ircommConnections++;
      this.transaction.response = data.slice(); this.stage('ircomm'); return;
    }
    if (!this.ircommConnected || data.length < 3 || data[0] !== LOCAL_SAP || data[1] !== this.peerSAP) throw new Error('Unexpected CSI IrCOMM data channel.');
    if (data[2] & 0x80) throw new Error('TinyTP SAR data is not implemented; original frame saved.');
    this.txCredits += data[2];
    if (this.txCredits > 127) throw new Error('Invalid TinyTP credit count.');
    if (data.length === 3) return;
    if (--this.rxCredits < 0) throw new Error('Watch exceeded TinyTP receive credits.');
    const controls = data[3];
    if (data.length < 4 + controls) throw new Error('Truncated CSI IrCOMM controls.');
    if (controls) this.record('ircomm-controls', { dataHex: toHex(data.slice(4, 4 + controls)) });
    if (data.length > 4 + controls) await this.applicationBytes(data.slice(4 + controls));
  }
  async applicationBytes(bytes) {
    this.record('application-rx', { dataHex: toHex(bytes) }); this.application = concat(this.application, bytes);
    if (this.application.length + this.partBytes > 65536) throw new Error('CSI capability response exceeds the diagnostic limit.');
    let next;
    while ((next = takeSCEP(this.application))) {
      this.application = next.rest; const packet = next.packet;
      this.record('scep-rx', { dataHex: toHex(packet) });
      if (packet[1] === 0x11 && this.csiState === 'await-cack') {
        this.peerSCEP = parseCSICack(packet); this.scepConnected = true; this.csiState = 'cack-received';
        this.record('scep-peer', { name: this.peerSCEP.name, secondaryMachineID: toHex(this.peerSCEP.secondaryID), maxPDU: this.peerSCEP.maxPDU });
      } else if (packet[1] === 0x30 && this.csiState === 'scep-disconnect') {
        this.record('scep-disconnected', { dataHex: toHex(packet) });
      } else if (packet[1] === 0x20 && this.csiState === 'await-capability') {
        this.parts.push(packet); this.partBytes += packet.length;
        if (!scepCommandEnds(packet)) continue;
        const command = unpackSCEP(concat(...this.parts)), result = parseCommand(command);
        this.parts = []; this.partBytes = 0;
        if (result.id !== this.capabilityIndex || ![0x40, 0x80].includes(result.reply) ||
            !equal(result.destination, machineID()) || !equal(result.source, this.peerSCEP.secondaryID)) throw new Error('CSI capability reply identity does not match its request.');
        const name = CSI_QUERIES[this.capabilityIndex++];
        this.capabilities[name] = { reply: result.reply, attributes: Object.fromEntries(Object.entries(result.attributes).map(([k, v]) => [k, toHex(v)])), commandHex: toHex(command) };
        this.stats.capabilityResponses++; this.csiState = 'capability-received';
        this.record('bftp-result', { name, ...this.capabilities[name] });
      } else await this.additionalSCEPPacket(packet);
    }
  }
  async tick() {
    if (!this.csiActive) return super.tick();
    this.check(); const now = performance.now();
    if (await this.recoverLink(now)) return;
    if (now >= this.csiDeadline || this.transaction && now >= this.transaction.deadline) throw new Error('CSI test timed out at ' + this.phase + '; application requests were not repeated.');
    const pending = this.transaction;
    if (!this.linkRecovery && pending?.linkAcknowledged && !this.turnIsOurs && now >= pending.finalPollAt &&
        now - this.lastRX >= FINAL_POLL_MS && pending.finalPollRetries < MAX_FINAL_REPOLLS) {
      pending.finalPollRetries++; this.stats.finalPollRetries++;
      this.record('irlap-final-repoll', { transaction: pending.purpose, retry: pending.finalPollRetries,
        expectedNR: this.vs, receiveNR: this.vr, applicationBytesRepeated: false });
      await this.poll('csi-final-repoll'); return;
    }
    if (this.transaction && this.turnIsOurs && now >= this.nextPollAt) await this.poll('csi-poll');
  }
  summarize(result) {
    Object.assign(result, { test: 'csi', role: 'primary', linkAccepted: this.linkAccepted, disconnected: this.disconnected,
      ias: this.iasResults, ircommConnections: this.stats.ircommConnections, peerSAP: this.peerSAP,
      transportProfile: this.transportProfile, linkQoS: this.linkQoS ?? null,
      linkRecovery: { enabled: this.linkRecovery, window: 1, retryMs: this.linkRetryMs, maxRetries: this.maxLinkRetries },
      scepConnected: this.scepConnected, capabilities: this.capabilities, applicationCommands: this.stats.applicationCommands,
      pendingOutputBytes: this.csiQueue.reduce((n, item) => n + item.bytes.length + item.controls.length, 0) });
    if (result.pendingOutputBytes) result.complete = false;
    if (this.peerRequestedDisconnect) {
      result.peerRequestedDisconnect = { ...this.peerRequestedDisconnect };
      result.withheldOutputBytes = this.withheldOutputBytes; result.complete = false;
    }
    if (this.disconnected && !this.peerRequestedDisconnect && this.capabilityIndex === CSI_QUERIES.length && !['error', 'interrupted'].includes(result.status)) result.status = 'csi-complete';
    return result;
  }
}
