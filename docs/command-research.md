# IR research

Open [`research.html`](https://bolknote.github.io/WQV-online/research.html), or
run `python3 serve.py --port 8766` and visit
`http://127.0.0.1:8766/research.html` in Chrome, Edge or Opera.
The normal photo app stays at the site's root. Use **Listen** for passive
capture, **Discovery** for active device discovery, or **Commands** for the
existing command probes. The page remembers
this choice, but never starts a recording or connects to the watch on reload.

This page is for the WQV-3 and SigmaTel STIr4200 (`066f:4200`). It uses the same
USB transport as the main app. It does not contact a
server or start a watch connection on load.

## Active discovery

Open [`research.html?mode=discovery`](https://bolknote.github.io/WQV-online/research.html?mode=discovery).

1. Select **Discovery** and one watch mode: **WATCH SEND**, **OTHERS SEND** or
   **SWAN SEND**. The rate is fixed at **9600 bit/s** and the window defaults to
   20 seconds (2–120 seconds allowed).
2. Release the adapter in other apps and click **Prepare SigmaTel USB…**.
   Preparation configures the adapter without transmitting an infrared frame.
3. Restart the selected SEND mode on the watch, choose a photo and face the
   watch toward SigmaTel. Tick the readiness box.
4. Click **Start discovery**, then press the final SEND button on the watch.
   **Mark SEND press** adds a manual timestamp to the journal.
5. Save the attempt ZIP and note any changes on the watch screen. Restart the
   watch's transfer mode before the next attempt; all steps are manual.

**PC / REMOTE** is also available in Discovery as a reception control. Prepare
USB first, restart **IR → PC → F / REMOTE** on the watch, then tick readiness
and start discovery. It uses the same XID-only exchange, without a photo or
service command. Passive Listen keeps its three SEND modes.

The test listens for 500 ms, then sends six XID slots (0–5) and the final FF
slot. The final packet advertises the generated local ID, name **WEB-WQV**,
service hints **84 25**, and ASCII charset **00**. These hints match the
working PC receiver in `switchToReceive`; their suitability for the other
watch modes has not been established. Completed searches are followed by a
two-second listening interval before another cycle.

Discovery interleaves individual USB reads and XID writes. It does not run
the photo app's background reader or use release/claim between slots. The
first hardware attempt exposed a Chromium receive-stop timeout before any
XID could be sent; this separate read loop avoids that transition. The normal
photo transport still starts its background reader after each transmission.

**Reset SigmaTel USB…** performs a WebUSB device reset before preparation.
The request and its outcome are included in the trace. A successful reset
does not prove that bulk transmission has recovered. If the XID write still
stalls, physically reconnect the adapter before testing the watch again.
A capture deadline reached during a transmit is reported as an error, not
as a silent watch. Check `txFrames`, completed cycles and the USB completion
records before interpreting missing replies.

When a peer searches, the test yields its own search and answers in the current
valid slot, once per observed peer cycle. The final peer slot is recorded,
without a late reply. If an **SNRM connection request addressed to our local
ID** arrives, it is recorded and the experiment ends. No UA, IAS response,
IrCOMM session, application command or photo transfer is sent. There is no
speed change. Each transmitted frame is an XID command or response.

The packet layout and final identity slot follow the Linux IrDA
`irlap_send_discovery_xid_frame` implementation; yielding to a peer search
also avoids two devices continuing competing discovery cycles. This is a
small diagnostic, not a complete IrLAP implementation.

Attempts have `kind: "discovery"` and format `wqv-discovery-research-v1`.
The result distinguishes `no-data`, `data-no-peer`, `peer-found` and
`connection-request`, as well as errors and interruption. It includes the
local ID, peer IDs, names, hints, completed cycles and XID counters. Echoes
with our source ID are counted separately and never treated as a discovered
peer. Unknown device names are retained; there is no Casio-only name filter.

`usb-in.bin` and `usb-out-requested.bin` keep the original streams, including
unrecognized bytes, corrupt frames and failed transmit requests. Received
frames use strict CRC checks without recovery. The same journal and ZIP format
are used in all modes; previous captures remain available. **USB reads**,
**With data** and **Empty reads** count successful bulk-IN completions, including
any completing during close. Zero received bytes does not identify the cause
of silence. Connection requests are saved but are not accepted by this test.

Software tests cover the complete slot cycle, replies in peer slots, yielding
to another search, a non-Casio peer name, stopping at SNRM, echoes, foreign
addresses, bad CRC preservation, manual Stop, a failed transmit and deadline
cleanup. Positive reception from a watch in this mode has not yet been tested.

## Passive listening

1. Choose a watch mode: **WATCH SEND**, **OTHERS SEND** or **SWAN SEND**.
   This is a label for the experiment; the page does not change or detect the
   watch's mode.
2. Choose a fixed **9600**, **38400** or **115200 bit/s** rate and a capture
   window of **2–120 seconds**. Each rate is a separate manual experiment.
3. Release SigmaTel in any other app, then click **Prepare SigmaTel USB…**.
   The page opens USB, initializes SIR and sets the chosen rate. This uses
   local adapter control requests; no infrared frame is transmitted. It does
   not start reading until you click **Start recording**.
4. On the watch, exit the previous transfer session, select the matching SEND
   mode and an image, and face it toward the adapter. Tick the readiness box.
5. Click **Start recording**, then press the final SEND button on the watch.
   Optionally click **Mark SEND press** on the page to add a timestamped event.
   The marker records the page click, not the exact physical watch button press.
6. Wait for the window to end, or click **Stop**. The page closes USB and keeps
   the trace. Add screen observations, export the ZIP, and manually choose the
   next experiment. Restart the watch's transfer mode before every attempt.

The listener reads USB bulk IN directly and keeps reading after poll/final
frames. It sends no discovery, connection setup, application commands, polls
or acknowledgements, and blocks USB bulk OUT. It keeps a single fixed speed
throughout the capture. A peer waiting for a reply may therefore stop after
its initial requests; that is a useful capture, not a complete photo transfer.

Original USB bytes are recorded before decoding. An optional strict IrDA
decoder supplies CRC-valid frames for convenience; it does not remove bytes,
repair escapes, recover bad CRCs or complete damaged end markers on empty reads.
Unknown formats and incomplete frames remain in `usb-in.bin`. These are bytes
delivered by SigmaTel, not raw optical pulse timings. An empty recording
cannot establish that the watch sent nothing or that the mode is unsupported.

Listening attempts have `kind: "listen"`, format `wqv-listen-research-v1`, the
selected `watchMode` and `baud`, window/start/end times and byte/frame counters.
`watch-send-mark` events carry the manual SEND markers. `response.bin` and
`before-command.bin` are empty because no application session is opened.
Read completions during shutdown remain in the original USB trace; counters
cover the reads processed before the capture window ended. Stop/deadline
returns even if a read is pending, and USB close cancels that browser request.
If closing fails, the export lists the unresolved call in `pendingUSBCalls`.

The listener has software tests for no bulk transmission, all three speed
settings, unmodified raw exports, strict CRC, continued reception after final
frames, manual Stop, endpoint errors and deadline completion with a pending
USB read. Seven passive captures on 2026-10-23 (SWAN SEND at 9600, OTHERS SEND
at 9600 and 115200) completed with no USB bytes. This does not establish the
cause or validate reception of an actual watch transmission.

## Command steps

Select **Commands** before following these steps. The previous command
position and saved attempts are retained when switching modes.

The order is `AA`, `AD`, `0B`, `AB`, `AC`, `AE`, `AF`, `A8`, `A9`, `B0`.
Each request contains exactly one application byte, with no parameters.

- `AA` is a control: this WQV-3 previously replied with just `0D`.
- `AD` has a real request builder in Casio Link 3. Its decoder expects `0D`
  followed by two status bytes. This does not establish its effect on a WQV-3.
- `0B` is a gap in the numbering. The other candidates are near `AA`/`AD`.
  We have no handler or parameter format for them.

The unknown commands may change watch data or settings. A reply does not prove
a command's meaning; silence does not prove that a code is unused.

1. Release the adapter in WQV Link or any other program.
2. Click **Prepare SigmaTel USB…**. Wait for **USB ready**. This opens the USB
   interface and reads adapter registers; it sends no watch command.
3. Exit the previous transfer mode on the watch and enter **IR → PC →
   F / REMOTE** again. A factory reset is not needed. Keep it facing the adapter.
4. Tick the readiness checkbox and click **Watch ready — send XX**.
5. The page discovers the watch, establishes a new primary IrCOMM connection,
   and makes one attempt to send the command. After that it sends only link
   polls and acknowledgements, not another application command. Automatic
   retransmission is disabled for the probe, including when an ACK is lost.
   If application data arrives before the command while waiting for credits,
   the probe stops instead of attributing that data to the new command.
6. It collects the reply for the selected 2–30 second window (five seconds by
   default), then closes USB. It does not send a watch teardown command after
   the probe. Closing USB does not itself reset the watch's transfer mode.
7. Add observations about the watch screen and save them with **Save notes**.
   Export the attempt ZIP. Click **Next step →** when you want to continue,
   prepare USB again, then restart transfer mode on the watch for that step.

Each whole step has a 50-second ceiling, including discovery and connection.
The attempt is marked interrupted if that ceiling is reached.

**Stop** aborts the current step and closes USB. **Retry this step** creates a
new attempt; earlier attempts remain in the journal. **Skip step →** moves the
selection without sending anything. Neither advancing nor reloading the page
starts a request. A stalled USB close may still require unplugging the adapter.

The page accepts any application reply, rather than requiring `0D` or exactly
three bytes. It keeps fragmented replies and extra bytes. The normal IrDA
transport still checks CRC and sequence numbers; the raw trace keeps the USB
bytes even if those checks reject a frame.
If an unfamiliar reply breaks the expected protocol sequence, the page keeps
listening passively for the rest of the response window. It sends no further
polls or application commands in that phase. Such frames remain in the raw
capture even when they cannot be added to the decoded application response.

## Saved evidence

Attempts are saved in a separate IndexedDB database, `wqv-command-research`.
They do not touch the photo collection. Event writes are batched every 250 ms;
a browser or machine crash can lose a pending batch. On reload, unfinished
attempts are marked interrupted. Nothing resumes automatically.

A storage error stops the test. The current in-memory trace remains available
through **Save attempt ZIP…**, even if the database cannot accept more data.
Export a copy before closing the page. There is no automatic deletion of old
attempts. The hosted site and a localhost copy use separate browser storage.

Each attempt folder in the ZIP contains:

| File | Contents |
| --- | --- |
| `attempt.json` | Request code, device identity, chip revision, negotiated speed, response window, counters, notes, errors and capture status. |
| `events.jsonl` | Every captured event with a UTC timestamp, monotonic elapsed time and sequence number. USB call/result pairs have matching IDs. Includes empty reads, control requests/replies, failures and exact byte counts. |
| `usb-in.bin` | Original bulk-IN bytes, concatenated before decoding or CRC recovery. Includes discovery and negotiation. Use `events.jsonl` to recover transfer boundaries and speed changes. |
| `usb-out-requested.bin` | Requested bulk-OUT buffers, including the SigmaTel `55 AA` wrapper. `bytesWritten` and status in the trace distinguish successful, short and failed transfers. |
| `frames.jsonl` | Decoded frames seen by the protocol reader, including duplicates and echoes. Frames rejected by CRC are still present in the original USB stream. |
| `response.bin` | Complete accepted IrCOMM application payload received after the probe, without interpreting or repairing its contents. |
| `before-command.bin` | Unsolicited application bytes received while preparing to send; these are not counted as a response to the command. |

For command attempts, `commandAttempted` records that the single send was attempted. `commandSent`
means the transport's send operation completed, not that the watch understood
or executed it. Errors and raw USB results must be checked alongside these flags.
An empty `response.bin` is also a result.

An export made during a run is a snapshot. Unresolved USB calls are listed in
`pendingUSBCalls`; late completions may appear in a later export. The event
trace, rather than an interpreted status field, is the primary evidence.

No unknown command has been sent to the watch as part of developing this page.
Its protocol behavior, raw capture, exports and manual stepping have software
tests; hardware probing remains a separate step.
