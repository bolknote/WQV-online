# SWAN signal and replay tests

Open `/swan-listen.html?experiment=sync`. All five steps use 9600 bit/s.
The older passive recordings remain at `/swan-listen.html` in their original
database. New experiments use `wqv-swan-sync` and the same research-tab lock.

The first two steps receive only, with USB bulk OUT blocked. In SEND, the first
front-button press enters photo selection. The right-hand buttons select a
photo. The second front-button press starts sending. Start recording before
the first press. Mark **Entered photo selection**, wait three seconds, change
the photo and mark **Changed the selected photo**, wait again, then press the
front button and mark **Started sending on the watch**. These are separate
observed states, not a double-click. RECEIVE retains a generic press marker;
its physical sequence is not inferred from SEND.

While bytes are arriving in a passive test, cover the optical path with an
opaque card for about three seconds, then uncover it, marking both actions.
The same recording tests whether incoming bytes follow optical visibility.
If transmission ends before uncovering, repeat with a freshly activated watch;
a timeout alone does not establish the cause of silence.

The remaining three steps replay previously captured bytes: first with the
watch removed, then with SWAN SEND and SWAN RECEIVE. The default is `7A 06 F0`.
Other observed triples and the exact original 66-byte SEND/RECEIVE recordings
are selectable before USB preparation. The two complete recordings are replayed
contiguously, without their original pauses. Match the selected replay between
the no-watch control and the watch test.

Nothing transmits during USB setup. Each replay capture permits one transmission
with the selected timing. The no-watch control defaults to **With the Start
button**. RECEIVE defaults to **With the RECEIVE mark**: start recording before
the final watch button, activate reception on the watch, then immediately click
**Mark RECEIVE and send once**. Start alone does not transmit. Further RECEIVE
marks remain in the journal but cannot send a second time. The page click is a
user report, not an optical timestamp; the mark, send request, USB completion
and FIFO completion have separate timestamps. **With the Start button** is still
available if reception is already active before recording. A silent peer does
not prevent either explicit transmission. SEND defaults
to **After incoming bytes, once**: start recording before activating the watch;
the reply is queued after 12 ms without another data-bearing USB completion.
The pause lets fragmented triples arrive before half-duplex turnaround; it is
not an optical timing measurement. **Separate Send button** is also available.
**Send now, once** is shown beside Start only for Manual timing and works with
no RX. It is hidden for Start/RX timing, so a premature click cannot replace
the selected automatic schedule. The RECEIVE mark can transmit only in its
dedicated timing mode, so a marker cannot pre-empt RX timing either.
The completed TX label beside Start describes
the current attempt, not a historical recording selected for review.
The TX label separately shows queueing, USB write and confirmed FIFO drain.

The original UI required three incoming bytes to enable manual transmission.
On the October 24 runs around 11:20 UTC, none of the three replay experiments
requested a transmission; all had TX=0 and `manual-send-not-requested`. These
cannot be interpreted as the watch rejecting our replay bytes. The RX gate was
removed, and the default Start/RX timing makes the selected action explicit.

Two later SEND runs around 12:20 and 12:22 UTC did send `7A 06 F0` once and
captured 66 bytes each. Their configured timing was RX-triggered, but the
actual request source was `send-button` before any RX: the first received byte
arrived 5.0407 and 4.322 seconds after the USB writes. They therefore still do
not test a reply following a watch burst. The manual override is now hidden
outside Manual timing. Analysis records the actual request source and the first
RX time relative to the USB write, rather than inferring it from the preset.

The 17:21 UTC SEND run did perform an RX-triggered reply: three received bytes
preceded TX, the source was `rx-quiet-window`, and USB output completed 17.0 ms
after the read completing the first triple. FIFO drain completed too. RX still
contained 22 `7A 06 F0` triples with the passive capture's repeating cadence;
no new payload or image transfer was identified. The 17:22 RECEIVE run sent
4,635.8 ms before its first RECEIVE page mark, while the 17:28 manual replay
sent 659.3 ms after its mark. Both had RX=0. These are software timestamps,
not exact watch-button or optical timing. The new RECEIVE-mark schedule has
passed software tests but has not yet been tried with the physical watch.

The existing raw SIR sender adds only SigmaTel's USB length header. It adds no
frame CRC, escaping, game protocol, acknowledgement or automatic retry. No
WQV-1 probe is included. USB/FIFO failures remain failed experiments.

**Prepare all recordings…** exports a single bundle of every saved attempt,
including setup-only and unsuccessful attempts. Each attempt has its own
directory with the full USB journal and raw bytes; `manifest.json` lists the
snapshot. Where available, gzip compression wraps the ZIP (`.zip.gz`) to reduce
the size of repetitive empty USB reads without discarding them.

Each button click, picture-change mark and optical-path mark is stored with
UTC and monotonic timestamps. These are user reports and may lag the physical
action. Stage and path byte counts refer to USB completion order, not exact
optical timing. A picture-change counter is not the watch's picture number.

All original RX/TX, empty reads, errors, late completions and pending USB calls
remain in the ZIP. Its explicit download link works like the passive page's.
The planned replay is separate from requested and completed serial output.
An exact RX copy after a USB write may be echo or a repeated watch invitation;
it is not labelled a confirmed response.

The analysis groups data-bearing reads using a 30 ms gap and lists distinct
bursts. These are not established packets. It also tests whether a three-byte
burst equals `7A 06 F0` shifted by 1–7 data bits, as a little-endian 24-bit word
with zero/one fill. This is an arithmetic comparison, not UART recovery: the
start/stop bits and optical pulse timings are not available. No bytes change.

The fixtures contain the original three 66-byte recordings and data-bearing
USB completion times. They verify lossless replay presets and grouping across
USB fragmentation. Tests also cover stage/path annotations, failed/late reads,
possible echo, and one manually triggered raw transmission after early RX.
