# Searching for the WonderSwan camera application

No ROM or source code for a Casio–WonderSwan camera application was obtained.
No new handshake bytes were recovered. The sources found so far describe an
exhibition project and planned support, rather than a verified retail program.

## Casio's own explanation of the menu

The [WQV-3 FAQ captured on 27 August 2001](https://web.archive.org/web/20010827003904/http://www.casio.co.jp:80/ww/wc/wqv-3/faq.html)
has a question about the icons in the IR COM menu. Casio says that, at that
stage, the supported partners were PCs and watches, and the two other icons
could not yet be used. The HTML identifies them explicitly:

- `img/swan.gif`, with alt text identifying SWAN: handheld game communication
  was planned for the future.
- `img/others.gif`, identifying OTHERS: PDA communication was also planned.

The same answer remains in the
[2 December 2001](https://web.archive.org/web/20011202080939/http://www.casio.co.jp:80/ww/wc/wqv-3/faq.html)
and [15 December 2002](https://web.archive.org/web/20021215203919/http://www.casio.co.jp:80/ww/wc/wqv-3/faq.html)
captures checked. An unchanged FAQ can be outdated; this is not a cancellation
notice.

This is a dated statement about available support. It does not show whether
the watch firmware contains a complete SWAN handler, and it does not establish
that either mode remained unavailable forever. The same period's
[download page](https://web.archive.org/web/20010908192758/http://www.casio.co.jp:80/ww/wc/wqv-3/download.html)
lists PC, Palm and CASSIOPEIA software and adapter drivers; no WonderSwan
application was identified there.

## What was shown

The firsthand [Tokyo Game Show report from September 2000](https://pc.watch.impress.co.jp/docs/article/20000925/tgs02.htm)
describes a Bandai/Casio project that would transfer wrist-camera photos through
WonderWave for editing and storage. Its planned release was autumn 2001.

A [31 March 2001 exhibition report](https://game.watch.impress.co.jp/docs/20010331/bandai.htm)
has a photo caption naming the camera setup `リストカメラリンク`
(Wrist Camera Link). This gives us a search term. A caption alone does not
establish a retail cartridge title, a working demonstration or a released ROM.

[The Video Game Kraken's later account](https://videogamekraken.com/wonderswan-digital-camera-unreleased)
calls the project unreleased. That is a secondary lead; the contemporary sources above establish plans and exhibits,
not a confirmed cancellation date.

## Catalogues checked

The downloaded title lists did not identify the application under Wrist Camera
Link, WQV, Casio or camera names:

- MAME's [WonderSwan](https://github.com/mamedev/mame/blob/master/hash/wswan.xml)
  and [WonderSwan Color](https://github.com/mamedev/mame/blob/master/hash/wscolor.xml)
  software lists.
- Libretro's No-Intro metadata for
  [WonderSwan](https://github.com/libretro/libretro-database/blob/master/metadat/no-intro/Bandai%20-%20WonderSwan.dat)
  and [WonderSwan Color](https://github.com/libretro/libretro-database/blob/master/metadat/no-intro/Bandai%20-%20WonderSwan%20Color.dat),
  including their homebrew entries.
- Internet Archive metadata searches for the exact English and Japanese name;
  both returned zero items. This is not a search inside every archived ROM.

These were catalogue checks, not disassembly of all listed programs. They do
not rule out an unnamed prototype, an unlisted dump or code under another title.

No-Intro's [undumped prototype list](https://wiki.no-intro.org/index.php?title=Bandai_-_WonderSwan_%28Color%29_prototypes_undumped)
also names an internal tool, `SWAN Reciever v1.0(916)r`, with a link to auction
`d496192012`. Its purpose is not established. Neither that list nor the seller's
description connects it to Casio. It is a separate lead, not an identified
camera program or a source of commands to try on a watch.

## What would let us extract the handshake

An exhibition ROM, a source archive or a capture from a working camera
application would provide a concrete target. We could then locate serial I/O
and trace the bytes sent when its receive/send screen starts. Generic
WonderWitch terminal code does not supply that missing Casio application layer.

Downloaded pages, catalogue snapshots, checksums and the Japanese watch manual
are retained locally in `work/wqv-swan-program-search/` outside the repository.
No downloaded program was executed and no owner or seller was contacted.
