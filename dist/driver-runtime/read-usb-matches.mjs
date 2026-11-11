import { WASI, File, OpenFile, ConsoleStdout } from './vendor/wasi/package/dist/index.js';

// Reading the registration table must never call probe/open or submit USB.
export async function readUSBMatches(bytes) {
  const module = await WebAssembly.compile(bytes);
  const wasi = new WASI([], [], [new OpenFile(new File([])), ConsoleStdout.lineBuffered(() => {}), ConsoleStdout.lineBuffered(() => {})]);
  const env = Object.fromEntries(WebAssembly.Module.imports(module).filter(item => item.module === 'env')
    .map(item => [item.name, () => { throw new Error('USB is not available during metadata inspection.'); }]));
  const instance = await WebAssembly.instantiate(module, { env, wasi_snapshot_preview1: wasi.wasiImport });
  wasi.initialize(instance);
  const count = instance.exports.wqv_id_count();
  if (!count || count > 64) throw new Error('The driver did not export a USB match table.');
  return Array.from({ length: count }, (_, index) => {
    const values = Array.from({ length: 6 }, (_, field) => instance.exports.wqv_id_field(index, field));
    return { vendorId: values[0], productId: values[1], interfaceClass: values[2] || null,
      interfaceSubclass: values[5] & 0x100 ? values[3] : null, interfaceProtocol: values[5] & 0x200 ? values[4] : null };
  });
}
