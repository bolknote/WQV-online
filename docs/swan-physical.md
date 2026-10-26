# SigmaTel pulse width and receiver comparison

Open `/swan-listen.html?experiment=physical`, also linked from both SWAN listening
pages. Each step starts manually. Prepare USB before activating the watch, then
start recording before the two front-button presses: one enters photo selection,
the next starts sending. Restart SWAN SEND for each attempt and keep the same
photo, placement and recording duration. The default capture window is 45 seconds.

The first two steps compare **transmit** pulse widths: 1.6 microseconds and
3/16 of a bit (19.53125 microseconds at 9600 bit/s). Both reply with `7A 06 F0`
once, after 12 ms without another data-bearing USB completion. The payload,
reply schedule, 9600 bit/s rate and receive threshold (code 1, eight samples)
stay fixed. There is no transmission during preparation or merely on Start.
The reply remains an unknown handshake candidate; no change after either test
does not establish that the watch decoded it or rule out a physical mismatch.

The next seven steps receive only, with USB bulk OUT blocked. They start with
the normal threshold (code 1), then try codes 0, 2, 3, 4, 5 and 6. The detector
requires 4, 8, 12, 16, 20, 24 or 28 consecutive samples of a pulse, respectively.
More required samples means a stricter threshold. Illegal code 7 is excluded.
TX pulse width is fixed at its normal short setting for these passive tests.

The source is the [SigmaTel STIr4200 datasheet, v2.0, table 16, p. 17](https://pdf.dzsc.com/STI/STIR4200.pdf#page=17).
Only register 4 changes: RXDSNS bits 7:5 and SPWIDTH bit 3. Bit 4 is reserved
and written as zero; bits 2:0 are the read-only chip revision. Each preparation
runs the existing normal setup, writes the profile and reads registers 1–9 back.
A mismatch prevents recording. Clock, modulation, control, DPLL and electrical
polarity are checked for unintended changes. No parity or stop-bit setting is
invented, and the normal PC driver setup is unchanged.

This page uses a separate `wqv-swan-physical` journal database and the existing
research-tab lock. Old sync recordings remain on the signal/replay page.
Reprepare USB for every step; a fresh normal setup replaces the previous profile.
The next test never starts automatically.

The ZIP includes `settings.json` with requested values, before/after register
readbacks, verification and the related events. All original USB calls/results,
empty reads, errors and late completions stay in `events.jsonl`; `usb-in.bin`
is untouched. Planned, requested and completed TX remain separate files. The
all-recordings export includes unsuccessful and preparation-only attempts too.
USB read times do not preserve optical pulse widths or UART framing errors.

Software tests cover isolated register changes, chip ID readback masking,
rejected settings, idle-receiver guards, one fixed RX-triggered replay per pulse
profile, passive reception and raw exports. These are not hardware results;
the new profiles still need to be compared with the physical watch.
