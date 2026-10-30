import { sha256 } from './formats.mjs';
import { photoName, photoFilename } from './images.mjs';

export const safePhotoName = name => (name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_').slice(0, 45) || 'WQV');

export async function collectionFiles(images, savedAt = new Date().toISOString()) {
  const encoder = new TextEncoder(), files = [], manifest = [];
  for (const [index, image] of images.entries()) {
    // Number every entry: repeated names and repeated JPEGs must survive ZIP
    // export too, including albums written by earlier versions of the client.
    const base = String(index + 1).padStart(3, '0') + '_' + safePhotoName(photoName(image));
    files.push({ name: base + '.jpg', data: image.previewJPEG || image.jpeg }, { name: base + '.upf', data: image.upf },
      { name: base + '.wqv', data: encoder.encode(JSON.stringify(image.archive, null, 2)) });
    manifest.push({ id: image.id, name: photoName(image), caption: image.watchCaption || null, filename: photoFilename(image),
      jpeg: base + '.jpg', upf: base + '.upf', archive: base + '.wqv',
      sha256: await sha256(image.previewJPEG || image.jpeg), originalJPEGsha256: await sha256(image.jpeg),
      jpegRepaired: Boolean(image.jpegRepaired) });
  }
  files.push({ name: 'collection.json', data: encoder.encode(JSON.stringify({ format: 'casio-wqv-collection-v1', savedAt, images: manifest }, null, 2)) });
  return files;
}
