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

export const COLOUR_CALENDAR_SIZE = 7305;
export const DATE_COLOURS = Object.freeze(['Standard', 'Blue', 'Red', 'Green']);

// PCLink3.exe 0040A0E0: all dates in 2000–2019 occupy the low nibbles,
// followed by 2020–2039 in the high nibbles of the same 7305 bytes.
// Its drawing table at 0040A8E4 maps 0/1/2/3 to standard/blue/red/green.
export class ColourCalendar extends HolidayCalendar {
  constructor(raw = new Uint8Array(COLOUR_CALENDAR_SIZE)) {
    // Inherit date operations, without applying the WQV-3 wire-size check.
    super();
    if (!(raw instanceof Uint8Array) || raw.length !== COLOUR_CALENDAR_SIZE) throw new LocalizedError(tr('The calendar must contain exactly {0} bytes.', COLOUR_CALENDAR_SIZE));
    this.raw = raw.slice();
  }
  static fromBackup(backup) {
    if (backup?.format !== 'casio-wqv10-calendar-v1') throw new LocalizedError(tr('Choose a {0} calendar file.', 'WQV-10'));
    return new ColourCalendar(fromHex(backup.data));
  }
  index(year, month, day) {
    validDate(year, month, day);
    let ordinal = day - 1;
    for (let y = FIRST_YEAR; y < year; y++) ordinal += leap(y) ? 366 : 365;
    for (let m = 1; m < month; m++) ordinal += monthDays(year, m);
    return ordinal;
  }
  get(year, month, day) {
    const index = this.index(year, month, day), shift = index < COLOUR_CALENDAR_SIZE ? 0 : 4;
    return (this.raw[index % COLOUR_CALENDAR_SIZE] >>> shift) & 15;
  }
  set(year, month, day, colour) {
    if (!Number.isInteger(colour) || colour < 0 || colour > 3) throw new RangeError('Expected a calendar colour from 0 to 3.');
    const index = this.index(year, month, day), offset = index % COLOUR_CALENDAR_SIZE;
    const shift = index < COLOUR_CALENDAR_SIZE ? 0 : 4;
    this.raw[offset] = (this.raw[offset] & ~(15 << shift)) | (colour << shift);
  }
  markWeekdays(year, weekdays, colour = 1) { super.markWeekdays(year, weekdays, colour); }
  clear(year = null) {
    for (let y = year ?? FIRST_YEAR; y <= (year ?? LAST_YEAR); y++) {
      for (let m = 1; m <= 12; m++) for (let d = 1; d <= monthDays(y, m); d++) this.set(y, m, d, 0);
    }
  }
  command() { return concat(b(8, 0x1c, 0x89), this.raw); }
  backup() { return { format: 'casio-wqv10-calendar-v1', savedAt: new Date().toISOString(), data: toHex(this.raw) }; }
}
