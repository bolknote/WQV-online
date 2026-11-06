import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transferOthers, othersOutcome, othersImage, readWatchMode, watchTabs } from '../dist/others-client.mjs';
import { WatchPhotoReceiver, WatchPhotoSender, WATCH_QOS } from '../dist/watch-peer.mjs';
import { KingsunStream } from '../dist/kingsun.mjs';
import { FrameDecoder } from '../dist/irda.mjs';
import { csiXID } from '../dist/irtranp-core.mjs';
import { b, fromHex as hx, toHex, concat, loadArchive, sha256 } from '../dist/formats.mjs';

const fixture = JSON.parse(await readFile(new URL('./fixtures/wqv3-watch-hardware.json', import.meta.url)));

test('WATCH is remembered for WQV-3, with only Photos and Connection; other model profiles can exclude it', () => {
  assert.equal(readWatchMode({ getItem: () => 'watch' }), 'watch');
  assert.equal(readWatchMode({ getItem: () => 'watch' }, ['others', 'swan']), 'pc');
  assert.deepEqual(watchTabs('watch'), ['photos', 'connection']);
});

for (const speed of [9600, 115200]) test(`WATCH input at ${speed} qualifies the persistent KS counter without resetting USB`, () => {
  const session = speed === 9600 ? fixture.download : fixture.download115200;
  const stream = new KingsunStream(), received = stream.feed(hx(session.rawUSBHex));
  assert.equal(toHex(received), session.sirHex);
  assert.equal(stream.counter.phase, session.finalCounter);
  const decoder = new FrameDecoder(); decoder.feed(received);
  assert.equal(decoder.frames.length, speed === 9600 ? 98 : 81); assert.equal(decoder.badCRC, 0);
});

for (const speed of [9600, 115200]) test(`WATCH receive at ${speed} reproduces every physical reply and saves an exportable UPF`, async () => {
  const session = speed === 9600 ? fixture.download : fixture.download115200;
  const upf = speed === 9600 ? fixture.upfHex : fixture.upf115200Hex;
  const decoder = new FrameDecoder({ recoverFrames: true, recoverBOF: true });
  decoder.feed(hx(session.sirHex));
  const files = []; let index = -1;
  const adapter = { decoder, opened: true, configured: true, baud: 9600, readerTask: null,
    description: { driver: 'KingSun KS-959' }, rxBytes: 0, txFrames: 0, readPending: false, revision: null,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
    async setSIRSpeed(baud) { assert.equal(baud, speed); this.baud = baud; },
    async sendFrame(address, control, data) {
      const actual = { address, control, dataHex: toHex(data) };
      if (index === -1) {
        const prime = csiXID(hx(session.localID), { slot: 0 });
        assert.deepEqual(actual, { address: prime.address, control: prime.control, dataHex: toHex(prime.data) });
      } else assert.deepEqual(actual, session.expectedHostFrames[index]);
      index++; this.txFrames++;
    }, async readRaw() { throw Error('No additional input after the recorded close'); },
  };
  const result = await transferOthers(adapter, { protocol: 'watch', direction: 'receive', maxBaud: speed, localID: hx(session.localID), durationMs: 2000,
    onFile: async file => files.push(await othersImage(file, { protocol: 'watch' })) });
  assert.equal(othersOutcome(result), 'received', JSON.stringify(result.error));
  assert.equal(result.protocol, 'watch'); assert.equal(result.negotiatedBaud, speed);
  assert.equal(index, session.expectedHostFrames.length);
  assert.equal(files.length, 1); assert.equal(files[0].protocol, 'watch');
  assert.equal(files[0].archive.sourceProtocol, 'watch');
  assert.equal(toHex(files[0].upf), upf);
  assert.deepEqual(await loadArchive(files[0].archive), hx(upf));
  assert.equal(await sha256(files[0].upf), await sha256(hx(upf)));
  assert.equal(decoder.recoverFrames, true); assert.equal(decoder.recoverBOF, true, 'restore PC recovery flags');
});

for (const speed of [9600, 115200]) test(`WATCH sender at ${speed} replays the physical upload and recovery with exactly one PUT`, { timeout: 18000 }, async () => {
  const session = speed === 9600 ? fixture.upload : fixture.upload115200, queued = [], events = []; let index = 0;
  const adapter = { decoder: new FrameDecoder(), opened: true, configured: true, baud: 9600, readerTask: null,
    description: { driver: 'KingSun KS-959' }, rxBytes: 0, txFrames: 0, readPending: false, revision: null,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
    async setSIRSpeed(baud) { assert.ok([9600, speed].includes(baud)); this.baud = baud; },
    async sendFrame(address, control, data) {
      const group = session.groups[index++]; assert.ok(group, 'no extra PUT or output after recorded close');
      assert.deepEqual({ address, control, dataHex: toHex(data) }, group.tx);
      queued.push(...group.reads.map(hx)); this.txFrames++;
    }, async readRaw() {
      const bytes = queued.shift() ?? b();
      return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
    },
  };
  const result = await transferOthers(adapter, { protocol: 'watch', direction: 'send', maxBaud: speed, localID: hx(session.localID), durationMs: 15000,
    file: { filename: session.filename, bytes: hx(speed === 9600 ? fixture.upfHex : fixture.upf115200Hex) }, record: (kind, details) => events.push({ kind, ...details }) });
  assert.equal(othersOutcome(result), 'accepted', JSON.stringify(result));
  assert.equal(result.complete, true); assert.equal(result.disconnected, true);
  assert.equal(result.storageVerified, false); assert.equal(result.negotiatedBaud, speed);
  assert.equal(result.putRequests, 1); assert.equal(result.putAccepted, 1); assert.equal(result.putSegments, 6);
  assert.equal(result.retransmissions, session.retransmissions); assert.equal(result.linkRecoveryPolls, 1);
  assert.equal(result.badCRC, 0); assert.equal(index, session.groups.length);
  assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  assert.equal(result.linkQoS.dataBytes, 256); assert.equal(result.linkQoS.windowSize, 1);
  assert.ok(events.filter(e => e.kind === 'tx-frame' && e.address === 0x71 && !(e.control & 1)).every(e => e.dataHex.length <= 512));
});

test('WATCH rejects incompatible link parameters before accepting a link or queuing PUT', async () => {
  const sent = [], adapter = { decoder: {}, baud: 9600, assertOpen() {},
    async sendFrame(...args) { sent.push(args); } };
  const receiver = new WatchPhotoReceiver(adapter, { localID: hx('01020304') });
  const offer = WATCH_QOS.slice(); offer[8] = 2; // 128-byte frames only; the tested path uses 256.
  await assert.rejects(receiver.frame({ address: 255, control: 0x93,
    data: concat(hx('193666be0102030470'), offer) }), /does not offer/);
  assert.equal(sent.length, 0);
  const sender = new WatchPhotoSender(adapter, { sendFile: { filename: 'QW000000.UPF', bytes: hx(fixture.upfHex) },
    copyCount: 2, sendPDU: 512, maxBaud: 115200 });
  assert.equal(sender.maxBaud, 115200); assert.equal(sender.copyCount, 1); assert.equal(sender.sendPDU, 0);
  await assert.rejects(transferOthers(adapter, { direction: 'send', protocol: 'unknown' }), /Unknown/);
});

test('automatic WATCH negotiation accepts a 9600-only peer in either role without an application retry', async () => {
  const localID = hx('01020304'), peerID = hx('193666be'), sent = [];
  const adapter = { decoder: {}, baud: 9600, assertOpen() {},
    async setSIRSpeed(baud) { assert.equal(baud, 9600); },
    async sendFrame(address, control, data) { sent.push({ address, control, dataHex: toHex(data) }); } };
  const receiver = new WatchPhotoReceiver(adapter, { localID });
  await receiver.frame({ address: 255, control: 0x93, data: concat(peerID, localID, b(0x70), WATCH_QOS) });
  assert.equal(receiver.negotiatedBaud, 9600);
  assert.equal(sent[0].dataHex.slice(16), toHex(WATCH_QOS));
  const sender = new WatchPhotoSender(adapter, { localID, sendFile: { filename: 'QW000000.UPF', bytes: hx(fixture.upfHex) } });
  Object.assign(sender, { clientState: 'await-ua', peerID, linkAddress: 0x70 });
  await sender.frame({ address: 0x70, control: 0x73, data: concat(peerID, localID, WATCH_QOS) });
  assert.equal(sender.negotiatedBaud, 9600); assert.equal(sender.putRequests, 0);
  assert.equal(sender.linkAccepted, true);
});

test('WATCH cancellation ends an unresolved USB read after the prime and restores decoder settings', { timeout: 1500 }, async () => {
  const controller = new AbortController(); let transmitted = 0;
  const adapter = { opened: true, configured: true, baud: 9600, readerTask: null, revision: null,
    description: { driver: 'KingSun KS-959' }, decoder: new FrameDecoder({ recoverFrames: true, recoverBOF: true }),
    rxBytes: 0, txFrames: 0, readPending: false,
    assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
    async sendFrame(address, control) { assert.equal(address, 255); assert.equal(control, 0x3f); transmitted++; },
    readRaw() { queueMicrotask(() => controller.abort()); return new Promise(() => {}); },
  };
  const result = await transferOthers(adapter, { protocol: 'watch', direction: 'receive', signal: controller.signal });
  assert.equal(othersOutcome(result), 'cancelled'); assert.equal(transmitted, 1);
  assert.equal(adapter.opened, false); assert.equal(adapter.decoder.recoverFrames, true); assert.equal(adapter.decoder.recoverBOF, true);
});
