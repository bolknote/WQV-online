import test from 'node:test';
import assert from 'node:assert/strict';
import { driverLogMessage } from '../dist/driver-log.mjs';
import { driverTranslation } from '../dist/driver-translations.mjs';

test('the visible journal describes stages without changing original event data', () => {
  const raw = { kind: 'module-loaded', bytes: 1234, imports: [{ module: 'env', name: 'host_submit', kind: 'function' }] };
  const saved = structuredClone(raw);
  assert.deepEqual(driverLogMessage(raw), { key: 'Driver loaded.', values: [] });
  assert.equal(driverLogMessage({ direction: 'out', dataHex: 'ab12', request: { request: 3 } }), null);
  assert.deepEqual(raw, saved);
});

test('access failures remain distinct from driver and USB-release failures', () => {
  assert.equal(driverLogMessage({ kind: 'check-failed', code: 'helper-needed' }).key, 'Blocked by WebUSB');
  assert.equal(driverLogMessage({ kind: 'check-failed', code: 'helper-unavailable' }).key, 'USB Helper unavailable');
  assert.equal(driverLogMessage({ kind: 'check-failed', code: 'initialization-failed' }).key, 'USB check failed');
  assert.deepEqual(driverLogMessage({ kind: 'check-cleanup-failed', message: 'timeout' }), { key: 'Could not release USB: {0}', values: ['timeout'] });
});

test('journal stages are translated in every desktop language', () => {
  const events = [{kind:'device-selected'}, {kind:'check-started',transport:'direct'}, {kind:'check-started',transport:'helper'},
    {kind:'module-loaded'}, {kind:'usb-opening'}, {kind:'driver-opened'}, {kind:'check-passed'}, {kind:'check-failed'},
    {kind:'usb-released'}, {kind:'check-cleanup-failed'}, {kind:'driver-built'}, {kind:'build-error'}, {kind:'error'}];
  for (const language of ['ru','ja','de','es','fi']) for (const event of events) {
    const key = driverLogMessage(event).key;
    assert.equal(typeof driverTranslation(language, key), 'string', language + ': ' + key);
  }
});
