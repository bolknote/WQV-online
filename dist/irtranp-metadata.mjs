// Standard UPF metadata and bFTP optional attributes. Raw values are retained;
// absent and malformed metadata must not become inferred dates or captions.
import { b, ascii, concat, be16, be32, u16, u32, toHex, sha256,
  makeUPF, jpegFromUPF, jpegInfo, makeCommand, attribute, parseCommand } from './formats.mjs';

const align = n => Math.ceil(n / 4) * 4;
const string = bytes => new TextDecoder('ascii').decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
const checkedText = (value, max) => {
  const data = ascii(value);
  if (data.includes(0) || data.length > max) throw new RangeError('Metadata text is too long or contains a NUL.');
  return data;
};
const timeParts = value => {
  if (!/^\d{14}$/.test(value)) throw new Error('Use YYYYMMDDHHMMSS for a file timestamp.');
  const parts = [Number(value.slice(0, 4)), ...[4, 6, 8, 10, 12].map(p => Number(value.slice(p, p + 2)))];
  const [y, m, d, h, min, s] = parts, date = new Date(Date.UTC(y, m - 1, d, h, min, s));
  if (y < 1900 || y > 9999 || date.toISOString().slice(0, 19).replace(/[-T:]/g, '') !== value) throw new Error('Invalid file timestamp.');
  return parts;
};
export function upfDate(value, timezoneQuarters = 0) {
  const [year, ...rest] = timeParts(value);
  if (!Number.isInteger(timezoneQuarters) || Math.abs(timezoneQuarters) > 48) throw new Error('Invalid UPF timezone.');
  return concat(b(timezoneQuarters & 255), be16(year), b(...rest));
}
function readDate(data) {
  const rawHex = toHex(data);
  if (data.slice(1).every(v => v === 255)) return { value: null, timezoneQuarters: null, rawHex };
  const parts = [u16(data, 1), ...data.slice(3)];
  const value = String(parts[0]).padStart(4, '0') + parts.slice(1).map(v => String(v).padStart(2, '0')).join('');
  try { timeParts(value); } catch { return { value: null, invalid: true, rawHex }; }
  const zone = data[0] === 128 ? null : data[0] > 127 ? data[0] - 256 : data[0];
  return { value, timezoneQuarters: zone, rawHex };
}
export function upfMetadata(upf) {
  jpegFromUPF(upf); // Validate the container's main image and entry bounds first.
  const count = upf[61], tables = []; let p = 384;
  for (let n = 0; n < count; n++) {
    if (p + 2 > upf.length) throw new Error('Truncated UPF metadata table.');
    const length = upf[p + 1] + 2, end = p + length;
    if (length < 4 || end > upf.length) throw new Error('Invalid UPF metadata table length.');
    const data = upf.slice(p, end), table = { id: data[0], bytes: length, rawHex: toHex(data) };
    if (data[0] === 0x12 && data[2] === 0) table.comment = string(data.slice(4));
    if (data[0] === 0x13 && data[3] === 0 && length >= 72) {
      table.author = string(data.slice(4, 36)); table.editor = string(data.slice(36, 68));
    }
    tables.push(table); p = align(end);
  }
  const entries = Array.from({ length: upf[60] }, (_, n) => {
    const at = 240 + n * 36, start = u32(upf, at), size = u32(upf, at + 4), type = upf[at + 8];
    const present = start !== 0xffffffff && size > 0;
    if (present && (384 + start < p || 384 + start + size > upf.length)) throw new Error('UPF image entry overlaps metadata or exceeds the file.');
    return { type, present, offset: start, bytes: size, width: u16(upf, at + 10), height: u16(upf, at + 12),
      ...(present ? { dataHex: toHex(upf.slice(384 + start, 384 + start + size)) } : {}) };
  });
  const title = upf[63] === 255 ? null : upf[63] === 0 ? string(upf.slice(64, 192)) : null;
  const thumbnail = entries.find(e => e.type === 0x11 && e.present) ?? null;
  return { created: readDate(upf.slice(20, 28)), modified: readDate(upf.slice(28, 36)),
    title, titleCharset: upf[63], titleRawHex: toHex(upf.slice(64, 192)),
    makerModelHex: toHex(upf.slice(36, 40)), tables,
    comment: tables.find(t => t.comment !== undefined)?.comment ?? null,
    author: tables.find(t => t.author !== undefined)?.author ?? null,
    editor: tables.find(t => t.editor !== undefined)?.editor ?? null, thumbnail,
    entries: entries.map(({ dataHex, ...e }) => e) };
}
function textTable(id, value) {
  const valueBytes = checkedText(value, 251), size = align(5 + valueBytes.length);
  if (size > 256) throw new Error('UPF text table exceeds 256 bytes.');
  const table = new Uint8Array(size); table.set(b(id, size - 2, 0, 0)); table.set(valueBytes, 4); return table;
}
export function metadataUPF(jpeg, fields = {}) {
  const head = makeUPF(jpeg).slice(0, 384), tables = [];
  if (fields.created) head.set(upfDate(fields.created), 20);
  if (fields.modified) head.set(upfDate(fields.modified), 28);
  if (fields.title !== undefined) { head[63] = 0; head.set(checkedText(fields.title, 127), 64); }
  if (fields.comment !== undefined) tables.push(textTable(0x12, fields.comment));
  if (fields.author !== undefined || fields.editor !== undefined) {
    const table = new Uint8Array(72); table.set(b(0x13, 70, 0, 0));
    table.set(checkedText(fields.author ?? '', 31), 4); table.set(checkedText(fields.editor ?? '', 31), 36); tables.push(table);
  }
  head[61] = tables.length;
  let prefix = concat(...tables);
  if (fields.thumbnail) {
    const info = jpegInfo(fields.thumbnail);
    if (info.width !== 80 || info.height !== 64) throw new Error('UPF index JPEG must be 80 × 64.');
    head.set(concat(be32(prefix.length), be32(fields.thumbnail.length), b(0x11, 0)), 240);
    head.set(concat(be16(80), be16(64)), 250);
    head.set(concat(be16(80), be16(64)), 268);
    prefix = concat(prefix, fields.thumbnail, new Uint8Array(align(fields.thumbnail.length) - fields.thumbnail.length));
  }
  head.set(be32(prefix.length), 276);
  return concat(head, prefix, jpeg);
}
export function metadataPutCommand(file, options) {
  const fields = file.transferMetadata ?? {}, attrs = [attribute('CMD0', b(0, 0, 0, 0)), attribute('FIL0', ascii(file.filename), true)];
  if (fields.longName) attrs.push(attribute('LFL0', checkedText(fields.longName, 255), true));
  if (fields.time) {
    timeParts(fields.time);
    attrs.push(concat(ascii('TIM0'), be32(16), b(6, 0), ascii(fields.time)));
  }
  attrs.push(attribute('BDY0', file.bytes)); return makeCommand(attrs, options);
}
export function transferMetadata(command) {
  const parsed = parseCommand(command), result = {};
  for (const [name, value] of Object.entries(parsed.attributes)) {
    if (['CMD0', 'BDY0'].includes(name)) continue;
    result[name] = { rawHex: toHex(value), text: ['FIL0', 'LFL0', 'TIM0'].includes(name) ? string(value) : null };
  }
  return result;
}

// A JPEG image fingerprint excludes APP/COM metadata and table ordering.
// It retains every quantization/Huffman value, coding parameter and scan byte.
// Equality proves the same compressed image; inequality alone is not corruption.
export async function jpegImageFingerprint(jpeg) {
  jpegInfo(jpeg); const tables = new Map(), coding = []; let p = 2;
  while (p + 4 <= jpeg.length) {
    const marker = jpeg[p + 1], length = u16(jpeg, p + 2), end = p + length + 2;
    if (jpeg[p] !== 255 || length < 2 || end > jpeg.length) throw new Error('Invalid JPEG segment.');
    const data = jpeg.slice(p + 4, end);
    if ([0xdb, 0xc4].includes(marker)) {
      for (let q = 0; q < data.length;) {
        const id = data[q], size = marker === 0xdb ? 1 + (id >> 4 ? 128 : 64) :
          17 + data.slice(q + 1, q + 17).reduce((a, v) => a + v, 0);
        if (q + size > data.length) throw new Error('Truncated JPEG table.');
        const key = marker * 256 + id;
        if (tables.has(key)) throw new Error('Repeated JPEG table is not supported by this fingerprint.');
        tables.set(key, concat(be16(key), be32(size), data.slice(q, q + size))); q += size;
      }
    } else if (marker === 0xda) {
      coding.push(concat(b(marker), be32(data.length), data, jpeg.slice(end)));
      return sha256(concat(...[...tables].sort(([a], [c]) => a - c).map(([, bytes]) => bytes), ...coding));
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) coding.push(concat(b(marker), be32(data.length), data));
    p = end;
  }
  throw new Error('Missing JPEG scan.');
}
export function cancellationPDU(mode, { destination, source, id }) {
  if (mode === 'stp') return b(0, 0x20, 3, 4, 0x10, 0xc2, 0, 0);
  if (mode !== 'abt') throw new Error('Unknown SCEP cancellation mode.');
  const header = concat(b(0x58, 0xc0), be32(22), destination, source, be16(8), be16(8), be16(id));
  if (header.length !== 28) throw new Error('Invalid SCEP Abort identity.');
  return concat(b(0, 0x20, 3, 32, 0x10, 0xc1, 0, 28), header);
}

export const FEATURE_CASES = Object.freeze([
  { id: 'control', number: 1, title: 'Control: labelled test image' },
  { id: 'filename', number: 2, title: 'File name (FIL0)' },
  { id: 'transfer-time', number: 3, title: 'File date (TIM0)', transfer: { time: '20010203040506' } },
  { id: 'long-name', number: 4, title: 'Long name (LFL0)', transfer: { longName: 'IrTranP long file name.UPF' } },
  { id: 'upf-dates', number: 5, title: 'UPF creation and edit dates', fields: { created: '20010203040506', modified: '20040506070809' } },
  { id: 'upf-title', number: 6, title: 'UPF title', fields: { title: 'IRTRANP TITLE 06' } },
  { id: 'upf-comment', number: 7, title: 'UPF comment', fields: { comment: 'IRTRANP COMMENT 07' } },
  { id: 'upf-author', number: 8, title: 'UPF author and editor', fields: { author: 'IRTRANP AUTHOR 08', editor: 'IRTRANP EDITOR 08' } },
  { id: 'upf-thumbnail', number: 9, title: 'UPF index image (80 × 64)' },
  { id: 'multiple', number: 10, title: 'Two different images in one connection', copies: 2 },
  { id: 'multiple-csi', number: 10, title: 'Two photos with CSI negotiated packets', copies: 2,
    recordedInput: true, recordedInputs: ['single-10', 'single-11'], sendPDU: 0 },
  { id: 'multiple-wince211', number: 10, title: 'Two photos with Windows CE 2.11 transport', copies: 2,
    recordedInput: true, recordedInputs: ['single-10', 'single-11'], sendPDU: 0, transportProfile: 'wince211' },
  { id: 'single-10', number: 10, title: 'Photo 10 alone: unchanged file', recordedInput: true },
  { id: 'single-11', number: 11, title: 'Photo 11 alone: unchanged file', recordedInput: true },
  { id: 'stop', number: 12, title: 'SCEP Stop during PUT', abortMode: 'stp' },
  { id: 'after-stop', number: 13, title: 'Normal upload after Stop' },
  { id: 'abort', number: 14, title: 'SCEP Abort after PUT', abortMode: 'abt' },
  { id: 'after-abort', number: 15, title: 'Normal upload after Abort' },
  { id: 'fast', number: 16, title: 'Labelled upload at 115200' },
]);
export function featureCase(id) {
  const result = FEATURE_CASES.find(item => item.id === id);
  if (!result) throw new Error('Unknown IrTran-P feature test.');
  return result;
}

export function compareMetadata(expected, actual) {
  const result = {};
  for (const key of ['title', 'comment', 'author', 'editor']) if (expected[key] !== null) result[key] = { expected: expected[key], actual: actual[key], matches: expected[key] === actual[key] };
  for (const key of ['created', 'modified']) if (expected[key].value !== null) result[key] = { expected: expected[key], actual: actual[key], matches: expected[key].value === actual[key].value && expected[key].timezoneQuarters === actual[key].timezoneQuarters };
  if (expected.thumbnail) result.thumbnail = { expectedBytes: expected.thumbnail.bytes, actualBytes: actual.thumbnail?.bytes ?? 0,
    matches: expected.thumbnail.dataHex === actual.thumbnail?.dataHex };
  return result;
}
