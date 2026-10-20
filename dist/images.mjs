import { LIMIT, checkWatchJPEG, makeUPF, jpegFromUPF, loadArchive, sha256, packSCEP, putCommand, toHex } from './formats.mjs';
import { normalizeWatchJPEG } from './jpeg.mjs';

export async function readableImage(image) {
  const normalized = normalizeWatchJPEG(image.jpeg);
  return { ...image, previewJPEG: normalized.changed ? normalized.jpeg : null,
    jpegSHA256: await sha256(normalized.jpeg), jpegRepaired: normalized.repaired };
}

export async function prepareRaster(blob, { fit = 'cover', quality = 0.7, rotate = 0 } = {}) {
  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch { throw new Error('Браузер не смог открыть картинку. Используй JPEG, PNG или WebP.'); }
  try {
    if (bitmap.width * bitmap.height > 100000000) throw new Error('Изображение слишком большое. Уменьши его перед импортом.');
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
    if (!blobJPEG) throw new Error('Не удалось подготовить JPEG.');
    const jpeg = new Uint8Array(await blobJPEG.arrayBuffer()); checkWatchJPEG(jpeg); return normalizeWatchJPEG(jpeg).jpeg;
  } finally { bitmap.close(); }
}
export async function imageFromFile(file, options = {}) {
  if (file.size > 32 * 1024 * 1024) throw new Error('Для импорта выбери файл меньше 32 МБ.');
  const extension = file.name.toLowerCase().split('.').at(-1);
  let upf, jpeg, archive = null;
  if (extension === 'wqv') {
    if (file.size > LIMIT * 3) throw new Error('Архив WQV слишком большой.');
    try { archive = JSON.parse(await file.text()); } catch { throw new Error('Неверный файл архива WQV.'); }
    upf = await loadArchive(archive); jpeg = jpegFromUPF(upf);
  } else if (extension === 'upf') {
    if (file.size > LIMIT) throw new Error('Файл UPF слишком большой.');
    upf = new Uint8Array(await file.arrayBuffer()); jpeg = jpegFromUPF(upf); checkWatchJPEG(jpeg);
  } else {
    const original = new Uint8Array(await file.arrayBuffer());
    let compatible = true;
    try { checkWatchJPEG(original); } catch { compatible = false; }
    jpeg = compatible ? normalizeWatchJPEG(original).jpeg : await prepareRaster(file, options);
    upf = makeUPF(jpeg);
  }
  const id = await sha256(jpeg), name = file.name.replace(/\.[^.]+$/, '');
  if (!archive) archive = { format: 'casio-wqv-transfer-v1', model: 3, filename: 'MC000001.UPF', jpeg_sha256: id,
    dimensions: [176, 144], packets: packSCEP(putCommand(upf, 'MC000001.UPF')).map(toHex) };
  return { id, name, jpeg, upf, archive, width: 176, height: 144, source: 'import', receivedAt: new Date().toISOString() };
}
export class LocalStore {
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('casio-wqv-webusb', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('images', { keyPath: 'id' }); request.result.createObjectStore('settings'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    }); return this;
  }
  async request(store, mode, action) {
    if (!this.db) throw new Error('Хранилище браузера недоступно. Экспортируй файлы перед закрытием вкладки.');
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode), request = action(tx.objectStore(store)); let value;
      request.onsuccess = () => { value = request.result; }; request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(value); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Хранилище прервало запись.'));
    });
  }
  images() { return this.request('images', 'readonly', s => s.getAll()); }
  saveImage(image) { return this.request('images', 'readwrite', s => s.put(image)); }
  removeImage(id) { return this.request('images', 'readwrite', s => s.delete(id)); }
  get(key) { return this.request('settings', 'readonly', s => s.get(key)); }
  set(key, value) { return this.request('settings', 'readwrite', s => s.put(value, key)); }
}
