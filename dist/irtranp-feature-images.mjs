import { featureCase, metadataUPF, jpegImageFingerprint } from './irtranp-metadata.mjs';
import { checkWatchJPEG, jpegInfo, sha256, fromHex, jpegFromUPF } from './formats.mjs';
import { normalizeWatchJPEG } from './jpeg.mjs';
import { RECORDED_CONTROL_INPUTS } from './irtranp-control-inputs.mjs';

async function numberedJPEG(number, nonce, thumbnail = false) {
  const canvas = document.createElement('canvas'); canvas.width = thumbnail ? 80 : 176; canvas.height = thumbnail ? 64 : 144;
  const ctx = canvas.getContext('2d', { alpha: false }), w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#000';
  ctx.textAlign = 'center'; ctx.font = `bold ${thumbnail ? 15 : 18}px monospace`;
  ctx.fillText(thumbnail ? 'INDEX' : 'IRTRAN-P', w / 2, thumbnail ? 16 : 23);
  ctx.font = `bold ${thumbnail ? 33 : 76}px monospace`; ctx.fillText(String(number).padStart(2, '0'), w / 2, thumbnail ? 48 : 99);
  ctx.font = `${thumbnail ? 9 : 14}px monospace`; ctx.fillText(nonce, w / 2, h - 5);
  // The nonce changes pixels too: retries cannot accidentally match an older
  // copy after the watch drops a filename or all optional metadata.
  for (let n = 0; n < 16; n++) if (parseInt(nonce, 16) & (1 << n)) ctx.fillRect(n * w / 16, h - (thumbnail ? 15 : 34), w / 16, thumbnail ? 3 : 6);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.72));
  if (!blob) throw new Error('Could not encode the labelled test image.');
  let jpeg = new Uint8Array(await blob.arrayBuffer());
  if (thumbnail) {
    const info = jpegInfo(jpeg);
    if (info.width !== 80 || info.height !== 64) throw new Error('Unexpected index-image dimensions.');
  } else { checkWatchJPEG(jpeg); jpeg = normalizeWatchJPEG(jpeg).jpeg; }
  return jpeg;
}
export async function createFeatureFiles(caseID, nonce) {
  const selected = featureCase(caseID);
  if (selected.recordedInput) {
    const files = await Promise.all((selected.recordedInputs ?? [caseID]).map(async id => {
      const recorded = RECORDED_CONTROL_INPUTS[id];
      if (!recorded) throw new Error('Recorded control file is unavailable.');
      const bytes = fromHex(recorded.dataHex), jpeg = jpegFromUPF(bytes);
      checkWatchJPEG(jpeg);
      if (await sha256(bytes) !== recorded.sha256) throw new Error('Recorded control file checksum does not match.');
      return { filename: recorded.filename, bytes, label: `${recorded.number} / ${recorded.nonce}`, transferMetadata: {},
        sha256: recorded.sha256, imageFingerprint: await jpegImageFingerprint(jpeg),
        source: { kind: 'recorded-multiple-control', sourceAttemptID: recorded.sourceAttemptID,
          sourceArchive: recorded.sourceArchive, number: recorded.number, nonce: recorded.nonce, unchanged: true } };
    }));
    return { files, caseID, nonce: files[0].source.nonce, abortMode: 'none', reusedInput: true };
  }
  if (!/^[a-f0-9]{4}$/i.test(nonce)) throw new Error('A four-digit hexadecimal test nonce is required.');
  const files = [];
  for (let copy = 0; copy < (selected.copies ?? 1); copy++) {
    const number = selected.number + copy, jpeg = await numberedJPEG(number, nonce), fields = { ...selected.fields };
    if (caseID === 'upf-thumbnail') fields.thumbnail = await numberedJPEG(number, nonce, true);
    const bytes = metadataUPF(jpeg, fields);
    files.push({ filename: ['filename', 'multiple'].includes(caseID) ? `IR${String(number).padStart(6, '0')}.UPF` : 'QW000000.UPF',
      bytes, label: String(number).padStart(2, '0') + ' / ' + nonce, transferMetadata: { ...selected.transfer },
      sha256: await sha256(bytes), imageFingerprint: await jpegImageFingerprint(jpeg),
      source: { kind: 'generated-irtranp-feature-image', caseID, nonce, number } });
  }
  return { files, caseID, nonce, abortMode: selected.abortMode ?? 'none' };
}
