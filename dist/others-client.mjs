import { IrTranPReceiver } from './irtranp-core.mjs';
import { IrTranPSender, validateSendFile } from './irtranp-send.mjs';
import { imageFromFile } from './images.mjs';
import { packSCEP, putCommand, toHex } from './formats.mjs';

export const WATCH_MODE_KEY = 'wqv-online.watch-mode';
export const watchTabs = mode => mode !== 'pc' ? ['photos', 'connection'] : ['photos', 'clock', 'holidays', 'connection'];
export function readWatchMode(storage) {
  try { return ['others', 'swan'].find(mode => mode === (storage ?? globalThis.localStorage)?.getItem(WATCH_MODE_KEY)) ?? 'pc'; }
  catch { return 'pc'; }
}

// Finish all USB setup before asking the user to activate the watch. There
// must be no PC keepalive or background IN reader sharing this connection.
export async function prepareOthers(adapter, signal) {
  signal?.throwIfAborted();
  await adapter.pauseReader();
  signal?.throwIfAborted();
  await adapter.setupSIR();
  signal?.throwIfAborted();
  adapter.assertOpen();
  adapter.decoder.reset(); adapter.decoder.frames.length = 0;
}

export async function othersImage(file) {
  const image = await imageFromFile(new File([file.bytes], file.filename));
  image.archive.filename = file.filename;
  image.archive.sourceProtocol = 'others';
  image.archive.packets = packSCEP(putCommand(image.upf, file.filename)).map(toHex);
  return { ...image, source: 'watch', protocol: 'others' };
}

// The normal client sends one PUT per connection. Retrying an IrLAP frame
// does not restart PUT or create another photo on the watch.
export async function transferOthers(adapter, { direction, signal, file, onFile,
  record = () => {}, progress = () => {}, durationMs = 60000, localID } = {}) {
  if (!['receive', 'send'].includes(direction)) throw new RangeError('Unknown photo transfer direction.');
  if (direction === 'send') validateSendFile(file?.bytes, file?.filename);
  let negotiatedBaud = null;
  const options = { signal, onFile, progress, localID, maxBaud: 115200,
    frameRecovery: adapter.description?.driver === 'KingSun KS-959' ? 'strict' : 'pad5-bof',
    record(kind, details) {
      if (kind === 'irlap-connected') negotiatedBaud = details.baud;
      record(kind, details);
    } };
  const recovery = { recoverFrames: adapter.decoder.recoverFrames, recoverBOF: adapter.decoder.recoverBOF };
  try {
    const transfer = direction === 'send' ? new IrTranPSender(adapter,
      { ...options, sendFile: file, copyCount: 1, sendPDU: 0 }) : new IrTranPReceiver(adapter, options);
    const summary = await transfer.run(durationMs);
    return { ...summary, direction, negotiatedBaud };
  } finally { Object.assign(adapter.decoder, recovery); }
}

export function othersOutcome(summary) {
  if (summary.fileCount > 0) return summary.status === 'received' && summary.complete ? 'received' : 'received-incomplete';
  if (summary.direction === 'send') {
    if (summary.uploadOutcome === 'accepted') return summary.status === 'sent' && summary.complete && summary.disconnected ? 'accepted' : 'accepted-incomplete';
    if (summary.uploadOutcome === 'rejected') return 'rejected';
    // An interrupted PUT can already have been stored. Do not invite an
    // automatic retry or claim that the watch has no new photo.
    if (summary.putRequests > 0) return 'unconfirmed';
  }
  if (summary.status === 'interrupted') return 'cancelled';
  return summary.error ? 'error' : summary.direction === 'send' ? 'not-sent' : 'empty';
}
