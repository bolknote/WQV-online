// Isolated smoke test of the shipped template/module. No browser, USB or
// user IndexedDB is accessed; this does not replace visual browser review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SWAN_LISTEN_PLAN } from '../dist/swan-listen-core.mjs';
import { SWAN_SYNC_PLAN, SWAN_REPLAYS, canReplayNow } from '../dist/swan-sync-core.mjs';
import { SWAN_PHYSICAL_PLAN, physicalSettings } from '../dist/swan-physical-core.mjs';
import { SWAN_AUTOTUNE_PLAN, AUTOTUNE_PROFILES } from '../dist/swan-autotune-core.mjs';
import { SWAN_PEER_PLAN, SWAN_PEER_VARIANT_PLAN, PEER_CADENCE } from '../dist/swan-peer-core.mjs';

const html = readFileSync(new URL('../dist/swan-listen.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../dist/swan-listen.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
class Element {
  children = []; dataset = {}; value = ''; textContent = ''; disabled = false; hidden = false;
  classList = { toggle() {} };
  constructor(attributes = '') {
    this.hidden = /\bhidden\b/.test(attributes);
    this.id = attributes.match(/\bid="([^"]*)"/)?.[1];
    this.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? '';
    const key = attributes.match(/\bdata-text="([^"]*)"/)?.[1];
    if (key) this.dataset.text = key;
  }
  get options() { return this.children; }
  setAttribute(key, value) { this[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) { return this.children.find(c => c.value === selector.match(/value="([^"]*)"/)?.[1]); }
}
async function load(search) {
  const nodes = new Map(), texts = [];
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const node = new Element(match[2]);
    if (node.id) nodes.set(node.id, node);
    if (node.dataset.text) texts.push(node);
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    nodes.get(match[1]).children = [...match[2].matchAll(/<option\b([^>]*)>/g)].map(m => new Element(m[1]));
  }
  const captions = new Map(), document = { documentElement: {},
    getElementById(id) { assert.ok(nodes.has(id), `Missing template element: ${id}`); return nodes.get(id); },
    createElement: () => new Element(), querySelectorAll: () => texts,
    querySelector(selector) { if (!captions.has(selector)) captions.set(selector, new Element()); return captions.get(selector); },
  };
  let language = 'en';
  const context = vm.createContext({ document, location: { search }, navigator: { usb: {} },
    window: { addEventListener() {} }, URLSearchParams, setInterval() {},
    getLanguage: () => language, setLanguage: value => { language = value; },
    openResearchStore: async () => ({ attempts: async () => [], save: async () => {} }),
    SWAN_LISTEN_PLAN, SWAN_SYNC_PLAN, SWAN_REPLAYS, SWAN_PHYSICAL_PLAN,
    SWAN_AUTOTUNE_PLAN, AUTOTUNE_PROFILES, physicalSettings, canReplayNow,
    SWAN_PEER_PLAN, SWAN_PEER_VARIANT_PLAN, PEER_CADENCE,
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, document };
}

test('automatic UI loads, switches groups and translates without accessing USB', async () => {
  const { nodes, document } = await load('?experiment=auto');
  assert.equal(document.title, 'WQV Link · SWAN automatic receiver');
  assert.equal(nodes.get('auto-settings').hidden, false);
  assert.equal(nodes.get('physical-settings').hidden, true);
  assert.equal(nodes.get('replay-settings').hidden, true);
  assert.equal(nodes.get('signal-controls').hidden, true);
  assert.equal(nodes.get('plan').children.length, 2);
  assert.equal(nodes.get('auto-rows').children.length, 7);
  assert.equal(nodes.get('start').disabled, true);
  assert.equal(nodes.get('prepare').disabled, false);
  assert.match(nodes.get('step-note').textContent, /seven clock divisors/);
  nodes.get('plan').children[1].children[0].onclick();
  assert.match(nodes.get('step-note').textContent, /seven legal RX thresholds/);
  nodes.get('language').value = 'ru'; nodes.get('language').onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('start').textContent, 'Начать автоподбор');
  assert.match(nodes.get('step-note').textContent, /семь допустимых порогов/);
});

test('manual physical and signal pages still load their original plans and expose the auto link', async () => {
  for (const [query, count] of [['?experiment=physical', 9], ['?experiment=sync', 5], ['', 6]]) {
    const { nodes } = await load(query);
    assert.equal(nodes.get('plan').children.length, count);
    assert.equal(nodes.get('auto-settings').hidden, true);
    assert.equal(nodes.get('auto-link').hidden, false);
    assert.equal(nodes.get('prepare').disabled, false);
  }
});

test('peer UI offers two RECEIVE pulse widths and gates its series on the RECEIVE mark', async () => {
  const { nodes, document } = await load('?experiment=peer');
  assert.equal(document.title, 'WQV Link · SWAN RECEIVE greeting');
  assert.equal(nodes.get('plan').children.length, 2);
  assert.equal(nodes.get('peer-settings').hidden, false);
  assert.equal(nodes.get('physical-settings').hidden, false);
  assert.equal(nodes.get('auto-settings').hidden, true);
  assert.equal(nodes.get('replay-settings').hidden, true);
  assert.equal(nodes.get('signal-controls').hidden, true);
  assert.equal(nodes.get('start').textContent, 'Record; wait for RECEIVE mark');
  assert.equal(nodes.get('mark').textContent, 'Mark RECEIVE and start 22 repeats');
  assert.match(nodes.get('physical-setting-summary').textContent, /SWAN RECEIVE.*RX 8.*22 × 7A 06 F0/);
  assert.match(nodes.get('peer-progress').textContent, /Waiting for recording and the RECEIVE mark/);
  assert.equal(nodes.get('start').disabled, true);
  assert.equal(nodes.get('prepare').disabled, false);
  nodes.get('plan').children[1].children[0].onclick();
  assert.match(nodes.get('physical-setting-summary').textContent, /19\.53/);
  nodes.get('language').value = 'ru'; nodes.get('language').onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('mark').textContent, 'Отметить RECEIVE и запустить 22 повтора');
  assert.match(nodes.get('step-note').textContent, /включите приём последним нажатием/);
  assert.match(nodes.get('activation-note').textContent, /Начало записи ничего не отправляет/);
});

test('variant UI keeps five separate experiments with explicit reversal and inversion meanings, in English and Russian', async () => {
  const { nodes, document } = await load('?experiment=variants');
  assert.equal(document.title, 'WQV Link · SWAN byte / bit / random');
  assert.equal(nodes.get('plan').children.length, 5);
  assert.equal(nodes.get('peer-link').hidden, false);
  assert.equal(nodes.get('variants-link').hidden, true);
  assert.equal(nodes.get('peer-payload-details').hidden, false);
  assert.equal(nodes.get('mark').textContent, 'Mark RECEIVE and start 22 transmissions');
  assert.equal(nodes.get('peer-payload-description').textContent, '7A 06 F0 → F0 06 7A');
  assert.match(nodes.get('physical-setting-summary').textContent, /TX 1.6.*RX 8.*F0 06 7A/);
  nodes.get('plan').children[1].children[0].onclick();
  assert.match(nodes.get('peer-payload-description').textContent, /within each byte.*5E 60 0F/);
  nodes.get('plan').children[2].children[0].onclick();
  assert.match(nodes.get('peer-payload-description').textContent, /three new random bytes.*0–255/);
  assert.match(nodes.get('peer-payload-preview').textContent, /will be saved when you prepare USB/);
  assert.equal(nodes.get('start').disabled, true);
  nodes.get('language').value = 'ru'; nodes.get('language').onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get('mark').textContent, 'Отметить RECEIVE и запустить 22 посылки');
  assert.match(nodes.get('peer-payload-description').textContent, /трёх|три новых случайных байта/);
  assert.match(nodes.get('peer-description').textContent, /22 посылки по три байта/);
  nodes.get('plan').children[3].children[0].onclick();
  assert.match(nodes.get('peer-payload-description').textContent, /F0 06 7A → 0F F9 85/);
  assert.match(nodes.get('peer-payload-description').textContent, /Инвертируем каждый бит данных/);
  nodes.get('plan').children[4].children[0].onclick();
  assert.match(nodes.get('physical-setting-summary').textContent, /22 × A1 9F F0/);
  assert.match(nodes.get('peer-payload-description').textContent, /5E 60 0F → A1 9F F0/);
  nodes.get('language').value = 'en'; nodes.get('language').onchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(nodes.get('peer-payload-description').textContent, /Flip each payload bit.*XOR FF per byte/);
});
