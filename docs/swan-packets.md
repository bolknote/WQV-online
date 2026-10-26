# Complete SWAN packet probes

Open `/swan.html` on the local server. This page tests a candidate byte format
recovered from the user-supplied Tag Tamers and Pocket DigimonWorld programs.
It is not a decoded WQV-3 protocol. Nothing starts on page load or during USB
preparation. The page uses SigmaTel STIr4200, fixed 9600 bit/s and raw SIR.

## Manual sequence

1. Disconnect SigmaTel in other apps and prepare USB on this page.
2. For **Adapter echo control**, keep the watch outside the IR path. Tick the
   checkbox, start recording, and click **Send packet once**.
3. Save the attempt, or keep it for **Save all attempts ZIP**.
4. Choose the next step manually and prepare USB again. On WQV-3 select
   IR → SWAN → RECEIVE, but leave its final activation until recording starts.
5. Tick the checkbox and start recording. Activate RECEIVE on the watch and
   immediately click **Send packet once**. Leave the capture running or Stop.
6. Restart the watch's transfer mode between tests. Each step can be retried
   separately; advancing never starts the next capture.

Default recording time is 30 seconds. Stop, a deadline or an error closes USB.
The send button can queue exactly one packet during a capture. It waits for an
outstanding USB read rather than cancelling the read to transmit. A stuck read
can prevent sending; the result then says `probe-not-sent`.

The four presets are an echo control, paired header type 11, paired header type
21, and selector 02 with an unpaired body. The control and header-11 watch test
send identical bytes. Header assignments come from the WonderSwan common code
and a PocketStation diagnostic initializer; they are not formally identified
Casio fields. The four system identity bytes are zero, the cartridge bytes are
Tag Tamers' `01 00 32 01`, and the single payload byte `00` is synthetic.
The fields can be edited before preparation. No empty payload is allowed:
the original routines assume a nonempty payload.

## Candidate format

Selector 01:

```text
55 FF 00
01 FE
H0 ~H0 ... H11 ~H11
N ~N
D0 ~D0 ... D(N-1) ~D(N-1)
S ~S
```

`~b` means `b XOR FF`. `S = (selector + sum(header) + N + sum(payload)) & FF`.
There is no IrDA frame CRC or SIR escaping added. A one-byte payload makes
35 optical serial bytes. SigmaTel's four-byte USB header is kept separately
in the USB trace.

Selector 02 still pairs the selector (`02 FD`); the rest of the body is bare.
The WonderSwan program implements this variant. The inspected PocketStation
program uses selector 01. This difference is retained in the test descriptions
and is not treated as proof of a universal WonderWave protocol.

## Files and interpretation

- `events.jsonl`: original USB calls/results/errors, boundaries, UTC and
  monotonic timestamps, empty reads, setup and manual send requests.
- `usb-in.bin`: all delivered RX bytes, including possible echo and reads
  completing during USB close. No bytes are repaired or removed.
- `usb-out-requested.bin`: attempted USB buffers, including the SigmaTel header.
- `candidate-frame.bin`: planned packet. This file alone proves no transmission.
- `serial-out-requested.bin`: attempted logical serial bytes.
- `serial-out-completed.bin`: bytes whose USB OUT and FIFO drain both completed.
  This still does not prove optical delivery to the watch.
- `analysis.json`: framing candidates checked for complements, length and SUM8,
  plus complete RX matches to a packet successfully written to USB. Early bytes
  and an unsent planned packet are not labelled echo. An exact match remains
  only a possible echo: USB completion order is not optical arrival timing.
- `attempt.json`: preset, edited fields, watch-presence label, counters, notes,
  completion status and unresolved USB calls.

A checksum-valid packet establishes framing only. Unmatched bytes are not
automatically a watch response. Silence, failed USB writes and unrequested
packets do not establish that a command is unsupported. No application ACK,
clock, delete or firmware command is added by the page.

The page has its own IndexedDB journal, `wqv-swan-research`, to keep its packet
experiments separate from the older command/byte research captures. It uses
the shared research-tab lock to avoid competing readers.

## Verification

`tests/wonderwave-fixtures.json` contains synthetic vectors emitted and received
by the original x86 routines in Tag Tamers. The paired vectors were also checked
against the original ARM sender/receiver and IR output gate writes in the
PocketStation program. SHA-256 hashes identify the source binaries; game code
and images are not included in this repository. This checks software framing,
not physical timings or compatibility with WQV-3.

Node tests cover these vectors, malformed pairs/checksums, fragmented captures,
late USB completions, possible echo, a manual whole-packet transmission through
the fake USB adapter, and lossless export after a failed transmission.
