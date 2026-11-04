import { russian } from './translations.mjs';
import { japanese } from './translations-ja.mjs';
import { german } from './translations-de.mjs';
import { spanish } from './translations-es.mjs';
import { finnish } from './translations-fi.mjs';
import { driverTranslation } from './driver-translations.mjs';

export const LANGUAGE_KEY = 'wqv-online.language';
export const languages = Object.freeze(['en', 'ru', 'ja', 'de', 'es', 'fi']);
const locales = { en: 'en-US', ru: 'ru-RU', ja: 'ja-JP', de: 'de-DE', es: 'es-ES', fi: 'fi-FI' };
const translations = { ru: russian, ja: japanese, de: german, es: spanish, fi: finnish };
const listeners = new Set();
function browserStorage() { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } }
export function readLanguage(storage = browserStorage()) {
  try { const saved = storage?.getItem(LANGUAGE_KEY); return languages.includes(saved) ? saved : 'en'; }
  catch { return 'en'; }
}
let language = readLanguage();
export const getLanguage = () => language;
export const locale = () => locales[language];
export function setLanguage(next, { storage = browserStorage(), persist = true } = {}) {
  if (!languages.includes(next)) throw new RangeError('Unknown display language: ' + next);
  if (persist) { try { storage?.setItem(LANGUAGE_KEY, next); } catch {} }
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener(next);
}
export function onLanguageChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

const nouns = {
  drivers: { en: { one: 'driver', other: 'drivers' }, ru: { one: 'драйвер', few: 'драйвера', many: 'драйверов', other: 'драйвера' }, ja: { other: 'ドライバー' }, de: { one: 'Treiber', other: 'Treiber' }, es: { one: 'controlador', other: 'controladores' }, fi: { one: 'ajuri', other: 'ajuria' } },
  photos: { en: { one: 'photo', other: 'photos' }, ru: { one: 'снимок', few: 'снимка', many: 'снимков', other: 'снимка' }, ja: { other: '枚' }, de: { one: 'Foto', other: 'Fotos' }, es: { one: 'foto', other: 'fotos' }, fi: { one: 'kuva', other: 'kuvaa' } },
  days: { en: { one: 'day', other: 'days' }, ru: { one: 'день', few: 'дня', many: 'дней', other: 'дня' }, ja: { other: '日' }, de: { one: 'Tag', other: 'Tage' }, es: { one: 'día', other: 'días' }, fi: { one: 'päivä', other: 'päivää' } },
  files: { en: { one: 'file', other: 'files' }, ru: { one: 'файл', few: 'файла', many: 'файлов', other: 'файла' }, ja: { other: 'ファイル' }, de: { one: 'Datei', other: 'Dateien' }, es: { one: 'archivo', other: 'archivos' }, fi: { one: 'tiedosto', other: 'tiedostoa' } },
  dates: { en: { one: 'date', other: 'dates' }, ru: { one: 'дата', few: 'даты', many: 'дат', other: 'даты' }, ja: { other: '件' }, de: { one: 'Datum', other: 'Datumsangaben' }, es: { one: 'fecha', other: 'fechas' }, fi: { one: 'päivämäärä', other: 'päivämäärää' } },
};
class Message {
  constructor(key, values, noun = null) { this.key = key; this.values = values; this.noun = noun; }
  toString() {
    if (this.noun) {
      const count = this.values[0], words = nouns[this.noun][language];
      return count + (language === 'ja' ? '' : ' ') + (words[new Intl.PluralRules(locale()).select(count)] || words.other);
    }
    const dictionary = translations[language];
    const template = dictionary && Object.hasOwn(dictionary, this.key) ? dictionary[this.key] : driverTranslation(language, this.key) ?? this.key;
    return template.replace(/\{(\d+)\}/g, (match, index) => index < this.values.length ? formatText(this.values[index]) : match);
  }
  toJSON() { return this.toString(); }
}
// Keep messages as data until display, so existing logs and progress also change language.
export const tr = (key, ...values) => new Message(key, values);
export function quantity(count, noun) {
  if (!Object.hasOwn(nouns, noun)) throw new RangeError('Unknown count noun: ' + noun);
  return new Message('', [count], noun);
}
export const formatNumber = (value, options) => new Intl.NumberFormat(locale(), options).format(value);
export function formatText(value) {
  if (value instanceof Error || (value && typeof value === 'object' && typeof value.message === 'string')) return value.message;
  return value == null ? '' : String(value);
}
export class LocalizedError extends Error {
  constructor(message) {
    super();
    Object.defineProperty(this, 'message', { configurable: true, get: () => formatText(message) });
  }
}

export function translateDOM(root = document) {
  const elements = selector => [...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector)];
  for (const element of elements('[data-i18n]')) {
    // Translate the direct text node; leave icons, inputs and status elements in place.
    const text = [...element.childNodes].find(node => node.nodeType === 3 && node.nodeValue.trim());
    if (text) {
      const leading = text.nodeValue.match(/^\s*/)[0], trailing = text.nodeValue.match(/\s*$/)[0];
      text.nodeValue = leading + formatText(tr(element.dataset.i18n)) + trailing;
    }
    else if (!element.children.length) element.textContent = formatText(tr(element.dataset.i18n));
  }
  for (const attribute of ['title', 'aria-label', 'alt']) {
    for (const element of elements('[data-i18n-' + attribute + ']')) {
      element.setAttribute(attribute, formatText(tr(element.getAttribute('data-i18n-' + attribute))));
    }
  }
  if (root.documentElement) root.documentElement.lang = language;
}
