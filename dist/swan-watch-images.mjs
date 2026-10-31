import { b, concat, sha256, makeUPF, packSCEP, putCommand, toHex, fromHex } from './formats.mjs';
import { checkSwanRecord, swanDetails, swanRGBA, swanFromRGBA, withSwanDetails } from './swan-watch-formats.mjs';
import { watchPhotoDetails } from './wqv3-photo-details.mjs';

const canvas = () => Object.assign(document.createElement('canvas'), { width: 176, height: 144 });
export async function swanImage(record, { filename = 'SW000001.BIN', source = 'watch' } = {}) {
  checkSwanRecord(record);
  const surface = canvas(), ctx = surface.getContext('2d', { alpha: false });
  const pixels = ctx.createImageData(176, 144); pixels.data.set(swanRGBA(record)); ctx.putImageData(pixels, 0, 0);
  const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('Could not prepare the SWAN preview.');
  const encoded = new Uint8Array(await blob.arrayBuffer());
  // The JPEG is a derived preview/export. The complete lossless SWAN record
  // is retained separately, including unsupported/undefined metadata bytes.
  const jpeg = concat(encoded.slice(0, 2), b(255, 0xe2, 0, 31), record.slice(0, 29), encoded.slice(2));
  const upf = makeUPF(jpeg), details = swanDetails(record), id = await sha256(jpeg);
  return { id, name: filename.replace(/\.[^.]+$/, ''), filename, jpeg, upf, width: 176, height: 144,
    source, protocol: 'swan', swanRecord: record.slice(), receivedAt: new Date().toISOString(),
    archive: { format: 'casio-wqv-transfer-v1', model: 3, filename, sourceProtocol: 'swan',
      jpeg_sha256: id, dimensions: [176, 144], packets: packSCEP(putCommand(upf, 'SW000001.UPF')).map(toHex),
      swan: { format: 'casio-wqv-swan-record-v1', recordHex: toHex(record), sha256: await sha256(record), ...details } } };
}
export async function swanArchiveRecord(archive) {
  const data = archive?.swan;
  if (data?.format !== 'casio-wqv-swan-record-v1' || typeof data.recordHex !== 'string' || !/^[0-9a-f]{50746}$/i.test(data.recordHex)) throw new Error('Invalid SWAN record archive.');
  const record = fromHex(data.recordHex); checkSwanRecord(record);
  if (await sha256(record) !== data.sha256) throw new Error('SWAN archive checksum does not match.');
  return record;
}
export async function swanSendRecord(image, editedDetails = null) {
  if (image.swanRecord) return editedDetails ? withSwanDetails(image.swanRecord, editedDetails) : checkSwanRecord(image.swanRecord).slice();
  const metadata = watchPhotoDetails(image.jpeg), name = image.watchCaption || image.name || '';
  const now = new Date(), pad = v => String(v).padStart(2, '0');
  const details = editedDetails ?? { caption: /^[\x20-\x7e]{0,24}$/.test(name) ? name : '',
    recordedAt: metadata.recordedAt ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}` };
  const bitmap = await createImageBitmap(new Blob([image.previewJPEG || image.jpeg], { type: 'image/jpeg' }));
  try {
    const surface = canvas(), ctx = surface.getContext('2d', { alpha: false });
    ctx.drawImage(bitmap, 0, 0, 176, 144);
    return swanFromRGBA(ctx.getImageData(0, 0, 176, 144).data, details);
  } finally { bitmap.close(); }
}
