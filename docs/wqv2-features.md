# WQV-2 features and remaining work

The original reference is Casio WQV Link for Palm OS 1.1, downloaded from
Casio's WQV-1/2 directory. Its `manual.txt` describes the watch operations and
the Palm-only editor separately. The [original ZIP](https://web.archive.org/web/20060627195345id_/http://ftp.casio.co.jp/pub/wat/download/en/wqv/1-2/wqvlinkpalm11.zip)
is preserved in the local research corpus. This comparison covers that
program, the old PC protocol and our WQV-2 app; it is not a claim that every
possible watch command has been found.

| Function | WQV-online status |
| --- | --- |
| Read the displayed photo | Implemented; checked on WQV-2 through SigmaTel and KS-959. |
| Read all photos | Implemented; all five original records matched between adapters. |
| Read the current watch time | Implemented through the PC greeting; hours, minutes, seconds and fractions, without the date. The Clock tab can request a fresh reading. |
| Set date, hours and minutes (`Send Time`) | Implemented. Payload and completion match the original Palm 68k code; software and browser tests pass. Hardware check pending. |
| Receive a photo from OTHERS SEND | Implemented with SUM16. Browser tests use simulated watch responses; the corrected receive settings still need a WQV-2 hardware check. |
| Send a photo to the watch | Not implemented in the WQV-2 app. The old protocol and original Palm program have this operation. |
| Previous/next photo on the watch | Not implemented. The original program has steps of one or five photos and continuous scrolling with a stop command. |
| Explicitly leave REMOTE (`Send Quit`) | Not implemented as a separate application command. Our ordinary PC operations close their data-link connection. |
| Edit an image and send the edited copy | Not implemented. Original Palm tools include pencil, brush, eraser, eyedropper and a new blank image. |
| Edit a photo title or recording date | Not implemented. Original Palm edits these locally, then sends an image record back to the watch. |
| Local album, local deletion and backup | Implemented: original BIN records, PNG previews and ZIP exports. These do not delete photos from the watch. |
| Palm categories, privacy, Palm-to-Palm beaming, FireViewer export | Palm application features; not watch commands. No equivalents in this app. |

The original WQV-1/2 Palm application does not establish support for reading
the full current date, editing WQV-3's holiday bitmap or remotely deleting
watch photos. Those should not be presented as missing implementations of
already known WQV-2 commands.

## Clock request recovered from the original program

`WQVLink.prc` SHA-256:
`2bee7758b7b3feaf170c16984bd7aa8e3cfce733f07f644178ed55ffed385f90`.
The SHA-256 of its `code` resource 1 is
`7bef8ef76a2e713ac6debbb20b313b848af0adbb6e3539f206bc9a3e1a57c57c`.

`WQVTimeSync` calls `IFTP_TimeSetFile`, which obtains the local date and time
and invokes `IFTP_TimeSetRequest`. Builder `send_TSR` at `00b502` emits seven
bytes:

```text
0D  year−2000  month  day  hour  minute  weekday
```

Months are one-based. Sunday is weekday zero. Year conversion in the original
builder adds `30h` to the low byte of the year, equivalent to subtracting 2000
in the supported 2000–2039 range. Seconds are absent. The original manual
also says the watch's seconds count is kept unchanged.

The transaction after a fresh PC connection is:

```text
PC → watch   adr 10  0D yy mo dd hh mm wd
watch → PC   adr 21
PC → watch   adr 11
watch → PC   adr 20  06
PC → watch   adr 32  08 00
watch → PC   adr 41
PC → watch   adr 53
watch → PC   adr 63
```

The `08 00` completion comes from the original `deal_pread1` handler after
`OP_ACK`. Despite the original helper name `send_error`, status zero ends
this request normally. It is not another clock-setting operation. The
implementation waits for the application ACK before reporting that the
watch accepted the date; a link ACK alone does not suffice. Missing responses
repeat the same numbered frame or poll. They do not start another session.

The workspace script `work/wqv12-native/research/emulate_palm_clock.py` runs
the original request builder, frame encoder and response handler in Unicorn
with a Motorola 68000 CPU. Logging, timers, memory APIs and serial output are
stubbed. Eight cases cover the beginning and end of the supported range, a
leap day, and seconds values zero and 59. The output in
`tests/fixtures/wqv12-clock-palm.json` contains generated packets and hashes,
not copies of Casio's program.

The Clock tab preserves the actual greeting time as a snapshot. A successful
write does not substitute the requested value for a readback. The user can
read again after re-entering PC mode on the watch.
