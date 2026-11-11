import { tr, quantity, locale, getLanguage } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';
import { driverStore } from './driver-store.mjs';
import { DRIVER_PROFILES, DRIVER_ABI, chooseInstalledDriver, usbID, usbMatchLabels, sourceDigest } from './driver-catalog.mjs';
import { compileDriver, referenceDriver } from './driver-compiler.mjs';
import { checkInstalledDriver } from './driver-usb.mjs';
import { driverLogMessage } from './driver-log.mjs';
import { readDriverAccess } from './driver-access.mjs';
import { ensureUSBHelperReady } from './usb-helper-help.mjs';

const $ = id => document.getElementById(id), say = key => String(tr(key));
const S = { records: [], selected: null, view: 'drivers', active: null, checkMethod: null, preparingHelper: false, device: null, report: null, reportKey: null, log: [], lastStatus: null };
const checkKey = record => record ? JSON.stringify([record.id, record.inputSHA256, record.updatedAt]) : null;
const selected = () => S.records.find(record => record.id === S.selected);
function status(state, heading, note = '') {
  S.lastStatus = { state, heading, note };
  $('driver-operation').dataset.state = state;
  $('driver-status').textContent = String(heading); $('driver-status-note').textContent = String(note);
}
function log(entry) {
  S.log.push({ at: new Date().toISOString(), ...entry });
  if (S.log.length > 300) S.log.shift();
  renderLog();
}
function renderLog() {
  const journal = $('driver-log'); journal.replaceChildren();
  for (const entry of S.log) {
    const message = driverLogMessage(entry); if (!message) continue;
    const line = document.createElement('li'), time = document.createElement('time'), text = document.createElement('span');
    time.dateTime = entry.at; time.textContent = new Date(entry.at).toLocaleTimeString(locale(), { hour12: false });
    text.textContent = String(tr(message.key, ...message.values)); line.append(time, text); journal.append(line);
  }
}
function showTab(view) {
  S.view = view;
  $('driver-library').hidden = view !== 'drivers'; $('library-tools').hidden = view !== 'drivers';
  $('driver-check').hidden = view !== 'check'; $('check-tools').hidden = view !== 'check';
  $('tab-drivers').setAttribute('aria-selected', String(view === 'drivers'));
  $('tab-check').setAttribute('aria-selected', String(view === 'check'));
}
function render() {
  const match = S.device && chooseInstalledDriver(S.records, S.device);
  if (S.report && S.reportKey !== checkKey(match?.record)) {
    S.report = null; S.reportKey = null; $('diagnostic-date').textContent = '';
  }
  const record = selected();
  document.title = say('Infrared drivers') + ' · CASSIOPEIA';
  $('driver-count').textContent = String(quantity(S.records.length, 'drivers'));
  const rows = $('driver-rows'); rows.replaceChildren();
  for (const item of S.records) {
    const row = document.createElement('tr'); row.classList.toggle('selected', item.id === S.selected);
    const cell = row.insertCell(), button = document.createElement('button'); button.className = 'driver-select'; button.type = 'button';
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    icon.classList.add('icon'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('viewBox', '0 0 16 16');
    use.setAttribute('href', './icons.svg#chip'); use.setAttribute('width', '16'); use.setAttribute('height', '16'); icon.append(use);
    button.append(icon, document.createTextNode(item.name)); button.setAttribute('aria-pressed', String(item.id === S.selected));
    button.dataset.driverId = item.id;
    button.disabled = Boolean(S.active); button.addEventListener('click', () => {
      S.selected = item.id; render();
      [...rows.querySelectorAll('button')].find(button => button.dataset.driverId === item.id)?.focus({ preventScroll: true });
    }); cell.append(button);
    row.insertCell().textContent = item.filename;
    const state = row.insertCell(); state.className = 'driver-state';
    state.dataset.build = item.artifact ? 'built' : item.buildError ? 'error' : 'saved';
    state.textContent = say(item.artifact ? 'Built' : item.buildError ? 'Build failed' : 'Saved'); rows.append(row);
  }
  $('driver-selected').hidden = !record;
  $('driver-name').textContent = record?.name ?? '';
  $('driver-source-info').textContent = record ? record.filename + ' · ' + say(record.artifact ? 'Built' : 'Saved') : '';
  $('driver-details').hidden = !record;
  const props = $('driver-properties'); props.replaceChildren();
  if (record) {
    const add = (key, value) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = say(key); dd.textContent = value; props.append(dt, dd); };
    add('Source file', record.filename); add('Source', record.provenance ? 'Linux ' + record.provenance.version : '—');
    add('USB matches', record.artifact?.usbMatches.map(match => match.vendorId ? usbID(match) : 'USB class ' + match.interfaceClass.toString(16) + ':' + match.interfaceSubclass).join(', ') ?? '—');
    add('Compiled size', record.artifact ? record.artifact.bytes.byteLength.toLocaleString(locale()) + ' B' : '—');
    add('SHA-256', record.sha256);
    if (Object.keys(record.files).length) add('Source file', Object.keys(record.files).join('\n'));
    if (record.buildError) add('Build failed', record.buildError);
  }
  for (const button of document.querySelectorAll('[data-driver-action]')) {
    const action = button.dataset.driverAction;
    button.disabled = action === 'stop' ? !S.active : Boolean(S.active) || ['build', 'remove', 'export-source'].includes(action) && !record;
    if (action === 'check' && !S.device) button.disabled = true;
  }
  $('check-method').disabled = Boolean(S.active);
  $('check-stop').hidden = !S.active; $('check-progress').hidden = !S.active || S.view !== 'check';
  $('save-report').disabled = !S.report || Boolean(S.active);
  if (!S.lastStatus) {
    $('driver-status').textContent = say(S.records.length ? 'Drivers are selected automatically by WQV Link.' : 'No drivers installed');
    $('driver-status-note').textContent = S.records.length ? '' : say('Choose Add… to install a driver.');
  }
  renderLog();
  renderCheck();
}
function renderCheck() {
  const device = S.device, matched = device ? chooseInstalledDriver(S.records, device) : null;
  $('check-device').textContent = device?.productName || device?.manufacturerName || say('No USB device selected');
  $('check-usb-id').textContent = device ? usbID(device) : '—';
  const builtin = device && knownModel(device);
  $('check-model').textContent = builtin ? builtin + ' · ' + say('Known adapter') : say('Unknown model');
  $('check-driver').textContent = matched ? matched.record.filename + (matched.match.exact ? '' : ' · ' + say('Matched by USB class')) : say('No matching installed driver');
  const labels = { passed: 'USB initialization passed', blocked: 'Blocked by WebUSB', unavailable: 'USB Helper unavailable', failed: 'USB check failed', untested: 'Not tested', cancelled: 'Operation cancelled' };
  for (const method of ['direct', 'helper']) {
    const result = S.report?.[method]; const target = $('check-' + method + '-result');
    const running = S.checkMethod === 'auto' || S.checkMethod === method;
    target.dataset.state = running ? 'running' : result?.status ?? 'untested'; target.textContent = say(running ? 'Testing…' : labels[result?.status] || 'Not tested');
  }
  const preferred = matched ? readDriverAccess(matched.record, device) : 'auto';
  $('remembered-access').textContent = say(preferred === 'helper' ? 'Through USB Helper' : preferred === 'direct' ? 'Without helper · WebUSB' : 'Not tested');
  if (S.preparingHelper) $('check-heading').textContent = say('Checking USB Helper…');
  else if (S.active && S.view === 'check') $('check-heading').textContent = say('Testing…');
  else if (!device) $('check-heading').textContent = say('Choose an adapter to test its driver.');
  else if (!matched) $('check-heading').textContent = say('No matching installed driver');
  else if (S.report) {
    const last = S.report.helper && S.report.helper.status !== 'untested' ? S.report.helper : S.report.direct;
    $('check-heading').textContent = say(labels[last?.status] || 'Not tested');
  } else $('check-heading').textContent = say('Not tested');
  const errors = [S.report?.direct, S.report?.helper].flatMap(result => [result?.message, result?.cleanupError]).filter(Boolean);
  $('check-note').textContent = errors.join('\n') || say('This check initializes USB without sending an infrared frame.');
}
function knownModel(device) {
  const known = { '066f:4200': 'SigmaTel STIr4200', '07d0:4959': 'KingSun KS-959', '07d0:4100': 'KingSun Dazzle', '07c0:4200': 'KingSun / DonShine', '9710:7780': 'MosChip MCS7780', '18ec:3118': 'ARK3116T', '0df7:0620': 'Mobile Action MA-620', '067b:2303': 'Prolific PL2303' };
  return known[usbID(device)] ?? null;
}
async function reload() {
  S.records = await driverStore.list();
  if (!selected()) S.selected = S.records[0]?.id ?? null;
  render();
}
async function run(task) {
  if (S.active) return;
  const controller = new AbortController(); S.active = controller; render();
  try { await task(controller.signal); }
  catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') status('idle', tr('Operation cancelled'));
    else if (error.name === 'NotFoundError') status('idle', tr('No USB device selected'));
    else { status('error', tr('Operation did not finish'), error.message); log({ kind: 'error', message: error.message }); }
  } finally {
    if ($('driver-build-dialog').open) $('driver-build-dialog').close();
    if (S.active === controller) S.active = null; render();
  }
}
async function build(record, signal) {
  signal.throwIfAborted();
  $('build-filename').textContent = record.filename; $('build-stage').textContent = say('Loading compiler…');
  $('driver-build-dialog').showModal(); status('working', tr('Preparing driver'), record.filename);
  try {
    const artifact = await compileDriver(record, { signal, progress: stage => { $('build-stage').textContent = say(stage === 'compiler' ? 'Loading compiler…' : 'Compiling driver…'); } });
    signal.throwIfAborted();
    if (artifact.abi !== DRIVER_ABI || artifact.sourceSHA256 !== await sourceDigest(record.source)) throw new Error('Compiled source checksum mismatch.');
    $('build-stage').textContent = say('Save compiled driver');
    if (!await driverStore.saveBuild(record.id, record.sha256, artifact)) throw new Error('The source was removed or changed during compilation.');
    log({ kind: 'driver-built', filename: record.filename, sourceSHA256: record.sha256, compileMs: artifact.compileMs, bytes: artifact.bytes.byteLength });
    status('success', tr('Driver installed'), tr('Drivers are selected automatically by WQV Link.'));
  } catch (error) {
    if (signal.aborted) status('idle', tr('Build cancelled. The source is still saved.'));
    else { await driverStore.saveBuild(record.id, record.sha256, null, error.message, record.inputSHA256); status('error', tr('Source saved; build did not finish'), error.message); }
    log({ kind: signal.aborted ? 'build-cancelled' : 'build-error', filename: record.filename, message: error.message });
  } finally { if ($('driver-build-dialog').open) $('driver-build-dialog').close(); await reload(); }
}
async function importFiles(files, signal) {
  const sources = files.filter(file => /\.c$/i.test(file.name)), headers = files.filter(file => /\.h$/i.test(file.name));
  const extra = {};
  if (sources.some(file => file.size > 512 * 1024) || headers.reduce((bytes, file) => bytes + file.size, 0) > 2 * 1024 * 1024) throw new Error('Driver source exceeds the file size limit.');
  for (const header of headers) extra[header.webkitRelativePath || header.name] = await header.text();
  if (!sources.length) {
    const record = selected();
    if (!record || !headers.length) throw new Error(say('Choose a C source file first.'));
    const saved = await driverStore.saveSource({ ...record, files: { ...record.files, ...extra } });
    await reload(); await build(saved, signal); return;
  }
  for (const source of sources) {
    signal.throwIfAborted();
    const saved = await driverStore.saveSource({ filename: source.name, source: await source.text(), files: extra });
    S.selected = saved.id; await reload(); await build(saved, signal);
  }
}
async function check(method, signal) {
  const match = chooseInstalledDriver(S.records, S.device);
  if (!match) { status('error', tr('No matching installed driver')); return; }
  S.log = []; status('working', tr('Testing…'), match.record.filename);
  S.report = null; $('diagnostic-date').textContent = '';
  S.reportKey = checkKey(match.record);
  S.checkMethod = method; renderCheck();
  let report;
  try { report = await checkInstalledDriver(match.record, match.match, S.device, { method, signal, waitForHelper: ensureUSBHelperReady, recordEvent: entry => log(entry) }); }
  finally { S.checkMethod = null; }
  S.report = { ...report, at: new Date().toISOString() };
  $('diagnostic-date').textContent = new Date().toLocaleTimeString(locale());
  const passed = report.direct.status === 'passed' || report.helper.status === 'passed';
  const cleanupFailed = report.direct.cleanupError || report.helper.cleanupError;
  if (report.cancelled && !cleanupFailed) status('idle', tr('Operation cancelled'));
  else status(passed ? 'success' : 'error', tr(passed ? 'USB initialization passed' : 'USB check failed'));
}
function download(filename, blob) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-driver-action]'); if (!button || button.disabled) return;
  const action = button.dataset.driverAction;
  if (action === 'stop') { S.active?.abort(); return; }
  if (action === 'import') { $('driver-files').click(); return; }
  if (action === 'reference') { $('reference-dialog').showModal(); return; }
  if (action === 'cancel-reference') { $('reference-dialog').close(); return; }
  if (action === 'add-reference') {
    const id = $('reference-source').value; $('reference-dialog').close();
    run(async signal => { const source = await referenceDriver(id); signal.throwIfAborted(); const record = await driverStore.saveSource(source); S.selected = record.id; await reload(); await build(record, signal); }); return;
  }
  if (action === 'build' && selected()) { run(signal => build(selected(), signal)); return; }
  if (action === 'remove' && selected()) {
    run(async signal => {
      const record = selected();
      if (!await messageDialog(tr('Remove'), tr('Remove this driver and its saved source?'), { confirm: true, accept: tr('Remove') })) return;
      signal.throwIfAborted(); await driverStore.remove(record.id); await reload(); status('success', tr('Driver removed'));
    }); return;
  }
  if (action === 'choose') {
    run(async signal => {
      if (!navigator.usb) throw new Error('WebUSB is unavailable. Open WQV Link in Chromium.');
      const device = await navigator.usb.requestDevice({ filters: [] }); signal.throwIfAborted();
      S.device = device; S.report = null; S.log = []; log({ kind: 'device-selected', usbId: usbID(device), name: device.productName }); render();
    }); return;
  }
  if (action === 'check') { const method = $('check-method').value; run(signal => check(method, signal)); return; }
  if (action === 'export-source' && selected()) download(selected().filename.split('/').at(-1), new Blob([selected().source], { type: 'text/x-c;charset=utf-8' }));
  if (action === 'export-report' && S.report) download('WQV-driver-check-' + new Date().toISOString().replaceAll(':', '-') + '.json', new Blob([JSON.stringify({ ...S.report, log: S.log, language: getLanguage() }, null, 2)], { type: 'application/json' }));
});
$('driver-files').addEventListener('change', () => { const files = [...$('driver-files').files]; $('driver-files').value = ''; if (files.length) run(signal => importFiles(files, signal)); });
$('driver-build-dialog').addEventListener('cancel', event => { event.preventDefault(); S.active?.abort(); });
let selectedCheckMethod = $('check-method').value;
function prepareHelper(previous) {
  if (S.active) return;
  selectedCheckMethod = $('check-method').value;
  S.preparingHelper = true;
  run(async signal => {
    try { await ensureUSBHelperReady({ signal, connecting: false }); }
    catch (error) {
      selectedCheckMethod = previous; $('check-method').value = previous; throw error;
    } finally { S.preparingHelper = false; }
  });
}
$('check-method').addEventListener('change', () => {
  if (S.active) return;
  const previous = selectedCheckMethod;
  selectedCheckMethod = $('check-method').value; renderCheck();
  if (selectedCheckMethod === 'helper') prepareHelper(previous);
});
for (const [id, tab] of [['tab-drivers', 'drivers'], ['tab-check', 'check']]) $(id).addEventListener('click', () => {
  if (S.active) return;
  showTab(tab); render();
  if (tab === 'check' && $('check-method').value === 'helper') prepareHelper('helper');
});
$('driver-library').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
$('driver-library').addEventListener('drop', event => { event.preventDefault(); if (!S.active) run(signal => importFiles([...event.dataTransfer.files], signal)); });
const referenceLabels = new Map();
for (const profile of DRIVER_PROFILES) { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name + ' · ' + profile.file; $('reference-source').append(option); }
function showReferenceIDs() {
  const labels = referenceLabels.get($('reference-source').value) ?? [];
  $('reference-usb-ids').textContent = labels.join(', '); $('reference-usb-ids').hidden = labels.length <= 3;
}
$('reference-source').addEventListener('change', showReferenceIDs);
fetch(new URL('./driver-runtime/corpus/sources.json', import.meta.url)).then(response => {
  if (!response.ok) throw new Error('Source catalogue HTTP ' + response.status); return response.json();
}).then(manifest => {
  for (const option of $('reference-source').options) {
    const profile = DRIVER_PROFILES.find(profile => profile.id === option.value);
    const labels = usbMatchLabels(manifest.files[profile.id].usbMatches ?? []); referenceLabels.set(profile.id, labels);
    const short = labels.slice(0, 3).join(', ') + (labels.length > 3 ? ' (+' + (labels.length - 3) + ')' : '');
    option.textContent = [profile.name, short, profile.file].filter(Boolean).join(' · '); option.title = labels.join(', ');
  }
  showReferenceIDs();
}).catch(error => console.error('Reference USB IDs:', error));
installDesktopShell({ changed: () => { render(); if (S.lastStatus) status(S.lastStatus.state, S.lastStatus.heading, S.lastStatus.note); },
  help: () => messageDialog(tr('Infrared drivers'), tr('Sources and compiled drivers stay in this browser.') + '\n\n' + tr('Drivers are selected automatically by WQV Link.') + '\n\n' + tr('This check initializes USB without sending an infrared frame.')) });
bindApplicationNavigation({ isBusy: () => Boolean(S.active), close: async () => { S.active?.abort(); } });
navigator.usb?.addEventListener('disconnect', event => { if (event.device === S.device) { S.active?.abort(); S.device = null; render(); status('error', tr('USB adapter unplugged')); } });
window.addEventListener('pagehide', () => S.active?.abort());
showTab('drivers');
reload().catch(error => { status('error', tr('Operation did not finish'), error.message); render(); });
