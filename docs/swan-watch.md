# WQV-3 SWAN in the CASSIOPEIA app

The SWAN mode in `wqv3.html` transfers one photo in either direction. It uses
the same album as PC and OTHERS, without the PC clock, calendar or remote
browsing controls. SEND and RECEIVE in the transfer window always describe
the watch's role.

## Wire protocol

This implementation ports the native Python receiver and sender checked on
the owner's WQV-3 on 30 October 2026. It uses 38400, 8N1, with `55 FF 00`
before each `C0 … C1` frame. The frame contains address, control, payload and
big-endian SUM16; C0, C1 and 7D are escaped. It shares framing with WQV-1/2,
but SWAN has different image opcodes and a different record layout.

The handshake is B3/A3, 93/63 and RR11/RR01. A3 contains a four-byte challenge
which 93 echoes; it is not a clock-setting request. The host proposes address
7 when sending, or accepts the address proposed by the watch when receiving.
The offer `10 FA 63 1D` announces one 25,373-byte record. A numbered `0D`
accepts it. Data packets start with `11` and carry up to 1024 record bytes.

Numbering uses N(S) in control bits 1–3 and N(R) in bits 5–7. Each direction
has its own sequence. A repeated receive block is acknowledged without
appending its pixels again. On a sender timeout, the same frame and N(S)
are retried, at most three times after the initial attempt. Rejected
checksum frames never reach the application. The image offer and whole
photo are never restarted automatically.

On reception the final application response is `42 / 0D`, followed by the
watch's DISC53 and the host's UA63. Sending uses the tested explicit final
acknowledgement: after the watch's `42 / 0D`, send RR51, expect RR41, then
send DISC53. The native watch tests stored and displayed the image even
though no full UA63 followed. `photoTransferComplete` and
`linkCloseConfirmed` remain separate. The UI says the photo was sent after
its application acceptance and final acknowledgement, while reporting an
unconfirmed disconnect in the detail. It does not claim a visual check of
watch storage.

## USB and lifecycle

`prepareSwan` stops the previous reader, configures SIR and verifies the
SigmaTel 38400 register settings. It sends no IR. Only after the user's
Start does the client run the known preparation sequence: one IrDA discovery
at 9600, change to 38400 and send the bare prefix. The watch activation cue
follows that sequence. There is no PC keepalive sharing the adapter.

KS-959 uses the existing local helper for its control transfers. Its RX
counter is synchronized by one uniquely decoded SUM16 A3 challenge or two
valid B3 greetings. A counter already known from another protocol is
preserved, and the advanced counter is returned to the PC/OTHERS transport.
Neither a speed change nor opening the adapter is treated as a counter
reset. Original USB input and decoded SIR bytes are recorded separately.

SigmaTel uses its ordinary bulk envelope `55 AA <length-le16> <SIR bytes>`
and waits for the transmit FIFO to drain. The receiver retains RXDSNS code
1 (8 samples), MODE 2A and DPLL 15. The 31 October direct optical bench found
some prefix-only errors at 38400 with both 8 and 28 samples; it did not
establish a replacement SWAN default. SUM16 frames are never repaired by
guessing bytes.

The common WQV-1/2 reader supplies strict framing, USB ownership, a 10 ms
RX-to-TX guard and abort-aware waiting. SWAN has its own application and
closing sequence. Cancellation or the overall deadline closes USB and ends
the caller's wait even if the USB promise remains unresolved. An incomplete
session releases the adapter. Completed received records survive a later
connection error.

## Image storage

The record is 24 ASCII caption bytes, five date bytes (YY MM DD hh mm), then
25,344 row-major RGB332 pixels. The captured caption `*  A   AAAB` and date
`00 01 06 12 1F` are preserved, along with every pixel. Unknown metadata
bytes stay in the original record.

The album keeps `swanRecord` separately from its derived JPEG and UPF. A WQV
archive contains the record's hex bytes and SHA-256 as well as a normal
derived UPF transfer archive. Import verifies the raw-record hash before
building a preview. Collection ZIPs include the raw BIN as well. Received
records sent back through SWAN bypass JPEG decoding; editing their caption
or date changes only the first 29 bytes. Other album images are decoded and
quantized to RGB332 for SWAN upload. Each receive/import remains a separate
album entry, including identical pictures.

## Verification and limits

`tests/fixtures/wqv3-swan-hardware.json` preserves the successful named-photo
capture, its source ZIP hash, the entire original SIR stream, all host replies
and the record/pixel hashes. The receiver replays all 33 original replies
exactly. Sender tests compare the nominal reverse exchange, omitting one
captured idle RR turn and adding the tested final RR51/RR41 turn. The actual
final incoming frames are retained in
`tests/fixtures/wqv3-swan-close-hardware.json`.

Protocol tests cover strict checksum rejection, repeated blocks, lost ACKs,
offer rejection, invalid size, missing UA, record metadata and pixels, KS-959
counter phases, cancellation and a USB promise that never completes.
`tests/browser/swan-watch.cjs` runs the real web protocol and album code with
fake USB devices for both transports. It verifies the original caption,
exact upload frames, raw BIN export, WQV backup/import, duplicate entries,
PC/OTHERS switching, three display languages and a 360-pixel layout.

The physical SWAN checks used KS-959 with the native client. SigmaTel passed
short-frame optical adapter tests at this speed; a complete SWAN photo
exchange through SigmaTel has not yet been verified on the watch. The new
integrated web path also awaits its first physical watch run. This does not
add WonderWave emulation, multiple photos per connection, watch deletion or
firmware commands.
