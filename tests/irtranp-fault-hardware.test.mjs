import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FrameDecoder, encodeFrame } from '../dist/irda.mjs';
import { IrTranPSender } from '../dist/irtranp-send.mjs';
import { LinkFaults } from '../dist/irtranp-faults.mjs';
import { b, fromHex as hx, toHex, sha256 } from '../dist/formats.mjs';

const fixture = JSON.parse(await readFile(new URL('./link-recovery-hardware-fixtures.json', import.meta.url)));
for (const session of fixture.sessions) {
  test('original hardware fault capture replays actual wire bytes and successful recovery: ' + session.scenario, { timeout: 35000 }, async () => {
    const events = [], queued = []; let index = 0;
    const record = (kind, data) => { faults.observe(kind, data); events.push({ kind, ...data }); };
    const faults = new LinkFaults(session.scenario, record, { at: session.faultAt });
    const adapter = { opened: true, configured: true, baud: 9600, revision: 7, readerTask: null,
      inEndpoint: 2, readPending: false, rxBytes: 0, txFrames: 0,
      decoder: new FrameDecoder({ recoverFrames: true, recoverBOF: true }),
      assertOpen() { assert.ok(this.opened); }, async close() { this.opened = false; },
      async setSIRSpeed(baud) { this.baud = baud; },
      device: { async transferIn() {
        const bytes = queued.shift() ?? b();
        return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.length) };
      } },
      async sendFrame(address, control, data, bof, options) {
        assert.equal(options.receive, false);
        const expected = session.groups[index++]; assert.ok(expected, 'No unexpected retransmission or extra PUT');
        assert.deepEqual({ address, control, dataHex: toHex(data) }, expected.tx);
        const wire = encodeFrame(address, control, data, bof);
        const usb = b(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
        assert.equal(toHex(faults.outgoing(usb)), expected.actualUSBHex, 'Actual malformed or repeated wire buffer matches capture');
        this.txFrames++; queued.push(...expected.reads.map(hx));
      },
    };
    const bytes = hx(session.input.dataHex);
    assert.equal(await sha256(bytes), session.input.sha256);
    const sender = new IrTranPSender(adapter, { sendFile: { bytes, filename: session.input.filename },
      copyCount: 1, sendPDU: 0, maxBaud: 115200, localID: hx(session.localID), frameRecovery: 'pad5-bof',
      record });
    const incoming = sender.frame.bind(sender);
    sender.frame = frame => faults.discardIncoming(frame) ? Promise.resolve() : incoming(frame);
    const result = await sender.run(30000);
    assert.equal(result.status, 'sent', JSON.stringify(result.error)); assert.equal(result.complete, true);
    assert.equal(result.linkRecovery.enabled, true, 'normal sender defaults to the hardware-verified recovery path');
    assert.equal(index, session.groups.length); assert.equal(result.txFrames, session.result.txFrames);
    for (const key of ['validFrames', 'rxBytes', 'badCRC', 'recoveredFrames', 'recoveredBOF', 'retransmissions',
      'linkRecoveryPolls', 'putRequests', 'putAccepted', 'putSegments', 'pendingOutputBytes', 'pendingUSBRead']) {
      assert.equal(result[key], session.result[key], key);
    }
    assert.deepEqual(faults.summary(), session.faultInjection);
    assert.deepEqual(result.putReplies, session.result.putReplies);
    assert.equal(events.filter(e => e.kind === 'put-started').length, 1);
  });
}
