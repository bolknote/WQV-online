import test from 'node:test';
import assert from 'node:assert/strict';
import { createSuite } from '../dist/irtranp-suite.mjs';
import { SUITE_RU } from '../dist/irtranp-suite-ui.mjs';
import { featureStepTitle, featureInstructions, featureSendButtonText, missingPhotoInstructions, reportResultKey } from '../dist/irtranp-presentation.mjs';

const english = text => text, russian = text => SUITE_RU[text] ?? text;
const suite = createSuite('operations');

test('the start button distinguishes each single-file control from the two-file test', () => {
  assert.equal(featureSendButtonText('single-10', english), 'Send only photo 10');
  assert.equal(featureSendButtonText('single-11', english), 'Send only photo 11');
  assert.equal(featureSendButtonText('multiple', english), 'Send photos 10 and 11');
  assert.equal(featureSendButtonText('multiple-csi', english), 'Send photos 10 and 11');
  assert.equal(featureSendButtonText('single-10', russian), 'Отправить только снимок 10');
  assert.equal(featureSendButtonText('single-11', russian), 'Отправить только снимок 11');
  assert.equal(featureSendButtonText('multiple', russian), 'Отправить снимки 10 и 11');
  assert.equal(featureSendButtonText('multiple-csi', russian), 'Отправить снимки 10 и 11');
});

test('an acknowledged upload is never displayed as a verified stored photo', () => {
  const report = Object.freeze({ test: 'sender', verdict: 'passed', featureEvidence: { role: 'write', caseID: 'multiple' } });
  assert.equal(reportResultKey(report), 'Upload acknowledged');
  assert.equal(russian(reportResultKey(report)), 'Передача подтверждена');
  assert.equal(report.verdict, 'passed');
  for (const verdict of ['incomplete', 'failed', 'interrupted', 'not-run', 'recorded']) {
    assert.equal(reportResultKey({ ...report, verdict }), verdict);
  }
  assert.equal(reportResultKey({ test: 'receiver', verdict: 'passed', featureEvidence: { outcome: 'image-matches' } }), 'image-matches');
  assert.equal(reportResultKey({ test: 'ias', verdict: 'passed' }), 'passed');
});

test('the two-file upload and its two individual read-backs identify direction and different photo numbers', () => {
  for (const t of [english, russian]) {
    const write = featureInstructions(suite.steps[0].feature, t);
    assert.match(write, /OTHERS RECEIVE/); assert.match(write, /10/); assert.match(write, /11/);
    assert.doesNotMatch(write, /OTHERS SEND/);
    for (const [index, number] of [[1, '10'], [2, '11']]) {
      const step = suite.steps[index], title = featureStepTitle(step, t), instructions = featureInstructions(step.feature, t);
      assert.match(title, new RegExp(number)); assert.match(instructions, /OTHERS SEND/);
      assert.match(instructions, new RegExp(number)); assert.doesNotMatch(instructions, /OTHERS RECEIVE/);
      assert.doesNotMatch(title + instructions, /\{number\}/);
    }
    assert.notEqual(featureStepTitle(suite.steps[1], t), featureStepTitle(suite.steps[2], t));
  }
});

test('a missing-photo hint names only the required photo and does not ask for a substitute', () => {
  for (const t of [english, russian]) {
    assert.equal(missingPhotoInstructions(suite.steps[0].feature, t), '');
    const first = missingPhotoInstructions(suite.steps[1].feature, t);
    const second = missingPhotoInstructions(suite.steps[2].feature, t);
    assert.match(first, /10/); assert.doesNotMatch(first, /11/);
    assert.match(second, /11/); assert.doesNotMatch(second, /10/);
    assert.doesNotMatch(first + second, /\{number\}/);
  }
});
