import { concat, fromHex, toHex } from './formats.mjs';
import { attemptFiles } from './research-core.mjs';

// Independently recovered from the supplied Tag Tamers and Pocket DigimonWorld
// programs. These are synthetic framing probes, not identified Casio commands.
export const SWAN_FORMAT = 'wonderwave-digimon-v1';
export const SWAN_PLAN = Object.freeze([
  { id: 'echo-control', label: 'Adapter echo control', headerType: 0x11, variant: 1, watchPresent: false },
  { id: 'ws-paired', label: 'SWAN RECEIVE · header 11', headerType: 0x11, variant: 1, watchPresent: true },
  { id: 'pocket-paired', label: 'SWAN RECEIVE · header 21', headerType: 0x21, variant: 1, watchPresent: true },
  { id: 'ws-unpaired', label: 'SWAN RECEIVE · selector 02', headerType: 0x11, variant: 2, watchPresent: true },
].map(Object.freeze));

export function packetBytes(text) {
  const compact = String(text).replace(/\s/g, '');
  if (!/^(?:[a-f\d]{2})+$/i.test(compact)) throw new RangeError('Enter complete hexadecimal bytes.');
  return fromHex(compact);
}

export function swanPreset(index) {
  const step = SWAN_PLAN[index];
  if (!step) throw new RangeError('Invalid SWAN step.');
  // Twelve uninterpreted header bytes: type, synthetic zero system identity,
  // Tag Tamers cartridge ID, zero tail. The payload 00 is synthetic too.
  return { variant: step.variant, header: Uint8Array.of(step.headerType, 0, 0, 0, 0, 1, 0, 0x32, 1, 0, 0, 0), payload: Uint8Array.of(0) };
}

export function encodeSwanPacket({ variant, header, payload }) {
  if (![1, 2].includes(variant)) throw new RangeError('Transport selector must be 01 or 02.');
  if (!(header instanceof Uint8Array) || header.length !== 12) throw new RangeError('The header must contain exactly 12 bytes.');
  if (!(payload instanceof Uint8Array) || payload.length < 1 || payload.length > 128) throw new RangeError('The payload must contain 1–128 bytes.');
  const logical = concat(Uint8Array.of(variant), header, Uint8Array.of(payload.length), payload);
  const checksum = logical.reduce((sum, value) => (sum + value) & 255, 0);
  const body = concat(logical, Uint8Array.of(checksum));
  const paired = bytes => Uint8Array.from([...bytes].flatMap(value => [value, value ^ 255]));
  return concat(Uint8Array.of(0x55, 0xff, 0), variant === 1 ? paired(body) : concat(paired(body.slice(0, 1)), body.slice(1)));
}

export function decodeSwanPacket(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes[0] !== 0x55 || bytes[1] !== 255 || bytes[2] !== 0) throw new RangeError('Invalid 55 FF 00 prefix.');
  const variant = bytes[3];
  if (![1, 2].includes(variant) || (variant ^ bytes[4]) !== 255) throw new RangeError('Invalid selector or complement.');
  let logical;
  if (variant === 1) {
    if ((bytes.length - 3) % 2) throw new RangeError('Incomplete byte pair.');
    for (let i = 3; i < bytes.length; i += 2) if ((bytes[i] ^ bytes[i + 1]) !== 255) throw new RangeError('Complement mismatch.');
    logical = Uint8Array.from(bytes.slice(3).filter((_, index) => !(index % 2)));
  } else logical = concat(bytes.slice(3, 4), bytes.slice(5));
  const size = logical[13];
  // RX may reveal payload sizes beyond our deliberately limited TX presets.
  if (!size || logical.length !== 15 + size) throw new RangeError('Packet length mismatch.');
  const checksum = logical.slice(0, -1).reduce((sum, value) => (sum + value) & 255, 0);
  if (checksum !== logical.at(-1)) throw new RangeError('SUM8 mismatch.');
  return { variant, headerHex: toHex(logical.slice(1, 13)), payloadHex: toHex(logical.slice(14, -1)), checksum, wireBytes: bytes.length };
}

// Scan untouched RX, allowing noise, USB fragmentation and multiple packets.
// Bad/incomplete candidates are annotations; no byte is changed or discarded.
export function scanSwanPackets(bytes, transmitted = new Uint8Array()) {
  const packets = [], rejected = [], txMatches = [];
  const equalAt = (value, offset) => value.every((byte, index) => bytes[offset + index] === byte);
  for (let offset = 0; offset < bytes.length; offset++) {
    if (transmitted.length && offset + transmitted.length <= bytes.length && equalAt(transmitted, offset)) txMatches.push({ offset, bytes: transmitted.length, origin: 'unverified-possible-echo' });
    if (bytes[offset] !== 0x55 || bytes[offset + 1] !== 255 || bytes[offset + 2] !== 0) continue;
    if (packets.length + rejected.length >= 256) continue;
    const variant = bytes[offset + 3];
    if (![1, 2].includes(variant)) { rejected.push({ offset, error: 'Invalid selector.' }); continue; }
    const lengthOffset = variant === 1 ? offset + 29 : offset + 17;
    if (lengthOffset >= bytes.length) { rejected.push({ offset, error: 'Incomplete header.' }); continue; }
    const size = bytes[lengthOffset], wireBytes = variant === 1 ? 33 + 2 * size : 19 + size;
    if (offset + wireBytes > bytes.length) { rejected.push({ offset, error: 'Incomplete packet.', expectedWireBytes: wireBytes }); continue; }
    const candidate = bytes.slice(offset, offset + wireBytes);
    try {
      packets.push({ offset, ...decodeSwanPacket(candidate), matchesTransmitted: candidate.length === transmitted.length && equalAt(transmitted, offset), origin: 'unverified' });
    } catch (error) { rejected.push({ offset, error: error.message }); }
  }
  return { packets, rejected, txMatches, possibleEchoBytes: txMatches.reduce((sum, match) => sum + match.bytes, 0) };
}

export function analyseSwanCapture(events, transmitted) {
  const chunks = [];
  let receivedBeforeWrite = 0, usbWriteCompleted = false;
  for (const event of events) {
    if (event.kind === 'serial-tx-usb-complete' && event.dataHex === toHex(transmitted)) usbWriteCompleted = true;
    if (event.kind !== 'usb-result' || event.operation !== 'transferIn' || !event.data) continue;
    const bytes = fromHex(event.data.hex); chunks.push(bytes);
    if (!usbWriteCompleted) receivedBeforeWrite += bytes.length;
  }
  const received = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let position = 0;
  for (const chunk of chunks) { received.set(chunk, position); position += chunk.length; }
  const scan = scanSwanPackets(received, usbWriteCompleted ? transmitted : new Uint8Array());
  scan.txMatches = scan.txMatches.filter(match => match.offset >= receivedBeforeWrite);
  scan.possibleEchoBytes = scan.txMatches.reduce((sum, match) => sum + match.bytes, 0);
  scan.packets = scan.packets.map(candidate => ({ ...candidate, possibleEcho: candidate.matchesTransmitted && candidate.offset >= receivedBeforeWrite }));
  return { ...scan, rxBytes: received.length, usbWriteCompleted, receivedBeforeWrite, rawBytesPreserved: true, echoRemoved: false,
    interpretation: 'Packet framing and exact TX matches only. No peer identity or watch command meaning is established.' };
}

export function swanAttemptFiles(attempt, events) {
  const bytes = fromHex(attempt.probeHex);
  const analysis = analyseSwanCapture(events, bytes);
  const files = attemptFiles(attempt, events), encoder = new TextEncoder();
  const readme = files.find(file => file.name === 'README.txt');
  readme.data = encoder.encode('WQV-3 SWAN FRAMING EXPERIMENT\n' +
    'The candidate format is recovered from Digimon software on WonderSwan and PocketStation. It is not an identified Casio command. System identity and payload bytes in the presets are synthetic. Header type assignments and Tag Tamers cartridge ID come from the supplied programs; their applicability to WQV-3 is unverified.\n' +
    'Each capture sends candidate-frame.bin at most ONCE, only after a manual button press. No discovery, IrLAP envelope, frame CRC, automatic retries, ACKs, delete, clock or firmware commands are added. The next step never starts automatically. The first step is a control with the watch removed from the IR path.\n' +
    'All original RX/TX and control transfers, empty reads, timestamps, boundaries, errors and late completions remain in events.jsonl. usb-in.bin is untouched; analysis.json marks checksum-valid packet candidates and exact matches to our requested TX. Matches are POSSIBLE echo, not a proven source identification. No echo removal or CRC repair occurs.\n' +
    'candidate-frame.bin is the planned optical byte sequence; it does not prove transmission. serial-out-requested.bin records attempted serial writes. serial-out-completed.bin requires successful USB OUT and FIFO drain. USB success does not prove optical delivery. Check the error/status fields and unresolved calls in attempt.json. Before/after RX counters use USB completion order, not optical timing.\n' +
    'A valid packet, an exact TX match, unrelated RX bytes, or a timeout does not prove watch compatibility. A probe-not-sent, USB error, interrupted capture, failed cleanup or unresolved call is not a successful negative test. Save both the control and watch attempts for comparison.\n');
  return [...files, { name: 'candidate-frame.bin', data: bytes },
    { name: 'analysis.json', data: encoder.encode(JSON.stringify(analysis, null, 2) + '\n') }];
}
