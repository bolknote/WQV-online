import { fromHex, toHex } from './formats.mjs';
import { sleep } from './irda.mjs';
import { ManualSerialTrigger, sendSerialBytes } from './serial-core.mjs';
import { swanSyncFiles } from './swan-sync-core.mjs';

// Relative first-data USB completion times from the 22-burst clock capture.
// These reproduce the observed cadence, not optical pulse timing or byte gaps.
export const PEER_CADENCE = Object.freeze({
  sourceAttempt: '94d6d41f-eb2d-4b44-9e19-074c5a70fe98',
  sourceArchiveSHA256: '4b8de9d5c4277295121ffe8ceba2ed584a0256f922404e0902d7ec6b4cf2519d',
  payloadHex: '7a06f0',
  offsetsMs: Object.freeze([0, 515.8, 1055.3, 1614.3, 2629.4, 3168.6, 3727.9, 4742.6,
    5281.8, 5841.4, 6856.1, 7395.3, 7957.4, 8969.5, 9520.7, 10080.1, 11094.9,
    11634.2, 12206, 13208.2, 13747.5, 14306.8]),
});
export const SWAN_PEER_PLAN = Object.freeze(['short', '3/16'].map(pulseWidth => Object.freeze({
  id: `peer-${pulseWidth === 'short' ? 'short' : 'long'}`, phase: 'peer', pulseWidth, rxSensitivity: 1,
  payloadStrategy: 'original',
  baud: 9600, seconds: 45, watchPresent: true, watchMode: 'swan-receive',
  transmit: true, replayTrigger: 'receive-mark',
  en: `RECEIVE · 22 repeats · ${pulseWidth === 'short' ? '1.6' : '19.53'} µs`,
  ru: `RECEIVE · 22 повтора · ${pulseWidth === 'short' ? '1,6' : '19,53'} мкс`,
})));
export const SWAN_PEER_VARIANT_PLAN = Object.freeze([
  { id: 'peer-reverse-bytes', payloadStrategy: 'reverse-bytes', probeHex: 'f0067a',
    en: 'Reverse byte order · F0 06 7A', ru: 'Обратный порядок байтов · F0 06 7A' },
  { id: 'peer-reverse-bits', payloadStrategy: 'reverse-bits', probeHex: '5e600f',
    en: 'Reverse bits in each byte · 5E 60 0F', ru: 'Обратный порядок битов в байте · 5E 60 0F' },
  { id: 'peer-random', payloadStrategy: 'random', probeHex: '',
    en: 'Random · a new triple per transmission', ru: 'Случайные · новая тройка на каждую посылку' },
  { id: 'peer-reverse-bytes-inverted', payloadStrategy: 'reverse-bytes-inverted', probeHex: '0ff985',
    en: 'Reverse bytes + invert bits · 0F F9 85', ru: 'Обратные байты + инверсия битов · 0F F9 85' },
  { id: 'peer-reverse-bits-inverted', payloadStrategy: 'reverse-bits-inverted', probeHex: 'a19ff0',
    en: 'Reverse bits + invert bits · A1 9F F0', ru: 'Обратные биты + инверсия битов · A1 9F F0' },
].map(item => Object.freeze({ ...item, phase: 'peer', pulseWidth: 'short', rxSensitivity: 1,
  baud: 9600, seconds: 45, watchPresent: true, watchMode: 'swan-receive',
  transmit: true, replayTrigger: 'receive-mark' })));

function fixedPayload(strategy) {
  const source = fromHex(PEER_CADENCE.payloadHex);
  if (['reverse-bytes-inverted', 'reverse-bits-inverted'].includes(strategy)) {
    return toHex(fromHex(fixedPayload(strategy.replace(/-inverted$/, ''))).map(byte => byte ^ 0xff));
  }
  if (strategy === 'original') return toHex(source);
  if (strategy === 'reverse-bytes') return toHex(source.reverse());
  if (strategy === 'reverse-bits') return toHex(source.map(byte => {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) reversed = reversed << 1 | (byte >> bit & 1);
    return reversed;
  }));
  if (strategy === 'random') return null;
  throw new RangeError('Unknown peer payload strategy.');
}

// Freeze all intended bytes before arming USB. A skipped or cancelled slot keeps
// its original triple, so exports never invent new random data after the test.
export function makePeerPayloadPlan(strategy = 'original', { count = PEER_CADENCE.offsetsMs.length,
  fillRandom = bytes => crypto.getRandomValues(bytes) } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > 22) throw new RangeError('Invalid payload count.');
  const fixed = fixedPayload(strategy), packetsHex = [];
  for (let i = 0; i < count; i++) {
    if (fixed !== null) packetsHex.push(fixed);
    else { const bytes = new Uint8Array(3); fillRandom(bytes); packetsHex.push(toHex(bytes)); }
  }
  return Object.freeze({ version: 1, strategy, sourceHex: PEER_CADENCE.payloadHex,
    bitReversal: ['reverse-bits', 'reverse-bits-inverted'].includes(strategy) ? 'within-each-8-bit-byte' : null,
    ...(strategy.endsWith('-inverted') ? { bitInversion: 'xor-ff-within-each-8-bit-byte' } : {}),
    packetsHex: Object.freeze(packetsHex) });
}

function checkedPayloadPlan(plan, count) {
  if (!plan || plan.version !== 1 || plan.sourceHex !== PEER_CADENCE.payloadHex ||
      !Array.isArray(plan.packetsHex) || plan.packetsHex.length !== count || count < 1 || count > 22 ||
      plan.packetsHex.some(hex => typeof hex !== 'string' || !/^[0-9a-f]{6}$/.test(hex))) {
    throw new RangeError('Invalid recorded peer payload plan.');
  }
  const fixed = fixedPayload(plan.strategy);
  if (fixed !== null && plan.packetsHex.some(hex => hex !== fixed)) throw new RangeError('Payload bytes do not match their strategy.');
  return Object.freeze({ version: 1, strategy: plan.strategy, sourceHex: PEER_CADENCE.payloadHex,
    bitReversal: ['reverse-bits', 'reverse-bits-inverted'].includes(plan.strategy) ? 'within-each-8-bit-byte' : null,
    ...(plan.strategy.endsWith('-inverted') ? { bitInversion: 'xor-ff-within-each-8-bit-byte' } : {}),
    packetsHex: Object.freeze([...plan.packetsHex]) });
}

export function peerConditions(step, at) {
  if (!SWAN_PEER_PLAN.includes(step) && !SWAN_PEER_VARIANT_PLAN.includes(step)) throw new RangeError('Invalid peer replay step.');
  return { source: 'user-confirmation', confirmedAt: at, watchPresent: true, watchMode: 'swan-receive',
    restartForThisAttempt: true, activationPending: true, opticalPath: 'open',
    placement: 'facing-adapter-5-to-10-cm', replayTrigger: 'receive-mark' };
}

export class PeerSeriesTrigger extends ManualSerialTrigger {
  constructor(now = () => performance.now()) { super(); this.now = now; this.requestedAt = null; }
  request() {
    if (!super.request()) return false;
    this.requestedAt = this.now(); return true;
  }
}

export class PeerSeries {
  constructor(offsetsMs = PEER_CADENCE.offsetsMs) {
    if (!Array.isArray(offsetsMs) || !offsetsMs.length || offsetsMs.length > 22 || offsetsMs[0] !== 0 ||
        offsetsMs.some((v, i) => !Number.isFinite(v) || v < 0 || v > 15000 || (i && v <= offsetsMs[i - 1]))) {
      throw new RangeError('Invalid bounded replay cadence.');
    }
    this.offsetsMs = [...offsetsMs]; this.anchor = null; this.index = 0;
    this.pausedByRX = false; this.entries = [];
  }
  start(at) { if (this.anchor !== null) return false; this.anchor = at; return true; }
  due(now) { return this.anchor !== null && !this.pausedByRX && this.index < this.offsetsMs.length && now >= this.anchor + this.offsetsMs[this.index]; }
  take(now, maxLateMs = 120) {
    if (!this.due(now)) return null;
    const entry = { repetition: this.index + 1, plannedOffsetMs: this.offsetsMs[this.index],
      requestedOffsetMs: now - this.anchor, lateMs: now - this.anchor - this.offsetsMs[this.index],
      state: 'requested' };
    if (entry.lateMs > maxLateMs) entry.state = 'skipped-late';
    this.index++; this.entries.push(entry); return entry;
  }
  received() {
    if (!this.entries.some(e => e.state === 'fifo-complete' || e.state === 'usb-complete')) return false;
    this.pausedByRX = true; return true;
  }
  summary() {
    return { planned: this.offsetsMs.length, started: this.anchor !== null, scheduled: this.index,
      requested: this.entries.filter(e => e.state !== 'skipped-late').length,
      usbCompleted: this.entries.filter(e => e.usbCompleted).length,
      fifoCompleted: this.entries.filter(e => e.state === 'fifo-complete').length,
      skipped: this.entries.filter(e => e.state === 'skipped-late').length,
      pausedByRX: this.pausedByRX, entries: this.entries.map(e => ({ ...e })) };
  }
}

// A RECEIVE mark starts one bounded series. There are no retries of failed
// writes and no burst catch-up after delayed USB. Keep every byte, including
// exact TX copies; their origin is not decided by an echo filter.
export async function replayPeer(adapter, { durationMs, payloadPlan = null }, { manualTrigger, signal, record = () => {},
  update = () => {}, now = () => performance.now(), offsetsMs = PEER_CADENCE.offsetsMs, maxLateMs = 120 } = {}) {
  if (!(manualTrigger instanceof ManualSerialTrigger)) throw new TypeError('A manual RECEIVE trigger is required.');
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) throw new RangeError('Invalid capture window.');
  signal?.throwIfAborted(); adapter.assertOpen();
  if (!adapter.configured || adapter.baud !== 9600 || adapter.readerTask || adapter.readPending) throw new Error('Prepare an idle 9600 receiver first.');
  const series = new PeerSeries(offsetsMs);
  const payloads = checkedPayloadPlan(payloadPlan ?? makePeerPayloadPlan('original', { count: offsetsMs.length }), offsetsMs.length);
  const started = now();
  let reason = null, error = null, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  const yieldTask = () => channel ? new Promise(resolve => { channel.port1.onmessage = resolve; channel.port2.postMessage(null); }) : sleep(0);
  const end = why => { if (!reason) { reason = why; manualTrigger.close(); finish({ ended: true }); adapter.close().catch(e => record('cleanup-error', { error: String(e) })); } };
  const wait = promise => Promise.race([Promise.resolve(promise).then(value => ({ value }), caught => ({ error: caught })), ended]);
  const abort = () => end('interrupted');
  const publish = () => update(series.summary());
  const counters = { rxBytes: 0, rxBeforeProbe: 0, rxAfterProbe: 0, readCount: 0, emptyReads: 0, txAttempts: 0, txCompleted: 0 };
  manualTrigger.arm();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => end('deadline'), durationMs);
  record('serial-start', { baud: 9600, watchMode: 'swan-receive', durationMs, framing: 'raw-sir-8n1',
    series: true, maxRepeats: offsetsMs.length, cadence: PEER_CADENCE, payloadPlan: payloads, maxLateMs, stopSeriesOnRX: true }); publish();
  try {
    while (!reason && now() - started < durationMs) {
      signal?.throwIfAborted(); adapter.assertOpen();
      if (manualTrigger.take()) {
        const requestedAt = manualTrigger.requestedAt ?? now();
        series.start(requestedAt); record('peer-series-triggered', { source: 'watch-receive-mark', plannedRepeats: offsetsMs.length,
          requestedOffsetMs: requestedAt - started, consumedOffsetMs: now() - started, waitingForUSBms: now() - requestedAt }); publish();
      }
      if (series.due(now())) {
        const entry = series.take(now(), maxLateMs);
        entry.dataHex = payloads.packetsHex[entry.repetition - 1];
        if (entry.state === 'skipped-late') { record('peer-repeat-skipped', { ...entry }); publish(); }
        else {
          counters.txAttempts++;
          record('serial-tx-attempt', { number: counters.txAttempts, ...entry, baud: 9600 });
          const written = await wait(sendSerialBytes(adapter, fromHex(entry.dataHex), {
            alive: () => !reason,
            record(kind, details) {
              if (kind === 'serial-tx-usb-complete') { entry.state = 'usb-complete'; entry.usbCompleted = true; entry.usbOffsetMs = now() - series.anchor; }
              record(kind, { ...details, repetition: entry.repetition, offsetMs: now() - series.anchor });
            },
          }));
          if (written.ended) break;
          if (written.error) throw written.error;
          if (!written.value) throw new Error('FIFO drain was not confirmed; the series was stopped.');
          entry.state = 'fifo-complete'; entry.fifoOffsetMs = now() - series.anchor; counters.txCompleted++;
          record('serial-tx-complete', { dataHex: entry.dataHex, number: counters.txCompleted,
            repetition: entry.repetition, offsetMs: entry.fifoOffsetMs, fifoDrained: true }); publish();
        }
      }
      if (reason) break;
      adapter.readPending = true;
      const read = adapter.device.transferIn(adapter.inEndpoint, 64).finally(() => { adapter.readPending = false; });
      const outcome = await wait(read);
      if (outcome.ended) break;
      if (outcome.error) throw outcome.error;
      const result = outcome.value;
      if (result.status !== 'ok' || !result.data) throw new Error(`USB IN: ${result.status}.`);
      const input = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      counters.readCount++; counters.rxBytes += input.length; adapter.rxBytes += input.length;
      if (input.length) {
        const afterProbe = series.entries.some(e => e.usbCompleted);
        counters[afterProbe ? 'rxAfterProbe' : 'rxBeforeProbe'] += input.length;
        record('serial-rx', { dataHex: toHex(input), afterProbe, offset: counters.rxBytes - input.length });
        if (!series.pausedByRX && series.received()) {
          record('peer-series-paused', { reason: 'received-bytes-after-tx', dataHex: toHex(input),
            interpretation: 'Possible watch response, echo or other input; bytes are not removed.' }); publish();
        }
      } else { counters.emptyReads++; await wait(yieldTask()); }
    }
  } catch (caught) {
    if (!reason) { reason = signal?.aborted ? 'interrupted' : 'error'; error = { name: caught.name, message: caught.message }; }
  } finally {
    manualTrigger.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
    channel?.port1.close(); channel?.port2.close();
  }
  const state = { ...series.summary(), finished: true };
  const status = reason === 'error' ? 'error' : reason === 'interrupted' ? 'interrupted' :
    state.fifoCompleted === 0 ? 'probe-not-sent' : state.pausedByRX && counters.rxAfterProbe ? 'captured' :
      state.fifoCompleted < state.planned ? 'series-incomplete' : counters.rxBytes ? 'captured' : 'no-data';
  const result = { status, reason: reason ?? 'deadline', error, ...counters, series: state, payloadPlan: payloads,
    elapsedMs: now() - started, txSerialBytes: counters.txCompleted * 3 };
  record('serial-finished', result); update(state); return result;
}

export function swanPeerFiles(attempt, events) {
  const files = swanSyncFiles(attempt, events), encoder = new TextEncoder();
  const recordedPlan = attempt.peerPayloadPlan ?? attempt.result?.payloadPlan ?? events.find(e => e.kind === 'serial-start')?.payloadPlan;
  if (!recordedPlan && attempt.format === 'wqv-swan-peer-v2') throw new Error('Missing recorded payload plan; cannot reconstruct random bytes.');
  const payloads = checkedPayloadPlan(recordedPlan ?? makePeerPayloadPlan(), recordedPlan?.packetsHex?.length ?? PEER_CADENCE.offsetsMs.length);
  files.find(f => f.name === 'README.txt').data = encoder.encode(
    'WQV-3 SWAN RECEIVE / BOUNDED PEER REPLAY\n' +
    'Start records only. The RECEIVE page mark starts one series of at most 22 three-byte transmissions at 9600, RXDSNS=1 (8 samples). Repeated marks never restart it. Original controls compare 1.6us and 3/16 TX pulse width; payload experiments hold TX width at 1.6us.\n' +
    'Payload strategy: ' + payloads.strategy + '. Original = 7A 06 F0; reverse-bytes = F0 06 7A; reverse-bits = 5E 60 0F (eight bits within each byte, preserving byte order). reverse-bytes-inverted = 0F F9 85; reverse-bits-inverted = A1 9F F0. Inversion XORs each payload byte with FF; UART framing is unchanged. Random = independently generated 0..255 bytes for each planned triple. payload-plan.json retains the exact pre-recorded sequence, including skipped and unsent slots. Export never generates replacement random bytes.\n' +
    'Offsets come from first-data USB completion times in source attempt ' + PEER_CADENCE.sourceAttempt + '. They reproduce the observed cadence, not optical timing, extended start bits or source inter-byte gaps. Payload bytes are the common-triple hypothesis, not the variable raw receiver output from the source recording. No CRC, escaping, game format or application acknowledgement is added.\n' +
    'USB writes happen only between completed reads. Timing is absolute from the RECEIVE mark request; a repeat more than 120ms late is skipped rather than sent in a catch-up burst. Each requested write, USB completion and FIFO completion is distinct. A failed write or FIFO stops the attempt without retry. Stop cancels remaining repetitions.\n' +
    'The first nonempty input after a completed USB transmission pauses all remaining repeats while recording continues. It may be a watch response or echo. No input bytes are discarded, including exact TX copies and data received before the mark or during close. No automatic ACK or protocol transition follows incoming data.\n' +
    'events.jsonl is authoritative. usb-in.bin is untouched. serial-out-requested.bin and serial-out-completed.bin distinguish planned requests from USB/FIFO completion. replay-planned.bin contains the full 66-byte plan but proves no transmission. peer-series.json stores the cadence and per-repetition results.\n');
  files.find(f => f.name === 'replay-planned.bin').data = fromHex(payloads.packetsHex.join(''));
  return [...files, { name: 'payload-plan.json', data: encoder.encode(JSON.stringify(payloads, null, 2) + '\n') },
    { name: 'peer-series.json', data: encoder.encode(JSON.stringify({
    cadence: PEER_CADENCE, payloadPlan: payloads, result: attempt.result?.series ?? null,
    events: events.filter(e => e.kind.startsWith('peer-') || e.kind.startsWith('serial-tx-') || e.kind === 'serial-manual-send-request'),
  }, null, 2) + '\n') }];
}
