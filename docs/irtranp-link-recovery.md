# IrLAP recovery and hardware fault tests

The research sender can now retain the outstanding I frame and repeat it
with the same N(S) and data. The current N(R) is included in the new header.
TinyTP credits, SCEP segments and PUT command IDs are not allocated again.
Repeated peer I frames are acknowledged without delivering their bytes or
credits twice. The advertised receive window is one frame in this mode.

After the four hardware fault tests below, `IrTranPSender` and the native
runner enable recovery by default. This also applies to uploads from the main CASSIOPEIA interface and the
research page. Deliberate faults still require `--fault`.
The native `--legacy-link` option (or API `linkRecovery: false`) retains the
old behavior for comparison; historical replay tests select it explicitly.
Other probe classes keep their existing opt-in setting.

The established-link path handles lost/corrupt I frames, lost final turns,
previous N(R), RR/RNR and REJ/SREJ. A final timeout is one second; the same
I frame may be retried at most three times. If reception is in progress,
one extra 300 ms wait is allowed. A peer requesting disconnection ends data
output. This is bounded stop-and-wait recovery, not a clone of the complete
Windows CE stack. SNRM/UA setup and DISC/UA closure retain their existing
bounded, single-attempt behavior. There is no automatic reconnect or new
PUT after a failed session.

The retry decisions follow the original Linux IrLAP `LAP_NRM_P` handling
of FINAL_TIMER_EXPIRED, RR, RNR and REJ/SREJ, inspected in the local source
`work/sigmatel-speed/linux-net-irlap_event.c`. They are not inferred from
the WQV-3 firmware. Actual watch behavior must be checked in the captures.

## Controlled faults

Each test requests only photo 10/07FB. By default the third outgoing PUT
I frame is selected, after two normal fragments have been accepted.
`--fault-at N` selects another PUT I frame (1–256). If the selected frame
is never reached, `faultOutcome` is `not-exercised`, even if the upload
itself succeeds. Each invocation waits for the user's `send` and the
watch's front-button press. There is no automatic next test.

| `--fault` | Injected event | What to inspect |
| --- | --- | --- |
| `bad-crc` | Flip one FCS bit once; transmit the complete frame | Same N(S)/data retried, then a complete upload |
| `crc-burst` | Corrupt the original frame and its first retry | Two recovery attempts before the unmodified frame |
| `truncated` | Transmit only the first half, without FCS/EOF | Receiver resynchronizes at the retry's BOF |
| `drop-ack` | Ignore one valid acknowledgement at the host after recording its original USB bytes | Retry of an already accepted I frame; no repeated application data or extra saved photo |

TX faults are applied before `captureUSB`, with a corrected SigmaTel USB
length. Original and changed buffers are retained in `fault-injected`.
`usb-call`, `usb-result`, written counts and raw binaries describe the
actual USB operation. The logical adapter completion is translated back
to the caller's requested size after a deliberately shortened frame, so
the driver can proceed to protocol recovery; that translation is also
journalled. The `tx-frame` trace describes the intended decoded frame;
use the raw OUT buffer to inspect corruption. A receive-discard fault is
explicitly a host simulation, not a claim that no signal reached USB.

The ZIP contains `faults.json`, the complete event journal and raw USB
input/output. `faultOutcome=recovered-at-protocol` requires both the
planned injection count and normal upload completion. It does not prove
persistent storage. Check the watch's photo count: each successful test
must add exactly one photo. `badCRC` counts received corrupt frames; it
does not count intentionally damaged outgoing FCS values.

## Replaying the fault tests

The native USB harness used for these captures is a local research tool,
not part of this repository. The captured wire buffers and default sender
can be checked without an adapter:

```sh
node --test tests/irtranp-fault-hardware.test.mjs
```

For a normal transfer on the watch, open the main app, choose OTHERS,
select a photo and click **To watch →**. The transfer window prepares USB
before asking for IR → OTHERS → RECEIVE and the final front-button press.
The normal app never injects a fault.

## Hardware results, 25 October 2026

The user ran all four scenarios at negotiated 115200 bit/s with the
2048-byte SCEP limit. All four returned one positive PUT reply and closed
SCEP/IrCOMM/IrLAP normally. The user reported that the watch displayed the
picture with number 10 at the end of every run. A separate photo-count or
image read-back check was not reported for these runs.

| Scenario | Attempt | PUT I-frame retries | Other recovery |
| --- | --- | --- | --- |
| `bad-crc` | `419e822c-606a-4664-a8c5-86d001616650` | 1 | One natural RINF I-frame retry; one final RR recovery |
| `crc-burst` | `b617bbf7-84d4-453e-b4b8-68dce0847efc` | 2 | One final RR recovery |
| `truncated` | `24e0f8bb-2cbe-4889-8f0e-f9fce3123ac5` | 1 | One final RR recovery |
| `drop-ack` | `352cd6c4-8a96-4c71-9f18-c8142656fde4` | 1 | One final RR recovery |

The `bad-crc` run also rejects one naturally damaged incoming frame during
RINF, before the deliberate PUT fault. The new mechanism recovers that
query too. In `drop-ack`, the intentionally ignored incoming N(R)=2
already acknowledged host N(S)=1. After the host repeated N(S)=1, the
watch returned RR with N(R)=2 and continued. The recorded application
stream still contains a single PUT.

`work/irtranp-native/verify-fault-captures.py` independently checks the
actual USB buffers, sizes, written counts and FCS values. It validates
789 outgoing frames, including the deliberately malformed buffers, and
747 accepted incoming frames (including the intentionally ignored ACK).
Every reconstructed original PUT packet matches the original CSI packet
fixture. All retries retain the original N(S) and payload. The original
ZIP files remain unchanged; analysis files are saved beside them.

`tests/link-recovery-hardware-fixtures.json` retains all four native
captures' wire buffers and original USB IN boundaries. The four tests in
`tests/irtranp-fault-hardware.test.mjs` replay every actual outgoing buffer,
including fault injection and data retries, using the default sender path.
Software peer-model tests additionally cover RR-only recovery, permanent
corruption, duplicated credits, busy/reject responses, sequence wrap and
the earlier damaged RINF frame. These results establish the tested
stop-and-wait behavior, not every IrLAP recovery or firmware error path.
