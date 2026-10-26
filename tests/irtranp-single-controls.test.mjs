import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFeatureFiles } from '../dist/irtranp-feature-images.mjs';
import { createSuite } from '../dist/irtranp-suite.mjs';
import { featureInstructions, featureStepTitle } from '../dist/irtranp-presentation.mjs';
import { SUITE_RU } from '../dist/irtranp-suite-ui.mjs';
import { fromHex, toHex, sha256 } from '../dist/formats.mjs';

const captured = JSON.parse(await readFile(new URL('./multiple-rd-hardware-fixture.json', import.meta.url)));

test('single controls reuse both exact files from the failed hardware pair, including names and nonce', async () => {
  for (const [index, number] of [10, 11].entries()) {
    const first = await createFeatureFiles('single-' + number, 'FFFF');
    const repeated = await createFeatureFiles('single-' + number, 'AAAA');
    assert.equal(first.files.length, 1); assert.equal(first.reusedInput, true); assert.equal(first.nonce, '07FB');
    const file = first.files[0], original = captured.inputs[index];
    assert.equal(file.filename, original.filename); assert.equal(toHex(file.bytes), original.dataHex);
    assert.equal(file.sha256, await sha256(fromHex(original.dataHex)));
    assert.equal(file.label, number + ' / 07FB'); assert.deepEqual(repeated.files[0].bytes, file.bytes);
    assert.equal(file.source.sourceAttemptID, captured.attemptID); assert.equal(file.source.unchanged, true);
    file.bytes[0] ^= 1;
    const again = await createFeatureFiles('single-' + number, '0000');
    assert.equal(toHex(again.files[0].bytes), original.dataHex, 'another attempt receives a fresh byte copy');
  }
});

test('the single-control plan alternates separate one-file uploads and their matching numbered read-backs', () => {
  const suite = createSuite('single-controls');
  assert.equal(suite.steps.length, 4); assert.equal(suite.automaticNextStep, false);
  for (const [index, item] of suite.steps.entries()) {
    assert.equal(item.copyCount, 1); assert.equal(item.sendPDU, 512); assert.equal(item.maxBaud, 9600);
    const number = index < 2 ? 10 : 11;
    assert.equal(item.feature.caseID, 'single-' + number);
    assert.equal(item.watchMode, index % 2 === 0 ? 'others-receive' : 'others-send');
    assert.equal(item.feature.sourceStepID, `single-${number}-write-0`);
    const t = text => SUITE_RU[text] ?? text;
    assert.match(featureStepTitle(item, t), new RegExp(String(number)));
    assert.match(featureInstructions(item.feature, t), new RegExp(String(number)));
    assert.doesNotMatch(featureInstructions(item.feature, t), /\{number\}/);
  }
});
