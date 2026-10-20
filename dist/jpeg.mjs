import { tr, LocalizedError } from './i18n.mjs';
// Baseline JPEG entropy validation and lossless removal of restart intervals.
// WQV-3 keeps RST markers but drops DRI when exporting an imported JPEG.
// Decode coefficients, carry DC predictors across intervals, and encode again
// with the original Huffman tables. Quantized image coefficients never change.
const fail = message => { throw new LocalizedError(tr('JPEG: {0}', message)); };
const word = (a, p) => (a[p] << 8) | a[p + 1];
const join = parts => {
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0)); let p = 0;
  for (const a of parts) { out.set(a, p); p += a.length; } return out;
};
function huffman(data) {
  const tables = new Map(); let pos = 0;
  while (pos < data.length) {
    const id = data[pos++], decode = Array.from({ length: 17 }, () => new Map()), encode = new Map();
    if (pos + 16 > data.length) fail(tr("truncated Huffman table."));
    const counts = data.slice(pos, pos + 16); pos += 16; let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      for (let n = 0; n < counts[bits - 1]; n++) {
        if (pos >= data.length || code >= (1 << bits) - 1) fail(tr("invalid Huffman table."));
        const symbol = data[pos++]; decode[bits].set(code, symbol); encode.set(symbol, { code, bits }); code++;
      }
      code *= 2;
    }
    tables.set(id, { decode, encode });
  }
  return tables;
}
class Reader {
  constructor(data) { this.data = data; this.pos = 0; }
  read(bits) {
    if (this.pos + bits > this.data.length * 8) fail(tr("truncated compressed image data."));
    let value = 0;
    while (bits--) { value = value * 2 + ((this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1); this.pos++; }
    return value;
  }
  symbol(table) {
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      code = code * 2 + this.read(1);
      if (table.decode[bits].has(code)) return table.decode[bits].get(code);
    }
    fail(tr("invalid Huffman code."));
  }
  padding() {
    const remaining = this.data.length * 8 - this.pos;
    if (remaining > 7) return false;
    for (let p = this.pos; p < this.data.length * 8; p++) if (!((this.data[p >> 3] >> (7 - (p & 7))) & 1)) return false;
    return true;
  }
  finish() {
    const remaining = this.data.length * 8 - this.pos;
    // Native Casio JPEGs end with zero fill, sometimes including one byte.
    if (this.padding()) return;
    if (remaining <= 15) {
      for (let p = this.pos; p < this.data.length * 8; p++) if ((this.data[p >> 3] >> (7 - (p & 7))) & 1) fail(tr("extra data after the image blocks."));
      return;
    }
    fail(tr("extra data after the image blocks."));
  }
}
class Writer {
  constructor() { this.bytes = []; this.byte = 0; this.bits = 0; }
  write(value, bits) {
    while (bits--) {
      this.byte = (this.byte << 1) | ((value >> bits) & 1); this.bits++;
      if (this.bits === 8) { this.bytes.push(this.byte); if (this.byte === 255) this.bytes.push(0); this.bits = 0; this.byte = 0; }
    }
  }
  symbol(table, value) {
    const entry = table.encode.get(value); if (!entry) fail(tr("the table cannot remove restart markers without loss."));
    this.write(entry.code, entry.bits);
  }
  finish() { if (this.bits) this.write((1 << (8 - this.bits)) - 1, 8 - this.bits); return Uint8Array.from(this.bytes); }
}
function scanParts(jpeg, start) {
  const parts = [], bytes = []; let restart = 0;
  for (let p = start; p < jpeg.length; p++) {
    if (jpeg[p] !== 255) { bytes.push(jpeg[p]); continue; }
    let marker = jpeg[++p]; while (marker === 255) marker = jpeg[++p];
    if (marker === 0) bytes.push(255);
    else if (marker >= 0xd0 && marker <= 0xd7) {
      if (marker !== 0xd0 + (restart++ % 8)) fail(tr("restart markers are out of order."));
      parts.push(Uint8Array.from(bytes)); bytes.length = 0;
    } else if (marker === 0xd9) {
      if (p + 1 !== jpeg.length) fail(tr("extra data after the end of the image."));
      parts.push(Uint8Array.from(bytes)); return parts;
    } else fail(tr("unsupported or damaged image stream."));
  }
  fail(tr("missing end of image."));
}
const signed = (value, bits) => bits && value < (1 << (bits - 1)) ? value - (1 << bits) + 1 : value;
function writeDC(writer, table, value) {
  const bits = value ? Math.floor(Math.log2(Math.abs(value))) + 1 : 0;
  if (bits > 11) fail(tr("DC value is outside the baseline JPEG range."));
  writer.symbol(table, bits); writer.write(value < 0 ? value + (1 << bits) - 1 : value, bits);
}
export function normalizeWatchJPEG(jpeg) {
  if (jpeg.length < 4 || jpeg.length > 2 * 1024 * 1024 || word(jpeg, 0) !== 0xffd8) fail(tr("invalid start of file."));
  const headers = [jpeg.slice(0, 2)], tables = new Map(); let components, scan, width, height, interval = null, pos = 2;
  while (pos + 4 <= jpeg.length) {
    if (jpeg[pos] !== 255) fail(tr("damaged header."));
    const marker = jpeg[pos + 1], size = word(jpeg, pos + 2), end = pos + 2 + size;
    if (size < 2 || end > jpeg.length) fail(tr("truncated header segment."));
    const data = jpeg.slice(pos + 4, end);
    if (marker === 0xc0) {
      if (components || data.length !== 15 || data[0] !== 8 || data[5] !== 3) fail(tr("a baseline JPEG with three components is required."));
      height = word(data, 1); width = word(data, 3);
      components = Array.from({ length: 3 }, (_, n) => ({ id: data[6 + n * 3], h: data[7 + n * 3] >> 4, v: data[7 + n * 3] & 15 }));
      if (width !== 176 || height !== 144 || components.some((c, n) => c.h !== (n ? 1 : 2) || c.v !== (n ? 1 : 2))) fail(tr("176 × 144 dimensions and 4:2:0 sampling are required."));
    } else if (marker === 0xc4) {
      for (const [id, table] of huffman(data)) tables.set(id, table);
    } else if (marker === 0xdd) {
      if (data.length !== 2 || interval !== null) fail(tr("invalid restart interval."));
      interval = word(data, 0);
    } else if (marker === 0xda) {
      if (!components || data.length !== 10 || data[0] !== 3 || data[7] !== 0 || data[8] !== 63 || data[9] !== 0) fail(tr("unsupported scan type."));
      scan = Array.from({ length: 3 }, (_, n) => {
        const c = components.find(c => c.id === data[1 + n * 2]), selector = data[2 + n * 2];
        const dc = tables.get(selector >> 4), ac = tables.get(0x10 | (selector & 15));
        if (!c || !dc || !ac) fail(tr("missing component or Huffman table."));
        return { ...c, dc, ac };
      });
      if (new Set(scan.map(c => c.id)).size !== 3) fail(tr("duplicate component."));
      headers.push(jpeg.slice(pos, end)); pos = end; break;
    } else if ((marker >= 0xc1 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) || marker === 0xdc || marker === 0xcc) fail(tr("a baseline JPEG is required."));
    if (marker !== 0xdd) headers.push(jpeg.slice(pos, end)); pos = end;
  }
  if (!scan) fail(tr("missing compressed image data."));
  const parts = scanParts(jpeg, pos), total = Math.ceil(width / 16) * Math.ceil(height / 16);
  const writer = new Writer(), outputDC = new Map(scan.map(c => [c.id, 0])); let count = 0, inferred = null;
  for (let index = 0; index < parts.length; index++) {
    const reader = new Reader(parts[index]), inputDC = new Map(scan.map(c => [c.id, 0])); let inPart = 0;
    while (!reader.padding() && count < total) {
      for (const c of scan) for (let block = 0; block < c.h * c.v; block++) {
        const category = reader.symbol(c.dc); if (category > 11) fail(tr("invalid DC coefficient."));
        const dc = inputDC.get(c.id) + signed(reader.read(category), category); inputDC.set(c.id, dc);
        writeDC(writer, c.dc, dc - outputDC.get(c.id)); outputDC.set(c.id, dc);
        for (let k = 1; k < 64;) {
          const symbol = reader.symbol(c.ac), run = symbol >> 4, bits = symbol & 15;
          writer.symbol(c.ac, symbol);
          if (!bits) {
            if (!run) break;
            if (run !== 15 || k + 16 > 64) fail(tr("invalid AC coefficient run."));
            k += 16;
          } else {
            if (bits > 10 || k + run >= 64) fail(tr("invalid AC coefficient."));
            writer.write(reader.read(bits), bits); k += run + 1;
          }
        }
      }
      count++; inPart++;
    }
    reader.finish();
    if (!inPart) fail(tr("empty image interval."));
    if (index < parts.length - 1) {
      if (inferred === null) inferred = inPart;
      if (inPart !== inferred || (interval !== null && interval !== inPart)) fail(tr("restart intervals do not match."));
    } else if ((inferred !== null && inPart > inferred) || (interval && inPart > interval)) fail(tr("invalid final interval."));
  }
  if (count !== total) fail(tr("truncated image: received {0} of {1} blocks.", count, total));
  const changed = parts.length > 1 || interval !== null;
  return { jpeg: changed ? join([...headers, writer.finish(), Uint8Array.of(255, 0xd9)]) : jpeg,
    changed, repaired: parts.length > 1 && interval === null, restartInterval: inferred ?? interval ?? 0, mcus: count };
}
