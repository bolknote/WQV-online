import { LinuxKingsun } from './runtime.mjs';
import { LinuxSigmaTel } from './sigmatel/runtime.mjs';
import { LinuxNetwork } from './corpus/runtime.mjs';
let driver, fields = [], description, usbSequence = 0, rawIsPacket = false;
const waiting = new Map();
const usb = (method, args = []) => new Promise((resolve, reject) => {
  const id = ++usbSequence; waiting.set(id, { resolve, reject }); self.postMessage({ usb: { id, method, args } });
});
const backend = {
  async open() { const reply = await usb('open'); fields = reply.fields; description = reply.description; },
  control: (request, bytes) => usb('control', [request, bytes]),
  rpc: (method, args) => usb('rpc', [method, args]),
  cancel: request => usb('cancel', [request]), close: () => usb('close'),
};
function flush() {
  if (!driver) return;
  if (driver.raw.length) { const bytes = Uint8Array.from(driver.raw.splice(0)); self.postMessage({ bytes, packet: rawIsPacket }, [bytes.buffer]); }
  for (const packet of driver.packets?.splice(0) ?? []) self.postMessage({ bytes: packet, packet: true }, [packet.buffer]);
}
self.onmessage = async ({ data }) => {
  if (data.usbReply) {
    const task = waiting.get(data.usbReply); if (!task) return;
    waiting.delete(data.usbReply); data.error ? task.reject(new Error(data.error)) : task.resolve(data.result); return;
  }
  try {
    let result;
    if (data.method === 'load') {
      const [bytes, profile] = data.args;
      rawIsPacket = profile === 'ir-usb';
      const Runtime = profile === 'sigmatel' ? LinuxSigmaTel : profile === 'ks959' ? LinuxKingsun : LinuxNetwork;
      driver = new Runtime(backend, () => {}, { rxSensitivity: 6 });
      const imports = driver.imports.bind(driver);
      driver.imports = () => ({ ...imports(), host_descriptor: field => fields[field] ?? 0 });
      driver.event = (kind, detail = {}) => {
        if (kind !== 'usb-request' && !(kind === 'usb-complete' && !detail.length && !detail.status)) self.postMessage({ event: { kind, ...detail } });
        queueMicrotask(flush);
      };
      await driver.load(bytes);
    } else if (data.method === 'open') { await driver.open(); result = description; }
    else if (data.method === 'speed') await driver.speed(data.args[0]);
    else if (data.method === 'send') await driver.send(new Uint8Array(data.args[0]));
    else if (data.method === 'close') { await driver.close(); flush(); }
    else throw new Error('Unknown driver operation.');
    if (driver?.fault && data.method !== 'close') throw new Error(driver.fault);
    self.postMessage({ reply: data.id, result });
  } catch (error) { self.postMessage({ reply: data.id, error: String(error.message || error) }); }
};
