import { tr, LocalizedError } from './i18n.mjs';
import { LIMIT, checkWatchJPEG, makeUPF, jpegFromUPF, loadArchive, sha256, packSCEP, putCommand, toHex } from './formats.mjs';
import { normalizeWatchJPEG } from './jpeg.mjs';

// WQV-3 exports its 24-byte caption followed by five date bytes in APP2.
// Other APP2 formats (e.g. ICC profiles) are not watch captions.
export function watchCaption(jpeg) {
  if (jpeg[0] !== 255 || jpeg[1] !== 0xd8) return null;
  for (let pos = 2; pos + 4 <= jpeg.length;) {
    if (jpeg[pos] !== 255 || jpeg[pos + 1] === 0xda) break;
    const marker = jpeg[pos + 1], size = (jpeg[pos + 2] << 8) | jpeg[pos + 3], end = pos + 2 + size;
    if (size < 2 || end > jpeg.length) break;
    if (marker === 0xe2 && size === 31) {
      const bytes = jpeg.subarray(pos + 4, pos + 28);
      let length = bytes.length;
      while (length && [0, 32, 255].includes(bytes[length - 1])) length--;
      const title = bytes.subarray(0, length);
      if (length && title.every(byte => byte >= 32 && byte <= 126)) return String.fromCharCode(...title);
    }
    pos = end;
  }
  return null;
}

export const photoName = image => image.watchCaption || image.filename?.replace(/\.[^.]+$/, '') || image.name;
export const photoFilename = image => image.filename || image.archive?.filename || image.name;

export async function readableImage(image) {
  const normalized = normalizeWatchJPEG(image.jpeg);
  return { ...image, previewJPEG: normalized.changed ? normalized.jpeg : null,
    originalJPEGsha256: await sha256(image.jpeg), watchCaption: watchCaption(image.jpeg),
    jpegSHA256: await sha256(normalized.jpeg), jpegRepaired: normalized.repaired };
}

// A received/imported file is an album entry, even if another entry has the
// same JPEG. Keep checksums separate from identity. Reopening stored entries
// uses readableImage directly so their IDs (including legacy IDs) stay stable.
export async function newAlbumImage(image) {
  return readableImage({ ...image, id: crypto.randomUUID() });
}

export async function prepareRaster(blob, { fit = 'cover', quality = 0.7, rotate = 0 } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new LocalizedError(tr("The browser could not open this image. Use JPEG, PNG or WebP.")); }
  try {
    if (bitmap.width * bitmap.height > 100000000) throw new LocalizedError(tr("The image is too large. Resize it before importing."));
    const source = document.createElement('canvas'), swapped = rotate % 180 !== 0;
    source.width = swapped ? bitmap.height : bitmap.width; source.height = swapped ? bitmap.width : bitmap.height;
    const sc = source.getContext('2d'); sc.translate(source.width / 2, source.height / 2); sc.rotate(rotate * Math.PI / 180);
    sc.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    const canvas = document.createElement('canvas'); canvas.width = 176; canvas.height = 144;
    const ctx = canvas.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 176, 144);
    const scale = (fit === 'contain' ? Math.min : Math.max)(176 / source.width, 144 / source.height);
    const w = source.width * scale, h = source.height * scale;
    ctx.drawImage(source, (176 - w) / 2, (144 - h) / 2, w, h);
    const blobJPEG = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', Math.min(0.85, Math.max(0.3, quality))));
    if (!blobJPEG) throw new LocalizedError(tr("Could not prepare the JPEG."));
    const jpeg = new Uint8Array(await blobJPEG.arrayBuffer()); checkWatchJPEG(jpeg); return normalizeWatchJPEG(jpeg).jpeg;
  } finally { bitmap.close(); }
}
export async function imageFromFile(file, options = {}) {
  if (file.size > 32 * 1024 * 1024) throw new LocalizedError(tr("Choose a file smaller than 32 MB to import."));
  const extension = file.name.toLowerCase().split('.').at(-1);
  let upf, jpeg, archive = null;
  if (extension === 'wqv') {
    if (file.size > LIMIT * 3) throw new LocalizedError(tr("The WQV archive is too large."));
    try { archive = JSON.parse(await file.text()); } catch { throw new LocalizedError(tr("Invalid WQV archive file.")); }
    upf = await loadArchive(archive); jpeg = jpegFromUPF(upf);
  } else if (extension === 'upf') {
    if (file.size > LIMIT) throw new LocalizedError(tr("The UPF file is too large."));
    upf = new Uint8Array(await file.arrayBuffer()); jpeg = jpegFromUPF(upf); checkWatchJPEG(jpeg);
  } else {
    const original = new Uint8Array(await file.arrayBuffer());
    let compatible = true;
    try { checkWatchJPEG(original); } catch { compatible = false; }
    jpeg = compatible ? normalizeWatchJPEG(original).jpeg : await prepareRaster(file, options);
    upf = makeUPF(jpeg);
  }
  const id = await sha256(jpeg), filename = extension === 'wqv' ? archive.filename || file.name : file.name;
  const name = filename.replace(/\.[^.]+$/, '');
  if (!archive) archive = { format: 'casio-wqv-transfer-v1', model: 3, filename: 'MC000001.UPF', jpeg_sha256: id,
    dimensions: [176, 144], packets: packSCEP(putCommand(upf, 'MC000001.UPF')).map(toHex) };
  return { id, name, filename,
    jpeg, upf, archive, width: 176, height: 144, source: 'import', receivedAt: new Date().toISOString() };
}
export class LocalStore {
  constructor({ name = 'casio-wqv-webusb' } = {}) { this.name = name; }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('images', { keyPath: 'id' }); request.result.createObjectStore('settings'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); return this;
  }
  async request(store, mode, action) {
    if (!this.db) throw new LocalizedError(tr("Browser storage is unavailable. Export your files before closing this tab."));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode), request = action(tx.objectStore(store)); let value;
      request.onsuccess = () => { value = request.result; }; request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new LocalizedError(tr("The storage write was interrupted.")));
    });
  }
  images() { return this.request('images', 'readonly', s => s.getAll()); }
  saveImage(image) { return this.request('images', 'readwrite', s => s.put(image)); }
  removeImage(id) { return this.request('images', 'readwrite', s => s.delete(id)); }
  get(key) { return this.request('settings', 'readonly', s => s.get(key)); }
  set(key, value) { return this.request('settings', 'readwrite', s => s.put(value, key)); }
}
