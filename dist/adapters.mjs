import { SigmaTel, VID, PID } from './sigmatel.mjs';

const hexID = value => value.toString(16).padStart(4, '0');
export function describeUSBDevice(device) {
  const usbId = hexID(device.vendorId) + ':' + hexID(device.productId);
  const driver = device.vendorId === VID && device.productId === PID ? 'SigmaTel STIr4200' : null;
  const name = device.productName?.trim() || device.manufacturerName?.trim() || 'USB-устройство';
  return { name, usbId, label: name + ' · ' + usbId, driver, supported: Boolean(driver) };
}
export function createAdapter(device, options) {
  const info = describeUSBDevice(device);
  if (!info.supported) throw new Error(info.label + ': для этого адаптера пока нет драйвера.');
  return new SigmaTel(device, options);
}
