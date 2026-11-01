import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { KingsunCounter, KingsunStream } from '../dist/kingsun.mjs';
import { FrameDecoder } from '../dist/irda.mjs';
import { concat, fromHex as hx } from '../dist/formats.mjs';

const hardware = JSON.parse(await readFile(new URL('./fixtures/ks959-interrupt-rx-hardware.json', import.meta.url)));

test('actual interrupt-IN bytes share the control-IN XOR counter, with eight exact CRC-valid frames', () => {
  const counter = new KingsunCounter(hardware.initialPhase), decoder = new FrameDecoder();
  for (const stage of hardware.stages) {
    assert.equal(counter.phase, stage.initialPhase, stage.label);
    const raw = stage.readsHex.map(hx), decoded = concat(...raw.map(part => counter.feed(part)));
    assert.equal(concat(...raw).length, stage.rawBytes);
    assert.deepEqual(decoded, hx(stage.expectedWireHex), stage.label);
    assert.equal(counter.phase, stage.finalPhase, stage.label);
    decoder.feed(decoded);
  }
  assert.equal(counter.phase, hardware.finalPhase);
  assert.equal(counter.skipped, 2);
  assert.equal(counter.unexpectedMarkers, 0);
  assert.equal(decoder.badCRC, 0);
  assert.equal(decoder.recoveredFrames, 0);
  assert.equal(decoder.frames.length, hardware.frameCount);
  assert.ok(decoder.frames.every(f => f.address === 0xfc && f.control === 3));
});

test('an unknown counter synchronizes from the two actual frames on either interrupt read size', () => {
  for (const stage of hardware.stages.filter(s => s.endpoint === 0x81)) {
    const raw = concat(...stage.readsHex.map(hx));
    for (const chunks of [stage.readsHex.map(hx), Array.from(raw, value => Uint8Array.of(value))]) {
      const stream = new KingsunStream();
      const decoded = concat(...chunks.map(part => stream.feed(part)));
      assert.deepEqual(decoded, hx(stage.expectedWireHex), stage.label);
      assert.equal(stream.counter.phase, stage.finalPhase);
      assert.equal(stream.counter.unexpectedMarkers, 0);
    }
  }
});
