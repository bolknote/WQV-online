import { toHex } from './formats.mjs';
import { swanSyncFiles } from './swan-sync-core.mjs';

// STIr4200 datasheet v2.0, table 16 (p. 17). Only register 4 is
// varied; the PC driver and its normal setup sequence are unchanged.
export const SIR_RX_SAMPLES = Object.freeze([4, 8, 12, 16, 20, 24, 28]);
export const SWAN_PHYSICAL_PLAN = Object.freeze([
  ...['short', '3/16'].map(pulseWidth => ({
    id: `pulse-${pulseWidth === 'short' ? 'short' : 'long'}`, phase: 'pulse', pulseWidth,
    rxSensitivity: 1, transmit: true, probeHex: '7a06f0', replayTrigger: 'rx', postRxQuietMs: 12,
    en: `TX pulse · ${pulseWidth === 'short' ? '1.6' : '19.5'} µs`,
    ru: `Импульс TX · ${pulseWidth === 'short' ? '1,6' : '19,5'} мкс`,
  })),
  // Repeat the normal threshold as a passive baseline before varying RX.
  ...[1, 0, 2, 3, 4, 5, 6].map(rxSensitivity => ({
    id: `receiver-${rxSensitivity}`, phase: 'receiver', pulseWidth: 'short',
    rxSensitivity, transmit: false,
    en: `RX threshold · ${SIR_RX_SAMPLES[rxSensitivity]} samples${rxSensitivity === 1 ? ' (baseline)' : ''}`,
    ru: `Порог RX · ${SIR_RX_SAMPLES[rxSensitivity]} ${rxSensitivity === 0 ? 'отсчёта' : 'отсчётов'}${rxSensitivity === 1 ? ' (исходный)' : ''}`,
  })),
].map(step => Object.freeze({ ...step, baud: 9600, seconds: 45, watchPresent: true, watchMode: 'swan-send' })));

export function physicalSettings({ pulseWidth, rxSensitivity }) {
  if (!['short', '3/16'].includes(pulseWidth) || !Number.isInteger(rxSensitivity) ||
      rxSensitivity < 0 || rxSensitivity >= SIR_RX_SAMPLES.length) throw new RangeError('Invalid SIR physical settings.');
  return { baud: 9600, modulation: 'SIR', pulseWidth,
    txPulseUs: pulseWidth === 'short' ? 1.6 : 1e6 / 9600 * 3 / 16,
    rxSensitivity, rxSamples: SIR_RX_SAMPLES[rxSensitivity],
    sensitivityRegister: rxSensitivity << 5 | (pulseWidth === '3/16' ? 8 : 0) };
}

function snapshot(raw) {
  return { firstRegister: 1, rawHex: toHex(raw), mode: raw[0], baudDivisor: raw[1],
    control: raw[2], sensitivity: raw[3], dpll: raw[7], irdig: raw[8] };
}

// Configure only an idle adapter. All calls are made through captureUSB, so
// both the raw control replies and these interpreted snapshots are journaled.
export async function applySwanPhysical(adapter, settings, { record = () => {}, signal } = {}) {
  const requested = physicalSettings(settings);
  adapter.assertOpen(); signal?.throwIfAborted();
  if (!adapter.configured || adapter.baud !== 9600 || adapter.readerTask || adapter.readPending) {
    throw new Error('Prepare an idle 9600 bit/s receiver before changing SIR settings.');
  }
  record('physical-settings-requested', { requested });
  const before = snapshot(await adapter.registers(1, 9, true));
  record('physical-settings-before', { registers: before }); signal?.throwIfAborted();
  if (before.mode !== 0x2a || before.baudDivisor !== 0x77 || before.control !== 0 || before.irdig !== 0) {
    throw new Error('Unexpected SigmaTel SIR setup. Release USB and prepare it again.');
  }
  // Bits 2:0 are a read-only chip ID; bit 4 is reserved and written as zero.
  await adapter.writeRegister(4, requested.sensitivityRegister);
  signal?.throwIfAborted();
  const after = snapshot(await adapter.registers(1, 9, true));
  const verified = (after.sensitivity & 0xf8) === requested.sensitivityRegister &&
    ['mode', 'baudDivisor', 'control', 'dpll', 'irdig'].every(key => after[key] === before[key]);
  const result = { requested, before, after, verified };
  record('physical-settings-applied', result);
  if (!verified) {
    const error = new Error('SigmaTel SIR settings did not match the readback. Recording has not started.');
    error.physicalSettings = result; throw error;
  }
  return result;
}

export function physicalConditions(step, at) {
  if (!SWAN_PHYSICAL_PLAN.includes(step)) throw new RangeError('Invalid physical comparison step.');
  return { source: 'user-confirmation', confirmedAt: at, watchPresent: true, watchMode: step.watchMode,
    restartForThisAttempt: true, activationPending: true, opticalPath: 'open',
    placement: 'facing-adapter-5-to-10-cm', samePhotoAndPlacement: true };
}

export function swanPhysicalFiles(attempt, events) {
  const files = swanSyncFiles(attempt, events), encoder = new TextEncoder();
  files.find(file => file.name === 'README.txt').data = encoder.encode(
    'WQV-3 SWAN / SIGMATEL PHYSICAL SETTINGS COMPARISON\n' +
    'All steps use SIR at 9600 bit/s. The two pulse steps use the same 7A 06 F0 bytes, once after 12ms without another data-bearing USB read. RX sensitivity is held at code 1 (8 samples). Only SPWIDTH (register 4 bit 3) changes: short=1.6us, 3/16=19.53125us at 9600. This is the TRANSMIT pulse width; it does not change passive reception. The byte meaning and correct Casio handshake are unknown.\n' +
    'Receiver steps are passive: no bulk OUT, probes or acknowledgements. Only RXDSNS (register 4 bits 7:5) changes. Codes 0..6 require 4,8,12,16,20,24,28 consecutive samples of an IR pulse. More required samples is a stricter threshold, not higher receive sensitivity. Code 7 is illegal and never used. Pulse width is held at the normal short setting throughout receiver steps.\n' +
    'settings.json records requested values, before/after register snapshots and verification. A preparation error or missing verified readback is not a completed comparison. Every preparation first runs the normal SigmaTel setup, then writes only register 4. No UART parity, data-bit, stop-bit, polarity, clock or DPLL settings are varied.\n' +
    'Restart SWAN SEND for each attempt. Keep the same photo, watch/adapter placement and capture duration. Press the front button once for photo selection and a second time to actually send. Page markers are user reports and may lag physical actions. Each step starts manually.\n' +
    'events.jsonl includes all USB calls/results, empty reads, errors, timestamps and late close completions. usb-in.bin is untouched; serial-out-requested.bin and serial-out-completed.bin distinguish requests from USB/FIFO completion. replay-planned.bin alone proves no transmission. USB timestamps are not optical waveform measurements. No reception or no change after one unknown reply does not rule out a physical-layer mismatch.\n');
  return [...files, { name: 'settings.json', data: encoder.encode(JSON.stringify({
    phase: attempt.physicalPhase, settings: attempt.physicalSettings ?? null,
    events: events.filter(event => event.kind.startsWith('physical-settings-')),
  }, null, 2) + '\n') }];
}
