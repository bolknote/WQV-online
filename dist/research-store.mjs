export function openResearchStore(name = 'wqv-command-research') {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('attempts', { keyPath: 'id' });
      request.result.createObjectStore('events', { keyPath: ['attemptId', 'seq'] });
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other research tabs to open the journal.'));
    request.onsuccess = () => resolve(new ResearchStore(request.result));
  });
}
export class ResearchStore {
  constructor(db) { this.db = db; }
  write(storeName, values) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      for (const value of values) tx.objectStore(storeName).put(value);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('Journal transaction aborted.'));
    });
  }
  read(storeName, range) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName), request = tx.objectStore(storeName).getAll(range);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  attempts() { return this.read('attempts'); }
  events(id) { return this.read('events', IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])); }
  save(attempt) { return this.write('attempts', [attempt]); }
}

export class Journal {
  constructor(store, attempt, onError = () => {}) {
    this.store = store; this.attempt = attempt; this.onError = onError;
    this.events = []; this.saved = 0; this.error = null; this.writing = null;
    this.started = performance.now();
    this.record = this.record.bind(this);
  }
  record(kind, details = {}) {
    this.events.push({ ...details, kind, attemptId: this.attempt.id, seq: this.events.length,
      at: new Date().toISOString(), elapsedMs: performance.now() - this.started });
  }
  async flush() {
    if (this.writing) return this.writing;
    if (this.error) throw this.error;
    const end = this.events.length;
    if (end === this.saved) return;
    this.writing = this.store.write('events', this.events.slice(this.saved, end))
      .then(() => { this.saved = end; })
      .catch(error => { this.error = error; this.onError(error); throw error; })
      .finally(() => { this.writing = null; });
    return this.writing;
  }
  async drain() {
    do { await this.flush(); } while (this.saved < this.events.length);
  }
}
