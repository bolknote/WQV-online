import { identifyDriver, sourceDigest, normalizeDriverPath } from './driver-catalog.mjs';

const DATABASE = 'wqv-online-drivers', STORE = 'drivers';
const MAX_SOURCE = 512 * 1024, MAX_FILES = 2 * 1024 * 1024;
export class DriverStore {
  constructor(indexedDB = globalThis.indexedDB) { this.indexedDB = indexedDB; this.database = null; }
  async open() {
    if (!this.indexedDB) throw new Error('Browser storage is unavailable.');
    if (!this.database) this.database = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); this.database = null; }; resolve(request.result); };
      request.onerror = () => { this.database = null; reject(request.error); };
      request.onblocked = () => { this.database = null; reject(new Error('Close the other driver window and try again.')); };
    });
    return this.database;
  }
  async transaction(mode, operation) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode), store = transaction.objectStore(STORE);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Driver storage operation failed.'));
      try { operation(store, value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }
  list() { return this.transaction('readonly', (store, done) => { const request = store.getAll(); request.onsuccess = () => done(request.result.sort((a, b) => a.name.localeCompare(b.name))); }); }
  get(id) { return this.transaction('readonly', (store, done) => { const request = store.get(id); request.onsuccess = () => done(request.result ?? null); }); }
  remove(id) { return this.transaction('readwrite', store => store.delete(id)); }
  async saveSource({ id = crypto.randomUUID(), filename, source, files = {}, provenance = null }) {
    if (typeof source !== 'string' || new TextEncoder().encode(source).length > MAX_SOURCE) throw new Error('The C source is too large (maximum 512 KiB).');
    filename = normalizeDriverPath(filename);
    const normalized = {};
    let size = 0;
    for (const [path, content] of Object.entries(files)) {
      if (typeof content !== 'string') throw new TypeError('Headers must be text files.');
      size += new TextEncoder().encode(content).length;
      if (size > MAX_FILES) throw new Error('Additional files exceed 2 MiB.');
      normalized[normalizeDriverPath(path)] = content;
    }
    const profile = identifyDriver(source), sha256 = await sourceDigest(source), previous = await this.get(id);
    const inputSHA256 = await sourceDigest(source + '\u0000' + JSON.stringify(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
    const sameFiles = previous && JSON.stringify(previous.files) === JSON.stringify(normalized);
    const record = { id, filename, source, files: normalized, sha256, inputSHA256, profile: profile?.id ?? null,
      name: profile?.name ?? filename, provenance, createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(),
      artifact: previous?.sha256 === sha256 && sameFiles ? previous.artifact : null, buildError: null };
    await this.transaction('readwrite', store => store.put(record));
    return record;
  }
  async saveBuild(id, sha256, artifact, error = null, inputSHA256 = artifact?.inputSHA256) {
    return this.transaction('readwrite', (store, done) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result;
        // A late compiler result must not reinstall a deleted or replaced source.
        if (!record || record.sha256 !== sha256 || inputSHA256 && record.inputSHA256 !== inputSHA256) { done(false); return; }
        if (artifact) record.artifact = artifact;
        record.buildError = error; record.updatedAt = Date.now();
        store.put(record); done(true);
      };
    });
  }
}
export const driverStore = new DriverStore();
