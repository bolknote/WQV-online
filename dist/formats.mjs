// IrTran-P SCEP/bFTP and UPF. Port of the tested wqv_formats.py.
export const LIMIT = 2 * 1024 * 1024;
export const b = (...values) => Uint8Array.of(...values);
export const ascii = text => {
  if (!/^[\x00-\x7f]*$/.test(text)) throw new Error('Ожидалась строка ASCII.');
  return Uint8Array.from(text, ch => ch.charCodeAt(0));
};
export const text = value => new TextDecoder('ascii').decode(value);
export function concat(...arrays) {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}
export const equal = (a, c) => a.length === c.length && a.every((v, i) => v === c[i]);
export const starts = (a, c) => a.length >= c.length && c.every((v, i) => v === a[i]);
export function fromHex(value) {
  if (typeof value !== 'string' || !/^(?:[\da-fA-F]{2}\s*)*$/.test(value)) throw new Error('Повреждённая шестнадцатеричная запись.');
  const clean = value.replace(/\s/g, '');
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}
export const toHex = value => Array.from(value, v => v.toString(16).padStart(2, '0')).join('');
export const u16 = (a, p = 0) => (a[p] << 8) | a[p + 1];
export const u32 = (a, p = 0) => new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(p);
export const be16 = v => b((v >>> 8) & 255, v & 255);
export const be32 = v => b((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
export const PRIMARY = fromHex('0800740300000000'), SECONDARY = fromHex('0800740310000000');
export const sha256 = async data => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));

export function attribute(name, value, isText = false) {
  if (name.length !== 4) throw new Error('Неверное имя атрибута IrTran-P.');
  return concat(ascii(name), be32(value.length + 2), b(+isText, 0), value);
}
export function makeCommand(attributes, { id = 0x80, reply = 0, destination = SECONDARY, source = PRIMARY } = {}) {
  const tail = concat(destination, source, be16(8), be16(8), be16(id), be16(attributes.length), ...attributes);
  return concat(b(0x58, reply), be32(tail.length), tail);
}
export function parseCommand(body) {
  if (body.length < 30 || body[0] !== 0x58 || u32(body, 2) + 6 !== body.length) throw new Error('Неверная длина команды SCEP.');
  const fields = { reply: body[1], destination: body.slice(6, 14), source: body.slice(14, 22), id: u16(body, 26), attributes: Object.create(null) };
  let position = 30;
  for (let i = 0; i < u16(body, 28); i++) {
    if (position + 10 > body.length) throw new Error('Обрезанный атрибут bFTP.');
    const name = text(body.slice(position, position + 4)), length = u32(body, position + 4);
    const end = position + 8 + length;
    if (length < 2 || end > body.length || Object.hasOwn(fields.attributes, name)) throw new Error('Неверный атрибут bFTP.');
    fields.attributes[name] = body.slice(position + 10, end); position = end;
  }
  if (position !== body.length) throw new Error('Лишние данные после команды bFTP.');
  return fields;
}
export function packSCEP(command, maxPDU = 512) {
  if (maxPDU < 64 || maxPDU > 4096 || command.length > LIMIT) throw new Error('Слишком большая команда SCEP.');
  const wrap = value => concat(b(0, 0x20, 3, 255), be16(value.length), value);
  if (command.length + 10 <= maxPDU) return [wrap(concat(b(0x10, 0xc1), be16(command.length), command))];
  const capacity = maxPDU - 18, count = Math.ceil(command.length / capacity), packets = [];
  for (let n = 0; n < count; n++) {
    const chunk = command.slice(n * capacity, (n + 1) * capacity);
    const flag = n === 0 ? 0x41 : n === count - 1 ? 0x81 : 1;
    packets.push(wrap(concat(b(0x10, flag), be16(chunk.length), be32(n), be32(count - n), chunk)));
  }
  return packets;
}
export function pduSize(stream) {
  if (stream.length < 4) return null;
  if (!starts(stream, b(0, 0x20, 3))) throw new Error('Отсутствует заголовок SCEP.');
  if (stream[3] !== 255) {
    if (stream[3] < 4) throw new Error('Неверная длина SCEP.');
    return 4 + stream[3];
  }
  if (stream.length < 6) return null;
  const size = 6 + u16(stream, 4);
  if (size < 10 || size > 4096) throw new Error('Неверный размер пакета SCEP.');
  return size;
}
export function unpackSCEP(stream) {
  if (stream.length > LIMIT * 1.1) throw new Error('Архив SCEP слишком большой.');
  let pos = 0, number = 0, total = null;
  const parts = [];
  while (pos < stream.length) {
    const size = pduSize(stream.subarray(pos));
    if (size === null || pos + size > stream.length) throw new Error('Обрезанный пакет SCEP.');
    const end = pos + size;
    let offset = pos + (stream[pos + 3] === 255 ? 6 : 4);
    if (stream[offset] !== 0x10) throw new Error('Неверный тип элемента SCEP.');
    const flag = stream[offset + 1], payloadSize = u16(stream, offset + 2); offset += 4;
    if (flag === 0xc1) {
      if (pos || end !== stream.length) throw new Error('Лишняя команда SCEP.');
    } else if ([0x41, 1, 0x81].includes(flag)) {
      if (offset + 8 > end) throw new Error('Обрезанный сегмент SCEP.');
      const sequence = u32(stream, offset), rest = u32(stream, offset + 4); offset += 8;
      if (total === null) total = rest;
      if (sequence !== number || rest !== total - number || !rest) throw new Error('Нарушен порядок сегментов SCEP.');
      const expected = number === 0 ? 0x41 : rest === 1 ? 0x81 : 1;
      if (flag !== expected || (rest === 1) !== (end === stream.length)) throw new Error('Незавершённый сеанс SCEP.');
      number++;
    } else throw new Error('Неизвестный флаг SCEP.');
    if (end - offset !== payloadSize) throw new Error('Длина сегмента SCEP не совпадает с данными.');
    parts.push(stream.slice(offset, end)); pos = end;
  }
  const command = concat(...parts); parseCommand(command); return command;
}
export function jpegFromUPF(upf) {
  if (upf.length < 384 || upf.length > LIMIT || !starts(upf, ascii('SSS V100UPF V100')) || ![2, 3, 4].includes(upf[60])) throw new Error('Неверный файл UPF.');
  for (let n = 0; n < upf[60]; n++) {
    const p = 240 + n * 36;
    if (upf[p + 8] !== 0x10) continue;
    const start = 384 + u32(upf, p), size = u32(upf, p + 4);
    if (start + size > upf.length || size < 4) throw new Error('Обрезанные данные изображения UPF.');
    const jpeg = upf.slice(start, start + size);
    jpegInfo(jpeg); return jpeg;
  }
  throw new Error('В UPF нет основного снимка.');
}
export function makeUPF(jpeg, width = 176, height = 144) {
  if (jpeg.length > LIMIT - 384) throw new Error('JPEG слишком большой.');
  const header = new Uint8Array(384);
  header.set(concat(ascii('SSS V100UPF V100'), b(1, 0, 1, 0)));
  header.set(concat(b(0x80), new Uint8Array(7).fill(255), b(0x80), new Uint8Array(15).fill(255)), 20);
  header[60] = 2; header[63] = 255; header.set(b(255, 255, 255, 255), 240); header[248] = 0x11;
  header.set(concat(be32(0), be32(jpeg.length), b(0x10, 0)), 276);
  header.set(concat(be16(width), be16(height)), 286); header.set(b(255, 255, 255), 293);
  header.set(concat(be16(width), be16(height)), 304);
  return concat(header, jpeg);
}
export function jpegInfo(jpeg) {
  if (!starts(jpeg, b(255, 0xd8)) || !equal(jpeg.slice(-2), b(255, 0xd9))) throw new Error('Ожидался полный файл JPEG.');
  let pos = 2, found;
  while (pos + 4 <= jpeg.length) {
    if (jpeg[pos] !== 255) throw new Error('Повреждённый заголовок JPEG.');
    const marker = jpeg[pos + 1], size = u16(jpeg, pos + 2);
    if (size < 2 || pos + 2 + size > jpeg.length) throw new Error('Обрезанный сегмент JPEG.');
    if (marker === 0xc0) {
      const data = jpeg.slice(pos + 4, pos + 2 + size);
      if (data.length < 6 || data[0] !== 8 || data.length !== 6 + 3 * data[5]) throw new Error('Неподдерживаемый JPEG.');
      found = { width: u16(data, 3), height: u16(data, 1), sampling: Array.from({ length: data[5] }, (_, n) => data[7 + 3 * n]) };
    } else if ([0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      throw new Error('Нужен baseline JPEG. Включи подготовку изображения.');
    } else if (marker === 0xda) {
      if (!found) throw new Error('У JPEG нет заголовка baseline.');
      return found;
    }
    pos += 2 + size;
  }
  throw new Error('У JPEG нет данных изображения.');
}
export function checkWatchJPEG(jpeg) {
  const info = jpegInfo(jpeg);
  if (info.width !== 176 || info.height !== 144 || !equal(info.sampling, [0x22, 0x11, 0x11])) throw new Error('Для WQV-3 нужен JPEG 176 × 144, baseline, 4:2:0.');
  return info;
}
export function extractUPF(command) {
  const fields = parseCommand(command), attrs = fields.attributes;
  if (fields.reply || !attrs.CMD0 || !equal(attrs.CMD0, b(0, 0, 0, 0)) || !attrs.BDY0) throw new Error('Ожидалась команда передачи изображения.');
  jpegFromUPF(attrs.BDY0); return attrs.BDY0;
}
export async function loadArchive(archive) {
  if (archive?.format !== 'casio-wqv-transfer-v1' || archive.model !== 3 || !Array.isArray(archive.packets)) throw new Error('Нужен архив снимка WQV-3.');
  if (archive.packets.reduce((n, p) => n + (typeof p === 'string' ? p.length : LIMIT * 10), 0) > LIMIT * 3) throw new Error('Архив снимка слишком большой.');
  const upf = extractUPF(unpackSCEP(concat(...archive.packets.map(fromHex))));
  if (await sha256(jpegFromUPF(upf)) !== archive.jpeg_sha256) throw new Error('Контрольная сумма архива не совпала.');
  checkWatchJPEG(jpegFromUPF(upf)); return upf;
}
export function putCommand(upf, filename, options = {}) {
  if (!/^[A-Z0-9_-]{8}\.UPF$/i.test(filename)) throw new Error('Имя на часах: 8 символов ASCII и расширение .UPF.');
  return makeCommand([attribute('CMD0', b(0, 0, 0, 0)), attribute('FIL0', ascii(filename), true), attribute('BDY0', upf)], { id: 0x83, ...options });
}
export function queryCommand(name, id = 0x80) {
  if (!['RIMG', 'RINF', 'RCMD'].includes(name)) throw new Error('Неизвестный запрос возможностей.');
  return makeCommand([attribute('CMD0', b(0, 1, 0, 0x40)), attribute('WHT0', ascii(name), true)], { id });
}
export function queryResponse(data) {
  const name = text(data.slice(-4));
  const extras = {
    RINF: '000010ffff11ffff', RCMD: '00002000010001',
    RIMG: '00000001010108000600020708000600064004b0050003c00400030003200258028001e0014000f003c4200401c4200500001800',
  };
  if (data.length < 44 || !Object.hasOwn(extras, name)) throw new Error('Неизвестный запрос характеристик от часов.');
  const shift = { RIMG: 0x20, RINF: -12, RCMD: -13 }[name], reply = data.slice(0, 44);
  reply[0] = data[1]; reply[1] = data[0]; reply[0x2b] = 1; reply[0x0f] = 0x40;
  reply[0x18] = data[0x20]; reply[0x20] = data[0x18];
  for (const i of [9, 13, 19]) reply[i] = (data[i] + shift) & 255;
  const extra = fromHex(extras[name]); return concat(reply, ascii('BDY0'), be32(extra.length), extra);
}
