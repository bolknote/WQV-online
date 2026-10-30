import { russian } from './translations.mjs';
import { japanese } from './translations-ja.mjs';

export const LANGUAGE_KEY = 'wqv-online.language';
export const languages = Object.freeze(['en', 'ru', 'ja']);
const locales = { en: 'en-US', ru: 'ru-RU', ja: 'ja-JP' };
const translations = { ru: russian, ja: japanese };
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
  photos: { en: { one: 'photo', other: 'photos' }, ru: { one: 'снимок', few: 'снимка', many: 'снимков', other: 'снимка' }, ja: { other: '枚' } },
  days: { en: { one: 'day', other: 'days' }, ru: { one: 'день', few: 'дня', many: 'дней', other: 'дня' }, ja: { other: '日' } },
  files: { en: { one: 'file', other: 'files' }, ru: { one: 'файл', few: 'файла', many: 'файлов', other: 'файла' }, ja: { other: 'ファイル' } },
  dates: { en: { one: 'date', other: 'dates' }, ru: { one: 'дата', few: 'даты', many: 'дат', other: 'даты' }, ja: { other: '件' } },
};
class Message {
  constructor(key, values, noun = null) { this.key = key; this.values = values; this.noun = noun; }
  toString() {
    if (this.noun) {
      const count = this.values[0], words = nouns[this.noun][language];
      return count + (language === 'ja' ? '' : ' ') + (words[new Intl.PluralRules(locale()).select(count)] || words.other);
    }
    const dictionary = translations[language];
    const template = dictionary && Object.hasOwn(dictionary, this.key) ? dictionary[this.key] : this.key;
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
