# WQV-3 WATCH photo exchange

WQV-3 WATCH SEND and WATCH RECEIVE use the existing IrCOMM/TinyTP/SCEP/bFTP
stack from the OTHERS implementation. They do not use SWAN's SUM16 protocol.
The app presents WATCH as its own mode and keeps its photos in the WQV-3
album. Clock, calendar and remote photo controls stay in PC mode.

`dist/watch-peer.mjs` supplies the WATCH discovery identity and the link
settings used in the successful native experiments. `others-client.mjs`
dispatches either protocol behind the same manual transfer window. No
infrared traffic is sent during USB preparation or before Start. Reception
primes the adapter with one XID, then only answers the watch's search.

The discovery identity is `8c0400434153494f2057494320323431312f4952`:
hints `8c04`, ASCII charset, `CASIO WIC 2411/IR`. Device addresses are generated
for each transfer, not copied from the captured watch. Discovery uses 9600;
SNRM/UA agree on the fastest shared rate through 115200. A lower-speed offer
is accepted without restarting an application request. The link keeps
256-byte data frames and a window of one, with at least 10 ms between RX
and TX. The peer's offer must support these frame and timing parameters.

IAS finds `IrDA:IrCOMM` and its TinyTP selector. SCEP/bFTP, image handling,
capability queries, PUT replies and closure reuse the existing OTHERS code.
The sender uses the peer's SCEP limit, 2048 bytes in the physical test, and
sends exactly one PUT per connection. IrLAP retransmissions retain that
request and sequence, rather than making another application upload.

Received UPFs retain their original bytes. Album records and WQV backups
identify their source as `watch`; image export and imports use the same
formats as OTHERS. The normal photo-details editor can change metadata in
a sent copy. An interrupted upload is reported as uncertain, with advice
to check the watch memory before trying again.

## Hardware evidence, 6 November 2026

`tests/fixtures/wqv3-watch-hardware.json` contains the recorded input and
expected output of both directions at 9600 and 115200. Its input image is the synthetic
`KS-959 / 8B / BB5E57` test picture, not a personal photograph.

Receive source: `WQV-WATCH-PHOTO-KS959-2026-11-06T11-20-13.022Z.zip`, SHA-256
`bdc89e70a05a185132a85da752566a98bea5d905834ac7d65103b68b5b2ea69d`.

- 12,215 original USB bytes, 12,167 SIR bytes, 98 valid CRC frames.
- 68 protocol replies after the initial receiver prime; normal SCEP and
  IrLAP close, without repairs or retransmissions.
- Original `QW000000.UPF`: 10,537 bytes, SHA-256
  `b3599f8b9f7fe2b55735574e17d787be6d0968adeb7fdf9d62b8566fc618aafb`.

Upload source: `WQV-WATCH-UPLOAD-KS959-2026-11-06T11-48-33.693Z.zip`, SHA-256
`75e6cda009cc5a9f3b8842235eb068dd413eaa951e6833f42a35fc9ecb614c47`.

- The same UPF, unchanged, sent in six SCEP segments with one PUT.
- 137 host frames, 184 encoded USB writes, 128 CRC-valid received frames.
- Five link data retransmissions and one recovery poll, followed by a
  positive RPL0, SCEP Disconnect, IrCOMM disconnect and IrLAP DISC/UA.
- The user confirmed that the expected picture appeared on the watch.

The higher-speed receive source is
`WQV-WATCH-PHOTO-KS959-2026-11-06T12-50-10.062Z.zip`, SHA-256
`4ee3f5b75c2a8ca857633d2be82dde1a5199161624cf41d6983262f4ab6ae6de`.
It completed at 115200 in 6.53 seconds, with 81 CRC-valid input frames,
70 host frames and no retries or repairs. The received pixels matched the
earlier picture exactly; metadata differed. Its original UPF is stored as
`upf115200Hex` in the fixture.

The higher-speed upload source is
`WQV-WATCH-UPLOAD-KS959-2026-11-06T13-06-10.416Z.zip`, SHA-256
`5c2f6b56efc437ae8f20413af06e9961df4aaf18f6432080812d3b35522a771a`.
It completed at 115200 in 10.94 seconds. All 128 input frames passed CRC;
132 host frames carried one unchanged UPF in six SCEP segments. There were
no data retransmissions and one recovery poll. RPL0 and all-layer closure
were positive, and the user confirmed the picture appeared on the watch.
The original 1712 high-speed USB OUT chunks each used at most eight useful
bytes. Native speed commands prove 9600 → 115200 → 9600 for both tests.

`tests/watch-peer.test.mjs` replays every protocol reply in both directions,
checks the exact UPF, one PUT, retransmissions, link limits and restoration
of adapter settings. `tests/browser/watch-peer.cjs` runs the real app with
the recorded exchanges at a simulated adapter boundary: both transfer
directions, manual start, UPF export, shared album, persistence, translations
and a narrow viewport. These tests do not replace a physical browser run at
115200. The user confirmed a browser transfer at the earlier 9600 default.
The native experiments used KS-959; WATCH through SigmaTel is unverified.
