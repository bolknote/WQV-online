import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SWAN_PLAN, SWAN_FORMAT, packetBytes, swanPreset, encodeSwanPacket, decodeSwanPacket, scanSwanPackets, analyseSwanCapture, swanAttemptFiles } from '../dist/swan-core.mjs';
import { b, concat, fromHex, toHex } from '../dist/formats.mjs';

// These vectors were emitted and received by the original x86/ARM procedures
// in Unicorn, using synthetic inputs. They are not a JS encoder round trip.
const fixtures = JSON.parse(readFileSync(new URL('./wonderwave-fixtures.json', import.meta.url)));
for (const fixture of fixtures.vectors) test(`original game routine vector: ${fixture.name}`, () => {
  const expected = fromHex(fixture.wireHex), header = fromHex(fixture.headerHex), payload = fromHex(fixture.payloadHex);
  assert.deepEqual(encodeSwanPacket({ variant: fixture.variant, header, payload }), expected);
  const decoded = decodeSwanPacket(expected);
  assert.equal(decoded.variant, fixture.variant); assert.equal(decoded.headerHex, fixture.headerHex);
  assert.equal(decoded.payloadHex, fixture.payloadHex); assert.equal(decoded.wireBytes, expected.length);
});

test('the echo control uses the same bytes as the first watch probe; every preset is nonempty', () => {
  assert.deepEqual(encodeSwanPacket(swanPreset(0)), encodeSwanPacket(swanPreset(1)));
  assert.equal(SWAN_PLAN[0].watchPresent, false);
  for (let index = 0; index < SWAN_PLAN.length; index++) {
    const preset = swanPreset(index), frame = encodeSwanPacket(preset);
    assert.equal(decodeSwanPacket(frame).payloadHex, '00');
    assert.equal(frame.length, preset.variant === 1 ? 35 : 20);
  }
  assert.throws(() => swanPreset(99), RangeError);
});

test('malformed hex, header sizes, selectors and empty/oversized payloads cannot produce a packet', () => {
  for (const value of ['', '0', '0x15', 'GG', '01,fe']) assert.throws(() => packetBytes(value), RangeError);
  assert.deepEqual(packetBytes('55 FF\n00'), b(0x55, 255, 0));
  const preset = swanPreset(1);
  for (const change of [{ variant: 0 }, { variant: '1' }, { header: b() }, { header: [...preset.header] }, { payload: b() }, { payload: new Uint8Array(129) }]) {
    assert.throws(() => encodeSwanPacket({ ...preset, ...change }), RangeError);
  }
});

test('the scanner rejects broken complements, SUM8 and truncated frames without altering RX', () => {
  const valid = encodeSwanPacket(swanPreset(1)), badPair = valid.slice(), badSum = valid.slice();
  badPair[7] ^= 1; badSum[badSum.length - 2] ^= 1; badSum[badSum.length - 1] ^= 1;
  assert.throws(() => decodeSwanPacket(badPair), /Complement/); assert.throws(() => decodeSwanPacket(badSum), /SUM8/);
  assert.throws(() => decodeSwanPacket(valid.slice(0, -1)), /pair/);
  const bytes = concat(b(255, 0x23), badPair, badSum, valid, valid.slice(0, 10)), original = bytes.slice();
  const scan = scanSwanPackets(bytes);
  assert.deepEqual(bytes, original); assert.equal(scan.packets.length, 1); assert.equal(scan.packets[0].offset, 72);
  assert.equal(scan.rejected.length, 3); assert.match(scan.rejected.at(-1).error, /Incomplete/);
});

const rx = bytes => ({ kind: 'usb-result', operation: 'transferIn', status: 'ok', data: { hex: toHex(bytes), byteLength: bytes.length } });
test('USB fragments and late completions are reassembled, while exact TX matches remain in raw RX', () => {
  const frame = encodeSwanPacket(swanPreset(1)), reply = encodeSwanPacket(swanPreset(2));
  const events = [rx(b(255, 255)), { kind: 'serial-tx-usb-complete', dataHex: toHex(frame) },
    rx(frame.slice(0, 17)), rx(b()), rx(concat(frame.slice(17), reply.slice(0, 9))), { kind: 'serial-ending' }, rx(reply.slice(9))];
  const analysis = analyseSwanCapture(events, frame);
  assert.equal(analysis.rxBytes, 72); assert.equal(analysis.packets.length, 2);
  assert.equal(analysis.txMatches[0].offset, 2); assert.equal(analysis.possibleEchoBytes, 35);
  assert.equal(analysis.packets[0].possibleEcho, true); assert.equal(analysis.packets[1].possibleEcho, false);
  assert.equal(analysis.rawBytesPreserved, true); assert.equal(analysis.echoRemoved, false);
});

test('planned, failed and early bytes are not reported as adapter echo', () => {
  const frame = encodeSwanPacket(swanPreset(1));
  for (const prefix of [[], [{ kind: 'serial-tx-attempt', dataHex: toHex(frame) }]]) {
    const analysis = analyseSwanCapture([...prefix, rx(frame)], frame);
    assert.equal(analysis.packets.length, 1); assert.equal(analysis.txMatches.length, 0); assert.equal(analysis.packets[0].possibleEcho, false);
  }
  const analysis = analyseSwanCapture([rx(frame), { kind: 'serial-tx-usb-complete', dataHex: toHex(frame) }, rx(b(255))], frame);
  assert.equal(analysis.txMatches.length, 0); assert.equal(analysis.packets[0].possibleEcho, false);
});

test('ZIP inputs preserve original streams, pending calls, planned and completed transmission separately', () => {
  const frame = encodeSwanPacket(swanPreset(1));
  const attempt = { kind: 'serial', packetFormat: SWAN_FORMAT, probeHex: toHex(frame), status: 'error' };
  const usbOut = concat(b(0x55, 0xaa, frame.length, 0), frame);
  const events = [{ kind: 'serial-tx-attempt', dataHex: toHex(frame) },
    { kind: 'usb-call', id: 1, operation: 'transferOut', args: [1, { hex: toHex(usbOut) }] },
    { kind: 'usb-result', id: 1, operation: 'transferOut', status: 'stall', bytesWritten: 0 },
    rx(concat(b(255), frame)), { kind: 'usb-call', id: 2, operation: 'transferIn', args: [2, 64] }];
  const files = new Map(swanAttemptFiles(attempt, events).map(file => [file.name, file.data]));
  const json = name => JSON.parse(new TextDecoder().decode(files.get(name)));
  assert.deepEqual(files.get('usb-in.bin'), concat(b(255), frame));
  assert.deepEqual(files.get('usb-out-requested.bin'), usbOut); assert.deepEqual(files.get('serial-out-requested.bin'), frame);
  assert.equal(files.get('serial-out-completed.bin').length, 0); assert.deepEqual(files.get('candidate-frame.bin'), frame);
  assert.deepEqual(json('attempt.json').pendingUSBCalls, [2]); assert.equal(json('analysis.json').txMatches.length, 0);
  assert.equal(new TextDecoder().decode(files.get('events.jsonl')).trim().split('\n').length, events.length);
});
