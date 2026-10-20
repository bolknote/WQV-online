// STIr4200 register sequence / USB framing from the tested native utility.
// Reference: Linux v4.16 drivers/staging/irda/drivers/stir4200.c.
import { FrameDecoder, encodeFrame, hex, sleep } from './irda.mjs';

export const VID = 0x066f, PID = 0x4200;

export function withTimeout(promise, ms, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Тайм-аут: ${operation}. Отключи соединение и подключись снова.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class SigmaTel {
  constructor(device, { log = () => {}, update = () => {}, rawLog = false } = {}) {
    if (device.vendorId !== VID || device.productId !== PID) throw new Error('Нужен SigmaTel STIr4200 (066f:4200).');
    this.device = device; this.log = log; this.update = update;
    this.rawLog = rawLog;
    this.decoder = new FrameDecoder(); this.rxBytes = 0; this.txFrames = 0; this.switches = 0;
    this.claimed = false; this.configured = false; this.closing = false;
    this.readerTask = null; this.readerActive = false; this.readPending = false; this.readError = null;
  }
  get opened() { return this.device.opened && this.claimed && !this.closing; }
  assertOpen() { if (!this.opened) throw new DOMException('Соединение с адаптером закрыто.', 'AbortError'); }
  async io(promise, operation, ms = 3000) {
    try { return await withTimeout(promise, ms, operation); }
    catch (error) { this.log('error', `${operation}: ${error.message}`); throw error; }
  }
  async open() {
    await this.io(this.device.open(), 'открытие USB');
    if (this.closing) {
      await this.device.close();
      throw new DOMException('Подключение остановлено.', 'AbortError');
    }
    if (this.device.configuration?.configurationValue !== 1) {
      await this.io(this.device.selectConfiguration(1), 'выбор конфигурации 1');
    }
    const iface = this.device.configuration.interfaces.find(i => i.interfaceNumber === 0);
    const alternate = iface?.alternates.find(a => a.alternateSetting === 0);
    const input = alternate?.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
    const output = alternate?.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (!input || !output) throw new Error('У интерфейса 0 не найдены ожидаемые bulk-каналы.');
    this.inEndpoint = input.endpointNumber; this.outEndpoint = output.endpointNumber;
    await this.io(this.device.claimInterface(0), 'захват USB-интерфейса 0');
    if (this.closing) {
      await this.device.close();
      throw new DOMException('Подключение остановлено.', 'AbortError');
    }
    this.claimed = true;
    this.log('ok', `Интерфейс 0 открыт: OUT ${this.outEndpoint}, IN ${this.inEndpoint}.`);
    this.description = {
      name: this.device.productName?.trim() || this.device.manufacturerName?.trim() || 'USB-устройство',
      usbId: this.device.vendorId.toString(16).padStart(4, '0') + ':' + this.device.productId.toString(16).padStart(4, '0'),
      configuration: 1, interface: 0, interfaceClass: alternate.interfaceClass,
      inEndpoint: this.inEndpoint, outEndpoint: this.outEndpoint, packetSize: input.packetSize,
    };
    await this.registers();
    return this.description;
  }
  async registers(start = 1, count = 9, quiet = false) {
    this.assertOpen();
    const result = await this.io(this.device.controlTransferIn({
      requestType: 'vendor', recipient: 'device', request: 1, value: 0, index: start,
    }, count), 'чтение регистров SigmaTel');
    if (result.status !== 'ok' || !result.data || result.data.byteLength !== count) {
      throw new Error(`Неполный ответ регистров: ${result.status}, ${result.data?.byteLength ?? 0}/${count} байт.`);
    }
    const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
    if (!quiet) this.log('info', `Регистры ${start}–${start + count - 1}: ${hex(bytes)}`);
    return bytes;
  }
  async writeRegister(index, value) {
    this.assertOpen();
    const result = await this.io(this.device.controlTransferOut({
      requestType: 'vendor', recipient: 'device', request: 3, value, index,
    }), `запись регистра ${index}`);
    if (result.status !== 'ok') throw new Error(`Регистр ${index}: ${result.status}.`);
  }
  async setupSIR() {
    this.assertOpen();
    if (this.configured) return;
    await this.pauseReader();
    for (const [direction, endpoint] of [['out', this.outEndpoint], ['in', this.inEndpoint]]) {
      await this.io(this.device.clearHalt(direction, endpoint), `очистка USB-канала ${direction}`);
    }
    for (const [index, value] of [[1, 0x20], [3, 1], [8, 0x15], [2, 0x77], [1, 0x2a],
      [3, 0x80], [3, 0], [4, 0x20], [5, 8], [5, 0]]) await this.writeRegister(index, value);
    this.configured = true;
    this.log('ok', 'ИК-порт настроен: SIR, 9600 бит/с.');
    await this.registers();
  }
  startReader() {
    this.assertOpen();
    if (this.readerTask) throw new Error('Предыдущее USB-чтение ещё не остановлено.');
    if (this.readError) throw this.readError;
    this.readerActive = true;
    this.readerTask = (async () => {
      try {
        while (this.readerActive && this.opened) {
          this.readPending = true;
          let result;
          try { result = await this.device.transferIn(this.inEndpoint, 64); }
          finally { this.readPending = false; }
          if (result.data?.byteLength) {
            const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength).slice();
            this.rxBytes += data.length; this.decoder.feed(data);
            if (this.rawLog) this.log('usb-rx', `${data.length} байт: ${hex(data)}`);
            this.update();
          }
          if (result.status !== 'ok') throw new Error(`USB IN: ${result.status}.`);
        }
      } catch (error) {
        // releaseInterface/close explicitly abort the pending endpoint request.
        if (this.readerActive && !this.closing) {
          this.readError = error; this.log('error', `Приём USB: ${error.message}`);
        }
      } finally { this.readerActive = false; this.readPending = false; }
    })();
  }
  async pauseReader() {
    const task = this.readerTask;
    if (!task) return;
    this.readerActive = false;
    if (this.readPending && this.device.opened && this.claimed && !this.closing) {
      const start = performance.now();
      // WebUSB has no cancelTransfer. Release aborts all transfers on this
      // interface; claiming it again does not perform a USB device reset.
      await this.io(this.device.releaseInterface(0), 'остановка ожидающего USB-чтения');
      this.claimed = false;
      await this.io(task, 'завершение USB-чтения');
      if (this.closing) return;
      await this.io(this.device.claimInterface(0), 'повторный захват USB-интерфейса');
      this.claimed = true; this.switches++;
      this.log('switch', `Приём остановлен через release/claim за ${(performance.now() - start).toFixed(1)} мс.`);
      this.update();
    } else await this.io(task, 'завершение USB-чтения');
    this.readerTask = null;
    if (this.readError) throw this.readError;
  }
  async testTurnaround(signal) {
    await this.setupSIR();
    for (let round = 0; round < 2; round++) {
      signal?.throwIfAborted();
      this.startReader();
      await sleep(100);
      signal?.throwIfAborted();
      await this.pauseReader();
      await this.registers();
      this.log('ok', `Цикл приёма ${round + 1}/2 завершён; адаптер отвечает после остановки чтения.`);
    }
  }
  async sendFrame(address, control, data, bof = 11) {
    this.assertOpen();
    await this.pauseReader();
    this.assertOpen();
    const wire = encodeFrame(address, control, data, bof);
    if (wire.length + 4 >= 4096) throw new Error('Пакет превышает размер FIFO SigmaTel.');
    const packet = Uint8Array.of(0x55, 0xaa, wire.length & 255, wire.length >>> 8, ...wire);
    const result = await this.io(this.device.transferOut(this.outEndpoint, packet), 'отправка USB-пакета');
    if (result.status !== 'ok' || result.bytesWritten !== packet.length) {
      throw new Error(`USB OUT: ${result.status}, ${result.bytesWritten}/${packet.length} байт.`);
    }
    this.txFrames++; this.update();
    this.log('tx', `IrDA ${hex([address, control])} · ${hex(data)}`);
    const deadline = performance.now() + wire.length * 10000 / 9600 + 1000;
    while (performance.now() < deadline) {
      const [status] = await this.registers(5, 3, true);
      if (!(status & 0x10) || (status & 4)) { this.startReader(); return; }
      await sleep(2);
    }
    throw new Error('Передающий FIFO SigmaTel не освободился.');
  }
  async receiveFrame(timeout = 100) {
    this.assertOpen();
    let deadline = performance.now() + timeout, previous = this.rxBytes;
    const limit = performance.now() + Math.max(timeout, 1000);
    while (true) {
      if (this.readError) throw this.readError;
      if (this.decoder.frames.length) return this.decoder.frames.shift();
      if (performance.now() >= deadline) return null;
      if (previous !== this.rxBytes && this.decoder.body !== null) {
        deadline = Math.min(limit, Math.max(deadline, performance.now() + 50));
      }
      previous = this.rxBytes;
      await sleep(2); this.assertOpen();
    }
  }
  async close() {
    if (this.closeTask) return this.closeTask;
    this.closing = true; this.readerActive = false; this.configured = false;
    this.closeTask = (async () => {
      try {
        if (this.device.opened) await this.io(this.device.close(), 'закрытие USB', 4000);
      } finally { this.claimed = false; this.update(); }
    })();
    return this.closeTask;
  }
}
