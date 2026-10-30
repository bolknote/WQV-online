import { tr, LocalizedError } from './i18n.mjs';
import { b, concat, checkWatchJPEG, makeUPF } from './formats.mjs';
import { clockPayload } from './calendar.mjs';

// WQV Color 2.2, code 2: 005e84..005ee0 builds APP2 as
// 24 caption bytes (FF padding), then YY MM DD hh mm. These are Casio's
// JPEG fields, separate from the standard UPF title and timestamps.
function headerSegments(jpeg) {
  const segments = [];
  if (jpeg[0] !== 255 || jpeg[1] !== 0xd8) return segments;
  for (let pos = 2; pos + 3 < jpeg.length;) {
    const start = pos;
    if (jpeg[pos++] !== 255) break;
    while (jpeg[pos] === 255) pos++;
    const marker = jpeg[pos++];
    if (marker === 0xda || marker === 0xd9) break;
    const size = (jpeg[pos] << 8) | jpeg[pos + 1], end = pos + size;
    if (size < 2 || end > jpeg.length) break;
    segments.push({ marker, start, end, data: jpeg.subarray(pos + 2, end) });
    pos = end;
  }
  return segments;
}
const casioSegment = segment => segment.marker === 0xe2 && segment.data.length === 29 &&
  // Never treat an ICC profile as Casio metadata, even if it is 29 bytes.
  !segment.data.subarray(0, 12).every((byte, i) => byte === 'ICC_PROFILE\0'.charCodeAt(i));

export function watchPhotoDetails(jpeg) {
  const segment = headerSegments(jpeg).find(casioSegment);
  if (!segment) return { caption: null, recordedAt: null };
  const bytes = segment.data;
  let length = 24;
  while (length && [0, 32, 255].includes(bytes[length - 1])) length--;
  const title = bytes.subarray(0, length);
  const caption = length && title.every(byte => byte >= 32 && byte <= 126) ? String.fromCharCode(...title) : null;
  const [year, month, day, hour, minute] = bytes.subarray(24);
  const pad = value => String(value).padStart(2, '0');
  const value = `${2000 + year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  let recordedAt = null;
  try { clockPayload(value); recordedAt = value; } catch { /* Undefined or invalid date. */ }
  return { caption, recordedAt };
}

export function withWatchPhotoDetails(jpeg, { caption, recordedAt }) {
  checkWatchJPEG(jpeg);
  if (typeof caption !== 'string' || !/^[\x20-\x7e]{0,24}$/.test(caption)) {
    throw new LocalizedError(tr('Use up to 24 ASCII characters for the caption.'));
  }
  const date = clockPayload(recordedAt).subarray(1, 6), body = new Uint8Array(29).fill(255);
  body.set(Array.from(caption, letter => letter.charCodeAt(0))); body.set(date, 24);
  const replacement = concat(b(255, 0xe2, 0, 31), body);
  const segments = headerSegments(jpeg).filter(casioSegment);
  if (!segments.length) return concat(jpeg.subarray(0, 2), replacement, jpeg.subarray(2));
  // Replace the first Casio marker and remove stale duplicates. Leave every
  // unrelated marker and all compressed image bytes untouched.
  const parts = []; let pos = 0;
  for (const [index, segment] of segments.entries()) {
    parts.push(jpeg.subarray(pos, segment.start));
    if (!index) parts.push(replacement);
    pos = segment.end;
  }
  parts.push(jpeg.subarray(pos)); return concat(...parts);
}

export function photoUpload(image, details = null) {
  const jpeg = image.previewJPEG || image.jpeg;
  if (details) return makeUPF(withWatchPhotoDetails(jpeg, details));
  return image.previewJPEG ? makeUPF(jpeg) : image.upf;
}
