import { b, concat, fromHex, toHex, LIMIT } from './formats.mjs';
import { sleep } from './irda.mjs';

// Hypotheses from DOS2WW.C / WonderWave's terminal guide, not Casio commands.
export const SERIAL_PROBES = Object.freeze([
  { id: 'nak', name: 'XMODEM NAK', hex: '15', repeatMs: 2000 },
  { id: 'cr', name: 'Enter / CR', hex: '0d', repeatMs: 0 },
  { id: 'listen', name: 'Listen only', hex: '', repeatMs: 0 },
].map(Object.freeze));
export const SERIAL_MODES = Object.freeze(['swan-send', 'watch-send', 'others-send']);

function joinChunks(chunks) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function serialSettings({ probe, watchMode, durationMs }) {
  const selected = SERIAL_PROBES.find(item => item.id === probe);
  if (!selected || !SERIAL_MODES.includes(watchMode)) throw new RangeError('Invalid serial probe or watch mode.');
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) throw new RangeError('The capture window must be between 2 and 120 seconds.');
  return { probe, watchMode, baud: 9600, durationMs, probeHex: selected.hex, repeatMs: selected.repeatMs, initialDelayMs: 500 };
}

// These are complete checksum-XMODEM block candidates, not identified peers.
// Keep offsets into the untouched USB stream, including noise and local echo.
export function xmodemCandidates(bytes) {
  const found = [];
  for (let offset = 0; offset + 132 <= bytes.length && found.length < 32; offset++) {
    if (bytes[offset] !== 1 || (bytes[offset + 1] ^ bytes[offset + 2]) !== 255) continue;
    let sum = 0;
    for (let i = offset + 3; i < offset + 131; i++) sum = (sum + bytes[i]) & 255;
    if (sum !== bytes[offset + 131]) continue;
    found.push({ offset, sequence: bytes[offset + 1], checksum: sum, dataHex: toHex(bytes.slice(offset + 3, offset + 131)) });
  }
  return found;
}

// The experiment owns the reader. Call only BETWEEN completed USB reads;
// sendFrame() would insert IrLAP fields, escaping, CRC and frame delimiters.
export async function sendSerialBytes(adapter, bytes, { record = () => {}, alive = () => true } = {}) {
  adapter.assertOpen();
  if (!adapter.configured || adapter.baud !== 9600 || adapter.readerTask || adapter.readPending) throw new Error('Prepare an idle 9600 bit/s receiver before sending serial bytes.');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length + 4 >= 4096) throw new RangeError('Invalid raw SIR payload.');
  const payload = bytes.slice();
  const packet = concat(b(0x55, 0xaa, payload.length & 255, payload.length >>> 8), payload);
  const result = await adapter.io(adapter.device.transferOut(adapter.outEndpoint, packet), 'sending raw SIR bytes');
  if (result.status !== 'ok' || result.bytesWritten !== packet.length) throw new Error(`USB OUT: ${result.status}, ${result.bytesWritten}/${packet.length} bytes.`);
  record('serial-tx-usb-complete', { dataHex: toHex(payload), bytesWritten: result.bytesWritten });
  const deadline = performance.now() + payload.length * 10000 / 9600 + 1000;
  let previousCount = Infinity;
  while (alive() && performance.now() < deadline) {
    adapter.assertOpen();
    const [status, low, high] = await adapter.registers(5, 3, true);
    if (!alive()) return false;
    if (!(status & 0x10) || (status & 4)) return true;
    const count = low | ((high & 0x1f) << 8);
    if (count > previousCount) break;
    previousCount = count;
    await sleep(2);
  }
  if (!alive()) return false;
  // Use the existing PAD-5 recovery and end this attempt on a stuck FIFO.
  await adapter.abortFIFO();
  return false;
}

export async function probeSerial(adapter, settings, { signal, record = () => {} } = {}) {
  const options = serialSettings(settings);
  signal?.throwIfAborted(); adapter.assertOpen();
  if (!adapter.configured || adapter.baud !== 9600 || adapter.readerTask || adapter.readPending) throw new Error('Prepare an idle 9600 bit/s receiver before serial research.');
  const { durationMs, watchMode, probe, probeHex, repeatMs, initialDelayMs } = options;
  const bytesToSend = fromHex(probeHex), chunks = [];
  const counters = adapter.serialStats = { rxBytes: 0, rxBeforeProbe: 0, rxAfterProbe: 0, readCount: 0,
    nonemptyReads: 0, emptyReads: 0, txAttempts: 0, txCompleted: 0, txSerialBytes: 0, probePausedByRX: false };
  const started = performance.now(), deadline = started + durationMs;
  let due = started + initialDelayMs, reason = null, error = null, transmitting = false, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const end = cause => {
    if (reason) return;
    reason = cause;
    if (cause === 'deadline' && transmitting) {
      reason = 'error'; error = { name: 'USBTransmitTimeout', message: 'Raw SIR transmission did not finish before the capture deadline.' };
    }
    record('serial-ending', { reason }); finish({ ended: true });
    adapter.close().catch(caught => record('cleanup-error', { error: String(caught) }));
  };
  const wait = promise => Promise.race([Promise.resolve(promise).then(value => ({ value }), caught => ({ error: caught })), ended]);
  const abort = () => end('interrupted');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => end('deadline'), durationMs);
  record('serial-start', { ...options, framing: 'raw-sir-8n1', usbHeader: '55aa', stopTransmittingOnAnyRX: true,
    irlap: false, automaticAcknowledgements: false });
  try {
    while (!reason && performance.now() < deadline) {
      signal?.throwIfAborted(); adapter.assertOpen();
      if (bytesToSend.length && !counters.probePausedByRX && performance.now() >= due) {
        counters.txAttempts++; transmitting = true;
        record('serial-tx-attempt', { probe, dataHex: probeHex, number: counters.txAttempts, baud: 9600 });
        const sent = await wait(sendSerialBytes(adapter, bytesToSend, { record, alive: () => !reason }));
        transmitting = false;
        if (sent.ended) break;
        if (sent.error) throw sent.error;
        if (!sent.value) break;
        counters.txCompleted++; counters.txSerialBytes += bytesToSend.length;
        record('serial-tx-complete', { probe, dataHex: probeHex, number: counters.txCompleted, fifoDrained: true });
        due = repeatMs ? performance.now() + repeatMs : Infinity;
      }
      if (reason) break;
      adapter.readPending = true;
      const reading = adapter.device.transferIn(adapter.inEndpoint, 64).finally(() => { adapter.readPending = false; });
      const outcome = await wait(reading);
      if (outcome.ended) break;
      if (outcome.error) throw outcome.error;
      const result = outcome.value;
      if (result.status !== 'ok' || !result.data) throw new Error(`USB IN: ${result.status}, missing or failed data buffer.`);
      const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
      counters.readCount++; adapter.rxBytes += bytes.length;
      if (bytes.length) {
        const offset = counters.rxBytes;
        chunks.push(bytes); counters.rxBytes += bytes.length; counters.nonemptyReads++;
        counters[counters.txCompleted ? 'rxAfterProbe' : 'rxBeforeProbe'] += bytes.length;
        if (!counters.probePausedByRX) record('serial-probe-paused', { reason: 'received-bytes', offset, beforeProbe: !counters.txCompleted });
        counters.probePausedByRX = true;
        record('serial-rx', { offset, dataHex: toHex(bytes), afterProbe: Boolean(counters.txCompleted) });
        if (counters.rxBytes >= LIMIT) { end('byte-limit'); break; }
      } else {
        counters.emptyReads++;
        await wait(sleep(2));
      }
    }
  } catch (caught) {
    if (!reason) { reason = signal?.aborted ? 'interrupted' : 'error'; error = { name: caught.name, message: caught.message }; }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
  const received = joinChunks(chunks);
  const result = { ...options, ...counters,
    status: ['interrupted', 'error'].includes(reason) ? reason : reason === 'byte-limit' ? 'byte-limit' :
      received.length ? 'captured' : bytesToSend.length && !counters.txCompleted ? 'probe-not-sent' : 'no-data',
    elapsedMs: performance.now() - started, xmodemCandidates: xmodemCandidates(received), error,
    framing: 'raw-sir-8n1', irlap: false, crcRecovery: false, automaticAcknowledgements: false };
  record('serial-finished', result);
  return result;
}

// USB close can complete an already pending read. Summarize the authoritative
// trace AFTER close so those bytes are included in the result and block scan.
export function finishSerialCapture(result, events) {
  const chunks = [];
  let sent = false, rxBeforeProbe = 0, rxAfterProbe = 0, readCount = 0, nonemptyReads = 0, emptyReads = 0;
  for (const event of events) {
    if (event.kind === 'serial-tx-complete') sent = true;
    if (event.kind !== 'usb-result' || event.operation !== 'transferIn' || event.status !== 'ok' || !event.data) continue;
    const bytes = fromHex(event.data.hex); chunks.push(bytes); readCount++;
    if (bytes.length) nonemptyReads++; else emptyReads++;
    if (sent) rxAfterProbe += bytes.length; else rxBeforeProbe += bytes.length;
  }
  const received = joinChunks(chunks);
  return { ...result, processedWindowRxBytes: result.rxBytes, rxBytes: received.length,
    rxBeforeProbe, rxAfterProbe, readCount, nonemptyReads, emptyReads,
    status: received.length && ['no-data', 'probe-not-sent'].includes(result.status) ? 'captured' : result.status,
    xmodemCandidates: xmodemCandidates(received) };
}
