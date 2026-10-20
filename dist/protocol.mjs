// Browser port of wqv_protocol.py, including the flow-control/disconnect fixes
// tested with the actual WQV-3. WQV Blink portions: Roger Braunstein, MIT.
// See third-party-notices.txt. This module has no DOM or native bridge.
import { hex, sleep } from './irda.mjs';
import { LIMIT, b, ascii, text, fromHex as hx, concat, equal, starts, u16, PRIMARY, SECONDARY,
  parseCommand, makeCommand, attribute, packSCEP, unpackSCEP, pduSize, extractUPF,
  jpegFromUPF, jpegInfo, queryResponse, queryCommand, putCommand, sha256, toHex, checkWatchJPEG } from './formats.mjs';
import { CALENDAR_SIZE, HolidayCalendar } from './calendar.mjs';

const random = max => crypto.getRandomValues(new Uint32Array(1))[0] % max;
const stackID = () => crypto.getRandomValues(new Uint8Array(4)).map(v => v & 0x3e);

export class WQVClient {
  constructor(adapter, { signal = null, log = () => {}, progress = () => {} } = {}) {
    this.adapter = adapter; this.signal = signal; this.log = log; this.progress = progress;
    this.ourPort = 0xff; this.watchPort = 0xfe; this.upper = 1; this.lower = 0; this.session = 0;
    this.lastSent = null; this.lastIFrame = null; this.lastRX = 0;
    this.connected = false; this.isPrimary = true; this.turnIsOurs = true;
    this.txCredits = 1; this.rxCredits = 14; this.appBuffer = new Uint8Array();
    this.primaryID = PRIMARY; this.secondaryID = SECONDARY; this.model = null; this.peerID = null;
  }
  check() { this.signal?.throwIfAborted(); this.adapter.assertOpen(); }
  seq({ data = false, upper = false, lower = false } = {}) {
    this.upper = (this.upper + 2 * +upper) & 15; this.lower = (this.lower + 2 * +lower) & 15;
    return (this.upper << 4) | (data ? this.lower : 1);
  }
  packet(direction, frame) { this.log(direction, `${hex([frame.address, frame.control])} [${frame.data.length}] ${hex(frame.data)}`); }
  async send(data = new Uint8Array(), control = null, address = null, bof = 11) {
    this.check();
    control ??= this.seq(); address ??= this.ourPort;
    const gap = 5 - (performance.now() - this.lastRX);
    if (gap > 0) await sleep(gap);
    this.lastSent = { address, control, data }; this.turnIsOurs = false;
    this.packet('tx-frame', this.lastSent);
    await this.adapter.sendFrame(address, control, data, bof);
  }
  async read(timeout = 2000, optional = false) {
    let deadline = performance.now() + timeout, retries = 0;
    while (true) {
      this.check();
      if (performance.now() >= deadline) {
        if (optional) return null;
        if (retries >= 2 || !this.connected || !this.lastSent) throw new Error(`Часы не ответили. Проверь IR → ПК и направление ИК-окон (ошибок CRC: ${this.adapter.decoder.badCRC}).`);
        if (this.isPrimary) {
          const { address, control, data } = this.lastSent;
          await this.send(data, control, address);
        }
        retries++; deadline = performance.now() + timeout;
      }
      const frame = await this.adapter.receiveFrame(Math.max(1, Math.min(150, deadline - performance.now())));
      if (!frame) continue;
      this.packet('rx-frame', frame);
      if (this.lastSent && frame.address === this.lastSent.address && frame.control === this.lastSent.control && equal(frame.data, this.lastSent.data)) continue;
      this.lastRX = performance.now(); this.turnIsOurs = Boolean(frame.control & 0x10);
      if (!(frame.control & 1) && frame.data.length) {
        const identity = `${frame.address}/${frame.control & 14}/${toHex(frame.data)}`;
        if (identity === this.lastIFrame) { await this.send(); continue; }
        this.lastIFrame = identity;
      }
      return frame;
    }
  }
  expect(frame, { prefix, exact, ack = false } = {}) {
    if (!frame) throw new Error('Нет ожидаемого ответа часов.');
    if (frame.address !== this.watchPort) throw new Error(`Пакет от другого IrDA-устройства: ${frame.address.toString(16)}.`);
    if (ack && ((frame.control & 15) !== 1 || frame.data.length)) throw new Error('Ожидалось подтверждение IrLAP.');
    if (prefix && !starts(frame.data, prefix)) throw new Error(`Неверный ответ: ${hex(frame.data.slice(0, 40))}; ожидался ${hex(prefix)}.`);
    if (exact && !equal(frame.data, exact)) throw new Error(`Неверный ответ: ${hex(frame.data.slice(0, 40))}; ожидался ${hex(exact)}.`);
    return frame.data;
  }
  async dataFrame(timeout = 12000) {
    const deadline = performance.now() + timeout; let retries = 0;
    while (performance.now() < deadline && retries < 10) {
      const frame = await this.read(Math.min(1000, deadline - performance.now()), true);
      if (!frame) { if (this.isPrimary) await this.send(); retries++; continue; }
      if (frame.address !== this.watchPort) continue;
      if (frame.control === 0x53) throw new Error('Часы завершили соединение.');
      if (frame.data.length) return frame;
      if ((frame.control & 15) === 1) await this.send();
    }
    throw new Error('Часы перестали передавать данные.');
  }
  async openPrimary(timeout = 15000) {
    await this.adapter.setupSIR();
    const source = stackID(), deadline = performance.now() + timeout;
    let response = null;
    this.progress('Поиск часов', 'Включи на часах IR → ПК.');
    while (performance.now() < deadline && !response) {
      for (let slot = 0; slot < 6; slot++) {
        this.check();
        await this.send(concat(b(1), source, b(255, 255, 255, 255, 1, slot, 0)), 0x3f, 0xff);
        const frame = await this.read(150, true);
        if (frame?.address === 0xfe && frame.control === 0xbf && frame.data.length >= 31 && equal(frame.data.slice(5, 9), source) && /^CASIO WIC 241[12]\/IR$/.test(text(frame.data.slice(15)))) {
          response = frame.data; break;
        }
        if (performance.now() >= deadline) break;
      }
    }
    if (!response) throw new Error('WQV-3 не найдены. Включи IR → ПК и направь часы на адаптер.');
    this.peerID = response.slice(1, 5); this.model = text(response).includes('2411/IR') ? 3 : 10;
    this.progress('Соединение с часами', `Casio WQV-${this.model}, IrLAP / IrCOMM`);
    this.watchPort = 2 * (random(0x7e) + 1); this.ourPort = this.watchPort + 1;
    const parameters = hx('01010282010183013f84010f85018086028003080107');
    await this.send(concat(source, this.peerID, b(this.watchPort), parameters), 0x93, 0xff);
    const accepted = await this.read();
    if (accepted.address !== this.watchPort || accepted.control !== 0x73 || !starts(accepted.data, concat(this.peerID, source))) throw new Error('Часы не приняли параметры соединения IrLAP.');
    this.connected = true; this.upper = 1; this.lower = 0;
    await this.send(hx('80030100'), this.seq({ data: true }));
    this.expect(await this.dataFrame(), { exact: hx('83008100') });
    await this.send(hx('80030201'), this.seq({ data: true, upper: true, lower: true }));
    this.expect(await this.read(), { ack: true });
    this.session = random(11) + 4;
    await this.send(b(0x83, this.session, 1, 0, 14), this.seq({ data: true, lower: true }));
    this.expect(await this.dataFrame(), { prefix: b(0x80 | this.session, 3) });
    await this.send(new Uint8Array(), this.seq({ upper: true }));
    await this.read(2000, true);
    this.log('ok', `Сеанс Casio WQV-${this.model} открыт.`);
  }
  async closeLink() {
    await this.send(b(0x83, this.session, 2, 1), this.seq({ data: true, lower: true }));
    await this.read(2000, true);
    await this.send(new Uint8Array(), this.seq({ lower: true })); await this.read(2000, true);
    await this.send(new Uint8Array(), 0x53); await this.read(2000, true); this.connected = false;
  }
  async switchToReceive(command = 1) {
    await this.send(concat(b(3, this.session, 0, 0, command), this.model === 10 ? b(0, 0) : b()), this.seq({ data: true, lower: true }));
    this.expect(await this.dataFrame(), { prefix: b(this.session, 3) });
    await this.send(b(), this.seq({ upper: true }));
    this.expect(await this.dataFrame(), { prefix: b(this.session, 3, 0, 0, 0x0d) });
    await this.send(b(), this.seq({ upper: true })); await this.read(); await this.closeLink();
    this.isPrimary = false; this.ourPort = 0xfe; this.watchPort = 0xff;
    this.upper = 1; this.lower = 0; this.lastIFrame = null;
    let frame = await this.read(5000);
    if (frame.control !== 0x3f || !starts(frame.data, concat(b(1), this.peerID))) throw new Error('Нет запроса от часов после смены ролей.');
    const localID = stackID();
    await this.send(concat(b(1), localID, this.peerID, hx('010500842500'), ascii('WEB-WQV\0')), 0xbf);
    while (true) {
      frame = await this.read();
      if (starts(frame.data, concat(b(1), this.peerID, hx('ffffffff01ff')))) break;
    }
    frame = await this.read();
    if (frame.control !== 0x93 || !starts(frame.data, this.peerID)) throw new Error('Нет параметров соединения от часов.');
    this.ourPort = frame.data[8]; this.watchPort = this.ourPort + 1;
    await this.send(concat(localID, this.peerID, hx('01010282010183013f84010f85018086028003080104')), 0x73);
    this.connected = true; this.rxCredits = 14;
    this.expect(await this.dataFrame(), { prefix: hx('80010100') });
    await this.send(hx('81008100'), this.seq({ data: true, upper: true }));
    let negotiation = 0, ready = false;
    for (let i = 0; i < 20; i++) {
      frame = await this.read(); const data = frame.data;
      if (data.length === 5 && data[0] > 0x80 && data[0] <= 0x8f) {
        this.session = data[0] & 15;
        await this.send(b(0x83, this.session, 0x81, 0, 14), this.seq({ data: true, upper: true, lower: true })); ready = true; break;
      }
      if (starts(data, hx('000184'))) {
        const replies = [hx('01008400000100050100000009'), hx('0100840000010005020006000106010101')];
        if (negotiation >= replies.length) throw new Error('Неожиданный дополнительный запрос IAS.');
        await this.send(replies[negotiation++], this.seq({ data: true, upper: true, lower: true }));
      } else if ((frame.control & 15) === 1) await this.send();
      else throw new Error(`Неверный пакет согласования IrCOMM: ${hex(data)}.`);
    }
    if (!ready) throw new Error('Не удалось установить соединение IrCOMM.');
    for (const prefix of [b(this.session, 3, 0, 3), b(this.session, 3, 0, 12)]) {
      // The watch can poll with an empty RR before its service parameters.
      this.expect(await this.dataFrame(), { prefix }); this.rxCredits--;
      await this.send(b(), this.seq({ upper: true }));
    }
  }
  async disconnect() {
    try {
      await this.send(b(), 0x53);
      const frame = await this.read(1000, true);
      if (frame?.control === 0x53) await this.send(b(), 0x73);
    } finally { this.connected = false; }
  }
  async close() {
    const previous = this.signal; this.signal = null;
    try {
      if (this.connected && this.adapter.opened) {
        if (!this.isPrimary && !this.turnIsOurs) await this.read(500, true);
        if (this.isPrimary || this.turnIsOurs) await this.disconnect();
      }
    } catch (error) { this.log('info', `Завершение сеанса: ${error.message}`); }
    finally {
      this.connected = false; this.signal = previous;
      if (this.adapter.opened) await this.adapter.pauseReader();
    }
  }
  async receiveSCEPFile(frame) {
    let stream = b(), position = 0; const packets = [];
    while (true) {
      const data = this.expect(frame, { prefix: b(this.session, 3) });
      if (data.length < 3) throw new Error('Обрезанный пакет TinyTP.');
      if (data.length > 3) {
        this.rxCredits--; const controls = data[3];
        if (data.length < 4 + controls) throw new Error('Обрезанные управляющие байты IrCOMM.');
        const payload = data.slice(4 + controls); packets.push(payload); stream = concat(stream, payload);
        this.progress('Приём снимка', `${stream.length} байт получено`, null);
      }
      if (stream.length > LIMIT) throw new Error('Снимок превышает лимит размера.');
      let complete = false;
      while (position < stream.length) {
        const view = stream.subarray(position), size = pduSize(view);
        if (size === null || view.length < size) break;
        const offset = view[3] === 255 ? 6 : 4;
        complete = Boolean(view[offset + 1] & 0x80); position += size;
        if (complete) { if (position !== stream.length) throw new Error('Лишние данные после снимка.'); break; }
      }
      if (this.rxCredits <= 6) {
        await this.send(b(3, this.session, 6), this.seq({ data: true, upper: true, lower: true })); this.rxCredits += 6;
      } else await this.send(b(), this.seq({ upper: true }));
      if (complete) return { packets, command: unpackSCEP(stream) };
      frame = await this.dataFrame();
    }
  }
  async receiveCollection({ maxImages = 0, onImage = async () => {} } = {}) {
    await this.read(); await this.send();
    this.expect(await this.dataFrame(), { prefix: b(this.session, 3, 0, 0, 0, 0x10) });
    this.rxCredits--; await this.send(b(), this.seq({ upper: true })); this.expect(await this.read(), { ack: true });
    const ident = hx('03000000001101301004080074030000000008007403100000001166723a310d0a69643a4c494e4b20515732343131202020202020200d0a');
    ident[1] = this.session;
    await this.send(ident, this.seq({ data: true, lower: true }));
    this.expect(await this.dataFrame(), { exact: b(this.session, 3, 1) });
    await this.send(b(), this.seq({ upper: true }));
    for (const command of ['RIMG', 'RINF', 'RCMD']) {
      const data = this.expect(await this.dataFrame(), { prefix: b(this.session, 3, 0, 0) }); this.rxCredits--;
      if (text(data.slice(-4)) !== command) throw new Error('Неверная последовательность запросов характеристик.');
      await this.send(queryResponse(data), this.seq({ data: true, upper: true, lower: true }));
      this.expect(await this.dataFrame(), { exact: b(this.session, 3, 1) });
      await this.send(b(), this.seq({ upper: true }));
    }
    const images = [];
    while (true) {
      const frame = await this.dataFrame();
      const data = this.expect(frame, { prefix: b(this.session, 3, 0, 0, 0) });
      if (starts(data, b(this.session, 3, 0, 0, 0, 0x30))) { await this.disconnect(); break; }
      if (!starts(data, b(this.session, 3, 0, 0, 0, 0x20))) throw new Error('Неожиданный пакет передачи снимка.');
      this.progress(`Приём снимка ${images.length + 1}`, 'Не двигай часы и адаптер.');
      const { packets, command } = await this.receiveSCEPFile(frame), fields = parseCommand(command);
      const nameBytes = fields.attributes.FIL0 || ascii('WQV.UPF');
      const filename = text(nameBytes).replace(/[\0 ]+$/g, ''), upf = extractUPF(command), jpeg = jpegFromUPF(upf);
      const info = jpegInfo(jpeg), digest = await sha256(jpeg);
      const archive = { format: 'casio-wqv-transfer-v1', model: this.model, filename,
        jpeg_sha256: digest, dimensions: [info.width, info.height], packets: packets.map(toHex) };
      const image = { id: digest, name: filename.replace(/\.UPF$/i, ''), jpeg, upf, archive,
        width: info.width, height: info.height, receivedAt: new Date().toISOString() };
      await onImage(image); images.push(image);
      this.log('ok', `Снимок ${images.length}: ${filename}, ${info.width}×${info.height}, ${jpeg.length} байт.`);
      const reply = makeCommand([attribute('RPL0', nameBytes, true)], { id: fields.id, reply: 0x40, destination: fields.source, source: fields.destination });
      this.expect(await this.read(), { ack: true });
      await this.send(concat(b(3, this.session, 0, 0), packSCEP(reply)[0]), this.seq({ data: true, lower: true }));
      this.expect(await this.dataFrame(), { exact: b(this.session, 3, 1) });
      if (maxImages && images.length >= maxImages) { await this.disconnect(); break; }
      await this.send(b(), this.seq({ upper: true }));
    }
    return images;
  }
  async download({ current = false, ...options } = {}) {
    if (!this.connected) await this.openPrimary();
    await this.switchToReceive(current ? 0 : 1);
    return this.receiveCollection(options);
  }
  primaryIngest(frame) {
    if (frame.address !== this.watchPort) throw new Error('Пакет от другого соединения IrDA.');
    if ([0x53, 0x1f].includes(frame.control)) throw new Error('Часы завершили соединение.');
    if (!(frame.control & 1)) {
      const sequence = (frame.control >> 1) & 7;
      if (sequence !== this.upper >> 1) throw new Error('Нарушена последовательность IrLAP.');
      this.upper = 2 * ((sequence + 1) & 7) + 1;
      const data = frame.data;
      if (starts(data, b(this.session, 3)) && data.length >= 3) {
        this.txCredits += data[2] & 0x7f;
        if (data.length > 3) {
          this.rxCredits--; const controls = data[3];
          if (4 + controls > data.length) throw new Error('Обрезанные параметры IrCOMM.');
          this.appBuffer = concat(this.appBuffer, data.slice(4 + controls));
          if (this.appBuffer.length > LIMIT) throw new Error('Слишком большой поток IrCOMM.');
        }
      } else if (data.length) throw new Error(`Неожиданные данные сервиса IrLMP: ${hex(data)}.`);
      return true;
    }
    return false;
  }
  async primaryExchange(payload = null) {
    if (payload !== null) await this.send(payload, this.seq({ data: true, lower: true }));
    else await this.send();
    for (let i = 0; i < 32; i++) {
      const frame = await this.read();
      if (this.primaryIngest(frame)) await this.send(); // ACK before using the service reply.
      else {
        const expected = ((this.lower >> 1) + 1) & 7;
        if ((frame.control & 15) === 1 && (frame.control >> 5) === expected) return;
        throw new Error('Часы не подтвердили отправленный кадр.');
      }
    }
    throw new Error('Слишком много кадров IrLAP без подтверждения.');
  }
  async primarySend(application = b(), controls = b()) {
    for (let i = 0; i < 12 && !this.txCredits; i++) await this.primaryExchange();
    if (!this.txCredits) throw new Error('Часы не выдают разрешения на передачу TinyTP.');
    this.txCredits--; const grant = this.rxCredits <= 6 ? 6 : 0; this.rxCredits += grant;
    await this.primaryExchange(concat(b(3, this.session, grant, controls.length), controls, application));
  }
  async primarySCEP() {
    for (let i = 0; i < 64; i++) {
      const stream = this.appBuffer; let length = null;
      if (stream.length >= 4) {
        if (starts(stream, b(0, 0x11)) || starts(stream, b(0, 0x30))) length = 4 + stream[3];
        else if (starts(stream, b(0, 0x20, 3))) length = stream[3] === 255 ? (stream.length >= 6 ? 6 + u16(stream, 4) : null) : 4 + stream[3];
        else throw new Error(`Неверное начало потока SCEP: ${hex(stream.slice(0, 32))}.`);
        if (length !== null && stream.length >= length) {
          const packet = stream.slice(0, length); this.appBuffer = stream.slice(length); return packet;
        }
      }
      await this.primaryExchange();
    }
    throw new Error('Не получен полный ответ SCEP.');
  }
  async openSender() {
    if (!this.connected) await this.openPrimary();
    await this.primarySend(b(), hx('000104'));
    await this.primarySend(b(), hx('10040000258011010320010c'));
    const info = concat(hx('1004'), this.primaryID, new Uint8Array(8), ascii('\x11fr:1\r\nid:WEB WQV\r\n'));
    await this.primarySend(concat(hx('0010000101'), b(info.length), info, hx('10020000')));
    const response = await this.primarySCEP();
    if (!starts(response, hx('001101')) || response.length < 22) throw new Error('Часы отклонили соединение IrTran-P.');
    this.primaryID = response.slice(6, 14); this.secondaryID = response.slice(14, 22);
  }
  async senderCommand(command) {
    const request = parseCommand(command), pdus = packSCEP(command); let sent = 0;
    const total = pdus.reduce((n, p) => n + p.length, 0);
    for (const pdu of pdus) for (let pos = 0; pos < pdu.length; pos += 380) {
      const part = pdu.slice(pos, pos + 380); await this.primarySend(part); sent += part.length;
      this.progress('Передача на часы', `${sent} / ${total} байт`, sent / total);
    }
    const parts = [];
    while (true) {
      const packet = await this.primarySCEP();
      if (!starts(packet, b(0, 0x20, 3))) throw new Error('Ожидался ответ на команду IrTran-P.');
      parts.push(packet); const offset = packet[3] === 255 ? 6 : 4;
      if (packet[offset + 1] & 0x80) {
        const response = parseCommand(unpackSCEP(concat(...parts)));
        if (response.id !== request.id || ![0x40, 0x80].includes(response.reply)) throw new Error('Не совпал идентификатор ответа IrTran-P.');
        return response;
      }
      if (parts.length > 4096) throw new Error('Слишком длинный ответ IrTran-P.');
    }
  }
  async capabilities() {
    await this.openSender(); const capabilities = {};
    for (const [i, name] of ['RIMG', 'RINF', 'RCMD'].entries()) {
      const response = await this.senderCommand(queryCommand(name, 0x80 + i));
      capabilities[name] = Object.fromEntries(Object.entries(response.attributes).map(([k, v]) => [k, toHex(v)]));
    }
    await this.primarySend(hx('0030200100')); await this.disconnect(); return capabilities;
  }
  async upload(upf, filename) {
    checkWatchJPEG(jpegFromUPF(upf));
    await this.openSender();
    const response = await this.senderCommand(putCommand(upf, filename, { destination: this.secondaryID, source: this.primaryID }));
    if (response.reply !== 0x40 || !response.attributes.RPL0) throw new Error('Часы отклонили изображение.');
    await this.primarySend(hx('0030200100')); await this.disconnect(); return text(response.attributes.RPL0).replace(/\0+$/, '');
  }
  async control(command) {
    if (!this.connected) await this.openPrimary();
    if (!this.isPrimary) throw new Error('Для управления нужен новый сеанс с часами.');
    if (!command.length || ![2, 3, 4, 5, 6, 7, 8, 9].includes(command[0])) throw new Error('Неизвестная команда управления.');
    if (this.appBuffer.length) throw new Error('В предыдущем ответе остались данные. Подключись к часам снова.');
    for (let pos = 0; pos < command.length; pos += 380) {
      await this.primarySend(command.slice(pos, pos + 380));
      if (command.length > 380) this.progress('Запись календаря', `${Math.min(pos + 380, command.length)} / ${command.length} байт`, Math.min(pos + 380, command.length) / command.length);
    }
    const needed = command[0] === 9 ? CALENDAR_SIZE + 3 : 1, deadline = performance.now() + 15000;
    while (this.appBuffer.length < needed && performance.now() < deadline) await this.primaryExchange();
    if (this.appBuffer.length < needed) throw new Error('Не получен полный ответ на команду управления.');
    const reply = this.appBuffer; this.appBuffer = b();
    this.log('control', `Команда ${command[0].toString(16).padStart(2, '0')}, ответ ${reply.length} байт: ${hex(reply.slice(0, 20))}`);
    if (command[0] === 9) {
      if (reply.length !== CALENDAR_SIZE + 3 || u16(reply, 1) !== CALENDAR_SIZE) throw new Error(`Неверный размер календаря: ${hex(reply.slice(0, 6))}.`);
      return new HolidayCalendar(reply.slice(3));
    }
    if (reply[0] !== 0x0d) throw new Error(`Часы не подтвердили команду: ${hex(reply)}.`);
    return reply;
  }
  async fastScroll(direction, { duration = 1000, stop = () => false } = {}) {
    if (!['forward', 'back'].includes(direction)) throw new Error('Неверное направление листания.');
    await this.control(b(direction === 'forward' ? 4 : 5));
    const deadline = performance.now() + Math.min(3000, Math.max(100, duration));
    try {
      while (performance.now() < deadline && !stop()) { await this.primaryExchange(); await sleep(20); }
    } finally {
      if (this.connected && this.adapter.opened) await this.control(b(6));
    }
  }
}
