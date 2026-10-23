import { WQVClient } from './protocol.mjs';
import { b, fromHex, toHex } from './formats.mjs';

export const PROBE_PLAN = Object.freeze([
  { code: 0xaa, evidence: 'control' }, { code: 0xad, evidence: 'client' },
  { code: 0x0b, evidence: 'gap' }, { code: 0xab, evidence: 'neighbor' },
  { code: 0xac, evidence: 'neighbor' }, { code: 0xae, evidence: 'neighbor' },
  { code: 0xaf, evidence: 'neighbor' }, { code: 0xa8, evidence: 'neighbor' },
  { code: 0xa9, evidence: 'neighbor' }, { code: 0xb0, evidence: 'neighbor' },
].map(Object.freeze));

// Snapshot BufferSource views at the USB boundary, before the decoder sees them.
export function snapshot(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) :
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { hex: toHex(bytes), byteLength: bytes.byteLength };
  }
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]));
  return value ?? null;
}

export function captureUSB(device, record, state = () => ({}), { receiveOnly = false, counters } = {}) {
  let sequence = 0;
  return new Proxy(device, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return async (...args) => {
      const id = ++sequence;
      record('usb-call', { id, operation: String(key), args: snapshot(args), ...state() });
      try {
        if (receiveOnly && key === 'transferOut') throw new Error('USB bulk OUT is disabled in listen mode.');
        const result = await value.apply(target, args);
        if (counters && key === 'transferIn' && result?.status === 'ok' && result.data) {
          counters.readCount++;
          if (result.data.byteLength) counters.nonemptyReads++; else counters.emptyReads++;
          counters.rxBytes += result.data.byteLength;
        }
        record('usb-result', { id, operation: String(key), status: result?.status ?? null,
          data: result?.data ? snapshot(result.data) : null, bytesWritten: result?.bytesWritten ?? null, ...state() });
        return result;
      } catch (error) {
        record('usb-error', { id, operation: String(key), error: String(error), name: error.name, ...state() });
        throw error;
      }
    };
  } });
}

export class ProbeTimeout extends Error { constructor(message) { super(message); this.name = 'ProbeTimeout'; } }

export class ManualSteps {
  constructor(index = 0, done = false) {
    this.index = Number.isInteger(index) && index >= 0 && index < PROBE_PLAN.length ? index : 0;
    this.state = done ? 'done' : 'idle';
  }
  get step() { return PROBE_PLAN[this.index]; }
  begin() { if (this.state !== 'idle') throw new Error('Prepare or retry the current step first.'); this.state = 'running'; }
  finish() { if (this.state !== 'running') throw new Error('No step is running.'); this.state = 'done'; }
  next(skip = false) {
    if (this.state === 'running' || (!skip && this.state !== 'done')) throw new Error('Finish or skip this step first.');
    if (this.index + 1 >= PROBE_PLAN.length) throw new Error('This is the last step.');
    this.index++; this.state = 'idle';
  }
  retry() { if (this.state === 'running') throw new Error('Stop this step first.'); this.state = 'idle'; }
}

function joinBytes(chunks) {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

// Only this research client changes retry behavior; the normal app is untouched.
export class ResearchClient extends WQVClient {
  constructor(adapter, options = {}) {
    super(adapter, options);
    this.record = options.record ?? (() => {});
    this.probing = false; this.commandAttempted = false; this.commandSent = false; this.replyParts = [];
  }
  packet(direction, frame) {
    this.record(direction, { address: frame.address, control: frame.control, dataHex: toHex(frame.data),
      phase: this.probing ? 'probe' : 'connection' });
  }
  async send(data = b(), ...args) {
    const application = this.probing && data.length;
    if (application) {
      if (this.commandAttempted) throw new Error('A research command must never be retransmitted automatically.');
      if (this.appBuffer.length) throw new Error('Application data arrived before the command. Restart the watch session.');
      this.commandAttempted = true;
      this.record('command-send-attempt', { commandHex: toHex(this.command), ircommHex: toHex(data) });
    }
    await super.send(data, ...args);
    if (application) { this.commandSent = true; this.record('command-sent', { commandHex: toHex(this.command) }); }
  }
  async read(timeout = 2000, optional = false) {
    if (!this.probing) return super.read(timeout, optional);
    const remaining = this.probeDeadline - performance.now();
    const frame = remaining > 0 ? await super.read(Math.min(timeout, remaining), true) : null;
    if (!frame && !optional) throw new ProbeTimeout('The response window ended or the watch stopped replying.');
    return frame;
  }
  primaryIngest(frame) {
    const before = this.appBuffer.length;
    try { return super.primaryIngest(frame); }
    finally {
      if (this.probing && this.appBuffer.length > before) {
        const bytes = this.appBuffer.slice(before);
        if (this.commandAttempted) this.replyParts.push(bytes);
        this.record(this.commandAttempted ? 'application-rx' : 'application-before-command', { dataHex: toHex(bytes) });
      }
    }
  }
  async probe(code, responseMs = 5000) {
    if (!PROBE_PLAN.some(step => step.code === code)) throw new RangeError('Code is not in the research plan.');
    if (!Number.isFinite(responseMs) || responseMs < 10 || responseMs > 30000) throw new RangeError('Invalid response window.');
    if (!this.connected || !this.isPrimary || this.model !== 3) throw new Error('A new WQV-3 primary session is required.');
    if (this.probing || this.appBuffer.length) throw new Error('Start a fresh session for each command.');
    this.command = b(code); this.probing = true; this.probeDeadline = performance.now() + responseMs;
    this.record('probe-start', { commandHex: toHex(this.command), responseMs, retransmit: false });
    let error = null;
    try {
      await this.primarySend(this.command);
      while (performance.now() < this.probeDeadline) await this.primaryExchange();
    } catch (caught) {
      error = { name: caught.name, message: caught.message };
      this.record(caught instanceof ProbeTimeout ? 'response-window-ended' : 'probe-error', error);
      // An unfamiliar reply must not cut off the raw capture. After a protocol
      // error, listen until the original deadline without sending any more polls.
      if (!(caught instanceof ProbeTimeout) && !this.signal?.aborted) {
        this.record('passive-capture-start');
        try {
          while (performance.now() < this.probeDeadline && this.adapter.opened && !this.adapter.readError) {
            this.check();
            const frame = await this.adapter.receiveFrame(Math.min(150, this.probeDeadline - performance.now()));
            if (frame) this.record('rx-frame', { address: frame.address, control: frame.control,
              dataHex: toHex(frame.data), phase: 'passive-after-error' });
          }
        } catch (passiveError) { this.record('passive-capture-error', { error: String(passiveError) }); }
      }
    }
    const response = joinBytes(this.replyParts);
    return { commandHex: toHex(this.command), commandAttempted: this.commandAttempted, commandSent: this.commandSent, responseHex: toHex(response),
      responseBytes: response.length, responseMs, error,
      status: error && error.name !== 'ProbeTimeout' ? 'error' : response.length ? 'response' : 'no-response' };
  }
}

export function attemptFiles(attempt, events) {
  const encoder = new TextEncoder();
  const rx = [], tx = [], reply = [], beforeCommand = [], frames = [];
  const pending = new Set();
  for (const event of events) {
    if (event.kind === 'usb-call') {
      pending.add(event.id);
      if (event.operation === 'transferOut' && event.args[1]?.hex) tx.push(fromHex(event.args[1].hex));
    }
    if (event.kind === 'usb-result' || event.kind === 'usb-error') pending.delete(event.id);
    if (event.kind === 'usb-result' && event.operation === 'transferIn' && event.data) rx.push(fromHex(event.data.hex));
    if (event.kind === 'application-rx') reply.push(fromHex(event.dataHex));
    if (event.kind === 'application-before-command') beforeCommand.push(fromHex(event.dataHex));
    if (event.kind === 'rx-frame' || event.kind === 'tx-frame') frames.push(event);
  }
  const json = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
  const jsonl = rows => encoder.encode(rows.map(row => JSON.stringify(row) + '\n').join(''));
  return [
    { name: 'attempt.json', data: json({ ...attempt, capturedEvents: events.length, pendingUSBCalls: [...pending] }) },
    { name: 'events.jsonl', data: jsonl(events) }, { name: 'frames.jsonl', data: jsonl(frames) },
    { name: 'usb-in.bin', data: joinBytes(rx) }, { name: 'usb-out-requested.bin', data: joinBytes(tx) },
    { name: 'response.bin', data: joinBytes(reply) },
    { name: 'before-command.bin', data: joinBytes(beforeCommand) },
    { name: 'README.txt', data: encoder.encode(attempt.kind === 'discovery' ?
      'ACTIVE DISCOVERY: fixed 9600 bit/s. Only XID search commands and XID replies are transmitted. Each completed search has six slots and a final slot FF advertising WEB-WQV with hints 84 25 and ASCII charset 00. These are the identity hints used by the working PC receiver, not proof of OTHERS/SWAN compatibility.\n' +
      'An incoming search interrupts our search to avoid competing with the peer. Incoming XID frames are answered once per observed peer cycle in the current slot. An SNRM addressed to us is saved and ends the experiment; no connection is accepted and no application command, IAS reply, photo transfer or speed negotiation is sent.\n' +
      'The selected watch mode is a manual label, not an automatic identification. The trace includes the generated local device ID, peer IDs, names and service hints. CRC recovery is disabled. Echoes with our source ID are counted separately.\n' +
      'events.jsonl is the authoritative USB trace, including empty reads, errors, timestamps, transfer boundaries, configuration requests and SEND markers. usb-in.bin contains original bulk-IN bytes before decoding; usb-out-requested.bin contains requested bulk-OUT buffers including SigmaTel headers. Check completion status and bytesWritten to establish transmission. frames.jsonl contains strict CRC-valid received frames and completed transmitted XIDs.\n' +
      'response.bin and before-command.bin are empty because no application session is opened. An empty recording does not establish the cause of silence. USB counters include successful reads completing during close; pendingUSBCalls lists unresolved requests. Interrupted, failed or live exports may be incomplete.\n' : attempt.kind === 'listen' ?
      'PASSIVE LISTENING: no discovery, watch commands, polls or acknowledgements are sent. USB bulk OUT is blocked; USB control writes configure the local SigmaTel receiver only.\n' +
      'attempt.json identifies the user-selected watch mode, fixed baud rate and capture window. These are test settings, not an automatically identified protocol.\n' +
      'usb-in.bin concatenates the exact bulk-IN bytes returned by SigmaTel, before any frame parsing. USB bytes are not a recording of optical pulse timings. Unknown data and CRC failures are preserved.\n' +
      'events.jsonl is the authoritative trace: UTC and monotonic timestamps, USB transfer IDs and boundaries, baud rate, empty reads, control transfers, errors and manual SEND markers. A SEND marker records a click on this page, not the exact physical button press on the watch.\n' +
      'frames.jsonl contains optional IrDA frames that pass the unmodified CRC check. No CRC recovery, byte removal or damaged-EOF completion is used. Other formats remain in the raw stream. response.bin and before-command.bin are empty because no application session is opened.\n' +
      'No received bytes does not establish that the watch sent nothing: the selected rate or optical format may be wrong, or the adapter may not have delivered the data.\n' +
      'The original stream includes reads completing during USB shutdown; the capture counters count reads processed before the window ended. pendingUSBCalls lists unresolved calls, including a read not yet cancelled by USB close. A failed/interrupted capture or live export may be incomplete.\n' :
      'events.jsonl is the authoritative trace: timestamps, USB boundaries, empty reads, control transfers, status and errors are preserved.\nusb-in.bin concatenates original bulk-IN bytes before CRC recovery; it includes discovery and negotiation.\nusb-out-requested.bin concatenates requested bulk-OUT buffers, including SigmaTel headers. Check bytesWritten/status in events.jsonl for short or failed writes.\nframes.jsonl contains decoded frames, including duplicates and echoes seen by the protocol reader. After a protocol error the page listens passively until the response deadline, without further polls or application commands.\nresponse.bin contains accepted IrCOMM application payloads after the single command, without interpretation. before-command.bin contains unsolicited application data seen before the command. Raw discarded/invalid or unrecognized frames remain in usb-in.bin and events.jsonl.\nA reply is not proof of the command meaning. No reply is not proof the command is unused. A failed/interrupted capture may be incomplete; pendingUSBCalls lists unresolved calls.\n') },
  ];
}
