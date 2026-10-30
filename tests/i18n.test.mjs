import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_KEY, readLanguage, getLanguage, setLanguage, onLanguageChange,
  tr, quantity, locale, formatNumber, formatText, LocalizedError } from '../dist/i18n.mjs';
import { russian } from '../dist/translations.mjs';
import { japanese } from '../dist/translations-ja.mjs';
import { clockPayload } from '../dist/calendar.mjs';

afterEach(() => setLanguage('en', { persist: false }));

test('English is the default; only an explicit saved language changes it', () => {
  assert.equal(getLanguage(), 'en');
  for (const saved of [null, '', 'fr', 'RU', '{"language":"ru"}']) {
    assert.equal(readLanguage({ getItem: () => saved }), 'en');
  }
  assert.equal(readLanguage({ getItem: () => 'ru' }), 'ru');
  assert.equal(readLanguage({ getItem: () => 'ja' }), 'ja');
  assert.equal(readLanguage({ getItem() { throw new Error('storage blocked'); } }), 'en');
});

test('the chosen language persists, and one change emits one notification', () => {
  const saved = new Map(), changes = [];
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const unsubscribe = onLanguageChange(value => changes.push(value));
  try {
    setLanguage('ru', { storage });
    setLanguage('ru', { storage });
    assert.equal(saved.get(LANGUAGE_KEY), 'ru');
    assert.equal(readLanguage(storage), 'ru');
    assert.deepEqual(changes, ['ru']);
    setLanguage('ja', { storage });
    assert.equal(saved.get(LANGUAGE_KEY), 'ja');
    assert.equal(readLanguage(storage), 'ja');
    assert.deepEqual(changes, ['ru', 'ja']);
  } finally { unsubscribe(); }
});

test('existing messages and nested counts translate without recreating the operation', () => {
  const message = tr('Received: {0}', quantity(21, 'photos'));
  assert.equal(String(message), 'Received: 21 photos');
  setLanguage('ru', { persist: false });
  assert.equal(String(message), 'Получено: 21 снимок');
  assert.equal(JSON.stringify({ message }), '{"message":"Получено: 21 снимок"}');
  setLanguage('ja', { persist: false });
  assert.equal(String(message), '受信: 21枚');
  setLanguage('en', { persist: false });
  assert.equal(String(message), 'Received: 21 photos');
});

test('Russian counts distinguish one, few, many, and the teen exceptions', () => {
  const values = [0, 1, 2, 5, 11, 21, 22, 25, 101];
  assert.deepEqual(values.map(n => String(quantity(n, 'photos'))),
    ['0 photos', '1 photo', '2 photos', '5 photos', '11 photos', '21 photos', '22 photos', '25 photos', '101 photos']);
  setLanguage('ru', { persist: false });
  assert.deepEqual(values.map(n => String(quantity(n, 'photos'))),
    ['0 снимков', '1 снимок', '2 снимка', '5 снимков', '11 снимков', '21 снимок', '22 снимка', '25 снимков', '101 снимок']);
  assert.equal(String(quantity(2, 'days')), '2 дня');
  assert.equal(String(quantity(5, 'files')), '5 файлов');
});

test('Japanese counters join the number and suffix without English spacing or plural forms', () => {
  setLanguage('ja', { persist: false });
  assert.deepEqual([0, 1, 2, 21].map(n => String(quantity(n, 'photos'))), ['0枚', '1枚', '2枚', '21枚']);
  assert.equal(String(quantity(2, 'days')), '2日');
  assert.equal(String(quantity(5, 'files')), '5ファイル');
  assert.equal(String(quantity(3, 'dates')), '3件');
});

test('dates and numbers follow the selected display language', () => {
  const date = new Date(Date.UTC(2026, 9, 20));
  assert.equal(date.toLocaleString(locale(), { month: 'long', timeZone: 'UTC' }), 'October');
  assert.equal(formatNumber(12.5), '12.5');
  setLanguage('ru', { persist: false });
  assert.equal(date.toLocaleString(locale(), { month: 'long', timeZone: 'UTC' }), 'октябрь');
  assert.equal(formatNumber(12.5), '12,5');
  setLanguage('ja', { persist: false });
  assert.equal(locale(), 'ja-JP');
  assert.equal(date.toLocaleString(locale(), { month: 'long', timeZone: 'UTC' }), '10月');
  assert.equal(formatNumber(12345.5), '12,345.5');
});

test('errors retain Error behavior and translate when read in another language', () => {
  let error;
  try { clockPayload('2040-01-01T12:00'); } catch (caught) { error = caught; }
  assert.ok(error instanceof Error);
  assert.match(error.message, /1 January 2000/);
  const log = tr('Closing session: {0}', error);
  setLanguage('ru', { persist: false });
  assert.match(error.message, /01\.01\.2000/);
  assert.match(String(log), /^Завершение сеанса: Дата должна/);
  assert.equal(formatText(new Error('USB pipe failed')), 'USB pipe failed');
  const timeout = new LocalizedError(tr('Timeout: {0}. Disconnect and reconnect USB.', tr('opening USB')));
  assert.match(timeout.message, /Тайм-аут: открытие USB/);
  setLanguage('ja', { persist: false });
  assert.match(error.message, /2000年1月1日/);
  assert.equal(timeout.message, 'タイムアウト: USBの接続。USBを接続し直してください。');
});

test('blocked persistence still allows switching, and unsupported languages leave state intact', () => {
  setLanguage('ru', { storage: { setItem() { throw new Error('storage blocked'); } } });
  assert.equal(getLanguage(), 'ru');
  assert.throws(() => setLanguage('de'), RangeError);
  assert.equal(getLanguage(), 'ru');
  assert.equal(String(tr('Photo {0}', '{1}<img>')), 'Снимок {1}<img>');
});

test('translations preserve every message substitution', () => {
  for (const dictionary of [russian, japanese]) for (const [english, translation] of Object.entries(dictionary)) {
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(translation), placeholders(english), english);
  }
});

test('Japanese covers the complete message catalog, including clock, calendar and transfer guidance', () => {
  assert.deepEqual(Object.keys(japanese).sort(), Object.keys(russian).sort());
  assert.ok(Object.values(japanese).every(value => typeof value === 'string' && value.trim()));
  setLanguage('ja', { persist: false });
  assert.equal(String(tr('Start')), 'スタート');
  assert.equal(String(tr('Holiday calendar')), '休日カレンダー');
  assert.equal(String(tr('Press the front button on the watch now.')), '時計の前面ボタンを押してください。');
  assert.equal(String(tr('Untranslated native error')), 'Untranslated native error');
});
