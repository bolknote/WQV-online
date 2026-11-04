import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DRIVER_ABI, identifyDriver, chooseInstalledDriver, matchingDriverIDs, normalizeDriverPath } from '../dist/driver-catalog.mjs';
import { WebUSBDriverBackend, DriverUSBError, classifyUSBFailure } from '../dist/driver-usb.mjs';
import { compileDriver } from '../dist/driver-compiler.mjs';
import { InstalledDriverAdapter } from '../dist/installed-adapter.mjs';
import { encodeFrame } from '../dist/irda.mjs';
import { WQVClient } from '../dist/protocol.mjs';
import { IrTranPReceiver } from '../dist/irtranp-core.mjs';

const device = (vendorId = 0x066f, productId = 0x4200, interfaceClass = 255) => ({ vendorId, productId,
  configurations: [{ configurationValue: 1, interfaces: [{ interfaceNumber: 0, alternates: [{ alternateSetting: 0,
    interfaceClass, interfaceSubclass: 2, interfaceProtocol: 0, endpoints: [] }] }] }] });
const record = (id, usbMatches, updatedAt = 1) => ({ id, updatedAt, sha256: id, inputSHA256: id, artifact: { abi: DRIVER_ABI, sourceSHA256: id, inputSHA256: id, usbMatches } });

test('distributed Linux sources retain the downloaded hashes and original notices', async () => {
  const base = new URL('../dist/driver-runtime/corpus/', import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('sources.json', base)));
  for (const file of Object.values(manifest.files)) {
    const bytes = await fs.readFile(new URL(file.localPath, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.localPath);
  }
  assert.match(await fs.readFile(new URL('COPYING', base), 'utf8'), /Version 2, June 1991/);
});

test('profile identification uses C declarations, not filenames or comments', () => {
  assert.equal(identifyDriver('struct stir_cb { int x; };').id, 'sigmatel');
  assert.equal(identifyDriver('/* struct stir_cb; */\nstruct ks959_cb {int x;};').id, 'ks959');
  assert.equal(identifyDriver('// struct stir_cb\nint main(void){return 0;}'), null);
  assert.throws(() => normalizeDriverPath('../../driver.h'), /Invalid/);
  assert.throws(() => normalizeDriverPath('/etc/file'), /Invalid/);
  assert.equal(normalizeDriverPath('linux/usb/irda.h'), 'linux/usb/irda.h');
});

test('installed exact USB IDs outrank a newer generic class driver', () => {
  const exact = record('exact', [{ vendorId: 0x066f, productId: 0x4200 }], 1);
  const generic = record('generic', [{ interfaceClass: 255 }], 20);
  assert.equal(chooseInstalledDriver([generic, exact], device()).record.id, 'exact');
  assert.equal(chooseInstalledDriver([generic], device()).record.id, 'generic');
  const corrupt = structuredClone(exact); corrupt.artifact.sourceSHA256 = 'wrong';
  assert.equal(chooseInstalledDriver([corrupt], device()), null);
  const changedHeader = structuredClone(exact); changedHeader.inputSHA256 = 'new header';
  assert.equal(chooseInstalledDriver([changedHeader], device()), null);
});

test('class matching respects subclass/protocol and recognizes exact IDs without OS interfaces', () => {
  const classRecord = record('class', [{ interfaceClass: 254, interfaceSubclass: 2, interfaceProtocol: 0 }]);
  assert.equal(matchingDriverIDs(classRecord, device(1, 2, 254)).length, 1);
  assert.equal(matchingDriverIDs(classRecord, device(1, 2, 255)).length, 0);
  const noInterface = { vendorId: 0x18ec, productId: 0x3118, configurations: [] };
  assert.equal(matchingDriverIDs(record('ark', [{ vendorId: 0x18ec, productId: 0x3118 }]), noInterface).length, 1);
});

test('invalid interface command requires helper before submitting any USB request', () => {
  const backend = new WebUSBDriverBackend({ configuration: { interfaces: [{ interfaceNumber: 0 }] } });
  backend.interfaceNumber = 0;
  assert.throws(() => backend.validateControl({ type: 0x21, index: 1 }), error => error.code === 'helper-needed');
  // A device-recipient register index is not an interface number.
  assert.doesNotThrow(() => backend.validateControl({ type: 0x40, index: 8 }));
});

test('busy, permission and initialization failures are not relabeled as helper requirements', () => {
  assert.equal(classifyUSBFailure(new DOMException('busy', 'NetworkError'), 'claim').code, 'busy');
  assert.equal(classifyUSBFailure(new DOMException('no', 'NotAllowedError')).code, 'permission');
  assert.equal(classifyUSBFailure(new Error('USB stall')).code, 'usb-error');
  const original = new DriverUSBError('no-interfaces', 'Configuration zero');
  assert.equal(classifyUSBFailure(original), original);
});

test('cancellation during native open closes a late USB handle', async () => {
  let finishOpen, closed = 0;
  const usb = { ...device(), opened: false, open: () => new Promise(resolve => { finishOpen = () => { usb.opened = true; resolve(); }; }),
    close: async () => { usb.opened = false; closed++; } };
  const backend = new WebUSBDriverBackend(usb);
  const open = backend.open(); await backend.close(); finishOpen();
  await assert.rejects(open, error => error.code === 'cancelled');
  assert.equal(usb.opened, false); assert.ok(closed >= 1);
});

test('compiler cancellation terminates the Worker rather than leaving C running', async () => {
  let terminated = 0;
  class Worker { postMessage() {} terminate() { terminated++; } }
  const controller = new AbortController();
  const compiling = compileDriver({}, { WorkerClass: Worker, signal: controller.signal });
  controller.abort(); await assert.rejects(compiling, { name: 'AbortError' });
  assert.equal(terminated, 1);
});

test('URB_ZERO_PACKET sends an actual empty bulk packet after a full-sized output', async () => {
  const writes = [], usb = { transferOut: async (endpoint, bytes) => { writes.push([endpoint, bytes.length]); return { status: 'ok', bytesWritten: bytes.length }; } };
  const backend = new WebUSBDriverBackend(usb); backend.claimed = true;
  backend.alternate = { endpoints: [{ direction: 'out', endpointNumber: 2, packetSize: 64 }] };
  const result = await backend.control({ transfer: 'bulk', type: 0, index: 2, length: 64, flags: 0x40 }, new Uint8Array(64));
  assert.equal(result.written, 64); assert.deepEqual(writes, [[2, 64], [2, 0]]);
});

test('the fixed-9600 driver limits both PC and OTHERS negotiation without changing other adapters', () => {
  const adapter = { maxBaud: 9600, decoder: {} };
  assert.equal(new WQVClient(adapter).localBaudRates, 2);
  assert.equal(new IrTranPReceiver(adapter).rates, 2);
  assert.equal(new WQVClient({}).localBaudRates, 62);
});

test('C SigmaTel input retains PAD-5 CRC recheck on real empty USB completions only', () => {
  const adapter = new InstalledDriverAdapter({}, { record: { profile: 'sigmatel' } });
  adapter.revision = 6; adapter.baud = 115200;
  const wire = encodeFrame(0xfe, 0x73, Uint8Array.of(1, 2, 3)); wire[wire.length - 1] = 0xe1;
  adapter.decoder.feed(wire); assert.equal(adapter.decoder.frames.length, 0);
  adapter.usbTransfer({ direction: 'in', request: { transfer: 'bulk', type: 128 }, dataHex: '' });
  assert.equal(adapter.decoder.frames.length, 1); assert.deepEqual(adapter.decoder.frames[0].data, Uint8Array.of(1, 2, 3));
  const other = new InstalledDriverAdapter({}, { record: { profile: 'ks959' } });
  other.decoder.feed(wire); other.usbTransfer({ direction: 'in', request: { transfer: 'bulk', type: 128 }, dataHex: '' });
  assert.equal(other.decoder.frames.length, 0);
});
