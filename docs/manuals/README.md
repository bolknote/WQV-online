# Watch manuals

The Programs screen includes two document files, one for each watch. Opening a
file selects the English, Russian or Japanese edition using the same saved
language as the watch applications.

| Model | Module | English | Russian | Japanese |
| --- | --- | --- | --- | --- |
| WQV-2 (also WQV-1) | 2220 | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_EN.pdf) | [i-Watch PDF](https://i-watch.ru/image/catalog/info/instruktsii/casio/2220.pdf) | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/22/2220/qw2220_JA.pdf) |
| WQV-3 | 2411 | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_EN.pdf) | [i-Watch PDF](https://i-watch.ru/image/catalog/info/instruktsii/casio/2411.pdf) | [Casio PDF](https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/24/2411/qw2411_JA.pdf) |

The WQV-3 Russian source was supplied by the owner. It is the i-Watch edition,
with thirteen landscape PDF pages. Its SHA-256, and the hashes of the other five
sources, are recorded in `dist/manuals/manifest.json`.

The English and Russian editions have native PDF text. Japanese booklets are
scans, so their body text uses Japanese OCR; the reader identifies these as
recognized text and links to the originals. None of the images is redrawn or
generated. Vector diagrams remain SVG; scanned illustrations use the original
scan pixels. Decorative page borders and paragraph panels are omitted from the
HTML text layout. Images retain their own labels and internal shading.

`scripts/build-manuals.py` builds the six HTML documents and their shared SVG
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

The original manuals and their illustrations retain their publishers'
copyright. They are separate from the application's MIT-licensed code.
