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
  const rx = [], tx = [], serialRequested = [], serialCompleted = [], reply = [], beforeCommand = [], frames = [];
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
    if (event.kind === 'serial-tx-attempt') serialRequested.push(fromHex(event.dataHex));
    if (event.kind === 'serial-tx-complete') serialCompleted.push(fromHex(event.dataHex));
  }
  const json = value => encoder.encode(JSON.stringify(value, null, 2) + '\n');
  const jsonl = rows => encoder.encode(rows.map(row => JSON.stringify(row) + '\n').join(''));
  if (attempt.kind === 'irtranp') return [
    { name: 'attempt.json', data: json({ ...attempt, capturedEvents: events.length, pendingUSBCalls: [...pending] }) },
    { name: 'events.jsonl', data: jsonl(events) }, { name: 'frames.jsonl', data: jsonl(frames) },
    { name: 'usb-in.bin', data: joinBytes(rx) }, { name: 'usb-out-requested.bin', data: joinBytes(tx) },
    { name: 'application-in.bin', data: joinBytes(reply) },
    { name: 'application-out-queued.bin', data: joinBytes(events.filter(e => e.kind === 'application-tx-queued').map(e => fromHex(e.dataHex))) },
    ...events.filter(e => e.kind === 'irtranp-file').map((event, index) => ({
      name: `files/${String(index).padStart(3, '0')}-${/^[A-Za-z0-9_-]{1,8}\.[A-Za-z0-9]{1,3}$/.test(event.filename) ? event.filename : 'received.bin'}`,
      data: fromHex(event.dataHex),
    })),
    ...events.filter(e => e.kind === 'irtranp-upload-file').map((event, index) => ({
      name: `upload-input/${String(index).padStart(3, '0')}-${/^[A-Za-z0-9_-]{8}\.UPF$/i.test(event.filename) ? event.filename : 'input.upf'}`,
      data: fromHex(event.dataHex),
    })),
    ...events.filter(e => e.kind === 'irtranp-reference-file').map((event, index) => ({
      name: `reference-input/${String(index).padStart(3, '0')}-${String(event.filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`, data: fromHex(event.dataHex),
    })),
    { name: 'README.txt', data: encoder.encode((attempt.test === 'listen-selection' ?
      'PASSIVE SEND SELECTION-SCREEN RECORDING. USB bulk OUT is blocked. No discovery, watch commands, polls or acknowledgements are sent. USB control writes configure only the local SigmaTel receiver at the selected fixed rate. Frame decoding uses the original CRC without recovery; every delivered byte is retained before parsing.\n' +
      'The first front press enters the SEND photo-selection screen, side buttons change the selected photo, and another front press begins transmission. watch-stage-mark records page clicks for those actions and an optional watch frame label; these are approximate annotations, not optical arrival times or automatically identified watch states. USB completion boundaries remain in events.jsonl. No received bytes is inconclusive.\n' : attempt.test === 'active-receiver' ?
      'ACTIVE IRTRAN-P IMAGE RECEIVER. Discovers the watch, queries IAS and opens the advertised 9-wire IrCOMM service. Then waits for the peer to start SCEP and transfer an image. No outgoing SCEP Connect, GET, PUT, image-transfer request or watch setting command is sent. Serial controls and device identity are from our CSI-based stack, not a recovered Nokia IrCOMM driver.\n' +
      'imageProfile selects only the RIMG capability response: CSI or the original-size response reconstructed from Nokia 9210 irtranp.dll. Local capture remains bounded at 128 KiB. This is not a full Nokia device emulation. A 12-second idle timeout closes the connection; incomplete packets remain in the raw recording.\n' : attempt.test === 'sender' ?
      'IRTRAN-P PHOTO SENDER for OTHERS RECEIVE. This test WRITES one or two explicitly selected copies to the watch. It opens IAS/IrCOMM/SCEP, queries RIMG/RINF/RCMD, sends the original UPF through PUT, waits for a matching RPL0 or ERR0 reply and closes SCEP/IrCOMM/IrLAP. PUT command bytes and the special one-segment 41/SeqNo=0/RestNo=1 wrapper match offline execution of the original CSI Image Viewer 2.5 DLL. USB and lower IrDA layers are our implementation.\n' +
      'upload-input/ contains the exact selected or generated files, not proof of delivery. Generated feature images are identified by case, visible number and per-attempt nonce. Optional bFTP attributes and UPF metadata are recorded before sending. put-started is an attempt, not a stored photo. put-reply with accepted=true is the peer acknowledgement; result.complete additionally requires a clean session close. A missing reply after PUT leaves the write outcome UNCONFIRMED: the watch may already have stored a copy. PUT is never repeated automatically. Two-copy mode requires RCMD multiple-command support and stops on the first NACK. Cancellation cases send standard SCEP Stop or Abort, not USB Stop; a clean close alone does not prove that a file was not saved. An Abort skipped because a PUT reply arrived is recorded as too late. File timestamps do not set the watch clock.\n' : attempt.test === 'csi' ?
      'READ-ONLY CSI CAPABILITY CLIENT for OTHERS RECEIVE. Queries IAS, connects to the advertised IrCOMM/TinyTP selector, sends serial controls and SCEP Connect as CASSIOPEIA, then queries only RIMG, RINF and RCMD before disconnecting. MachineID, Connect and query packets match offline execution of CSI Image Viewer 2.5. Lower IrCOMM serial settings come from our PC-mode implementation; they are not recovered Windows CE driver bytes. No PUT, image, PC-mode switch, clock or firmware command is sent. Application queries are not repeated.\n' +
      'E0/81 damaged-start recovery requires a real C1 end marker and an unchanged valid original CRC. The raw USB stream is preserved before any recovery.\n' : attempt.test === 'ias' ?
      'READ-ONLY IRLAP/IAS CLIENT PROBE. Completes XID discovery, sends one SNRM, validates UA and negotiates link speed, then opens IAS and queries IrDA:IrCOMM Parameters, IrDA:TinyTP:LsapSel and IrDA:IrLMP:InstanceName before disconnecting. IAS requests are not repeated. RR acknowledgements/polls are ordinary link control. No IrCOMM/TinyTP channel, SCEP, bFTP, photo, PC-mode switch, clock or firmware command is sent.\n' +
      'When recoverBOF is enabled in the start event, E0 or 81 outside an existing frame can start a speculative frame. It requires a real C1 end marker and the original unchanged frame CRC; this cannot combine with byte trimming, alternative escapes or idle completion. recoveredBOF/rejectedBOF count these candidates. The original USB bytes are never changed.\n' :
      'STANDALONE IRTRAN-P RECEIVER for OTHERS SEND. SCEP identity, CACK and default capabilities are based on offline analysis of CSI Image Viewer 2.5. Lower-layer discovery/IrCOMM is our implementation, not a recording of the Windows CE driver.\n' +
      'Starts discovery at 9600 bit/s and negotiates link speed up to the configured maximum. Accepts incoming IrLAP and IrCOMM connections, answers IAS queries and SCEP/bFTP requests. Sends protocol replies and acknowledgements; no PC-mode Casio switch, upload, delete, clock or firmware command is sent to the watch.\n') +
      'events.jsonl is authoritative. USB calls/results retain original bytes, timestamps, boundaries, errors and empty reads. usb-in.bin is captured before CRC recovery. frames.jsonl contains decoded received frames and completed transmitted frames. application-in.bin is the received IrCOMM SCEP stream. application-out-queued.bin includes replies queued for transmission and does not prove delivery; use tx-frame and USB completion events.\n' +
      'files/ preserves each complete bFTP file body before image decoding. reference-input/ preserves the paired upload bytes for a feature read-back; reference-upload confirmation and source attempt are in the journal. Feature metadata is only interpreted after matching the compressed image, allowing table-order and non-image header differences. A received file is not proof of a cleanly completed session; check result.complete, status, errors and pendingUSBCalls. Incomplete SCEP packets remain in the raw application and USB streams. No received bytes is inconclusive. Manual SEND markers record page clicks, not exact physical button timings.\n') },
  ];
  return [
    { name: 'attempt.json', data: json({ ...attempt, capturedEvents: events.length, pendingUSBCalls: [...pending] }) },
    { name: 'events.jsonl', data: jsonl(events) }, { name: 'frames.jsonl', data: jsonl(frames) },
    { name: 'usb-in.bin', data: joinBytes(rx) }, { name: 'usb-out-requested.bin', data: joinBytes(tx) },
    { name: 'response.bin', data: joinBytes(reply) },
    { name: 'before-command.bin', data: joinBytes(beforeCommand) },
    ...(attempt.kind === 'serial' ? [
      { name: 'serial-out-requested.bin', data: joinBytes(serialRequested) },
      { name: 'serial-out-completed.bin', data: joinBytes(serialCompleted) },
    ] : []),
    { name: 'README.txt', data: encoder.encode(attempt.kind === 'serial' ?
      'RAW SERIAL EXPERIMENT: fixed 9600 bit/s, 8N1. The selected bytes go directly through the SigmaTel SIR path with only its USB 55 AA length header. No IrLAP address/control fields, escaping, frame CRC, discovery, polls, XMODEM ACKs or application session are added.\n' +
      'Check transmission in attempt.json. Manual mode sends the selected byte at most once, only after serial-manual-send-request. Earlier RX bytes are preserved and do not cancel this explicit request. Automatic mode starts after 500 ms: NAK (15) repeats at 2-second intervals while silent; CR (0D) is sent once. Any RX byte stops automatic transmission, including possible local echo. Listen-only transmits nothing. Capture continues until Stop/deadline; no automatic ACKs are sent. These probes are hypotheses from WonderWitch sources, not identified Casio commands.\n' +
      'events.jsonl is the authoritative trace, including empty reads, timestamps, USB transfer boundaries, failures, setup, pending calls and manual SEND/RECEIVE markers. Watch mode is a user-selected label; it is not identified automatically. usb-in.bin preserves ALL delivered bytes without decoding, CRC recovery or echo removal. The final result and XMODEM candidate scan include successful reads completed during USB close. USB bytes are not optical pulse timings; before/after counts refer to USB completions, not the original optical arrival times.\n' +
      'usb-out-requested.bin contains requested USB buffers including SigmaTel headers. serial-out-requested.bin contains only requested logical serial bytes. serial-out-completed.bin contains bytes for which USB OUT and FIFO drain checks both completed; neither USB success nor an empty FIFO proves optical delivery to the watch. Check status/bytesWritten and serial-tx-usb-complete events for writes that succeeded before a FIFO error.\n' +
      'No IrCOMM application response is decoded: response.bin, before-command.bin and frames.jsonl are empty. Check usb-in.bin for replies. XMODEM candidates have a complete SOH/sequence/inverse/128-byte-data/8-bit-checksum layout; a candidate is not proof of peer identity or full file compatibility. No ACK is sent after a candidate.\n' +
      'A no-data result is inconclusive. probe-not-sent means no probe completed: check probeNotSentReason, TX counters and the event trace. The manual button may not have been pressed, an automatic probe may have paused on early RX, or a USB read may have blocked the send. Received bytes never turn an unsent probe into a successful response test. Pending writes, deadline failures, byte-limit captures and interrupted runs are not successful negative watch tests. Late/unresolved calls are listed in pendingUSBCalls; live exports may be incomplete.\n' : attempt.kind === 'discovery' ?
      'ACTIVE DISCOVERY: fixed 9600 bit/s. Only XID search commands and XID replies are transmitted. Each completed search has six slots and a final slot FF advertising WEB-WQV with hints 84 25 and ASCII charset 00. These are the identity hints used by the working PC receiver, not proof of OTHERS/SWAN compatibility.\n' +
      'An incoming search interrupts our search to avoid competing with the peer. Incoming XID frames are answered once per observed peer cycle in the current slot. An SNRM addressed to us is saved and ends the experiment; no connection is accepted and no application command, IAS reply, photo transfer or speed negotiation is sent.\n' +
      'The selected watch mode is a manual label, not an automatic identification. The trace includes the generated local device ID, peer IDs, names and service hints. CRC recovery is disabled. Echoes with our source ID are counted separately.\n' +
      'events.jsonl is the authoritative USB trace, including empty reads, errors, timestamps, transfer boundaries, configuration requests and SEND markers. usb-in.bin contains original bulk-IN bytes before decoding; usb-out-requested.bin contains requested bulk-OUT buffers including SigmaTel headers. Check completion status and bytesWritten to establish transmission. frames.jsonl contains strict CRC-valid received frames and completed transmitted XIDs.\n' +
      'response.bin and before-command.bin are empty because no application session is opened. An empty recording does not establish the cause of silence. USB counters include successful reads completing during close; pendingUSBCalls lists unresolved requests. Interrupted, failed or live exports may be incomplete.\n' : attempt.kind === 'listen' ?
      'PASSIVE LISTENING: no discovery, watch commands, polls or acknowledgements are sent. USB bulk OUT is blocked; USB control writes configure the local SigmaTel receiver only.\n' +
      'attempt.json identifies the user-selected watch mode, fixed baud rate and capture window. These are test settings, not an automatically identified protocol.\n' +
      'usb-in.bin concatenates the exact bulk-IN bytes returned by SigmaTel, before any frame parsing. USB bytes are not a recording of optical pulse timings. Unknown data and CRC failures are preserved.\n' +
      'events.jsonl is the authoritative trace: UTC and monotonic timestamps, USB transfer IDs and boundaries, baud rate, empty reads, control transfers, errors and manual SEND/RECEIVE markers. watch-send-mark and watch-receive-mark record clicks on this page, not the exact physical button presses on the watch. SWAN RECEIVE is a passive label only; no receiver invitation, ACK or other byte is transmitted by the adapter.\n' +
      'frames.jsonl contains optional IrDA frames that pass the unmodified CRC check. No CRC recovery, byte removal or damaged-EOF completion is used. Other formats remain in the raw stream. response.bin and before-command.bin are empty because no application session is opened.\n' +
      'No received bytes does not establish that the watch sent nothing: the selected rate or optical format may be wrong, or the adapter may not have delivered the data.\n' +
      'The original stream includes reads completing during USB shutdown; the capture counters count reads processed before the window ended. pendingUSBCalls lists unresolved calls, including a read not yet cancelled by USB close. A failed/interrupted capture or live export may be incomplete.\n' :
      'events.jsonl is the authoritative trace: timestamps, USB boundaries, empty reads, control transfers, status and errors are preserved.\nusb-in.bin concatenates original bulk-IN bytes before CRC recovery; it includes discovery and negotiation.\nusb-out-requested.bin concatenates requested bulk-OUT buffers, including SigmaTel headers. Check bytesWritten/status in events.jsonl for short or failed writes.\nframes.jsonl contains decoded frames, including duplicates and echoes seen by the protocol reader. After a protocol error the page listens passively until the response deadline, without further polls or application commands.\nresponse.bin contains accepted IrCOMM application payloads after the single command, without interpretation. before-command.bin contains unsolicited application data seen before the command. Raw discarded/invalid or unrecognized frames remain in usb-in.bin and events.jsonl.\nA reply is not proof of the command meaning. No reply is not proof the command is unused. A failed/interrupted capture may be incomplete; pendingUSBCalls lists unresolved calls.\n') },
  ];
}
