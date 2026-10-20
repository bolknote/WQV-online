import { createAdapter, describeUSBDevice } from './adapters.mjs';
import { WQVClient } from './protocol.mjs';
import { HolidayCalendar, FIRST_YEAR, LAST_YEAR, monthDays, clockPayload } from './calendar.mjs';
import { b, equal, sha256, makeUPF, jpegFromUPF, packSCEP, putCommand, toHex } from './formats.mjs';
import { imageFromFile, prepareRaster, readableImage, LocalStore } from './images.mjs';
import { zipFiles } from './zip.mjs';
import { sleep } from './irda.mjs';

const $ = id => document.getElementById(id), store = new LocalStore();
const emptyGallery = $('gallery').firstElementChild.cloneNode(true);
const S = {
  device: null, adapter: null, lastAdapter: null, client: null, active: null, maintenance: null, idleTimer: null,
  images: [], selected: null, urls: new Map(), events: [], tests: {}, tab: 'photos',
  calendar: null, baseline: null, holidayBackup: null, calendarOrigin: '', fast: false, stopFast: false,
};
const supported = Boolean(navigator.usb && isSecureContext);
const stamp = () => new Date().toISOString();
function quantity(n, words) { const last = n % 10, teen = n % 100; return n + ' ' + words[teen >= 11 && teen <= 14 ? 2 : last === 1 ? 0 : last >= 2 && last <= 4 ? 1 : 2]; }
let logTimer = null, updateTimer = null;

function log(level, message) {
  S.events.push({ at: stamp(), level, message });
  if (S.events.length > 10000) S.events.shift();
  if (!logTimer) logTimer = setTimeout(renderLog, 80);
}
function renderLog() {
  logTimer = null;
  const verbose = $('raw-log').checked;
  const visible = S.events.filter(e => verbose || !['tx-frame', 'rx-frame', 'tx', 'usb-rx', 'switch'].includes(e.level));
  $('log').textContent = visible.slice(-250).map(e => new Date(e.at).toLocaleTimeString('ru-RU') + '  ' + e.level.toUpperCase().padEnd(7) + ' ' + e.message).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}
function result(state, heading, detail = '', ratio = null) {
  $('result-heading').textContent = heading; $('result-detail').textContent = detail;
  $('result-heading').closest('.operation-bar').dataset.state = state;
  $('result-icon').textContent = { success: '●', error: '!', working: '◌', idle: '●' }[state] || '●';
  $('progress').hidden = state !== 'working';
  if (ratio === null) $('progress').removeAttribute('value'); else $('progress').value = ratio;
}
function updateSoon() { if (!updateTimer) updateTimer = setTimeout(update, 60); }
function selected() { return S.images.find(i => i.id === S.selected); }
function update() {
  clearTimeout(updateTimer); updateTimer = null;
  const connected = Boolean(S.adapter?.opened), busy = Boolean(S.active), source = S.adapter || S.lastAdapter;
  const info = S.device ? describeUSBDevice(S.device) : null;
  $('connect').disabled = !supported || busy || connected;
  $('disconnect').disabled = (!S.adapter && !S.device) || busy;
  document.querySelectorAll('[data-usb]').forEach(button => { button.disabled = !connected || busy; });
  for (const id of ['import-images', 'rotate-image', 'delete-local-image']) $(id).disabled = busy || (id !== 'import-images' && !selected());
  $('upload-image').disabled = !connected || busy || !selected() || Boolean(selected()?.jpegError);
  $('save-image').disabled = !selected();
  $('export-all').disabled = !S.images.length;
  $('remote-stop').disabled = !connected || (busy && !S.fast);
  $('stop').hidden = !busy;
  $('adapter-label').textContent = info?.label || 'USB IrDA';
  $('adapter-label').title = info?.label || 'Выбери USB IrDA-адаптер';
  $('device-name').textContent = info?.name || '—'; $('usb-id').textContent = info?.usbId || '—';
  $('adapter-support').textContent = info ? info.supported ? 'Поддерживается' : 'Не реализована' : '—';
  $('endpoints').textContent = connected ? 'OUT ' + S.adapter.outEndpoint + ' / IN ' + S.adapter.inEndpoint : '—';
  $('watch-model').textContent = S.client?.connected ? 'Casio WQV-' + S.client.model : '—';
  $('connection-badge').textContent = info && !info.supported ? 'Не поддерживается' : connected ? 'USB подключён' : 'USB не подключён';
  $('connection-badge').classList.toggle('connected', connected);
  $('connection-badge').classList.toggle('unsupported', Boolean(info && !info.supported));
  $('power-led').classList.toggle('on', connected);
  $('power-led').title = connected ? info.label + ' подключён' : 'USB не подключён';
  $('title-connection').textContent = S.client?.connected ? 'WQV-' + S.client.model + ' на связи' : connected ? 'IrDA / USB' : 'автономно';
  $('tx-count').textContent = source?.txFrames ?? 0; $('rx-count').textContent = source?.rxBytes ?? 0;
  $('crc-count').textContent = source?.decoder.badCRC ?? 0; $('switch-count').textContent = source?.switches ?? 0;
  $('ir-mode').textContent = S.adapter?.configured ? 'SIR · 9600 бит/с' : '—';
  $('send-holidays').disabled = !S.calendar || !connected || busy;
  $('export-holidays').disabled = !S.calendar;
  $('original-backup').disabled = !S.holidayBackup;
  $('holiday-edit').disabled = !S.calendar || busy;
  $('import-holidays').disabled = busy;
  document.querySelectorAll('#calendar-grid button[data-day]').forEach(button => { button.disabled = !S.calendar || busy; });
}
function record(name, value) { S.tests[name] = { at: stamp(), ...value }; }
function switchTab(name) {
  if (!['photos', 'clock', 'holidays', 'connection'].includes(name)) return;
  S.tab = name;
  for (const tab of ['photos', 'clock', 'holidays', 'connection']) {
    $('panel-' + tab).hidden = tab !== name;
    $('tab-' + tab).setAttribute('aria-selected', String(tab === name));
    $('tab-' + tab).tabIndex = tab === name ? 0 : -1;
  }
  closeMenus(); if (name === 'connection') renderLog();
}
function closeMenus() {
  $('start-menu').hidden = true; $('start-menu-button').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('details.menu').forEach(menu => { menu.open = false; });
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
document.querySelectorAll('.tabs [role=tab]').forEach((button, index, buttons) => button.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4;
  switchTab(buttons[next].dataset.tab); buttons[next].focus();
}));
$('start-menu-button').addEventListener('click', () => { $('start-menu').hidden = !$('start-menu').hidden; $('start-menu-button').setAttribute('aria-expanded', String(!$('start-menu').hidden)); });
document.addEventListener('click', event => { if (!event.target.closest('.start-menu,.start-button,.menu')) closeMenus(); });

function showDialog(title, message, accept = 'OK', confirm = false) {
  closeMenus();
  return new Promise(resolve => {
    const dialog = $('message-dialog'); $('dialog-title').textContent = title; $('dialog-message').textContent = message;
    $('dialog-detail').replaceChildren(); $('dialog-accept').textContent = accept; $('dialog-cancel').hidden = !confirm;
    const finish = value => { dialog.close(); resolve(value); };
    $('dialog-accept').onclick = () => finish(true); $('dialog-cancel').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal(); (confirm ? $('dialog-cancel') : $('dialog-accept')).focus();
  });
}
const help = () => showDialog('WQV Link 0.2 · CASSIOPEIA', 'Casio WQV-3 / WebUSB.\n\nОбмен поддерживается с SigmaTel STIr4200 (066f:4200). У других устройств можно увидеть имя и USB ID; работа с ними пока не реализована.\n\nПодключи USB и включи на часах IR → ПК. ИК-окна должны быть напротив друг друга, на расстоянии 5–10 см.\n\nСнимки: текущий снимок, вся коллекция, импорт JPEG / PNG / UPF / WQV, запись и экспорт. Стрелки управляют просмотром на часах.\n\n«Удалить локальную копию…» удаляет выбранный снимок только из этого браузера. На WQV-3 удаление выполняется кнопками часов: VISUAL DATABANK → выбрать снимок B/E → F → удерживать A около секунды → DEL → PAGE → YES. Меню выбираются B/E и подтверждаются F.\n\nЧасы: дата и время, синхронизация с компьютером. Праздники: чтение, редактирование и запись календаря 2000–2039.\n\nСнимки и резервные копии хранятся только в этом браузере. Сохрани ZIP для независимой копии. Команды удаления снимков с часов и управления будильником не найдены.\n\nОформление вдохновлено Casio CASSIOPEIA и Pocket PC 2000.');
for (const id of ['help-top', 'help-menu', 'help-menu-bar']) $(id).addEventListener('click', help);

async function closeClient() {
  clearTimeout(S.idleTimer); S.idleTimer = null;
  const client = S.client; S.client = null;
  if (client) await client.close();
}
function scheduleKeepAlive() {
  clearTimeout(S.idleTimer);
  if (!S.client?.connected || !S.client.isPrimary || !S.adapter?.opened || S.active) return;
  S.idleTimer = setTimeout(() => {
    if (S.active || !S.client?.connected) return;
    const client = S.client; client.signal = null;
    S.maintenance = client.primaryExchange().catch(async error => {
      log('info', 'Связь с часами прервана: ' + error.message);
      client.connected = false;
      if (S.client === client) S.client = null;
      if (S.adapter?.opened) { try { await S.adapter.pauseReader(); } catch {} }
    }).finally(() => { S.maintenance = null; update(); scheduleKeepAlive(); });
  }, 500);
}
async function ensureClient(signal) {
  if (S.client?.connected && S.client.isPrimary) { S.client.signal = signal; return S.client; }
  await closeClient();
  const client = new WQVClient(S.adapter, { signal, log, progress: (h, d, r = null) => result('working', h, d, r) });
  S.client = client; await client.openPrimary(); signal?.throwIfAborted();
  $('watch-model').textContent = 'Casio WQV-' + client.model;
  record('connection', { passed: true, model: client.model });
  return client;
}
async function run(task, { keep = true } = {}) {
  if (S.active) return;
  clearTimeout(S.idleTimer); S.idleTimer = null;
  const controller = new AbortController(); S.active = controller; update();
  try { await S.maintenance; controller.signal.throwIfAborted(); await task(controller.signal); }
  catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') {
      log('info', 'Операция отменена.'); result('idle', 'Операция отменена', 'Уже полученные снимки сохранены. Для продолжения можно снова подключить USB.');
    } else if (error.name === 'NotFoundError' && !S.adapter) {
      result('idle', 'USB-устройство не выбрано', 'Нажми «Подключить USB…» и выбери ИК-адаптер.');
    } else {
      log('error', error.name + ': ' + error.message); record('lastError', { name: error.name, message: error.message });
      result('error', 'Операция не завершена', error.message);
    }
    try { await closeClient(); } catch (closeError) { log('error', closeError.message); }
    if (S.adapter) {
      const adapter = S.adapter; S.lastAdapter = adapter; S.adapter = null;
      try { await adapter.close(); } catch (closeError) { log('error', closeError.message); }
    }
  } finally {
    if (!keep || !S.client?.connected) { try { await closeClient(); } catch (error) { log('error', error.message); } }
    if (S.client) S.client.signal = null;
    if (S.active === controller) S.active = null;
    S.fast = false; update(); scheduleKeepAlive();
    if ($('result-heading').closest('.operation-bar').dataset.state !== 'working') $('progress').hidden = true;
  }
}
$('connect').addEventListener('click', () => run(async signal => {
  result('working', 'Выбери USB IrDA-адаптер', 'Название и поддержка будут определены по выбранному устройству.');
  const device = await navigator.usb.requestDevice({ filters: [] });
  signal.throwIfAborted();
  S.device = device; S.lastAdapter = null;
  const info = describeUSBDevice(device); update();
  if (!info.supported) {
    record('usb', { passed: false, supported: false, description: info });
    log('info', info.label + ': нет подходящего драйвера. USB-обмен не запускался.');
    result('idle', 'Адаптер не поддерживается', info.label + '. Обмен для этого USB ID пока не реализован.');
    return;
  }
  S.adapter = createAdapter(device, { log, update: updateSoon, rawLog: $('raw-log').checked }); S.lastAdapter = S.adapter;
  const description = await S.adapter.open(); signal.throwIfAborted();
  record('usb', { passed: true, description }); log('ok', info.label + ' открыт через WebUSB.');
  result('success', 'USB-адаптер подключён', info.label + '. Включи на WQV-3 режим IR → ПК и выбери операцию.');
}));
$('disconnect').addEventListener('click', () => run(async () => {
  await closeClient(); const adapter = S.adapter;
  if (adapter) { await adapter.close(); S.lastAdapter = adapter; } S.adapter = null; S.device = null;
  result('idle', 'USB-соединение закрыто', 'Коллекция остаётся в браузере.'); log('info', 'USB-соединение закрыто.');
}, { keep: false }));
$('stop').addEventListener('click', async () => {
  S.active?.abort(); clearTimeout(S.idleTimer);
  if (S.adapter) { try { await S.adapter.close(); } catch (error) { log('error', error.message); } }
});
$('find-watch').addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal);
  result('success', 'Casio WQV-' + client.model + ' на связи', 'Можно управлять просмотром, временем и календарём или передавать снимки.');
}));
$('test-usb').addEventListener('click', () => run(async signal => {
  await closeClient(); result('working', 'Проверка USB-приёма', 'Два цикла остановки и возобновления чтения.');
  await S.adapter.testTurnaround(signal); record('turnaround', { passed: true }); result('success', 'USB-обмен исправен', 'Оба цикла завершены; адаптер отвечает.');
}, { keep: false }));
$('registers').addEventListener('click', () => run(async () => {
  const raw = await S.adapter.registers(); result('success', 'Регистры адаптера прочитаны', Array.from(raw, v => v.toString(16).padStart(2, '0')).join(' '));
}));
$('capabilities').addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal), capabilities = await client.capabilities();
  $('capabilities-output').hidden = false; $('capabilities-output').textContent = JSON.stringify(capabilities, null, 2);
  record('capabilities', { passed: true, capabilities }); result('success', 'Возможности часов получены', 'RIMG — изображения, RINF — сведения, RCMD — команды.');
}, { keep: false }));

function imageURL(image) {
  if (!S.urls.has(image.id)) S.urls.set(image.id, URL.createObjectURL(new Blob([image.previewJPEG || image.jpeg], { type: 'image/jpeg' })));
  return S.urls.get(image.id);
}
function renderGallery() {
  $('photo-count').textContent = quantity(S.images.length, ['снимок', 'снимка', 'снимков']);
  if (S.images.length) {
    const fragment = document.createDocumentFragment();
    for (const image of S.images) {
      const button = document.createElement('button'); button.className = 'thumbnail'; button.setAttribute('aria-pressed', String(image.id === S.selected));
      button.title = image.name; button.setAttribute('aria-label', 'Снимок ' + image.name);
      const img = document.createElement('img'); img.src = imageURL(image); img.alt = ''; img.width = 88; img.height = 72;
      const label = document.createElement('span'); label.textContent = image.name;
      button.append(img, label); button.addEventListener('click', () => { S.selected = image.id; renderGallery(); }); fragment.append(button);
    }
    $('gallery').replaceChildren(fragment);
  } else $('gallery').replaceChildren(emptyGallery.cloneNode(true));
  const image = selected(); $('preview').hidden = !image || Boolean(image.jpegError); $('preview-empty').hidden = Boolean(image) && !image.jpegError;
  if (image) {
    $('preview').src = imageURL(image); $('preview').alt = image.name;
    $('selected-name').textContent = image.name;
    $('selected-details').textContent = image.jpegError || (((image.previewJPEG || image.jpeg).length / 1024).toFixed(1) + ' КБ · ' + (image.source === 'import' ? 'импорт' : 'с часов') + (image.jpegRepaired ? ' · JPEG восстановлен' : ''));
    $('upload-ready').textContent = '176 × 144 · baseline JPEG · 4:2:0' + (image.previewJPEG ? ' · перезапуски убраны без потерь' : '');
  } else {
    $('preview').removeAttribute('src'); $('preview').alt = 'Выбранный снимок';
    $('selected-name').textContent = '—'; $('selected-details').textContent = 'Выбери снимок в альбоме';
    $('upload-ready').textContent = 'Выбери снимок в альбоме или импортируй картинку.';
  }
  update();
}
$('delete-local-image').addEventListener('click', async () => {
  const image = selected(); if (!image || S.active) return;
  const confirmed = await showDialog('Удалить локальную копию', 'Удалить «' + image.name + '» из коллекции этого браузера?\n\nСнимок на часах и уже сохранённые файлы останутся. Удаление локальной копии нельзя отменить.', 'Удалить копию', true);
  if (!confirmed || S.active) return;
  const index = S.images.findIndex(item => item.id === image.id); if (index < 0) return;
  const operation = new AbortController(); S.active = operation; update();
  try {
    if (store.db) await store.removeImage(image.id);
    S.images.splice(index, 1);
    S.selected = S.images[Math.min(index, S.images.length - 1)]?.id ?? null;
    if (S.urls.has(image.id)) { URL.revokeObjectURL(S.urls.get(image.id)); S.urls.delete(image.id); }
    log('info', 'Удалена локальная копия «' + image.name + '».');
    result('success', 'Локальная копия удалена', 'Снимок на часах и сохранённые файлы остались.');
  } catch (error) {
    log('error', 'Не удалось удалить локальную копию: ' + error.message);
    result('error', 'Локальная копия не удалена', error.message);
  } finally {
    if (S.active === operation) S.active = null;
    renderGallery(); scheduleKeepAlive();
  }
});
async function addImage(image) {
  image = await readableImage(image);
  if (image.jpegRepaired) log('info', image.name + ': восстановлен JPEG с потерянным интервалом перезапуска. Исходные UPF и WQV сохранены.');
  if (S.urls.has(image.id)) { URL.revokeObjectURL(S.urls.get(image.id)); S.urls.delete(image.id); }
  const existing = S.images.findIndex(i => i.id === image.id);
  if (existing >= 0) S.images[existing] = image; else S.images.push(image);
  S.selected = image.id;
  try { await store.saveImage(image); } catch (error) { $('storage-label').textContent = 'только эта вкладка'; log('error', error.message); }
  renderGallery();
}
async function receive(current) {
  await run(async signal => {
    const client = await ensureClient(signal);
    const images = await client.download({ current, onImage: addImage });
    record(current ? 'downloadCurrent' : 'downloadAll', { passed: true, count: images.length });
    result('success', 'Получено: ' + quantity(images.length, ['снимок', 'снимка', 'снимков']), 'JPEG, UPF и WQV-архивы сохранены в коллекции этого браузера.');
  }, { keep: false });
}
$('download-current').addEventListener('click', () => receive(true));
$('download-all').addEventListener('click', () => receive(false));
function triggerImport() { closeMenus(); switchTab('photos'); $('image-files').click(); }
$('import-images').addEventListener('click', triggerImport); $('menu-import').addEventListener('click', triggerImport);
$('image-files').addEventListener('change', async event => {
  const files = Array.from(event.target.files); event.target.value = '';
  if (files.length > 100) { await showDialog('Импорт', 'Выбери не больше 100 файлов за один раз.'); return; }
  await run(async signal => {
    for (let i = 0; i < files.length; i++) {
      signal.throwIfAborted(); result('working', 'Импорт снимков', files[i].name, i / files.length);
      const image = await imageFromFile(files[i], { fit: $('prepare-fit').value, quality: +$('prepare-quality').value / 100 });
      await addImage(image); log('ok', 'Импортирован ' + files[i].name + ' (' + image.jpeg.length + ' байт JPEG).');
    }
    result('success', 'Импорт завершён', files.length + ' файлов подготовлено для WQV-3.');
  });
});
$('prepare-quality').addEventListener('input', () => { $('quality-value').value = $('prepare-quality').value + '%'; });
$('rotate-image').addEventListener('click', () => run(async signal => {
  const image = selected(); if (!image) return;
  result('working', 'Подготовка снимка', 'Поворот на 90° и сохранение JPEG 176 × 144.');
  const jpeg = await prepareRaster(new Blob([image.previewJPEG || image.jpeg], { type: 'image/jpeg' }), { rotate: 90, fit: $('prepare-fit').value, quality: +$('prepare-quality').value / 100 });
  signal.throwIfAborted();
  await addImage(await imageFromFile(new File([jpeg], image.name + '_rotated.jpg', { type: 'image/jpeg' })));
  result('success', 'Снимок повёрнут', 'Подготовлена новая копия для записи на часы.');
}));
function downloadFile(data, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
const safeName = name => (name.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_').slice(0, 45) || 'WQV');
$('save-image').addEventListener('click', () => {
  const image = selected(); if (!image) return;
  const format = $('export-format').value, name = safeName(image.name) + '.' + format;
  downloadFile(format === 'jpg' ? image.previewJPEG || image.jpeg : format === 'upf' ? image.upf : JSON.stringify(image.archive, null, 2), name, format === 'jpg' ? 'image/jpeg' : 'application/octet-stream');
});
function exportCollection() {
  closeMenus(); if (!S.images.length) return;
  const encoder = new TextEncoder(), files = [], manifest = [];
  for (const image of S.images) {
    const base = safeName(image.name) + '_' + image.id.slice(0, 12);
    files.push({ name: base + '.jpg', data: image.previewJPEG || image.jpeg }, { name: base + '.upf', data: image.upf },
      { name: base + '.wqv', data: encoder.encode(JSON.stringify(image.archive, null, 2)) });
    manifest.push({ jpeg: base + '.jpg', upf: base + '.upf', archive: base + '.wqv', sha256: image.jpegSHA256 || image.id,
      originalJPEGsha256: image.id, jpegRepaired: Boolean(image.jpegRepaired) });
  }
  files.push({ name: 'collection.json', data: encoder.encode(JSON.stringify({ format: 'casio-wqv-collection-v1', savedAt: stamp(), images: manifest }, null, 2)) });
  downloadFile(zipFiles(files), 'WQV-collection.zip'); record('export', { count: S.images.length });
}
$('export-all').addEventListener('click', exportCollection); $('menu-export').addEventListener('click', exportCollection);
$('upload-image').addEventListener('click', () => run(async signal => {
  const image = selected(), filename = $('upload-name').value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{8}\.UPF$/.test(filename)) throw new Error('Имя файла: 8 символов ASCII и .UPF, например MC000001.UPF.');
  const client = await ensureClient(signal), upf = image.previewJPEG ? makeUPF(image.previewJPEG) : image.upf;
  const accepted = await client.upload(upf, filename);
  record('upload', { passed: true, filename: accepted, sha256: image.jpegSHA256 || image.id });
  log('ok', 'На часы отправлен снимок ' + accepted);
  result('success', 'Снимок записан на часы', accepted);
}, { keep: false }));
for (const [id, command] of [['remote-back', 3], ['remote-forward', 2]]) $(id).addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal); await client.control(b(command));
  record('navigation', { passed: true, command }); result('success', 'Просмотр на часах переключён', command === 2 ? 'Следующий снимок.' : 'Предыдущий снимок.');
}));
for (const [id, direction] of [['remote-fast-back', 'back'], ['remote-fast-forward', 'forward']]) $(id).addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal); S.fast = true; S.stopFast = false; update();
  result('working', 'Быстрое листание', 'Листание автоматически остановится через секунду.');
  await client.fastScroll(direction, { duration: 1000, stop: () => S.stopFast });
  record('fastScroll', { passed: true, direction }); result('success', 'Листание остановлено', 'Часы подтвердили команду остановки.');
}));
$('remote-stop').addEventListener('click', () => {
  if (S.fast) { S.stopFast = true; return; }
  run(async signal => { const client = await ensureClient(signal); await client.control(b(6)); result('success', 'Листание остановлено'); });
});

function localDateTime(date = new Date()) {
  const pad = v => String(v).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
function fillClock() { const [date, time] = localDateTime().split('T'); $('clock-date').value = date; $('clock-time').value = time; }
function tickClock() {
  const now = new Date(); $('pc-clock').textContent = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  $('desktop-time').textContent = now.toLocaleTimeString('ru-RU', { hour12: false });
  $('desktop-date').textContent = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('desktop-zone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
}
$('fill-clock').addEventListener('click', fillClock);
$('set-clock').addEventListener('click', () => run(async signal => {
  const value = $('clock-date').value + 'T' + $('clock-time').value, payload = clockPayload(value);
  const client = await ensureClient(signal); await client.control(payload);
  record('clock', { passed: true, value }); result('success', 'Дата и время установлены', value.replace('T', ' ') + ' · секунды сброшены в 00.');
}));
$('sync-clock').addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal), target = Math.floor(Date.now() / 60000) * 60000 + 60000;
  let lastPoll = 0;
  while (Date.now() < target) {
    signal.throwIfAborted(); const left = Math.ceil((target - Date.now()) / 1000);
    result('working', 'Ожидание начала минуты', 'Синхронизация через ' + left + ' с. Часы должны оставаться напротив адаптера.', 1 - (target - Date.now()) / 60000);
    if (Date.now() - lastPoll > 400 && target - Date.now() > 250) { await client.primaryExchange(); lastPoll = Date.now(); }
    await sleep(Math.max(1, Math.min(50, target - Date.now())));
  }
  const value = localDateTime(new Date(target)); await client.control(clockPayload(value)); fillClock();
  record('clockSync', { passed: true, value }); result('success', 'Время синхронизировано', value.replace('T', ' ') + ' · отправлено в начале минуты.');
}));

const monthNames = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString('ru-RU', { month: 'long' }));
for (const [i, month] of monthNames.entries()) $('calendar-month').add(new Option(month[0].toUpperCase() + month.slice(1), i + 1));
for (let y = FIRST_YEAR; y <= LAST_YEAR; y++) $('calendar-year').add(new Option(y, y));
$('calendar-month').value = new Date().getMonth() + 1; $('calendar-year').value = Math.max(FIRST_YEAR, Math.min(LAST_YEAR, new Date().getFullYear()));
function renderCalendar() {
  const year = +$('calendar-year').value, month = +$('calendar-month').value, first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const today = new Date(), fragment = document.createDocumentFragment();
  for (let cell = 0; cell < 42; cell++) {
    const day = cell - first + 1, button = document.createElement('button');
    if (day < 1 || day > monthDays(year, month)) { button.className = 'blank'; button.disabled = true; button.setAttribute('aria-hidden', 'true'); }
    else {
      const marked = Boolean(S.calendar?.get(year, month, day));
      button.textContent = day; button.dataset.day = day; button.disabled = !S.calendar || Boolean(S.active);
      button.setAttribute('aria-label', new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })); button.setAttribute('aria-pressed', String(marked));
      button.classList.toggle('holiday', marked);
      button.classList.toggle('today', today.getFullYear() === year && today.getMonth() + 1 === month && today.getDate() === day);
      button.addEventListener('click', () => { S.calendar.set(year, month, day, !S.calendar.get(year, month, day)); renderCalendar(); });
    }
    fragment.append(button);
  }
  $('calendar-grid').replaceChildren(fragment);
  const dirty = S.calendar && S.baseline && !equal(S.calendar.raw, S.baseline);
  $('holiday-state').textContent = !S.calendar ? 'Не считан с часов' : dirty ? 'Есть изменения' : S.calendarOrigin;
  $('holiday-count').textContent = S.calendar ? quantity(S.calendar.count(year), ['день', 'дня', 'дней']) + ' в ' + year : '—';
  update();
}
for (const id of ['calendar-month', 'calendar-year']) $(id).addEventListener('change', renderCalendar);
for (const [id, delta] of [['month-back', -1], ['month-forward', 1]]) $(id).addEventListener('click', () => {
  let m = +$('calendar-month').value - 1 + delta, y = +$('calendar-year').value;
  if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
  if (y < FIRST_YEAR || y > LAST_YEAR) return;
  $('calendar-year').value = y; $('calendar-month').value = m + 1; renderCalendar();
});
async function rememberCalendar(calendar, origin) {
  S.calendar = calendar; S.baseline = calendar.raw.slice(); S.calendarOrigin = origin;
  try { await store.set('calendar', calendar.backup()); } catch (error) { log('error', error.message); }
  renderCalendar();
}
async function saveHolidayBackup(calendar) {
  S.holidayBackup = calendar.backup();
  try { await store.set('holidayBackup', S.holidayBackup); } catch (error) { log('error', error.message); }
}
$('read-holidays').addEventListener('click', () => run(async signal => {
  const client = await ensureClient(signal); result('working', 'Чтение календаря', 'Отметки за 2000–2039 годы.');
  const calendar = await client.control(b(9)); await saveHolidayBackup(calendar); await rememberCalendar(calendar, 'Считан с часов');
  record('holidayRead', { passed: true, sha256: await sha256(calendar.raw), count: calendar.count() });
  result('success', 'Календарь считан', calendar.count() + ' отмеченных дат. Исходная копия сохранена в браузере.');
}));
$('send-holidays').addEventListener('click', async () => {
  if (!S.calendar || S.active) return;
  const desired = new HolidayCalendar(S.calendar.raw);
  if (!await showDialog('Запись календаря', 'Заменить на часах все отметки праздников за 2000–2039 годы?\n\nВ новом календаре отмечено дат: ' + desired.count() + '. Изменятся также другие месяцы.\n\nПеред записью будет считана и сохранена резервная копия текущего календаря часов.', 'Записать', true)) return;
  await run(async signal => {
    const client = await ensureClient(signal); result('working', 'Резервная копия календаря', 'Считываю исходные отметки перед записью.');
    const original = await client.control(b(9)); await saveHolidayBackup(original);
    await client.control(desired.command()); result('working', 'Проверка календаря', 'Считываю записанные отметки обратно.');
    const actual = await client.control(b(9));
    if (!equal(actual.raw, desired.raw)) throw new Error('Прочитанный календарь отличается от отправленного. Исходная копия сохранена; проверь журнал.');
    await rememberCalendar(actual, 'Проверен после записи');
    record('holidayWrite', { passed: true, sha256: await sha256(actual.raw), count: actual.count() });
    result('success', 'Календарь записан и проверен', 'Все 1840 байт совпали при чтении обратно.');
  });
});
$('mark-weekdays').addEventListener('click', () => {
  if (!S.calendar) return;
  const weekdays = Array.from(document.querySelectorAll('.weekday-options input:checked'), input => +input.value);
  S.calendar.markWeekdays(+$('calendar-year').value, weekdays); renderCalendar();
});
$('clear-holidays').addEventListener('click', () => { if (S.calendar) { S.calendar.clear($('clear-range').value === 'all' ? null : +$('calendar-year').value); renderCalendar(); } });
$('undo-holidays').addEventListener('click', () => { if (S.baseline) { S.calendar = new HolidayCalendar(S.baseline); renderCalendar(); } });
$('export-holidays').addEventListener('click', () => { if (S.calendar) downloadFile(JSON.stringify(S.calendar.backup(), null, 2), 'WQV-holidays.json', 'application/json'); });
$('original-backup').addEventListener('click', () => { if (S.holidayBackup) downloadFile(JSON.stringify(S.holidayBackup, null, 2), 'WQV-holidays-original.json', 'application/json'); });
$('import-holidays').addEventListener('click', () => $('holiday-file').click());
$('holiday-file').addEventListener('change', event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  run(async signal => {
    if (file.size > 20000) throw new Error('Файл календаря слишком большой.');
    let backup; try { backup = JSON.parse(await file.text()); } catch { throw new Error('Файл не содержит календарь JSON.'); }
    signal.throwIfAborted(); const calendar = HolidayCalendar.fromBackup(backup);
    await rememberCalendar(calendar, 'Из резервной копии'); result('success', 'Календарь открыт', 'На часах ничего не изменено. Для применения нажми «Записать на часы…».');
  });
});

function saveReport() {
  const a = S.adapter || S.lastAdapter;
  const report = { format: 'wqv-webusb-diagnostics-v1', version: '0.2', savedAt: stamp(),
    environment: { secureContext: isSecureContext, webUSB: Boolean(navigator.usb), userAgent: navigator.userAgent },
    tests: S.tests, counters: a ? { txFrames: a.txFrames, rxBytes: a.rxBytes, switches: a.switches, badCRC: a.decoder.badCRC } : null, events: S.events };
  downloadFile(JSON.stringify(report, null, 2), 'WQV-Link-report-' + stamp().replace(/[:.]/g, '-') + '.json', 'application/json');
}
$('save-log').addEventListener('click', saveReport); $('menu-report').addEventListener('click', saveReport);
$('clear-log').addEventListener('click', () => { S.events.length = 0; log('info', 'Журнал очищен.'); });
$('raw-log').addEventListener('change', () => { if (S.adapter) S.adapter.rawLog = $('raw-log').checked; renderLog(); });
if (navigator.usb) navigator.usb.addEventListener('disconnect', event => {
  if (event.device !== S.device) return;
  S.active?.abort(); clearTimeout(S.idleTimer); S.lastAdapter = S.adapter; S.adapter = null; S.device = null;
  if (S.client) S.client.connected = false; S.client = null;
  result('idle', 'USB-адаптер извлечён', 'Подключи USB IrDA-адаптер снова.'); log('info', 'USB-адаптер извлечён.'); update();
});
window.addEventListener('pagehide', () => { clearTimeout(S.idleTimer); S.active?.abort(); S.adapter?.close().catch(() => {}); });
fillClock(); tickClock(); setInterval(tickClock, 1000); renderCalendar(); update();
if (!supported) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = !isSecureContext ? 'Для WebUSB открой страницу через localhost или HTTPS.' : 'В этом браузере нет WebUSB. Открой страницу в Chrome, Edge или поддерживающей WebUSB Opera.';
  log('info', $('compatibility').textContent);
} else log('ok', 'WQV Link 0.2 · WebUSB доступен.');
try {
  await store.open();
  for (const image of (await store.images()).sort((a, c) => a.receivedAt.localeCompare(c.receivedAt))) {
    try { const checked = await readableImage(image); S.images.push(checked); await store.saveImage(checked); }
    catch (error) { log('error', image.name + ': ' + error.message); S.images.push({ ...image, jpegError: error.message }); }
  }
  if (S.images.length) { S.selected = S.images[0].id; renderGallery(); }
  const calendar = await store.get('calendar'), backup = await store.get('holidayBackup');
  if (calendar) { S.calendar = HolidayCalendar.fromBackup(calendar); S.baseline = S.calendar.raw.slice(); S.calendarOrigin = 'Локальная копия'; }
  if (backup) S.holidayBackup = backup;
  renderCalendar();
} catch (error) { $('storage-label').textContent = 'только эта вкладка'; log('info', 'Хранилище браузера: ' + error.message); }
