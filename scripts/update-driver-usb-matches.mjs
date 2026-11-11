// Regenerate the reference-source labels from real compiled Linux C tables.
// No USB device is opened. Run: node scripts/update-driver-usb-matches.mjs
import fs from 'node:fs/promises';
import { DRIVER_PROFILES } from '../dist/driver-catalog.mjs';
import { makePack } from '../dist/driver-runtime/corpus/packs.mjs';
import { preparePack } from '../dist/driver-runtime/corpus/prepare-pack.mjs';
import { compileUnit } from '../dist/driver-runtime/corpus/compiler.mjs';
import { readUSBMatches } from '../dist/driver-runtime/read-usb-matches.mjs';

const base = new URL('../dist/driver-runtime/corpus/', import.meta.url);
const read = (path, format) => fs.readFile(new URL(path, base), format);
const manifest = JSON.parse(await read('sources.json', 'utf8'));
const log = console.log;
for (const profile of DRIVER_PROFILES) {
  const entry = manifest.files[profile.id], files = {};
  for (const name of entry.dependencies ?? []) {
    const dependency = manifest.files[name];
    files[dependency.path.split('/').at(-1)] = await read(dependency.localPath, 'utf8');
  }
  const pack = preparePack(await makePack(profile.id, path => read(path, 'utf8')),
    { source: await read(entry.localPath, 'utf8'), files });
  let result;
  try { console.log = () => {}; result = await compileUnit(pack, read); }
  finally { console.log = log; }
  entry.usbMatches = await readUSBMatches(result.bytes);
  log(profile.id + ': ' + entry.usbMatches.length + ' USB matches');
}
await fs.writeFile(new URL('sources.json', base), JSON.stringify(manifest, null, 2) + '\n');
