// A working USB transport belongs to this device, build and browser.
// A timeout alone is not proof that a helper is required.
const PREFIX = 'wqv-online.driver-access.';
const memory = new Map();
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
function identity(record, device) {
  return JSON.stringify([device.vendorId, device.productId, device.serialNumber ?? '', record.profile,
    record.inputSHA256, record.artifact?.builtAt ?? 0, globalThis.navigator?.userAgent ?? '']);
}
export function readDriverAccess(record, device, storage = browserStorage()) {
  const key = PREFIX + identity(record, device);
  try { const method = storage?.getItem(key); if (method === 'direct' || method === 'helper') return method; } catch {}
  return memory.get(key) ?? 'auto';
}
export function rememberDriverAccess(record, device, method, storage = browserStorage()) {
  if (!['direct', 'helper'].includes(method)) throw new RangeError('Unknown USB access method');
  const key = PREFIX + identity(record, device); memory.set(key, method);
  try { storage?.setItem(key, method); } catch {}
}
export function canTryUSBHelper(error) {
  return ['helper-needed', 'initialization-failed'].includes(error?.code);
}
