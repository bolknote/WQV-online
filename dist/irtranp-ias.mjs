// Read-only IrLAP/IAS client. No TinyTP connection or SCEP/bFTP command.
import { IrTranPReceiver, csiXID } from './irtranp-core.mjs';
import { parseXID } from './discovery-core.mjs';
import { b, ascii, concat, equal, fromHex as hx, toHex, u16, text } from './formats.mjs';
import { linkParameters, selectBaudRate } from './irda.mjs';
import { ce211LinkParameters, negotiateCE211 } from './irtranp-wince211.mjs';

export const IAS_QUERIES = Object.freeze(['Parameters', 'IrDA:TinyTP:LsapSel', 'IrDA:IrLMP:InstanceName']);
const LOCAL_SAP = 1, BROADCAST = hx('ffffffff');

export function iasRequest(name) {
  if (!IAS_QUERIES.includes(name)) throw new RangeError('Unsupported IAS diagnostic query.');
  const cls = ascii('IrDA:IrCOMM'), attr = ascii(name);
  return concat(b(0, LOCAL_SAP, 0x84, cls.length), cls, b(attr.length), attr);
}
export function parseIAS(data) {
  if (data.length < 6 || !equal(data.slice(0, 3), b(LOCAL_SAP, 0, 0x84))) throw new Error('Unexpected IAS reply header; original bytes saved.');
  const code = data[3], count = u16(data, 4), values = [];
  if (code) return { code, found: false, rawHex: toHex(data), values };
  let pos = 6;
  for (let i = 0; i < count; i++) {
    if (pos + 3 > data.length) throw new Error('Truncated IAS value header.');
    const objectID = u16(data, pos), type = data[pos + 2], row = { objectID, type }; pos += 3;
    let size;
    if (type === 1) size = 4;
    else if (type === 2 || type === 3) {
      if (pos + 2 > data.length) throw new Error('Truncated IAS length.');
      if (type === 2) size = u16(data, pos);
      else { row.charset = data[pos]; size = data[pos + 1]; }
      pos += 2;
    } else throw new Error('Unsupported IAS type; original bytes saved.');
    if (pos + size > data.length) throw new Error('Truncated IAS value body.');
    const value = data.slice(pos, pos + size); pos += size; row.hex = toHex(value);
    if (type === 1) row.integer = new DataView(value.buffer, value.byteOffset, 4).getUint32(0);
    if (type === 3 && row.charset === 0) row.text = text(value);
    values.push(row);
  }
  if (pos !== data.length) throw new Error('Trailing IAS bytes; original bytes saved.');
  return { code: 0, found: values.length > 0, values, rawHex: toHex(data) };
}

export class IrTranPIASProbe extends IrTranPReceiver {
  constructor(adapter, options = {}) {
    super(adapter, options);
    this.transportProfile = options.transportProfile ?? 'current';
    if (!['current', 'wince211'].includes(this.transportProfile)) throw new RangeError('Unknown IrTran-P transport profile.');
    this.peerBusy = false;
    this.linkRecovery = options.linkRecovery ?? false;
    if (typeof this.linkRecovery !== 'boolean') throw new TypeError('linkRecovery must be a boolean.');
    this.linkRetryMs = 1000; this.maxLinkRetries = 3;
    this.acceptingConnections = false; this.initiateConnection = true;
    // Explicitly confined to this research client until hardware verification.
    // Captured IAS answers had E0 or 81 in place of BOF, with unchanged FCS.
    if (!options.frameRecovery || options.frameRecovery === 'auto') adapter.decoder.recoverBOF = true;
    this.selectedPeer = null; this.finalSearchSent = false;
    this.clientState = 'discovery'; this.transaction = null; this.turnIsOurs = true;
    this.iasResults = {}; this.queryIndex = 0; this.linkAccepted = false; this.disconnected = false;
    Object.assign(this.stats, { connectionAttempts: 0, iasResponses: 0, linkRecoveryPolls: 0, linkTimeouts: 0 });
  }
  async beginTransaction(payload, purpose, wantsReply = true) {
    if (this.transaction) throw new Error('A link transaction is still pending.');
    if (this.linkQoS && payload.length > this.linkQoS.dataBytes) throw new Error('Outgoing frame exceeds the negotiated IrLAP size.');
    this.transaction = { purpose, wantsReply, response: null, polls: 0, deadline: performance.now() + 4000 };
    const frame = { address: this.linkAddress + 1, control: (this.vr << 5) | 0x10 | (this.vs << 1), data: payload };
    if (this.linkRecovery) Object.assign(this.transaction, { frame: { ...frame, data: payload.slice() },
      linkAcknowledged: false, dataRetries: 0, recoveryPolls: 0 });
    this.vs = (this.vs + 1) & 7; this.turnIsOurs = false;
    await this.transmit(frame, purpose);
    if (this.linkRecovery) this.transaction.recoveryAt = performance.now() + this.linkRetryMs;
    if (purpose === 'ias-query') this.stats.iasQueries++;
  }
  async poll(purpose = 'ias-poll') {
    this.turnIsOurs = false;
    await this.transmit({ address: this.linkAddress + 1, control: (this.vr << 5) | 0x11, data: b() }, purpose);
    if (this.linkRecovery && this.transaction) this.transaction.recoveryAt = performance.now() + this.linkRetryMs;
  }
  async retryInformation(reason) {
    const pending = this.transaction;
    if (!pending?.frame || pending.linkAcknowledged || this.peerBusy) return false;
    if (pending.dataRetries >= this.maxLinkRetries) throw new Error('IrLAP information-frame retry limit reached; no new application request was created.');
    pending.dataRetries++; this.stats.retransmissions++;
    const frame = { ...pending.frame, control: (this.vr << 5) | 0x10 | (pending.frame.control & 0x0e) };
    this.record('irlap-data-retry', { reason, transaction: pending.purpose, retry: pending.dataRetries,
      sendNS: (frame.control >>> 1) & 7, receiveNR: this.vr, dataHex: toHex(frame.data), newApplicationRequest: false });
    this.turnIsOurs = false;
    await this.transmit(frame, 'irlap-data-retry');
    pending.recoveryAt = performance.now() + this.linkRetryMs;
    pending.deadline = Math.max(pending.deadline, pending.recoveryAt + 100);
    return true;
  }
  async recoverLink(now = performance.now()) {
    const pending = this.transaction;
    if (!this.linkRecovery || !pending || this.turnIsOurs || now < (pending.recoveryAt ?? Infinity)) return false;
    // As in Linux NRM_P/FINAL_TIMER_EXPIRED: retransmit outstanding I
    // frames, otherwise regain the turn with RR. Never consume credits twice.
    if (this.adapter.decoder.body?.length && now - this.lastRX < 300 && !pending.extendedReceive) {
      pending.extendedReceive = true; pending.recoveryAt = now + 300; return true;
    }
    this.stats.linkTimeouts++;
    if (await this.retryInformation('final-timeout')) return true;
    if ((pending.recoveryPolls ?? 0) >= this.maxLinkRetries) throw new Error('IrLAP final-bit recovery limit reached.');
    pending.recoveryPolls = (pending.recoveryPolls ?? 0) + 1;
    this.stats.linkRecoveryPolls++;
    if (this.csiActive) this.stats.finalPollRetries++;
    this.record('irlap-turn-retry', { transaction: pending.purpose, retry: pending.recoveryPolls,
      linkAcknowledged: Boolean(pending.linkAcknowledged), receiveNR: this.vr, newApplicationRequest: false });
    await this.poll('irlap-turn-retry');
    pending.deadline = Math.max(pending.deadline, pending.recoveryAt + 100);
    return true;
  }
  async nextQuery() {
    if (this.queryIndex < IAS_QUERIES.length) {
      this.clientState = 'query'; this.stage('ias-query');
      this.record('ias-query-attempt', { name: IAS_QUERIES[this.queryIndex] });
      await this.beginTransaction(iasRequest(IAS_QUERIES[this.queryIndex]), 'ias-query');
    } else {
      this.clientState = 'ias-disconnect'; this.stage('ias-disconnect');
      await this.beginTransaction(hx('80010201'), 'ias-lmp-disconnect', false);
    }
  }
  async completeTransaction() {
    const response = this.transaction.response; this.transaction = null;
    if (this.clientState === 'ias-connect') {
      if (!equal(response ?? b(), hx('81008100'))) throw new Error('Unexpected IAS connection confirmation; original bytes saved.');
      await this.nextQuery();
    } else if (this.clientState === 'query') {
      const name = IAS_QUERIES[this.queryIndex], result = parseIAS(response);
      this.iasResults[name] = result; this.stats.iasResponses++;
      this.record('ias-result', { name, result }); this.queryIndex++;
      await this.nextQuery();
    } else if (this.clientState === 'ias-disconnect') {
      await this.afterIAS();
    }
  }
  async afterIAS() { await this.closeIrLAP(); }
  async beforePeerDisconnect() {}
  async closeIrLAP() {
    this.clientState = 'await-disc-ua'; this.stage('disconnect'); this.phaseDeadline = performance.now() + 2000;
    await this.transmit({ address: this.linkAddress + 1, control: 0x53, data: b() }, 'ias-probe-disc');
  }
  async consumeTransactionPayload(data) {
    if (this.transaction.response !== null) throw new Error('Multiple IAS reply payloads; original frames saved.');
    this.transaction.response = data.slice();
  }
  async frame(frame) {
    this.check(); this.stats.validFrames++;
    this.record('rx-frame', { address: frame.address, control: frame.control, dataHex: toHex(frame.data), phase: this.phase, baud: this.adapter.baud });
    const xid = parseXID(frame);
    if (this.clientState === 'discovery' && xid) {
      if (equal(xid.source, this.localID) || !equal(xid.destination, this.localID) && !equal(xid.destination, BROADCAST)) return;
      this.stats[xid.response ? 'xidResponses' : 'xidCommands']++;
      this.record('peer-xid', { source: toHex(xid.source), name: xid.name, hintsHex: xid.hintsHex, slot: xid.slot, response: xid.response });
      // This explicit client probe only initiates a link to a matching watch.
      if (!this.selectedPeer && xid.response && /^CASIO WIC 241[12]\/IR$/.test(xid.name ?? '')) {
        this.selectedPeer = xid.source.slice(); this.nextSearch = performance.now() + 100;
      }
      return;
    }
    if (this.clientState === 'await-ua') {
      if (frame.address !== this.linkAddress) return;
      if (frame.control === 0x1f) throw new Error('Watch returned disconnected mode after SNRM.');
      if (frame.control !== 0x73 || !equal(frame.data.slice(0, 8), concat(this.peerID, this.localID))) return;
      const { baud } = selectBaudRate(frame.data.slice(8), this.rates);
      if (this.transportProfile === 'wince211') {
        this.linkQoS = negotiateCE211(frame.data.slice(8), this.rates);
        this.minimumTurnMs = Math.max(5, this.linkQoS.minTurnUs / 1000);
        this.record('irlap-qos-negotiated', { transportProfile: this.transportProfile, ...this.linkQoS,
          effectiveMinimumTurnMs: this.minimumTurnMs, transmittedBOFs: 11 });
      }
      this.linkAccepted = true;
      await this.wait(this.adapter.setSIRSpeed(baud)); this.check(); this.stage('irlap');
      this.record('irlap-connected', { peerID: toHex(this.peerID), address: this.linkAddress, baud, role: 'primary' });
      this.clientState = 'ias-connect'; this.stage('ias-connect');
      await this.beginTransaction(hx('80010100'), 'ias-lmp-connect'); return;
    }
    if (this.clientState === 'await-disc-ua') {
      if (frame.address !== this.linkAddress || frame.control !== 0x73 || frame.data.length) return;
      await this.wait(this.adapter.setSIRSpeed(9600)); this.check();
      this.disconnected = true; this.closed = true; this.clientState = 'done'; this.stage(this.completionPhase ?? 'ias-complete'); return;
    }
    if (!this.linkAccepted || frame.address !== this.linkAddress || !this.transaction) return;
    const ctl = frame.control;
    if (ctl === 0x53) {
      if (frame.data.length) throw new Error('Unexpected data in the watch IrLAP disconnect request.');
      // In primary role an incoming 53 is RD (Request Disconnect), not the
      // secondary's DISC command. Finish the link handshake with DISC/UA.
      // This cannot manufacture a missing SCEP/bFTP result.
      this.peerRequestedDisconnect = { phase: this.phase, address: frame.address, control: ctl };
      this.record('irlap-peer-disconnect-request', this.peerRequestedDisconnect);
      this.transaction = null; this.turnIsOurs = true;
      await this.beforePeerDisconnect();
      this.completionPhase = 'peer-requested-disconnect';
      await this.closeIrLAP(); return;
    }
    if (ctl === 0x1f) throw new Error('Watch returned IrLAP disconnected mode at ' + this.phase + '.');
    if ((ctl & 3) === 3) throw new Error('Unexpected IrLAP control during IAS.');
    const nr = (ctl >>> 5) & 7;
    if (nr !== this.vs && nr !== ((this.vs + 7) & 7)) throw new Error('Unexpected IrLAP acknowledgement during IAS.');
    this.turnIsOurs = Boolean(ctl & 0x10);
    if (this.linkRecovery) {
      if (nr === this.vs) this.transaction.linkAcknowledged = true;
      if (this.turnIsOurs) this.transaction.recoveryAt = performance.now() + this.linkRetryMs;
    }
    if (!(ctl & 1)) {
      const ns = (ctl >>> 1) & 7;
      if (ns === this.vr) {
        this.vr = (this.vr + 1) & 7;
        await this.consumeTransactionPayload(frame.data);
      } else if (ns === ((this.vr + 7) & 7)) this.stats.duplicates++;
      else if (this.linkRecovery) {
        this.record('irlap-out-of-order', { expectedNS: this.vr, receivedNS: ns });
        if (this.turnIsOurs) await this.poll('irlap-sequence-recovery');
        return;
      } else throw new Error('Out-of-order IAS IrLAP frame.');
      if (this.turnIsOurs && this.transportProfile === 'wince211' && !this.peerBusy && nr === this.vs &&
          (this.transaction.response !== null || !this.transaction.wantsReply)) {
        this.record('irlap-direct-advance', { transaction: this.transaction.purpose, receiveNR: this.vr, acknowledgedNR: nr });
        await this.completeTransaction();
      } else if (this.turnIsOurs) await this.poll('ias-reply-ack');
    } else if ((ctl & 15) === 1) {
      this.peerBusy = false;
      if (this.linkRecovery && this.turnIsOurs && nr !== this.vs && await this.retryInformation('peer-missing-frame')) return;
      if (this.turnIsOurs && nr === this.vs && (this.transaction.response !== null || !this.transaction.wantsReply)) await this.completeTransaction();
      else if (this.turnIsOurs) this.nextPollAt = performance.now() + 300;
    } else if ((ctl & 15) === 5) {
      this.peerBusy = true;
      if (this.turnIsOurs) this.nextPollAt = performance.now() + 300;
    } else if (this.linkRecovery && [9, 13].includes(ctl & 15)) {
      this.record('irlap-reject', { selective: (ctl & 15) === 13, receiveNR: nr });
      if (this.turnIsOurs && !await this.retryInformation('peer-reject')) await this.poll('irlap-reject-poll');
    } else throw new Error('Unsupported IrLAP supervisory reply during IAS.');
  }
  async tick() {
    this.check(); const now = performance.now();
    if (this.clientState === 'discovery') {
      if (!this.selectedPeer) return super.tick();
      if (now < this.nextSearch) return;
      if (!this.finalSearchSent) {
        await this.transmit(csiXID(this.localID, { slot: 255 }), 'xid-final-before-connect');
        this.stats.completedCycles++; this.finalSearchSent = true; this.nextSearch = performance.now() + 100; return;
      }
      this.peerID = this.selectedPeer; this.linkAddress = 0x70;
      this.clientState = 'await-ua'; this.stage('snrm'); this.phaseDeadline = now + 3000;
      await this.transmit({ address: 255, control: 0x93,
        data: concat(this.localID, this.peerID, b(this.linkAddress), this.transportProfile === 'wince211' ?
          ce211LinkParameters(this.rates) : this.linkRecovery ? ce211LinkParameters(this.rates) : linkParameters(this.rates)) }, 'ias-probe-snrm');
      this.stats.connectionAttempts++; return;
    }
    if (this.clientState === 'await-ua' && now >= this.phaseDeadline) throw new Error('No matching UA after SNRM; request was not repeated.');
    if (this.clientState === 'await-disc-ua' && now >= this.phaseDeadline) throw new Error('No UA after DISC; USB will be closed.');
    if (this.transaction) {
      if (await this.recoverLink(now)) return;
      if (now >= this.transaction.deadline) throw new Error('IAS request timed out; original request was not repeated.');
      if (this.turnIsOurs && now >= this.nextPollAt) {
        if (this.transaction.polls++ >= 8) throw new Error('IAS reply did not arrive after RR polling.');
        await this.poll();
      }
    }
  }
  summarize(result) {
    Object.assign(result, { test: 'ias', role: 'primary', linkAccepted: this.linkAccepted,
      disconnected: this.disconnected, ias: this.iasResults, ircommConnections: 0, applicationCommands: 0 });
    if (this.peerRequestedDisconnect) {
      result.peerRequestedDisconnect = { ...this.peerRequestedDisconnect }; result.complete = false;
    }
    if (this.disconnected && !this.peerRequestedDisconnect && this.queryIndex === IAS_QUERIES.length && !['error', 'interrupted'].includes(result.status)) result.status = 'ias-complete';
    return result;
  }
}
