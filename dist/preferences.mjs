export const WEEK_START_KEY = 'wqv-online.week-start';
const listeners = new Set();
function browserStorage() { try { return globalThis.window?.localStorage; } catch { return undefined; } }
export function readWeekStart(storage = browserStorage()) {
  try { return storage?.getItem(WEEK_START_KEY) === 'sun' ? 'sun' : 'mon'; }
  catch { return 'mon'; }
}
let weekStart = readWeekStart();
export const getWeekStart = () => weekStart;
export function setWeekStart(next, { storage = browserStorage(), persist = true } = {}) {
  if (!['mon', 'sun'].includes(next)) throw new RangeError('Unknown first day of week: ' + next);
  if (persist) { try { storage?.setItem(WEEK_START_KEY, next); } catch {} }
  if (next === weekStart) return;
  weekStart = next;
  for (const listener of listeners) listener(next);
}
export function onWeekStartChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
globalThis.window?.addEventListener('storage', event => {
  if (event.key === WEEK_START_KEY || event.key === null) setWeekStart(readWeekStart(), { persist: false });
});

export function weekdayOrder(start = 'mon') {
  if (!['mon', 'sun'].includes(start)) throw new RangeError('Unknown first day of week: ' + start);
  return Array.from({ length: 7 }, (_, i) => (i + (start === 'mon' ? 1 : 0)) % 7);
}
export function monthOffset(year, month, start = 'mon') {
  return weekdayOrder(start).indexOf(new Date(Date.UTC(year, month - 1, 1)).getUTCDay());
}
