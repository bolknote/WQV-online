# WQV-1/2 PC client comparison

Updated 30 October 2026. WQV-2 PC photo downloads now work with SigmaTel and
KS-959. Programs opens a separate WQV-2 application in the CASSIOPEIA interface.

## Verified transfers and browser integration

On 29 October, the owner downloaded the current photo and all five stored
photos through each adapter. The original records and PNG images matched
between adapters. The current photo's record SHA-256 is
`a84bc28fa497bc74d6c02f2feec22a4ca8606582143bfc164b4cdb4d7f13afaa`.

| Adapter | All-photo result |
| --- | --- |
| KingSun KS-959 | Five records of 7229 bytes, normal disconnect. Capture `WQV2-KS959-2026-10-29T19-11-52.091Z.zip`. |
| SigmaTel STIr4200 | The same five records, 293 valid frames, no rejected sums or malformed frames, normal disconnect. Capture `WQV2-PC-2026-10-29T20-28-26-063Z.zip`. |

The SigmaTel fix is RXDSNS code 6: a 28-sample receive-pulse threshold rather
than the earlier eight samples. The native client and WQV-2 browser app use
this value at 115200 bit/s. A controlled optical replay through KS-959 also
returned all 293 expected frames at this setting. The WQV-3 defaults are
unchanged. This establishes a working receive setting without claiming that
USB traces reveal the precise electrical cause of the earlier corruptions.

The WQV-2 browser app uses the shared SUM16 client for PC and OTHERS reception.
PC can read one or all photos; OTHERS can receive one photo when the watch
initiates the transfer. KS-959's receive counter is synchronized with a unique
valid clock greeting in PC mode, or two valid B3 greetings in OTHERS mode.
It does not use the WQV-3 CRC decoder to qualify an old-protocol stream.

Browser checks exercise both USB transports with simulated watch responses,
including preparation before Start, reception, cancellation, separate model
albums and USB release when returning to Programs. OTHERS reception with
the corrected settings still needs a physical WQV-2 check. Photo upload is
not implemented for this model.

The sections below retain the investigation in order. Receiver defaults and
pending tests described in those earlier attempts reflect their dates.

## Original software and source implementations

The Internet Archive directory supplied by the owner is the original
[WQV Link 1.0.1 CD software](https://archive.org/download/ar405jpn_202403/Software/).
Both language versions were already downloaded. All 20 English and Japanese
installer files were compared with the archive's SHA-1 metadata and matched.
The extracted communication library is `ComDll.dll`, 65,536 bytes, SHA-256
`d488b77d8022a31cd676f9ad6f97d65698a9c513deb602d5c0a0fd4a13d89068`.
The earlier corpus also contains Link 1.0.2; its communication DLL is identical.

| Implementation | Findings relevant to this probe |
| --- | --- |
| Original Casio WQV Link 1.x, Windows | Single C0 BOF; SUM16 in big-endian order; checksum bytes escaped too. A 10 ms delay after the last received byte precedes every transmission. An idle connected session can send 53 directly. |
| [WQV Blink wqv12](https://github.com/partlyhuman/wqv-blink/tree/main/firmware/wqv12) | Same hello/connect/ready commands, strict SUM16 and one BOF. Its documented WQV-2 support uses an ESP32 and TFDU4101; it does not supply a SigmaTel configuration. |
| [Kees Jongenburger's WQV-2 tool](https://wqv-wristcam.sourceforge.net/protocol/protocol.html) | Fixed 115200, SUM16, 128-byte image payloads and repeated replies. Its Java implementation uses a 16-bit sum; the prose pseudocode's modulus 0x1000 is a typo. Its close routine first ends an image transfer. |
| [Open WQV Link](https://github.com/JoshuMain/open-wqv-link) | Same command family, skips repeated 63 replies, offers a direct 53 disconnect, and retries data without advancing the packet number. It documents hardware verification on WQV-1 rather than WQV-2. |
| [wrist-cam-2026](https://github.com/AtomBoy/wrist-cam-2026) | Uses a 20 ms receive-to-transmit pause through a serial adapter. This corroborates the need for a guard interval, but is not the source of the original Casio timing. |

Several projects build on Marcus Gröber's protocol notes. Their agreement is
useful, but they are not independent discoveries of the protocol. The original
Casio binary provides a separate check of framing and timing.

## Adapter drivers and physical settings

The original WQV Link 1.0.1 manual specifies a PAD-2 connected to a 9-pin
serial port; its own application does not support a laptop's built-in infrared
port. The module-2220 manual likewise names PAD-2. The later WQV Link 2.0
manual explicitly excludes WQV-1 and WQV-2 from PAD-5 support. The downloaded
PAD-5 Windows driver is therefore not an official WQV-2 reference driver.

The later Link 1 hybrid CD contains an optional USB-to-serial cable driver,
not the SigmaTel driver. Its `U2SWDM.INF` identifies Magic Control Technology
and USB VID/PID `0711:0230`; `U2SP2K.INF` creates the serial-port device.
The extracted Windows 2000 `U2SWDM.SYS` has SHA-256
`8d500b010de337a357ec6e469071d6d5a56427164e5aa685ef060787351ed01a`.
By comparison, the PAD-5 INF targets SigmaTel `066f:4200` and `stirusb.sys`.
These drivers control different USB hardware and cannot be interchanged.

Our native program does not run either Windows driver. It controls the owner's
SigmaTel through libusb and the same SIR register setup used for WQV-3,
with a separate WQV-1/2 SUM16 protocol above it. The successful probe establishes
that this raw path can exchange WQV-2 frames; it does not prove sustained
photo reception or make the official PAD-5 compatibility exclusion disappear.

The old watch protocol uses fixed 115200, 8N1. SigmaTel is directly configured
at 115200 (PDCLK 09), without the colour watches' 9600 discovery negotiation.
Its short transmit pulse is 1.6 microseconds; 3/16 of a bit at 115200 would be
about 1.628 microseconds. These are almost equal at this baud rate, so a pulse
width comparison would not be the large change it is at 9600. The default
receive-pulse threshold is eight samples, with a four-sample comparison now
available. The PAD-2's exact optical waveform and receiver filtering have not
been recovered from these drivers, and USB logs do not measure optical timing.

Sources: [module 2220 manual](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_EN.pdf),
[original Link 1 manual](https://archive.org/download/ar405jpn_202403/Manual/English/WQVLink_Manual_E.pdf),
[Marcus Gröber's physical-link notes](https://www.mgroeber.de/wqvprot.html).
The Link 2 manual text, SigmaTel datasheet, PAD-5 driver and the extracted
hybrid-CD drivers are preserved in the local research corpus.

The UART translation in that MCT SYS has now been emulated separately; see
[the MCT driver comparison](wqv12-mct-u232.md). Its 22 cases confirm the baud,
line-format, handflow and modem-control requests. They do not provide the
PAD-2's optical pulse timing. The same report records the SourceForge Java
client's all-photo path and its warning-only checksum handling.

## The missing delay

In the original DLL, routine `10005A60` reads a serial byte and stores
`GetTickCount()` at `10010438`. Routine `10005AA0` waits, using `Sleep(1)`, until
the current tick count reaches that timestamp plus 10 ms, then invokes the
serial writer. The rule includes every received byte, not just valid frames.

The prototype lacked this guard. In the owner's last capture, the first connect,
ready and disconnect requests followed the preceding nonempty USB completion
by 0.193 ms, 0.074 ms and 0.197 ms respectively. The prototype now waits at least
10 ms from the last nonempty USB read before sending another frame. Waiting
from USB delivery is conservative because optical reception happened earlier.
The delay is recorded in transmission attempts and checked after timer wakeups.
The default RX threshold remains code 1, and the baud rate remains 115200.

The original idle-disconnect routine `10002810`, starting in connected state 4,
calls `10002300` and sends a single `C0 02 53 00 55 C1`. It then enters state 6
to await the reply. A preceding photo-transfer command is not required by this
path. Therefore the probe's use of 53 is not itself an invented close sequence.

## Reproducible binary checks

The workspace script `work/wqv12-native/research/emulate_link1.py` runs the
original x86 routines in Unicorn. Serial reads/writes, time, sleep and logging
are stubbed; no Windows application, driver or USB operation is run.

The resulting fixture, `tests/fixtures/wqv12-link1-traces.json`, records:

- Fourteen actual original-encoder outputs, including hello, connection, ready,
  disconnect, image requests, data and escaped checksums. Our encoder matches
  all fourteen byte for byte.
- Five timing cases: requests made 0, 3, 9, 10 and 15 ms after reception wait
  another 10, 7, 1, 0 and 0 ms respectively.
- The original idle-disconnect path, producing only the expected 53 frame
  after the 10 ms guard.

These checks establish the original software's behavior. They do not establish
that this change fixes the physical watch connection.

## What the first hardware captures show

Both probes received a valid clock, accepted the assigned address 02 and
completed ready/01. Neither received a valid final disconnect acknowledgement.
The longer capture contains 19 rejected SUM16 bodies. Its last reply is
`C0 81 63 00 65 C1`; the intended address-02 reply would be
`C0 02 63 00 65 C1`. Several hello replies also contain altered or missing
bytes, so the unknown source of reception damage remains relevant even after
restoring the missing turnaround delay.

The owner's next probe, `WQV2-PC-2026-10-28T16-53-04-416Z.zip`, completed
normally with the corrected 10 ms delay and unchanged RX threshold 1:
five transmitted frames, six valid received frames, zero checksum failures,
and `connected-and-closed` in 898 ms. The raw stream includes the final
`C0 02 63 00 65 C1`. One ready request was repeated after the watch's three
63 connection acknowledgements; that retry received 01. This verifies the
new probe path on the physical WQV-2. It does not yet verify photo transfer
or establish that all possible reception errors came from missing turnaround.

The subsequent current-photo run, `WQV2-PC-2026-10-28T16-57-04-195Z.zip`,
did not download a photo. After `10 00`, the original USB stream contains
`81 02 21 00 E4 C1`, where the expected acknowledgement would be
`C0 02 21 00 23 C1`. Both the BOF and the checksum byte differ. After retries,
valid `02 43` replies arrive; another copy ends in 83 rather than C1.

This exposed a diagnostic limitation: `badChecksum=0` only counted frames
whose start and end were recognized. It did not mean the receive stream was
undamaged. The parser now additionally reports `unframedBytes` and
`abandonedFrames`; this captured stream has six unframed bytes and one frame
abandoned when the next BOF arrived. The stream is preserved in
`tests/fixtures/wqv12-current-damaged-ack.json`. No guessed marker or payload
repair is applied. A valid unexpected 43 now stops the current exchange with
an explicit error instead of repeatedly reporting that the watch was silent.

`tests/fixtures/wqv12-first-probes.json` preserves both original delivered USB
streams and their chunk boundaries. Strict decoding accepts the valid replies
and rejects the damaged ones. There is no guessed SUM16 payload repair.

The optional `--rx-sensitivity 0` experiment changes only the pulse-detection
threshold and verifies register readback. Its USB-only preparation succeeded.
The subsequent physical comparison still failed at the header: six bad SUM16
bodies, two abandoned frames and six unframed bytes. Threshold 1 remains the
default.

## Later reads and a FIFO comparison

The four later `--all` attempts ending at 17:47:30, 17:48:00, 17:49:45
and 17:50:03 UTC on 28 October still produced no images. Three stopped at
connect; the 17:49:45 attempt sent `10 01` and again received `02 21 00 E4`
with a bad checksum. Thus changing the image-request parameter from 00 to 01
did not avoid that repeated invalid acknowledgement. Threshold 0 also failed
to give reliable reception in its earlier comparison.

Several known byte differences fit per-character bit-alignment models:

| Expected byte | Captured byte | Corresponding model |
| --- | --- | --- |
| 03 | E0 | Start three bits late, then idle ones |
| 23 | E4 | Start three bits late, then idle ones |
| 2D | CB | Start two bits late, then idle ones |
| C1 | F0 | Start two bits late, then idle ones |
| 2D | 5B | Start one bit early, including a preceding idle one |

This is a diagnostic inference, not a measurement of optical timing and not
an algorithm for repairing data. USB, controller and optical causes have not
been separated. The workspace `start-bit-patterns.json` records the models
and the later attempts. Accepted image records still require valid SUM16.

The fixed PC-link rate remains 115200, 8N1. The WQV-1/2 protocol has no
documented 9600 discovery-to-faster-rate negotiation. Changing only the
adapter rate would also change its outgoing hello timing, so failure at a
lower rate would not be an isolated measurement of receive-clock tolerance.

The optional comparison `--no-fastrx` changes MODE from 2A to
22, clearing only bit 3, FASTRXEN. Per STIr4200 table 12, that bit permits
simultaneous FIFO reads and writes. Baud, SIR modulation, optical input,
pulse width, DPLL setting, RX threshold and the 10 ms turnaround remain the
same. Preparation verifies register readback before any IR traffic. The
normal mode remains unchanged unless the flag is supplied.

The owner's `WQV2-PC-2026-10-28T18-34-58-347Z.zip` tested this configuration.
Register readback confirmed MODE 22 and the unchanged threshold, clock and
DPLL. The run accepted a valid 21 acknowledgement but failed on the following
header poll. It recorded 26 bad SUM16 bodies, one malformed frame, 97 unframed
bytes and one abandoned frame. Turning FASTRXEN off did not fix reception.
MODE 2A remains the default.

## OTHERS on WQV-2

The shared OTHERS menu name does not imply the same protocol across models.
[Gröber's Nokia page](https://www.mgroeber.de/nokia.html) explicitly separates
the WQV-1/2 application for Nokia 9110 from WQV-3's standard IrTran-P support.
The old and colour models have different communication protocols.

[molefrog/casio-wqv-rcv](https://github.com/molefrog/casio-wqv-rcv) documents
successful WQV-2 OTHERS SEND reception on a Mac with an IrDroid serial USB
adapter. Its source confirms that the watch initiates the older SUM16 family,
acting as the sender while the computer acts as another receiving watch:

| Watch sends | Receiver answers |
| --- | --- |
| FF B3 | FF A3, four local handshake clock bytes |
| FF 93, echoed clock and assigned address | assigned-address 63 |
| 11 | 01 |
| 10, data 04 FA 1C 3D | 21 |
| 11 | 20, data 06 |
| 32, 34, 36, 38, 3A, 3C, 3E, 30; data 05 plus image bytes | 41, 61, 81, A1, C1, E1, 01, 21 respectively |
| 31 | 42, data 06 |
| 53 | 63 |

The original protocol notes also describe an optional 51/41 poll before 53.
The native `--others` receiver accepts either closing sequence. It waits for
a valid B3 before transmitting, verifies the challenge echo and 7229-byte
record size, rejects bad sums, and repeats acknowledgements for duplicate
requests without appending the image bytes again. An A3 response does not set
the watch clock. All raw USB traffic remains in the capture.

This implementation is based on the protocol behavior, not a copy of the Rust
source. Its simulated peer checks do not establish reception on the owner's
SigmaTel. No complete image from this WQV-2 has been captured yet.

## First OTHERS hardware run, 29 October

The owner ran the receiver and supplied
`WQV2-OTHERS-2026-10-29T03-09-36-850Z.zip`. Its 71 original input bytes have
SHA-256 `d1c5494e9e112702a61301cec284382f60478a69ee720711dfd534859ee6ffb9`.
Grouping nonempty USB reads by gaps of at least 100 ms yields fourteen bursts,
approximately 0.53–0.59 seconds apart. This is diagnostic grouping, not frame
reconstruction or a claim that host timestamps measure optical byte timing.

| Observed burst | Count | Compared with expected C0 FF B3 01 B2 C1 |
| --- | --- | --- |
| C0 FF B3 01 B2 C1 | 1 | Complete valid greeting |
| C0 B3 01 B2 C1 | 5 | FF missing |
| C0 B3 C0 B2 C1 | 8 | FF missing; 01 replaced by C0 |

The first four damaged bursts preceded any host transmission. The fifth
burst was valid; the host sent one complete A3 with challenge 06091FD3,
10.87 ms after the last input. The watch continued repeating damaged B3
greetings instead of sending 93. This does not establish that it received A3.
The run never connected and received no image data.

The strict parser reports zero bad sums because none of the thirteen damaged
bursts has a complete address/control/checksum body to check. Instead it counts
thirteen malformed endings and eight restarts at an unexpected C0. Short bodies
are now also written as explicit rejection events. The fixture
`tests/fixtures/wqv12-others-damaged-hellos.json` preserves the bytes, original
USB chunks and burst grouping. A passive replay accepts exactly one B3,
without repairing the other bursts or emitting any infrared frame.

The next controlled comparison uses native `--listen` with LONGP 1 and 2,
with the watch sending OTHERS. Each records 30 seconds and sends no reply.
Per STIr4200 table 20, LONGP occupies DPLL bits 1:0 and tunes the receive
pulse detector; the reset value is 2, whereas the Linux setup uses 1 in its
15 register value. The comparison changes 15 to 16, retaining DPCNT in bits
7:2, RXDSNS, mode, speed and all transmitter settings. It does not change
the default or assert that reset LONGP will fix this adapter. Register readback
is required before capture. A watch NG/timeout is expected in this passive
test and is not its success criterion.

USB-only `--prepare-only` runs on the owner's SigmaTel verified DPLL 16 at
03:19:21 UTC and restored DPLL 15 at 03:19:36 UTC on 29 October. Both readbacks
matched; the captures contain no infrared OUT frames. They validate register
access, not optical reception. The 29 software checks pass on Node.js 24.21.0
and 26.12.1.

## Passive LONGP comparison and interruption

The owner supplied both passive runs. The LONGP 1 recording completed its
30 seconds; LONGP 2 was interrupted after 28.736 seconds because the watch
displayed ERROR. Since neither run sends an acknowledgement, a watch timeout
or ERROR is expected. The shortened recording already contains repeated
greetings and does not need another run just to reach 30 seconds.

| Setting | Received bytes | Valid B3 greetings | Result |
| --- | --- | --- | --- |
| LONGP 1, DPLL 15 | 144 | 3 | 28 observed bursts; repeated missing FF and shifted bytes |
| LONGP 2, DPLL 16 | 163 | 0 | Same damage, plus unframed FF bytes; interrupted |

Both ZIPs passed their integrity checks and their input binaries match the
durable JSONL journals. Changing LONGP to 2 did not fix reception in this
comparison. The owner also tried near-contact and 5–10 cm positioning with
the same problem. The original input streams and pattern counts are preserved
in `work/wqv12-native/research/longp-passive-comparison-2026-10-29.json`.

The second archive records a separate cleanup problem: terminal SIGINT reached
both Node and its Python child. Python stopped before Node's close RPC could
finish, leaving `Native USB bridge exited: null` in cleanupError. It did not
damage the ZIP. The Python bridge now ignores SIGINT; Node owns cancellation,
sends close over RPC and saves the capture. Signal-caused bridge exits also
report their signal name instead of null.

Three Node IPC tests and three Python dispatcher tests passed, including real
SIGINT delivery to a subprocess and a fake adapter's close callback. A further
check interrupted a real passive SigmaTel USB read with SIGINT to the isolated
Node/Python process group. Its ZIP
`WQV2-LISTEN-2026-10-29T03-38-30-189Z.zip` is intact, cleanupError is absent,
stderr is empty and infrared OUT contains zero bytes. No watch transfer was
started. The preparation also returned LONGP to the normal value 1.

## KingSun KS-959 comparison

The owner supplied KS-959 drivers and reported successful WQV-3 use. The
workspace already contains a working native KS-959 transport and actual WQV-3
captures at 9600 and 115200. A separate `work/kingsun-ks959/wqv12.mjs` now
connects that transport to the same WQV-1/2 SUM16 client. This comparison
changes the USB/controller path while retaining the protocol and the original
Casio 10 ms turnaround guard.

The new raw SIR boundary avoids SigmaTel FIFO/register requests and does not
wrap KS-959 writes in a SigmaTel 55 AA USB header. Its incoming bytes are
unmasked and have only the documented KS-959 counter-wrap slots removed;
they bypass the WQV-3 CRC decoder and are checked by the common SUM16 parser.
Original encoded control-IN bytes are journaled before unmasking. Both stages,
counter states, control requests and rejected frame bodies remain in each ZIP.

USB-only preparation succeeded on the owner's KS-959 (07D0:4959), session
14940375826828: the eight-byte format command selected 115200/8N1 and cleanup
returned it to 9600. Counter 98 was unchanged. The archive
`WQV2-KS959-2026-10-29T17-35-18.952Z.zip` contains no attempted or completed
infrared frame. The first optical WQV-2 run on this transport is still pending.

Static examination of the supplied Kingsun driver 5.21s confirms normal
receive, transmit and baud/8N1 requests. No pulse-threshold, pulse-width or
FIFO-reset command was found in those transfer/format functions. Windows uses
more USB padding than Linux; the useful length is a separate request field.
The first test retains the Linux-compatible packing already used for WQV-3.
The scoped comparison and disassembly are in
`work/kingsun-ks959/research/windows-driver/` outside the public repository.
