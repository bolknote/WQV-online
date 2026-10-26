import test from 'node:test';
import assert from 'node:assert/strict';
import { IrTranPSuiteUI } from '../dist/irtranp-suite-ui.mjs';
import { createSuite } from '../dist/irtranp-suite.mjs';

// Exercise the actual selection handlers with an isolated local store. No USB,
// browser profile or real research journal is opened by these tests.
async function setup(t, savedSuites, currentID) {
  const nodes = new Map(), storage = new Map([['wqv-irtranp-current-suite', currentID]]);
  const previous = Object.fromEntries(['document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const element = () => ({ value: '', dataset: {}, classList: { add() {} }, append() {}, setAttribute() {},
    replaceChildren(...children) { this.children = children; } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else Object.defineProperty(globalThis, key, value);
    }
  });
  const saved = new Map(savedSuites.map(suite => [suite.id, structuredClone(suite)])), settings = [], errors = [];
  let blocked = false;
  const store = { attempts: async () => [...saved.values()].map(value => structuredClone(value)),
    save: async suite => { saved.set(suite.id, structuredClone(suite)); } };
  const ui = new IrTranPSuiteUI({ t: text => text, getAttempts: () => [], getEvents: async () => [],
    blocked: () => blocked, applySettings: step => settings.push(structuredClone(step)), render() {},
    status: (...message) => errors.push(message), download() {}, showFiles() {} });
  await ui.initialize(store);
  const choose = async (id, value) => { nodes.get(id).value = value; await nodes.get(id).onchange(); };
  return { ui, saved, settings, errors, nodes, choose, storage, setBlocked: value => { blocked = value; } };
}

test('choosing a plan switches the active series without the New series button and preserves prior work', async t => {
  const original = createSuite('operations', { id: 'old-operations' });
  original.steps[0].attemptIDs.push('saved-two-file-attempt');
  const context = await setup(t, [original], original.id);
  const { ui, nodes, choose, saved, settings, storage } = context;
  assert.equal(nodes.get('suite-plan').value, 'operations');
  await choose('suite-plan', 'single-controls');
  const controls = ui.selected;
  assert.equal(controls.planID, 'single-controls');
  assert.equal(controls.steps.length, 4);
  assert.equal(ui.step().feature.caseID, 'single-10');
  assert.equal(settings.at(-1).copyCount, 1);
  assert.equal(nodes.get('suite-select').value, controls.id);
  assert.equal(storage.get('wqv-irtranp-current-suite'), controls.id);
  assert.equal(saved.size, 2);
  await choose('suite-plan', 'operations');
  assert.equal(ui.selected.id, original.id);
  assert.deepEqual(ui.step().attemptIDs, ['saved-two-file-attempt']);
  await choose('suite-plan', 'single-controls');
  assert.equal(ui.selected.id, controls.id);
  assert.equal(saved.size, 2, 'switching back resumes the existing unfinished series');
  await choose('suite-select', original.id);
  assert.equal(nodes.get('suite-plan').value, 'operations', 'selecting a saved series updates the plan too');
  context.setBlocked(true);
  await choose('suite-plan', 'single-controls');
  assert.equal(ui.selected.id, original.id, 'a blocked UI cannot change the active step');
  assert.deepEqual([...saved.values()].flatMap(suite => suite.steps.flatMap(step => step.attemptIDs)), ['saved-two-file-attempt']);
});

test('reloading restores the active plan and a failed new-series save restores the picker', async t => {
  const controls = createSuite('single-controls', { id: 'resumed-controls' });
  controls.cursor = 2;
  const { ui, nodes, choose, errors } = await setup(t, [controls], controls.id);
  assert.equal(nodes.get('suite-plan').value, 'single-controls');
  assert.equal(ui.step().feature.caseID, 'single-11');
  ui.store.save = async () => { throw new Error('Local store unavailable'); };
  await choose('suite-plan', 'operations');
  assert.equal(ui.selected.id, controls.id);
  assert.equal(nodes.get('suite-plan').value, 'single-controls');
  assert.equal(nodes.get('suite-select').value, controls.id);
  assert.match(errors.at(-1)[0], /Local store unavailable/);
});

test('choosing the CE 2.11 plan applies the new two-file transport instead of the previous series', async t => {
  const previous = createSuite('multiple-csi', { id: 'previous-csi' });
  const { ui, choose, nodes, settings } = await setup(t, [previous], previous.id);
  await choose('suite-plan', 'multiple-wince211');
  assert.equal(ui.selected.planID, 'multiple-wince211');
  assert.equal(ui.step().feature.caseID, 'multiple-wince211');
  assert.equal(settings.at(-1).transportProfile, 'wince211');
  assert.equal(settings.at(-1).copyCount, 2); assert.equal(settings.at(-1).maxBaud, 9600);
  assert.equal(nodes.get('suite-plan').value, 'multiple-wince211');
});
