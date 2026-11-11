// The profile supplies Linux services and entry points, never USB match IDs.
// USB match records are read from the compiled driver's own C registration table.
export const DRIVER_ABI = 1;
export const DRIVER_PROFILES = Object.freeze([
  { id: 'sigmatel', name: 'SigmaTel STIr4200', file: 'stir4200.c', signature: /struct\s+stir_cb\b/, framing: 'raw' },
  { id: 'ks959', name: 'KingSun KS-959', file: 'ks959-sir.c', signature: /struct\s+ks959_cb\b/, framing: 'raw' },
  { id: 'ksdazzle', name: 'KingSun Dazzle', file: 'ksdazzle-sir.c', signature: /\bksdazzle_rcv_irq\b/, framing: 'raw' },
  { id: 'kingsun', name: 'KingSun / DonShine', file: 'kingsun-sir.c', signature: /\bkingsun_rcv_irq\b/, framing: 'raw' },
  { id: 'mcs7780', name: 'MosChip MCS7780', file: 'mcs7780.c', signature: /struct\s+mcs_cb\b/, framing: 'sir' },
  { id: 'irda-usb', name: 'USB IrDA', file: 'irda-usb.c', signature: /struct\s+irda_usb_cb\b/, framing: 'packet' },
  { id: 'ark3116', name: 'ARK3116', file: 'ark3116.c', signature: /struct\s+ark3116_private\b/, framing: 'raw' },
  { id: 'ir-usb', name: 'USB IrDA serial', file: 'ir-usb.c', signature: /\bir_set_termios\b/, framing: 'packet' },
  { id: 'pl2303', name: 'Prolific PL2303', file: 'pl2303.c', signature: /struct\s+pl2303_private\b/, framing: 'raw', infrared: false },
  { id: 'ma620', name: 'Mobile Action MA-620', file: 'ma600-sir.c', signature: /\bma600_change_speed\b/, framing: 'raw' },
]);
export function identifyDriver(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  return DRIVER_PROFILES.find(profile => profile.signature.test(code)) ?? null;
}
export const driverProfile = id => DRIVER_PROFILES.find(profile => profile.id === id) ?? null;
export const usbID = device => [device.vendorId, device.productId].map(v => v.toString(16).padStart(4, '0')).join(':');
export function usbMatchLabels(matches) {
  const byte = n => n == null ? '*' : n.toString(16).padStart(2, '0');
  return [...new Set(matches.map(match => match.vendorId || match.productId ? usbID(match) :
    'class ' + [match.interfaceClass, match.interfaceSubclass, match.interfaceProtocol].map(byte).join('/')))];
}
export function usbAlternates(device) {
  const configurations = [device.configuration, ...(device.configurations ?? [])].filter((configuration, index, all) =>
    configuration && all.findIndex(item => item?.configurationValue === configuration.configurationValue) === index);
  return configurations.flatMap(configuration => (configuration.interfaces ?? []).flatMap(iface =>
    (iface.alternates ?? []).map(alternate => ({ configuration: configuration.configurationValue,
      interfaceNumber: iface.interfaceNumber, alternate, endpoints: alternate.endpoints ?? [] }))));
}
export function matchingDriverIDs(record, device) {
  const alternatives = usbAlternates(device);
  return (record.artifact?.usbMatches ?? []).flatMap((match, index) => {
    const exact = Boolean(match.vendorId || match.productId);
    if (exact && (match.vendorId !== device.vendorId || match.productId !== device.productId)) return [];
    if (!exact && match.interfaceClass == null) return [];
    const available = alternatives.filter(({ alternate }) =>
      (match.interfaceClass == null || match.interfaceClass === alternate.interfaceClass) &&
      (match.interfaceSubclass == null || match.interfaceSubclass === alternate.interfaceSubclass) &&
      (match.interfaceProtocol == null || match.interfaceProtocol === alternate.interfaceProtocol));
    // Exact VID/PID recognition remains useful when an OS exposes no interfaces.
    if (exact && !alternatives.length) return [{ index, exact, interface: null }];
    return available.map(iface => ({ index, exact, interface: iface }));
  });
}
export function chooseInstalledDriver(records, device) {
  return records.filter(record => record.artifact?.abi === DRIVER_ABI && record.artifact.sourceSHA256 === record.sha256 && record.artifact.inputSHA256 === record.inputSHA256)
    .flatMap(record => matchingDriverIDs(record, device).map(match => ({ record, match })))
    .sort((a, b) => Number(b.match.exact) - Number(a.match.exact) ||
      Number(driverProfile(a.record.profile)?.infrared === false) - Number(driverProfile(b.record.profile)?.infrared === false) ||
      b.record.updatedAt - a.record.updatedAt)[0] ?? null;
}
export async function sourceDigest(source) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))), n => n.toString(16).padStart(2, '0')).join('');
}
export function normalizeDriverPath(path) {
  const clean = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Invalid driver file path: ' + path);
  return clean;
}
