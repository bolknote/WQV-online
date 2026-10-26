# Compare receiver settings during one watch transmission

Open `swan-listen.html?experiment=auto`. Choose either the clock comparison or
the receiver threshold comparison. Each mode needs one watch SEND session,
instead of restarting the watch for each setting. Prepare USB, start recording,
then press the front button once for photo selection and again to send. No page
marker is required to run the comparison. Keep the same watch/adapter position.

The page receives two bursts at each of seven settings, selects two candidates,
then receives three more bursts at each finalist. The target is 20 study bursts,
with remaining repeats recorded at the provisional winner. A short or silent
train may leave an incomplete result; it must not become a confirmed selection.

The threshold mode compares all legal RXDSNS codes at 9600 bit/s. The clock mode
holds RXDSNS at code 5 (24 samples) and tries PDCLK 119, 117, 121, 115, 123, 118
and 120. Rates displayed for these divisors use `1152000 / (PDCLK + 1)`. That
relationship is inferred from the standard-rate values in SigmaTel's datasheet,
table 14; these are estimated rates, not measured optical bit times. The two
modes vary one parameter at a time. The normal PC driver setup stays unchanged.

The automatic reader only writes registers 2 and 4, between completed USB reads
and after 40 ms of receive quiet. Every write is checked by a register readback.
It never clears FIFO, resets the modulator or sends bytes to the watch. Bytes
received during the first 250 ms or within 20 ms of a switch are saved but
excluded from ranking as possible buffered or transition data. Native USB reads
use a task yield rather than a per-read timer sleep, to avoid one-second browser
background timer clamping merging several watch repeats. A frozen page or slow
USB may still limit the comparison; software timestamps are not optical timing.

Burst grouping is based on USB completion gaps. Long bursts are retained whole,
never divided into assumed three-byte packets. The ranking does not contain an
expected `7A 06 F0`. It compares the dominant observed length, repeated words,
and bit distances to each profile's most frequent observed word. All-zero and
all-FF outputs are treated as uninformative. Disagreement with the cross-profile
modal word is a tie-breaker, not a known protocol check. The same heuristic can
prefer a stable but incorrectly decoded signal; a winner remains provisional.

The live table shows each setting, sample count, modal bytes and exact repeats.
The separate `wqv-swan-autotune` database retains attempts without replacing the
manual comparison records. ZIP exports include `auto-tune.json`, settings and
transition events, original USB calls/results, empty reads and late completions.
`usb-in.bin` is unchanged. A late close completion need not belong to a scored
window; it is still part of the raw export.
