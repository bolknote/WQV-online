import { SigmaTel } from './sigmatel.mjs';
import { getLanguage, setLanguage } from './i18n.mjs';
import { fromHex, toHex } from './formats.mjs';
import { captureUSB } from './research-core.mjs';
import { openResearchStore, Journal } from './research-store.mjs';
import { ManualSerialTrigger, probeSerialPacket, finishSerialCapture } from './serial-core.mjs';
import { SWAN_FORMAT, SWAN_PLAN, packetBytes, swanPreset, encodeSwanPacket, analyseSwanCapture, swanAttemptFiles } from './swan-core.mjs';
import { zipFiles } from './zip.mjs';

const ru = {
  'Passive speed comparison · 9600 / 38400': 'Пассивное сравнение скоростей · 9600 / 38400',
  'SWAN packet research': 'Исследование пакетов SWAN', 'Back to IR research': 'К исследованию ИК', Language: 'Язык',
  'Digimon packet format · applicability to WQV-3 unverified. Each packet is sent once, by a separate click. All RX bytes are kept, including possible echo.': 'Формат пакетов Digimon · работа с WQV-3 пока не подтверждена. Каждая посылка отправляется один раз по отдельному нажатию. Весь RX сохраняется, включая возможное эхо.',
  'Manual steps': 'Шаги вручную', 'Adapter echo control': 'Контроль эха адаптера',
  'SWAN RECEIVE · header 11': 'SWAN RECEIVE · заголовок 11', 'SWAN RECEIVE · header 21': 'SWAN RECEIVE · заголовок 21',
  'SWAN RECEIVE · selector 02': 'SWAN RECEIVE · селектор 02',
  'Restart SWAN RECEIVE between watch tests. Changing a step never starts it.': 'Между пробами заново включайте SWAN RECEIVE. Выбор шага не запускает его.',
  '9600 bit/s · 8N1 · raw SIR · no automatic replies': '9600 бит/с · 8N1 · сырой SIR · без автоматических ответов',
  'Packet fields': 'Поля пакета', 'Transport selector': 'Селектор транспорта', 'Header · 12 bytes': 'Заголовок · 12 байт', 'Payload · 1–128 bytes': 'Данные · 1–128 байт',
  '01 · paired': '01 · с дополнениями байтов', '02 · unpaired body': '02 · тело без дополнений',
  'Preset identity bytes are zero; the cartridge ID is from Tag Tamers. Payload 00 is synthetic. These are framing probes, not known watch commands.': 'В шаблонах идентификатор устройства нулевой, ID картриджа взят из Tag Tamers. Данные 00 — синтетические. Это пробы формата пакетов; значение команды часов неизвестно.',
  'Restore this preset': 'Вернуть шаблон', '1. Prepare the adapter': '1. Подготовьте адаптер',
  'Disconnect SigmaTel in other apps. Prepare USB before activating the watch; preparation sends no packet.': 'Отключите SigmaTel в других приложениях. Подготовьте USB до включения обмена на часах: подготовка не отправляет пакет.',
  'Prepare SigmaTel USB…': 'Подготовить SigmaTel USB…', 'Reset SigmaTel USB…': 'Сбросить SigmaTel USB…', 'Release USB': 'Освободить USB',
  '2. Record, activate the watch, send once': '2. Запись, включение часов, одна посылка',
  'Recording window (seconds)': 'Длительность записи (секунды)', 'Start recording': 'Начать запись', 'Send packet once': 'Отправить пакет один раз', Stop: 'Остановить',
  'For watch steps, start recording before the final button that activates RECEIVE. Then activate RECEIVE and click Send packet once immediately.': 'В пробах с часами начните запись до последнего нажатия, включающего RECEIVE. Затем включите RECEIVE и сразу нажмите «Отправить пакет один раз».',
  '← Previous step': '← Предыдущий шаг', 'Next step →': 'Следующий шаг →', 'Opening the journal…': 'Открываем журнал…',
  'Raw results': 'Сырые результаты', Attempt: 'Попытка', 'Save attempt ZIP…': 'Сохранить попытку ZIP…', 'Save all attempts ZIP…': 'Сохранить все попытки ZIP…',
  'ZIPs include original USB RX/TX, every event, the planned packet and packet/echo annotations. Everything stays in this browser. An RX match alone does not identify its source.': 'В ZIP входят исходные USB RX/TX, все события, подготовленный пакет и отметки пакетов и возможного эха. Всё хранится в этом браузере. Совпадение байтов RX само по себе не определяет источник.',
  'What happened on the watch?': 'Что было на экране часов?', 'Save notes': 'Сохранить заметки', 'Attempt details': 'Подробности попытки', 'Recent events': 'Последние события',
  'Manual steps · SigmaTel 066f:4200 · no automatic progression': 'Шаги вручную · SigmaTel 066f:4200 · без автоматического перехода',
  'Keep the watch out of the IR path for this control. Its purpose is to record adapter echo and background bytes.': 'Для контроля уберите часы из ИК-луча. Эта запись нужна для проверки эха адаптера и фоновых байтов.',
  'Restart IR → SWAN → RECEIVE. Face the watch toward SigmaTel at 5–10 cm. Leave the final RECEIVE activation until recording has started.': 'Заново выберите IR → SWAN → RECEIVE. Поставьте часы напротив SigmaTel на расстоянии 5–10 см. Последнее нажатие для включения RECEIVE сделайте после начала записи.',
  'The watch is out of the IR path.': 'Часы убраны из ИК-луча.', 'SWAN RECEIVE is selected; the final activation is still pending.': 'Выбран SWAN RECEIVE; последнее нажатие для включения приёма ещё не сделано.',
  'Prepare USB before activating the watch.': 'Подготовьте USB перед включением обмена на часах.', 'Preparing SigmaTel…': 'Подготавливаем SigmaTel…',
  'USB ready. Start recording first.': 'USB готов. Сначала начните запись.', 'Recording. Activate RECEIVE, then send the packet.': 'Идёт запись. Включите RECEIVE и отправьте пакет.',
  'Control recording. Keep the watch away and send the packet.': 'Контрольная запись. Держите часы в стороне и отправьте пакет.',
  'Packet queued; waiting for the current USB read.': 'Пакет запрошен; ожидаем завершения текущего чтения USB.',
  'Packet transmitted; recording continues without automatic replies.': 'Пакет отправлен; запись продолжается без автоматических ответов.',
  'Recording finished. Save the ZIP and restart the watch before another step.': 'Запись завершена. Сохраните ZIP и заново включите обмен на часах перед другой пробой.',
  'Packet was not transmitted. Check the attempt details.': 'Пакет не был отправлен. Проверьте подробности попытки.',
  'USB released.': 'USB освобождён.', 'Notes saved.': 'Заметки сохранены.',
  'Journal error. Recording stopped; the in-memory ZIP is still available.': 'Ошибка журнала. Запись остановлена; ZIP из памяти ещё можно сохранить.',
  'Another research tab is open. Close it before preparing USB.': 'Открыта другая исследовательская вкладка. Закройте её перед подготовкой USB.',
  'WebUSB is unavailable in this browser.': 'В этом браузере нет WebUSB.',
  'Enter complete hexadecimal bytes.': 'Введите целые шестнадцатеричные байты.', 'The header must contain exactly 12 bytes.': 'Заголовок должен содержать ровно 12 байт.',
  'The payload must contain 1–128 bytes.': 'Данные должны содержать от 1 до 128 байт.', 'Transport selector must be 01 or 02.': 'Селектор транспорта должен быть 01 или 02.',
};
const $ = id => document.getElementById(id), t = key => getLanguage() === 'ru' ? ru[key] ?? key : key;
const spaced = bytes => toHex(bytes).toUpperCase().match(/../g)?.join(' ') ?? '';
let index = 0;
try { const saved = Number(localStorage.getItem('wqv-swan.step')); if (Number.isInteger(saved) && SWAN_PLAN[saved]) index = saved; } catch {}
let store, adapter, active, journal, trigger, controller, unlock, busy = false, broken = false, attempts = [], packetError = null;
let statusKey = 'Opening the journal…', statusDetail = '', statusError = false;
const journals = new Map();

function status(key, detail = '', error = false) {
  statusKey = key; statusDetail = detail; statusError = error;
  $('status').textContent = t(key) + (detail ? '\n' + detail : ''); $('status').classList.toggle('error', error);
}
function packet() { return encodeSwanPacket({ variant: Number($('variant').value), header: packetBytes($('header').value), payload: packetBytes($('payload').value) }); }
function preview() {
  try {
    const bytes = packet(); packetError = null; $('frame-preview').textContent = spaced(bytes);
    $('packet-size').textContent = getLanguage() === 'ru' ? `Полный пакет: ${bytes.length} байт · SUM8 и дополнения вычислены` : `Complete packet: ${bytes.length} bytes · SUM8 and complements calculated`;
  } catch (error) { packetError = error; $('frame-preview').textContent = t(error.message); $('packet-size').textContent = ''; }
}
function restore() {
  const preset = swanPreset(index); $('variant').value = preset.variant; $('header').value = spaced(preset.header); $('payload').value = spaced(preset.payload);
  preview();
}
function selected() { return active && (! $('attempts').value || active.id === $('attempts').value) ? active : attempts.find(item => item.id === $('attempts').value); }
function render() {
  const opened = Boolean(adapter?.opened), running = busy && active?.status === 'running';
  document.documentElement.lang = getLanguage(); $('language').value = getLanguage();
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
  $('step-heading').textContent = `${index + 1}. ${t(SWAN_PLAN[index].label)}`;
  $('step-note').textContent = t(SWAN_PLAN[index].watchPresent ? 'Restart IR → SWAN → RECEIVE. Face the watch toward SigmaTel at 5–10 cm. Leave the final RECEIVE activation until recording has started.' : 'Keep the watch out of the IR path for this control. Its purpose is to record adapter echo and background bytes.');
  $('ready-label').textContent = t(SWAN_PLAN[index].watchPresent ? 'SWAN RECEIVE is selected; the final activation is still pending.' : 'The watch is out of the IR path.');
  $('plan').replaceChildren(...SWAN_PLAN.map((step, at) => {
    const li = document.createElement('li'), button = document.createElement('button'); button.textContent = t(step.label);
    li.setAttribute('aria-current', at === index ? 'step' : 'false'); button.disabled = busy || opened || !store;
    button.onclick = () => choose(at); li.append(button); return li;
  }));
  for (const id of ['variant', 'header', 'payload', 'restore']) $(id).disabled = busy || opened;
  for (const id of ['prepare', 'reset']) $(id).disabled = !store || broken || busy || opened || !navigator.usb || Boolean(packetError);
  $('release').disabled = busy || !opened; $('ready').disabled = busy || !opened;
  $('start').disabled = busy || !opened || !$('ready').checked || broken;
  $('send-packet').disabled = !running || trigger?.state !== 'waiting' || broken;
  $('stop').disabled = !running; $('seconds').disabled = busy;
  $('previous').disabled = busy || opened || !store || index === 0; $('next').disabled = busy || opened || !store || index === SWAN_PLAN.length - 1;
  $('attempts').disabled = busy || opened; $('notes').disabled = busy; $('save-notes').disabled = busy || !selected();
  $('export').disabled = !selected(); $('export-all').disabled = !attempts.length && !active;
  $('usb-state').textContent = opened ? `${adapter.description.name} · ${adapter.description.usbId}` : '—';
  preview(); status(statusKey, statusDetail, statusError);
}
function choose(next) {
  if (busy || adapter?.opened || !SWAN_PLAN[next]) return;
  index = next; try { localStorage.setItem('wqv-swan.step', index); } catch {}
  $('ready').checked = false; restore(); render();
}
function showResult() {
  const item = selected(); $('notes').value = item?.notes ?? ''; $('result').textContent = item ? JSON.stringify(item, null, 2) : '—';
  const result = item?.result, analysis = item?.analysis;
  $('summary').textContent = !result ? '' : getLanguage() === 'ru' ?
    `Отправлено пакетов: ${result.txCompleted}\nRX: ${result.rxBytes} байт · совпадений с TX: ${analysis?.txMatches.length ?? 0} · пакетов с верной SUM8: ${analysis?.packets.length ?? 0}\nСовпадение с TX может быть эхом. Источник остальных байтов пока не установлен.` :
    `Packets sent: ${result.txCompleted}\nRX: ${result.rxBytes} bytes · exact TX matches: ${analysis?.txMatches.length ?? 0} · SUM8-valid packets: ${analysis?.packets.length ?? 0}\nTX matches may be echo. The source of other bytes is not established.`;
}
async function refresh(id = active?.id) {
  attempts = (await store.attempts()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (active) attempts = [...attempts.filter(item => item.id !== active.id), active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('attempts').replaceChildren(...attempts.map(item => {
    const option = document.createElement('option'); option.value = item.id;
    option.textContent = `${item.createdAt.slice(0, 19)} UTC · ${t(SWAN_PLAN[item.stepIndex]?.label ?? item.stepId)} · ${item.status}`; return option;
  }));
  if (attempts.length) $('attempts').value = attempts.some(item => item.id === id) ? id : attempts.at(-1).id;
  showResult(); render();
}
function storageError(error) {
  broken = true; controller?.abort(); adapter?.close().catch(() => {});
  status('Journal error. Recording stopped; the in-memory ZIP is still available.', String(error), true); render();
}
async function save() { try { await store.save(active); } catch (error) { storageError(error); throw error; } }
async function prepare(reset = false) {
  if (busy || adapter?.opened || !store || broken) return;
  let bytes;
  try { bytes = packet(); } catch (error) { status(error.message, '', true); return; }
  busy = true; active = null; journal = null; $('ready').checked = false; status('Preparing SigmaTel…'); render();
  controller = new AbortController();
  try {
    const devices = await navigator.usb.getDevices();
    const device = devices.find(item => item.vendorId === 0x066f && item.productId === 0x4200) ?? await navigator.usb.requestDevice({ filters: [{ vendorId: 0x066f, productId: 0x4200 }] });
    const step = SWAN_PLAN[index];
    active = { id: crypto.randomUUID(), kind: 'serial', packetFormat: SWAN_FORMAT, createdAt: new Date().toISOString(), status: 'preparing',
      stepIndex: index, stepId: step.id, watchPresent: step.watchPresent, watchMode: 'swan-receive', baud: 9600,
      probe: 'packet', probeHex: toHex(bytes), transmission: 'manual', repeatMs: 0, notes: '',
      packet: { variant: Number($('variant').value), headerHex: toHex(packetBytes($('header').value)), payloadHex: toHex(packetBytes($('payload').value)), synthetic: true },
      device: { vendorId: device.vendorId, productId: device.productId, productName: device.productName },
      capture: { originalUSBBytes: true, automaticNextStep: false, echoRemoval: false, automaticReplies: false } };
    await save(); journal = new Journal(store, active, storageError); journals.set(active.id, journal);
    const attempt = active, record = journal.record, counters = { readCount: 0, nonemptyReads: 0, emptyReads: 0, rxBytes: 0 };
    adapter = new SigmaTel(captureUSB(device, record, () => ({ baud: adapter?.baud ?? null, phase: attempt.status }), { counters }),
      { log: (level, message) => record('log', { level, message: String(message) }) });
    adapter.usbStats = counters; record('attempt-prepared', { step: step.id, plannedHex: active.probeHex, watchPresent: step.watchPresent });
    if (reset) { await adapter.io(adapter.device.open(), 'opening USB for reset'); await adapter.io(adapter.device.reset(), 'resetting SigmaTel USB'); }
    await adapter.open(); await adapter.setupSIR(); controller.signal.throwIfAborted();
    active.status = 'prepared'; active.adapter = adapter.description; active.chipRevision = adapter.revision;
    record('packet-armed', { baud: adapter.baud, chipRevision: adapter.revision, dataHex: active.probeHex });
    await journal.drain(); await save(); status('USB ready. Start recording first.');
  } catch (error) {
    if (active) { active.status = 'preparation-error'; active.error = String(error); journal?.record('preparation-error', { error: String(error) }); }
    await adapter?.close().catch(() => {}); adapter = null;
    if (active && !broken) { await journal?.drain(); await save(); }
    if (!broken) status(String(error), '', true);
  } finally { busy = false; if (active && !broken) await refresh(); else render(); }
}
async function release() {
  if (busy || !adapter) return;
  busy = true; render();
  try { await adapter.close(); active.status = 'released-without-recording'; journal.record('usb-released'); await journal.drain(); await save(); status('USB released.'); }
  catch (error) { journal.record('cleanup-error', { error: String(error) }); status(String(error), '', true); }
  finally { adapter = null; busy = false; $('ready').checked = false; await refresh(); }
}
async function run() {
  if (busy || !adapter?.opened || !$('ready').checked || broken || !$('seconds').reportValidity()) return;
  busy = true; active.status = 'running'; active.startedAt = new Date().toISOString(); active.notes = $('notes').value;
  active.captureWindowMs = Number($('seconds').value) * 1000; controller = new AbortController(); trigger = new ManualSerialTrigger();
  $('ready').checked = false;
  try {
    await save(); journal.record('watch-setup-confirmed', { watchPresent: active.watchPresent });
    status(active.watchPresent ? 'Recording. Activate RECEIVE, then send the packet.' : 'Control recording. Keep the watch away and send the packet.');
    const recording = probeSerialPacket(adapter, { bytes: fromHex(active.probeHex), watchMode: active.watchMode, durationMs: active.captureWindowMs },
      { signal: controller.signal, record: journal.record, manualTrigger: trigger });
    render(); active.result = await recording; active.status = active.result.status;
  } catch (error) { active.status = controller.signal.aborted ? 'interrupted' : 'error'; active.error = String(error); journal.record('step-error', { error: String(error), stack: error.stack }); }
  finally {
    trigger.close();
    try { await adapter.close(); } catch (error) { active.cleanupError = String(error); journal.record('cleanup-error', { error: String(error) }); }
    if (active.result) { active.result = finishSerialCapture(active.result, journal.events); active.status = active.result.status; }
    active.finishedAt = new Date().toISOString(); active.analysis = analyseSwanCapture(journal.events, fromHex(active.probeHex));
    active.captureMayBeIncomplete = !['captured', 'no-data'].includes(active.status) || Boolean(active.cleanupError);
    active.usbCounters = { ...adapter.usbStats }; active.counters = { ...adapter.serialStats, fifoRecoveries: adapter.fifoRecoveries };
    journal.record('step-finished', { status: active.status, analysis: active.analysis });
    if (!broken) { try { await journal.drain(); await save(); } catch {} }
    busy = false; adapter = null;
    if (!broken) {
      status(active.status === 'probe-not-sent' ? 'Packet was not transmitted. Check the attempt details.' : active.status === 'error' ? String(active.error ?? active.result?.error?.message ?? 'USB error') : 'Recording finished. Save the ZIP and restart the watch before another step.', '', active.status === 'error');
      await refresh();
    } else { attempts = [...attempts.filter(item => item.id !== active.id), active]; render(); }
    showResult(); updateStats();
  }
}
function updateStats() {
  const stats = adapter?.serialStats ?? active?.result;
  if (stats) $('stats').textContent = `TX ${stats.txCompleted}/${stats.txAttempts} · RX ${stats.rxBytes} B · ${getLanguage() === 'ru' ? 'до / после' : 'before / after'} ${stats.rxBeforeProbe}/${stats.rxAfterProbe} · USB ${stats.readCount} · ${getLanguage() === 'ru' ? 'пустых' : 'empty'} ${stats.emptyReads}`;
  if (journal) $('events').textContent = journal.events.filter(event => !['usb-call', 'usb-result'].includes(event.kind)).slice(-12).map(event => JSON.stringify(event)).join('\n');
  const sent = journal?.events.some(event => event.kind === 'serial-tx-complete');
  if (busy && active?.status === 'running' && sent && statusKey !== 'Packet transmitted; recording continues without automatic replies.') status('Packet transmitted; recording continues without automatic replies.');
  $('send-packet').disabled = !busy || active?.status !== 'running' || trigger?.state !== 'waiting' || broken;
}
async function exportZIP(all = false) {
  const items = all ? [...attempts.filter(item => item.id !== active?.id), ...(active ? [active] : [])] : [selected()].filter(Boolean);
  if (!items.length) return;
  try {
    const files = [];
    for (const item of items) {
      const live = journals.get(item.id), events = live?.events.slice() ?? await store.events(item.id);
      const meta = { ...item, exportedAt: new Date().toISOString(), snapshot: ['preparing', 'prepared', 'running'].includes(item.status), storageError: live?.error ? String(live.error) : null };
      const prefix = all ? `${item.createdAt.replace(/[:.]/g, '-')}-${item.stepId}-${item.id}/` : '';
      files.push(...swanAttemptFiles(meta, events).map(file => ({ ...file, name: prefix + file.name })));
    }
    const url = URL.createObjectURL(zipFiles(files)), link = document.createElement('a');
    link.href = url; link.download = `WQV-SWAN-packets-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { status(String(error), '', true); }
}
$('prepare').onclick = () => prepare(); $('reset').onclick = () => prepare(true); $('release').onclick = release; $('start').onclick = run;
$('ready').onchange = render; $('previous').onclick = () => choose(index - 1); $('next').onclick = () => choose(index + 1);
$('restore').onclick = () => { restore(); render(); }; for (const id of ['variant', 'header', 'payload']) $(id).addEventListener('input', () => { preview(); render(); });
$('send-packet').onclick = () => { if (busy && active?.status === 'running' && trigger.request()) { journal.record('serial-manual-send-request', { dataHex: active.probeHex, watchPresent: active.watchPresent }); status('Packet queued; waiting for the current USB read.'); render(); } };
$('stop').onclick = () => { journal?.record('manual-stop'); controller?.abort(); adapter?.close().catch(() => {}); };
$('attempts').onchange = () => { showResult(); render(); }; $('export').onclick = () => exportZIP(); $('export-all').onclick = () => exportZIP(true);
$('save-notes').onclick = async () => { const item = selected(); if (!item) return; try { item.notes = $('notes').value; await store.save(item); status('Notes saved.'); showResult(); } catch (error) { storageError(error); } };
$('language').onchange = () => { setLanguage($('language').value); render(); showResult(); };
setInterval(() => { if (journal && !journal.error) journal.flush().catch(() => {}); updateStats(); }, 250);
window.addEventListener('pagehide', () => { controller?.abort(); adapter?.close().catch(() => {}); unlock?.(); });
async function initialize() {
  restore(); render();
  try {
    if (navigator.locks && !await new Promise((resolve, reject) => {
      navigator.locks.request('wqv-command-research', { ifAvailable: true }, lock => { resolve(Boolean(lock)); if (lock) return new Promise(releaseLock => { unlock = releaseLock; }); }).catch(reject);
    })) { status('Another research tab is open. Close it before preparing USB.', '', true); return; }
    store = await openResearchStore('wqv-swan-research');
    for (const item of await store.attempts()) if (['preparing', 'prepared', 'running'].includes(item.status)) { item.status = 'interrupted-by-page-close'; item.captureMayBeIncomplete = true; await store.save(item); }
    await refresh(); status(navigator.usb ? 'Prepare USB before activating the watch.' : 'WebUSB is unavailable in this browser.', '', !navigator.usb); render();
  } catch (error) { storageError(error); }
}
initialize();
