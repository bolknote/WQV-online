# WonderWave and WonderWitch

Research notes, 23 October 2026.

WonderWitch programs did exchange data through WonderWave. Sasao's
[WonderWave file-transfer guide](https://web.archive.org/web/20020602165017/http://ha6.seikyou.ne.jp/home/sasao/junkhard/ww/wwave.htm),
updated in September 2001, gives a working setup: direct access to the PC's
infrared serial port, 9600 bit/s, eight data bits and no parity. Pressing
Enter in a terminal produces the WonderWitch shell's `meg>` prompt. The guide
specifically bypasses the Windows IrDA stack.

This makes a byte-oriented protocol a concrete possibility for WQV-3 SWAN
mode. It does not establish the watch's handshake or file format. WonderWave
supplies the infrared connection; the program running on the console decides
what the bytes mean.

## Code recovered

Sasao's [DOS2WW 1.4 documentation](https://web.archive.org/web/20020602163024/http://ha6.seikyou.ne.jp/home/sasao/junkhard/ww/dos2ww.htm)
explicitly supports WonderWave at 9600 bit/s and requires half-duplex operation
for infrared. Its
[download archive](https://web.archive.org/web/20060212103508/http://ha6.seikyou.ne.jp/home/sasao/junkhard/ww/dos2ww.lzh)
contains `DOS2WW.C`, alongside the DOS executables and instructions. The C source
configures 8N1, sends bytes directly to a serial library, and implements:

| Stage | Bytes sent or expected |
| --- | --- |
| Open shell interaction | Send `0D` (carriage return). |
| Prepare a file upload | Shell commands `delete "..."` and `put /rom0`, each ending in `0D`. |
| Begin binary upload | Wait for `15` (NAK); `18` cancels. |
| Send a block | `01`, sequence number, its XOR with `FF`, 128 data bytes, then `sum(data) & FF`. |
| Confirm a block | `06` advances the sequence; `15` requests a retry. |
| End upload | Send `04` (EOT). |

This is checksum XMODEM, with a 132-byte block. There is also a `#!ws` file
header for WonderWitch imports. These shell operations and that header belong
to WonderWitch; none has been identified in a WQV-3 SWAN capture.

The `/L` option consumes received bytes to work around local echo on some PCs.
It is evidence that echo must be considered, not a rule to discard the first
received byte on SigmaTel. Keep the original stream before attempting any
echo removal.

The separate [WW_COMM 0.8 archive](https://web.archive.org/web/20060212103858/http://ha6.seikyou.ne.jp/home/sasao/junkhard/ww/ww_com08.lzh)
contains a buffered serial library and echo-test source. It calls WonderWitch's
`comm_send_char` and `comm_receive_char` through interrupt hooks. No camera
handler or IrLAP discovery implementation was found in these sources.

## BIOS calls are local to the console

The [Wonder Witch Technical Manual](http://shaw.la.coocan.jp/wwtm/), communication
chapter (PDF pages 33–37), and its `COMM.INC` describe the console's INT 14h API.
It has byte/block I/O, 9600/38400 settings, timeouts and an internal XMODEM call.
`COMM_XMODEM = 0D`, erase states and encrypted-transfer constants are BIOS
definitions, not bytes to send to a watch. DOS2WW's Freya OS update option
likewise concerns the WonderWitch cartridge. It provides no evidence of Casio
firmware access.

## Consequences for the next watch experiment

The existing passive listener already saves every byte delivered by SigmaTel,
including bytes that fail IrDA framing or CRC. An absent decoded frame is
therefore different from an empty `usb-in.bin`; the previous empty recordings
cannot be explained solely by a strict CRC decoder.

Active Discovery sends XID frames. It cannot test a peer waiting for a raw
serial byte. A raw-serial experiment would need a separate transmit path:
the SigmaTel USB `55 AA` length wrapper is still required, but `sendFrame()`
adds IrLAP address/control fields, CRC and delimiters that a serial experiment
must not insert. The [Serial bytes mode](command-research.md#raw-serial-probes)
now implements this path with manual probes and original-byte exports.
Software tests cover framing, repeated NAK, one-shot CR, stopping TX on any
incoming byte, pending USB operations, FIFO failure and checksum-block detection.
The watch handshake remains unverified on hardware.

On 23 October, three 20-second SWAN SEND runs completed: ten NAK writes,
one CR write, and a listen-only control. All returned zero USB bytes after
22,460 successful reads in total. The writes and FIFO checks completed without
errors; two additional NAK/listen runs were also empty. These tests did not
confirm checksum XMODEM or a terminal handshake. The user then verified that
the normal WQV Link page could communicate with the watch using this adapter.

The next passive experiment is **SWAN RECEIVE**: capture before activating
reception to look for any initial bytes from the watch in that role. A working
normal PC connection is already established; it need not be repeated before
this capture.

For SWAN, use a separate 9600-bit/s capture for each deliberately
chosen raw-byte probe, restarting the watch mode between attempts. Preserve
requested USB writes, completion status, all incoming bytes and screen notes.
`15` is a source-backed XMODEM receiver-start hypothesis; `0D` is a confirmed
WonderWitch shell interaction. Neither is a confirmed Casio SWAN command.
The shell's delete, upload and execute commands are not watch-test presets.

## Source copies

Original downloads and decoded Japanese text are retained locally under the
ignored `coverage/wonderwitch/` directory. No downloaded executable was run.

| Download | SHA-256 |
| --- | --- |
| `wwave.htm` (2002-06-02 capture) | `df3376602999bbb5cdfde0c10b306f24721eb4666cf8c3e2f396b1607c4cca1b` |
| `dos2ww.lzh` (2006-02-12 capture) | `7df48fc80c0dbdb8b4e4d64a0605abac2f2665818fa57e23806e79f28ce978ad` |
| `ww_com08.lzh` (2006-02-12 capture) | `6987e4933d37e2098ae9be1a01c45bf185d8804ba35e15619d52283b564af8a3` |
| `wwtm.zip` | `99f0c0710e2f0019111d1264370dbfae4b590d329cdcad8e9834b8febb10b646` |
