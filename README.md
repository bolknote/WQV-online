# WQV-online

Get photos on and off a Casio WQV-3 wrist camera in your browser. A USB infrared
adapter connects directly to the page through WebUSB. The interface takes its
look from the Casio CASSIOPEIA handhelds and Pocket PC 2000.

**[Open the app](https://bolknote.github.io/WQV-online/)**

![The CASSIOPEIA-style interface, with photos downloaded from a WQV-3](docs/screenshot.png)

## What you need

The tested setup is a **Casio WQV-3, module 2411**, a **SigmaTel STIr4200 USB
infrared adapter (`066f:4200`)**, and Opera on macOS. The adapter may identify
itself as “IrDA/USB Bridge.” No Windows virtual machine or kernel driver is
needed for this setup.

USB access needs a desktop browser with WebUSB, such as Chrome, Edge or Opera.
Safari and Firefox cannot connect to the adapter. The app starts in English.
Choose **Tools → Options…** to switch to Russian. It remembers your choice in
this browser, and switching languages keeps your current photo and connection.

Other infrared adapters need their own USB transport code. **ARK3116T does not
work yet.** WQV-10 and other operating systems have not been tested.

## Connect the watch

Choose **PC** or **OTHERS** on the toolbar to match the watch menu. PC has photo,
clock and calendar controls. OTHERS has Photos and Connection, for sending one
photo at a time. Both modes use the same local album. The page remembers the
mode you last used.

### PC

1. Plug in the SigmaTel adapter and open [the app](https://bolknote.github.io/WQV-online/).
2. Click **Connect USB…** and choose the adapter.
3. On the watch, select **IR → PC**, then **F / REMOTE**. Face its infrared
   window toward the adapter, about 5–10 cm apart.
4. Download the current photo or the whole collection. You can also import
   an image from your computer and send it to the watch.

If the watch leaves transfer mode, enter IR → PC again. Another application
using the adapter must release it before the browser can connect.

### OTHERS

Connect USB before starting transfer on the watch.

To get a photo from the watch:

1. Choose **OTHERS**, then **Receive photo…**. Wait for **USB ready**.
2. On the watch, choose **IR → OTHERS → SEND**. Press the front button once
   to open the photos, then choose one with the side buttons.
3. Click **Start receiving** on the page, then press the front button again
   to send the selected photo.

To send a photo to the watch, select or import it in the album and click
**To watch →**. Wait for USB to be ready, choose **IR → OTHERS → RECEIVE** on
the watch, click **Start sending**, then press the watch's front button.

Each transfer closes its connection. Start another transfer for the next photo.
The sender uses the watch's SCEP packet limit (2048 bytes on the tested WQV-3)
and retries lost IrLAP frames without starting another upload. Clock, calendar
and remote photo-browsing commands are available in PC mode.

Discovery starts at 9600 bit/s. Once the watch replies, the app negotiates the
fastest shared SIR speed, up to **115200 bit/s**. It negotiates again when the
watch takes over to send photos, and returns to 9600 after disconnecting.
The Connection tab and transfer log show the current speed. Photo downloads at
115200 have been checked with the WQV-3 and SigmaTel adapter.

## Photos and settings

- Download individual photos or the whole collection. The arrow buttons browse
  photos on the watch; clicking a thumbnail opens the local copy.
- Import images, crop or fit them, rotate them, and prepare a 176 × 144 JPEG
  for the watch.
- Save JPEGs, keep the original UPF or WQV files, or export the collection as a ZIP.
- Read and edit the holiday calendar for 2000–2039, with JSON backups.
- Set the date and time, or sync with the computer at the start of a minute.

Photo downloads, uploads and calendar reading have been checked on a real WQV-3.
Clock setting and calendar writing are implemented and have packet tests, but
have not yet been checked on the watch.

Some JPEGs returned by the watch lose their restart interval marker. The app
repairs these for viewing and export without recompressing the image, while
keeping the original file.

The SigmaTel receiver can recover a few known framing faults by checking CRC
again after correcting an escape sequence or removing one stray edge byte.
Ambiguous frames and frames that still fail CRC are dropped. The Connection
tab counts recovered frames separately from rejected CRC errors.

The receiver also uses PAD-5's empty-read rule when an end marker is damaged
or missing: one empty USB read on chip revisions up to 6, or two in a row on
revision 7 above 9600 bit/s. It checks the full frame first, then tries removing
the last byte. A timeout or a cancelled USB read never completes a frame.
This path has software tests; checking it with the watch is still pending.

If the transmit FIFO stalls, the app tries the PAD-5 recovery sequence and
ends the current transfer. Click **Connect USB…** again and restart **IR → PC**
on the watch before retrying. Completed photos stay in the collection.

Photos and calendar backups stay in this browser. There is no account, upload
server or analytics. Keep a ZIP export if you want a copy outside browser
storage. The hosted app and a localhost copy have separate collections.

Deleting a local photo only removes that browser copy. Deleting a photo from
the watch still takes the watch's buttons; the app's Help menu has the steps.

## IR research

There is a separate [research page](https://bolknote.github.io/WQV-online/research.html)
with four modes. **Listen** records what SigmaTel receives at a fixed 9600,
38400 or 115200 bit/s. Choose WATCH SEND, OTHERS SEND, SWAN SEND or SWAN RECEIVE,
prepare USB, then start recording before activating that mode on the watch. It sends no discovery,
commands or acknowledgements. Every recording and speed change is manual.

**Discovery** tests whether the watch is waiting for another device to speak.
It sends complete XID searches at 9600 bit/s, advertises itself as WEB-WQV,
and answers searches from the watch. It records any request to connect and
stops there. It sends no application commands and does not accept a connection.

**Serial bytes** tests the WonderWave/WonderWitch lead at 9600 bit/s, 8N1.
Start recording, activate the chosen watch mode, then send `15` (XMODEM NAK)
or `0D` (Enter) with a separate button. The default is one byte per capture,
with no automatic repeats. SWAN RECEIVE is available with its own instructions.
There is also a listen-only control and an optional automatic setting for SEND
modes. No IrLAP framing or XMODEM acknowledgements are added;
raw bytes and possible local echo are kept in the ZIP. These are protocol
hypotheses, not identified Casio commands.

**Commands** keeps the existing step-by-step command probes. Prepare USB first,
restart IR → PC on the watch, then send the selected command. Moving to the
next step is manual. Each attempt keeps its original USB bytes and can be
exported as a ZIP, including failed or interrupted attempts. All four modes use
the same local research journal; previous recordings remain available.

Listen and Discovery keep unknown bytes and failed CRC frames in the original
stream. Their frame decoders use strict IrDA CRC checks without recovery.
The selected mode and speed are test settings, not detected capabilities.
The first passive captures and a WATCH SEND discovery run returned no USB
bytes. Reception in the research modes is still unverified. The effects of
the unknown command codes are not established. See the
[research notes](docs/command-research.md) for instructions and the log format.
There are also [WonderWave notes](docs/wonderwave-research.md) with recovered
WonderWitch serial-transfer sources and what they might tell us about SWAN mode.

The [SWAN packet page](https://bolknote.github.io/WQV-online/swan.html) tests complete candidate packets recovered
from Digimon programs on WonderSwan and PocketStation. Start with the adapter
echo control, then run each watch test separately. Start recording before
activating SWAN RECEIVE and use **Send packet once** when the watch is ready.
There are no automatic replies or repeats. Its separate local journal and ZIPs
keep all USB bytes, planned and completed writes, and possible echo matches.
These packets have not been confirmed as WQV-3 commands. See the
[packet test instructions](docs/swan-packets.md).

For a passive speed comparison, open `swan-listen.html` locally. It has separate
background, SWAN SEND and SWAN RECEIVE steps at 9600 and 38400 bit/s, with no
outgoing packets. Each recording saves its confirmed setup, watch-button marker
and raw USB data. The watch's SWAN speed is still unknown. See the
[listening instructions](docs/swan-listening.md).

The separate OTHERS test page is `irtranp.html`. It keeps the manual research
plans and raw USB recordings. Normal one-photo transfers are now part of the
main app. Sending and receiving have worked on a WQV-3 at 9600 and 115200 bit/s,
including uploads with 2048-byte SCEP packets. Four deliberate link faults
also recovered: a bad CRC, two bad CRCs in a row, a truncated frame and a lost
acknowledgement. In each case the watch displayed the uploaded photo.

The main app sends one photo per connection. Although the watch advertises
multiple PUT operations, our attempts to send two photos in one connection
failed. Metadata the watch discards is kept in the original local UPF.
See the [IrTran-P notes](docs/irtranp-research.md) and
[link recovery details](docs/irtranp-link-recovery.md) for the captures and limits
of those tests. The integrated interface is checked by replaying those recorded
exchanges and has also been used with the same watch and adapter.

## Run locally

The app is plain HTML, CSS and JavaScript. There are no packages to install and
no build step.

```sh
git clone https://github.com/bolknote/WQV-online.git
cd WQV-online
python3 serve.py
```

Open <http://127.0.0.1:8765/> in a browser with WebUSB. Python only serves the
files in `dist/`; all USB communication happens in the browser. Use HTTPS or
localhost, rather than opening `index.html` as a file.

Run the tests with Node.js 24 or later:

```sh
npm test
```

The optional browser check needs Playwright installed separately and the local
server running on its default port:

```sh
node tests/browser/others.cjs
```

It replays captured watch exchanges through a fake USB adapter. It also checks
the mode switch, shared album, language settings and cancellation. It uses an
isolated browser and never opens the real adapter. Screenshots go to a temporary
folder. Set `WQV_APP_URL` to use a different local server address.

There is also an independent JPEG pixel check, using Python and Pillow:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install Pillow
.venv/bin/python tests/verify-jpeg-pixels.py
```

GitHub Actions runs the JavaScript tests on pushes and pull requests. A passing
push to `main` publishes `dist/` to GitHub Pages, so the site's root opens the
app directly.

## Credits and license

By Evgeny Stepanischev. Released under the [MIT license](LICENSE).

The watch protocol work builds on Roger Braunstein's
[WQV Blink](https://github.com/partlyhuman/wqv-blink), also MIT licensed. Its
copyright and license are preserved in [third-party-notices.txt](third-party-notices.txt).
The Linux [STIr4200 driver](https://github.com/torvalds/linux/blob/v4.16/drivers/staging/irda/drivers/stir4200.c)
was a reference for the adapter's registers and USB framing. Additional watch
commands were worked out from Casio's original PC software.
Frame and FIFO recovery behavior was also checked against Casio's original
PAD-5 driver, `stirusb.sys` 1.23.
