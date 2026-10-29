// Raw SIR bytes for protocol engines that own the receive loop. Older test
// transports and SigmaTel use bulk IN; KS-959 implements control IN decoding.
export function readSIR(adapter) {
  return adapter.readRaw ? adapter.readRaw() : adapter.device.transferIn(adapter.inEndpoint, 64);
}
