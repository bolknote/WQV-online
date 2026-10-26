import { fromHex, sha256, jpegFromUPF, jpegInfo } from './formats.mjs';
import { attemptFiles } from './research-core.mjs';
import { upfMetadata, transferMetadata, jpegImageFingerprint, compareMetadata, featureCase } from './irtranp-metadata.mjs';

export const RECOVERY_MODES = Object.freeze(['auto', 'strict', 'pad5', 'pad5-bof']);
export const TEST_RATES = Object.freeze([9600, 38400, 115200]);
const step = (id, test, maxBaud, imageProfile = 'csi', frameRecovery = test === 'receiver' ? 'pad5' : 'pad5-bof') =>
  Object.freeze({ id, test, maxBaud, imageProfile, frameRecovery, seconds: test === 'listen-selection' ? 90 : 60,
    watchMode: ['receiver', 'listen-selection'].includes(test) ? 'others-send' : 'others-receive',
    comparisonGroup: test === 'receiver' ? 'same-watch-photo' : null });
const receive = [step('csi-fast', 'receiver', 115200), step('nokia-fast', 'receiver', 115200, 'nokia-original'),
  step('csi-9600', 'receiver', 9600), step('nokia-9600', 'receiver', 9600, 'nokia-original'),
  step('csi-repeat', 'receiver', 115200), step('nokia-repeat', 'receiver', 115200, 'nokia-original')];
const connection = [step('ias-9600', 'ias', 9600), step('ias-fast', 'ias', 115200),
  step('capabilities-9600', 'csi', 9600), step('capabilities-fast', 'csi', 115200)];
const selection = TEST_RATES.map(rate => step('selection-' + rate, 'listen-selection', rate, 'csi', 'strict'));
const featureStep = (caseID, role, copyIndex = 0) => Object.freeze({
  ...step(`${caseID}-${role}-${copyIndex}`, role === 'write' ? 'sender' : 'receiver', caseID === 'fast' ? 115200 : 9600,
    'csi', 'pad5-bof'), comparisonGroup: null,
  feature: { caseID, role, copyIndex, sourceStepID: `${caseID}-write-0` },
  copyCount: featureCase(caseID).copies ?? 1, sendPDU: featureCase(caseID).sendPDU ?? 512,
  ...(role === 'write' && featureCase(caseID).transportProfile ? { transportProfile: featureCase(caseID).transportProfile } : {}),
});
const metadataSteps = ['control', 'filename', 'transfer-time', 'long-name', 'upf-dates', 'upf-title', 'upf-comment', 'upf-author', 'upf-thumbnail']
  .flatMap(id => [featureStep(id, 'write'), featureStep(id, 'read')]);
const operationSteps = [featureStep('multiple', 'write'), featureStep('multiple', 'read', 0), featureStep('multiple', 'read', 1),
  featureStep('stop', 'write'), featureStep('after-stop', 'write'), featureStep('after-stop', 'read'),
  featureStep('abort', 'write'), featureStep('after-abort', 'write'), featureStep('after-abort', 'read'),
  featureStep('fast', 'write'), featureStep('fast', 'read')];
const singleControlSteps = ['single-10', 'single-11'].flatMap(id => [featureStep(id, 'write'), featureStep(id, 'read')]);
const multipleCSISteps = [featureStep('multiple-csi', 'write'), featureStep('multiple-csi', 'read', 0), featureStep('multiple-csi', 'read', 1)];
const multipleCE211Steps = [featureStep('multiple-wince211', 'write'), featureStep('multiple-wince211', 'read', 0), featureStep('multiple-wince211', 'read', 1)];
export const SUITE_PLANS = Object.freeze([
  Object.freeze({ id: 'multiple-wince211', title: 'Two photos: Windows CE 2.11 transport', steps: Object.freeze(multipleCE211Steps) }),
  Object.freeze({ id: 'selection', title: 'SEND screen: passive recording', steps: Object.freeze(selection) }),
  Object.freeze({ id: 'receive', title: 'Photos: profiles, speed and repeatability', steps: Object.freeze(receive) }),
  Object.freeze({ id: 'connection', title: 'RECEIVE: IAS and capabilities', steps: Object.freeze(connection) }),
  Object.freeze({ id: 'metadata', title: 'Metadata: send and read back', steps: Object.freeze(metadataSteps) }),
  Object.freeze({ id: 'operations', title: 'Multiple files, cancellation and fast upload', steps: Object.freeze(operationSteps) }),
  Object.freeze({ id: 'multiple-csi', title: 'Two photos: CSI packet size', steps: Object.freeze(multipleCSISteps) }),
  Object.freeze({ id: 'single-controls', title: 'One at a time: exact photos 10 and 11', steps: Object.freeze(singleControlSteps) }),
  Object.freeze({ id: 'full', title: 'Full comparison', steps: Object.freeze([...selection, ...connection, ...receive,
    step('csi-strict', 'receiver', 115200, 'csi', 'strict'), step('nokia-strict', 'receiver', 115200, 'nokia-original', 'strict')]) }),
]);

export function createSuite(planID, { id = crypto.randomUUID(), now = new Date().toISOString() } = {}) {
  const plan = SUITE_PLANS.find(plan => plan.id === planID);
  if (!plan) throw new RangeError('Unknown test series.');
  return { id, format: 'wqv-irtranp-suite-v1', createdAt: now, planID, title: plan.title, cursor: 0, status: 'open',
    automaticNextStep: false, steps: plan.steps.map(item => ({ ...item, attemptIDs: [], skipped: false, skipReason: '' })) };
}
export function currentStep(suite) { return suite?.steps[suite.cursor] ?? null; }
export function bindAttempt(suite, attempt) {
  const selected = currentStep(suite);
  if (!selected) throw new Error('The test series has no current step.');
  for (const key of ['test', 'watchMode', 'maxBaud', 'imageProfile', 'frameRecovery']) {
    if (attempt[key] !== selected[key]) throw new Error('Attempt settings do not match the selected step: ' + key);
  }
  if ((attempt.transportProfile ?? 'current') !== (selected.transportProfile ?? 'current')) {
    throw new Error('Attempt transport profile does not match the selected step.');
  }
  if (selected.feature && (attempt.feature?.caseID !== selected.feature.caseID || attempt.feature?.role !== selected.feature.role ||
      (attempt.feature?.copyIndex ?? 0) !== selected.feature.copyIndex)) throw new Error('Feature test does not match this step.');
  if (!selected.attemptIDs.includes(attempt.id)) selected.attemptIDs.push(attempt.id);
  selected.skipped = false; selected.skipReason = ''; suite.status = 'open';
  attempt.suite = { id: suite.id, planID: suite.planID, stepID: selected.id, stepIndex: suite.cursor,
    repetition: selected.attemptIDs.indexOf(attempt.id) + 1, comparisonGroup: selected.comparisonGroup };
  if (suite.repeat) attempt.suite.repeatStartedAt = suite.repeat.startedAt;
}
export function stepCanAdvance(suite, attempts) {
  const selected = currentStep(suite);
  if (suite?.repeat && selected.attemptIDs.length <= suite.repeat.afterAttemptCount) return false;
  const last = selected && attempts.find(attempt => attempt.id === selected.attemptIDs.at(-1));
  return Boolean(selected && (selected.skipped || last?.startedAt && !['preparing', 'prepared', 'running'].includes(last.status)));
}
export function advanceSuite(suite, attempts, { skipReason, now = new Date().toISOString() } = {}) {
  const selected = currentStep(suite);
  if (!selected) throw new Error('The test series is finished.');
  if (suite.repeat && skipReason !== undefined) throw new Error('Cancel this repeat to return without changing the original step.');
  if (skipReason !== undefined) {
    if (!skipReason.trim()) throw new Error('Enter a reason for skipping this step.');
    selected.skipped = true; selected.skipReason = skipReason.trim().slice(0, 1000);
  } else if (!stepCanAdvance(suite, attempts)) throw new Error('Run the step or skip it explicitly before continuing.');
  if (suite.repeat) return finishRepeat(suite, 'finished', now);
  suite.cursor++;
  if (suite.cursor === suite.steps.length) suite.status = 'finished';
  return currentStep(suite);
}

function requireReleased(suite, attempts) {
  const ids = new Set(suite.steps.flatMap(step => step.attemptIDs));
  if (attempts.some(attempt => ids.has(attempt.id) && ['preparing', 'prepared', 'running'].includes(attempt.status))) {
    throw new Error('Stop the test and release USB before changing the step.');
  }
}
export function repeatSuiteStep(suite, index, attempts, { now = new Date().toISOString() } = {}) {
  if (!suite || !Number.isInteger(index) || index < 0 || index >= suite.steps.length || index >= suite.cursor) {
    throw new RangeError('Only an earlier step can be reopened for a repeat.');
  }
  if (suite.repeat) throw new Error('Finish or cancel the current repeat first.');
  requireReleased(suite, attempts);
  const selected = suite.steps[index];
  suite.repeat = { stepIndex: index, resumeCursor: suite.cursor, afterAttemptCount: selected.attemptIDs.length,
    priorSkip: { skipped: selected.skipped, reason: selected.skipReason }, startedAt: now };
  suite.cursor = index; suite.status = 'open';
  return selected;
}
function finishRepeat(suite, outcome, now) {
  const repeat = suite.repeat;
  suite.repeatHistory ??= [];
  suite.repeatHistory.push({ ...repeat, outcome, finishedAt: now,
    attemptIDs: suite.steps[repeat.stepIndex].attemptIDs.slice(repeat.afterAttemptCount) });
  suite.cursor = repeat.resumeCursor; delete suite.repeat;
  suite.status = suite.cursor === suite.steps.length ? 'finished' : 'open';
  return currentStep(suite);
}
export function cancelSuiteRepeat(suite, attempts, { now = new Date().toISOString() } = {}) {
  if (!suite?.repeat) throw new Error('There is no reopened step to cancel.');
  requireReleased(suite, attempts);
  return finishRepeat(suite, 'cancelled', now);
}

function cleanDisconnect(events) {
  for (let i = 0; i < events.length; i++) {
    const disc = events[i];
    if (!['rx-frame', 'tx-frame'].includes(disc.kind) || disc.control !== 0x53) continue;
    const opposite = disc.kind === 'rx-frame' ? 'tx-frame' : 'rx-frame';
    if (events.slice(i + 1).some(event => event.kind === opposite && event.control === 0x73 &&
      event.address === (disc.address ^ 1) && !event.dataHex)) return true;
  }
  return false;
}

export async function analyseAttempt(attempt, events) {
  if (events.some(event => event.attemptId && event.attemptId !== attempt.id)) throw new Error('Mixed attempt journals.');
  const result = attempt.result ?? {}, counters = attempt.counters ?? result, pending = new Set(), files = [], uploads = [];
  const start = events.find(event => event.kind === 'receiver-manual-start') ??
    events.find(event => ['irtranp-start', 'listen-start'].includes(event.kind));
  let reads = 0, nonemptyReads = 0, rxBytes = 0, completedWrites = 0, queuedWrites = 0;
  const markers = [], windows = [];
  let window = { stage: 'before-first-marker', label: '', rxBytes: 0, reads: 0, firstDataMs: null };
  windows.push(window);
  for (const event of events) {
    if (event.kind === 'usb-call') { pending.add(event.id); if (event.operation === 'transferOut') queuedWrites++; }
    if (['usb-result', 'usb-error'].includes(event.kind)) pending.delete(event.id);
    if (event.kind === 'usb-result' && event.operation === 'transferOut' && event.status === 'ok') completedWrites++;
    const inWindow = start && event.elapsedMs >= start.elapsedMs;
    if (event.kind === 'watch-stage-mark' && inWindow) {
      const marker = { stage: event.stage, label: event.label ?? '', at: event.at,
        elapsedMs: event.elapsedMs - start.elapsedMs, frameLabel: event.frameLabel ?? '' };
      markers.push(marker); window = { ...marker, rxBytes: 0, reads: 0, firstDataMs: null }; windows.push(window);
    } else if (['watch-send-mark', 'watch-receive-mark'].includes(event.kind) && inWindow) {
      markers.push({ stage: 'front-button', marker: event.marker, elapsedMs: event.elapsedMs - start.elapsedMs, at: event.at });
    }
    if (event.kind === 'usb-result' && event.operation === 'transferIn' && event.status === 'ok') {
      const size = event.data?.hex ? event.data.hex.length / 2 : 0;
      reads++; rxBytes += size; if (size) nonemptyReads++;
      if (inWindow) { window.reads++; window.rxBytes += size; if (size && window.firstDataMs === null) window.firstDataMs = event.elapsedMs - start.elapsedMs; }
    }
    if (['irtranp-file', 'irtranp-upload-file'].includes(event.kind)) {
      const bytes = fromHex(event.dataHex), row = { filename: event.filename, bytes: bytes.length,
        upfSHA256: await sha256(bytes), jpegSHA256: null, width: null, height: null, jpegBytes: 0, previewError: null };
      try {
        const jpeg = jpegFromUPF(bytes), info = jpegInfo(jpeg);
        Object.assign(row, { jpegSHA256: await sha256(jpeg), jpegBytes: jpeg.length, width: info.width, height: info.height });
        try { row.imageFingerprint = await jpegImageFingerprint(jpeg); } catch (error) { row.fingerprintError = String(error); }
        try { row.metadata = upfMetadata(bytes); } catch (error) { row.metadataError = String(error); }
      } catch (error) { row.previewError = String(error); }
      (event.kind === 'irtranp-upload-file' ? uploads : files).push(row);
    }
  }
  const phases = events.filter(event => event.kind === 'irtranp-phase').map(event => event.phase);
  const peer = events.filter(event => event.kind === 'peer-xid'), link = events.find(event => event.kind === 'irlap-connected');
  const ircomm = phases.includes('ircomm') || (result.ircommConnections ?? 0) > 0;
  const scep = phases.includes('scep') || result.scepConnected === true;
  const commands = events.filter(event => event.kind === 'bftp-command').map(event => event.name);
  const capabilityReplies = events.filter(event => event.kind === 'bftp-result');
  const putReplies = events.filter(event => event.kind === 'put-reply');
  const negativeReplies = capabilityReplies.filter(event => event.reply !== 0x40).map(event => event.name);
  const closed = cleanDisconnect(events), passive = attempt.test === 'listen-selection';
  const lastPhase = phases.at(-1) ?? result.phase ?? (passive && start ? 'listen' : 'not-started');
  const running = ['preparing', 'prepared', 'running'].includes(attempt.status), started = Boolean(start || attempt.startedAt);
  const pendingCalls = [...pending], errors = events.filter(event => ['usb-error', 'cleanup-error', 'receiver-error'].includes(event.kind));
  const validCapture = !running && started && !pending.size && !attempt.cleanupError &&
    !['error', 'interrupted', 'interrupted-by-page-close', 'preparation-error'].includes(attempt.status);
  let verdict = attempt.status === 'preparation-error' ? 'failed' : !started ? 'not-run' : running || pending.size ? 'incomplete' :
    attempt.status === 'interrupted' || attempt.status === 'interrupted-by-page-close' ? 'interrupted' :
    attempt.status === 'error' || attempt.status === 'preparation-error' || attempt.cleanupError ? 'failed' : 'incomplete';
  if (validCapture && passive && reads > 0) verdict = rxBytes ? 'recorded' : 'no-data';
  else if (validCapture && result.complete && closed) {
    if (attempt.test === 'ias' && ['Parameters', 'IrDA:TinyTP:LsapSel', 'IrDA:IrLMP:InstanceName'].every(name =>
      events.some(event => event.kind === 'ias-result' && event.name === name))) verdict = 'passed';
    else if (attempt.test === 'csi' && ['RIMG', 'RINF', 'RCMD'].every(name => capabilityReplies.some(event => event.name === name))) verdict = negativeReplies.length ? 'negative-reply' : 'passed';
    else if (attempt.test === 'sender') {
      const copies = attempt.upload?.copyCount;
      if (attempt.status === 'sent' && [1, 2].includes(copies) && putReplies.length === copies && putReplies.every(r => r.accepted) &&
          new Set(putReplies.map(r => r.id)).size === copies && uploads.length === (attempt.upload?.files?.length ?? 1) && uploads.every((file, i) =>
            !file.previewError && file.upfSHA256 === (attempt.upload?.files?.[i]?.sha256 ?? attempt.upload?.sha256)) &&
          events.some(e => e.kind === 'tx-frame' && e.purpose === 'csi-put')) verdict = 'passed';
      else if (attempt.status === 'send-rejected' && (putReplies.some(r => !r.accepted) || events.some(e => e.kind === 'put-not-sent'))) verdict = 'negative-reply';
      else if (attempt.status === 'cancel-observed' && events.some(e => e.kind === 'scep-cancel-transmitted')) verdict = 'recorded';
    }
    else if (['receiver', 'active-receiver'].includes(attempt.test) && files.length && files.every(file => !file.previewError)) verdict = 'passed';
  }
  if (validCapture && result.complete && closed && result.cancellation && attempt.feature?.abortMode && attempt.feature.abortMode !== 'none') verdict = 'recorded';
  const layer = (name, observed, detail) => ({ name, status: observed ? 'observed' : 'not-observed', detail });
  const firstFrame = events.find(event => event.kind === 'rx-frame' && start && event.elapsedMs >= start.elapsedMs);
  let featureEvidence = null;
  if (attempt.feature) {
    const ref = events.find(e => e.kind === 'irtranp-reference-file');
    const incoming = events.find(e => e.kind === 'bftp-command' && e.name === 'PUT');
    featureEvidence = { ...attempt.feature, cancellation: result.cancellation ?? null, imageMatches: null,
      metadata: null, transfer: incoming ? transferMetadata(fromHex(incoming.commandHex)) : null };
    if (ref && files[0]?.imageFingerprint) {
      const bytes = fromHex(ref.dataHex), expected = upfMetadata(bytes);
      featureEvidence.imageMatches = await jpegImageFingerprint(jpegFromUPF(bytes)) === files[0].imageFingerprint;
      featureEvidence.canInterpretMetadata = featureEvidence.imageMatches && Boolean(attempt.feature.referenceUploadConfirmed) && Boolean(files[0].metadata);
      featureEvidence.metadata = featureEvidence.canInterpretMetadata ? compareMetadata(expected, files[0].metadata) : null;
      if (featureEvidence.canInterpretMetadata && expected.thumbnail && files[0].metadata.thumbnail) {
        const thumbnail = featureEvidence.metadata.thumbnail;
        thumbnail.rawBytesMatch = thumbnail.matches;
        try { thumbnail.matches = await jpegImageFingerprint(fromHex(expected.thumbnail.dataHex)) ===
          await jpegImageFingerprint(fromHex(files[0].metadata.thumbnail.dataHex)); }
        catch (error) { thumbnail.matches = null; thumbnail.error = String(error); }
      }
      featureEvidence.referenceFilename = ref.filename;
      featureEvidence.filenameMatches = files[0].filename === ref.filename;
      featureEvidence.expectedTransfer = ref.transferMetadata ?? {};
      featureEvidence.transferResults = {};
      if (featureEvidence.canInterpretMetadata) {
        if (attempt.feature.caseID === 'filename') featureEvidence.transferResults.filename = {
          expected: ref.filename, actual: files[0].filename, matches: featureEvidence.filenameMatches };
        if (ref.transferMetadata?.time) {
          const actual = { TIM0: featureEvidence.transfer?.TIM0?.text ?? null,
            UPFCreated: files[0].metadata.created.value, UPFModified: files[0].metadata.modified.value };
          featureEvidence.transferResults.time = { expected: ref.transferMetadata.time, actual, matches: Object.values(actual).includes(ref.transferMetadata.time) };
        }
        if (ref.transferMetadata?.longName) {
          const actual = { LFL0: featureEvidence.transfer?.LFL0?.text ?? null, UPFTitle: files[0].metadata.title };
          featureEvidence.transferResults.longName = { expected: ref.transferMetadata.longName, actual, matches: Object.values(actual).includes(ref.transferMetadata.longName) };
        }
      }
      // A changed filename and a missing optional field do not identify the
      // photo. Never score metadata persistence before matching image content.
      featureEvidence.outcome = !featureEvidence.imageMatches ? 'wrong-or-changed-image' :
        !attempt.feature.referenceUploadConfirmed ? 'image-matches-unconfirmed-upload' :
        !files[0].metadata ? 'image-matches-metadata-unparsed' :
        [...Object.values(featureEvidence.metadata ?? {}), ...Object.values(featureEvidence.transferResults)].some(field => !field.matches) ? 'image-matches-metadata-differs' : 'image-matches';
    }
  }
  return { id: attempt.id, createdAt: attempt.createdAt, test: attempt.test, watchMode: attempt.watchMode,
    imageProfile: attempt.imageProfile ?? 'csi', maxBaud: attempt.maxBaud, frameRecovery: attempt.frameRecovery ?? 'auto',
    transportProfile: attempt.transportProfile ?? result.transportProfile ?? 'current',
    irLAPDataBytes: result.linkQoS?.dataBytes ?? null, applicationChunkBytes: result.linkQoS?.applicationChunkBytes ?? null,
    suite: attempt.suite ?? null, recordedStatus: attempt.status, verdict, lastPhase,
    negotiatedBaud: link?.baud ?? null, receiveBaud: passive ? attempt.maxBaud : null,
    complete: Boolean(result.complete), cleanDisconnect: closed, reads, nonemptyReads, emptyReads: reads - nonemptyReads,
    rxBytes, queuedWrites, completedWrites, pendingUSBCalls: pendingCalls, usbErrors: errors.length,
    badCRC: counters.badCRC ?? 0, recoveredFrames: counters.recoveredFrames ?? 0, recoveredBOF: counters.recoveredBOF ?? 0,
    frontButtonMarkers: markers.filter(marker => ['front-button', 'selection-open', 'transmit-start'].includes(marker.stage)).length, markers, windows,
    firstFrameMs: firstFrame && start ? firstFrame.elapsedMs - start.elapsedMs : null,
    durationMs: result.elapsedMs ?? null, files, uploads, putReplies, uploadOutcome: result.uploadOutcome ?? null, negativeReplies, featureEvidence,
    storageVerification: attempt.test === 'sender' ? { status: 'not-checked-in-this-attempt',
      protocolAcknowledged: verdict === 'passed', requiredReadbackPhotos: attempt.upload?.copyCount ?? null } : null,
    error: attempt.error ?? result.error?.message ?? attempt.cleanupError ?? null,
    layers: [layer('USB', reads > 0, { reads, rxBytes, pendingCalls }), layer('Discovery', peer.length > 0, { frames: peer.length }),
      layer('IrLAP', Boolean(link), { baud: link?.baud ?? null }),
      layer('IAS', events.some(event => ['ias-result', 'ias-query'].includes(event.kind)), { responses: result.iasResponses ?? 0, queries: result.iasQueries ?? 0 }),
      layer('IrCOMM', ircomm, {}), layer('SCEP', scep, {}),
      layer('bFTP', commands.length > 0 || capabilityReplies.length > 0 || putReplies.length > 0, { commands, negativeReplies, putReplies }),
      layer('File', files.length > 0 || putReplies.some(r => r.accepted), { received: files.length, selectedForUpload: uploads.length,
        acceptedPUT: putReplies.filter(r => r.accepted).length }), layer('Disconnect', closed, {})] };
}

export async function suiteSummary(suite, records, { suites = [] } = {}) {
  const attempts = [];
  for (const { attempt, events } of records) attempts.push(await analyseAttempt(attempt, events));
  const baselines = new Map();
  for (const row of attempts) {
    const group = row.suite?.comparisonGroup && row.suite.id + '/' + row.suite.comparisonGroup;
    if (!group || !row.files[0]?.jpegSHA256) { row.comparison = null; continue; }
    if (!baselines.has(group)) baselines.set(group, { id: row.id, file: row.files[0] });
    const baseline = baselines.get(group), file = row.files[0];
    row.comparison = { baselineAttemptID: baseline.id, sameUPF: baseline.file.upfSHA256 === file.upfSHA256,
      sameJPEG: file.jpegSHA256 && baseline.file.jpegSHA256 ? baseline.file.jpegSHA256 === file.jpegSHA256 : null };
  }
  const count = verdict => attempts.filter(row => row.verdict === verdict).length;
  const plans = suite ? [suite] : suites;
  return { format: 'wqv-irtranp-suite-report-v1', generatedAt: new Date().toISOString(), suite, suites: plans,
    note: 'All steps start manually. A passed upload is a protocol result; saved photos require matching read-back evidence. No data is not proof of no optical emission. Stage windows use USB completion times, not optical pulse timestamps.',
    totals: { attempts: attempts.length, passed: count('passed'), failed: count('failed'), interrupted: count('interrupted'),
      recorded: count('recorded'), noData: count('no-data'), incomplete: count('incomplete'), notRun: count('not-run'),
      differentPhotos: attempts.filter(row => row.comparison?.sameJPEG === false).length,
      skippedSteps: plans.reduce((n, plan) => n + plan.steps.filter(step => step.skipped).length, 0) }, attempts };
}
const encode = value => new TextEncoder().encode(value);
const jsonFile = (name, value) => ({ name, data: encode(JSON.stringify(value, null, 2) + '\n') });
const csv = value => {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export async function suiteFiles(suite, records, { suites = [] } = {}) {
  if (new Set(records.map(record => record.attempt.id)).size !== records.length) throw new Error('Duplicate attempt in export.');
  const summary = await suiteSummary(suite, records, { suites }), files = [jsonFile('summary.json', summary), jsonFile('plan.json', suite)];
  if (!suite) files.push(jsonFile('plans.json', suites));
  const columns = ['id', 'test', 'watchMode', 'imageProfile', 'maxBaud', 'negotiatedBaud', 'receiveBaud', 'frameRecovery',
    'transportProfile', 'irLAPDataBytes', 'applicationChunkBytes', 'recordedStatus', 'verdict',
    'lastPhase', 'rxBytes', 'badCRC', 'recoveredFrames', 'recoveredBOF', 'frontButtonMarkers', 'firstFrameMs', 'durationMs'];
  const fileColumns = ['upfSHA256', 'jpegSHA256', 'baselineAttemptID', 'sameUPF', 'sameJPEG'];
  const rows = [[...columns, ...fileColumns], ...summary.attempts.map(row => [...columns.map(column => row[column]),
    row.files[0]?.upfSHA256, row.files[0]?.jpegSHA256, row.comparison?.baselineAttemptID, row.comparison?.sameUPF, row.comparison?.sameJPEG])];
  files.push({ name: 'summary.csv', data: encode(rows.map(row => row.map(csv).join(',')).join('\r\n') + '\r\n') });
  for (const [index, { attempt, events }] of records.entries()) {
    const dir = `attempts/${String(index + 1).padStart(3, '0')}-${attempt.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}/`;
    const report = summary.attempts[index];
    files.push(...attemptFiles({ ...attempt, snapshot: ['running', 'preparing', 'prepared'].includes(attempt.status) }, events)
      .map(file => ({ ...file, name: dir + file.name })), jsonFile(dir + 'analysis.json', report));
    for (const [fileIndex, event] of events.filter(event => event.kind === 'irtranp-file').entries()) {
      try {
        files.push({ name: dir + `previews/${String(fileIndex).padStart(3, '0')}.jpg`, data: jpegFromUPF(fromHex(event.dataHex)) });
      } catch { /* The original file body remains in files/ even when preview decoding fails. */ }
    }
    // USB data is assigned by its completion time. Original events and byte
    // stream remain authoritative, including data completed during USB close.
    const markerRows = events.filter(event => event.kind === 'watch-stage-mark');
    if (attempt.test === 'listen-selection' && markerRows.length) {
      const parts = [[]]; let current = 0;
      for (const event of events) {
        if (event.kind === 'watch-stage-mark') { current++; parts[current] = []; }
        if (event.kind === 'usb-result' && event.operation === 'transferIn' && event.status === 'ok' && event.data?.hex) parts[current].push(fromHex(event.data.hex));
      }
      for (let i = 0; i < parts.length; i++) {
        const chunks = parts[i], bytes = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
        let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        files.push({ name: dir + `stage-windows/${String(i).padStart(3, '0')}.bin`, data: bytes });
      }
    }
  }
  files.push({ name: 'README.txt', data: encode('WQV OTHERS test series\n\n' +
    'summary.json and summary.csv describe each attempt. plan.json contains the selected manually controlled sequence and explicit skips; an all-attempts export has plans.json with every saved series. Every retry has its own directory with the original events, USB and application streams, file bodies and an analysis.json. Original attempt statuses are preserved.\n\n' +
    'Selection-screen tests block USB bulk OUT and never send discovery or acknowledgements. Mark entry into the image-selection screen, left/right changes and the final front-panel SEND press. Stage windows group bytes by USB completion time; they are not optical pulse timings. No bytes at one rate cannot establish that the watch emits nothing.\n\n' +
    'Use the same watch photo for profile/speed comparison. UPF and JPEG SHA-256 hashes are compared separately: different UPF metadata may still contain identical JPEG bytes. A different JPEG is a comparison result, not proof of transport corruption. A live or interrupted export is incomplete.\n\n' +
    'manifest.json lists byte lengths and SHA-256 hashes of every other file in this ZIP. No watch settings, deletions or firmware commands are included.\n') });
  const entries = [];
  for (const file of files) entries.push({ path: file.name, bytes: file.data.length, sha256: await sha256(file.data) });
  files.push(jsonFile('manifest.json', { algorithm: 'SHA-256', files: entries }));
  return files;
}
