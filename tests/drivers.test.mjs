import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DRIVER_ABI, identifyDriver, chooseInstalledDriver, matchingDriverIDs, normalizeDriverPath } from '../dist/driver-catalog.mjs';
import { WebUSBDriverBackend, DriverUSBError, classifyUSBFailure, usbDescriptorSnapshot } from '../dist/driver-usb.mjs';
import { compileDriver } from '../dist/driver-compiler.mjs';
import { InstalledDriverAdapter } from '../dist/installed-adapter.mjs';
import { encodeFrame } from '../dist/irda.mjs';
import { WQVClient } from '../dist/protocol.mjs';
import { IrTranPReceiver } from '../dist/irtranp-core.mjs';
import { transferOthers } from '../dist/others-client.mjs';
import { WQV12Client } from '../dist/wqv12-core.mjs';
import { WQV12Decoder, encodeWQV12 } from '../dist/wqv12-formats.mjs';
import { fromHex, toHex } from '../dist/formats.mjs';

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

test('a zero-valued active configuration reaches the real interface claim and is retained in diagnostics', async () => {
  const usb = device(0x18ec, 0x3118), calls = [], events = [];
  const configuration = usb.configurations[0]; configuration.configurationValue = 0;
  const iface = configuration.interfaces[0]; iface.alternate = iface.alternates[0];
  iface.alternate.endpoints = [{ endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
    { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 }];
  Object.assign(usb, { configuration, opened: false,
    async open() { this.opened = true; calls.push('open'); },
    async close() { this.opened = false; calls.push('close'); },
    async claimInterface(number) { calls.push(['claim', number]); },
    async releaseInterface(number) { calls.push(['release', number]); },
    async selectConfiguration() { assert.fail('an already active configuration must not be selected again'); },
  });
  const backend = new WebUSBDriverBackend(usb, null, { onEvent: event => events.push(event) });
  const description = await backend.open();
  assert.equal(description.description.configuration, 0);
  assert.deepEqual(description.fields.slice(4, 6), [0x82, 2]);
  assert.deepEqual(calls, ['open', ['claim', 0]]);
  const snapshot = JSON.parse(JSON.stringify(events.find(event => event.kind === 'usb-descriptors')));
  assert.equal(snapshot.opened, true); assert.equal(snapshot.activeConfiguration.configurationValue, 0);
  assert.equal(snapshot.configurations[0].interfaces[0].alternates[0].endpoints.length, 2);
  await backend.close(); assert.deepEqual(calls.slice(2), [['release', 0], 'close']);
});

test('missing interfaces still fail without a helper fallback and keep their descriptor evidence', async () => {
  const events = [], usb = { vendorId: 1, productId: 2, opened: false, configuration: null,
    configurations: [{ configurationValue: 0, interfaces: [] }],
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async claimInterface() { assert.fail('no interface may be invented'); },
  };
  const backend = new WebUSBDriverBackend(usb, null, { onEvent: event => events.push(event) });
  await assert.rejects(backend.open(), error => error.code === 'no-interfaces');
  assert.equal(usb.opened, false);
  assert.equal(events[0].configurations[0].configurationValue, 0);
  assert.deepEqual(events[0].configurations[0].interfaces, []);
  assert.equal(usbDescriptorSnapshot(usb).activeConfiguration, null);
});

test('a failed native claim with configuration zero remains a native failure', async () => {
  const usb = device(0x18ec, 0x3118);
  usb.configuration = usb.configurations[0]; usb.configuration.configurationValue = 0;
  Object.assign(usb, { opened: false, async open() { this.opened = true; }, async close() { this.opened = false; },
    async claimInterface() { throw new DOMException('Cannot claim this interface', 'NetworkError'); },
  });
  await assert.rejects(new WebUSBDriverBackend(usb).open(), error => error.code === 'busy');
  assert.equal(usb.opened, false);
});

test('driver teardown aborts WinUSB reads with close and restores access for the remaining C shutdown', async () => {
  const usb = device(), calls = [], pending = [];
  const iface = usb.configurations[0].interfaces[0];
  iface.alternates[0].alternateSetting = 1; iface.alternate = iface.alternates[0];
  Object.assign(usb, { configuration: usb.configurations[0], opened: false,
    async open() { this.opened = true; calls.push('open'); },
    async close() {
      calls.push('close'); this.opened = false; iface.alternate = { alternateSetting: 0 };
      for (const reject of pending.splice(0)) reject(new DOMException('Native read aborted', 'AbortError'));
    },
    async claimInterface() { calls.push('claim'); },
    async releaseInterface() { calls.push('release'); }, // Does not abort reads on WinUSB.
    async selectAlternateInterface(number, alternateSetting) { calls.push(['alternate', number, alternateSetting]); iface.alternate = { alternateSetting }; },
    transferIn() { return new Promise((resolve, reject) => pending.push(reject)); },
    async controlTransferOut() { calls.push('shutdown-control'); return { status: 'ok', bytesWritten: 0 }; },
  });
  const backend = new WebUSBDriverBackend(usb); await backend.open();
  const reads = Promise.allSettled([backend.control({ transfer: 'bulk', type: 128, index: 2, length: 64 }),
    backend.control({ transfer: 'interrupt', type: 128, index: 1, length: 4 })]);
  backend.prepareClose(); await backend.cancel();
  assert.ok((await reads).every(read => read.status === 'rejected' && read.reason.name === 'AbortError'));
  assert.equal(backend.reads.size, 0); assert.equal(backend.claimed, true);
  assert.deepEqual(calls, ['open', 'claim', 'close', 'open', 'claim', ['alternate', 0, 1]]);
  await backend.control({ type: 0x40, request: 0xfe, value: 0, index: 1, length: 0 }, new Uint8Array());
  assert.equal(calls.at(-1), 'shutdown-control');
  await backend.close(); assert.equal(usb.opened, false);
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

test('installed PC background reader counts each consumed SIR byte once', async () => {
  const counts = [], adapter = new InstalledDriverAdapter({}, { record: { profile: 'sigmatel' } },
    { update: () => counts.push(adapter.rxBytes) });
  adapter.claimed = true;
  const wire = encodeFrame(2, 0x73, Uint8Array.of(1, 2, 3));
  adapter.input(wire.slice(0, 5), false); adapter.input(wire.slice(5), false);
  assert.equal(adapter.rxBytes, 0, 'queued input is counted when consumed, like built-in adapters');
  adapter.startReader(); await adapter.readerTask;
  assert.equal(adapter.rxBytes, wire.length); assert.equal(adapter.queueBytes, 0);
  assert.equal(counts.at(-1), wire.length, 'the UI sees the consumed byte count');
  assert.deepEqual(adapter.decoder.frames[0].data, Uint8Array.of(1, 2, 3));
});

test('installed raw WATCH receiver reports the actual capture length, without counting driver input twice', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/wqv3-watch-hardware.json', import.meta.url)));
  const session = fixture.download115200, bytes = fromHex(session.sirHex), files = [];
  const adapter = new InstalledDriverAdapter({}, { record: { profile: 'ks959' } });
  Object.assign(adapter, { claimed: true, configured: true, baud: 9600 });
  adapter.sendFrame = async () => { adapter.txFrames++; };
  adapter.setSIRSpeed = async baud => { adapter.baud = baud; };
  adapter.input(bytes, false);
  const result = await transferOthers(adapter, { protocol: 'watch', direction: 'receive', durationMs: 2000,
    localID: fromHex(session.localID), onFile: async file => files.push(file) });
  assert.equal(result.status, 'received', JSON.stringify(result.error));
  assert.equal(result.rxBytes, bytes.length); assert.equal(adapter.rxBytes, bytes.length);
  assert.equal(adapter.queueBytes, 0); assert.equal(toHex(files[0].bytes), fixture.upf115200Hex);
});

test('installed raw WQV-1/2 transport counts the handshake bytes once in both client and adapter', async () => {
  const adapter = new InstalledDriverAdapter({}, { record: { profile: 'ks959' } });
  Object.assign(adapter, { claimed: true, configured: true, baud: 115200 });
  let receivedBytes = 0;
  adapter.writeSIR = async bytes => {
    const decoder = new WQV12Decoder(); decoder.feed(bytes);
    const frame = decoder.frames[0]; assert.ok(frame);
    const control = { 179: 0xa3, 147: 0x63, 17: 1, 83: 0x63 }[frame.control];
    assert.ok(control, 'probe sends no photo or clock-setting command');
    const reply = encodeWQV12(frame.address === 255 && frame.control === 0xb3 ? 255 : 2,
      control, frame.control === 0xb3 ? Uint8Array.of(13, 57, 25, 128) : new Uint8Array());
    receivedBytes += reply.length; adapter.input(reply, false);
    return { status: 'ok', bytesWritten: bytes.length };
  };
  const result = await new WQV12Client(adapter).run({ mode: 'probe' });
  assert.equal(result.status, 'connected-and-closed', JSON.stringify(result.error)); assert.equal(result.complete, true);
  assert.equal(result.rxBytes, receivedBytes); assert.equal(adapter.rxBytes, receivedBytes);
});
