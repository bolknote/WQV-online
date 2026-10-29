import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUSBDevice, createAdapter } from '../dist/adapters.mjs';
import { SigmaTel } from '../dist/sigmatel.mjs';
import { Kingsun } from '../dist/kingsun.mjs';

test('the USB device supplies its display name; the USB ID selects support', () => {
  const device = { vendorId: 0x066f, productId: 0x4200, productName: '  IrDA/USB Bridge  ' };
  const info = describeUSBDevice(device);
  assert.equal(info.label, 'IrDA/USB Bridge · 066f:4200');
  assert.equal(info.supported, true);
  assert.ok(createAdapter(device) instanceof SigmaTel);
  assert.equal(describeUSBDevice({ ...device, productName: 'Another brand' }).name, 'Another brand');
});
test('an adapter without product strings is identified by its real USB ID', () => {
  const info = describeUSBDevice({ vendorId: 0x18ec, productId: 0x3118, productName: '  ' });
  assert.equal(info.label, 'USB device · 18ec:3118');
  assert.equal(info.supported, false);
});
test('KingSun support requires its exact USB ID and keeps the manufacturer product name', () => {
  const device = { vendorId: 0x07d0, productId: 0x4959, productName: 'USB to IRDA' };
  assert.equal(describeUSBDevice(device).label, 'USB to IRDA · 07d0:4959');
  assert.equal(describeUSBDevice(device).driver, 'KingSun KS-959');
  assert.ok(createAdapter(device) instanceof Kingsun);
  assert.equal(describeUSBDevice({ ...device, vendorId: 0x066f }).supported, false);
});
test('selecting another adapter never opens it or sends SigmaTel commands', () => {
  let calls = 0;
  const other = { vendorId: 0x18ec, productId: 0x3118, productName: 'ARK3116T',
    open() { calls++; }, controlTransferOut() { calls++; } };
  assert.equal(describeUSBDevice(other).label, 'ARK3116T · 18ec:3118');
  assert.throws(() => createAdapter(other), /18ec:3118/);
  assert.equal(calls, 0);
  assert.equal(describeUSBDevice({ ...other, vendorId: 0x066f }).supported, false);
});
