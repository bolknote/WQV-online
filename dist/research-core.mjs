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

export function captureUSB(device, record, state = () => ({})) {
  let sequence = 0;
  return new Proxy(device, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return async (...args) => {
      const id = ++sequence;
      record('usb-call', { id, operation: String(key), args: snapshot(args), ...state() });
      try {
        const result = await value.apply(target, args);
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
    { name: 'README.txt', data: encoder.encode('events.jsonl is the authoritative trace: timestamps, USB boundaries, empty reads, control transfers, status and errors are preserved.\nusb-in.bin concatenates original bulk-IN bytes before CRC recovery; it includes discovery and negotiation.\nusb-out-requested.bin concatenates requested bulk-OUT buffers, including SigmaTel headers. Check bytesWritten/status in events.jsonl for short or failed writes.\nframes.jsonl contains decoded frames, including duplicates and echoes seen by the protocol reader. After a protocol error the page listens passively until the response deadline, without further polls or application commands.\nresponse.bin contains accepted IrCOMM application payloads after the single command, without interpretation. before-command.bin contains unsolicited application data seen before the command. Raw discarded/invalid or unrecognized frames remain in usb-in.bin and events.jsonl.\nA reply is not proof of the command meaning. No reply is not proof the command is unused. A failed/interrupted capture may be incomplete; pendingUSBCalls lists unresolved calls.\n') },
  ];
}
