import { tr, LocalizedError } from './i18n.mjs';
// PCLink2.exe: ordinal day index at 0040A2B0, 368 bits/year;
// packing at 0040BDA0: MSB first, active-low. Preserve all padding bits.
import { b, concat, toHex, fromHex } from './formats.mjs';
export const FIRST_YEAR = 2000, LAST_YEAR = 2039, CALENDAR_SIZE = 1840;
export const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
export const monthDays = (year, month) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
export function validDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) throw new LocalizedError(tr("The date must be between 1 January 2000 and 31 December 2039."));
}
export function clockPayload(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new LocalizedError(tr("Enter a date, hours and minutes."));
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  validDate(year, month, day);
  if (hour > 23 || minute > 59) throw new LocalizedError(tr("Invalid time."));
  // Native Set Clock copies six fields; CTime's tm_wday is Sunday=0.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return b(7, year - 2000, month, day, hour, minute, weekday);
}
export class HolidayCalendar {
  constructor(raw = new Uint8Array(CALENDAR_SIZE).fill(255)) {
    if (!(raw instanceof Uint8Array) || raw.length !== CALENDAR_SIZE) throw new LocalizedError(tr("The calendar must contain exactly 1840 bytes."));
    this.raw = raw.slice();
  }
  static fromBackup(backup) {
    if (backup?.format !== 'casio-wqv-holidays-v1') throw new LocalizedError(tr("Choose a WQV calendar file."));
    return new HolidayCalendar(fromHex(backup.data));
  }
  index(year, month, day) {
    validDate(year, month, day);
    let ordinal = day - 1;
    for (let m = 1; m < month; m++) ordinal += monthDays(year, m);
    return (year - FIRST_YEAR) * 368 + ordinal;
  }
  get(year, month, day) { const index = this.index(year, month, day); return !(this.raw[index >>> 3] & (0x80 >>> (index & 7))); }
  set(year, month, day, holiday) {
    const index = this.index(year, month, day), mask = 0x80 >>> (index & 7);
    if (holiday) this.raw[index >>> 3] &= ~mask;
    else this.raw[index >>> 3] |= mask;
  }
  markWeekdays(year, weekdays, holiday = true) {
    for (let m = 1; m <= 12; m++) for (let d = 1; d <= monthDays(year, m); d++) {
      if (weekdays.includes(new Date(Date.UTC(year, m - 1, d)).getUTCDay())) this.set(year, m, d, holiday);
    }
  }
  clear(year = null) {
    for (let y = year ?? FIRST_YEAR; y <= (year ?? LAST_YEAR); y++) {
      for (let m = 1; m <= 12; m++) for (let d = 1; d <= monthDays(y, m); d++) this.set(y, m, d, false);
    }
  }
  count(year = null) {
    let n = 0;
    for (let y = year ?? FIRST_YEAR; y <= (year ?? LAST_YEAR); y++) for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= monthDays(y, m); d++) if (this.get(y, m, d)) n++;
    }
    return n;
  }
  command() { return concat(b(8, 7, 0x30), this.raw); }
  backup() { return { format: 'casio-wqv-holidays-v1', savedAt: new Date().toISOString(), data: toHex(this.raw) }; }
}
