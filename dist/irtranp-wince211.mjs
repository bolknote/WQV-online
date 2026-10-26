// CE 2.11 IRLAP.LIB!NegotiateQosParms and IrCOMM's send-size calculation.
// The tables and results were checked against original MIPS machine code.
// See docs/ircomm-stack-comparison.md. This is a bounded research profile,
// not an implementation of the complete Windows CE IrDA stack.
import { linkParameters, selectBaudRate } from './irda.mjs';

export const CE211_RECEIVE_CREDITS = 4;
const DATA = [64, 128, 256, 512, 1024, 2048];
const WINDOW = [1, 2, 3, 4, 5, 6, 7];
const MAX_TURN = [500, 250, 100, 50, 25, 10, 5];
const MIN_TURN = [10000, 5000, 1000, 500, 100, 50, 10, 0, 0, 0];
const BOFS = [48, 24, 12, 5, 3, 2, 1, 0];
const DISCONNECT = [3, 8, 12, 16, 20, 25, 30, 40];
const THRESHOLD = [0, 3, 3, 3, 3, 3, 3, 3];
const CAPACITY = {
  9600: [400, 200, 80, 0, 0, 0, 0], 19200: [800, 400, 160, 0, 0, 0, 0],
  38400: [1600, 800, 320, 0, 0, 0, 0], 57600: [2360, 1180, 472, 0, 0, 0, 0],
  115200: [4800, 2400, 960, 480, 240, 96, 48],
};
const BOF_DIVISOR = { 9600: 12, 19200: 6, 38400: 3, 57600: 2, 115200: 1 };

function parameters(bytes) {
  const values = new Map();
  for (let p = 0; p < bytes.length;) {
    if (p + 2 > bytes.length) throw new Error('Truncated IrLAP QoS parameters.');
    const kind = bytes[p++], size = bytes[p++];
    if (!size || size > 2 || p + size > bytes.length || values.has(kind)) throw new Error('Invalid IrLAP QoS parameter.');
    values.set(kind, bytes[p] | (size === 2 ? bytes[p + 1] << 8 : 0)); p += size;
  }
  return values;
}
function select(bits, table, name) {
  if (!bits || bits & ~((1 << table.length) - 1)) throw new Error('Unsupported IrLAP ' + name + ' offer.');
  const index = Math.floor(Math.log2(bits));
  return { index, value: table[index], mask: 1 << index };
}
export function ce211LinkParameters(rates) {
  const bytes = linkParameters(rates);
  // Our primary keeps one outgoing frame pending and has no gap buffer.
  // Advertise the corresponding receive window instead of offering four.
  for (let p = 0; p < bytes.length; p += 2 + bytes[p + 1]) if (bytes[p] === 0x84) bytes[p + 2] = 1;
  return bytes;
}
export function negotiateCE211(peerParameters, rates, localParameters = ce211LinkParameters(rates)) {
  const remote = parameters(peerParameters), local = parameters(localParameters);
  const { baud, commonRates } = selectBaudRate(peerParameters, rates);
  const maxTurn = select(remote.get(0x82), MAX_TURN, 'maximum turnaround');
  const minTurn = select(remote.get(0x86), MIN_TURN, 'minimum turnaround');
  const bofs = select(remote.get(0x85), BOFS, 'BOF');
  const disconnect = select((remote.get(8) ?? 0) & (local.get(8) ?? 0), DISCONNECT, 'disconnect time');
  const dataMask = (remote.get(0x83) ?? 0) & (local.get(0x83) ?? 0);
  const initialData = select(dataMask, DATA, 'data size');
  const initialWindow = select(remote.get(0x84), WINDOW, 'window');
  const bofCount = Math.floor(bofs.value / BOF_DIVISOR[baud]) + 1;
  const capacity = CAPACITY[baud][maxTurn.index];
  let chosen = null;
  for (let i = initialData.index; i >= 0 && !chosen; i--) {
    if (!(dataMask & (1 << i))) continue;
    for (let window = 1; window <= initialWindow.value; window++) {
      if (window * (DATA[i] + 6 + bofCount) > capacity) break;
      chosen = { dataBytes: DATA[i], dataMask: 1 << i, windowSize: window, windowMask: 1 << (window - 1) };
    }
  }
  if (!chosen) throw new Error('IrLAP offers exceed the negotiated line capacity.');
  return { baud, ...chosen, applicationChunkBytes: chosen.dataBytes - 5, sendWindow: 1,
    maxTurnMs: maxTurn.value, minTurnUs: minTurn.value, negotiatedBOFs: bofCount,
    disconnectSeconds: disconnect.value, thresholdSeconds: THRESHOLD[disconnect.index],
    selectedParameterMasks: [1 << Math.floor(Math.log2(commonRates)),
      maxTurn.mask, chosen.dataMask, chosen.windowMask, bofs.mask, minTurn.mask, disconnect.mask] };
}
