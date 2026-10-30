import { clockPayload } from './calendar.mjs';

// Palm WQV Link 1.1, code 1: send_TSR at 00b502. The six date fields
// match the colour models; the old protocol uses opcode 0D, not 07.
// Seconds do not occur in the original request.
export function wqv12ClockPayload(value) {
  const payload = clockPayload(value);
  payload[0] = 0x0d;
  return payload;
}
