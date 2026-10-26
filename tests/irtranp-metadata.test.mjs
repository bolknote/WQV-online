import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromHex as hx, toHex, jpegFromUPF, parseCommand, u32, sha256 } from '../dist/formats.mjs';
import { metadataUPF, upfMetadata, metadataPutCommand, transferMetadata, upfDate,
  jpegImageFingerprint, cancellationPDU, compareMetadata } from '../dist/irtranp-metadata.mjs';
import { analyseAttempt, createSuite, bindAttempt, advanceSuite, currentStep } from '../dist/irtranp-suite.mjs';
import { attemptFiles } from '../dist/research-core.mjs';

const captures = JSON.parse(await readFile(new URL('./receiver-hardware-fixtures.json', import.meta.url)));
const original = hx(captures.sessions[0].expectedUPFHex), jpeg = jpegFromUPF(original);
const source = hx('0800740100000000'), destination = hx('0800740300000000');

test('original watch metadata is absent, not a fabricated date, author or thumbnail', () => {
  const meta = upfMetadata(original);
  assert.equal(meta.created.value, null); assert.equal(meta.modified.value, null);
  assert.equal(meta.created.rawHex, '80ffffffffffffff'); assert.equal(meta.title, null);
  assert.equal(meta.titleCharset, 255); assert.equal(meta.tables.length, 0);
  assert.equal(meta.thumbnail, null); assert.equal(meta.comment, null); assert.equal(meta.author, null);
});

test('nine identified hardware round trips retain the image but export no optional metadata', async () => {
  const fixture = JSON.parse(await readFile(new URL('./metadata-hardware-fixtures.json', import.meta.url)));
  assert.equal(fixture.cases.length, 9);
  for (const row of fixture.cases) {
    const input = hx(row.inputUPFHex), output = hx(row.outputUPFHex);
    assert.equal(await sha256(input), row.inputUPFSHA256);
    assert.equal(await sha256(output), row.outputUPFSHA256);
    assert.equal(await jpegImageFingerprint(jpegFromUPF(input)), await jpegImageFingerprint(jpegFromUPF(output)), row.label);
    const before = upfMetadata(input), after = upfMetadata(output);
    assert.equal(after.created.value, null); assert.equal(after.created.rawHex, '80ffffffffffffff');
    assert.equal(after.modified.value, null); assert.equal(after.modified.rawHex, '80ffffffffffffff');
    for (const key of ['title', 'comment', 'author', 'editor', 'thumbnail']) assert.equal(after[key], null);
    assert.deepEqual(after.tables, []); assert.equal(after.titleCharset, 255);
    assert.equal(row.outputAttributes.FIL0.rawHex, toHex(new TextEncoder().encode('QW000000.UPF')));
    assert.equal(Object.hasOwn(row.outputAttributes, 'TIM0'), false);
    assert.equal(Object.hasOwn(row.outputAttributes, 'LFL0'), false);
    assert.equal(row.storedFilenameReply, new TextDecoder().decode(hx(row.inputAttributes.FIL0.rawHex)));
    assert.equal(row.finalPollRetries, 1);
    for (const item of Object.values(compareMetadata(before, after))) assert.equal(item.matches, false);
    if (row.caseID === 'filename') assert.equal(new TextDecoder().decode(hx(row.inputAttributes.FIL0.rawHex)), 'IR000002.UPF');
    if (row.caseID === 'transfer-time') {
      assert.equal(row.inputAttributes.TIM0.type, 6);
      assert.equal(new TextDecoder().decode(hx(row.inputAttributes.TIM0.rawHex)), '20010203040506');
    }
    if (row.caseID === 'long-name') assert.equal(new TextDecoder().decode(hx(row.inputAttributes.LFL0.rawHex)), 'IrTranP long file name.UPF');
    if (row.caseID === 'upf-dates') {
      assert.equal(before.created.value, '20010203040506'); assert.equal(before.modified.value, '20040506070809');
    }
    if (row.caseID === 'upf-title') assert.equal(before.title, 'IRTRANP TITLE 06');
    if (row.caseID === 'upf-comment') assert.equal(before.comment, 'IRTRANP COMMENT 07');
    if (row.caseID === 'upf-author') {
      assert.equal(before.author, 'IRTRANP AUTHOR 08'); assert.equal(before.editor, 'IRTRANP EDITOR 08');
    }
    if (row.caseID === 'upf-thumbnail') {
      assert.equal(before.thumbnail.bytes, 2137); assert.equal(before.thumbnail.width, 80); assert.equal(before.thumbnail.height, 64);
    }
  }
});

test('UPF tables and dates relocate the unchanged main JPEG with correct bounds and padding', () => {
  const fields = { created: '20010203040506', modified: '20040506070809', title: 'TITLE', comment: 'COMMENT', author: 'AUTHOR', editor: 'EDITOR' };
  const file = metadataUPF(jpeg, fields), meta = upfMetadata(file);
  assert.deepEqual(jpegFromUPF(file), jpeg);
  assert.equal(meta.created.value, fields.created); assert.equal(meta.modified.value, fields.modified);
  for (const key of ['title', 'comment', 'author', 'editor']) assert.equal(meta[key], fields[key]);
  assert.deepEqual(meta.tables.map(t => t.id), [0x12, 0x13]);
  assert.equal(u32(file, 276), meta.tables.reduce((n, t) => n + t.bytes, 0));
  assert.equal(u32(file, 276) % 4, 0);
  assert.ok(Object.values(compareMetadata(meta, upfMetadata(file))).every(row => row.matches));
  assert.equal(compareMetadata(meta, upfMetadata(original)).comment.matches, false);
  const bad = file.slice(); bad[385] = 255; assert.throws(() => upfMetadata(bad), /overlap|length/);
});

test('an 80×64 UPF index image has its own entry and does not replace the main JPEG', () => {
  // Header dimension fixture, not a hardware image: JPEG data remains the
  // original scan. The browser generator creates a real 80×64 encoded scan.
  const thumb = jpeg.slice(); let p = 2;
  while (thumb[p + 1] !== 0xc0) p += 2 + (thumb[p + 2] << 8 | thumb[p + 3]);
  thumb.set(hx('00400050'), p + 5);
  const file = metadataUPF(jpeg, { comment: 'INDEX TEST', thumbnail: thumb }), meta = upfMetadata(file);
  assert.equal(meta.thumbnail.width, 80); assert.equal(meta.thumbnail.height, 64);
  assert.equal(meta.thumbnail.dataHex, toHex(thumb)); assert.deepEqual(jpegFromUPF(file), jpeg);
  assert.equal(meta.entries[1].offset % 4, 0);
  assert.throws(() => metadataUPF(jpeg, { thumbnail: jpeg }), /80/);
});

test('bFTP TIM0 uses time type 06 and LFL0 stays a separate optional attribute', () => {
  const cmd = metadataPutCommand({ filename: 'IR000003.UPF', bytes: original,
    transferMetadata: { time: '20010203040506', longName: 'Long name.UPF' } }, { id: 3, destination, source });
  const parsed = parseCommand(cmd); assert.equal(parsed.id, 3);
  assert.equal(new TextDecoder().decode(parsed.attributes.TIM0), '20010203040506');
  assert.equal(transferMetadata(cmd).LFL0.text, 'Long name.UPF');
  const raw = Buffer.from(cmd), at = raw.indexOf(Buffer.from('TIM0'));
  assert.equal(cmd[at + 8], 6); assert.equal(cmd[at + 9], 0); assert.equal(u32(cmd, at + 4), 16);
  assert.deepEqual(parsed.attributes.BDY0, original);
  assert.equal(toHex(upfDate('20010203040506')), '0007d10203040506');
  assert.throws(() => upfDate('20010230040506'), /Invalid/);
  assert.throws(() => metadataUPF(jpeg, { title: 'a'.repeat(128) }), /long/);
});

test('image fingerprints match the actual read-back despite reordered JPEG tables and changed APP2 bytes', async () => {
  const readback = hx(captures.sessions.find(s => s.id === '5699c272-a7a3-4c73-9966-bdff2eaac3d5').expectedUPFHex);
  assert.notDeepEqual(jpeg, jpegFromUPF(readback));
  assert.equal(await jpegImageFingerprint(jpeg), await jpegImageFingerprint(jpegFromUPF(readback)));
  const altered = jpeg.slice(); altered[altered.length - 5] ^= 1;
  assert.notEqual(await jpegImageFingerprint(jpeg), await jpegImageFingerprint(altered));
});

test('Stop and Abort use distinct standard PDUs; Abort has a 28-byte header and no bFTP attributes', () => {
  assert.equal(toHex(cancellationPDU('stp', {})), '0020030410c20000');
  assert.equal(toHex(cancellationPDU('abt', { id: 3, destination, source })),
    '0020032010c1001c58c00000001608007403000000000800740100000000000800080003');
});

test('metadata read-back only compares fields after identifying the exact image and keeps reference bytes in ZIP', async () => {
  const sent = metadataUPF(jpeg, { title: 'TEST TITLE' });
  const ref = { kind: 'irtranp-reference-file', filename: 'IR000006.UPF', dataHex: toHex(sent) };
  const attempt = { id: 'read', kind: 'irtranp', status: 'received', test: 'receiver',
    feature: { caseID: 'upf-title', role: 'read', referenceUploadConfirmed: true } };
  const report = await analyseAttempt(attempt, [ref, { kind: 'irtranp-file', filename: 'QW000000.UPF', dataHex: toHex(original) }]);
  assert.equal(report.featureEvidence.imageMatches, true);
  assert.equal(report.featureEvidence.metadata.title.matches, false);
  assert.equal(report.featureEvidence.outcome, 'image-matches-metadata-differs');
  const other = original.slice(); other[other.length - 5] ^= 1;
  const wrong = await analyseAttempt(attempt, [ref, { kind: 'irtranp-file', filename: 'QW000000.UPF', dataHex: toHex(other) }]);
  assert.equal(wrong.featureEvidence.outcome, 'wrong-or-changed-image');
  assert.equal(wrong.featureEvidence.canInterpretMetadata, false);
  assert.equal(wrong.featureEvidence.metadata, null);
  const files = new Map(attemptFiles(attempt, [ref]).map(f => [f.name, f.data]));
  assert.deepEqual(files.get('reference-input/000-IR000006.UPF'), sent);
});

test('unknown or malformed metadata does not mark the intact JPEG as corrupt', async () => {
  const body = metadataUPF(jpeg, { title: 'TITLE' }); body[61] = 1;
  const report = await analyseAttempt({ id: 'bad-meta', kind: 'irtranp', test: 'receiver', status: 'received' },
    [{ kind: 'irtranp-file', filename: 'QW000000.UPF', dataHex: toHex(body) }]);
  assert.equal(report.files[0].previewError, null); assert.equal(report.files[0].width, 176);
  assert.match(report.files[0].metadataError, /metadata/);
});

test('new feature series retain manual write/read direction and reject a mismatched case', () => {
  const suite = createSuite('metadata'); assert.equal(suite.steps.length, 18);
  for (let n = 0; n < suite.steps.length; n += 2) {
    const write = suite.steps[n], read = suite.steps[n + 1];
    assert.equal(write.test, 'sender'); assert.equal(write.watchMode, 'others-receive');
    assert.equal(read.test, 'receiver'); assert.equal(read.watchMode, 'others-send');
    assert.equal(read.feature.sourceStepID, write.id); assert.equal(write.maxBaud, 9600);
  }
  assert.throws(() => bindAttempt(suite, { ...currentStep(suite), id: 'bad', feature: { caseID: 'upf-author', role: 'write' } }), /Feature/);
  assert.throws(() => advanceSuite(suite, []), /Run the step/);
  assert.equal(createSuite('operations').steps.length, 11);
});
