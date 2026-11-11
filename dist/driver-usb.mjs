import { usbAlternates, usbID } from './driver-catalog.mjs';
import { readDriverAccess, rememberDriverAccess, canTryUSBHelper } from './driver-access.mjs';

export class DriverUSBError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'DriverUSBError'; this.code = code; }
}
const protectedClasses = new Set([1, 3, 8, 11, 14, 16, 224]);
const copy = data => data ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array();
const hex = bytes => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
const unhex = text => Uint8Array.from(text?.match(/../g) ?? [], n => parseInt(n, 16));
const types = ['standard', 'class', 'vendor', 'reserved'], recipients = ['device', 'interface', 'endpoint', 'other'];

// WebUSB descriptor objects have getters, so JSON.stringify(device) loses them.
// Preserve configuration value 0: it is distinct from an absent configuration.
export function usbDescriptorSnapshot(device) {
  const configuration = value => value ? {
    configurationValue: value.configurationValue,
    interfaces: Array.from(value.interfaces ?? [], iface => ({
      interfaceNumber: iface.interfaceNumber,
      claimed: Boolean(iface.claimed),
      alternateSetting: iface.alternate?.alternateSetting ?? null,
      alternates: Array.from(iface.alternates ?? [], alternate => ({
        alternateSetting: alternate.alternateSetting,
        interfaceClass: alternate.interfaceClass,
        interfaceSubclass: alternate.interfaceSubclass,
        interfaceProtocol: alternate.interfaceProtocol,
        endpoints: Array.from(alternate.endpoints ?? [], endpoint => ({
          endpointNumber: endpoint.endpointNumber, direction: endpoint.direction,
          type: endpoint.type, packetSize: endpoint.packetSize,
        })),
      })),
    })),
  } : null;
  return {
    opened: Boolean(device.opened),
    activeConfiguration: configuration(device.configuration),
    configurations: Array.from(device.configurations ?? [], configuration),
  };
}

export function classifyUSBFailure(error, stage = '') {
  if (error instanceof DriverUSBError) return error;
  if (error?.name === 'AbortError' || error?.name === 'NotFoundError') return new DriverUSBError('cancelled', error.message, error);
  if (error?.name === 'NotAllowedError') return new DriverUSBError('permission', 'USB access was not allowed.', error);
  if (stage === 'claim' && error?.name === 'NetworkError') return new DriverUSBError('busy', 'Cannot claim the USB interface. Disconnect it in the other application and try again.', error);
  return new DriverUSBError('usb-error', error?.message || String(error), error);
}
export function classifyDriverOpenFailure(error, backend) {
  return backend.lastError ?? (error?.name === 'Error'
    ? new DriverUSBError('initialization-failed', error.message, error) : classifyUSBFailure(error));
}

export class WebUSBDriverBackend {
  constructor(device, match, { onTransfer = () => {}, onEvent = () => {}, synchronize = null } = {}) {
    this.device = device; this.match = match; this.onTransfer = onTransfer; this.onEvent = onEvent; this.synchronize = synchronize;
    this.claimed = false; this.closing = false; this.reads = new Set(); this.readTasks = new Set(); this.completed = 0; this.lastError = null;
    this.transport = 'direct';
  }
  async open() {
    this.closing = false; this.driverClosing = false;
    try {
      await this.openDevice();
      if (this.closing) { await this.device.close(); throw new DOMException('USB connection cancelled.', 'AbortError'); }
      this.onEvent({ kind: 'usb-descriptors', ...usbDescriptorSnapshot(this.device) });
      const iface = this.match?.interface ?? usbAlternates(this.device)[0];
      if (!iface || iface.configuration == null) throw new DriverUSBError('no-interfaces', 'The operating system does not provide usable USB interfaces for this adapter.');
      if (this.device.configuration?.configurationValue !== iface.configuration) await this.device.selectConfiguration(iface.configuration);
      if (protectedClasses.has(iface.alternate.interfaceClass)) throw new DriverUSBError('helper-needed', 'WebUSB does not allow this USB interface class.');
      this.interfaceNumber = iface.interfaceNumber; this.alternate = iface.alternate;
      try { await this.device.claimInterface(this.interfaceNumber); }
      catch (error) { throw classifyUSBFailure(error, 'claim'); }
      this.claimed = true;
      if (this.closing) { await this.close(); throw new DOMException('USB connection cancelled.', 'AbortError'); }
      if ((this.device.configuration.interfaces.find(i => i.interfaceNumber === this.interfaceNumber)?.alternate?.alternateSetting ?? 0) !== this.alternate.alternateSetting) {
        await this.device.selectAlternateInterface(this.interfaceNumber, this.alternate.alternateSetting);
      }
      this.info = { vendorId: this.device.vendorId, productId: this.device.productId,
        productName: this.device.productName, manufacturerName: this.device.manufacturerName,
        configuration: this.device.configuration, interfaceNumber: this.interfaceNumber,
        alternate: this.alternate, matchIndex: this.match?.index ?? 0 };
      return this.descriptors();
    } catch (error) { this.lastError = classifyUSBFailure(error); await this.close().catch(() => {}); throw this.lastError; }
  }
  descriptors() {
    const { alternate, interfaceNumber, matchIndex } = this.info, endpoints = alternate.endpoints ?? [];
    const input = endpoints.find(e => e.direction === 'in' && e.type !== 'interrupt') ?? endpoints.find(e => e.direction === 'in');
    const output = endpoints.find(e => e.direction === 'out');
    const interrupt = endpoints.find(e => e.direction === 'in' && e.type === 'interrupt');
    return { fields: [this.device.vendorId, this.device.productId, interfaceNumber, alternate.alternateSetting,
      input ? input.endpointNumber | 128 : 0, output?.endpointNumber ?? 0, interrupt ? interrupt.endpointNumber | 128 : 0,
      input?.packetSize ?? 0, output?.packetSize ?? 0, alternate.interfaceClass, alternate.interfaceSubclass,
      alternate.interfaceProtocol, input?.type === 'interrupt' ? 3 : 2, matchIndex],
      description: { name: this.device.productName || this.device.manufacturerName || 'USB device', usbId: usbID(this.device),
        configuration: this.info.configuration.configurationValue, interface: interfaceNumber, interfaceClass: alternate.interfaceClass, transport: this.transport } };
  }
  async openDevice() {
    const pending = this.device.open(); this.opening = pending;
    try { await pending; }
    finally { if (this.opening === pending) this.opening = null; }
  }
  validateControl(request) {
    const recipient = request.type & 31;
    if (recipient === 1) {
      const number = request.index & 255;
      const iface = this.device.configuration?.interfaces.find(iface => iface.interfaceNumber === number);
      if (!iface) throw new DriverUSBError('helper-needed', 'The driver addresses USB interface ' + number + ', which is absent from the device descriptor.');
      if (number !== this.interfaceNumber) throw new DriverUSBError('helper-needed', 'The driver requires an additional USB interface.');
    }
    if (recipient > 3 || types[request.type >> 5 & 3] === 'reserved') throw new DriverUSBError('unsupported-request', 'Unsupported USB control recipient or request type.');
  }
  async control(request, bytes) {
    const input = Boolean(request.type & 128);
    try {
      if (this.cancelTask) await this.cancelTask;
      if (this.closing || !this.claimed) throw new DOMException('USB connection closed.', 'AbortError');
      const transfer = async () => {
        let result;
        if (request.bulk || request.transfer) {
          result = input ? await this.readTransfer(request, () => this.device.transferIn(request.index, request.length)) : await this.device.transferOut(request.index, bytes);
          const endpoint = this.alternate.endpoints.find(endpoint => endpoint.direction === 'out' && endpoint.endpointNumber === request.index);
          if (!input && result.status === 'ok' && result.bytesWritten === bytes.length && request.flags & 0x40 && bytes.length && endpoint?.packetSize && bytes.length % endpoint.packetSize === 0) {
            const zlp = await this.device.transferOut(request.index, new Uint8Array());
            if (zlp.status !== 'ok') throw new DriverUSBError('transfer-failed', 'The USB zero-length packet failed.');
          }
        } else {
          this.validateControl(request);
          const setup = { requestType: types[request.type >> 5 & 3], recipient: recipients[request.type & 31],
            request: request.request, value: request.value, index: request.index };
          result = input ? await this.readTransfer(request, () => this.device.controlTransferIn(setup, request.length)) : await this.device.controlTransferOut(setup, bytes ?? new Uint8Array());
        }
        if (result.status !== 'ok') throw new DriverUSBError('transfer-failed', 'USB transfer returned ' + result.status + '.');
        const answer = input ? { bytes: copy(result.data) } : { written: result.bytesWritten };
        return this.completeTransfer(request, bytes, answer);
      };
      return await transfer();
    } catch (error) {
      if (error?.name === 'AbortError' || this.closing) throw new DOMException('USB request cancelled.', 'AbortError');
      this.lastError = classifyUSBFailure(error); throw this.lastError;
    }
  }
  completeTransfer(request, bytes, answer) {
    const input = Boolean(request.type & 128), expected = bytes?.length ?? 0;
    const short = !input && (!Number.isInteger(answer.written) || answer.written !== expected);
    const validCount = Number.isInteger(answer.written) && answer.written >= 0 && answer.written <= expected;
    let data = input ? answer.bytes : bytes ?? new Uint8Array();
    if (short) data = validCount ? data.slice(0, answer.written) : new Uint8Array();
    this.onTransfer({ request, direction: input ? 'in' : 'out', dataHex: hex(data),
      ...(!input ? { bytesWritten: answer.written, requestedBytes: expected } : {}),
      ...(short ? { status: 'short-write', requestedDataHex: hex(bytes ?? new Uint8Array()) } : {}) });
    if (short) throw new DriverUSBError('short-write', 'Short USB write: ' + answer.written + ' of ' + expected + ' bytes.');
    this.completed++;
    return input && this.synchronize ? this.synchronize(answer) : answer;
  }
  async readTransfer(request, start) {
    const task = { request, cancelled: false, recovery: null }; this.readTasks.add(task);
    try {
      for (;;) {
        if (this.cancelTask) await this.cancelTask;
        if (task.cancelled || this.closing) throw new DOMException('USB read cancelled.', 'AbortError');
        let result, error, pending;
        try { pending = start(); this.reads.add(pending); result = await pending; }
        catch (reason) { error = reason; }
        finally { this.reads.delete(pending); }
        const recovery = task.recovery;
        if (recovery) { await recovery.promise; task.recovery = null; if (recovery.error) throw recovery.error; }
        if (task.cancelled || this.closing) {
          if (result?.data) this.onTransfer({ request, direction: 'in', dataHex: hex(copy(result.data)), status: 'cancelled' });
          throw new DOMException('USB read cancelled.', 'AbortError');
        }
        // A native handle close also aborts other endpoints. Keep their C URBs
        // pending and reissue just the interrupted reads after restoring USB.
        if (recovery && (error || result?.status === 'cancelled')) continue;
        if (error) throw error;
        return result;
      }
    } finally { this.readTasks.delete(task); }
  }
  prepareClose() { this.driverClosing = true; }
  async cancel(request) {
    for (const task of this.readTasks) {
      if (this.driverClosing || !request || task.request === request ||
          request.transferId != null && task.request.transferId === request.transferId) task.cancelled = true;
    }
    if (this.cancelTask) return this.cancelTask;
    if (!this.reads.size || !this.claimed || this.closing) return;
    let resume;
    const recovery = { promise: new Promise(resolve => { resume = resolve; }), error: null };
    for (const task of this.readTasks) task.recovery = recovery;
    this.cancelTask = (async () => {
      this.cancelling = true;
      this.onEvent({ kind: 'usb-cancel-started', pendingReads: this.reads.size,
        strategy: 'close-reopen', transferId: request?.transferId ?? null });
      try {
        // releaseInterface does not abort pending reads on WinUSB. Closing the
        // native handle does; unrelated reads resume on the restored handle.
        await this.device.close();
        this.claimed = false;
        await Promise.allSettled([...this.reads]);
        if (!this.closing) {
          await this.openDevice();
          if (this.closing) { await this.device.close(); return; }
          if (this.device.configuration?.configurationValue !== this.info.configuration.configurationValue) {
            await this.device.selectConfiguration(this.info.configuration.configurationValue);
          }
          if (this.closing) { if (this.device.opened) await this.device.close(); return; }
          await this.device.claimInterface(this.interfaceNumber); this.claimed = true;
          if (this.closing) { await this.device.close(); this.claimed = false; return; }
          if (this.alternate.alternateSetting) await this.device.selectAlternateInterface(this.interfaceNumber, this.alternate.alternateSetting);
        }
        this.onEvent({ kind: 'usb-cancel-complete', reconnected: this.claimed });
      } catch (error) { recovery.error = error; this.lastError = classifyUSBFailure(error); throw error; }
      finally { this.cancelling = false; this.cancelTask = null; resume(); }
    })();
    return this.cancelTask;
  }
  async rpc(method, args = []) {
    if (method === 'clearHalt') return this.device.clearHalt(args[0] & 128 ? 'in' : 'out', args[0] & 15);
    if (method === 'setInterface') return this.device.selectAlternateInterface(args[0], args[1]);
    if (method === 'resetConfiguration') {
      await this.cancel();
      if (this.claimed) { await this.device.releaseInterface(this.interfaceNumber); this.claimed = false; }
      await this.device.reset();
      if (this.device.configuration?.configurationValue !== this.info.configuration.configurationValue) await this.device.selectConfiguration(this.info.configuration.configurationValue);
      await this.device.claimInterface(this.interfaceNumber); this.claimed = true;
      if (this.alternate.alternateSetting) await this.device.selectAlternateInterface(this.interfaceNumber, this.alternate.alternateSetting);
      return;
    }
    throw new Error('Unsupported USB service: ' + method);
  }
  async close() {
    this.closing = true;
    if (this.closeTask) return this.closeTask;
    const bounded = promise => {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new DriverUSBError('close-timeout', 'USB did not close. Disconnect and reconnect the adapter.')), 3000); })]).finally(() => clearTimeout(timer));
    };
    this.closeTask = (async () => {
      try {
        // Abort must also observe a late native open/recovery. Otherwise its
        // failure could arrive after the UI has already announced release.
        let pendingError;
        try {
          if (this.opening) await bounded(this.opening);
          if (this.cancelTask) await bounded(this.cancelTask);
        } catch (error) { pendingError = error; }
        if (this.claimed && this.device.opened) await bounded(this.device.releaseInterface(this.interfaceNumber)).catch(() => {});
        this.claimed = false;
        if (this.device.opened) await bounded(this.device.close());
        if (pendingError) throw pendingError;
      } finally { this.closeTask = null; }
    })();
    return this.closeTask;
  }
}

export class HelperDriverBackend extends WebUSBDriverBackend {
  constructor(device, match, options = {}) { super(device, match, options); this.transport = 'helper'; this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis); this.url = options.url ?? 'http://127.0.0.1:8768/usb'; this.session = null; }
  async call(method, args = []) {
    let response;
    try {
      response = await this.fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args, session: this.session }), cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(3500) });
    } catch (error) { throw new DriverUSBError('helper-unavailable', 'Cannot reach USB Helper. Start it on this computer and try again.', error); }
    const reply = await response.json();
    if (!response.ok || reply.error) throw new DriverUSBError(reply.code || 'helper-error', reply.error || 'USB Helper HTTP ' + response.status);
    return reply.result;
  }
  async open() {
    this.closing = false;
    try {
      const info = await this.call('open', [this.device.vendorId, this.device.productId, this.match?.interface?.interfaceNumber ?? 0]);
      this.session = info.session;
      if (this.closing) { await this.close(); throw new DOMException('USB connection cancelled.', 'AbortError'); }
      if (!this.session || info.vendorId !== this.device.vendorId || info.productId !== this.device.productId) throw new DriverUSBError('helper-error', 'USB Helper opened a different device.');
      this.info = { ...info, matchIndex: this.match?.index ?? 0 };
      this.claimed = true; return this.descriptors();
    } catch (error) { this.lastError = classifyUSBFailure(error); await this.close().catch(() => {}); throw this.lastError; }
  }
  async control(request, bytes) {
    if (!this.session || this.closing) throw new DOMException('USB helper session closed.', 'AbortError');
    try {
      const reply = await this.call('transfer', [{ ...request, dataPointer: undefined, pointer: undefined, actual: undefined }, bytes ? hex(bytes) : null]);
      const input = Boolean(request.type & 128), result = input ? { bytes: unhex(reply.hex) } : { written: reply.written };
      return this.completeTransfer(request, bytes, result);
    } catch (error) { this.lastError = classifyUSBFailure(error); throw this.lastError; }
  }
  async cancel() { /* Native reads have a bounded 100 ms timeout. */ }
  rpc(method, args = []) { return this.call(method, args); }
  async close() {
    this.closing = true;
    try { if (this.session) await this.call('close'); }
    finally { this.session = null; this.claimed = false; }
  }
}

export async function checkInstalledDriver(record, match, device, { method = 'auto', signal, waitForHelper, recordEvent = () => {} } = {}) {
  const { DriverWorkerClient } = await import('./driver-worker-client.mjs');
  const report = { device: { name: device.productName || device.manufacturerName || 'USB device', usbId: usbID(device), descriptors: usbDescriptorSnapshot(device) },
    environment: { userAgent: globalThis.navigator?.userAgent ?? null },
    driver: { id: record.id, filename: record.filename, sha256: record.sha256, inputSHA256: record.inputSHA256, profile: record.profile },
    direct: { status: 'untested' }, helper: { status: 'untested' }, infrared: 'not-tested', events: [] };
  const attempt = async transport => {
    let initializing = false;
    const event = entry => { if (report.events.length < 300) report.events.push(entry); recordEvent(entry); };
    const backend = transport === 'direct' ? new WebUSBDriverBackend(device, match, { onTransfer: event, onEvent: event }) : new HelperDriverBackend(device, match, { onTransfer: event, onEvent: event });
    const client = new DriverWorkerClient(backend, { event });
    event({ kind: 'check-started', transport });
    const abort = () => { void client.abort().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      if (transport === 'helper' && waitForHelper) await waitForHelper({ signal });
      signal?.throwIfAborted();
      await client.load(record.artifact.bytes, record.profile); signal?.throwIfAborted();
      event({ kind: 'usb-opening', transport });
      initializing = true;
      const description = await client.open(); signal?.throwIfAborted();
      if (!backend.completed) throw new DriverUSBError('initialization-failed', 'The driver did not complete any USB request.');
      report[transport] = { status: 'passed', description, completedTransfers: backend.completed };
      event({ kind: 'check-passed', transport });
    } catch (error) {
      const reason = initializing ? classifyDriverOpenFailure(error, backend) : backend.lastError ?? classifyUSBFailure(error);
      const cancelled = signal?.aborted || reason.code === 'cancelled';
      report[transport] = { status: cancelled ? 'cancelled' : reason.code === 'helper-needed' ? 'blocked' : reason.code === 'helper-unavailable' ? 'unavailable' : 'failed', code: reason.code, message: reason.message };
      event({ kind: cancelled ? 'check-cancelled' : 'check-failed', transport, code: reason.code, message: reason.message });
    } finally {
      try { await client.close(); event({ kind: 'usb-released', transport }); }
      catch (error) { report[transport].cleanupError = error.message; report[transport].status = 'failed'; event({ kind: 'check-cleanup-failed', transport, message: error.message }); }
      finally { signal?.removeEventListener('abort', abort); }
    }
    if (signal?.aborted && report[transport].status === 'passed') report[transport].status = 'cancelled';
    if (!signal?.aborted && report[transport].status === 'passed') rememberDriverAccess(record, device, transport);
  };
  const first = method === 'auto' ? readDriverAccess(record, device) === 'helper' ? 'helper' : 'direct' : method;
  report.preferredAccess = first;
  await attempt(first);
  if (!signal?.aborted && method === 'auto' && first === 'direct' && canTryUSBHelper(report.direct) && !report.direct.cleanupError) await attempt('helper');
  report.cancelled = Boolean(signal?.aborted || report.direct.status === 'cancelled' || report.helper.status === 'cancelled'); report.complete = !report.cancelled; return report;
}
