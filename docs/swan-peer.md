# Replay the greeting to SWAN RECEIVE

## Five payload experiments

Open `swan-listen.html?experiment=variants` for five separately selected tests:

1. Reverse byte order: `7A 06 F0` becomes `F0 06 7A`.
2. Reverse eight bits within each byte: `7A 06 F0` becomes `5E 60 0F`.
   Byte order remains unchanged. This changes the byte values; UART still uses
   its normal 8N1 framing and least-significant-bit-first transmission.
3. A new random triple for each of the 22 transmission slots. Each byte is
   independently generated in the full range 0–255 using `crypto.getRandomValues`.
4. Reverse byte order, then invert each payload bit: `F0 06 7A` becomes
   `0F F9 85` (XOR each byte with `FF`).
5. Reverse eight bits within each byte, then invert each payload bit:
   `5E 60 0F` becomes `A1 9F F0`. UART start/stop bits remain unchanged.

All five tests use 9600 bit/s, RXDSNS=1 (eight samples), 1.6-us TX pulses and
the same 22-slot cadence as the original replay. They change only the payload.
Prepare USB and start recording, activate RECEIVE on the watch, then click
**Mark RECEIVE and start 22 transmissions**. Restart the watch mode before each
manually selected experiment. Any RX after USB TX pauses the remaining slots.

USB preparation generates and saves the exact payload plan before recording.
The recorder never regenerates a random slot after a skip, cancellation or
export. `payload-plan.json` and `replay-planned.bin` preserve all intended slots;
the raw journal, `serial-out-requested.bin` and `serial-out-completed.bin` show
which actually ran. Every per-slot timing entry also names its three bytes.
There are no retries of failed writes or automatic acknowledgements to RX.

These attempts use format `wqv-swan-peer-v2` and the separate database
`wqv-swan-peer-variants`. Original pulse comparison recordings remain accessible
through `?experiment=peer`; their export remains supported.

## Original pulse comparison

Open `swan-listen.html?experiment=peer`. The watch is the receiver in this test.
Prepare USB and start recording first. Activate SWAN RECEIVE on the watch, then
immediately click **Mark RECEIVE and start 22 repeats**. Start alone sends nothing.
Later RECEIVE marks cannot restart the series. The next manual step changes only
TX pulse width, from 1.6 to 19.53125 microseconds; RX stays at 9600, eight samples.

The adapter sends `7A 06 F0` in 22 separate USB/FIFO transactions over about
14.31 seconds. Relative times come from the first data-bearing USB completions
in the October 25 source capture, identified in `PEER_CADENCE`. Variable source
bytes from the clock sweep are not replayed; each payload is the common-triple
hypothesis. These are ordinary SIR bytes, not an optical waveform replay. The
test does not reproduce extended start bits or unknown source inter-byte gaps.

Each transmission is scheduled relative to the original RECEIVE page request.
It can run only between completed USB reads. The journal records time spent
waiting for USB, planned and actual request times, USB completion and FIFO drain.
A repeat more than 120 ms late is skipped, so a delayed read cannot turn the
remaining schedule into a catch-up burst. Failed writes are not retried.

Any delivered input after a completed USB transmission pauses the remaining
repeats and leaves the recorder running until Stop or the capture deadline.
This input may be a watch response, echo or another signal; no byte is removed.
Before-trigger data is also retained and cannot itself start the series. A
response is not automatically acknowledged or interpreted as successful pairing.

The default capture window is 45 seconds. Its timer starts at Start recording,
so activate RECEIVE and mark it promptly. It continues after the 14.31-second
series to preserve delayed responses. Stop cancels all unsent repetitions.

The separate `wqv-swan-peer` database retains the attempts and raw journals.
ZIP exports contain `peer-series.json`, the full 66-byte logical plan, raw USB
input, requested output and FIFO-confirmed output. A plan is not proof of sending;
check per-repetition completion. Late close completions remain in the raw stream.
