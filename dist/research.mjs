import { SigmaTel } from './sigmatel.mjs';
import { getLanguage, setLanguage } from './i18n.mjs';
import { toHex } from './formats.mjs';
import { zipFiles } from './zip.mjs';
import { PROBE_PLAN, ManualSteps, ResearchClient, captureUSB, attemptFiles } from './research-core.mjs';
import { openResearchStore, Journal } from './research-store.mjs';

const $ = id => document.getElementById(id);
const ru = {
  'Command research': 'Исследование команд', 'Back to WQV Link': 'К WQV Link', Language: 'Язык', Steps: 'Шаги', Step: 'Шаг',
  'The unknown commands may change watch data or settings. Their effects are not established. Each step sends one command with no parameters; this is not a firmware reader.': 'Неизвестные команды могут менять данные или настройки часов. Их действие не установлено. На каждом шаге отправляется один код без параметров; это не программа чтения прошивки.',
  'AA is a control request. AD exists in Casio Link 3. The remaining codes are guesses from gaps or neighboring numbers.': 'AA — контрольный запрос. AD найден в Casio Link 3. Остальные коды выбраны по пропускам или соседним номерам.',
  '1. Prepare USB first': '1. Сначала подготовьте USB',
  'Disconnect this adapter in other apps. Prepare USB before enabling transfer mode on the watch. No watch command is sent during preparation.': 'Отключите адаптер в других программах. Подготовьте USB до включения обмена на часах. При подготовке команды часам не отправляются.',
  'Prepare SigmaTel USB…': 'Подготовить SigmaTel USB…', 'Release USB': 'Освободить USB',
  '2. Reset the watch, then run this step': '2. Перезапустите обмен на часах и выполните шаг',
  'Exit the previous transfer session on the watch. Select IR → PC → F / REMOTE again and face the watch toward the adapter. No factory reset is needed.': 'Выйдите из предыдущего сеанса обмена на часах. Снова выберите IR → ПК → F / REMOTE и поставьте часы напротив адаптера. Сброс к заводским настройкам не нужен.',
  'I restarted IR → PC for this step; the watch is ready now.': 'Я заново включил IR → ПК для этого шага; часы готовы сейчас.',
  'Response window, seconds': 'Время сбора ответа, секунд', 'Watch ready — send': 'Часы готовы — отправить', Stop: 'Остановить',
  'One application command, no automatic retransmission. Normal IrDA discovery, negotiation and acknowledgements are still sent. The page stops after the response window and releases USB; it does not advance to another command.': 'Прикладная команда отправляется один раз, без автоматического повтора. Поиск IrDA, согласование и подтверждения кадров работают как обычно. После сбора ответа страница останавливается и освобождает USB; следующая команда сама не запускается.',
  'Retry this step': 'Повторить этот шаг', 'Skip step →': 'Пропустить шаг →', 'Next step →': 'Следующий шаг →',
  'Opening the local journal…': 'Открываем локальный журнал…', 'Raw results': 'Сырые результаты', Attempt: 'Попытка',
  'Save attempt ZIP…': 'Сохранить ZIP попытки…', 'Save all attempts ZIP…': 'Сохранить ZIP всех попыток…',
  'Every USB read and write is saved locally, including empty reads, errors and bytes rejected by CRC. ZIPs contain the original binary streams, timestamps, transfer boundaries, decoded frames and the complete application response. Nothing is uploaded.': 'Все чтения и записи USB сохраняются локально, включая пустые чтения, ошибки и байты, отброшенные по CRC. В ZIP — исходные двоичные потоки, время и границы передач, разобранные кадры и полный прикладной ответ. На сервер ничего не отправляется.',
  'What happened on the watch?': 'Что происходило на экране часов?', 'Save notes': 'Сохранить заметки',
  'Recent events (exports include every event)': 'Последние события (в выгрузке — все события)',
  'Manual steps · SigmaTel 066f:4200 · WQV-3 module 2411': 'Ручные шаги · SigmaTel 066f:4200 · WQV-3 модуль 2411',
  'Control request; this WQV-3 previously returned only 0D.': 'Контрольный запрос; ранее эти WQV-3 ответили только 0D.',
  'Implemented in Casio Link 3. The client expects 0D and two status bytes. Not yet checked on this WQV-3.': 'Реализован в Casio Link 3. Клиент ожидает 0D и два байта статуса. На этих WQV-3 ещё не проверялся.',
  'Numbering gap. No command handler or payload format found in the PC software.': 'Пропуск в нумерации. Обработчик команды и формат параметров в программах ПК не найдены.',
  'Candidate by proximity to AA/AD only. No known meaning or parameter format.': 'Кандидат только по соседству с AA/AD. Назначение и формат параметров неизвестны.',
  'Prepare USB. Keep the watch out of transfer mode until the adapter is ready.': 'Подготовьте USB. Включать обмен на часах нужно после готовности адаптера.',
  'USB ready. Now restart IR → PC on the watch, tick the checkbox and send this command.': 'USB готов. Теперь заново включите IR → ПК на часах, отметьте готовность и отправьте эту команду.',
  'USB released. Restart IR → PC before a new attempt.': 'USB освобождён. Перед новой попыткой заново включите IR → ПК.',
  'Step finished. Reset the watch transfer session before continuing. The next step is manual.': 'Шаг завершён. Перед продолжением перезапустите обмен на часах. Переход к следующему шагу — вручную.',
  'Step interrupted. Raw data received so far is kept.': 'Шаг прерван. Уже полученные сырые данные сохранены.',
  'Local journal failed. The test was stopped. Save the attempt ZIP now; its in-memory trace is still available.': 'Ошибка локального журнала. Тест остановлен. Сохраните ZIP попытки сейчас: её журнал ещё доступен в памяти.',
  'WebUSB is unavailable. Use a desktop Chrome, Edge or Opera on HTTPS or localhost.': 'WebUSB недоступен. Откройте страницу в настольном Chrome, Edge или Opera по HTTPS либо на localhost.',
  'Notes saved.': 'Заметки сохранены.', 'Saved locally in this browser. A page reload does not start any command.': 'Сохранено локально в этом браузере. Перезагрузка страницы не запускает команды.',
  'Start from AA': 'Начать с AA', 'Another research tab is already open. Close it before using this page.': 'Уже открыта другая вкладка исследования. Закройте её перед работой с этой страницей.',
  'Events': 'Событий', 'Saved': 'Сохранено', 'Response bytes': 'Байт ответа', 'Command sent': 'Команда отправлена',
  'No application response': 'Прикладного ответа нет', 'This is an in-progress snapshot.': 'Это промежуточный снимок журнала.',
};
const t = key => getLanguage() === 'ru' ? ru[key] ?? key : key;
const codeHex = code => code.toString(16).padStart(2, '0').toUpperCase();
const evidence = {
  control: 'Control request; this WQV-3 previously returned only 0D.',
  client: 'Implemented in Casio Link 3. The client expects 0D and two status bytes. Not yet checked on this WQV-3.',
  gap: 'Numbering gap. No command handler or payload format found in the PC software.',
  neighbor: 'Candidate by proximity to AA/AD only. No known meaning or parameter format.',
};
let position = {};
try { position = JSON.parse(localStorage.getItem('wqv-research.position') || '{}'); } catch {}
const plan = new ManualSteps(position.index, position.done);
let store, adapter, client, controller, journal, active, busy = false, storageFailed = false, attempts = [], releasePageLock;
let statusKey = 'Opening the local journal…', statusDetail = '', statusError = false;
const journals = new Map();

function status(key, detail = '', error = false) {
  statusKey = key; statusDetail = detail; statusError = error;
  $('status').textContent = t(key) + (detail ? '\n' + detail : '');
  $('status').classList.toggle('error', error);
}
function savePosition() {
  try { localStorage.setItem('wqv-research.position', JSON.stringify({ index: plan.index, done: plan.state === 'done' })); } catch {}
}
function render() {
  const ready = Boolean(adapter?.opened), done = plan.state === 'done';
  document.documentElement.lang = getLanguage(); $('language').value = getLanguage();
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
  $('step-heading').textContent = `${t('Step')} ${plan.index + 1} / ${PROBE_PLAN.length} · ${codeHex(plan.step.code)}`;
  $('step-evidence').textContent = t(evidence[plan.step.evidence]);
  $('steps').replaceChildren(...PROBE_PLAN.map((step, i) => {
    const li = document.createElement('li'); li.textContent = codeHex(step.code);
    if (i === plan.index) li.setAttribute('aria-current', 'step');
    if (i < plan.index) li.className = 'done';
    return li;
  }));
  $('prepare').disabled = !store || busy || ready || done || storageFailed || !navigator.usb;
  $('disconnect').disabled = busy || !ready;
  $('watch-ready').disabled = !ready || busy || done;
  $('response-seconds').disabled = busy || ready && done;
  $('send').textContent = t('Watch ready — send') + ' ' + codeHex(plan.step.code);
  $('send').disabled = !ready || busy || done || storageFailed || !$('watch-ready').checked;
  $('stop').disabled = !busy || !adapter;
  $('next').disabled = busy || ready || !done || plan.index === PROBE_PLAN.length - 1 || storageFailed;
  $('skip').disabled = !store || busy || ready || plan.index === PROBE_PLAN.length - 1;
  $('retry').disabled = busy || ready || !done;
  $('restart-plan').disabled = !store || busy || ready;
  $('attempts').disabled = busy || ready;
  $('export-one').disabled = !$('attempts').value;
  $('export-all').disabled = !attempts.length;
  $('save-notes').disabled = busy || !$('attempts').value;
  $('notes').disabled = busy;
  $('usb-state').textContent = ready ? `${adapter.description.name} · ${adapter.description.usbId}` : '—';
  $('storage-state').textContent = t('Saved locally in this browser. A page reload does not start any command.');
  status(statusKey, statusDetail, statusError);
}
function drawCapture() {
  if (!journal) return;
  const a = adapter;
  $('capture-stats').textContent = `${t('Events')}: ${journal.events.length} · ${t('Saved')}: ${journal.saved}` +
    (a ? ` · ${a.baud ?? '—'} bit/s · RX ${a.rxBytes} B · CRC ${a.decoder.badCRC} · recovered ${a.decoder.recoveredFrames}` : '');
  $('recent').textContent = journal.events.slice(-14).map(event => JSON.stringify(event)).join('\n');
}
function storageError(error) {
  storageFailed = true; controller?.abort(error);
  adapter?.close().catch(() => {});
  status('Local journal failed. The test was stopped. Save the attempt ZIP now; its in-memory trace is still available.', String(error), true);
  render();
}
async function refreshAttempts(selected = $('attempts').value) {
  const saved = await store.attempts();
  const merged = new Map(saved.map(attempt => [attempt.id, attempt]));
  if (active) merged.set(active.id, active);
  attempts = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  showAttemptOptions(selected);
}
function showAttemptOptions(selected) {
  $('attempts').replaceChildren(...attempts.map(attempt => {
    const option = document.createElement('option'); option.value = attempt.id;
    option.textContent = `${attempt.createdAt.slice(0, 19).replace('T', ' ')} UTC · ${attempt.commandHex.toUpperCase()} · ${attempt.status}`;
    return option;
  }));
  if (attempts.some(attempt => attempt.id === selected)) $('attempts').value = selected;
  else if (attempts.length) $('attempts').value = attempts.at(-1).id;
  showReport(); render();
}
function selectedAttempt() { return attempts.find(attempt => attempt.id === $('attempts').value); }
function showReport() {
  const attempt = selectedAttempt();
  if (!attempt) { $('reply').textContent = '—'; return; }
  const result = attempt.result;
  $('reply').textContent = JSON.stringify({ status: attempt.status, commandHex: attempt.commandHex,
    commandAttempted: result?.commandAttempted ?? false, commandSent: result?.commandSent ?? false, responseBytes: result?.responseBytes ?? 0,
    responseHex: result?.responseHex ?? '', error: result?.error ?? attempt.error ?? null,
    cleanupError: attempt.cleanupError ?? null }, null, 2);
  $('notes').value = attempt.notes ?? '';
}
async function saveActive() {
  try { await store.save(active); }
  catch (error) { storageError(error); throw error; }
}
async function prepare() {
  if (busy || adapter?.opened || plan.state !== 'idle' || storageFailed) return;
  active = null; journal = null; $('capture-stats').textContent = ''; $('recent').textContent = '—';
  busy = true; $('watch-ready').checked = false; controller = new AbortController(); render();
  try {
    const devices = await navigator.usb.getDevices();
    const device = devices.find(d => d.vendorId === 0x066f && d.productId === 0x4200) ||
      await navigator.usb.requestDevice({ filters: [{ vendorId: 0x066f, productId: 0x4200 }] });
    controller.signal.throwIfAborted();
    active = { id: crypto.randomUUID(), format: 'wqv-command-research-v1', createdAt: new Date().toISOString(),
      commandHex: codeHex(plan.step.code).toLowerCase(), step: plan.index, status: 'preparing', notes: '',
      device: { vendorId: device.vendorId, productId: device.productId, productName: device.productName,
        manufacturerName: device.manufacturerName, serialNumber: device.serialNumber, deviceVersionMajor: device.deviceVersionMajor,
        deviceVersionMinor: device.deviceVersionMinor, deviceVersionSubminor: device.deviceVersionSubminor },
      request: { parametersHex: '', applicationTransmissions: 1, automaticRetransmission: false },
      capture: { originalUSBBytes: true, syntheticData: false, automaticNextStep: false } };
    await saveActive();
    journal = new Journal(store, active, storageError); journals.set(active.id, journal);
    const record = journal.record;
    record('attempt-prepared', { commandHex: active.commandHex });
    const attempt = active;
    let transport;
    transport = new SigmaTel(captureUSB(device, record, () => ({ baud: transport?.baud ?? null, phase: attempt.status })),
      { log: (level, message) => record('log', { level, message: String(message) }) });
    adapter = transport;
    await adapter.open(); controller.signal.throwIfAborted();
    active.status = 'prepared'; active.adapter = adapter.description; active.chipRevision = adapter.revision;
    await journal.drain(); await saveActive();
    status('USB ready. Now restart IR → PC on the watch, tick the checkbox and send this command.');
  } catch (error) {
    if (active?.status === 'preparing') { active.status = 'preparation-error'; active.error = String(error); }
    journal?.record('preparation-error', { error: String(error) });
    await adapter?.close().catch(() => {}); adapter = null;
    if (active && !storageFailed) { await journal?.drain(); await saveActive(); }
    if (!storageFailed) status(String(error), '', true);
  } finally {
    busy = false;
    if (store && !storageFailed) await refreshAttempts(active?.id);
    else if (active) { attempts = [...attempts.filter(attempt => attempt.id !== active.id), active]; showAttemptOptions(active.id); }
    render();
  }
}
async function release() {
  if (busy || !adapter) return;
  busy = true; render();
  try {
    await adapter.close();
    if (active.status === 'prepared') active.status = 'released-without-command';
    journal.record('usb-released'); await journal.drain(); await saveActive();
    status('USB released. Restart IR → PC before a new attempt.');
  } catch (error) { journal.record('cleanup-error', { error: String(error) }); status(String(error), '', true); }
  finally { adapter = null; busy = false; $('watch-ready').checked = false; await refreshAttempts(active.id); }
}
async function run() {
  if (busy || !adapter?.opened || !$('watch-ready').checked || plan.state !== 'idle' || storageFailed) return;
  const seconds = Number($('response-seconds').value);
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 30) { $('response-seconds').reportValidity(); return; }
  plan.begin(); busy = true; controller = new AbortController(); $('watch-ready').checked = false;
  active.status = 'running'; active.startedAt = new Date().toISOString(); active.responseWindowMs = seconds * 1000;
  active.notes = $('notes').value; render();
  const timer = setTimeout(() => { controller.abort(new Error('Overall step timeout (50 seconds).')); adapter?.close().catch(() => {}); }, 50000);
  client = new ResearchClient(adapter, { signal: controller.signal, record: journal.record,
    log: (level, message) => journal.record('log', { level, message: String(message) }),
    progress: (heading, detail) => status(String(heading), String(detail ?? '')) });
  try {
    await saveActive();
    journal.record('watch-ready', { responseWindowMs: seconds * 1000 });
    await client.openPrimary();
    active.model = client.model; active.negotiatedBaud = adapter.baud;
    active.result = await client.probe(plan.step.code, seconds * 1000);
    active.status = controller.signal.aborted ? 'interrupted' : active.result.status;
  } catch (error) {
    active.status = controller.signal.aborted ? 'interrupted' : 'error'; active.error = String(error);
    journal.record('step-error', { error: String(error), stack: error.stack });
  } finally {
    clearTimeout(timer);
    // Deliberately do not send a teardown application command after a probe.
    // The user restarts IR → PC manually; only the USB connection is closed.
    try { await adapter.close(); }
    catch (error) { active.cleanupError = String(error); journal.record('cleanup-error', { error: String(error) }); }
    active.finishedAt = new Date().toISOString();
    active.counters = { rxBytes: adapter.rxBytes, txFrames: adapter.txFrames, badCRC: adapter.decoder.badCRC,
      recoveredFrames: adapter.decoder.recoveredFrames, fifoRecoveries: adapter.fifoRecoveries };
    if (!active.result && client.probing) active.result = { commandAttempted: client.commandAttempted, commandSent: client.commandSent,
      responseHex: toHex(client.appBuffer), responseBytes: client.appBuffer.length };
    journal.record('step-finished', { status: active.status, counters: active.counters });
    if (!storageFailed) { try { await journal.drain(); await saveActive(); } catch {} }
    plan.finish(); savePosition(); busy = false; adapter = null;
    if (!storageFailed) {
      status(active.status === 'interrupted' ? 'Step interrupted. Raw data received so far is kept.' :
        'Step finished. Reset the watch transfer session before continuing. The next step is manual.', active.error ?? active.result?.error?.message ?? '', active.status === 'error' || Boolean(active.cleanupError));
      await refreshAttempts(active.id);
    } else { attempts = [...attempts.filter(attempt => attempt.id !== active.id), active]; showAttemptOptions(active.id); }
    drawCapture(); render();
  }
}
function navigate(kind) {
  if (busy || adapter?.opened) return;
  journal?.record('manual-navigation', { action: kind });
  if (kind === 'retry') plan.retry(); else plan.next(kind === 'skip');
  savePosition(); $('watch-ready').checked = false;
  status('Prepare USB. Keep the watch out of transfer mode until the adapter is ready.'); render();
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function exportAttempts(all) {
  try {
    const selected = all ? attempts : [selectedAttempt()].filter(Boolean), files = [];
    for (const attempt of selected) {
      const live = journals.get(attempt.id);
      // Current memory is authoritative even when IndexedDB has failed or is behind.
      const events = live ? live.events.slice() : await store.events(attempt.id);
      const meta = { ...attempt, exportedAt: new Date().toISOString(), snapshot: attempt.status === 'running',
        storageError: live?.error ? String(live.error) : null };
      const folder = `${attempt.createdAt.replace(/[:.]/g, '-')}-${attempt.commandHex}-${attempt.id}`;
      for (const file of attemptFiles(meta, events)) files.push({ ...file, name: `${folder}/${file.name}` });
    }
    download(zipFiles(files), `WQV-command-research-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  } catch (error) { status(String(error), '', true); }
}

$('prepare').onclick = () => prepare().catch(error => status(String(error), '', true));
$('disconnect').onclick = () => release().catch(error => status(String(error), '', true));
$('send').onclick = () => run().catch(error => status(String(error), '', true));
$('stop').onclick = () => { journal?.record('manual-stop'); controller?.abort(new DOMException('Stopped by user.', 'AbortError')); adapter?.close().catch(() => {}); };
$('watch-ready').onchange = render;
for (const kind of ['next', 'skip', 'retry']) $(kind).onclick = () => navigate(kind);
$('restart-plan').onclick = () => {
  if (busy || adapter?.opened) return;
  plan.index = 0; plan.state = 'idle'; savePosition(); $('watch-ready').checked = false;
  status('Prepare USB. Keep the watch out of transfer mode until the adapter is ready.'); render();
};
$('attempts').onchange = () => { showReport(); render(); };
$('export-one').onclick = () => exportAttempts(false); $('export-all').onclick = () => exportAttempts(true);
$('save-notes').onclick = async () => {
  const attempt = selectedAttempt(); if (!attempt) return;
  attempt.notes = $('notes').value;
  try { await store.save(attempt); status('Notes saved.'); } catch (error) { storageError(error); }
};
$('language').onchange = () => { setLanguage($('language').value); render(); };
setInterval(() => {
  for (const item of journals.values()) if (!item.error) item.flush().catch(() => {});
  drawCapture();
}, 250);
window.addEventListener('pagehide', () => { controller?.abort(); adapter?.close().catch(() => {}); releasePageLock?.(); });

async function acquirePageLock() {
  if (!navigator.locks) return true;
  return new Promise((resolve, reject) => {
    navigator.locks.request('wqv-command-research', { ifAvailable: true }, lock => {
      resolve(Boolean(lock));
      if (lock) return new Promise(release => { releasePageLock = release; });
    }).catch(reject);
  });
}

async function initialize() {
  render();
  try {
    if (!await acquirePageLock()) { status('Another research tab is already open. Close it before using this page.', '', true); return; }
    store = await openResearchStore();
    for (const attempt of await store.attempts()) {
      if (['preparing', 'prepared', 'running'].includes(attempt.status)) {
        attempt.status = 'interrupted-by-page-close'; attempt.captureMayBeIncomplete = true;
        await store.save(attempt);
      }
    }
    await refreshAttempts();
    status(navigator.usb ? 'Prepare USB. Keep the watch out of transfer mode until the adapter is ready.' :
      'WebUSB is unavailable. Use a desktop Chrome, Edge or Opera on HTTPS or localhost.', '', !navigator.usb);
    render();
  } catch (error) { storageError(error); }
}
initialize();
