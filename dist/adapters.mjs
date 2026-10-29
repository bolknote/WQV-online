import { tr, LocalizedError } from './i18n.mjs';
import { SigmaTel, VID, PID } from './sigmatel.mjs';
import { Kingsun, VID as KVID, PID as KPID } from './kingsun.mjs';

const hexID = value => value.toString(16).padStart(4, '0');
export function describeUSBDevice(device) {
  const usbId = hexID(device.vendorId) + ':' + hexID(device.productId);
  const driver = device.vendorId === VID && device.productId === PID ? 'SigmaTel STIr4200' :
    device.vendorId === KVID && device.productId === KPID ? 'KingSun KS-959' : null;
  const name = device.productName?.trim() || device.manufacturerName?.trim() || String(tr("USB device"));
  return { name, usbId, label: name + ' · ' + usbId, driver, supported: Boolean(driver) };
}
export function createAdapter(device, options) {
  const info = describeUSBDevice(device);
  if (!info.supported) throw new LocalizedError(tr("{0}: no driver is available for this adapter yet.", info.label));
  return info.driver === 'KingSun KS-959' ? new Kingsun(device, options) : new SigmaTel(device, options);
}
