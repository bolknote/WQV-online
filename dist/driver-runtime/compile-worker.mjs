import { makePack } from './corpus/packs.mjs';
import { compileUnit } from './corpus/compiler.mjs';
import { preparePack } from './corpus/prepare-pack.mjs';
import { readUSBMatches } from './read-usb-matches.mjs';

self.onmessage = async event => {
  try {
    const { record } = event.data;
    if (!record.profile) throw new Error('This source needs Linux API services that are not available yet. The source has been saved.');
    self.postMessage({ progress: 'compiler' });
    const pack = preparePack(await makePack(record.profile), record);
    self.postMessage({ progress: 'compiling' });
    const result = await compileUnit(pack);
    const usbMatches = await readUSBMatches(result.bytes);
    if (result.sourceSHA256 !== record.sha256) throw new Error('The source changed while compiling.');
    self.postMessage({ result: { ...result, usbMatches, inputSHA256: record.inputSHA256, profile: record.profile, builtAt: Date.now() } }, [result.bytes.buffer]);
  } catch (error) { self.postMessage({ error: String(error.message || error) }); }
};
