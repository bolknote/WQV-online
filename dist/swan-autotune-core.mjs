import { toHex } from './formats.mjs';
import { sleep } from './irda.mjs';
import { SIR_RX_SAMPLES } from './swan-physical-core.mjs';
import { swanSyncFiles } from './swan-sync-core.mjs';

// The divisor relationship is inferred from every SIR rate in STIr4200
// table 14: 1152000 / (PDCLK + 1). Off-standard rates are estimates, not
// measured optical bit rates. Nothing here changes the normal PC driver.
const profile = (divisor, rxSensitivity) => Object.freeze({
  id: `clock-${divisor}-rx-${rxSensitivity}`, divisor, rxSensitivity,
  estimatedBaud: 1152000 / (divisor + 1), rxSamples: SIR_RX_SAMPLES[rxSensitivity],
});
export const AUTOTUNE_PROFILES = Object.freeze({
  clock: Object.freeze([119, 117, 121, 115, 123, 118, 120].map(divisor => profile(divisor, 5))),
  receiver: Object.freeze([1, 0, 5, 2, 4, 3, 6].map(sensitivity => profile(119, sensitivity))),
});
export const SWAN_AUTOTUNE_PLAN = Object.freeze([
  { id: 'auto-clock', tuneGroup: 'clock', rxSensitivity: 5,
    en: 'Automatic · speed around 9600', ru: 'Автоподбор · скорость около 9600' },
  { id: 'auto-receiver', tuneGroup: 'receiver', rxSensitivity: 1,
    en: 'Automatic · receiver threshold', ru: 'Автоподбор · порог приёмника' },
].map(step => Object.freeze({ ...step, pulseWidth: 'short', baud: 9600, seconds: 45,
  transmit: false, watchPresent: true, watchMode: 'swan-send' })));

const distance = (a, b) => {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i += 2) {
    let bits = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (bits) { bits &= bits - 1; n++; }
  }
  return n;
};
const informative = hex => hex.length > 0 && hex.length <= 128 && !/^(00)+$/.test(hex) && !/^(ff)+$/.test(hex);

// Compare unmodified bursts, without an expected word, fixed packet length,
// CRC repair or bit-shift correction. A stable output is not a proven decode.
export function rankTuneProfiles(profiles, bursts) {
  const usable = bursts.filter(b => b.eligible && informative(b.hex));
  const lengths = new Map();
  for (const b of usable) lengths.set(b.hex.length, (lengths.get(b.hex.length) ?? 0) + 1);
  const commonLength = [...lengths].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const common = usable.filter(b => b.hex.length === commonLength), counts = new Map();
  for (const b of common) counts.set(b.hex, (counts.get(b.hex) ?? 0) + 1);
  const consensus = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const rows = profiles.map((p, order) => {
    const all = bursts.filter(b => b.profileId === p.id && b.eligible);
    const good = all.filter(b => informative(b.hex) && b.hex.length === commonLength);
    const own = new Map();
    for (const b of good) own.set(b.hex, (own.get(b.hex) ?? 0) + 1);
    const mode = [...own].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return { ...p, order, samples: all.length, usable: good.length, rejected: all.length - good.length,
      modeHex: mode?.[0] ?? null, equalToMode: mode?.[1] ?? 0,
      repeatFraction: all.length ? (mode?.[1] ?? 0) / all.length : 0,
      meanDistanceToMode: good.length ? good.reduce((n, b) => n + distance(b.hex, mode[0]), 0) / good.length : null,
      meanDistanceToConsensus: good.length && consensus ? good.reduce((n, b) => n + distance(b.hex, consensus), 0) / good.length : null };
  });
  rows.sort((a, b) => Number(b.usable >= 2) - Number(a.usable >= 2) ||
    (a.samples ? a.rejected / a.samples : 1) - (b.samples ? b.rejected / b.samples : 1) ||
    (a.meanDistanceToMode ?? Infinity) - (b.meanDistanceToMode ?? Infinity) ||
    b.repeatFraction - a.repeatFraction || b.usable - a.usable ||
    (a.meanDistanceToConsensus ?? Infinity) - (b.meanDistanceToConsensus ?? Infinity) || a.order - b.order);
  return { consensusHex: consensus, commonLengthBytes: commonLength === null ? null : commonLength / 2, rows };
}

export class AutoTuneSchedule {
  constructor(group) {
    if (!AUTOTUNE_PROFILES[group]) throw new RangeError('Invalid automatic comparison group.');
    this.group = group; this.profiles = AUTOTUNE_PROFILES[group]; this.index = 0;
    this.phase = 'scan'; this.windowSamples = 0; this.bursts = []; this.windows = [];
    this.finalists = []; this.winnerId = null; this.finished = false;
  }
  get current() { return this.profiles.find(p => p.id === this.currentId); }
  get currentId() { return this.phase === 'verify' ? this.finalists[this.index] : this.phase === 'hold' ? this.winnerId : this.profiles[this.index]?.id; }
  get targetSamples() { return this.phase === 'scan' ? 2 : this.phase === 'verify' ? 3 : Infinity; }
  add(burst) { this.bursts.push(burst); if (burst.eligible && burst.profileId === this.currentId) this.windowSamples++; }
  get windowComplete() { return this.windowSamples >= this.targetSamples; }
  advance(reason) {
    this.windows.push({ profileId: this.currentId, phase: this.phase, samples: this.windowSamples, reason });
    this.windowSamples = 0; this.index++;
    if (this.phase === 'scan' && this.index >= this.profiles.length) {
      const ranking = rankTuneProfiles(this.profiles, this.bursts);
      this.finalists = ranking.rows.filter(row => row.usable >= 2).slice(0, 2).map(row => row.id);
      this.index = 0; this.phase = 'verify';
      if (this.finalists.length < 2) { this.finished = true; return null; }
    } else if (this.phase === 'verify' && this.index >= this.finalists.length) {
      const verified = new Set(this.windows.filter(w => w.phase === 'verify' && w.reason === 'samples' && w.samples >= 3).map(w => w.profileId));
      const ranking = rankTuneProfiles(this.profiles.filter(p => verified.has(p.id)), this.bursts);
      // A winner requires both finalists to have received their repeat check.
      this.winnerId = verified.size === 2 ? ranking.rows.find(row => row.samples >= 5 && row.usable >= 4 && row.repeatFraction >= 0.6)?.id ?? null : null;
      this.phase = 'hold'; this.index = 0; this.finished = !this.winnerId;
    }
    return this.current ?? null;
  }
  summary() {
    return { group: this.group, phase: this.phase, currentProfileId: this.currentId ?? null,
      winnerId: this.winnerId, provisional: true, referenceRequired: false, studiedBursts: this.bursts.filter(b => b.eligible && b.phase !== 'hold').length,
      sampleBudget: 20, finalists: this.finalists, windows: this.windows, bursts: this.bursts,
      ...rankTuneProfiles(this.profiles, this.bursts),
      interpretation: 'Ranks repeatability of receiver output only. The optical bit rate, transmitted bytes and Casio handshake remain unverified.' };
  }
}

export async function applyTuneProfile(adapter, candidate, { record = () => {}, check = () => {} } = {}) {
  const p = Object.values(AUTOTUNE_PROFILES).flat().find(p => p.id === candidate?.id);
  if (!p) throw new RangeError('Unknown automatic receiver profile.');
  adapter.assertOpen(); check();
  if (!adapter.configured || adapter.readerTask || adapter.readPending) throw new Error('Automatic tuning requires an idle USB reader.');
  adapter.autotuneIO = { phase: 'configuring', profileId: p.id };
  record('autotune-profile-requested', { profile: p });
  const before = await adapter.registers(1, 9, true); check();
  if (before[0] !== 0x2a || before[2] !== 0 || before[8] !== 0) throw new Error('Unexpected SIR modulation, input selection or polarity.');
  // Live register writes only, with no SRESET, endpoint halt or FIFO clear.
  if (before[1] !== p.divisor) { await adapter.writeRegister(2, p.divisor); check(); }
  if ((before[3] & 0xf8) !== p.rxSensitivity << 5) { await adapter.writeRegister(4, p.rxSensitivity << 5); check(); }
  const after = await adapter.registers(1, 9, true); check();
  const verified = after[1] === p.divisor && (after[3] & 0xf8) === p.rxSensitivity << 5 &&
    [0, 2, 7, 8].every(i => before[i] === after[i]);
  record('autotune-profile-applied', { profile: p, beforeHex: toHex(before), afterHex: toHex(after), verified });
  if (!verified) throw new Error('Automatic receiver profile did not match the USB readback.');
  adapter.baud = p.estimatedBaud;
  adapter.autotuneIO = { phase: 'receiving', profileId: p.id, divisor: p.divisor, rxSensitivity: p.rxSensitivity };
  return p;
}

export async function listenAutotune(adapter, { group, durationMs }, { signal, record = () => {}, update = () => {},
  now = () => performance.now(), quietMs = 40, settleMs = 20, warmupMs = 250, windowMs = 2300, endQuietMs = 2200 } = {}) {
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) throw new RangeError('Invalid capture window.');
  const schedule = new AutoTuneSchedule(group), started = now();
  adapter.assertOpen(); signal?.throwIfAborted();
  let reason = null, error = null, resolveEnd, pending = null, appliedAt = started, windowAt = started, lastRX = null, signalSeen = false;
  const counters = { readCount: 0, rxBytes: 0, emptyReads: 0 };
  const ended = new Promise(resolve => { resolveEnd = resolve; });
  // Timer-based per-read sleeps can be clamped to a second in a background
  // browser tab, merging several watch repeats. Native USB plus a task yield
  // lets the UI run without adding that timer delay to every empty read.
  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  const yieldTask = () => channel ? new Promise(resolve => {
    channel.port1.onmessage = resolve; channel.port2.postMessage(null);
  }) : sleep(0);
  const end = why => { if (!reason) { reason = why; resolveEnd({ ended: true }); adapter.close().catch(e => record('cleanup-error', { error: String(e) })); } };
  const abort = () => end('interrupted');
  const check = () => { signal?.throwIfAborted(); if (reason) throw new DOMException('Capture ended.', 'AbortError'); };
  const wait = task => Promise.race([Promise.resolve(task).then(value => ({ value }), caught => ({ error: caught })), ended]);
  const publish = () => update(schedule.summary());
  const flush = (complete = true) => {
    if (!pending) return;
    const burst = { ...pending, complete, eligible: complete && pending.firstMs >= warmupMs && pending.firstMs >= appliedAt - started + settleMs };
    schedule.add(burst); record('autotune-burst', burst); pending = null; publish();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => end('deadline'), durationMs);
  record('autotune-start', { group, durationMs, quietMs, settleMs, warmupMs, windowMs, endQuietMs,
    sampleBudget: 20, scanSamples: 2, verificationSamples: 3, transmit: false, profiles: schedule.profiles });
  try {
    const initial = await wait(applyTuneProfile(adapter, schedule.current, { record, check }));
    if (initial.error) throw initial.error;
    if (!initial.ended) {
      appliedAt = windowAt = now(); publish();
      while (!reason) {
        check();
        const elapsed = now();
        if (pending && elapsed - started - pending.lastMs >= quietMs) flush();
        if (!pending && signalSeen && schedule.phase !== 'hold' &&
            (schedule.windowComplete || elapsed - windowAt >= windowMs)) {
          const next = schedule.advance(schedule.windowComplete ? 'samples' : 'timeout');
          record('autotune-window-finished', schedule.windows.at(-1)); publish();
          if (!next) { end('insufficient-samples'); break; }
          const applied = await wait(applyTuneProfile(adapter, next, { record, check }));
          if (applied.ended) break;
          if (applied.error) throw applied.error;
          appliedAt = windowAt = now(); publish();
        }
        const silentWindows = schedule.windows.slice(-3);
        const scanWentQuiet = silentWindows.length === 3 && silentWindows.every(w => w.reason === 'timeout' && w.samples === 0);
        if (signalSeen && !pending && now() - lastRX >= endQuietMs && (schedule.phase === 'hold' || scanWentQuiet)) {
          end(schedule.winnerId ? 'complete' : 'signal-ended'); break;
        }
        adapter.readPending = true;
        const reading = adapter.device.transferIn(adapter.inEndpoint, 64).finally(() => { adapter.readPending = false; });
        const outcome = await wait(reading);
        if (outcome.ended) break;
        if (outcome.error) throw outcome.error;
        const result = outcome.value;
        if (result.status !== 'ok' || !result.data) throw new Error(`USB IN: ${result.status}.`);
        const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        const time = now(); counters.readCount++; counters.rxBytes += bytes.length; adapter.rxBytes += bytes.length;
        if (bytes.length) {
          if (pending && time - started - pending.lastMs > quietMs) flush();
          if (!pending) pending = { profileId: schedule.currentId, phase: schedule.phase, firstMs: time - started, lastMs: time - started, hex: '', reads: 0 };
          pending.hex += toHex(bytes); pending.lastMs = time - started; pending.reads++;
          lastRX = time;
          if (time - started >= warmupMs && time >= appliedAt + settleMs) {
            if (!signalSeen) windowAt = time;
            signalSeen = true;
          }
        } else { counters.emptyReads++; await wait(yieldTask()); }
      }
    }
  } catch (caught) {
    if (!reason) { error = { name: caught.name, message: caught.message }; reason = signal?.aborted ? 'interrupted' : 'error'; }
  } finally {
    // A partial tail cannot be mistaken for a quiet-completed study sample.
    if (pending) flush(false);
    channel?.port1.close(); channel?.port2.close();
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
  const result = { status: reason === 'error' ? 'error' : reason === 'interrupted' ? 'interrupted' : counters.rxBytes ? 'captured' : 'no-data',
    reason, elapsedMs: now() - started, ...counters, autoTune: schedule.summary(), error };
  record('autotune-finished', result); update(result.autoTune); return result;
}

export function autoTuneConditions(step, at) {
  if (!SWAN_AUTOTUNE_PLAN.includes(step)) throw new RangeError('Invalid automatic comparison step.');
  return { source: 'user-confirmation', confirmedAt: at, watchPresent: true, watchMode: 'swan-send',
    restartForThisAttempt: true, activationPending: true, opticalPath: 'open', placement: 'facing-adapter-5-to-10-cm' };
}

export function swanAutotuneFiles(attempt, events) {
  const files = swanSyncFiles(attempt, events), encoder = new TextEncoder();
  const analysisFile = files.find(file => file.name === 'analysis.json');
  const analysis = JSON.parse(new TextDecoder().decode(analysisFile.data));
  analysis.receiverSettingsVary = true;
  analysis.autoTune = attempt.result?.autoTune ?? null;
  analysis.interpretation = 'Untouched USB receiver output with per-window settings. Estimated baud rates and repeatability ranking do not establish optical timing, correct decoding or a Casio handshake.';
  analysisFile.data = encoder.encode(JSON.stringify(analysis, null, 2) + '\n');
  files.find(file => file.name === 'README.txt').data = encoder.encode(
    'WQV-3 SWAN / AUTOMATIC PASSIVE RECEIVER COMPARISON\n' +
    'One watch SEND session compares seven profiles with two quiet-separated USB bursts each, then rechecks two candidates with three more bursts each (20 study samples). Candidate selection ranks repeatability without requiring 7A 06 F0 or another expected word. A provisional winner describes receiver-output consistency, not proven optical decoding. All-zero/all-FF and wrong-length outputs are penalized.\n' +
    'Receiver mode varies RXDSNS codes 0..6 at 9600. Clock mode varies PDCLK around 0x77 at RXDSNS=5 (24 samples). Estimated clock rates use 1152000/(PDCLK+1), inferred from the documented standard-rate table, not measured. Only registers 2 and 4 may be written during recording. Every setting is read back. There is no transmitter output, FIFO clear, soft reset, polarity inversion or parity setting.\n' +
    'Switches happen only between completed USB reads, after a 40ms receive quiet interval. Bursts received in the first 250ms or within 20ms after a switch are retained but excluded from ranking as possible buffered/transition data. USB timestamps are not optical timing, and a setting window may include buffered data. Never split a long USB burst into invented three-byte packets. Timeouts, partial scans and inconsistent data must not produce a confirmed winner.\n' +
    'events.jsonl retains all raw USB calls/results, empty reads, settings/readbacks, transitions and late completions. usb-in.bin is untouched. auto-tune.json stores ranking, windows and unmodified candidate bursts. The normal PC-mode driver is unchanged; each new USB preparation restores its baseline setup.\n');
  return [...files, { name: 'auto-tune.json', data: encoder.encode(JSON.stringify({
    result: attempt.result?.autoTune ?? null, events: events.filter(e => e.kind.startsWith('autotune-')),
  }, null, 2) + '\n') }];
}
