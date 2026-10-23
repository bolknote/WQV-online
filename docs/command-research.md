# Command research

Open [`research.html`](https://bolknote.github.io/WQV-online/research.html), or
run `python3 serve.py --port 8766` and visit
`http://127.0.0.1:8766/research.html` in Chrome, Edge or Opera.
The normal photo app stays at the site's root.

This page is for the WQV-3 and SigmaTel STIr4200 (`066f:4200`). It uses the same
USB transport and speed negotiation as the main app. It does not contact a
server or start a watch connection on load.

## The steps

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

`commandAttempted` records that the single send was attempted. `commandSent`
means the transport's send operation completed, not that the watch understood
or executed it. Errors and raw USB results must be checked alongside these flags.
An empty `response.bin` is also a result.

An export made during a run is a snapshot. Unresolved USB calls are listed in
`pendingUSBCalls`; late completions may appear in a later export. The event
trace, rather than an interpreted status field, is the primary evidence.

No unknown command has been sent to the watch as part of developing this page.
Its protocol behavior, raw capture, exports and manual stepping have software
tests; hardware probing remains a separate step.
