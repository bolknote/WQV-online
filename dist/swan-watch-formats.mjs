// WQV-3 SWAN: 24 caption bytes, YY MM DD hh mm, 176 × 144 RGB332.
// Reconstructed from the named, complete hardware capture of 30 October 2026.
import { b, concat } from './formats.mjs';
import { clockPayload } from './calendar.mjs';
import { tr, LocalizedError } from './i18n.mjs';

export const SWAN_RECORD_BYTES = 25373, SWAN_BLOCK_BYTES = 1024, SWAN_BAUD = 38400;
export const SWAN_PREFIX = b(0x55, 0xff, 0);
export function checkSwanRecord(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== SWAN_RECORD_BYTES) throw new Error('A SWAN photo record must contain 25373 bytes.');
  return bytes;
}
export function swanDetails(bytes) {
  checkSwanRecord(bytes);
  let title = bytes.slice(0, 24);
  while (title.length && [0, 32, 255].includes(title.at(-1))) title = title.slice(0, -1);
  const caption = title.length && title.every(v => v >= 32 && v <= 126) ? String.fromCharCode(...title) : null;
  const [year, month, day, hour, minute] = bytes.slice(24, 29), pad = v => String(v).padStart(2, '0');
  const value = `${2000 + year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  let recordedAt = null;
  try { clockPayload(value); recordedAt = value; } catch { /* Keep original date bytes even when undefined. */ }
  return { caption, recordedAt };
}
export function withSwanDetails(bytes, { caption, recordedAt }) {
  checkSwanRecord(bytes);
  if (typeof caption !== 'string' || !/^[\x20-\x7e]{0,24}$/.test(caption)) throw new LocalizedError(tr('Use up to 24 ASCII characters for the caption.'));
  const copy = bytes.slice(); copy.fill(32, 0, 24);
  copy.set(Array.from(caption, char => char.charCodeAt(0))); copy.set(clockPayload(recordedAt).slice(1, 6), 24);
  return copy;
}
export function swanRGBA(bytes) {
  checkSwanRecord(bytes);
  const rgba = new Uint8ClampedArray(176 * 144 * 4);
  bytes.subarray(29).forEach((v, i) => {
    rgba[i * 4] = Math.round((v >>> 5) * 255 / 7);
    rgba[i * 4 + 1] = Math.round(((v >>> 2) & 7) * 255 / 7);
    rgba[i * 4 + 2] = (v & 3) * 85; rgba[i * 4 + 3] = 255;
  });
  return rgba;
}
export function swanFromRGBA(rgba, details) {
  if (rgba.length !== 176 * 144 * 4) throw new RangeError('Expected 176 × 144 RGBA pixels.');
  const pixels = new Uint8Array(176 * 144);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (rgba[4 * i] & 0xe0) | ((rgba[4 * i + 1] >>> 3) & 0x1c) | (rgba[4 * i + 2] >>> 6);
  return withSwanDetails(concat(new Uint8Array(29), pixels), details);
}
