# Watch manuals

The Programs screen includes three document files, one for each watch. Opening a
file selects the English, Russian, Japanese or German edition using the same
saved language as the watch applications. In German, WQV-3 still opens the
English edition and its icon remains labelled **User’s Guide**.

| Model | Module | English | Russian | Japanese |
| --- | --- | --- | --- | --- |
| WQV-2 (also WQV-1) | 2220 | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_EN.pdf) | [i-Watch PDF](https://i-watch.ru/image/catalog/info/instruktsii/casio/2220.pdf) | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_JA.pdf) |
| WQV-3 | 2411 | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_EN.pdf) | [i-Watch PDF](https://i-watch.ru/image/catalog/info/instruktsii/casio/2411.pdf) | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_JA.pdf) |
| WQV-10 | 2412 | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2412/qw2412_EN.pdf) | [i-Watch PDF](https://i-watch.ru/image/catalog/info/instruktsii/casio/2412.pdf) | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2412/qw2412_JA.pdf) |

The WQV-3 Russian source was supplied by the owner. It is the i-Watch edition,
with thirteen landscape PDF pages. Its SHA-256, and the hashes of the other
sources, are recorded in `dist/manuals/manifest.json`.

The English and Russian editions have native PDF text. Japanese booklets are
scans, so their body text uses Japanese OCR; the reader identifies these as
recognized text and links to the originals. Vector diagrams remain SVG; scanned illustrations use the original
scan pixels. Decorative page borders and paragraph panels are omitted from the
HTML text layout. Images retain their own labels and internal shading.

`scripts/build-manuals.py` builds the nine English, Russian and Japanese HTML documents and their shared SVG
and PNG assets. Scan images are stored as binary PNG files without resampling.
The source PDFs and word-coordinate OCR caches are held in the local
research directory. It requires PyMuPDF 2.0 and ImageMagick. Rebuild with:

```sh
python scripts/build-manuals.py --sources /path/to/source-pdfs --ocr /path/to/ocr-cache
```

Source filenames match the catalog IDs, such as `wqv2-en.pdf`. OCR directories
use the same IDs, with a JSON word-coordinate file and rendered PNG for each
source page. The generator never writes over the source PDFs.

Faint callouts can be missed by OCR. `figure-bounds.json` records reviewed
regions for the operation-overview drawings in the Japanese editions. The
coordinates refer to the full source-page renders at the recorded dimensions;
each region includes the watch, button letters and complete leader lines.
These compound drawings use the reviewed regions instead of guessing label
ownership from OCR, which can confuse nearby paragraphs with callouts.
The WQV-10 booklet uses macOS Vision OCR; `text-corrections.json` records the
reviewed button-letter corrections on its operation-overview page.

## German editions

The German originals are Casio’s [module 2220 PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_DE.pdf)
and [module 2412 PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2412/qw2412_DE.pdf).
Both are scans. The WQV-2 source has 11 PDF pages; WQV-10 has 27, including its
PC setup sheet, power-save insert and software licence. These make eleven
adapted guides in total. No German WQV-3 edition is included.

The WQV-2 scan jumps from booklet page G-11 to G-16. The missing G-12–G-15
material is translated from page 2220-3 of the complete English module 2220
manual supplied by the owner (`libble-eu_22031.pdf`). Its hash is identical to
the English source already in the catalog. The addition covers brightness,
50/60 Hz lighting, Mix and Art modes. A small gray vertical margin note marks
it as a translation from the English original. `wqv2-de-supplement.html` holds
the translated text; its illustrations are crops from that English page. The
brightness and Mix diagrams include their complete leader lines and translated
German labels.

German scans were recognized by German Tesseract and checked against a separate
macOS Vision pass and the page images. `german-proofreading.json` records the
source hashes, illustration bounds, corrected lines, table transcriptions and
page review status. A second complete pass checked paragraph order, German
case endings, procedure references and the technical specifications. Raster
error-message and water-resistance tables were transcribed to HTML. Circled
button letters, timings, dimensions and clipped
word edges were checked against the scans. Missing index page references were
recovered from the matching section headings. Historical wording and warranty
periods have not been updated.

Words clipped at a scan edge are completed from the sentence and the matching
English guide. In the WQV-2 and WQV-10 diagrams, complete German labels replace
the cut fragments as selectable SVG text. The original scan pixels and leader lines
remain underneath; a small gray vertical note marks the repaired labels. The
source PDFs are unchanged. Printed word-break hyphens are removed when joining
lines, while grammatical hyphens such as **ein- oder** and **Stunden- und** stay.

At narrow widths, diagrams sit between paragraphs instead of squeezing the
text into a narrow column. Wide diagrams and tables scroll inside the page;
their labels keep a readable size. Browser checks cover every illustration’s
aspect ratio and all reconstructed label bounds.

Build the German guides separately, using the local source PDFs and the
reviewed word-coordinate caches:

```sh
python scripts/build-german-manuals.py
```

This generator refuses pages that have not been reviewed. `--draft` is for
proofreading, and visibly labels the result as a draft. It preserves the other
nine catalog entries; the main generator also retains the German entries.

The original manuals and their illustrations retain their publishers'
copyright. They are separate from the application's MIT-licensed code.
