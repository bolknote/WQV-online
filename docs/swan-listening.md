# SWAN speed comparison

For the later fixed-9600 signal, photo-selection and byte-replay experiments,
use `/swan-listen.html?experiment=sync`; see [swan-signal.md](swan-signal.md).
This original page retains the earlier recordings and passive comparison.

Open `/swan-listen.html` on the local server. This is a passive experiment for
SigmaTel STIr4200. It does not send discovery packets, game packets, invitations
or acknowledgements. USB bulk OUT is blocked by the capture wrapper.

The six manual steps are background, SWAN SEND and SWAN RECEIVE at 9600 bit/s,
then the same three at 38400. The second speed is a hypothesis based on the
WonderSwan UART, not a confirmed WQV-3 setting. Each watch capture needs a new
activation of the selected mode; switching steps never starts a recording.

1. Release SigmaTel in other applications. Prepare USB on this page.
2. For a background step, remove the watch from the infrared path. For a watch
   step, restart the indicated SWAN mode and leave its final button unpressed.
   Select a photo for SEND. Face the watch toward the adapter at 5–10 cm.
3. Confirm the checkbox for this specific setup and start recording. For a
   watch step, press its final SEND or RECEIVE button now, then mark that press
   on the page. The marker is a page click, not an optical timestamp.
4. Leave the adapter and watch in position. Default capture windows are
   20 seconds for the background and 45 seconds for watch modes.
5. Record the final watch display and save the observation. Save the attempt
   ZIP before moving to another step. The raw-RX button also saves a small
   binary file, but it does not replace the ZIP's timestamps and conditions.
   Preparing a file displays a persistent **Download** link with its size.
   Click that link to save it. A hidden programmatic download was unreliable
   in the in-app browser; the page now uses an explicit link and keeps the
   object URL alive until another file is prepared or the page closes.

The journal uses its own IndexedDB database, `wqv-swan-listening`. Original
control transfers, empty reads, failures and data-bearing USB results are kept
in `events.jsonl`. `usb-in.bin` includes all delivered bytes, including reads
completed during shutdown. `analysis.json` lists each data-bearing read, its
completion time, a byte histogram and any Digimon-format packet candidates.
Nothing repairs the bytes or removes possible echo.

`attempt.json` separates the planned step from `conditions`, which is filled
only when the setup checkbox is confirmed and recording starts. A background
step has `watchPresent: false` and `watchMode: null`. Watch presence, placement,
mode and final display are user reports; the page cannot sense them.

Compare each watch capture with the background at the same speed. The earlier
9600 capture contained twenty individual `FF` bytes, with no host transmission;
their optical source remains unverified. Another empty capture had unknown
physical conditions and is not a valid background control. Neither result
identifies the Casio SWAN protocol. Failed, interrupted or unresolved USB
captures must not be counted as successful negative tests.

On October 24, two later SWAN RECEIVE captures and one SWAN SEND capture at
9600 each delivered 66 bytes with no host bulk OUT, failed reads or pending
USB calls. Each stream splits into 22 groups of three bytes. The dominant
group is `7A 06 F0`; variants include `7B 06 F0`, `3D 03 F8` and `F5 18 C0`.
The groups follow almost the same schedule in all three runs: after an initial
gap near 0.515 s, intervals near 0.54, 0.56 and 1.015 s repeat. Controls with
the watch removed at both speeds contained no bytes. A later 38400 RECEIVE
run with two button markers was also empty.

The user observed that an extra front-button press was needed before the data
appeared; page markers were sometimes delayed. The previous one-marker empty
watch attempts therefore do not establish silence after full activation.
The repeated pattern is evidence to investigate, not a decoded command or proof
that 9600 is the actual optical symbol rate. The similar SEND/RECEIVE captures
suggest a shared early exchange, but the phase, bit alignment and field meanings
remain unknown. There is no `55 FF 00` Digimon prefix in these captures.
