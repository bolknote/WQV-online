import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SUITE_PLANS, createSuite, currentStep, bindAttempt, advanceSuite, stepCanAdvance,
  repeatSuiteStep, cancelSuiteRepeat, analyseAttempt, suiteSummary, suiteFiles } from '../dist/irtranp-suite.mjs';
import { IrTranPReceiver } from '../dist/irtranp-core.mjs';
import { IrTranPIASProbe } from '../dist/irtranp-ias.mjs';
import { FrameDecoder } from '../dist/irda.mjs';
import { b, fromHex, toHex } from '../dist/formats.mjs';

const fixture = JSON.parse(await readFile(new URL('./receiver-hardware-fixtures.json', import.meta.url)));
const text = bytes => new TextDecoder().decode(bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = '2026-10-24T10:00:00.000Z';
const attemptFor = (suite, id, extra = {}) => ({ ...currentStep(suite), id, kind: 'irtranp',
  createdAt: iso, status: 'prepared', ...extra });

test('test plans retain manual boundaries, fixed passive rates and matched-image comparison settings', () => {
  assert.deepEqual(SUITE_PLANS.map(plan => [plan.id, plan.steps.length]),
    [['multiple-wince211', 3], ['selection', 3], ['receive', 6], ['connection', 4], ['metadata', 18], ['operations', 11], ['multiple-csi', 3], ['single-controls', 4], ['full', 15]]);
  const suite = createSuite('full', { id: 'suite', now: iso });
  assert.equal(suite.automaticNextStep, false);
  assert.equal(suite.cursor, 0);
  assert.deepEqual(suite.steps.slice(0, 3).map(step => [step.test, step.maxBaud, step.frameRecovery]),
    [['listen-selection', 9600, 'strict'], ['listen-selection', 38400, 'strict'], ['listen-selection', 115200, 'strict']]);
  for (const step of suite.steps) {
    assert.ok(step.seconds >= 2 && step.seconds <= 120);
    assert.equal(step.watchMode, ['receiver', 'listen-selection'].includes(step.test) ? 'others-send' : 'others-receive');
  }
  assert.equal(new Set(suite.steps.map(step => step.id)).size, suite.steps.length);
  assert.equal(suite.steps.filter(step => step.frameRecovery === 'strict' && step.test === 'receiver').length, 2);
  assert.throws(() => createSuite('unknown'), /Unknown/);
});

test('each retry keeps its own journal reference; advancing and skipping are explicit and survive serialization', () => {
  let suite = createSuite('receive', { id: 'suite', now: iso });
  assert.throws(() => advanceSuite(suite, []), /Run the step/);
  const a = attemptFor(suite, 'first', { status: 'error', startedAt: iso });
  bindAttempt(suite, a);
  assert.equal(suite.cursor, 0, 'Finishing or binding an attempt never advances the plan');
  assert.equal(stepCanAdvance(suite, [a]), true);
  const retry = attemptFor(suite, 'retry'); bindAttempt(suite, retry);
  assert.equal(stepCanAdvance(suite, [a, retry]), false, 'An earlier failure cannot advance a newly prepared retry');
  retry.status = 'running'; retry.startedAt = iso;
  assert.equal(stepCanAdvance(suite, [a, retry]), false);
  retry.status = 'received';
  bindAttempt(suite, retry); // Idempotent binding must not duplicate an attempt.
  assert.deepEqual(currentStep(suite).attemptIDs, ['first', 'retry']);
  assert.equal(retry.suite.repetition, 2);
  assert.equal(stepCanAdvance(suite, [retry, a]), true);
  suite = JSON.parse(JSON.stringify(suite));
  advanceSuite(suite, [a, retry]); assert.equal(suite.cursor, 1);
  assert.throws(() => advanceSuite(suite, [], { skipReason: '  ' }), /reason/);
  advanceSuite(suite, [], { skipReason: 'watch battery low' });
  assert.equal(suite.steps[1].skipped, true); assert.equal(suite.steps[1].skipReason, 'watch battery low');
  while (currentStep(suite)) advanceSuite(suite, [], { skipReason: 'not tested' });
  assert.equal(suite.status, 'finished'); assert.equal(suite.cursor, suite.steps.length);
  assert.throws(() => bindAttempt(suite, a), /no current step/);
});

test('a series cannot silently record another mode, speed, profile or recovery setting under its current step', () => {
  for (const [key, value] of Object.entries({ test: 'ias', watchMode: 'others-receive',
    maxBaud: 9600, imageProfile: 'nokia-original', frameRecovery: 'strict' })) {
    const suite = createSuite('receive');
    assert.throws(() => bindAttempt(suite, attemptFor(suite, 'bad', { [key]: value })), new RegExp(key));
    assert.deepEqual(currentStep(suite).attemptIDs, []);
  }
});

test('an earlier step can be repeated without overwriting later runs or losing the return position', () => {
  let suite = createSuite('receive'), attempts = [];
  for (let index = 0; index < 5; index++) {
    const attempt = attemptFor(suite, 'original-' + index, { startedAt: iso, status: index === 1 ? 'error' : 'received' });
    bindAttempt(suite, attempt); attempts.push(attempt); advanceSuite(suite, attempts);
  }
  const before = structuredClone(suite.steps);
  repeatSuiteStep(suite, 1, attempts, { now: iso });
  assert.equal(suite.cursor, 1); assert.equal(suite.repeat.resumeCursor, 5);
  assert.deepEqual(suite.steps, before); assert.equal(stepCanAdvance(suite, attempts), false);
  assert.throws(() => advanceSuite(suite, attempts), /Run the step/);
  assert.throws(() => advanceSuite(suite, attempts, { skipReason: 'skip' }), /Cancel/);
  suite = JSON.parse(JSON.stringify(suite)); // A reload retains the repeat and return position.
  const rerun = attemptFor(suite, 'new-repeat'); bindAttempt(suite, rerun); attempts.push(rerun);
  assert.equal(rerun.suite.stepID, 'nokia-fast'); assert.equal(rerun.suite.repetition, 2);
  assert.equal(rerun.suite.repeatStartedAt, iso);
  assert.equal(stepCanAdvance(suite, attempts), false);
  assert.throws(() => cancelSuiteRepeat(suite, attempts), /release USB/);
  rerun.startedAt = iso; rerun.status = 'received';
  advanceSuite(suite, attempts, { now: iso });
  assert.equal(suite.cursor, 5); assert.equal(suite.repeat, undefined);
  assert.deepEqual(suite.steps[1].attemptIDs, ['original-1', 'new-repeat']);
  for (const index of [0, 2, 3, 4, 5]) assert.deepEqual(suite.steps[index], before[index]);
  assert.equal(suite.repeatHistory[0].outcome, 'finished');
  assert.deepEqual(suite.repeatHistory[0].attemptIDs, ['new-repeat']);
});

test('cancelling a repeat preserves the original verdict, all attempts and an already completed series', async () => {
  const suite = createSuite('selection');
  while (currentStep(suite)) advanceSuite(suite, [], { skipReason: 'not available' });
  const before = structuredClone(suite.steps);
  repeatSuiteStep(suite, 0, []);
  assert.equal(suite.status, 'open');
  assert.throws(() => repeatSuiteStep(suite, 0, []));
  cancelSuiteRepeat(suite, []);
  assert.equal(suite.status, 'finished'); assert.equal(suite.cursor, 3);
  assert.deepEqual(suite.steps, before); assert.equal(suite.repeatHistory[0].outcome, 'cancelled');
  repeatSuiteStep(suite, 1, []);
  const rerun = attemptFor(suite, 'failed-repeat', { status: 'error', startedAt: iso }); bindAttempt(suite, rerun);
  advanceSuite(suite, [rerun]);
  assert.equal(suite.status, 'finished'); assert.equal(suite.cursor, 3);
  const files = new Map((await suiteFiles(suite, [{ attempt: rerun, events: [] }])).map(file => [file.name, file.data]));
  const plan = JSON.parse(text(files.get('plan.json')));
  assert.equal(plan.repeatHistory.length, 2);
  assert.deepEqual(plan.steps[1].attemptIDs, ['failed-repeat']);
  assert.equal(plan.repeatHistory[1].priorSkip.reason, 'not available');
});

test('step repeats reject future positions and live USB sessions', () => {
  const suite = createSuite('receive'); suite.cursor = 2;
  for (const index of [-1, 2, 3, 99, 1.5]) assert.throws(() => repeatSuiteStep(suite, index, []), RangeError);
  suite.steps[0].attemptIDs.push('in-flight');
  for (const status of ['preparing', 'prepared', 'running']) {
    assert.throws(() => repeatSuiteStep(suite, 1, [{ id: 'in-flight', status }]), /release USB/);
    assert.equal(suite.cursor, 2);
  }
});

for (const Receiver of [IrTranPReceiver, IrTranPIASProbe]) {
  test(`${Receiver.name} honours explicit strict and PAD-5 recovery settings`, () => {
    for (const [mode, recoverFrames, recoverBOF] of [['strict', false, false], ['pad5', true, false], ['pad5-bof', true, true]]) {
      const adapter = { decoder: new FrameDecoder({ recoverFrames: true, recoverBOF: true }) };
      new Receiver(adapter, { frameRecovery: mode, localID: fromHex('12345678'), maxBaud: 9600 });
      assert.equal(adapter.decoder.recoverFrames, recoverFrames);
      assert.equal(adapter.decoder.recoverBOF, recoverBOF);
    }
    assert.throws(() => new Receiver({ decoder: new FrameDecoder() }, { frameRecovery: 'guess' }), /recovery/);
  });
}

// These are the original successful hardware input bytes. This replay retains
// their frame contents, but deliberately makes no claim about original timing
// or USB transfer boundaries (the complete source ZIPs retain both).
async function replay(session) {
  const decoder = new FrameDecoder(), bytes = fromHex(session.usbInHex), events = [];
  let clock = 0, sent = 0;
  const record = (kind, details = {}) => events.push({ kind, ...details, attemptId: session.id,
    seq: events.length, elapsedMs: clock++, at: iso });
  record('receiver-manual-start');
  record('usb-call', { id: 1, operation: 'transferIn', args: [2, 64] });
  record('usb-result', { id: 1, operation: 'transferIn', status: 'ok', data: { hex: session.usbInHex } });
  decoder.feed(bytes);
  const adapter = { decoder, opened: true, configured: true, baud: 9600, revision: 7,
    readerTask: null, rxBytes: bytes.length, txFrames: 0, readPending: false,
    assertOpen() {}, async setSIRSpeed(rate) { this.baud = rate; },
    async sendFrame(address, control, data) {
      assert.deepEqual({ address, control, dataHex: toHex(data) }, session.expectedTransmissions[sent++]);
      this.txFrames++;
    }, device: { transferIn() { throw new Error('Unexpected read'); } } };
  const result = await new IrTranPReceiver(adapter, { localID: fromHex(session.localID),
    imageProfile: session.imageProfile, maxBaud: session.maxBaud ?? 115200, frameRecovery: 'strict', record }).run(2000);
  return { attempt: { id: session.id, createdAt: iso, kind: 'irtranp', test: 'receiver',
    imageProfile: session.imageProfile, frameRecovery: 'strict', maxBaud: session.maxBaud ?? 115200, watchMode: 'others-send',
    startedAt: iso, status: result.status, result, counters: result }, events };
}
const hardware = await Promise.all(fixture.sessions.map(replay));

test('analysis recognises original photo exchanges with their negotiated speed and exact captured file hashes', async () => {
  const reports = await Promise.all(hardware.map(({ attempt, events }) => analyseAttempt(attempt, events)));
  for (const [index, report] of reports.entries()) {
    const session = fixture.sessions[index];
    assert.equal(report.verdict, 'passed'); assert.equal(report.cleanDisconnect, true);
    assert.equal(report.negotiatedBaud, session.maxBaud ?? 115200, 'Returning to discovery speed at close is not the negotiated transfer rate');
    assert.equal(report.badCRC, 0); assert.equal(report.recoveredFrames, 0);
    assert.equal(report.files[0].bytes, 1698); assert.equal(report.files[0].jpegBytes, 1314);
    assert.equal(report.files[0].width, 176); assert.equal(report.files[0].height, 144);
    assert.equal(report.files[0].upfSHA256, hash(fromHex(session.expectedUPFHex)));
    assert.ok(report.layers.every(layer => layer.status === 'observed'), JSON.stringify(report.layers));
    assert.deepEqual(report.pendingUSBCalls, []);
  }
  assert.equal(reports[0].files[0].jpegSHA256, reports[1].files[0].jpegSHA256);
});

test('a received photo is not a passed session with missing disconnect, pending USB, an error or a live snapshot', async () => {
  const original = hardware[0];
  const withoutDisconnect = original.events.filter(event => !['rx-frame', 'tx-frame'].includes(event.kind) || ![0x53, 0x73].includes(event.control));
  assert.equal((await analyseAttempt(original.attempt, withoutDisconnect)).verdict, 'incomplete');
  const pending = [...original.events, { kind: 'usb-call', id: 999, operation: 'transferIn', attemptId: original.attempt.id }];
  const report = await analyseAttempt(original.attempt, pending);
  assert.equal(report.verdict, 'incomplete'); assert.deepEqual(report.pendingUSBCalls, [999]);
  for (const [status, verdict] of [['running', 'incomplete'], ['interrupted', 'interrupted'], ['error', 'failed']]) {
    assert.equal((await analyseAttempt({ ...original.attempt, status }, original.events)).verdict, verdict);
  }
  const badFile = original.events.map(event => event.kind === 'irtranp-file' ? { ...event, dataHex: '0000' } : event);
  assert.equal((await analyseAttempt(original.attempt, badFile)).verdict, 'incomplete');
  await assert.rejects(analyseAttempt({ ...original.attempt, id: 'another' }, original.events), /Mixed/);
});

const passive = () => {
  const attempt = { id: 'passive', kind: 'irtranp', test: 'listen-selection', watchMode: 'others-send',
    createdAt: iso, startedAt: iso, status: 'captured', maxBaud: 9600, imageProfile: 'csi', frameRecovery: 'strict', result: { elapsedMs: 2000 } };
  const events = [], mark = (stage, ms, frameLabel) => events.push({ kind: 'watch-stage-mark', stage, elapsedMs: ms, frameLabel });
  const input = (id, hex, ms) => events.push({ kind: 'usb-call', id, operation: 'transferIn', elapsedMs: ms - 1 },
    { kind: 'usb-result', id, operation: 'transferIn', status: 'ok', data: { hex }, elapsedMs: ms });
  events.push({ kind: 'receiver-manual-start', elapsedMs: 10 }); input(1, 'aa', 15);
  mark('selection-open', 20, '01'); input(2, '23e1', 25);
  mark('next-image', 30, '02'); input(3, '', 35); input(4, '123456', 40);
  mark('transmit-start', 50, '02'); input(5, 'c0c1', 60);
  return { attempt, events };
};

test('passive stage counts keep unknown bytes and distinguish image selection from actual transmission', async () => {
  const { attempt, events } = passive(), report = await analyseAttempt(attempt, events);
  assert.equal(report.verdict, 'recorded'); assert.equal(report.rxBytes, 8);
  assert.equal(report.negotiatedBaud, null); assert.equal(report.receiveBaud, 9600);
  assert.equal(report.reads, 5); assert.equal(report.emptyReads, 1); assert.equal(report.completedWrites, 0);
  assert.equal(report.frontButtonMarkers, 2); assert.equal(report.markers[1].frameLabel, '02');
  assert.deepEqual(report.windows.map(window => [window.stage, window.rxBytes]),
    [['before-first-marker', 1], ['selection-open', 2], ['next-image', 3], ['transmit-start', 2]]);
  const exported = new Map((await suiteFiles(null, [{ attempt, events }])).map(file => [file.name, file.data]));
  const root = 'attempts/001-passive/';
  assert.equal(toHex(exported.get(root + 'usb-in.bin')), 'aa23e1123456c0c1');
  for (const [index, hex] of ['aa', '23e1', '123456', 'c0c1'].entries()) {
    assert.equal(toHex(exported.get(root + `stage-windows/${String(index).padStart(3, '0')}.bin`)), hex);
  }
  assert.equal(exported.get(root + 'usb-out-requested.bin').length, 0);
  assert.match(text(exported.get(root + 'README.txt')), /USB bulk OUT is blocked/);
  assert.equal((await analyseAttempt({ ...attempt, status: 'no-data' }, events.filter(event => event.kind !== 'usb-result'))).verdict, 'incomplete');
  const quiet = events.map(event => event.data ? { ...event, data: { hex: '' } } : event);
  assert.equal((await analyseAttempt({ ...attempt, status: 'no-data' }, quiet)).verdict, 'no-data');
});

test('file hash comparisons distinguish metadata from JPEG bytes and keep different series separate', async () => {
  const first = structuredClone(hardware[0]), second = structuredClone(hardware[1]);
  first.attempt.suite = { id: 'one', comparisonGroup: 'same-watch-photo' };
  second.attempt.suite = { id: 'one', comparisonGroup: 'same-watch-photo' };
  const file = second.events.find(event => event.kind === 'irtranp-file'), bytes = fromHex(file.dataHex);
  bytes[100] ^= 1; file.dataHex = toHex(bytes); // Outside the main JPEG data.
  let report = await suiteSummary(null, [first, second]);
  assert.equal(report.attempts[1].comparison.sameUPF, false);
  assert.equal(report.attempts[1].comparison.sameJPEG, true);
  second.attempt.suite.id = 'two';
  report = await suiteSummary(null, [first, second]);
  assert.equal(report.attempts[1].comparison.baselineAttemptID, second.attempt.id);
});

test('series ZIP files keep failures and retries, original event order, skipped reasons and independently verified hashes', async () => {
  const suite = createSuite('selection', { id: 'suite', now: iso });
  const failed = { attempt: attemptFor(suite, 'failed', { status: 'error', startedAt: iso }),
    events: [{ kind: 'receiver-error', error: 'USB error', elapsedMs: 12 }] };
  bindAttempt(suite, failed.attempt);
  const retry = passive(); bindAttempt(suite, retry.attempt);
  advanceSuite(suite, [failed.attempt, retry.attempt]);
  advanceSuite(suite, [], { skipReason: '=manual skip; keep this text' });
  const files = await suiteFiles(suite, [failed, retry]), entries = new Map(files.map(file => [file.name, file.data]));
  const report = JSON.parse(text(entries.get('summary.json')));
  assert.equal(report.totals.attempts, 2); assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.recorded, 1); assert.equal(report.totals.skippedSteps, 1);
  assert.deepEqual(JSON.parse(text(entries.get('plan.json'))).steps[0].attemptIDs, ['failed', 'passive']);
  assert.match(text(entries.get('plan.json')), /=manual skip; keep this text/);
  assert.deepEqual(text(entries.get('attempts/002-passive/events.jsonl')).trim().split('\n').map(JSON.parse), retry.events);
  const manifest = JSON.parse(text(entries.get('manifest.json')));
  assert.equal(manifest.files.length, entries.size - 1);
  for (const item of manifest.files) {
    assert.equal(entries.get(item.path).length, item.bytes, item.path);
    assert.equal(hash(entries.get(item.path)), item.sha256, item.path);
  }
  await assert.rejects(suiteFiles(suite, [retry, retry]), /Duplicate/);
  const noRuns = await suiteFiles(suite, []);
  assert.ok(noRuns.some(file => file.name === 'summary.json'), 'Explicit skips can be exported without a successful attempt');
  const photoFiles = await suiteFiles(null, [hardware[0]]);
  assert.equal(photoFiles.find(file => file.name.endsWith('previews/000.jpg')).data.length, 1314);
});

test('an all-attempts backup also preserves unrun series and their explicit skips', async () => {
  const suites = [createSuite('selection'), createSuite('connection')];
  advanceSuite(suites[1], [], { skipReason: 'not available today' });
  const exported = new Map((await suiteFiles(null, [], { suites })).map(file => [file.name, file.data]));
  assert.deepEqual(JSON.parse(text(exported.get('plans.json'))), suites);
  const report = JSON.parse(text(exported.get('summary.json')));
  assert.equal(report.totals.attempts, 0); assert.equal(report.totals.skippedSteps, 1);
  assert.deepEqual(report.suites, suites);
});
