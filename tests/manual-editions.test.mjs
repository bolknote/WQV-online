import test from 'node:test';
import assert from 'node:assert/strict';
import {manualLanguage, manualLabel} from '../dist/manual-editions.mjs';

test('German uses actual German WQV-2/10 editions while WQV-3 keeps its English document and label', () => {
  for (const model of ['wqv2','wqv10']) {
    assert.equal(manualLanguage(model,'de'),'de');
    assert.equal(manualLabel(model,'de'),null);
  }
  assert.equal(manualLanguage('wqv3','de'),'en');
  assert.equal(manualLabel('wqv3','de'),'User’s Guide');
  for (const model of ['wqv2','wqv3','wqv10']) for (const language of ['en','ru','ja']) {
    assert.equal(manualLanguage(model,language),language);
    assert.equal(manualLabel(model,language),null);
  }
});
