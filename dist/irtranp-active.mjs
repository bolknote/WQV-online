// Open the advertised IrCOMM service, then receive. No outgoing SCEP Connect,
// capability query, GET or PUT. Nokia's library starts with a serial read;
// our IrDA stack supplies the connection, with CSI identity retained.
import { IrTranPCSIProbe } from './irtranp-csi.mjs';
import { IrTranPReceiver } from './irtranp-core.mjs';
import { b, concat, fromHex as hx, toHex } from './formats.mjs';

const LOCAL_SAP = 9, IDLE_MS = 12000;

export class IrTranPActiveReceiver extends IrTranPCSIProbe {
  constructor(adapter, options = {}) {
    super(adapter, options);
    this.completionPhase = 'active-receiver-complete';
    this.peerSCEPClosed = false; this.peerIrcommClosed = false;
    this.closing = false; this.idleTimeout = false; this.disconnectQueued = false;
  }
  queueApplication(bytes) { this.queueCSI(bytes, 'active-receiver-reply'); }
  async completeTransaction() {
    if (!this.csiActive) return super.completeTransaction();
    this.transaction = null;
    if (this.csiState === 'ircomm-connect') {
      if (!this.ircommConnected) throw new Error('Missing IrCOMM connection confirmation.');
      // These controls are from our working stack, not recovered Nokia driver
      // bytes. Keep them identical to the outgoing CSI test for comparison.
      this.queueCSI(b(), 'active-ircomm-service', hx('000104'));
      this.queueCSI(b(), 'active-ircomm-settings', hx('10040000258011010320010c'));
      this.csiState = 'waiting-connect'; this.csiDeadline = performance.now() + IDLE_MS;
      this.stage('active-wait-scep');
      this.record('receiver-waiting', { imageProfile: this.imageProfile, outgoingSCEPConnect: false, idleTimeoutMs: IDLE_MS });
    } else if (this.csiState === 'ircomm-disconnect' || this.peerIrcommClosed) {
      this.csiActive = false; await this.closeIrLAP(); return;
    }
    await this.advanceCSI();
  }
  async advanceCSI() {
    if (this.peerIrcommClosed) { this.csiActive = false; await this.closeIrLAP(); return; }
    if (!this.csiQueue.length && this.closing) {
      if (this.peerSCEP && !this.peerSCEPClosed && !this.disconnectQueued) {
        this.queueCSI(hx('0030200100'), 'active-scep-disconnect'); this.disconnectQueued = true;
      } else {
        this.csiState = 'ircomm-disconnect'; this.csiDeadline = performance.now() + 4000;
        this.stage('active-ircomm-disconnect');
        await this.beginTransaction(b(0x80 | this.peerSAP, LOCAL_SAP, 2, 1), 'active-ircomm-disconnect', false); return;
      }
    }
    const grant = this.rxCredits <= 6 ? 6 : 0;
    if (this.csiQueue.length && this.txCredits > 0) {
      const item = this.csiQueue.shift(); this.txCredits--; this.rxCredits += grant;
      await this.beginTransaction(concat(b(this.peerSAP, LOCAL_SAP, grant, item.controls.length), item.controls, item.bytes), item.purpose, false);
    } else if (grant) {
      this.rxCredits += grant;
      await this.beginTransaction(b(this.peerSAP, LOCAL_SAP, grant), 'active-credit-grant', false);
    } else {
      this.transaction = { purpose: 'active-receive-wait', response: null, wantsReply: false, polls: 0, deadline: this.csiDeadline };
      this.turnIsOurs = true; this.nextPollAt = performance.now() + 150;
    }
  }
  async consumeTransactionPayload(data) {
    if (this.csiActive && data.length >= 4 && (data[0] & 0x80) &&
        (data[0] & 127) === LOCAL_SAP && data[1] === this.peerSAP && data[2] === 2) {
      if (!this.ircommConnected) throw new Error('Peer rejected the IrCOMM connection.');
      this.record('irlmp-disconnect', { dataHex: toHex(data) });
      this.peerIrcommClosed = true; this.closing = true; return;
    }
    return super.consumeTransactionPayload(data);
  }
  async applicationBytes(bytes) {
    // Reuse the incoming SCEP/bFTP parser and raw file capture. Its replies
    // go through queueApplication above, using this primary link's credits.
    await IrTranPReceiver.prototype.applicationBytes.call(this, bytes);
    this.scepConnected = Boolean(this.peerSCEP); this.csiDeadline = performance.now() + IDLE_MS;
    if (this.scepClosedAt !== null) {
      this.peerSCEPClosed = true; this.closing = true; this.scepClosedAt = null;
    } else if (this.peerSCEP) this.csiState = 'receiving';
  }
  async tick() {
    if (!this.csiActive) return super.tick();
    this.check(); const now = performance.now();
    if (this.csiState === 'ircomm-connect' || this.csiState === 'ircomm-disconnect') return super.tick();
    if (now >= this.csiDeadline && !this.closing) {
      if (this.csiQueue.length || this.application.length || this.parts.length) throw new Error('Incomplete image session timed out; raw bytes retained.');
      this.idleTimeout = true; this.closing = true;
      this.record('receiver-idle-timeout', { phase: this.phase, files: this.files.length, scepConnected: this.scepConnected });
      this.csiDeadline = now + 4000;
      // Respect the pending IrLAP turn before sending the disconnect.
    }
    if (this.closing && now >= this.csiDeadline) throw new Error('Receiver disconnect timed out; raw bytes retained.');
    if (this.transaction && this.turnIsOurs && now >= this.nextPollAt) await this.poll('active-receiver-poll');
  }
  summarize(result) {
    // Do not call the capability client's summary: no queries are issued.
    const pendingOutputBytes = this.csiQueue.reduce((n, item) => n + item.bytes.length + item.controls.length, 0);
    Object.assign(result, { test: 'active-receiver', imageProfile: this.imageProfile, role: 'primary',
      linkAccepted: this.linkAccepted, disconnected: this.disconnected, ias: this.iasResults,
      ircommConnections: this.stats.ircommConnections, peerSAP: this.peerSAP, scepConnected: this.scepConnected,
      applicationCommands: 0, capabilityResponses: this.stats.queries, idleTimeout: this.idleTimeout,
      peerSCEPClosed: this.peerSCEPClosed, peerIrcommClosed: this.peerIrcommClosed, pendingOutputBytes });
    if (pendingOutputBytes) result.complete = false;
    if (this.disconnected && !['error', 'interrupted'].includes(result.status)) {
      if (result.pendingBytes || pendingOutputBytes || this.files.length && !this.peerSCEPClosed) result.complete = false;
      result.status = this.files.length ? result.complete ? 'received' : 'received-incomplete-session' : 'receiver-no-image';
    }
    return result;
  }
}
