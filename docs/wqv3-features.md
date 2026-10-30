# WQV-3 protocol functions

This comparison covers communication with the watch. Palm categories, drawing,
slideshows and other local application functions are outside its scope.

| Function | CASSIOPEIA client |
| --- | --- |
| Download current photo or all photos | PC commands `00` / `01`; hardware checked. |
| Send a photo | PC and OTHERS / IrTran-P; one photo per connection, hardware checked. |
| Next / previous photo | PC `02` / `03`. A double-arrow tap sends five acknowledged steps. |
| Continuous browsing / stop | PC `04` / `05` / `06`. Holding a double arrow starts browsing; release, pointer cancellation, loss of focus or hiding the page requests a stop. There is a 30-second upper limit. |
| Set date and time | PC `07` with six fields; packet tests. |
| Write / read holidays | PC `08` / `09`; reading hardware checked, writing has packet tests. |
| Exit REMOTE | PC `0C`, requiring reply `0D`, followed by IrLAP disconnect. Original Palm command recovered; hardware check pending. |
| Photo caption and recording date | Casio JPEG APP2 fields on upload through either protocol. Original builder matched in emulation; edited-copy hardware check pending. |
| Image capabilities | SCEP `RIMG`, `RINF`, `RCMD`; already used by the sender. |

No additional normal watch command was needed for captions or dates. They
travel with the photo, so changing them adds another copy to the watch. It
does not edit an existing watch record in place.

## Caption and date bytes

The original [WQV Color for Palm OS 2.2 package](https://web.archive.org/web/20060627113204id_/http://ftp.casio.co.jp/pub/wat/download/en/wqv/3/WQVColor22.zip)
contains the reference builder. Its PRC SHA-256 is
`670d7a00eecb5df732825d2452b59cf834f3bda827c87c694ab9210c48e43e50`.
In code resource 2, instructions `005e84..005ee0` build 29 bytes:

| Bytes | Meaning |
| --- | --- |
| 0–23 | Caption, followed by `FF` padding. A full 24-character caption needs no terminator. |
| 24 | Year minus 2000. |
| 25–28 | Month, day, hour, minute; binary values, month and day starting at 1. |

The caller selects JPEG marker `E2` with 29 data bytes, producing the segment
header `FF E2 00 1F`. These fields are separate from standard UPF metadata.

The fixture [wqv3-photo-details-palm.json](../tests/fixtures/wqv3-photo-details-palm.json)
records execution of those original 68000 instructions in Unicorn, with a
caption and Palm `DateTimeType` supplied in memory. It covers an empty title,
a leap day, significant spaces, a full title and both date limits. There are
no operating-system calls or USB operations in that emulated slice.

The uploader replaces this segment, or adds it when absent, and preserves
unrelated JPEG metadata and compressed scan bytes. Tests compare image
fingerprints before and after editing. The stored original UPF and JPEG stay
unchanged; leaving the checkbox clear retains the existing upload behavior.

## Quit and browsing

The Palm manual's **Send Quit** returns the watch from REMOTE to IR COM.
`PCRemote_QuitRemoteMode` in code resource 3 (`0019de`) builds command `0C`;
the common handler accepts reply `0D`. The web client makes this an explicit
action. Closing USB, switching protocols and downloading photos do not
silently add a quit command.

The same manual describes five-photo steps for a double-arrow tap and
continuous browsing while held. The client uses the existing step and
start/stop commands. It does not guess another opcode for a five-photo jump.

Browser checks cover both upload paths, unchanged album originals, invalid
input, tap and keyboard steps, stopping after release outside the button,
cancellation, release during connection setup, and all three display languages.
These checks use simulated USB; they do not claim a new hardware result.
