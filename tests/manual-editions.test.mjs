import test from 'node:test';
import assert from 'node:assert/strict';
import {manualLanguage, manualLabel, manualSourceURL} from '../dist/manual-editions.mjs';

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

test('Spanish and Finnish select only the available originals, with English labels for the other models', () => {
  for (const [language, translated] of [['es',['wqv2','wqv3']],['fi',['wqv3']]]) {
    for (const model of ['wqv2','wqv3','wqv10']) {
      const available = translated.includes(model);
      assert.equal(manualLanguage(model, language), available ? language : 'en');
      assert.equal(manualLabel(model, language), available ? null : 'User’s Guide');
      const source = manualSourceURL(model, language);
      assert.match(source, available ? language === 'es'
        ? model === 'wqv3' ? /baroli\.es\/wp-content\/uploads\/2015\/12\/2411\.pdf$/ : /baroli\.es\/manuales\/2220\.pdf$/
        : /perkko\.fi.*Casio-2411\.pdf$/ : /_EN\.pdf$/);
    }
  }
  assert.equal(manualLanguage('toString','fi'),'en');
});
