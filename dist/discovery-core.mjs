import { FrameDecoder, sleep } from './irda.mjs';
import { b, ascii, concat, equal, toHex } from './formats.mjs';
import { LISTEN_MODES } from './listen-core.mjs';

const BROADCAST = b(255, 255, 255, 255);
const SLOT_COUNTS = [1, 6, 8, 16];
// The same computer / IrCOMM / OBEX hints used by our working PC receiver.
const IDENTITY = concat(b(0x84, 0x25, 0), ascii('WEB-WQV'));

export function discoverySettings({ watchMode, durationMs }) {
  if (!LISTEN_MODES.includes(watchMode)) throw new RangeError('Invalid watch mode.');
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 120000) {
    throw new RangeError('The discovery window must be between 2 and 120 seconds.');
  }
  return { watchMode, durationMs, baud: 9600 };
}

export function xidFrame(source, { destination = BROADCAST, slots = 6, slot = 0, response = false } = {}) {
  const flags = SLOT_COUNTS.indexOf(slots);
  if (source.length !== 4 || destination.length !== 4 || flags < 0 ||
      !Number.isInteger(slot) || (slot !== 255 && (slot < 0 || slot >= slots))) throw new RangeError('Invalid XID fields.');
  return { address: response ? 0xfe : 0xff, control: response ? 0xbf : 0x3f,
    data: concat(b(1), source, destination, b(flags, slot, 0), response || slot === 255 ? IDENTITY : b()) };
}

export function parseXID(frame) {
  const response = frame.address === 0xfe && frame.control === 0xbf;
  if (!response && !(frame.address === 0xff && frame.control === 0x3f)) return null;
  const p = frame.data;
  if (p.length < 12 || p[0] !== 1 || p[11] !== 0) return null;
  const slots = SLOT_COUNTS[p[9] & 3], slot = p[10];
  if (slot !== 255 && slot >= slots) return null;
  let name = null, hintsHex = null, charset = null;
  if (p.length > 12) {
    const count = p[12] & 0x80 ? 2 : 1;
    if (p.length < 13 + count) return null;
    hintsHex = toHex(p.slice(12, 12 + count)); charset = p[12 + count];
    // Keep the original bytes in every case; only ASCII names are interpreted.
    if (charset === 0) name = new TextDecoder('ascii').decode(p.slice(13 + count)).replace(/\0+$/, '');
  }
  if ((response || slot === 255) && hintsHex === null) return null;
  return { response, source: p.slice(1, 5), destination: p.slice(5, 9), slots, slot, name, hintsHex, charset };
}

// Only discovery frames are transmitted. An incoming SNRM is evidence that
// the peer wants a connection; stop there, without accepting it or opening IAS.
export async function discoverXID(adapter, settings, { signal, record = () => {}, localID } = {}) {
  const { durationMs, watchMode } = discoverySettings(settings);
  signal?.throwIfAborted(); adapter.assertOpen();
  if (!adapter.configured || adapter.baud !== 9600 || adapter.readerTask) throw new Error('Prepare a 9600 bit/s receiver before discovery.');
  localID = localID ? Uint8Array.from(localID) : crypto.getRandomValues(new Uint8Array(4));
  if (localID.length !== 4 || equal(localID, BROADCAST) || localID.every(v => v === 0)) throw new RangeError('Invalid local device address.');
  const decoder = new FrameDecoder(); adapter.decoder = decoder;
  const counters = adapter.discoveryStats = { validFrames: 0, xidCommands: 0, xidResponses: 0,
    xidRepliesSent: 0, completedCycles: 0, echoFrames: 0, connectionRequests: 0 };
  const peers = new Map(), replies = new Map();
  const started = performance.now(), deadline = started + durationMs;
  let nextCycle = started + 500, slot = null, due = 0, lastRX = -Infinity, reason = null, error = null, transmitting = false;
  const end = cause => {
    if (reason) return;
    reason = cause;
    if (cause === 'deadline' && transmitting) {
      reason = 'error'; error = { name: 'USBTransmitTimeout', message: 'USB XID transmission did not complete before the capture deadline.' };
    }
    // Closing aborts a pending WebUSB read or write. The caller awaits the
    // same bounded close operation before saving the finished journal.
    record('discovery-ending', { reason });
    adapter.close().catch(caught => record('cleanup-error', { error: String(caught) }));
  };
  const abort = () => end('interrupted');
  const timer = setTimeout(() => end('deadline'), durationMs);
  signal?.addEventListener('abort', abort, { once: true });
  const send = async (frame, purpose) => {
    const gap = 10 - (performance.now() - lastRX);
    if (gap > 0) await sleep(gap);
    if (reason || performance.now() >= deadline) return false;
    record('xid-send-attempt', { purpose, address: frame.address, control: frame.control, dataHex: toHex(frame.data) });
    // This experiment owns one USB read at a time. Transmit only between
    // completed reads and do not start the normal background reader: stopping
    // its rapid empty-read resubmissions can hang release/claim in Chromium.
    transmitting = true;
    try { await adapter.sendFrame(frame.address, frame.control, frame.data, 11, { receive: false }); }
    finally { transmitting = false; }
    record('tx-frame', { ...frame, data: undefined, dataHex: toHex(frame.data), phase: 'discovery', purpose, baud: 9600 });
    return true;
  };
  record('discovery-start', { watchMode, durationMs, baud: 9600, localIdHex: toHex(localID),
    identityHex: toHex(IDENTITY), slots: 6, applicationTransmissions: 0, acceptingConnections: false });
  try {
    while (!reason && performance.now() < deadline) {
      signal?.throwIfAborted(); adapter.assertOpen();
      const now = performance.now();
      if (slot === null && now >= nextCycle) { slot = 0; due = now; record('discovery-cycle-start'); }
      if (slot !== null && now >= due && now - lastRX >= (decoder.body?.length ? 100 : 10)) {
        if (await send(xidFrame(localID, { slot }), slot === 255 ? 'cycle-end' : 'search-slot')) {
          if (slot === 255) { counters.completedCycles++; slot = null; nextCycle = performance.now() + 2000; }
          else { slot = slot === 5 ? 255 : slot + 1; due = performance.now() + 100; }
        }
      }
      if (reason) break;
      const frame = decoder.frames.shift();
      if (!frame) {
        adapter.readPending = true;
        let result;
        try { result = await adapter.device.transferIn(adapter.inEndpoint, 64); }
        finally { adapter.readPending = false; }
        if (reason) break;
        if (result.status !== 'ok' || !result.data) throw new Error(`USB IN: ${result.status}, missing or failed data buffer.`);
        const bytes = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        adapter.rxBytes += bytes.length;
        if (bytes.length) { lastRX = performance.now(); decoder.feed(bytes); }
        else await sleep(2);
        continue;
      }
      counters.validFrames++;
      record('rx-frame', { address: frame.address, control: frame.control, dataHex: toHex(frame.data),
        phase: 'discovery', baud: 9600, decoder: 'irda-crc-strict', recovered: false });
      const xid = parseXID(frame);
      if (xid) {
        if (equal(xid.source, localID)) { counters.echoFrames++; continue; }
        if (!equal(xid.destination, localID) && !equal(xid.destination, BROADCAST)) continue;
        const id = toHex(xid.source);
        counters[xid.response ? 'xidResponses' : 'xidCommands']++;
        peers.set(id, { id, name: xid.name ?? peers.get(id)?.name ?? null, hintsHex: xid.hintsHex ?? peers.get(id)?.hintsHex ?? null });
        record('peer-xid', { ...peers.get(id), response: xid.response, slot: xid.slot, slots: xid.slots });
        if (!xid.response) {
          // Yield our search to an incoming search, and let its slots finish.
          if (slot !== null) record('discovery-cycle-yielded', { peerIdHex: id });
          slot = null; nextCycle = lastRX + (xid.slots + 1) * 100 + 500;
          const previous = replies.get(id);
          if (xid.slot === 255) { replies.delete(id); nextCycle = lastRX + 2000; }
          else {
            const newCycle = !previous || lastRX - previous.at > 2500 || xid.slot < previous.slot;
            if (newCycle && await send(xidFrame(localID, { destination: xid.source, slots: xid.slots, slot: xid.slot, response: true }), 'reply-to-peer')) counters.xidRepliesSent++;
            replies.set(id, { slot: xid.slot, at: lastRX });
          }
        }
      } else if (frame.address === 0xff && frame.control === 0x93 && frame.data.length >= 9 &&
          equal(frame.data.slice(4, 8), localID) && !equal(frame.data.slice(0, 4), localID)) {
        counters.connectionRequests++;
        record('peer-connection-request', { sourceIdHex: toHex(frame.data.slice(0, 4)), dataHex: toHex(frame.data), accepted: false });
        reason = 'connection-request';
      }
    }
  } catch (caught) {
    if (!reason) { reason = signal?.aborted ? 'interrupted' : 'error'; error = { name: caught.name, message: caught.message }; }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
  }
  const result = { status: reason === 'connection-request' ? reason : reason === 'interrupted' || reason === 'error' ? reason :
    peers.size ? 'peer-found' : adapter.rxBytes ? 'data-no-peer' : 'no-data',
    watchMode, baud: 9600, durationMs, elapsedMs: performance.now() - started, localIdHex: toHex(localID),
    peers: [...peers.values()], ...adapter.usbStats, ...counters, txFrames: adapter.txFrames,
    rxBytes: adapter.rxBytes, badCRC: decoder.badCRC, recoveredFrames: 0, partialBodyHex: toHex(decoder.body ?? []), error };
  record('discovery-finished', result);
  return result;
}
