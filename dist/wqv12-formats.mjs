// WQV-1/2 PC protocol: Marcus Gröber's wqvprot.html and Kees
// Jongenburger's WQV-2 notes. This uses SUM16, not the WQV-3 IrLAP CRC.
import { b, ascii, concat, be32, toHex } from './formats.mjs';

export const WQV12_RECORD_BYTES = 7229;
export function isWQV12ClockReply(frame) {
  return frame.address === 255 && frame.control === 0xa3 && frame.data.length === 4 &&
    frame.data[0] < 24 && frame.data[1] < 60 && frame.data[2] < 60;
}
export function sum16(bytes) { return bytes.reduce((sum, byte) => (sum + byte) & 0xffff, 0); }
export function encodeWQV12(address, control, data = b()) {
  if (![address, control].every(v => Number.isInteger(v) && v >= 0 && v <= 255) || !(data instanceof Uint8Array)) throw new TypeError('Invalid WQV-1/2 frame.');
  const body = concat(b(address, control), data), checksum = sum16(body), escaped = [];
  for (const byte of concat(body, b(checksum >>> 8, checksum & 255))) {
    if ([0xc0, 0xc1, 0x7d].includes(byte)) escaped.push(0x7d, byte ^ 0x20); else escaped.push(byte);
  }
  return b(0xc0, ...escaped, 0xc1);
}

export class WQV12Decoder {
  frames = []; body = null; escaped = false; badChecksum = 0; malformed = 0;
  unframedBytes = 0; abandonedFrames = 0;
  constructor({ rejected = () => {} } = {}) { this.rejected = rejected; }
  reset() { this.body = null; this.escaped = false; }
  feed(bytes) {
    for (const byte of bytes) {
      if (byte === 0xc0) {
        if (this.body?.length || this.escaped) {
          this.abandonedFrames++;
          this.rejected({ reason: 'restarted-before-eof', bodyHex: toHex(Uint8Array.from(this.body)) });
        }
        this.body = []; this.escaped = false; continue;
      }
      if (this.body === null) { this.unframedBytes++; continue; }
      if (byte === 0xc1) {
        if (!this.escaped && this.body.length >= 4) {
          const body = Uint8Array.from(this.body), end = body.length - 2;
          const calculated = sum16(body.subarray(0, end)), received = (body[end] << 8) | body[end + 1];
          if (calculated === received) {
            this.frames.push({ address: body[0], control: body[1], data: body.slice(2, end) });
          } else {
            this.badChecksum++;
            this.rejected({ reason: 'checksum', bodyHex: toHex(body), calculated, received });
          }
        } else {
          this.malformed++;
          this.rejected({ reason: this.escaped ? 'unfinished-escape' : 'short-body', bodyHex: toHex(Uint8Array.from(this.body)) });
        }
        this.reset(); continue;
      }
      if (this.escaped) {
        if (![0xe0, 0xe1, 0x5d].includes(byte)) { this.malformed++; this.reset(); continue; }
        this.body.push(byte ^ 0x20); this.escaped = false;
      } else if (byte === 0x7d) this.escaped = true;
      else this.body.push(byte);
      if (this.body?.length > 2048) { this.malformed++; this.reset(); }
    }
  }
}

export function decodeWQV12Record(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== WQV12_RECORD_BYTES) throw new Error('A WQV-1/2 image record must contain 7229 bytes.');
  const titleBytes = bytes.slice(0, 24), dateBytes = bytes.slice(24, 29), grey = new Uint8Array(120 * 120);
  for (let i = 0; i < 7200; i++) {
    grey[2 * i] = 255 - (bytes[29 + i] & 15) * 17;
    grey[2 * i + 1] = 255 - (bytes[29 + i] >>> 4) * 17;
  }
  // References disagree about the month base. Keep both interpretations and
  // the untouched bytes until checked against an image from this WQV-2.
  const date = month => {
    const [year, , day, hour, minute] = dateBytes, fullYear = year + 2000;
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(fullYear, month, 0)).getUTCDate() || hour > 23 || minute > 59) return null;
    const pad = value => String(value).padStart(2, '0');
    return `${fullYear}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  };
  return { bytes: bytes.slice(), grey, width: 120, height: 120,
    title: Array.from(titleBytes, byte => byte < 128 ? String.fromCharCode(byte) : '?').join('').replace(/^[\0 ]+|[\0 ]+$/g, ''),
    titleHex: toHex(titleBytes), dateHex: toHex(dateBytes),
    dateOneBased: date(dateBytes[1]), dateZeroBased: date(dateBytes[1] + 1) };
}

// Lossless grayscale PNG, with a stored DEFLATE block. No JPEG conversion,
// image library, browser canvas or platform-specific rendering is needed.
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
export function wqv12PNG(grey) {
  if (!(grey instanceof Uint8Array) || grey.length !== 14400) throw new Error('Expected 120 × 120 grayscale pixels.');
  const chunk = (name, data) => {
    const body = concat(ascii(name), data);
    return concat(be32(data.length), body, be32(crc32(body)));
  };
  const rows = new Uint8Array(121 * 120);
  for (let y = 0; y < 120; y++) rows.set(grey.subarray(y * 120, y * 120 + 120), y * 121 + 1);
  let a = 1, c = 0;
  for (const byte of rows) { a = (a + byte) % 65521; c = (c + a) % 65521; }
  const size = rows.length, deflate = concat(b(0x78, 1, 1, size & 255, size >>> 8, (~size) & 255, ((~size) >>> 8) & 255), rows, be32((c << 16) | a));
  return concat(b(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', concat(be32(120), be32(120), b(8, 0, 0, 0, 0))), chunk('IDAT', deflate), chunk('IEND', b()));
}
