// Baseline JPEG entropy validation and lossless removal of restart intervals.
// WQV-3 keeps RST markers but drops DRI when exporting an imported JPEG.
// Decode coefficients, carry DC predictors across intervals, and encode again
// with the original Huffman tables. Quantized image coefficients never change.
const fail = message => { throw new Error('JPEG: ' + message); };
const word = (a, p) => (a[p] << 8) | a[p + 1];
const join = parts => {
  const out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0)); let p = 0;
  for (const a of parts) { out.set(a, p); p += a.length; } return out;
};
function huffman(data) {
  const tables = new Map(); let pos = 0;
  while (pos < data.length) {
    const id = data[pos++], decode = Array.from({ length: 17 }, () => new Map()), encode = new Map();
    if (pos + 16 > data.length) fail('обрезана таблица Хаффмана.');
    const counts = data.slice(pos, pos + 16); pos += 16; let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      for (let n = 0; n < counts[bits - 1]; n++) {
        if (pos >= data.length || code >= (1 << bits) - 1) fail('неверная таблица Хаффмана.');
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
    if (this.pos + bits > this.data.length * 8) fail('оборваны сжатые данные изображения.');
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
    fail('неверный код Хаффмана.');
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
      for (let p = this.pos; p < this.data.length * 8; p++) if ((this.data[p >> 3] >> (7 - (p & 7))) & 1) fail('лишние данные после блоков изображения.');
      return;
    }
    fail('лишние данные после блоков изображения.');
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
    const entry = table.encode.get(value); if (!entry) fail('таблица не позволяет убрать перезапуск без потерь.');
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
      if (marker !== 0xd0 + (restart++ % 8)) fail('нарушен порядок маркеров перезапуска.');
      parts.push(Uint8Array.from(bytes)); bytes.length = 0;
    } else if (marker === 0xd9) {
      if (p + 1 !== jpeg.length) fail('лишние данные после конца изображения.');
      parts.push(Uint8Array.from(bytes)); return parts;
    } else fail('неподдерживаемый или повреждённый поток изображения.');
  }
  fail('отсутствует конец изображения.');
}
const signed = (value, bits) => bits && value < (1 << (bits - 1)) ? value - (1 << bits) + 1 : value;
function writeDC(writer, table, value) {
  const bits = value ? Math.floor(Math.log2(Math.abs(value))) + 1 : 0;
  if (bits > 11) fail('значение DC вне диапазона baseline JPEG.');
  writer.symbol(table, bits); writer.write(value < 0 ? value + (1 << bits) - 1 : value, bits);
}
export function normalizeWatchJPEG(jpeg) {
  if (jpeg.length < 4 || jpeg.length > 2 * 1024 * 1024 || word(jpeg, 0) !== 0xffd8) fail('неверное начало файла.');
  const headers = [jpeg.slice(0, 2)], tables = new Map(); let components, scan, width, height, interval = null, pos = 2;
  while (pos + 4 <= jpeg.length) {
    if (jpeg[pos] !== 255) fail('повреждён заголовок.');
    const marker = jpeg[pos + 1], size = word(jpeg, pos + 2), end = pos + 2 + size;
    if (size < 2 || end > jpeg.length) fail('обрезан сегмент заголовка.');
    const data = jpeg.slice(pos + 4, end);
    if (marker === 0xc0) {
      if (components || data.length !== 15 || data[0] !== 8 || data[5] !== 3) fail('нужен baseline JPEG с тремя компонентами.');
      height = word(data, 1); width = word(data, 3);
      components = Array.from({ length: 3 }, (_, n) => ({ id: data[6 + n * 3], h: data[7 + n * 3] >> 4, v: data[7 + n * 3] & 15 }));
      if (width !== 176 || height !== 144 || components.some((c, n) => c.h !== (n ? 1 : 2) || c.v !== (n ? 1 : 2))) fail('нужен размер 176 × 144 и цветность 4:2:0.');
    } else if (marker === 0xc4) {
      for (const [id, table] of huffman(data)) tables.set(id, table);
    } else if (marker === 0xdd) {
      if (data.length !== 2 || interval !== null) fail('неверный интервал перезапуска.');
      interval = word(data, 0);
    } else if (marker === 0xda) {
      if (!components || data.length !== 10 || data[0] !== 3 || data[7] !== 0 || data[8] !== 63 || data[9] !== 0) fail('неподдерживаемый тип сканирования.');
      scan = Array.from({ length: 3 }, (_, n) => {
        const c = components.find(c => c.id === data[1 + n * 2]), selector = data[2 + n * 2];
        const dc = tables.get(selector >> 4), ac = tables.get(0x10 | (selector & 15));
        if (!c || !dc || !ac) fail('отсутствует компонент или таблица Хаффмана.');
        return { ...c, dc, ac };
      });
      if (new Set(scan.map(c => c.id)).size !== 3) fail('повторный компонент.');
      headers.push(jpeg.slice(pos, end)); pos = end; break;
    } else if ((marker >= 0xc1 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) || marker === 0xdc || marker === 0xcc) fail('нужен baseline JPEG.');
    if (marker !== 0xdd) headers.push(jpeg.slice(pos, end)); pos = end;
  }
  if (!scan) fail('отсутствуют сжатые данные.');
  const parts = scanParts(jpeg, pos), total = Math.ceil(width / 16) * Math.ceil(height / 16);
  const writer = new Writer(), outputDC = new Map(scan.map(c => [c.id, 0])); let count = 0, inferred = null;
  for (let index = 0; index < parts.length; index++) {
    const reader = new Reader(parts[index]), inputDC = new Map(scan.map(c => [c.id, 0])); let inPart = 0;
    while (!reader.padding() && count < total) {
      for (const c of scan) for (let block = 0; block < c.h * c.v; block++) {
        const category = reader.symbol(c.dc); if (category > 11) fail('неверный коэффициент DC.');
        const dc = inputDC.get(c.id) + signed(reader.read(category), category); inputDC.set(c.id, dc);
        writeDC(writer, c.dc, dc - outputDC.get(c.id)); outputDC.set(c.id, dc);
        for (let k = 1; k < 64;) {
          const symbol = reader.symbol(c.ac), run = symbol >> 4, bits = symbol & 15;
          writer.symbol(c.ac, symbol);
          if (!bits) {
            if (!run) break;
            if (run !== 15 || k + 16 > 64) fail('неверный пропуск коэффициентов AC.');
            k += 16;
          } else {
            if (bits > 10 || k + run >= 64) fail('неверный коэффициент AC.');
            writer.write(reader.read(bits), bits); k += run + 1;
          }
        }
      }
      count++; inPart++;
    }
    reader.finish();
    if (!inPart) fail('пустой интервал изображения.');
    if (index < parts.length - 1) {
      if (inferred === null) inferred = inPart;
      if (inPart !== inferred || (interval !== null && interval !== inPart)) fail('интервалы перезапуска не совпадают.');
    } else if ((inferred !== null && inPart > inferred) || (interval && inPart > interval)) fail('неверный последний интервал.');
  }
  if (count !== total) fail('изображение обрезано: получено блоков ' + count + ' из ' + total + '.');
  const changed = parts.length > 1 || interval !== null;
  return { jpeg: changed ? join([...headers, writer.finish(), Uint8Array.of(255, 0xd9)]) : jpeg,
    changed, repaired: parts.length > 1 && interval === null, restartInterval: inferred ?? interval ?? 0, mcus: count };
}
