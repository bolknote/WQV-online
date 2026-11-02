# WQV-10 / module 2412

WQV-10 opens `wqv3.html?model=wqv10`. The shared application takes its name,
icon, database and calendar format from `dist/watch-models.mjs`. WQV-3 keeps
its existing URL and database. WQV-10 uses `casio-wqv10-webusb`.

The PC discovery names are `CASIO WIC 2411/IR` for WQV-3 and
`CASIO WIC 2412/IR` for WQV-10. An application rejects the other model before
sending SNRM or any application command. The generic protocol client can
still discover either model when no expected model is supplied.

Both models use 176 × 144 JPEGs in the existing UPF/SCEP transfer. Photo
archives retain their model number and can be imported into either application.
Clock setting, photo browsing and REMOTE exit use the same PC commands.
The shared reader already supplies WQV-10's two extra bytes after PC requests
00 and 01. OTHERS and SWAN use the existing photo-transfer implementations.

## Calendar wire formats

| | WQV-3 | WQV-10 |
| --- | --- | --- |
| Read command | `09` | `09` |
| Write prefix | `08 07 30` | `08 1C 89` |
| Data bytes | 1840 | 7305 |
| Date field | Active-low bit, MSB first | Four-bit colour |
| Layout | 368 bits per year | Low nibbles: 2000–2019; high nibbles: 2020–2039 |
| Values | Ordinary / holiday | 0 standard, 1 blue, 2 red, 3 green |

WQV-10 packs actual days consecutively, including leap days. Its PC program
keeps 368 DWORD entries per year internally, but skips the padding when writing
the wire buffer. The two halves each contain 7305 days. Two dates twenty years
apart share one byte; editing one preserves the other nibble. Unknown nibble
values are kept until that date is explicitly edited.

These details come from PCLink3.exe's encoder at `0040A0E0`, decoder at
`0040A1A0`, and colour drawing table at `0040A8E4`. comm_wc3.dll builds the
calendar command at `100027B1`. Calendar backups have a separate format ID,
`casio-wqv10-calendar-v1`, so a WQV-3 backup cannot be written accidentally.

`tests/fixtures/wqv10-calendar-original.json` contains output from executing
the original x86 encoder in Unicorn, its source hash and representative dates
at both nibble boundaries. Only the Gregorian year-length helper was stubbed.
Unit tests compare every byte with the JavaScript implementation. Browser
tests use an in-memory watch for editing, backup, write and readback checks.
No physical WQV-10 transfer has been verified yet.

To regenerate the reference fixture, install Unicorn in an isolated Python
environment and run `scripts/reference-wqv10-calendar.py /path/to/PCLink3.exe`.
The executable is not distributed with the application.

## Manuals

The Pocket Word reader has English (7 source pages), Russian (12) and Japanese
(31) WQV-10 guides. Text reflows; illustrations retain their original labels.
The Japanese booklet uses OCR and links to the scan. Source URLs and SHA-256
hashes are in `dist/manuals/manifest.json`. The originals describe the transfer
destinations as icons, rather than WQV-3's text menu.
