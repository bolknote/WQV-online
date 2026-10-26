# Windows CE 2.11 IrDA/IrCOMM compared with WQV Link

2026-10-25

The five SCEP PUT packets in our native two-photo test match CSI's output,
but the transport carrying them does not reproduce Windows CE. The original
CE 2.11 components confirm differences in frame sizing, acknowledgement
turns, initial TinyTP credits and IrCOMM control traffic. These give us a
concrete transport experiment. They do not establish why the watch rejected
the batch or whether it can save two photos in one connection.

## Original components and scope

The components come from Microsoft's original
[Windows CE 2.11 Platform Builder CDs](https://archive.org/details/MicrosoftWindowsCEPlatformBuilder2.11Disc1.iso.7z),
preserved on Archive.org. The compressed CDs' SHA-1 and MD5 values match the
archive metadata. The ISO volume identifies Microsoft as its publisher.
No installer was run and no Windows CE system was booted.

| Component | Original ISO location under `PUBLIC/COMMON/OAK/` | SHA-256 |
| --- | --- | --- |
| IrLAP | `LIB/MIPS/R4100/CE/RETAIL/IRLAP.LIB` | `b65dea3628c9c311c424e5673ee2ccaefe42d97c9cf50fb9b8871a0c6b1e2951` |
| IrLMP / TinyTP | `LIB/MIPS/R4100/CE/RETAIL/IRLMP.LIB` | `aaabc8de178291d46d7e346598038f45bb45708a96add8f6dd041569b63d5fc7` |
| IrDA socket provider | `LIB/MIPS/R4100/CE/RETAIL/IRTDI.LIB` | `1ad99d060e8785af693fc76bfb4606d41a0422ee4c7f07695c5bb698a6787a48` |
| Virtual serial driver | `TARGET/ARM/ARM720/CE/RETAIL/IRCOMM.DLL` | `d44cbaaec2446205f48f9e35258792870ec6dc32ed12faab7f249abaf0b3c78b` |

The MIPS libraries were built in August 1998. The ARM DLL's PE timestamp is
1998-08-28. This is the standard Microsoft stack from CSI's OS generation,
not a recovered CASSIOPEIA OEM ROM. The ARM DLL was examined statically;
selected MIPS functions were interpreted in isolated memory. The CE 6
source used during the initial search is not the basis for calling these
results CE 2.11 behavior.

CSI's own `IrTranP.dll` opens the supplied `COM3:` port and calls
`ReadFile`/`WriteFile`. Its imports contain no `SetCommState`,
`SetCommTimeouts`, `EscapeCommFunction` or `DeviceIoControl`. The earlier
CSI sender execution therefore verified application bytes, not this system
driver or the physical link.

## Confirmed differences

| Layer | Original CE 2.11 | Outgoing research client with the `current` profile |
| --- | --- | --- |
| IrLAP QoS | Negotiates data size, window, turnaround, BOFs and link timers | Selects baud; other outgoing limits remain fixed |
| Data size with our captured 9600 offers | 256-byte IrLAP information field; virtual serial driver can supply up to 251 application bytes | 60 application bytes per fragment |
| Incoming I(F), with acknowledged outgoing data and more data queued | Can send the next I(P), carrying N(R) | Sends RR(P), waits for RR(F), then advances the queue |
| IrCOMM startup | Enables the socket's 9-wire mode; no separate serial-control sends | Sends service selection and baud / format / DTR / RTS control packets |
| Initial TinyTP receive credits | 4 | 14 |
| Receive-credit replenishment | Follows consumption of the stack's receive buffers | Grants 6 when the local remaining allowance is at most 6 |
| Link recovery | Includes resend, receive-window and busy-state machinery | Restricted transaction state machine, with a specific final-RR recovery |

### Frame size: the 2048-byte SCEP change did not change this layer

The original MIPS `NegotiateQosParms`, COFF section 33 in `irlap.obj`, was
executed with the exact SNRM and UA parameter lists from native attempt
`30def0dd-d039-4083-b004-0a490428487d`. Its original helper and lookup tables
were also executed. Only COFF addresses were relocated; no OS calls were
stubbed in this calculation.

The result is 9600 bit/s, a 500 ms maximum turn, 256 data bytes, a one-frame
peer receive window, a 5000 microsecond minimum turnaround and one BOF
including the opening marker. The supported 2048-byte size is reduced to
fit the permitted line capacity at 9600. The same code selects 1024 bytes
at 38400 and 2048 at 115200 when fed synthetic baud masks; those two cases
are offline calculations, not additional hardware results.

The original serial driver's maximum application chunk follows this path:

1. `IRLMP!IrlapConnectConf` subtracts three bytes for IrLMP and TinyTP.
2. `IRTDI!IRLMP_GetSocketInformation` subtracts one in 9-wire mode when
   returning `IRLMP_SEND_PDU_LEN`.
3. `IRCOMM!TxThread` uses that returned limit minus one.

For this recorded negotiation, that gives `256 - 3 - 1 - 1 = 251` bytes.
The last subtraction is present in the original DLL at `0x100020ac`; it
is not an invented extra header. The option result is stored at
`0x100030b4` and consumed by the transmit thread at `0x10002050`.

Our `IrTranPCSIProbe.afterIAS()` fixes `chunkSize` at 60. It keeps doing
that when a SCEP packet is 2048 bytes long. SCEP packets and IrLAP frames
are different boundaries. A larger SCEP packet alone cannot reproduce
the original transport's larger fragments.

The negotiated BOF count also differs from our fixed eleven opening
bytes. A physical miniport and its turnaround handling were not emulated,
so this calculation alone is not an instruction to remove SigmaTel's
existing padding.

### Acknowledgements: data can carry N(R)

The original `ProcessIFrame`, section 56 in `irlap.obj`, calls
`XmitTxMsgList` after a valid I(F) when the outgoing sequence is
acknowledged and there are no receive gaps.

`XmitTxMsgList`, section 20, was executed separately with explicit queue
and send stubs. With a one-frame window and queued data, it chooses
`SendIFrame` with P=1. With an empty queue, a busy peer or local busy state,
it chooses `SendRR_RNR` instead. All four cases were checked. This is the
original queue decision; the stubs do not pretend to transmit a frame.

Our `IrTranPIASProbe.frame()` always sends `ias-reply-ack` after an I(F).
The next outgoing application fragment waits for another RR(F). Much of
that exchange can be replaced by the next data frame acknowledging the
peer's frame. A replacement must still respect N(R), sequence gaps,
credits and busy state; simply skipping every RR would be wrong.

In the native failed batch there are 340 outgoing frames, including 139
PUT fragments and 159 empty RR requests. The 139 fragments carry 8136
SCEP bytes. Of 153 received TinyTP data/credit PDUs, 148 grant one credit
and five grant none. There are no received SAR fragments. These counts
explain where many extra turns occur; they do not mean all 159 RR requests
are unnecessary.

### IrCOMM startup and control parameters

The original DLL enables `IRLMP_9WIRE_MODE` with socket option 22 and
queries the send-size limit with option 19. Its only direct `send()` call
is at `0x10002120`, inside `TxThread`. Its bytes come from the ring filled
by `COM_Write`. There is no separate send path constructing baud-rate,
service-selection, DTR or RTS packets.

Our outgoing client adds `000104` and `10040000258011010320010c` before
SCEP Connect. Those were borrowed from the working PC-mode path. They
were never extracted from CSI's application DLL, and the original system
driver does not supply them either. They are a real difference, not proof
that these valid IrCOMM controls caused the batch failure.

The original IrDA provider's `IrlmpDataInd`, section 3 in `tdiup.obj`, does
not implement modem-line flow control here. In 9-wire mode it accepts the
zero-control prefix; a nonzero control-length frame takes the ignore path.
Unlike the later CE 6 code, it does not pass a mixed control/data frame's
remaining application bytes. Our client logs controls and continues with
any following application bytes. The only nonempty control block in the
native recording is a control-only frame, so this receive-path difference
does not discard any image bytes in that recording.

### TinyTP framing already matches

The original `FormatAndSendDataReq`, section 25 in `irlmp.obj`, was
executed with explicit reference-count and lower-send stubs. Given our
SAP values, it produces:

| Input | Header before the application bytes | Consumes a transmit credit |
| --- | --- | --- |
| 9-wire application data, no returned credits | `03 09 00 00` | Yes |
| 9-wire application data, four returned credits | `03 09 04 00` | Yes |
| Credit-only TinyTP PDU returning four credits | `03 09 04` | No |

These header rules match our client. A grant-only PDU must not contain a
spurious IrCOMM control-length byte or consume a data credit. There is no
evidence that a missing TinyTP header byte or SAR caused the recorded
failure. The different initial allowance, four versus fourteen, is a
profile difference rather than evidence of an invalid credit algorithm.

## What this changes about the next experiment

The separate `wince211` research profile now applies the recovered frame
sizing, sends queued I frames with piggybacked acknowledgements, omits the
added serial-control sends, and uses four initial receive credits. Credits
are replenished in groups of four once the previous allowance is consumed.
The **Two photos: Windows CE 2.11 transport** plan sends the same unchanged
10/07FB and 11/07FB files at 9600 in one connection, then offers two manual
read-back steps. SCEP still uses the peer's receive limit.

This profile advertises a one-frame receive window, matching our implemented
primary state machine. It honors a peer minimum turnaround greater than the
existing 5 ms floor and retains SigmaTel's existing eleven opening bytes.
It does not claim the complete retransmission, timer, buffering or physical
miniport behavior of Windows CE. Other plans retain the `current` profile.

The frame-size tests use results independently obtained from the original
machine code. A simulated complete transfer checks every byte of the same
five original CSI packets, N(S)/N(R), four-credit replenishment, no serial
controls and normal closure. A second case verifies that peer RD after
PUT 2 still produces an incomplete result. These are software checks,
not a successful hardware batch.

This profile tests recovered behavior below SCEP while keeping both files
in one connection. A successful first PUT reply still needs the same
distinction from a saved photo and a fully accepted batch as in the
previous tests.

## Hardware result with the new profile

Attempt `da28d58e-d2c3-4fff-b489-574adc880aa7` ran through the same native
USB bridge as the previous comparison. It used `wince211`, the same two
07FB files, one connection and 9600 bit/s. The actual negotiation selected
256 IrLAP data bytes, 251 application bytes, a one-frame window and a
5 ms minimum turnaround. All five PUT packets were transmitted in 36
application fragments. Independent decoding checks all 74 USB OUT frames
and every PUT byte against CSI, plus all 55 received frames' original
FCS values. Eight damaged opening markers were recovered without changing
payload or FCS bytes; no bad CRC remained.

The first PUT gets RPL0. The second PUT gets no application reply. Its
last I frame, N(S)=5, is acknowledged by the watch with N(R)=6. The next
RR poll gets RD, then DISC/UA closes the link. There are no queued output
bytes or unresolved USB calls. Relative to IrLAP connection, the first
PUT starts at 1.881 s, its RPL0 arrives at 8.345 s, and RD arrives at
14.253 s. The previous native profile reached RD at about 23.3 s.

The user checked memory afterward and found neither photo 10 nor 11.
The result is therefore an unsuccessful batch, with `complete=false` and
one protocol acknowledgement, not one verified saved image. Larger frames,
direct acknowledgement progress and the other recovered settings reduce
transport overhead but do not fix this batch failure. These results still
do not prove a firmware limit or reproduce the complete Casio OEM stack.

`tests/wince211-hardware-fixture.json` retains the original USB IN result
boundaries, empty reads and all 74 expected outgoing frames. Its regression
replay must keep the incomplete verdict. The local capture directory is
`work/irtranp-native/captures/2026-10-25T09-57-38.820Z/`; its analysis records
the user's memory observation separately from the original capture ZIP.

## Reproduction and records

A separate timing experiment adds `interPutDelayMs=2000` after the first
positive RPL0. It keeps the same SCEP/IrCOMM/IrLAP connection open and uses
the normal IrLAP polling and TinyTP credit handling during the gap. The
same five CSI PUT packets and the same two 07FB inputs are retained. No
blocking sleep or second file connection is used. The raw journal records
`put-gap-started`, each transmitted `put-gap-poll`, and `put-gap-ended`
with the measured delay; the result retains an interrupted gap too. Stop
or peer RD during that interval prevents the second PUT.

Run the prepared native test with `--wince211 --inter-put-delay-ms 2000`.
The default remains zero. This is a hypothesis about time needed to save
the first image, not a recovered CSI delay requirement. Software tests
verify the two-second pause, continued polls, unchanged packets and early
termination.

The user then ran attempt `5d7be852-7445-4718-a07c-8ef926eb9e06` in Terminal,
saved under `work/irtranp-native/captures/2026-10-25T15-01-25.864Z/`. The gap
lasted 2171.758 ms with twelve RR polls, at most 182.019 ms apart, and no
application writes. One IrCOMM/IrLAP connection was kept throughout.
Independent decoding validates all 77 outgoing and 67 incoming frames,
including five BOF repairs with unchanged FCS, and all five PUT packets
still match CSI exactly. The final PUT I frame (N(S)=5) is acknowledged
by N(R)=6. PUT 3 gets RPL0, PUT 4 does not; the watch again requests RD,
followed by DISC/UA. The user checked memory and found neither image.
The result stays `send-incomplete`, `complete=false` with no pending output
or USB calls. The two-second gap did not fix the batch; it does not prove
an absolute firmware limit or rule out every timing issue. The original
ZIP is retained unchanged; `analysis.json`, `wire-check.json` and
`independent-crc-check.json` are separate analysis files in that directory.

The local audit directory is `work/ircomm-stack-audit/` in the parent
research workspace. It contains the original download manifest, annotated
COFF disassembly and these scripts/results:

| Script | Record |
| --- | --- |
| `coff_audit.py` | Annotated original COFF sections, symbols and relocations |
| `trace_qos211.py` | `qos211-trace.json`: three original-code QoS cases |
| `trace_turn211.py` | `turn211-trace.json`: four original-code queue cases |
| `trace_tinytp211.py` | `tinytp211-trace.json`: three original-code header cases |
| `inspect_ircomm211.py` | `ircomm211-static.json`: checked ARM instructions and API call sites |
| `compare_capture.py` | `comparison.json`: capture counts and audited code hashes |

The interpreted functions cannot access USB, sockets or the host file
system. The ARM DLL was not executed. No hardware retry was performed for
this audit, and no original Microsoft binary or source is added to this
repository.
