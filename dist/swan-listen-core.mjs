import { fromHex, toHex } from './formats.mjs';
import { attemptFiles } from './research-core.mjs';
import { scanSwanPackets } from './swan-core.mjs';

// These are receiver settings, not a detected or established WQV-3 speed.
export const SWAN_LISTEN_PLAN = Object.freeze([9600, 38400].flatMap(baud => [
  { id: `background-${baud}`, baud, watchPresent: false, watchMode: null, seconds: 20 },
  { id: `send-${baud}`, baud, watchPresent: true, watchMode: 'swan-send', seconds: 45 },
  { id: `receive-${baud}`, baud, watchPresent: true, watchMode: 'swan-receive', seconds: 45 },
]).map(Object.freeze));

export function confirmedConditions(step, at) {
  if (!SWAN_LISTEN_PLAN.includes(step)) throw new RangeError('Invalid listening step.');
  return { source: 'user-confirmation', confirmedAt: at, watchPresent: step.watchPresent,
    watchMode: step.watchMode, finalButtonPending: step.watchPresent,
    restartForThisAttempt: step.watchPresent,
    placement: step.watchPresent ? 'facing-adapter-5-to-10-cm' : 'removed-from-ir-path' };
}

// Read the authoritative USB journal after close, including late completions.
// A background capture never inherits a watch-mode label from the previous run.
export function analyseSwanListening(events) {
  const chunks = [], bursts = [], histogram = new Array(256).fill(0), pending = new Set();
  let readCount = 0, emptyReads = 0, failedReads = 0, rxBytes = 0, bulkOutCalls = 0;
  for (const event of events) {
    if (event.kind === 'usb-call') {
      pending.add(event.id);
      if (event.operation === 'transferOut') bulkOutCalls++;
    }
    if (event.kind === 'usb-result' || event.kind === 'usb-error') pending.delete(event.id);
    if (event.kind !== 'usb-result' || event.operation !== 'transferIn' || !event.data) continue;
    const bytes = fromHex(event.data.hex); readCount++;
    if (event.status !== 'ok') failedReads++;
    if (!bytes.length) { emptyReads++; continue; }
    bursts.push({ offset: rxBytes, at: event.at, elapsedMs: event.elapsedMs, dataHex: toHex(bytes), bytes: bytes.length });
    chunks.push(bytes); rxBytes += bytes.length;
    for (const byte of bytes) histogram[byte]++;
  }
  const bytes = new Uint8Array(rxBytes);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  return { bytes, analysis: { rxBytes, readCount, emptyReads, failedReads, nonemptyReads: bursts.length,
    bulkOutCalls, pendingUSBCalls: [...pending], bursts,
    histogram: histogram.flatMap((count, byte) => count ? [{ hex: byte.toString(16).padStart(2, '0'), count }] : []),
    markers: events.filter(event => ['watch-send-mark', 'watch-receive-mark'].includes(event.kind)),
    digimonPacketCandidates: scanSwanPackets(bytes).packets,
    origin: 'unverified', rawBytesPreserved: true, crcRecovery: false, echoRemoved: false } };
}

export function swanListeningFiles(attempt, events) {
  const { analysis } = analyseSwanListening(events), encoder = new TextEncoder();
  const files = attemptFiles(attempt, events);
  files.find(file => file.name === 'README.txt').data = encoder.encode(
    'WQV-3 SWAN PASSIVE SPEED COMPARISON\n' +
    'No bulk OUT is allowed. USB control transfers configure the SigmaTel receiver. There are no optical probes, invitations, acknowledgements, retransmissions or application commands. A 38400 bit/s setting is a hypothesis based on the WonderSwan UART, not an established WQV-3 speed.\n' +
    'attempt.json records the planned step, separately confirmed physical conditions and the observer-selected final watch display. A control has watchPresent=false and watchMode=null. Physical conditions are user reports; software cannot verify watch placement or mode. A marker records a click on this page, not the exact optical or watch-button timing.\n' +
    'events.jsonl retains all USB calls/results, empty reads, errors, boundaries, UTC and monotonic timestamps. usb-in.bin concatenates every delivered bulk-IN byte, including reads completed during close, without repair or echo removal. USB completion times are not optical pulse timings. analysis.json includes individual data-bearing reads and a byte histogram. Digimon packet candidates are annotations, not identification of a Casio protocol.\n' +
    'Compare each watch capture with the background capture at the same speed. RX bytes or a timeout alone do not identify their source or establish compatibility. Failed, interrupted or unresolved USB captures are not valid negative results. No console ROM or game payload is included.\n');
  return [...files, { name: 'analysis.json', data: encoder.encode(JSON.stringify(analysis, null, 2) + '\n') }];
}
