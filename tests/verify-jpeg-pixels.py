"""Independent pixel check with Pillow/libjpeg; QA only, not a runtime dependency.
Run: python3 tests/verify-jpeg-pixels.py (also requires Node.js).
"""
from pathlib import Path
import io
import subprocess
import tempfile
from PIL import Image, ImageChops

root = Path(__file__).resolve().parent.parent
original = (root / 'tests/fixtures/restart-row.jpg').read_bytes()
p = original.index(b'\xff\xdd')
dropped = original[:p] + original[p + 6:]
script = """
import {readFile,writeFile} from 'node:fs/promises';
import {normalizeWatchJPEG} from './dist/jpeg.mjs';
const input=new Uint8Array(await readFile(process.argv[1]));
await writeFile(process.argv[2],normalizeWatchJPEG(input).jpeg);
"""
with tempfile.TemporaryDirectory(prefix='wqv-jpeg-pixels-') as folder:
    folder = Path(folder)
    for name, data in [('valid', original), ('missing-dri', dropped)]:
        source, target = folder / (name + '.jpg'), folder / (name + '-normalized.jpg')
        source.write_bytes(data)
        subprocess.run(['node', '--input-type=module', '-e', script, str(source), str(target)], cwd=root, check=True)
        reference, actual = Image.open(io.BytesIO(original)), Image.open(target)
        reference.load()
        actual.load()
        assert reference.size == actual.size == (176, 144)
        assert ImageChops.difference(reference, actual).getbbox() is None, name
        print(name + ': all decoded pixels match the original')
