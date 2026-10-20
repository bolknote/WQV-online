import { tr, LocalizedError } from './i18n.mjs';
// Small ZIP writer (stored files, UTF-8). No external dependencies or network.
const table = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
export function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255]; return (crc ^ 0xffffffff) >>> 0; }
export function zipFiles(files) {
  if (files.length > 65535) throw new LocalizedError(tr("Too many files for a ZIP archive."));
  let offset = 0, centralSize = 0;
  const bodies = [], directory = [], encoder = new TextEncoder();
  for (const file of files) {
    const name = encoder.encode(file.name), data = file.data, crc = crc32(data);
    if (data.length > 0xffffffff || name.length > 65535 || offset > 0xffffffff) throw new LocalizedError(tr("The file is too large for a ZIP archive."));
    const head = new Uint8Array(30), h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true);
    h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
    const central = new Uint8Array(46), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    bodies.push(head, name, data); directory.push(central, name);
    offset += head.length + name.length + data.length; centralSize += central.length + name.length;
  }
  const tail = new Uint8Array(22), end = new DataView(tail.buffer);
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...bodies, ...directory, tail], { type: 'application/zip' });
}
