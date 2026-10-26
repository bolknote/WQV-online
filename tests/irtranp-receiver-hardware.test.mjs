import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IrTranPReceiver } from '../dist/irtranp-core.mjs';
import { FrameDecoder } from '../dist/irda.mjs';
import { b, fromHex as hx, toHex } from '../dist/formats.mjs';

const recorded = JSON.parse(await readFile(new URL('./receiver-hardware-fixtures.json', import.meta.url)));

for (const session of recorded.sessions) {
  test(`original OTHERS SEND bytes complete a photo session (${session.imageProfile})`, async () => {
    // Feed the original input through a strict decoder. This replay preserves
    // bytes and frames; it deliberately does not reproduce empty-read timing.
    const decoder = new FrameDecoder(), bytes = hx(session.usbInHex);
    decoder.feed(bytes);
    assert.equal(decoder.badCRC, 0); assert.equal(decoder.recoveredFrames, 0);
    assert.equal(decoder.frames.length, session.originalResult.validFrames);
    let sent = 0; const files = [], events = [];
    const adapter = { decoder, opened: true, configured: true, baud: 9600, revision: 7,
      readerTask: null, rxBytes: bytes.length, txFrames: 0, readPending: false,
      assertOpen() { assert.equal(this.opened, true); },
      async setSIRSpeed(baud) { this.baud = baud; }, async close() { this.opened = false; },
      async sendFrame(address, control, data) {
        assert.deepEqual({ address, control, dataHex: toHex(data) }, session.expectedTransmissions[sent++]);
        this.txFrames++;
      },
      device: { transferIn() { throw new Error('Unexpected read after the recorded session'); } } };
    const result = await new IrTranPReceiver(adapter, { localID: hx(session.localID), imageProfile: session.imageProfile,
      maxBaud: session.maxBaud ?? 115200,
      onFile: async file => files.push(file), record: (kind, details) => events.push({ kind, ...details }) }).run(2000);
    assert.equal(result.status, 'received', JSON.stringify(result.error)); assert.equal(result.complete, true);
    assert.equal(sent, session.expectedTransmissions.length); assert.equal(result.queries, 3);
    assert.equal(result.fileCount, 1); assert.equal(result.pendingBytes, 0);
    assert.equal(files[0].filename, 'QW000000.UPF'); assert.equal(toHex(files[0].bytes), session.expectedUPFHex);
    assert.equal(files[0].jpeg.length, 1314); assert.equal(files[0].previewError, null);
    assert.equal(events.filter(event => event.kind === 'credit-retired-on-disconnect').length,
      session.expectedRetiredCreditEvents ?? 1);
  });
}

test('disconnect does not discard an unacknowledged application reply', async () => {
  const adapter = { decoder: new FrameDecoder(), opened: true,
    assertOpen() {}, async sendFrame() {} };
  const receiver = new IrTranPReceiver(adapter, { localID: hx('12345678') });
  Object.assign(receiver, { linkAddress: 94, peerSAP: 3, scepClosedAt: performance.now(),
    unacked: { frame: { data: b(3, 9, 0, 0, 0x20, 1) }, retries: 0 } });
  await receiver.frame({ address: 95, control: 0x53, data: b() });
  assert.equal(receiver.closed, true); assert.ok(receiver.unacked);
});
