import { decodeWQV12Record, wqv12PNG } from './wqv12-formats.mjs';
import { sha256 } from './formats.mjs';

export async function wqv2Image(record, { source = 'watch', receivedAt = new Date().toISOString() } = {}) {
  const decoded = decodeWQV12Record(record), hash = await sha256(record);
  return { id: hash, model: 'WQV-2', record: decoded.bytes, png: wqv12PNG(decoded.grey),
    title: decoded.title, titleHex: decoded.titleHex, dateHex: decoded.dateHex,
    dateOneBased: decoded.dateOneBased, dateZeroBased: decoded.dateZeroBased,
    width: 120, height: 120, source, receivedAt };
}
export const wqv2Filename = image => 'WQV2-' + image.id.slice(0, 12);
export function wqv2Files(image) {
  const name = wqv2Filename(image);
  const metadata = { model: image.model, sha256: image.id, title: image.title, titleHex: image.titleHex,
    dateHex: image.dateHex, dateOneBased: image.dateOneBased, dateZeroBased: image.dateZeroBased,
    dateInterpretationConfirmed: false, width: 120, height: 120 };
  return [{ name: name + '.bin', data: image.record }, { name: name + '.png', data: image.png },
    { name: name + '.json', data: new TextEncoder().encode(JSON.stringify(metadata, null, 2) + '\n') }];
}
