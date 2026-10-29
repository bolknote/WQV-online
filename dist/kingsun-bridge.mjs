import { tr, LocalizedError } from './i18n.mjs';

// KS-959 uses wIndex=1 as a command selector despite having only interface 0.
// Chromium rejects that request before USB. Keep the entire watch protocol in
// JavaScript; the loopback helper only forwards validated KS-959 USB controls.
export class KingsunBridgeDevice {
  constructor(device, { fetch = globalThis.fetch, url = 'http://127.0.0.1:8767/usb' } = {}) {
    this.vendorId = device.vendorId; this.productId = device.productId;
    this.productName = device.productName; this.manufacturerName = device.manufacturerName;
    this.fetch = fetch; this.url = url; this.opened = false; this.configuration = null; this.session = null;
  }
  async rpc(method, args = []) {
    let response;
    try {
      const request = this.fetch;
      response = await request(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args, session: this.session }), signal: AbortSignal.timeout(3000),
        cache: 'no-store', credentials: 'omit', keepalive: method === 'close' });
    } catch (cause) {
      const error = new LocalizedError(tr('Cannot reach the KS-959 USB helper: {0}', cause.message));
      error.cause = cause; throw error;
    }
    const reply = await response.json();
    if (!response.ok || reply.error) throw new Error(reply.error || 'KS-959 helper: HTTP ' + response.status);
    return reply.result;
  }
  async open() {
    const info = await this.rpc('open');
    if (info.vendorId !== 0x07d0 || info.productId !== 0x4959 || !info.session) throw new Error('Unexpected KS-959 helper response.');
    this.session = info.session; this.opened = true;
    this.configuration = { configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{
      alternateSetting: 0, interfaceClass: 255,
      endpoints: [{ direction: 'in', type: 'interrupt', endpointNumber: 1, packetSize: 8 }],
    }] }] };
  }
  async claimInterface(number) { if (!this.opened || number !== 0) throw new Error('KS-959 requires interface 0.'); }
  async selectConfiguration(number) { if (!this.opened || number !== 1) throw new Error('KS-959 requires configuration 1.'); }
  async controlTransferIn(setup, length) {
    const result = await this.rpc('controlTransferIn', [setup, length]);
    const bytes = Uint8Array.from(result.hex.match(/../g) ?? [], value => parseInt(value, 16));
    return { status: result.status, data: new DataView(bytes.buffer) };
  }
  controlTransferOut(setup, data) {
    const hex = Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), v => v.toString(16).padStart(2, '0')).join('');
    return this.rpc('controlTransferOut', [setup, { hex }]);
  }
  async close() {
    if (!this.opened) return;
    try { await this.rpc('close'); }
    finally { this.opened = false; this.session = null; }
  }
}
