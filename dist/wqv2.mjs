import { tr, quantity, formatText, formatNumber, locale, translateDOM } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';
import { createWQV2Adapter } from './wqv2-adapter.mjs';
import { describeUSBDevice } from './adapters.mjs';
import { WQV12Client } from './wqv12-core.mjs';
import { wqv12ClockPayload } from './wqv12-clock.mjs';
import { LocalStore } from './images.mjs';
import { wqv2Image, wqv2Filename, wqv2Files } from './wqv2-images.mjs';
import { concat, fromHex } from './formats.mjs';
import { zipFiles } from './zip.mjs';

const $ = id => document.getElementById(id), store = new LocalStore({ name: 'casio-wqv2-webusb' });
const empty = $('gallery').firstElementChild.cloneNode(true);
const supported = Boolean(navigator.usb && isSecureContext);
const MODE_KEY = 'wqv-online.wqv2.mode';
let initialMode = 'pc'; try { if (localStorage.getItem(MODE_KEY) === 'others') initialMode = 'others'; } catch {}
const S = { device: null, adapter: null, active: null, client: null, latest: null, pending: null,
  mode: initialMode, tab: 'photos', clockSnapshot: null,
  images: [], selected: null, urls: new Map(), log: [], capture: null, storageFailed: false,
  status: ['idle', tr('Ready'), tr('Connect a USB adapter to communicate with the watch.'), null] };
let refreshTimer, startReading;
const now = () => new Date().toISOString();
const selected = () => S.images.find(image => image.id === S.selected);
const label = image => image.title || tr('Photo {0}', String(S.images.indexOf(image) + 1).padStart(2, '0'));
const navigation = bindApplicationNavigation({ isBusy: () => Boolean(S.active), close: async () => {
  try { await S.adapter?.close(); } catch (error) { log('error', error.message); }
  S.adapter = null;
} });

function log(level, message) {
  S.log.push({ at: now(), level, message }); if (S.log.length > 500) S.log.shift(); refreshSoon();
}
function status(state, heading, detail = '', ratio = null) {
  S.status = [state, heading, detail, ratio]; refreshSoon();
}
function refreshSoon() { if (!refreshTimer) refreshTimer = setTimeout(render, 50); }
function capture(mode) {
  S.capture = { format: 'wqv2-webusb-v1', startedAt: now(), mode,
    device: S.device ? describeUSBDevice(S.device) : null, settings: null, events: [],
    raw: { 'usb-rx': [], 'usb-tx-attempt': [], 'sir-rx': [], 'sir-tx': [] }, result: null };
}
function record(kind, details = {}) {
  if (S.capture) S.capture.events.push({ ...details, kind, at: now() });
  if (kind === 'wqv12-tx') S.capture?.raw['sir-tx'].push(fromHex(details.wireHex));
  if (kind === 'wqv12-phase') log('info', phaseLabel(details.phase));
  if (kind === 'wqv12-retry') log('info', tr('Repeating request {0}.', details.control.toString(16).padStart(2, '0')));
  if (kind === 'wqv12-rejected-frame') log('error', tr('Received frame rejected: {0}.', details.reason));
  if (kind === 'wqv2-kingsun-sync') log('info', tr('KS-959 receive stream synchronized.'));
  if (kind === 'wqv12-clock') S.clockSnapshot = { hex: details.rawHex, at: now(), beforeUpdate: false };
  if (kind === 'wqv12-phase' && details.phase === 'set-clock' && S.clockSnapshot) S.clockSnapshot.beforeUpdate = true;
  refreshSoon();
}
const phases = { hello: 'Looking for the watch', connect: 'Connecting to the watch', connected: 'Watch connected',
  header: 'Reading photo information', photos: 'Reading photos', finish: 'Finishing transfer', disconnect: 'Closing connection', closed: 'Transfer finished',
  'others-listen': 'Waiting for a photo from the watch', 'others-connect': 'Connecting to the watch',
  'others-header': 'Reading photo information', 'others-photos': 'Reading photos', 'others-finish': 'Finishing transfer',
  'set-clock': 'Setting the watch date and time', 'clock-finish': 'Finishing clock update' };
const phaseLabel = phase => tr(phases[phase] || 'Communicating with the watch');

function render() {
  clearTimeout(refreshTimer); refreshTimer = null;
  const connected = Boolean(S.adapter?.opened), busy = Boolean(S.active), image = selected();
  const info = S.device ? describeUSBDevice(S.device) : null;
  navigation();
  $('connect').disabled = !supported || busy || connected;
  $('disconnect').disabled = !connected || busy;
  for (const id of ['download-current', 'download-all', 'find-watch']) $(id).disabled = !connected || busy;
  for (const id of ['read-clock', 'set-clock']) $(id).disabled = !connected || busy || S.mode !== 'pc';
  for (const id of ['clock-date', 'clock-time', 'fill-clock']) $(id).disabled = busy;
  $('receive-photo').disabled = !connected || busy;
  document.querySelectorAll('[data-pc-only]').forEach(element => { element.hidden = S.mode !== 'pc'; });
  document.querySelectorAll('[data-others-only]').forEach(element => { element.hidden = S.mode !== 'others'; });
  document.querySelectorAll('[data-mode]').forEach(button => {
    button.disabled = busy; button.setAttribute('aria-pressed', String(button.dataset.mode === S.mode));
  });
  $('mode-description').textContent = S.mode === 'pc' ? tr('120 × 120 · 16 shades of gray') : tr('One photo per connection');
  $('mode-badge').textContent = 'WQV-2 · ' + S.mode.toUpperCase();
  $('watch-mode-value').textContent = S.mode.toUpperCase() + ' · 115200 bit/s';
  for (const id of ['import-images', 'menu-import']) $(id).disabled = busy;
  $('delete-local-image').disabled = busy || !image; $('save-image').disabled = !image;
  for (const id of ['export-all', 'menu-export']) $(id).disabled = !S.images.length;
  $('adapter-label').textContent = info?.label || 'USB IrDA';
  $('connection-badge').textContent = connected ? tr('USB connected') : tr('USB not connected');
  $('connection-badge').classList.toggle('connected', connected); $('power-led').classList.toggle('on', connected);
  $('power-led').title = connected ? tr('{0} connected', info.label) : tr('USB not connected');
  $('title-connection').textContent = connected ? 'IrDA / USB' : tr('Offline');
  $('device-name').textContent = info?.name || '—'; $('usb-id').textContent = info?.usbId || '—';
  $('adapter-support').textContent = info ? info.driver === 'KingSun KS-959' ? tr('Local USB helper') : info.supported ? 'WebUSB' : tr('Not supported') : '—';
  $('kingsun-help').hidden = info?.driver !== 'KingSun KS-959';
  $('storage-label').textContent = S.storageFailed ? tr('this tab only') : tr('local storage');
  const metrics = S.client?.stats || S.latest || {};
  $('tx-count').textContent = metrics.txFrames ?? 0; $('rx-count').textContent = metrics.rxBytes ?? 0;
  $('retry-count').textContent = metrics.retries ?? 0;
  $('checksum-count').textContent = S.client?.decoder.badChecksum ?? S.latest?.badChecksum ?? 0;
  const clock = S.clockSnapshot;
  const watchTime = clock ? Array.from(fromHex(clock.hex).slice(0, 3), n => String(n).padStart(2, '0')).join(':') : '—';
  $('watch-time').textContent = watchTime; $('clock-watch-time').textContent = watchTime;
  $('clock-read-at').textContent = clock ? tr('Last read: {0}', new Date(clock.at).toLocaleTimeString(locale())) : '—';
  $('clock-snapshot-note').textContent = clock?.beforeUpdate ? tr('This time was read before the clock update. Read again to refresh it.') :
    tr('Read the watch time when a PC connection starts.');
  const [state, heading, detail, ratio] = S.status;
  $('result-heading').textContent = heading; $('result-detail').textContent = detail;
  $('result-heading').closest('.operation-bar').dataset.state = state;
  $('result-icon').textContent = state === 'error' ? '!' : state === 'working' ? '◌' : '●';
  $('progress').hidden = state !== 'working'; $('stop').hidden = !busy;
  if (ratio === null) $('progress').removeAttribute('value'); else $('progress').value = ratio;
  $('log').textContent = S.log.map(e => new Date(e.at).toLocaleTimeString(locale()) + '  ' + formatText(e.message)).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
  if (S.pending) renderTransfer();
}
function imageURL(image) {
  if (!S.urls.has(image.id)) S.urls.set(image.id, URL.createObjectURL(new Blob([image.png], { type: 'image/png' })));
  return S.urls.get(image.id);
}
function renderGallery() {
  $('photo-count').textContent = quantity(S.images.length, 'photos');
  if (!S.images.length) { $('gallery').replaceChildren(empty.cloneNode(true)); translateDOM($('gallery')); }
  else $('gallery').replaceChildren(...S.images.map(image => {
    const button = document.createElement('button'); button.className = 'thumbnail';
    button.setAttribute('aria-pressed', String(image.id === S.selected)); button.setAttribute('aria-label', label(image));
    const picture = document.createElement('img'); picture.src = imageURL(image); picture.alt = ''; picture.width = picture.height = 80;
    const caption = document.createElement('span'); caption.textContent = label(image); button.append(picture, caption);
    button.addEventListener('click', () => { S.selected = image.id; renderGallery(); }); return button;
  }));
  const image = selected(); $('preview').hidden = !image; $('preview-empty').hidden = Boolean(image);
  if (image) { $('preview').src = imageURL(image); $('preview').alt = label(image); }
  else $('preview').removeAttribute('src');
  $('selected-name').textContent = image ? label(image) : '—';
  $('selected-details').textContent = image ? tr('{0} KB · {1}', formatNumber(image.record.length / 1024, { maximumFractionDigits: 1 }),
    image.source === 'watch' ? tr('from watch') : tr('from backup')) : tr('Choose a photo in the collection');
  render();
}
async function addImage(image) {
  const index = S.images.findIndex(item => item.id === image.id);
  if (index < 0) S.images.push(image); else S.images[index] = { ...image, receivedAt: S.images[index].receivedAt };
  S.selected = image.id;
  try { await store.saveImage(S.images.find(item => item.id === image.id)); }
  catch (error) { S.storageFailed = true; log('error', tr('Browser storage: {0}', error.message)); }
  renderGallery();
}
function switchTab(name) {
  if (name === 'clock' && S.mode !== 'pc') name = 'photos';
  S.tab = name;
  for (const tab of ['photos', 'clock', 'connection']) {
    $('panel-' + tab).hidden = tab !== name;
    $('tab-' + tab).setAttribute('aria-selected', String(tab === name)); $('tab-' + tab).tabIndex = tab === name ? 0 : -1;
  }
  document.querySelectorAll('details.menu').forEach(menu => { menu.open = false; });
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  if (S.active) return;
  S.mode = button.dataset.mode;
  if (S.mode === 'others' && S.tab === 'clock') switchTab('photos');
  try { localStorage.setItem(MODE_KEY, S.mode); } catch {}
  status('idle', S.mode === 'pc' ? tr('PC mode') : tr('OTHERS mode'),
    S.mode === 'pc' ? tr('Choose Current photo, All photos or Find watch.') : tr('Choose Receive photo, then send a photo from OTHERS → SEND on WQV-2.'));
  render();
}));
document.querySelectorAll('.tabs [role=tab]').forEach(button => button.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = ['photos', ...(S.mode === 'pc' ? ['clock'] : []), 'connection'];
  const index = tabs.indexOf(button.dataset.tab), direction = event.key === 'ArrowLeft' ? -1 : 1;
  const name = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(index + direction + tabs.length) % tabs.length];
  switchTab(name); $('tab-' + name).focus();
}));

async function simple(task) {
  if (S.active) return;
  const controller = new AbortController(); S.active = controller; render();
  try { await task(controller.signal); }
  catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') status('idle', tr('Operation cancelled'));
    else if (error.name === 'NotFoundError') status('idle', tr('No USB device selected'));
    else { log('error', error.message); status('error', tr('Operation did not finish'), error.message); }
    if (S.adapter && !S.adapter.opened) S.adapter = null;
  } finally { if (S.active === controller) S.active = null; render(); }
}
$('connect').addEventListener('click', () => simple(async signal => {
  const device = await navigator.usb.requestDevice({ filters: [] }); signal.throwIfAborted();
  S.device = device; capture('usb');
  const adapter = createWQV2Adapter(device, { record, raw: (kind, bytes) => S.capture?.raw[kind].push(bytes),
    log: (level, message) => log(level, message), update: refreshSoon });
  S.adapter = adapter;
  try { await adapter.open(); signal.throwIfAborted(); }
  catch (error) { try { await adapter.close(); } catch {} S.adapter = null; throw error; }
  status('success', tr('USB adapter connected'), S.mode === 'pc' ? tr('Choose Current photo, All photos or Find watch.') :
    tr('Choose Receive photo, then send a photo from OTHERS → SEND on WQV-2.'));
  log('info', tr('{0} connected', describeUSBDevice(device).label));
}));
$('disconnect').addEventListener('click', () => simple(async () => {
  await S.adapter?.close(); S.adapter = null; S.device = null;
  status('idle', tr('USB connection closed'), tr('Your collection stays in this browser.'));
}));

function renderTransfer() {
  const pending = S.pending; if (!pending) return;
  const others = pending.mode === 'others', settingClock = pending.mode === 'set-clock';
  $('transfer-title').textContent = settingClock ? tr('Set date and time') : pending.clockRead ? tr('Read watch time') : others ? tr('Receive photo from watch') : pending.mode === 'all' ? tr('Read all photos') : pending.mode === 'probe' ? tr('Find watch') : tr('Read current photo');
  $('transfer-watch-path').textContent = others ? 'IR → OTHERS → SEND' : 'IR → PC → F';
  $('transfer-start').textContent = settingClock ? tr('Set on watch') : others ? tr('Start receiving') : tr('Start reading');
  $('transfer-instructions').textContent = others ? pending.state === 'running' ?
    tr('Press the front F button on WQV-2 now to send the selected photo. Keep the watch facing the adapter.') :
    tr('From COM, select OTHERS and press F. With SEND selected, press F again to open the photos. Choose a photo and wait before the final F press.') : pending.state === 'running' ?
    tr('Now select IR → PC on WQV-2 and press the front F button. Keep the watch facing the adapter.') :
    tr('Keep the watch outside IR → PC for now. Click Start reading, then activate IR → PC and press F on the watch.');
  $('transfer-start').disabled = pending.state !== 'ready';
  $('transfer-status').textContent = pending.heading;
  $('transfer-detail').textContent = pending.detail;
  $('transfer-progress').hidden = pending.state !== 'running';
  if (pending.ratio == null) $('transfer-progress').removeAttribute('value'); else $('transfer-progress').value = pending.ratio;
}
async function read(mode, { clockValue, clockRead = false } = {}) {
  if (S.active || !S.adapter?.opened) return;
  if ((mode === 'others') !== (S.mode === 'others')) return;
  if (mode === 'set-clock') {
    try { wqv12ClockPayload(clockValue); }
    catch (error) { status('error', tr('Invalid date or time'), error.message); render(); return; }
  }
  const adapter = S.adapter, controller = new AbortController(); S.active = controller; S.latest = null;
  capture(mode);
  if (mode === 'set-clock') record('wqv12-clock-selected', { requested: clockValue, sent: false });
  S.pending = { mode, clockValue, clockRead, state: 'preparing', heading: tr('Preparing USB'), detail: '', ratio: null };
  $('transfer-dialog').showModal(); render();
  try {
    S.capture.settings = await adapter.prepareWQV2(controller.signal, { mode: mode === 'others' ? 'others' : 'pc' }); controller.signal.throwIfAborted();
    S.pending.state = 'ready'; S.pending.heading = tr('USB ready'); S.pending.detail = mode === 'set-clock' ?
      tr('Set to {0}. Seconds will stay unchanged.', new Date(clockValue).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })) : mode === 'others' ?
      tr('Start receiving here before pressing F to send the photo.') : tr('Start here before activating PC mode on the watch.'); render();
    await new Promise((resolve, reject) => {
      const cancel = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', cancel, { once: true });
      startReading = () => { controller.signal.removeEventListener('abort', cancel); startReading = null; resolve(); };
      if (controller.signal.aborted) cancel();
    });
    controller.signal.throwIfAborted(); S.pending.state = 'running';
    status('working', tr('Looking for the watch'), mode === 'others' ?
      tr('Press F on WQV-2 now to send the photo.') : tr('Select IR → PC and press F on WQV-2 now.'));
    const client = new WQV12Client(adapter, { signal: controller.signal, record,
      progress(phase, details) {
        const heading = phaseLabel(phase);
        const received = details.received ?? 0;
        const ratio = phase === 'photos' && details.total ? Math.min(1, received / details.total) : null;
        const detail = phase === 'photos' && details.total ? tr('{0} of {1} photos · {2} / {3} bytes',
          details.images ?? 0, details.count, Math.min(received, details.total), details.total) : '';
        Object.assign(S.pending, { heading, detail, ratio }); status('working', heading, detail, ratio);
      },
      onImage: async image => addImage(await wqv2Image(image.bytes)),
    });
    S.client = client; const result = await client.run({ mode, clockValue }); S.latest = result; S.capture.result = result;
    if (mode === 'set-clock' && result.clockUpdate) {
      const outcome = result.clockUpdate.outcome;
      status(result.complete ? 'success' : 'error', outcome === 'accepted' ?
        result.complete ? tr('Date and time updated') : tr('Clock updated; connection did not finish') :
        outcome === 'rejected' ? tr('Clock update rejected') : tr('Clock update not confirmed'),
        outcome === 'accepted' ? tr('Seconds were kept unchanged. Read the watch time again to check it.') : outcome === 'rejected' ?
          tr('The watch rejected the requested date and time.') :
          tr('The watch may have applied the date and time. Read its time before trying again.'));
      if (!result.complete) await adapter.close();
    }
    else if (controller.signal.aborted) status('idle', tr('Operation cancelled'), mode === 'set-clock' ? '' : tr('Photos already received have been saved. Reconnect USB to continue.'));
    else if (!result.complete) {
      status('error', result.imageCount ? tr('Photos saved; connection did not finish') : tr('Operation did not finish'), result.error?.message || '');
      await adapter.close();
    } else if (mode === 'probe') status('success', clockRead ? tr('Watch time read') : tr('WQV-2 replied'), tr('The watch connection opened and closed normally.'));
    else status('success', tr('Received: {0}', quantity(result.imageCount, 'photos')), tr('Original BIN files and PNG images are saved in this browser.'));
  } catch (error) {
    if (controller.signal.aborted) status('idle', tr('Operation cancelled'), mode === 'set-clock' ? '' : tr('Photos already received have been saved. Reconnect USB to continue.'));
    else { log('error', error.message); status('error', tr('Operation did not finish'), error.message); }
    try { await adapter.close(); } catch {}
  } finally {
    if (controller.signal.aborted) { try { await adapter.close(); } catch {} }
    startReading = null; S.pending = null; S.client = null;
    if (!adapter.opened) S.adapter = null;
    if (S.active === controller) S.active = null;
    $('transfer-dialog').close(); render();
  }
}
const cancel = () => {
  S.active?.abort(new DOMException('Stopped by user', 'AbortError'));
  S.adapter?.close().catch(() => {});
};
for (const id of ['stop', 'transfer-cancel', 'transfer-close']) $(id).addEventListener('click', cancel);
$('transfer-dialog').addEventListener('cancel', event => { event.preventDefault(); cancel(); });
$('transfer-start').addEventListener('click', () => startReading?.());
$('download-current').addEventListener('click', () => read('current'));
$('download-all').addEventListener('click', () => read('all'));
$('find-watch').addEventListener('click', () => read('probe'));
$('receive-photo').addEventListener('click', () => read('others'));
$('read-clock').addEventListener('click', () => read('probe', { clockRead: true }));
$('set-clock').addEventListener('click', () => read('set-clock', { clockValue: $('clock-date').value + 'T' + $('clock-time').value }));
function fillClock() {
  const date = new Date(), two = value => String(value).padStart(2, '0');
  $('clock-date').value = date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate());
  $('clock-time').value = two(date.getHours()) + ':' + two(date.getMinutes());
}
$('fill-clock').addEventListener('click', fillClock); fillClock();

function download(data, name, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('save-image').addEventListener('click', () => {
  const image = selected(); if (!image) return;
  const format = $('export-format').value; download(format === 'bin' ? image.record : image.png,
    wqv2Filename(image) + '.' + format, format === 'png' ? 'image/png' : 'application/octet-stream');
});
const exportAll = () => { if (S.images.length) download(zipFiles(S.images.flatMap(wqv2Files)), 'WQV2-photos-' + now().replaceAll(':', '-') + '.zip'); };
for (const id of ['export-all', 'menu-export']) $(id).addEventListener('click', exportAll);
for (const id of ['import-images', 'menu-import']) $(id).addEventListener('click', () => $('image-files').click());
$('image-files').addEventListener('change', event => {
  const files = [...event.target.files]; event.target.value = ''; if (!files.length) return;
  simple(async signal => {
    let imported = 0;
    for (const file of files) {
      signal.throwIfAborted();
      try {
        if (file.size !== 7229) throw new Error(String(tr('Choose a 7229-byte WQV-2 BIN backup.')));
        await addImage(await wqv2Image(new Uint8Array(await file.arrayBuffer()), { source: 'backup' })); imported++;
      } catch (error) { log('error', tr('{0}: {1}', file.name, error.message)); }
    }
    status(imported ? 'success' : 'error', imported ? tr('Imported: {0}', quantity(imported, 'photos')) : tr('No photos imported'),
      imported ? tr('The photos are saved in the WQV-2 album.') : tr('Choose a 7229-byte WQV-2 BIN backup.'));
  });
});
$('delete-local-image').addEventListener('click', async () => {
  const image = selected(); if (!image || S.active) return;
  if (!await messageDialog(tr('Delete local copy'), tr('Delete “{0}” from this browser’s WQV-2 album?', label(image)),
    { confirm: true, accept: tr('Delete copy') })) return;
  simple(async () => {
    if (store.db) await store.removeImage(image.id);
    const index = S.images.indexOf(image); S.images.splice(index, 1);
    S.selected = S.images[Math.min(index, S.images.length - 1)]?.id ?? null;
    URL.revokeObjectURL(S.urls.get(image.id)); S.urls.delete(image.id);
    status('success', tr('Local copy deleted'), tr('The photo on the watch and exported files have been kept.')); renderGallery();
  });
});
function saveReport() {
  const c = S.capture, json = data => new TextEncoder().encode(JSON.stringify(data, null, 2) + '\n');
  const report = { format: 'wqv2-webusb-v1', model: 'WQV-2', savedAt: now(),
    environment: { secureContext: isSecureContext, webUSB: Boolean(navigator.usb), userAgent: navigator.userAgent },
    startedAt: c?.startedAt, mode: c?.mode, adapter: c?.device, settings: c?.settings, result: c?.result,
    log: S.log.map(event => ({ ...event, message: formatText(event.message) })) };
  const files = [{ name: 'report.json', data: json(report) }];
  if (c) {
    files.push({ name: 'protocol.jsonl', data: new TextEncoder().encode(c.events.map(e => JSON.stringify(e)).join('\n') + '\n') });
    for (const [kind, parts] of Object.entries(c.raw)) files.push({ name: kind + '.bin', data: concat(...parts) });
  }
  download(zipFiles(files), 'WQV2-report-' + now().replaceAll(':', '-') + '.zip');
}
for (const id of ['save-log', 'menu-report']) $(id).addEventListener('click', saveReport);
$('clear-log').addEventListener('click', () => { S.log.length = 0; render(); });

function applyLanguage() {
  renderGallery();
  if (!supported) $('compatibility').textContent = tr('This browser has no WebUSB. Open the page in Chrome, Edge or an Opera version with WebUSB.');
}
installDesktopShell({ help: () => messageDialog('WQV-2 · WQV Link',
  [tr('Connect a SigmaTel STIr4200 or KingSun KS-959, then choose Current photo or All photos. Start reading on the computer before activating IR → PC and pressing F on WQV-2.\n\nPhotos are stored in this browser’s WQV-2 album. Save PNG images or original BIN records, open BIN backups, or export the album as a ZIP.\n\nKS-959 uses the local USB helper. SigmaTel connects directly through WebUSB.'),
    tr('In OTHERS mode, choose Receive photo. Open OTHERS → SEND on WQV-2 and choose a photo. Start receiving on the computer before pressing F on the watch to send it.'),
    tr('In PC mode, the Clock tab reads the watch time and sets the date, hours and minutes. Setting keeps the watch seconds unchanged. Start on the computer before activating PC mode on WQV-2.')].join('\n\n')), changed: applyLanguage });
if (!supported) $('compatibility').hidden = false;
if (navigator.usb) navigator.usb.addEventListener('disconnect', event => {
  if (event.device !== S.device) return;
  cancel(); S.device = null; S.adapter = null; status('idle', tr('USB adapter unplugged'), tr('Reconnect the USB IrDA adapter.'));
});
window.addEventListener('pagehide', () => {
  S.active?.abort(); S.adapter?.close().catch(() => {});
  for (const url of S.urls.values()) URL.revokeObjectURL(url);
});
try {
  await store.open();
  for (const image of (await store.images()).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    // Rebuild the preview from the original record, including imported backups.
    try { S.images.push(await wqv2Image(image.record, image)); }
    catch (error) { log('error', tr('Could not open a stored WQV-2 photo: {0}', error.message)); }
  }
  S.selected = S.images[0]?.id ?? null; renderGallery();
} catch (error) { S.storageFailed = true; log('error', tr('Browser storage: {0}', error.message)); render(); }
