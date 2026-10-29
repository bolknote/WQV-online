# The Magic Control driver on the WQV Link CD

28 October 2026.

The hybrid WQV Link 1 CD contains `DRIVERS/WIN2000/U2SWDM.SYS`, not the
SigmaTel `STIRUSB.SYS` driver. Its INF matches Magic Control Technology USB
`0711:0230`, and the accompanying port INF creates a serial-port device. The
external PAD-2 provides the infrared part of this connection.

The exact original SYS has SHA-256
`8d500b010de337a357ec6e469071d6d5a56427164e5aa685ef060787351ed01a`.
It is a 21,673-byte x86 PE image. The following results come from this
binary, rather than an assumption that every MCT firmware behaves alike.

## What was emulated

The workspace script `work/wqv12-native/research/emulate_mct.py` executes
the ioctl-to-vendor-request translator at `1362E` in Unicorn. Its device
extension, IRP and serial settings are synthetic. The vendor-request helper
at `138C0` is intercepted before it allocates a URB or submits USB traffic.
No driver entry point, Windows kernel routine or adapter is run. All 22
configuration cases and their outgoing request buffers are saved beside the
script in `mct-windows-traces.json`.

## Results

| Serial operation | Original Windows driver's generated request |
| --- | --- |
| Set 115200 bit/s | request 05, one data byte 0C |
| Follow baud change | request 0B with 00, then request 0C with 01 |
| Set 8 data bits, no parity, one stop bit | request 07 with C3 |
| Set 7N1, 8E1, 8N2 for comparison | request 07 with C2, DB, C7 respectively |
| Disable / enable CTS flow control | request 0C with 00 / 01 |
| Modem output masks 08, 09, 0A, 0B | request 0A carries the corresponding byte |

The driver's baud table maps 300, 600, 1200, 2400, 3600, 4800, 7200,
9600, 19200, 38400, 57600 and 115200 to codes 01 through 0C. Thus 115200
is an ordinary table entry, not a hidden alternate rate. These are MCT
commands and values, not SigmaTel register writes.

The original Casio COM setup enables DTR/RTS outputs and disables CTS-based
output flow control. The Windows driver's baud handler initially sends 0C/01;
its separate handflow handler can subsequently send 0C/00. Those are distinct
operations, not contradictory measurements. The Linux MCT driver also
describes the two extra requests and the CTS function of request 0C.

In these handlers there is no infrared modulation or pulse-width setting.
They configure the serial cable feeding the PAD-2. Its optical electronics
and their exact timing cannot be reconstructed from this UART translator.
This does not identify a new physical SigmaTel setting to copy.

## The SourceForge WQV-2 client

The [WQV-2 protocol page](https://wqv-wristcam.sourceforge.net/protocol/protocol.html)
and its Java source are already in the research corpus. The source differs
from our reader in two relevant ways:

1. Its implemented image download issues `10 01` (all pictures). `10 00`
   (one picture) appears as a comment. WQV Blink's tested wqv12 firmware
   also implements the all-picture path. Our two failed image tests so far
   both used `10 00`.
2. `readFrame()` computes SUM16, but a mismatch only produces
   `log.warning("Wrong checksum")`. The method still returns the body,
   and the caller can continue with the next `11` request. Our reader
   rejects that body and retries the original request.

That second difference may matter when interpreting reports that the old
program works. It does not establish that a damaged picture is intact. The
current reader keeps strict checksums on all accepted image data.

The repeatable E4 checksum in replies to `10 00` is not yet explained. A
controlled comparison can now change only the request to `10 01`, using the
existing `--all` mode, the normal RX threshold and the corrected 10 ms guard.
If the same invalid ACK occurs, a further diagnostic can query the next
documented header state with `11` and require a valid header, rather than
silently accepting the damaged acknowledgement. That recovery has not yet
been implemented or tested.

Other sources: [original Link 1 manual](https://archive.org/download/ar405jpn_202403/Manual/English/WQVLink_Manual_E.pdf),
[Linux MCT driver](https://github.com/torvalds/linux/blob/master/drivers/usb/serial/mct_u232.c).
The original driver, INFs, disassembly and emulator traces are retained in the
local workspace; the SYS is not included in the public project.
