// WQV-3 WATCH uses the same IrCOMM/SCEP/bFTP layers as OTHERS. The
// discovery identity and the conservative link limits below were checked
// in both directions on WQV-3 with KS-959. See docs/watch-peer.md.
import { IrTranPReceiver, csiXID } from './irtranp-core.mjs';
import { IrTranPSender } from './irtranp-send.mjs';
import { negotiateCE211 } from './irtranp-wince211.mjs';
import { baudMask, selectBaudRate } from './irda.mjs';
import { concat, equal, fromHex, toHex } from './formats.mjs';

export const WATCH_IDENTITY = fromHex('8c0400434153494f2057494320323431312f4952');
export const WATCH_QOS = fromHex('010102820101830104840101850180860101080104');

export function watchQoS(maxBaud = 115200) {
  const parameters = WATCH_QOS.slice(); parameters[2] = baudMask(maxBaud); return parameters;
}

function verifyOffer(parameters, selected) {
  const values = new Map();
  for (let p = 0; p < parameters.length;) {
    if (p + 2 > parameters.length) throw new Error('Truncated WATCH QoS');
    const kind = parameters[p++], size = parameters[p++];
    if (![1, 2].includes(size) || p + size > parameters.length || values.has(kind)) throw new Error('Invalid WATCH QoS');
    values.set(kind, parameters[p] | (size === 2 ? parameters[p + 1] << 8 : 0)); p += size;
  }
  for (let p = 0; p < selected.length; p += 3) {
    if (!((values.get(selected[p]) ?? 0) & selected[p + 2])) throw new Error('WATCH does not offer the selected link parameter');
  }
}

function selectQoS(parameters, rates) {
  const { baud, commonRates } = selectBaudRate(parameters, rates), selected = WATCH_QOS.slice();
  selected[2] = 1 << Math.floor(Math.log2(commonRates));
  verifyOffer(parameters, selected);
  return { baud, parameters: selected };
}

export class WatchPhotoReceiver extends IrTranPReceiver {
  constructor(adapter, options = {}) {
    super(adapter, { ...options, maxBaud: options.maxBaud ?? 115200 });
    this.minimumTurnMs = 10;
    this.selectedQoS = null;
    this.negotiatedBaud = null;
  }
  // KS-959 needs an initial transmission to enable reception. This is
  // called only after Start, before asking the user for the final F press.
  async prime() { await this.transmit(csiXID(this.localID, { slot: 0 }), 'watch-receiver-prime'); }
  async tick() {} // Let the watch run discovery; do not compete with it.
  async transmit(frame, purpose) {
    if (frame.address === 0xfe && frame.control === 0xbf) {
      frame = { ...frame, data: concat(frame.data.slice(0, 12), WATCH_IDENTITY) };
    }
    if (purpose === 'accept-irlap') {
      frame = { ...frame, data: concat(this.localID, this.peerID, this.selectedQoS) };
      this.record('watch-link-selected', { baud: this.negotiatedBaud, dataBytes: 256, windowSize: 1, parametersHex: toHex(this.selectedQoS) });
    }
    return super.transmit(frame, purpose);
  }
  async frame(frame) {
    if (this.linkAddress === null && frame.address === 255 && frame.control === 0x93 && frame.data.length >= 9 &&
        equal(frame.data.slice(4, 8), this.localID)) {
      const selected = selectQoS(frame.data.slice(9), this.rates);
      this.selectedQoS = selected.parameters; this.negotiatedBaud = selected.baud;
    }
    if (this.linkAddress !== null && frame.address === this.linkAddress + 1 && !(frame.control & 1) && frame.data.length > 256) {
      throw new Error('WATCH frame exceeds the selected 256-byte receive size');
    }
    return super.frame(frame);
  }
  summarize(result) {
    return Object.assign(result, { watchMode: 'watch-send', negotiatedBaud: this.negotiatedBaud,
      identityHex: toHex(WATCH_IDENTITY), selectedParametersHex: this.selectedQoS ? toHex(this.selectedQoS) : null });
  }
}

export class WatchPhotoSender extends IrTranPSender {
  constructor(adapter, options = {}) {
    super(adapter, { ...options, maxBaud: options.maxBaud ?? 115200, copyCount: 1, sendFiles: [options.sendFile],
      sendPDU: 0, transportProfile: 'current', linkRecovery: true, abortMode: 'none', interPutDelayMs: 0 });
    this.offeredQoS = watchQoS(this.maxBaud);
    this.negotiatedBaud = null;
    this.minimumTurnMs = 10;
  }
  async transmit(frame, purpose) {
    if (frame.address === 255 && frame.control === 0x3f && frame.data[10] === 255) {
      frame = { ...frame, data: concat(frame.data.slice(0, 12), WATCH_IDENTITY) };
    }
    if (purpose === 'ias-probe-snrm') frame = { ...frame, data: concat(frame.data.slice(0, 9), this.offeredQoS) };
    return super.transmit(frame, purpose);
  }
  async frame(frame) {
    if (this.clientState === 'await-ua' && frame.address === this.linkAddress && frame.control === 0x73 &&
        equal(frame.data.slice(0, 8), concat(this.peerID, this.localID))) {
      selectQoS(frame.data.slice(8), this.rates);
      this.linkQoS = negotiateCE211(frame.data.slice(8), this.rates, this.offeredQoS);
      this.negotiatedBaud = this.linkQoS.baud;
      this.minimumTurnMs = Math.max(10, this.linkQoS.minTurnUs / 1000);
      this.record('watch-link-selected', { ...this.linkQoS, effectiveMinimumTurnMs: this.minimumTurnMs,
        parametersHex: toHex(this.offeredQoS) });
    }
    if (this.linkAccepted && frame.address === this.linkAddress && !(frame.control & 1) && frame.data.length > 256) {
      throw new Error('WATCH frame exceeds the selected 256-byte receive size');
    }
    return super.frame(frame);
  }
  summarize(result) {
    super.summarize(result);
    return Object.assign(result, { watchMode: 'watch-receive', storageVerified: false, negotiatedBaud: this.negotiatedBaud,
      identityHex: toHex(WATCH_IDENTITY), offeredParametersHex: toHex(this.offeredQoS) });
  }
}
