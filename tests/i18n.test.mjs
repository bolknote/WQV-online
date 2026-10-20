import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_KEY, readLanguage, getLanguage, setLanguage, onLanguageChange,
  tr, quantity, locale, formatNumber, formatText, LocalizedError } from '../dist/i18n.mjs';
import { russian } from '../dist/translations.mjs';
import { clockPayload } from '../dist/calendar.mjs';

afterEach(() => setLanguage('en', { persist: false }));

test('English is the default; only an explicit saved language changes it', () => {
  assert.equal(getLanguage(), 'en');
  for (const saved of [null, '', 'fr', 'RU', '{"language":"ru"}']) {
    assert.equal(readLanguage({ getItem: () => saved }), 'en');
  }
  assert.equal(readLanguage({ getItem: () => 'ru' }), 'ru');
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
  } finally { unsubscribe(); }
});

test('existing messages and nested counts translate without recreating the operation', () => {
  const message = tr('Received: {0}', quantity(21, 'photos'));
  assert.equal(String(message), 'Received: 21 photos');
  setLanguage('ru', { persist: false });
  assert.equal(String(message), 'Получено: 21 снимок');
  assert.equal(JSON.stringify({ message }), '{"message":"Получено: 21 снимок"}');
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

test('dates and numbers follow the selected display language', () => {
  const date = new Date(Date.UTC(2026, 9, 20));
  assert.equal(date.toLocaleString(locale(), { month: 'long', timeZone: 'UTC' }), 'October');
  assert.equal(formatNumber(12.5), '12.5');
  setLanguage('ru', { persist: false });
  assert.equal(date.toLocaleString(locale(), { month: 'long', timeZone: 'UTC' }), 'октябрь');
  assert.equal(formatNumber(12.5), '12,5');
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
});

test('blocked persistence still allows switching, and unsupported languages leave state intact', () => {
  setLanguage('ru', { storage: { setItem() { throw new Error('storage blocked'); } } });
  assert.equal(getLanguage(), 'ru');
  assert.throws(() => setLanguage('de'), RangeError);
  assert.equal(getLanguage(), 'ru');
  assert.equal(String(tr('Photo {0}', '{1}<img>')), 'Снимок {1}<img>');
});

test('translations preserve every message substitution', () => {
  for (const [english, translation] of Object.entries(russian)) {
    const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(translation), placeholders(english), english);
  }
});
