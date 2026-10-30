# IrTran-P research

The main CASSIOPEIA interface now supports OTHERS transfers, one photo per
connection. Single-photo uploads have completed at 115200 bit/s with the
watch's 2048-byte SCEP limit. The owner has also confirmed the integrated
interface works. See the [README](../README.md#others) for normal use and
[link recovery](irtranp-link-recovery.md) for the current retry behavior.
The sections below retain the earlier experiments and intermediate results.

Open `irtranp.html` on the local server. This is a separate experiment for
OTHERS mode; it does not use the normal app's PC-mode switch command.

## Sending a photo back: one upload verified at 9600

**Send a watch photo back** opens the same outgoing IAS/IrCOMM/SCEP path
already tested for capability queries, then sends a bFTP PUT. Choose
**Single test**, this test, a speed limit, and **Use last received photo**
or an original watch `.UPF` file. The input is limited to 128 KiB and must
contain the WQV-3's 176×144 baseline JPEG with 4:2:0 sampling. The UPF bytes
are not converted. Prepare USB before enabling OTHERS RECEIVE on the watch.
Start here, then press the watch's front button to activate reception.

The default adds one photo copy. **Two copies in one connection** is an
explicit write test and requires the peer's RCMD multiple-command flag.
Each PUT gets its own command ID, starting at 3 after RIMG/RINF/RCMD.
The sender waits for a matching positive RPL0 or negative ERR0, and stops
the sequence at the first refusal. File-size, empty-memory, low-battery and
incompatible sampling reports can prevent PUT altogether. Capability bytes
and the local decision are retained in the journal.

`put-started` means a request was queued, not that a photo was saved.
`put-reply.accepted` is the watch's acknowledgement. `sent` additionally
requires a completed session close. A missing reply leaves the write
**unconfirmed**: the photo may have been stored. No PUT is automatically
repeated. The ZIP has the selected original in `upload-input/`, its SHA-256,
every raw USB call/result, application bytes, the peer replies and separate
upload analysis. Merely selecting a file cannot produce a passed verdict.

An upload's `passed` verdict is confined to the protocol exchange, not a
check of the watch's stored photos. The UI calls it **Upload acknowledged**
and the report records `storageVerification.status=not-checked-in-this-attempt`.
The paired read-back steps provide the separate image-content check. For the
two-file test, keep the watch in OTHERS RECEIVE while the computer sends both
photos automatically. Then use two separate OTHERS SEND attempts: photo 10
in the first read-back step, photo 11 in the next. Both previews and captions
are shown before the upload; each read-back step names the required number.
If that number is absent on the watch, record it as the skip reason rather
than selecting another photo. Absence reported by the user is retained as
an observation; a protocol acknowledgement does not override it.

The default **Split at 512 bytes** uses the segmented path that completed on
the watch. **CSI: use peer limit** reproduces the original sender's packing
at the larger advertised limit; its first hardware attempt received no PUT
reply. Both use the same bFTP and UPF bytes and were compared with offline
execution of CSI Image Viewer
2.5's original MIPS DLL (SHA-256
`bef3b1f4b000aef01296404e81a55f4514d0651084cd0a4ba213d20831918ed7`).
The bounded run uses captured watch CACK/capability replies, the original
1698-byte UPF, explicit WinCE file/port stubs and synthetic PUT ACKs:

- At peer `fr:3`, CSI emits one 1792-byte SCEP PDU. Its flag is **41**, with
  SeqNo 0 and RestNo 1, even though the PUT fits in one PDU. The entire
  packet, not just its header, matches `csiPutPackets()`.
  The receiver and reply parsers now use RestNo=1 as a completion signal for
  that form, then validate the whole command. Previously they waited for
  the last-segment flag and left this one-segment command pending. A
  regression test feeds the complete original packing in small stream chunks.
- At `fr:1`, it emits 512, 512, 512 and 310-byte PDUs with flags 41, 01, 01,
  81. All four match our output byte for byte.
- With two files supplied, the original worker emits command IDs 3 and 4,
  consumes both synthetic ACKs, sends `003020020001` (User Disconnect) and
  closes the port with pre-close error zero.
- With synthetic ERR0=0020 (file system full), CSI stops with internal
  error 2207 and closes the port without sending SCEP Disconnect. The final
  GUI callback overwrites that error with zero, so the audit retains the
  value before closing. Our sender retains ERR0 and attempts a clean close;
  that error path is tested synthetically, not claimed to match CSI's close.

Reproduction and full traces live outside the public app under
`work/wqv-swan-program-search/csi-irtranp-audit/send-session.py` and
`send-{session,segmented-session,two-session,nack-session}.json` in the
workspace. `tests/csi-sender-fixture.json` retains the original packet
fixtures and provenance. Later Nokia/Symbian `BFTP::Put()` is a stub; its
public receive implementation is useful for incoming replies, not an
independent working upload reference.

The watch's recorded RIMG lists several standard image sizes but omits
176×144. This discrepancy is logged explicitly. The successful hardware
upload returned an image previously received from this watch, as Casio's CSI
manual describes. RINF uses FFFF as the standard's "enough" indication for
receive memory and battery. It gives no numeric free-space or remaining-time
measurement, and does not mean unlimited memory or a fully charged battery.

Software tests cover unchanged file bytes, both original CSI packing forms,
multiple PUT, credit flow, error and unrelated/premature replies, limits,
Stop with a pending USB read, and a synthetic padded UPF larger than 64 KiB.
The padded file is only a transport stress fixture and is never chosen for
hardware. The original USB capture of the successful upload has a separate
replay test covering all 112 outgoing frames, the PUT reply and orderly close.

### Numbered images and the final reply

The user reports three numbered test images stored on the watch. In the two
supplied started captures, `cbc5f1d2-0388-4ff2-b6ed-1d20aaf6e3b9` and
`4af74b3b-b8c6-45a7-b2b3-46fb8ee32bfa`, the page nevertheless timed out
without a PUT reply. The last data fragment was acknowledged at IrLAP in
both cases. The watch returned a TinyTP credit (`09 03 01`), the page sent
RR/P, and no further incoming frame was recorded. Independent decoding
checks all 200 and 196 accepted RX frames against their original FCS bytes.
Storage reported by the user and a missing protocol reply are separate
facts; the captures must keep their unconfirmed result.

`send-completion-audit.py` runs CSI's original Send worker with the second
capture's exact 4355-byte file. Serial I/O and file callbacks are stubbed;
the captured CACK's `fr:3` is changed to `fr:1` to select the same 512-byte
packing. All nine original PUT PDUs match the hardware capture byte for
byte. After the last block the worker reads, without sending another end
marker or a separate file acknowledgement. A synthetic positive RPL0 leads
to User Disconnect `003020020001`, then port close. With the reply withheld,
the bounded run stops at that read and has sent no Disconnect. This does
not emulate the Windows CE lower IrDA stack or its timeouts.

The outgoing CSI path now retries an unanswered RR/P after one quiet second,
at most three times within the existing transaction deadline. This is
limited to transactions whose I frame has already been acknowledged, or
an idle transaction with no outstanding data. It follows the primary's
final-timer recovery for an empty retransmission queue in
[Linux IrLAP](https://android.googlesource.com/kernel/common/+/6ec22f9b037fc0c2e00ddb7023fad279c365324d/net/irda/irlap_event.c).
It never repeats an I frame, PUT, file input or metadata command. Every retry
is recorded as `irlap-final-repoll`, with an empty `csi-final-repoll` TX
frame and a `finalPollRetries` counter. An unacknowledged last I frame is
left unconfirmed; this change does not guess that it reached the watch.

Software checks cover recovery after a lost RR turn, a silent peer bounded
to three retries, no recovery without a data acknowledgement, and the
existing original hardware replays.

Archive `WQV-IrTranP-2026-10-24T20-32-39-333Z.zip`, attempt
`d1335912-74cb-4289-8705-eed181c08091`, verifies the new path on the watch.
It uploads the generated image `01 / 21E0` in nine SCEP PDUs at 9600 bit/s.
After the final TinyTP credit and an unanswered RR/P, the page repeats the
same empty RR/P once. The watch's positive RPL0 for command 3 follows
85 ms later. SCEP User Disconnect, IrCOMM disconnect and DISC/UA all
complete; no second PUT is sent. The session takes 15.839 seconds, with
194 RX frames, 1920 raw RX bytes, zero bad CRC and 22 damaged-BOF recoveries
validated independently against the original FCS bytes.
`tests/sender-final-repoll-hardware-fixture.json` preserves the exact input,
raw USB reads and all 198 outgoing frames. Its replay verifies the retry,
positive PUT response and clean close. The subsequent metadata series below
provides paired read-back for this and eight other images.

### Hardware upload and subsequent download, 24 October 2026

The first upload, attempt `63a2c992-e772-4eb8-bbf6-9a583904a297`, used the
watch's advertised 2048-byte SCEP limit: one 1792-byte PDU with flag 41,
SeqNo 0 and RestNo 1. All 30 IrCOMM fragments were acknowledged at IrLAP,
but no SCEP/bFTP PUT reply arrived. The write remains unconfirmed; link-layer
acknowledgements alone do not establish storage.

Archive `WQV-IrTranP-2026-10-24T17-25-27-762Z.zip`, attempt
`e4bb6ed6-1991-4644-989e-85a4de4fd5c2`, completed OTHERS RECEIVE at 9600
bit/s with 512, 512, 512 and 310-byte SCEP PDUs. The bFTP command and original
1698-byte UPF were unchanged. The watch returned a positive RPL0 for command
3 with filename `QW000000.UPF`. SCEP User Disconnect `003020020001`, IrCOMM
disconnect and IrLAP DISC/UA followed. The 8.673-second session had 106 valid
RX frames, zero bad CRC, no retransmissions or pending USB calls. Eight
damaged opening markers were accepted with their unchanged original FCS;
an independent Python CRC decoder reproduced all 106 frames. This confirms
one upload, not a general file-size or multiple-file limit. The USB adapter
was also reset before this run, so segmentation is a lead for the earlier
failure, not an isolated proven cause.

Archive `WQV-IrTranP-2026-10-24T17-38-58-609Z.zip`, attempt
`5699c272-a7a3-4c73-9966-bdff2eaac3d5`, then downloaded a photo through
OTHERS SEND at 9600. It completed in 12.716 seconds with 37 valid received
frames, zero bad CRC or frame repairs, an acknowledged positive PUT reply,
peer SCEP Disconnect and DISC/UA. An independent decoder reproduced all
37 accepted frames from the original USB bytes with damaged-start recovery
disabled, as it was in the page. No USB calls remained unresolved.

The downloaded UPF is also 1698 bytes, with a 1314-byte JPEG. File hashes
differ, but the 384-byte UPF header, JPEG frame/scan headers, quantization
and Huffman tables, and all compressed scan bytes are identical. The DQT
segments now precede DHT, and two bytes in APP2 differ; their meaning is
unknown. Pillow decodes both to identical 176×144 RGB pixels (SHA-256
`7534999520fbd9cd544e7c11a34efbc72981ca536ae5eaafb0689f075de2086b`).
The input UPF hash is
`dcef8519232de0fd51ca2f85f56cc7072ae489214bf4baf4960e841a2e8a7d35`;
the download is
`85a3d7c8195b6a06ad437edaa3da84baaeb5ba38e3046eb3471a929a7b773d3a`.
This is the same image content without recompression, but the watch contains
duplicates and the user could not identify the selected copy on its screen.
It therefore does not prove that the newly uploaded copy was read back, or
when and where the JPEG header was rewritten.

Next are a repeat with a distinguishable supported image, upload at 115200,
and two PUTs in one connection. Each step starts manually after resetting
the watch mode. Larger files, full-memory responses, interruption recovery
and repeatability still need hardware tests. Incoming small-file reception
and IAS/capabilities at both speeds are already verified below.

### Transfer speed ceiling

The watch's SNRM in the 17:38 archive advertises baud parameter `01 01 3f`:
the available rate bits stop at 115200 bit/s. The page selected 9600 because
that test explicitly imposed that limit. Its choice did not cause the watch
to omit higher rate bits from its offer. The current SIR implementation
supports 9600, 19200, 38400, 57600 and 115200; it has no FIR codec.

This is a device limit observed in negotiation, not an IrTran-P limit. The
[IrTran-P 1.0 stack diagram](https://irda.org/standards/pubs/IrTran-P_10.PDF)
includes a 4 Mbit/s lower layer, and the
[SigmaTel STIr4200 datasheet](https://pdf.dzsc.com/STI/STIR4200.pdf) specifies
4 Mbit/s FIR operation. Neither establishes that the WQV-3 can use it. No
captured watch offer advertises a rate above 115200. For this watch, reducing
protocol overhead is a more supported direction than raising the optical
bit rate; any such optimization still needs a measured comparison.

## Remaining features: manual hardware experiments

**Metadata: send and read back** has 18 steps, alternating OTHERS RECEIVE
(write to the watch) and OTHERS SEND (read the new image back). It begins with
a generated-image control, then tests FIL0, TIM0, LFL0, UPF creation/edit dates,
title, comment, author/editor, and an embedded 80×64 UPF index image. Each case
changes one metadata feature. The main test pictures carry a large case number
and a four-digit nonce; the nonce also changes pixels. Repeats get new nonces,
so a previous copy cannot satisfy a new read-back by keeping the same filename.
The browser uses its normal JPEG encoder and validates a 176×144 baseline
4:2:0 image before preparing USB. This is new image content, not a watch-native
file. If the initial control is rejected, later rejections cannot establish
that metadata itself is unsupported.

Choose this plan, click **New series**, then **Create numbered test image**
or **Prepare SigmaTel USB**. Generation is local and happens before USB is
opened. Review the visible image and exact values, prepare USB, then activate
OTHERS RECEIVE. After the attempt ends, manually choose **Next step**. For the
read-back, prepare USB first, choose the displayed numbered photo on the watch
in OTHERS SEND, start the page receiver, then press the final SEND button.
The page never starts a transfer or advances the series automatically.

File timestamps use conspicuous fixed sample values from 2001 and 2004; they
do not set the watch clock. TIM0 has bFTP type 06. Title uses ASCII in the UPF
header; comment and author/editor use the defined 12h and 13h tables. The
index JPEG has a separate UPF entry, with corrected offsets and alignment.
Outer TYP0/TMB0 attributes are not generated: IrTran-P 1.0 marks their payloads
as unused in that document, so this test uses the defined UPF index-image form.

Both the sent bytes and paired reference are retained in each read-back ZIP.
The report identifies the image using coding parameters, quantization/Huffman
tables and every compressed scan byte, independent of APP/COM metadata and
table ordering. A different fingerprint is inconclusive for metadata, not
proof of corruption: the user may have selected another photo or the watch
may have reencoded it. A matching image permits field-by-field comparisons;
the report distinguishes a clean transport session from metadata retention.
Unknown metadata is kept as raw hex. Missing upload acknowledgement is also
retained, even if an image later matches. A metadata-parse error does not
turn an otherwise valid JPEG into a bad preview.

### Completed metadata series, 24 October 2026

Archive `WQV-IrTranP-series-2026-10-24T20-45-59-937Z.zip` contains all 18
steps of suite `b8a23283-d3a7-4dd8-ae11-24ceb8fac387`: nine confirmed PUTs
and nine clean reads, all at 9600 bit/s. The archive also retains the three
earlier unconfirmed control writes and one preparation released without
starting; those are not additional completed metadata tests. Each of the
nine successful writes needed one final RR retry, then returned RPL0 and
closed normally. All nine returned photos match their paired, uniquely
numbered inputs. An independent Pillow decode gives identical RGB pixels,
not just similar previews. The actual sent PUT bodies match the input files,
and the incoming PUT bodies match the exported files. Independent raw USB
decoding verifies the original FCS on all 2325 received frames, including
268 opening-marker recoveries. No bad CRC was reported in these 18 runs.

| Field | Test value sent | What the watch returned |
| --- | --- | --- |
| FIL0 | `IR000002.UPF` | RPL0 echoes `IR000002.UPF`; later export uses `QW000000.UPF` |
| TIM0 | `20010203040506`, type 06 | No TIM0; no creation/edit date in UPF |
| LFL0 | `IrTranP long file name.UPF` | No LFL0; UPF title absent |
| UPF creation/edit dates | `20010203040506` / `20040506070809`, UTC | Both `80ffffffffffffff` (undefined) |
| UPF title | `IRTRANP TITLE 06` | Absent, character set FF |
| UPF comment | `IRTRANP COMMENT 07`, table 12h | No comment table |
| UPF author/editor | `IRTRANP AUTHOR 08` / `IRTRANP EDITOR 08`, table 13h | No author/editor table |
| UPF index image | Distinct 80×64 JPEG, 2137 bytes | Absent index entry; main image preserved |

The watch accepts the image-bearing requests with these fields, but does
not return the optional values through this OTHERS SEND path. Export alone
cannot distinguish ignoring them at import from omitting them when rebuilding
an export; it is not a direct dump of the watch's internal file storage.
The result is confined to these encodings and test values. It does not
establish other character-set behavior, internal creation dates or PC-mode
handling of metadata. `tests/metadata-hardware-fixtures.json` retains all
nine input/output file pairs, actual outer attributes, capture IDs and the
source archive hash.

### Caption entered on the watch, 30 October 2026

A photo manually renamed to `*  A   AAAB` on WQV-3 was exported through both
PC and OTHERS SEND. OTHERS returned `QW000000.UPF`, 3625 bytes, containing a
3241-byte JPEG. The entire UPF is identical to the PC export, including the
caption. Its SHA-256 is
`2e77844174bf8ab66046363384af9591045214f26963c083f9bcf99496cd3254`.

The caption occupies 24 ASCII bytes in JPEG APP2, followed by the five date
bytes `00 01 06 12 1f`. The standard UPF Title field remains undefined
(character set `FF`). The outer PUT has only `CMD0`, `FIL0` and `BDY0`; its
`FIL0` is the technical filename `QW000000.UPF`.

The KS-959 transfer completed at 115200 bit/s in 6.15 seconds. Independent
decoding of the original USB input reproduces all 38 received CRC-valid
frames and the complete PUT; there are no bad CRCs. The report is
`WQV-Link-report-2026-10-30T16-03-33-979Z.json`. Its provenance and the shared
PC/OTHERS payload are retained in `tests/fixtures/wqv3-album-hardware.json`.

Thus OTHERS SEND does export captions entered on the watch. The earlier
metadata-import tests above concern standard UPF and bFTP fields and remain
valid; they did not test creating a watch caption through Casio's JPEG APP2.

**Multiple files, cancellation and fast upload** has 11 manual steps: two
different numbered files in one connection followed by separate reads of
each; Stop during a segmented PUT; a normal write/read pair; Abort after a
complete PUT request; another normal write/read pair; then a write/read pair
at a 115200 limit. Standard Stop (DFLG C2) is sent after just the first full
512-byte SCEP segment, with the rest of the file deliberately withheld. Abort
uses PduType C0 and the original command ID in a 28-byte command header. If a
PUT reply arrives before Abort can go out, Abort is skipped and explicitly
marked too late. After sending cancellation the client records responses and
tries to close; neither silence nor a clean close proves that storage was
rolled back. The existing **Stop** button still aborts the local recording
and closes USB. It is separate from these planned protocol messages.

The operations plan still needs hardware verification. Synthetic tests cover
distinct two-file PUTs, cancellation and the too-late race. Successful single
uploads and the metadata round trips above have separate hardware evidence.

### First two-file attempt and peer-requested disconnect

The unused control plan **One at a time: exact photos 10 and 11** has four manual
steps: upload 10, read 10 back, upload 11, read 11 back. Each upload uses one
PUT and closes its connection. It reuses the exact two input files from
attempt `29b5f956-14f3-4782-89bd-37d318668d01`, including filenames and nonce
07FB. The 4138-byte file 10 has SHA-256
`34848488179890875be909701ffe87f7f3d0acfc91954e71c1c994a59d3a759c`;
the 3756-byte file 11 has SHA-256
`0730758a126a53d3a5f82552af070311ba5de69b4de1d81cf5f3425418763891`.
`irtranp-control-inputs.mjs` holds these generated test files with their
capture provenance; it contains no camera photos. Each load decodes a fresh
byte copy and verifies its hash. The code does not redraw or reencode these
controls. Their captures record `reusedInput=true` and `generatedInput=false`.
The read-back steps still compare image content before claiming a match.
These controls can test whether each individual file is accepted. A successful
pair of separate uploads would not, by itself, identify the precise reason
that a combined transfer failed; command IDs and inter-file timing also differ.
Selecting a plan now activates its most recent unfinished series, or creates
one if necessary. Selecting a saved series also updates the plan picker;
reloading restores both. The start button names either the sole control photo
or the pair. USB preparation rejects a mismatch between the picker and the
active series. Changing the plan never starts a USB or watch operation.

Attempt `ad26a731-c100-4f4d-a761-2c2d83bef7ce`, exported in
`WQV-IrTranP-2026-10-24T20-58-17-279Z.zip`, sends images 10/BFCF and 11/BFCF
at 9600 in one SCEP session. PUT 3 gets a positive RPL0 after one final RR
retry. All data for PUT 4 is then transmitted and its last I frame is
acknowledged. Instead of a second bFTP reply, the watch sends an empty
IrLAP RD response (control 53). The old client throws its inherited
"during IAS" error and closes USB without answering RD. Independent raw
decoding checks all 338 RX frames and 41 original-FCS opening repairs.
The user reports that the last numbered photo visible afterward is 09;
neither new image is confirmed as stored. RPL0 for the first request must
not be presented as proof that this interrupted batch persisted.

The original CSI worker was rerun offline with both exact, distinct input
files and the same 512-byte packing. All 17 PUT PDUs match the hardware
attempt. With synthetic positive replies it sends User Disconnect after
the second reply; withholding the second reply leaves it waiting without
another serial write. The Image Viewer file-complete callback closes its
local input handle and increments its file index; no fixed inter-file
delay appears in that inspected callback. This does not emulate the WinCE
IrCOMM driver or establish actual optical timing on a CASSIOPEIA.

The primary client now answers RD with DISC and waits for UA, as in the
primary's `RECV_RD_RSP` path in Linux IrLAP. It withholds any queued
application output, journals the request as `irlap-peer-disconnect-request`,
and preserves the missing PUT reply. Closing the link does not turn this
into a completed application session: `complete` stays false and an
unconfirmed PUT remains unconfirmed. The message records the actual phase,
rather than calling every disconnect an IAS failure. Synthetic tests cover
RD after the second PUT and midway through a segmented PUT, with no further
data output. This RD completion path still needs a hardware repeat; it is
not yet a successful two-file upload.

The repeat `29b5f956-14f3-4782-89bd-37d318668d01` in
`WQV-IrTranP-2026-10-25T07-14-25-115Z.zip` verifies that RD is now answered
with DISC/UA on hardware. The application transfer still fails: only PUT 3
gets RPL0; after PUT 4 the watch requests RD without a second reply. The
recorded status is `send-incomplete`, `complete=false`, and the report verdict
is `incomplete`, despite the clean link close. The user reports OTHERS
RECEIVE NG and no visible new numbered images. This is not evidence of a
working two-file transfer. Independent decoding checks all 331 received
frames and 45 original-FCS opening repairs. The regression fixture replays
all 336 outgoing frames and must retain the incomplete verdict. Single-file
encoding, inter-file timing and the watch's multiple-PUT behavior remain
separate possible causes; the current capture does not identify which one
caused NG.

The next export, `WQV-IrTranP-2026-10-25T07-44-56-053Z.zip`, is another
two-file operations run, not a single-file control. Attempt
`1887cde0-15fe-4414-b49c-4f71ea60077a` sends 10/2963 and 11/2963 with
`copyCount=2`. It again gets one positive PUT reply, then RD after the second
PUT, and completes DISC/UA with `complete=false`. The user reports NG.
The old plan picker could display a newly chosen plan while leaving the old
operations series active; the selection fix above removes that ambiguity.
Neither unchanged 07FB file has a single-control hardware result yet.

The RCMD body `20 00 01 00 01` prompted the multiple-transfer experiment:
the original Symbian source names function 1 `func-multi-command`. This
advertisement alone does not establish that the watch saves two images per
connection. We have not found a correction that makes the two-file hardware
transfer work. Separate one-file sessions remain the practical path; the
exact-file controls are intended to isolate the failure, not to claim support
for a batch.

### Multiple files with CSI's original negotiated packet size

The earlier 512-byte comparison was too narrow to establish that our entire
transfer matches CSI. It changed the captured watch CACK from `fr:3` to
`fr:1`, deliberately forcing the original DLL to use the same small packets
as our test. With the actual CACK unchanged, CSI uses the watch's 2048-byte
receive limit. The same 07FB files then produce five SCEP PUT packets:
2048, 2048, 172 bytes for image 10; 2048 and 1820 bytes for image 11. Our
failed 512-byte attempt used seventeen packets. Reassembled bFTP commands,
file bytes, names and command IDs are identical.

This was checked by executing the original sender worker with
`send-completion-audit.py --copies 2 --captured-fr`. File supply, serial I/O
and positive PUT replies remain explicit stubs. The trace has one port open,
one SCEP Connect, three capability queries, PUT 3, its reply, PUT 4, its
reply, then User Disconnect. No extra application command occurs between
the PUTs. The GUI's file-completion callback closes the local file handle
and advances the file index; it does not reopen the IrCOMM port.

The **Two photos: CSI packet size** plan tests that concrete difference.
Its write step sends both unchanged 07FB files in one connection, with
`sendPDU=0` (peer limit), 9600 bit/s and the existing frame recovery.
Image preparation must preserve that choice instead of resetting it to
512. Two manual read-back steps can verify the two resulting photos if
the upload succeeds. The single-file controls are not the proposed next
experiment. The negotiated-size path's hardware results are recorded below.

`tests/csi-multiple-negotiated-fixture.json` retains all five original PUT
packets, the unchanged CACK and input hashes. The sender regression compares
every packet byte for byte in a simulated complete two-file connection;
this is an offline check, not a hardware success claim.

Among the other inspected implementations, the public Symbian sender
`BFTP::Put` is a stub, Andrew Gregory's Psion module documents sending as
future work, and Microsoft's Windows IrTran-P service is receive-only.
They supply no alternative multi-file sender sequence. CSI supplies the
concrete sender behavior used for this test.

The [IrTran-P specification](https://irda.org/standards/pubs/IrTran-P_10.PDF)
section 2.3 describes successive PUTs in one SCEP connection; section 3.3.2.5
defines optional function `0001` for multiple PUTs. The watch advertises
that value. This makes the experiment protocol-based, while its actual
behavior still needs a successful hardware transfer.

### Hardware result at the CSI packet size

Browser attempt `83767461-816a-4199-b484-0b0fe45c6764`, from
`WQV-IrTranP-2026-10-25T08-30-01-799Z.zip`, selects the right case, both
original files and the 2048-byte SCEP limit. It only transmits seven
60-byte IrCOMM fragments (420 bytes) of the first PUT before timing out;
3848 queued bytes remain. PUT 4 never starts. All 48 received frames have
valid original FCS, including eight damaged-BOF recoveries.

After the first few fragments, calls are separated by roughly one-second
pauses while the USB calls themselves take a median of 0.4 ms and a maximum
of 17.5 ms. The user reports that the test page remained active. Visibility
and individual timer lateness were not recorded, so attributing these pauses
to changing tabs would be unjustified. This incomplete first PUT cannot
test the watch's handling of a second file.

The native repeat `30def0dd-d039-4083-b004-0a490428487d` uses the same JS
sender and SigmaTel driver through a Python ctypes/libusb RPC bridge, with
the existing native timeout-free USB reader. The browser is not involved.
This run transmits both complete files in one connection: three SCEP
packets for 10 and two for 11. Independent decoding checks all 340 raw OUT
frames and compares all five outgoing SCEP packets byte for byte with the
original CSI fixture. All 315 received frames pass their original CRCs;
25 require the independently checked BOF recovery.

The first PUT gets RPL0. The second gets no application reply; the watch
sends RD, which the client finishes with DISC/UA. The final status is
`send-incomplete`, `complete=false`, with one positive reply and no CRC
errors. The user could not read the final watch message and did not find
photo 10 in memory afterward. There is no verified saved image from this
batch. Changing 512-byte segmentation to CSI's 2048-byte segmentation did
not fix the multi-file failure. These captures do not establish a hard
one-photo limit; the WinCE lower IrDA stack is still not reproduced.

### Original Windows CE 2.11 transport comparison

The [lower-stack audit](ircomm-stack-comparison.md) now examines original
Microsoft CE 2.11 components, including bounded execution of the MIPS
QoS negotiator, transmit-queue decision and TinyTP header builder. It
confirms differences below the already matched SCEP packets: negotiated
frame size, extra RR turns, serial-control traffic and initial credits.
For the actual recorded 9600 offers the original negotiator selects 256
IrLAP data bytes; the original serial-driver size calculation allows up
to 251 application bytes, compared with our fixed 60. This is a concrete
basis for the separate `wince211` transport profile and the manual
**Two photos: Windows CE 2.11 transport** plan. Its write step uses the same
10/07FB and 11/07FB files, one connection, 9600 bit/s and the watch's SCEP
limit. It uses four receive credits, no added serial controls, negotiated
application chunks and direct progress from an acknowledged I(F) to the
next queued I(P). It retains RR when an acknowledgement is outstanding or
the peer is busy. The result and raw journal retain the profile and actual
negotiated limits. Two subsequent manual steps read back photos 10 and 11.
Other plans retain the earlier transport. Software checks do not establish
a successful hardware batch or emulate a complete CASSIOPEIA OEM ROM.

The subsequent native hardware attempt
`da28d58e-d2c3-4fff-b489-574adc880aa7` uses the new profile and selects
256-byte IrLAP frames / 251 application bytes. Its 36 PUT fragments carry
all five original CSI packets unchanged. Independent checks validate all
74 outgoing frames and 55 original-FCS replies, including eight BOF repairs.
The watch acknowledges the last I frame of the second PUT, but only the
first PUT gets RPL0; after the second it requests RD. DISC/UA completes
cleanly with `send-incomplete`, `complete=false`, no CRC errors and no
pending output. The user found neither 10 nor 11 in memory. The failed
batch now has a raw replay fixture, `tests/wince211-hardware-fixture.json`.
The transport overhead decreased, but the multi-file storage failure
persists. No further unchanged retry was started.

## Manual test series

The original four plans remain available. **SEND screen: passive recording** listens at fixed
9600, 38400 and 115200 bit/s. **Photos: profiles, speed and repeatability**
receives the same photo with CSI and Nokia image-capability replies, at speed
limits of 115200 and 9600, then repeats the fast transfers. **RECEIVE: IAS and
capabilities** checks IAS and CSI queries at those two limits. **Full
comparison** combines these and adds strict-CRC photo reception.

Create a series, prepare USB, position the watch, then start each step
manually. The page never starts the next test itself. Leave transfer mode
on the watch between attempts. **Next step** becomes available after an
attempt has ended. **Repeat step** keeps the settings and retains the earlier
attempt. A skip needs a reason. The current step and its attempt IDs survive
a page reload; an interrupted recording is marked as such. To choose settings
freely, select **Single test** in the series list.

Each earlier row has its own **Repeat step** button. It reopens that row's
original settings and appends new attempts without removing the old ones.
**Finish repeat** returns to the saved position in the series; it requires
a newly completed attempt, so an earlier failure cannot satisfy it.
**Cancel repeat** returns without changing another step's result. The return
position survives a reload, and `repeatHistory` in the exported plan keeps
completed and cancelled revisits.

There are two distinct front-button presses in OTHERS SEND. The first opens
the photo-selection screen with the word SEND. The side buttons select a
photo. Another front-button press starts transmission. For normal image
reception, choose the photo first, start the page receiver, then make that
final press.

The selection-screen experiment starts earlier: prepare USB and start the
page recording **before the first front press**. Mark the selection screen
opening, each side-button change and the final SEND press with the separate
buttons on the page. An optional visible frame label can accompany each
mark. USB bulk OUT is blocked in this test; it does not search, connect or
acknowledge anything. Unknown bytes are saved alongside any strict-CRC IrDA
frames. No data at a fixed rate does not prove that the watch emits nothing.
The marks are page clicks and the byte windows use USB completion times,
not exact optical or physical-button timestamps.

Keep the same watch photo throughout a profile/speed comparison. The report
hashes the UPF body and extracted JPEG separately, so a metadata difference
does not become a claim of image corruption. A photo counts as a passed
session only when its JPEG is parseable, the protocol reports completion,
DISC/UA is recorded and there are no unresolved USB calls or cleanup errors.
The original status and bytes remain in the archive even when analysis adds
a different verdict.

**Save series ZIP** includes every attempt and retry belonging to the
selected series, its skipped steps and the current position. **Save all
attempts ZIP** also includes earlier standalone IrTran-P recordings and every
saved series plan in `plans.json`. Both
contain `summary.json`, `summary.csv`, `plan.json`, per-attempt original
journals and USB/application streams, UPF bodies, JPEG previews and analysis.
Passive attempts also have raw `stage-windows/` files mapped by the window
list in `analysis.json`. `manifest.json` records every other file's length
and SHA-256. A raw single-attempt export remains available during a running
test; the full export waits until USB is released.

Frame recovery is explicit in a series. **Strict CRC only** disables both
PAD-5 repairs and damaged-start recovery. **PAD-5 data and end marker** uses
the existing data/end-marker recovery with original-CRC rechecking.
**PAD-5 and damaged start marker** additionally allows the recorded E0/81
start candidates. **Current defaults** preserves each test's previous
defaults. These options change local decoding, not the watch firmware.

## Connect and read IAS

This is the default test. It completes discovery, sends one SNRM to open
IrLAP, checks the watch's UA and switches to the negotiated speed. It then
opens IAS and reads `IrDA:IrCOMM` attributes `Parameters`,
`IrDA:TinyTP:LsapSel` and `IrDA:IrLMP:InstanceName`. Finally it disconnects
IAS and closes IrLAP. An unknown attribute is kept as an IAS status, rather
than being treated as a broken transfer.

Choose **OTHERS RECEIVE**, prepare SigmaTel, then start **Connect and read
IAS** before activating reception on the watch. It opens no TinyTP/IrCOMM
channel and sends no image or SCEP/bFTP request. IAS requests and SNRM are
not repeated automatically. A full hardware session completed on 24 October
2026: all three IAS requests received replies and the link closed normally.

## CSI image receiver

Choose this separate test for an incoming photo from OTHERS SEND.

The receiver uses the MachineID, CACK and default capability responses
recovered from CSI Image Viewer 2.5's MIPS IrTranP.dll. It accepts an incoming
IrLAP/IrCOMM connection and dispatches SCEP/bFTP requests by their contents.
The CSI packet fixtures check the reconstructed library output. The later
hardware photo sessions are recorded separately below.

Prepare USB before activating the watch. Open the SEND photo-selection
screen with the first front press, choose a photo with the side buttons,
start the receiver, then press the front button again. Each attempt is
manual. Save its ZIP even if the watch does not respond.

## CSI capability queries

Use **CSI capability queries** with **OTHERS RECEIVE**. This is an outgoing
client, separate from the incoming image receiver. It performs the same IAS
queries, requires an unambiguous advertised 9-wire IrCOMM service, and opens
the returned TinyTP selector. The observed selector is 3, but it is not
hardcoded. The selected test sets the page's watch-mode instruction; it
cannot detect which mode is physically active on the watch.

The client sends IrCOMM service/serial controls, SCEP Connect with the CSI
MachineID and `fr:4`, then RIMG, RINF and RCMD. It learns the peer MachineID
from CACK, checks every reply's command ID and both MachineIDs, and retains
all attributes as original hexadecimal values. An explicit negative bFTP
reply is kept as a reply, rather than replaced with a guessed capability.
After the three replies, it disconnects SCEP, IrCOMM and IrLAP. No image,
PUT, PC-mode switch, clock or firmware command is exposed by this test.

Connect and all three query packets are checked against original CSI DLL
execution. The IrCOMM serial controls come from our working PC-mode path;
CSI delegates this lower layer to the Windows CE COM3 driver. They have not
been recovered from that driver. The outgoing CSI test is verified with a
synthetic peer, including fragmented streams, credit grants and cancellation.
On 24 October 2026 it also completed a hardware session with the WQV-3:
all three capability queries received positive replies and the connection
closed normally. That session verifies the capability exchange and carries
no image. Incoming photo transfer was verified in later sessions below.

## What has worked on hardware

On 24 October 2026, WQV-3 OTHERS RECEIVE returned six XID discovery responses:
288 USB bytes, peer name `CASIO WIC 2411/IR`, hints `8c04`, no CRC errors and
no repaired frames. An independent strict decoder confirmed the original
bytes. OTHERS SEND returned no bytes in two attempts; the cause is unknown.

The successful IAS session took 1.767 seconds and returned 193 USB bytes at
a negotiated 115200 bit/s. It reported:

| Attribute | Original value |
| --- | --- |
| Parameters | `00 01 07` |
| IrDA:TinyTP:LsapSel | Integer `3` |
| IrDA:IrLMP:InstanceName | IAS status `2` (attribute not found) |

The client then disconnected IAS and IrLAP and returned the adapter to 9600.
No TinyTP/IrCOMM connection or SCEP exchange was attempted. The complete
session, including USB read boundaries and empty reads, is a regression
fixture in `tests/ias-complete-hardware-fixture.json`.

The later `06-40-37-710Z` outgoing CSI session completed in 4.650 seconds,
including discovery: 693 original USB bytes, 49 completed transmissions,
39 decoded frames, three IAS replies and three successful bFTP replies
(`0x40`). The peer returned MachineID `0800740300000000`, product name
`CASIO WIC 2411/IR` and `fr:3` (2048-byte SCEP receive size). IrLAP ran at
115200 bit/s and returned to 9600 after the final DISC/UA. IrCOMM used the
advertised LSAP 3. There were no unresolved USB calls, pending application
bytes, retransmissions or CRC rejections. Six frames required recovery,
including four with an `e0` start marker; the original FCS of those four
frames was independently checked without modifying the body or FCS.

All three capability bodies are retained verbatim. RINF returned
`10ffff11ffff` and RCMD returned `2000010001`; the complete RIMG response is
in `tests/csi-hardware-fixture.json`. The regression test replays all 49
transmissions and the original USB fragments, including empty reads. No
image or PUT was sent. The separately exported `06-40-44-132Z` recording was
an earlier, receiver-only search: five XID responses in 239 bytes, all 147
transmissions XID, no connection attempt.

At 08:12 and 08:17 UTC the incoming receiver completed OTHERS SEND photo
transfers with CSI and Nokia original-size RIMG replies respectively.
The watch initiated discovery and IrLAP, queried IAS, opened IrCOMM/SCEP,
queried RIMG/RINF/RCMD and sent PUT with `QW000000.UPF`. Both transfers
contained the same 1698-byte UPF, SHA-256
`dcef8519232de0fd51ca2f85f56cc7072ae489214bf4baf4960e841a2e8a7d35`,
containing a 1314-byte JPEG at 176×144. Independent CRC calculation validated
all 30 and 31 incoming frames respectively. No frame recovery, retransmission
or pending USB call was recorded. The negotiated rate was 115200 bit/s.

Both sessions ended with SCEP Disconnect and IrLAP DISC/UA. The page
initially labelled them incomplete because a final TinyTP credit-only
I-frame remained unacknowledged. After a peer SCEP disconnect and completed
DISC/UA, the receiver now retires that data-free credit grant. An outstanding
application reply is retained as incomplete. Saved original reports are
unchanged. `receiver-hardware-fixtures.json` replays both strict-decoded
input streams and checks their directly triggered output frames, including
the final UA. This replay omits periodic page search transmissions and
empty-read timing; the full original journals retain both.

The second run contained about 32 seconds between the first page button
marker and the watch's discovery search, near the second marker. Page
markers are not physical button timestamps, so this does not establish
what the first press does on the watch.

The CSI receiver does not initiate an IrLAP connection after a peer's XID
reply. OTHERS RECEIVE with that test only records discovery. Use **Connect
and read IAS** to check the next layer; this is still separate from testing
SCEP compatibility.

The `06-04-09-005Z` CSI recording contains 287 USB bytes and six valid XID
replies. Its manual mode label is OTHERS RECEIVE, and all 147 transmitted
frames are XID. It ran the incoming image receiver, so there was no SNRM,
IAS, IrCOMM or SCEP attempt. This recording predates the successful IAS
session despite being supplied later.

A later OTHERS RECEIVE capture had five complete XID responses in 239 bytes.
The following OTHERS SEND capture returned 26 `ff` bytes with no complete
frame. All transmitted frames in those two captures were XID: they preceded
the new outgoing client. Neither establishes an IAS or photo session.

## Nokia 9210 comparison

The Nokia archive at [my9210.bs0dd.net](http://my9210.bs0dd.net/) supplied
two original ARM Imaging/IrTran-P builds, including Imaging 3.1 inside the
[4.13 software restore set](http://my9210.bs0dd.net/Arch/%21NokiaSupport/9210/4.xx/All_Nokia_9210_data_v413.sis).
Both Imaging applications directly import `IRTRANP[01005e15].DLL`.
These files were unpacked and disassembled without execution. They were
obtained from SIS distributions; the supplied Nokia flash container's
filesystem has not been extracted.

The 4.13 set's `irtranp.dll` is 14,528 bytes, SHA-256
`4b19c821af64df55d5369629a7c8a6d86c3d2d158cd5a9bd8b117f2ac1f34cbb`.
Its product name is `Nokia 9210 Communicator`. Its original-size RIMG body
is `0201ffffffff05ffffffff`, accepting the original geometry and advertising
`ffffffff` for file size. The application can also select VGA. RINF and
RCMD match the CSI responses. The successful serial-open path starts a read
without an intervening library-level write.

The [later public Symbian IrTran-P source](https://github.com/SymbianSource/oss.FCL.sf.os.bt/tree/master/irda/irdastack/irtranp)
helps interpret the old binary, but it is a different build. Its export
ordinal tables cannot be applied directly to the 9210 DLL. The original
IrCOMM system driver has not been recovered, so this comparison does not
yet reconstruct Nokia's lower-layer discovery and connection behaviour.
The receiver's **Image capabilities** selector now offers the original-size
Nokia RIMG response as a controlled alternative to CSI. Only that response
changes: CSI identity, MachineIDs and lower-layer settings remain the same.
This is not Nokia device emulation. Local file capture is still limited to
128 KiB, even though the original Nokia response advertises `ffffffff`.
Capability differences occur after SCEP and cannot explain a recording
with no discovery replies.

## Connect, then receive an image

This test actively discovers the watch, uses the existing IAS client to
find its 9-wire IrCOMM service and opens it as the IrLAP primary. It sends
the same serial controls as the working CSI capability test, then waits
for the peer to initiate SCEP and transfer a file. It sends no outgoing
SCEP Connect, GET, PUT or image-transfer request. SCEP/bFTP requests from
the peer receive the selected capability replies and file acknowledgements.
Every complete incoming body is recorded before JPEG decoding.

Use OTHERS SEND for the image experiment. OTHERS RECEIVE is also selectable
as a connection control: it checks that this path can open IrCOMM, then
waits without sending a photo. The watch-mode label is still manual.
Twelve seconds of application inactivity starts a normal disconnect;
an incomplete image or failed close remains an incomplete recording.
Stop and the overall deadline retain the existing independent USB wait
cancellation, including when a USB read never settles.

The synthetic peer tests cover both RIMG choices, arbitrary stream splits,
segmented file bodies spanning multiple credit windows, advertised selectors,
idle disconnect and Stop during a blocked read. The earlier successful
hardware capture is still replayed by the CSI client test. The active
receiver has not completed a hardware connection. Its OTHERS SEND attempt
saw a discovery command from the watch and stopped after a SigmaTel FIFO
error. The working incoming path lets the watch initiate the connection;
it does not require the active-receiver test.

## Photo comparison series

The 11:26–11:33 UTC hardware series on 24 October 2026 produced six complete
photo sessions and three USB errors. CSI received the same photo four times
(three at negotiated 115200, one at 9600); Nokia original-size replies received
it twice (9600 and 115200). All six UPF bodies and extracted JPEGs were byte
identical to the earlier 1698-byte/1314-byte photo. Their incoming frames were
independently checked without recovery: 32, 29, 37, 33, 31 and 31 frames.
Every session closed with DISC/UA and no unresolved USB call.

The four successful fast sessions exercised the credit-only retirement at
disconnect. Both 9600 sessions completed without needing that case. This is
fresh hardware confirmation of the clean-completion fix, rather than a replay
of the earlier incomplete-labelled exports.

Both attempts at the initial Nokia/115200 step failed on the first USB OUT
of XID discovery, while the adapter was still at 9600. The first attempt at
CSI/9600 then failed the same way. None reached an IrLAP connection or a
Nokia capability reply, so these errors do not identify a Nokia-profile or
high-speed protocol fault. The subsequent runs, including Nokia/115200 at
step 6, succeeded. The targeted repeat of step 2 retains its two failed
attempts and one preparation that was released without starting a recording.

Source: `WQV-IrTranP-series-2026-10-24T11-35-30-479Z.zip`, series
`00898c05-6a6c-4d17-b6e4-9cd23b706f57`.

The targeted Nokia/115200 repeat completed at 12:21 UTC. Attempt
`edc05eee-5715-4874-8bcc-0a535301b89a` received the same 1698-byte UPF and
1314-byte JPEG, with both hashes matching the earlier photo. An independent
decoder validated all 34 frames directly from the 2875 original USB bytes;
none needed recovery. There were no retransmissions, FIFO recoveries or
unresolved USB calls. The positive PUT reply was acknowledged before the
watch sent SCEP Disconnect and IrLAP DISC; our final UA completed normally.
Source: `WQV-IrTranP-2026-10-24T12-21-56-237Z.zip`. All six steps in the
photo plan now have a successful recording, including the reopened step 2.

### Full comparison series

The 12:24–12:37 UTC series `4ed3ab8a-80d9-48a3-9e6b-b9c289ccda10`
contains 17 attempts across 15 steps. All eight photo steps passed: CSI and
Nokia at 9600 and 115200, their fast repeats, and both fast strict-CRC
controls. All UPFs and JPEGs match the earlier photo byte for byte. An
independent decoder checked their 30, 30, 34, 32, 33, 29, 31 and 33 original
frames without recovery. Each positive PUT reply was acknowledged before
the watch sent SCEP Disconnect and DISC; each final UA completed.

IAS passed at both speeds after one earlier discovery/FIFO error at the
9600 step. The 9600 capability query passed and returned RIMG/RINF/RCMD.
Two IAS frames and four capability-query frames used damaged-BOF recovery:
three original markers were E0 and three were 81. Independent checks
validated the unchanged bodies and original FCS of all six. This confirms
that the option was exercised on hardware; the eight photo sessions did
not need it.

The fast capability-query step was stopped manually after about 54 seconds,
with 133 completed discovery transmissions and 18,802 empty USB reads. No
connection or application request was reached, so it remains unverified
in this series. All four passive recordings were also stopped manually;
their original bytes are retained. The 9600 recording contains 112 strict
discovery frames, while the two higher-rate selections have no complete
IrDA frame. Every USB call in these 17 attempts has settled.

The selected-series export is
`WQV-IrTranP-series-2026-10-24T12-41-34-531Z.zip`. The user's later
`12-45-00-195Z` export contains all 61 historical attempts, including these
same 17; it adds no newer attempt to this series. All 181 and 611 manifest
entries respectively passed independent size and SHA-256 verification.
The series cursor still points at its final step; that metadata does not
invalidate its completed recording.

### RECEIVE follow-up at both speeds

Series `0655a44a-7288-4022-9014-1ab179d1246c`, recorded at 15:53–15:55 UTC,
completed all four IAS/capability steps in six successful attempts. IAS ran
once at negotiated 9600 and twice at 115200; RIMG/RINF/RCMD ran twice at
9600 and once at 115200. This supplies the fast capability-query result
missing from the earlier full comparison. The capability bodies are
identical across all three runs and match the earlier watch responses.

All six connections completed DISC/UA, with no retransmissions, FIFO
recoveries, USB errors or unresolved USB calls. Replaying original USB
results, including empty reads, reproduces all 153 received frames.
An independent Python decoder also validates every accepted frame against
its original FCS without changing payload or checksum bytes.

Fourteen frames needed boundary recovery: twelve used damaged BOF
candidates, while two fast sessions used idle completion and discarded a
trailing F0. Both latter cases contain original decoded bytes
`70 91 83 7a f0`; removing only F0 leaves `70 91 83 7a`, whose original FCS
`83 7a` validates. This is an observed framing recovery, not proof of the
physical cause of the extra F0 byte.

Source: `WQV-IrTranP-series-2026-10-24T15-57-11-334Z.zip`, an all-history
export containing 67 attempts. The six records in this new series were
analysed separately; older failures have not been relabelled.

### File acknowledgement and the watch display

The [IrTran-P 1.0 specification](https://irda.org/standards/pubs/IrTran-P_10.PDF)
defines the PUT reply in section 3.3.2.7 and SCEP Disconnect in section
3.2.2.5. Its usage model ends a completed picture transfer with a
sender-initiated SCEP disconnect followed by disconnection of IrCOMM and
the lower layers. A complete implementation also needs the specified
failure and interruption paths; working reception does not cover all of
those cases.

All six original successful sessions contain the same closing sequence: our positive
bFTP PUT reply (`0x40`, attribute `RPL0`, filename `QW000000.UPF`), a numbered
IrLAP acknowledgement from the watch covering that reply, the watch's SCEP
Disconnect `003020020001`, its IrLAP DISC, and our UA. The SCEP reason is
`0001` (User Disconnect). The receiver does not stop merely because a file
body has arrived. The saved `termination-check.json` independently checks
the order and acknowledgement number in each original event stream.

The [published Symbian receiver](https://github.com/SymbianSource/oss.FCL.sf.os.bt/tree/master/irda/irdastack/irtranp)
also sends `RPL0` after the file body. Its SCEP Disconnect handler changes
the session state and closes the IrCOMM port; it does not send a separate
SCEP Disconnect reply. This is a source reference, not a claim that it is
identical to the old Nokia 9210 binary.

An additional bounded run of CSI's original MIPS receiver worker
`0x10004ab0` confirms the same application-level closing order. With captured
bFTP bytes resegmented into four synthetic SCEP file PDUs, it emits CACK,
three capability replies and a positive `RPL0`. After reading the captured
`003020020001`, it calls the disconnect callback and closes its IrCOMM port,
without another application write. Error state before close is zero.
Serial I/O, GUI callbacks and Windows CE's lower IrDA stack are stubbed;
this is not a hardware run or an execution of GUI file saving. The stubbed
run's `RPL0` has an empty filename and its CSI RIMG differs from the captured
Nokia-profile response, so the output is not byte-identical to ours.

The exact single-PDU PUT capture did not complete that bounded DLL replay:
the single-command dispatcher returned internal error `2207`, leaving the
Disconnect unread. This is retained as a replay limitation. It is not
evidence of a missing confirmation in our successful hardware sessions.

The [Casio module 2411 manual, page 5](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_EN.pdf#page=5)
describes a brief OK message after watch-to-watch transmission, then a
return to photo selection. A returns to the IR menu and D to timekeeping.
This section explicitly covers WATCH, so the same display behaviour in
OTHERS remains an inference. The user reports that a photo remains visible
after our OTHERS transfer; the exact text on the watch was not observed.
That alone does not establish that transmission is still active.

## Psion IrTran-P OPM

[Andrew Gregory's IrTran-P OPM](https://www.scss.com.au/family/andrew/pdas/epoc/myprogs/irtranp/)
lists WQV-3 among tested devices. Its 9468-byte ZIP contains `IrTranP.sis`,
an OMH interface document and a README. The SIS holds a 9091-byte compiled
OPL module and the SCOMMS dependency; it does not contain full OPL source.
The downloaded ZIP SHA-256 is
`7a45e71e0b7bb7eef1bb0b015b7d79106dd32350913855269d4891fdb8788dbb`.

The public interface receives a photo, handles asynchronous progress,
cancels reception and exposes product ID, filename and completion fraction.
It accepts explicit dimensions or `ARB` and a maximum file-size hint.
The README describes photo sending as future work. It is another receiver
implementation to compare, not evidence of firmware access.

Static inspection retains SCEP and bFTP handler names, `IrCOMM`, RIMG/RINF/RCMD,
FIL0/BDY0/RPL0 and the logging path `C:\\LOGS\\IrTranp\\Rx.txt`. Embedded
constants include `fr:1` and an RCMD response body `2000010000`, differing
from our current `2000010001`. The RINF body `10ffff11ffff` matches our
profile. These constants have not yet been reconstructed by executing or
fully disassembling the OPL module. Neither the SIS installer nor the
downloaded OPM has been run.

## SEND selection-screen captures

On 24 October 2026, three 90-second passive recordings covered entry into
OTHERS SEND, the photo-selection screen, a previous/next photo change and
the final front-button SEND press. Each action had its own page marker.
SigmaTel's selected fixed rate was confirmed by register readback. No USB
bulk OUT was requested in any run, and all USB calls settled without errors.

| Fixed receive rate | Bytes before final SEND marker | Bytes after marker | Strict IrDA frames |
| --- | --- | --- | --- |
| 9600 | 0 | 3450 | 112 |
| 38400 | 0 | 6710 | 0 |
| 115200 | 0 | 12297 | 0 |

The 9600 recording contains 16 repeated discovery cycles advertising
`CASIO WIC 2411/IR`. Independent decoding checked all 112 original frame
CRCs without repairs. Every byte outside those frames was an FF preamble.
There was no photo number, application exchange or image body in the trace.

At 38400 the raw stream contains only FF, 77, F7 and 7F. At 115200 all 12297
bytes are FF. Neither recording contains a complete IrDA frame; a zero CRC
rejection count here does not mean CRC-verified reception. Activity begins
0.27–0.32 seconds after the final page marker and lasts about 14.216 seconds
at all three receive rates. This is consistent with the same 9600 discovery
transmission being received at the wrong fixed rate in the two faster tests.
It is not evidence of a negotiated 38400 or 115200 connection.

No bytes were delivered while selecting or changing photos at any tested
rate. This does not establish silence at every possible optical format.
Page markers and USB completion times also do not identify exact physical
button or optical pulse timings.

Source exports: `WQV-IrTranP-2026-10-24T11-14-15-099Z.zip`,
`WQV-IrTranP-2026-10-24T11-17-03-328Z.zip` and
`WQV-IrTranP-2026-10-24T11-19-07-844Z.zip`. These are passive captures; the
watch receives no discovery reply or acknowledgement from the page.

## Cancellation and raw data

An earlier IAS run contained a complete Parameters response with `e0` where
the decoder expected the opening `c0` marker. The unchanged frame body had a
valid original CRC, `a8 3d`; the decoder had ignored it before checking CRC.
The IAS diagnostic can now start a candidate at `e0` outside an existing
frame. It accepts that candidate only at a real `c1` end marker with the
original CRC. It cannot combine this with edge-byte removal, alternative
escapes or idle completion. `recoveredBOF` and `rejectedBOF` count these
candidates separately. This option is off by default and enabled only by
the IAS and outgoing CSI research clients; it is not a claim about the
physical cause.

The three later OTHERS RECEIVE attempts at 08:08–08:10 UTC also contained
the original IAS Parameters reply with valid FCS `a83d`, but marker `81`
instead of `c0`. The old decoder ignored it and then timed out. The same
opt-in recovery now accepts `81` as another candidate outside a frame,
subject to the unchanged-body, unchanged-FCS and real-`c1` requirements.
It cannot combine with other repair methods. This is tested across every
split of the original reply. It has not yet been verified in a new complete
hardware session. Ordinary PC transfers do not enable this recovery option.

That damaged-start case has a regression test using the original USB chunks.
The first successful IAS hardware session had a normal start on Parameters
and used the existing end-marker recovery on one acknowledgement. The later
successful CSI session exercised the new damaged-start path on Parameters,
CACK and two link acknowledgements, with their original valid FCS values
`a83d`, `3f08`, `8d9d` and `837a` respectively.

A hardware capture exposed a browser USB read that stayed pending even after
USB close succeeded. Stop and the deadline now cancel the application wait
independently of that read. Late USB results keep their original journal.
Both subsequent hardware tests completed after one Stop click; their exported
snapshots had no unresolved USB calls.

`events.jsonl` is the full trace, including empty reads, control requests,
errors and transfer boundaries. `usb-in.bin` contains the original incoming
bytes before decoding. `usb-out-requested.bin` contains requested buffers,
including SigmaTel headers; completion records establish which writes
finished. `application-in.bin` and `application-out-queued.bin` contain the
IrCOMM byte streams when that stage is reached. Queued output is not proof
of transmission. Any complete file body is kept under `files/` before image
decoding.

`pendingUSBRead` describes the receive loop's end. `pendingUSBCalls` in the
export is calculated from the captured call/result pairs, so a read may
finish between those two snapshots. A manually interrupted recording remains
incomplete even when USB closes normally.
