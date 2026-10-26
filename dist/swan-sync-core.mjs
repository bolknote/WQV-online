import { fromHex } from './formats.mjs';
import { attemptFiles } from './research-core.mjs';
import { analyseSwanListening } from './swan-listen-core.mjs';

// Bytes delivered by SigmaTel on 2026-10-24, not identified commands.
// The full captures are contiguous replays: original inter-burst pauses are
// deliberately NOT implied by their byte arrays.
export const SWAN_REPLAYS = Object.freeze([
  { id: 'triple', hex: '7a06f0', en: '7A 06 F0 · common triple', ru: '7A 06 F0 · частая тройка' },
  { id: 'triple-7b', hex: '7b06f0', en: '7B 06 F0 · observed variant', ru: '7B 06 F0 · наблюдавшийся вариант' },
  { id: 'triple-3d', hex: '3d03f8', en: '3D 03 F8 · observed variant', ru: '3D 03 F8 · наблюдавшийся вариант' },
  { id: 'triple-f5', hex: 'f518c0', en: 'F5 18 C0 · observed variant', ru: 'F5 18 C0 · наблюдавшийся вариант' },
  { id: 'send-66', hex: '7a06f0'.repeat(9) + '3d03f8' + '7a06f0'.repeat(2) + '7b06f0' + '7a06f0' + '3d03f8' + '7b06f0' + '7a06f0'.repeat(2) + '3d03f8' + '7a06f0'.repeat(3),
    sourceAttempt: '3305ea7d-1e37-40c2-bafc-c789ff40c865', en: 'SWAN SEND · 66 bytes, no pauses', ru: 'SWAN SEND · 66 байт подряд, без пауз' },
  { id: 'receive-66', hex: '7a06f0'.repeat(8) + 'f518c0' + '7a06f0'.repeat(12) + '3d03f8',
    sourceAttempt: 'abae8f88-ce2d-4078-b97f-3ed7986efef3', en: 'SWAN RECEIVE · 66 bytes, no pauses', ru: 'SWAN RECEIVE · 66 байт подряд, без пауз' },
].map(Object.freeze));

export const SWAN_SYNC_PLAN = Object.freeze([
  { id: 'signal-send', watchPresent: true, watchMode: 'swan-send', transmit: false, seconds: 45,
    en: 'SEND · buttons and optical path', ru: 'SEND · кнопки и ИК-луч' },
  { id: 'signal-receive', watchPresent: true, watchMode: 'swan-receive', transmit: false, seconds: 45,
    en: 'RECEIVE · buttons and optical path', ru: 'RECEIVE · кнопки и ИК-луч' },
  { id: 'replay-control', watchPresent: false, watchMode: null, transmit: true, seconds: 20,
    replayTrigger: 'start',
    en: 'Replay · without the watch', ru: 'Повтор байтов · без часов' },
  { id: 'replay-send', watchPresent: true, watchMode: 'swan-send', transmit: true, seconds: 45,
    replayTrigger: 'rx',
    en: 'Replay → SWAN SEND', ru: 'Повтор байтов → SWAN SEND' },
  { id: 'replay-receive', watchPresent: true, watchMode: 'swan-receive', transmit: true, seconds: 45,
    replayTrigger: 'receive-mark',
    en: 'Replay → SWAN RECEIVE', ru: 'Повтор байтов → SWAN RECEIVE' },
].map(step => Object.freeze({ ...step, baud: 9600 })));

// A quiet peer must never lock out a manual transmission. Readiness depends on
// the capture/one-shot state only, not the amount of received data.
export function canReplayNow({ running, transmit, triggerState, mode = 'manual', broken = false }) {
  return Boolean(running && transmit && mode === 'manual' && triggerState === 'waiting' && !broken);
}

// One approved replay per manually started capture. RX mode waits for 12 ms
// without another data-bearing USB completion so split triples can arrive
// before we turn the half-duplex adapter around. This is not optical timing.
export class ReplayTiming {
  constructor(trigger, mode, onRequest = () => {}, quietMs = 12) {
    if (!['manual', 'start', 'rx', 'receive-mark'].includes(mode)) throw new RangeError('Invalid replay timing.');
    this.trigger = trigger; this.mode = mode; this.onRequest = onRequest; this.quietMs = quietMs; this.closed = false;
  }
  request(source) {
    if (source === 'send-button' && this.mode !== 'manual') return false;
    if (source === 'watch-receive-mark' && this.mode !== 'receive-mark') return false;
    if (this.closed || !this.trigger.request()) return false;
    clearTimeout(this.timer); this.onRequest(source); return true;
  }
  start() { if (this.mode === 'start') this.request('start-button'); }
  receiveMark() { return this.mode === 'receive-mark' && this.request('watch-receive-mark'); }
  received() {
    if (this.closed || this.mode !== 'rx' || this.trigger.state !== 'waiting') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.request('rx-quiet-window'), this.quietMs);
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}

export function syncConditions(step, at) {
  if (!SWAN_SYNC_PLAN.includes(step)) throw new RangeError('Invalid SWAN signal step.');
  return { source: 'user-confirmation', confirmedAt: at, watchPresent: step.watchPresent,
    watchMode: step.watchMode, restartForThisAttempt: step.watchPresent,
    activationPending: step.watchPresent, opticalPath: step.watchPresent ? 'open' : 'watch-removed',
    placement: step.watchPresent ? 'facing-adapter-5-to-10-cm' : 'removed-from-ir-path' };
}

// This tests a mathematical relationship between decoded data bits. It is NOT
// a UART decoder: start/stop bits and optical pulse timings are unavailable.
export function dataBitShiftMatches(bytes, reference = fromHex('7a06f0')) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 3 || reference.length !== 3) return [];
  const word = data => data[0] | data[1] << 8 | data[2] << 16;
  const actual = word(bytes), base = word(reference), mask = 0xffffff, matches = [];
  if (actual === base) return [{ shift: 0, fill: null }];
  for (let n = 1; n <= 7; n++) for (const fill of [0, 1]) {
    if (((base >>> n) | (fill ? (mask ^ (mask >>> n)) : 0)) === actual) matches.push({ shift: -n, fill });
    if ((((base << n) & mask) | (fill ? ((1 << n) - 1) : 0)) === actual) matches.push({ shift: n, fill });
  }
  return matches;
}

// Group delivered USB chunks by a visible idle gap, never by byte count. The
// threshold is an analysis setting, not an identified Casio packet boundary.
export function signalBursts(chunks, gapMs = 30) {
  const groups = [];
  for (const chunk of chunks) {
    const previous = groups.at(-1), time = Number.isFinite(chunk.elapsedMs) ? chunk.elapsedMs : Date.parse(chunk.at);
    if (previous && Number.isFinite(time) && Number.isFinite(previous.lastMs) && time - previous.lastMs >= 0 && time - previous.lastMs <= gapMs) {
      previous.hex += chunk.dataHex; previous.bytes += chunk.bytes; previous.lastMs = time; previous.reads++;
    } else groups.push({ offset: chunk.offset, at: chunk.at, firstMs: time, lastMs: time, hex: chunk.dataHex, bytes: chunk.bytes, reads: 1 });
  }
  return groups.map((group, index) => ({ ...group,
    gapFromPreviousMs: index && Number.isFinite(group.firstMs) && Number.isFinite(groups[index - 1].lastMs) ? group.firstMs - groups[index - 1].lastMs : null,
    dataBitShiftMatches: dataBitShiftMatches(fromHex(group.hex)) }));
}

export function analyseSwanSync(events, probeHex = '') {
  const { bytes, analysis } = analyseSwanListening(events), grouped = signalBursts(analysis.bursts);
  const counts = new Map();
  for (const group of grouped) counts.set(group.hex, (counts.get(group.hex) ?? 0) + 1);
  const variants = [...counts].map(([hex, count]) => ({ hex, count, dataBitShiftMatches: dataBitShiftMatches(fromHex(hex)) }));
  const buttons = analysis.markers;
  const pathMarkers = events.filter(event => event.kind === 'sync-path-mark');
  const start = events.find(event => event.kind === 'physical-conditions-confirmed');
  const end = events.findLast(event => event.kind === 'listen-finished' || event.kind === 'serial-finished');
  let phase = { path: start?.opticalPath ?? 'unrecorded', startedMs: start?.elapsedMs ?? null, rxBytes: 0, nonemptyReads: 0 };
  const phases = [];
  for (const event of events) {
    if (event.kind === 'sync-path-mark') {
      phases.push({ ...phase, endedMs: event.elapsedMs });
      phase = { path: event.path, startedMs: event.elapsedMs, rxBytes: 0, nonemptyReads: 0 };
    }
    if (event.kind === 'usb-result' && event.operation === 'transferIn' && event.data?.byteLength) {
      phase.rxBytes += event.data.byteLength; phase.nonemptyReads++;
    }
  }
  phases.push({ ...phase, endedMs: end?.elapsedMs ?? null });
  let stage = { stage: 'before-first-mark', startedMs: start?.elapsedMs ?? null, rxBytes: 0, nonemptyReads: 0 };
  const stages = [];
  for (const event of events) {
    const isStage = event.kind === 'watch-send-mark' && event.stage;
    if (isStage || event.kind === 'watch-picture-mark') {
      stages.push({ ...stage, endedMs: event.elapsedMs });
      stage = { stage: isStage ? event.stage : stage.stage, startedMs: event.elapsedMs,
        changeNumber: event.kind === 'watch-picture-mark' ? event.changeNumber : null, rxBytes: 0, nonemptyReads: 0 };
    }
    if (event.kind === 'usb-result' && event.operation === 'transferIn' && event.data?.byteLength) {
      stage.rxBytes += event.data.byteLength; stage.nonemptyReads++;
    }
  }
  stages.push({ ...stage, endedMs: end?.elapsedMs ?? null });
  const probe = fromHex(probeHex), exactMatches = [], writes = events.filter(event => event.kind === 'serial-tx-usb-complete' && event.dataHex === probeHex);
  const firstWrite = writes[0];
  const beforeWrite = firstWrite ? events.slice(0, events.indexOf(firstWrite)).reduce((n, event) => n +
    (event.kind === 'usb-result' && event.operation === 'transferIn' ? (event.data?.byteLength ?? 0) : 0), 0) : bytes.length;
  if (probe.length && firstWrite) for (let i = beforeWrite; i + probe.length <= bytes.length; i++) {
    if (probe.every((byte, j) => byte === bytes[i + j])) exactMatches.push({ offset: i, bytes: probe.length, possibleEcho: true });
  }
  return { ...analysis, groupedBursts: grouped, groupingGapMs: 30, variants,
    buttonPressCount: buttons.length, pathMarkers, opticalPhasesByUSBCompletion: phases,
    selectionPhasesByUSBCompletion: stages, pictureChangeCount: events.filter(event => event.kind === 'watch-picture-mark').length,
    usbWriteCompleted: Boolean(firstWrite), fifoDrainCompleted: events.some(event => event.kind === 'serial-tx-complete' && event.dataHex === probeHex),
    requestedProbeHex: probeHex, exactMatchesAfterUSBWrite: exactMatches,
    replayRequestSource: events.find(event => event.kind === 'serial-manual-send-request')?.source ?? null,
    rxBytesBeforeUSBWrite: firstWrite ? beforeWrite : null,
    firstRXmsAfterUSBWrite: firstWrite && analysis.bursts.length && Number.isFinite(firstWrite.elapsedMs) ? analysis.bursts[0].elapsedMs - firstWrite.elapsedMs : null,
    interpretation: 'Raw receiver output at 9600. Burst grouping, bit shifts and exact TX matches are annotations only; no packet format or response meaning has been identified.' };
}

export function swanSyncFiles(attempt, events) {
  const analysis = analyseSwanSync(events, attempt.probeHex ?? ''), encoder = new TextEncoder();
  const files = attemptFiles(attempt, events);
  files.find(file => file.name === 'README.txt').data = encoder.encode(
    'WQV-3 SWAN SIGNAL / REPLAY EXPERIMENT · FIXED 9600 BIT/S\n' +
    'Passive steps block USB bulk OUT. Replay steps send only the chosen previously observed bytes, once per manually started capture. replayTrigger=start queues the replay from the Start button; rx queues it after 12ms without another data-bearing USB completion; manual waits for Send now. The manual Send now button also works with a silent peer. There is no repeated or unlimited response. No WQV-1, IrLAP, game format, CRC, escaping or ACK is added. A 66-byte replay is contiguous and does not preserve the original pauses. The byte meaning is unknown.\n' +
    'Compare replay controls with the watch removed using the SAME replay selection as the watch capture. An exact received copy may be local echo or another repetition from the watch; it is not a proven response. USB OUT success and FIFO drain do not establish optical delivery.\n' +
    'events.jsonl is authoritative and includes original USB calls/results, empty reads, errors, UTC/monotonic timestamps and late close completions. usb-in.bin is untouched. serial-out-requested.bin and serial-out-completed.bin distinguish requested bytes from USB+FIFO completion. replay-planned.bin alone proves no transmission.\n' +
    'Conditions, button clicks and covered/open optical-path markers are user reports, not measurements. RX phase counts use USB completion order and can include buffered bytes. Each new attempt requires restarting the watch mode. The next step never starts automatically.\n' +
    'analysis.json groups adjacent data-bearing USB reads with gaps <=30ms. These are candidate bursts, NOT decoded packets. The bit-shift annotations treat three bytes as a 24-bit little-endian integer and test shifts of 1–7 with zero/one fill. UART start/stop bits and optical timings are unavailable; no corrected bytes are generated.\n');
  return [...files, { name: 'replay-planned.bin', data: fromHex(attempt.probeHex ?? '') },
    { name: 'analysis.json', data: encoder.encode(JSON.stringify(analysis, null, 2) + '\n') }];
}
