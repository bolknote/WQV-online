import { SigmaTel } from './sigmatel.mjs';
import { CSI_PROFILE, IMAGE_CAPABILITIES, IrTranPReceiver } from './irtranp-core.mjs';
import { IrTranPIASProbe } from './irtranp-ias.mjs';
import { IrTranPCSIProbe, CSI_QUERIES } from './irtranp-csi.mjs';
import { IrTranPActiveReceiver } from './irtranp-active.mjs';
import { IrTranPSender, validateSendFile } from './irtranp-send.mjs';
import { FEATURE_CASES, featureCase } from './irtranp-metadata.mjs';
import { createFeatureFiles } from './irtranp-feature-images.mjs';
import { listen } from './listen-core.mjs';
import { RECOVERY_MODES, TEST_RATES } from './irtranp-suite.mjs';
import { SUITE_RU, IrTranPSuiteUI } from './irtranp-suite-ui.mjs';
import { featureInstructions, featureSendButtonText, missingPhotoInstructions, UPLOAD_ACKNOWLEDGED, TWO_UPLOADS_ACKNOWLEDGED } from './irtranp-presentation.mjs';
import { captureUSB, attemptFiles } from './research-core.mjs';
import { openResearchStore, Journal } from './research-store.mjs';
import { fromHex, toHex, sha256, jpegFromUPF } from './formats.mjs';
import { zipFiles } from './zip.mjs';
import { getLanguage, setLanguage } from './i18n.mjs';

const $ = id => document.getElementById(id);
const ru = {
  ...SUITE_RU,
  'Send a watch photo back': 'Вернуть снимок на часы', 'Photo to send': 'Снимок для отправки',
  'Use a UPF received from this watch. Its bytes are sent unchanged. This adds the selected number of copies to the watch.':
    'Выберите UPF, полученный с этих часов. Его байты отправятся без изменений. На часы добавится выбранное число копий.',
  'Use last received photo': 'Взять последний полученный снимок', 'Open UPF…': 'Открыть UPF…', Copies: 'Копии',
  'One copy': 'Одна копия', 'Two copies in one connection': 'Две копии за одно соединение',
  'SCEP PUT packets': 'Пакеты SCEP для PUT', 'CSI: use peer limit': 'Как CSI: предел часов', 'Split at 512 bytes': 'Делить по 512 байт',
  'Choose a watch UPF before preparing USB.': 'Перед подготовкой USB выберите UPF с часов.',
  'No received watch photo is saved yet. Open a UPF file.': 'Полученного снимка пока нет в журнале. Откройте файл UPF.',
  'Photo ready. Prepare USB, then select OTHERS RECEIVE on the watch.': 'Снимок готов. Подготовьте USB, затем выберите OTHERS RECEIVE на часах.',
  'Loading the last received photo…': 'Открываем последний полученный снимок…',
  'IAS → capabilities → unchanged UPF → PUT reply → disconnect. The watch will receive a new photo copy.':
    'IAS → возможности → исходный UPF → ответ на PUT → отключение. На часы запишется копия снимка.',
  'Sender started. Now activate OTHERS RECEIVE on the watch.': 'Отправка запущена. Теперь включите OTHERS RECEIVE на часах.',
  'USB ready. Start the test here, then activate OTHERS RECEIVE on the watch.': 'USB готов. Запустите тест здесь, затем включите OTHERS RECEIVE на часах.',
  'Sending the UPF file': 'Отправляем файл UPF', 'PUT acknowledged': 'Получено подтверждение PUT',
  'The watch rejected PUT; closing the session': 'Часы отказали в записи PUT; закрываем сеанс',
  'RR retries': 'Повторы RR',
  'The watch requested a disconnect': 'Часы запросили разрыв соединения',
  'PUT was rejected or blocked by the peer capabilities. Save the ZIP.': 'PUT отклонён или не отправлен из-за возможностей часов. Сохраните ZIP.',
  'The watch acknowledged the upload, but the session did not close cleanly. Save the ZIP.': 'Часы подтвердили передачу, но сеанс не закрылся штатно. Сохраните ZIP.',
  'No complete PUT confirmation. The photo may have been written. Save the ZIP before retrying.': 'Полного подтверждения PUT нет. Снимок мог записаться. Перед повтором сохраните ZIP.',
  'IR research': 'Исследование ИК', Language: 'Язык', 'IrTran-P receiver': 'Приёмник IrTran-P',
  'Test OTHERS mode step by step. Every USB byte and protocol reply is saved locally.': 'Проверка режима OTHERS по шагам. Все байты USB и ответы протокола сохраняются локально.',
  'OTHERS / IrTran-P research': 'Исследование OTHERS / IrTran-P', Test: 'Тест',
  'Connect and read IAS': 'Подключение и чтение IAS', 'CSI image receiver': 'Приём снимка как CSI',
  'CSI capability queries': 'CSI: запрос возможностей',
  'Connect, then receive an image': 'Подключиться и принять снимок',
  'Image capabilities': 'Параметры снимка', 'CSI: 640 × 480': 'CSI: 640 × 480',
  'Nokia: original image size': 'Nokia: исходный размер',
  'Only the image capability reply changes. Device identity and connection settings stay the same. Local capture limit: 128 KiB.': 'Меняется только ответ о параметрах снимка. Имя устройства и настройки соединения одинаковы. Предел локальной записи: 128 КиБ.',
  'IAS → IrCOMM → wait for the watch to start SCEP and send an image. No outgoing image-transfer request.': 'IAS → IrCOMM → ждём, когда часы откроют SCEP и отправят снимок. Команда передачи изображения с нашей стороны не посылается.',
  'OTHERS RECEIVE is a connection control: the page opens IrCOMM and waits. This test sends no image to the watch.': 'OTHERS RECEIVE — контроль подключения: страница открывает IrCOMM и ждёт. Этот тест не отправляет снимок на часы.',
  'Connected. Waiting for the watch to start SCEP': 'Подключено. Ждём открытия SCEP со стороны часов',
  'Active receiver started. Now press the front button on the watch.': 'Активный приёмник запущен. Теперь нажмите переднюю кнопку часов.',
  'Connection closed. No complete image was received. Save the ZIP.': 'Соединение закрыто. Полного снимка не получено. Сохраните ZIP.',
  'IAS → IrCOMM → SCEP as CASSIOPEIA → RIMG, RINF, RCMD → disconnect. No image is sent.': 'IAS → IrCOMM → SCEP от имени CASSIOPEIA → RIMG, RINF, RCMD → отключение. Снимок не отправляется.',
  'Discovery → SNRM → UA → IAS service queries → disconnect. No IrCOMM channel or image transfer.': 'Поиск → SNRM → UA → запросы служб IAS → отключение. Без открытия IrCOMM и передачи снимков.',
  'CASSIOPEIA receiver profile · SCEP 4096 B · 128 KiB · JPEG 4:2:0': 'Профиль приёмника CASSIOPEIA · SCEP 4096 Б · 128 КиБ · JPEG 4:2:0',
  'Select IR → OTHERS → RECEIVE. Face the watch toward SigmaTel, about 5–10 cm away. Start the test here, then activate reception on the watch.': 'Выберите IR → OTHERS → RECEIVE. Поставьте часы напротив SigmaTel на расстоянии 5–10 см. Начните тест здесь, затем включите приём на часах.',
  'Receive an image from OTHERS SEND using the CSI Image Viewer 2.5 profile. Every USB byte and protocol reply is saved locally.': 'Приём снимка в режиме OTHERS SEND с параметрами CSI Image Viewer 2.5. Все байты USB и ответы протокола сохраняются локально.',
  '1. Prepare USB first': '1. Сначала подготовьте USB',
  'Disconnect SigmaTel in other apps. Keep the watch out of transfer mode until USB is ready.': 'Отключите SigmaTel в других приложениях. Включайте обмен на часах после подготовки USB.',
  'Prepare SigmaTel USB…': 'Подготовить SigmaTel USB…', 'Reset SigmaTel USB…': 'Сбросить SigmaTel USB…', 'Release USB': 'Освободить USB',
  '2. Set the watch mode': '2. Выберите режим часов', 'Watch mode': 'Режим часов',
  'OTHERS RECEIVE (discovery only)': 'OTHERS RECEIVE (только поиск)',
  'OTHERS RECEIVE can answer discovery, but this receiver does not initiate a connection or send images to the watch. This mode records discovery only.': 'OTHERS RECEIVE может отвечать на поиск, но этот приёмник не открывает соединение со своей стороны и не отправляет снимки на часы. В этом режиме записывается только поиск.',
  'Select IR → OTHERS → SEND and choose an image. Face the watch toward SigmaTel, about 5–10 cm away. Start the receiver here before pressing the final front button on the watch.': 'Выберите IR → OTHERS → SEND и снимок. Поставьте часы напротив SigmaTel на расстоянии 5–10 см. Начните приём здесь перед последним нажатием передней кнопки часов.',
  'The watch is positioned. I will press its front button after starting the receiver.': 'Часы напротив адаптера. Я нажму переднюю кнопку после запуска приёмника.',
  'The watch is positioned. I will press its front button after starting the test.': 'Часы напротив адаптера. Я нажму переднюю кнопку после запуска теста.',
  'Test window, seconds': 'Время теста, секунд',
  'Receive window, seconds': 'Окно приёма, секунд', 'Start receiver': 'Начать приём', Stop: 'Остановить', 'Mark watch button press': 'Отметить нажатие на часах',
  'Discovery starts at 9600 bit/s. The connection may negotiate up to 115200 bit/s. The 4096-byte SCEP limit is separate from the link speed.': 'Поиск начинается на 9600 бит/с. При соединении возможен переход до 115200 бит/с. Предел SCEP в 4096 байт не связан со скоростью.',
  'Raw results': 'Сырые результаты', Attempt: 'Попытка', 'Save attempt ZIP…': 'Сохранить ZIP попытки…',
  'What happened on the watch?': 'Что происходило на экране часов?', 'Save notes': 'Сохранить заметки',
  'Recent events (exports include every event)': 'Последние события (в выгрузке — все события)',
  'Opening local journal…': 'Открываем локальный журнал…',
  'Another research tab is open. Close it before preparing USB.': 'Открыта другая исследовательская вкладка. Закройте её перед подготовкой USB.',
  'Prepare USB before activating the watch.': 'Подготовьте USB перед включением часов.',
  'Preparing SigmaTel…': 'Подготавливаем SigmaTel…',
  'USB ready. Select OTHERS SEND and a photo; do not press the final SEND button yet.': 'USB готов. Выберите OTHERS SEND и снимок; последнее нажатие SEND пока не делайте.',
  'USB ready. Select the watch mode, then start the test before pressing its front button.': 'USB готов. Выберите режим часов и начните тест перед нажатием передней кнопки.',
  'USB released. Restart the watch mode before trying again.': 'USB освобождён. Перед повтором заново включите обмен на часах.',
  'Receiver started. Now press the final SEND button on the watch.': 'Приёмник запущен. Теперь нажмите последнюю кнопку SEND на часах.',
  'Discovery started. Activate OTHERS RECEIVE on the watch. No image will be sent.': 'Поиск запущен. Включите OTHERS RECEIVE на часах. Снимок отправляться не будет.',
  'IAS test started. Activate the selected watch mode now.': 'Тест IAS запущен. Теперь включите выбранный режим на часах.',
  'CSI test started. Activate OTHERS RECEIVE on the watch. No image will be sent.': 'Тест CSI запущен. Включите OTHERS RECEIVE на часах. Снимок отправляться не будет.',
  'Opening the IrCOMM service found in IAS': 'Открываем службу IrCOMM, найденную в IAS',
  'Opening SCEP as CASSIOPEIA': 'Открываем SCEP от имени CASSIOPEIA',
  'Reading RIMG, RINF and RCMD': 'Читаем RIMG, RINF и RCMD',
  'Closing SCEP': 'Закрываем SCEP', 'Closing IrCOMM': 'Закрываем IrCOMM',
  'CSI capability test complete. Save the ZIP.': 'Запрос возможностей CSI завершён. Сохраните ZIP.',
  'Opening the IrLAP connection (SNRM)': 'Открываем соединение IrLAP (SNRM)',
  'Opening the IAS catalogue': 'Открываем каталог IAS',
  'Reading IAS service entries': 'Читаем записи служб IAS',
  'Closing the IAS channel': 'Закрываем канал IAS', 'Closing the IrLAP connection': 'Закрываем соединение IrLAP',
  'IAS test complete. Save the ZIP.': 'Проверка IAS завершена. Сохраните ZIP.',
  'Discovery: waiting for the watch': 'Поиск: ждём часы', 'IrLAP connected': 'IrLAP подключён',
  'IAS: answering service queries': 'IAS: отвечаем на запросы служб', 'IrCOMM connected': 'IrCOMM подключён',
  'SCEP connected as CASSIOPEIA': 'SCEP подключён как CASSIOPEIA', 'File received; finishing the session': 'Файл принят; завершаем сеанс',
  'Transfer complete. Save the ZIP.': 'Передача завершена. Сохраните ZIP.',
  'A file was received, but the session did not close cleanly. Save the ZIP.': 'Файл получен, но сеанс не завершился штатно. Сохраните ZIP.',
  'No USB bytes received. The cause of silence is not established.': 'Входящих байтов USB нет. Причина тишины пока не установлена.',
  'Receive window ended. Check the last protocol phase and save the ZIP.': 'Окно приёма закончилось. Посмотрите последний этап протокола и сохраните ZIP.',
  'The test stopped after an error. Check the last protocol phase and save the ZIP.': 'Тест остановлен из-за ошибки. Посмотрите последний этап протокола и сохраните ZIP.',
  'Stopped. All received bytes are kept.': 'Остановлено. Все полученные байты сохранены.',
  'Stopping. Saving the raw recording…': 'Останавливаем. Сохраняем сырую запись…',
  'Journal error. Recording stopped; the in-memory ZIP is still available.': 'Ошибка журнала. Запись остановлена; ZIP из памяти ещё доступен.',
  'Notes saved.': 'Заметки сохранены.', 'WebUSB is unavailable in this browser.': 'В этом браузере недоступен WebUSB.',
  'Save UPF': 'Сохранить UPF', 'Save JPEG': 'Сохранить JPEG',
};
const t = s => getLanguage() === 'ru' ? ru[s] ?? s : s;
const phases = { discovery: 'Discovery: waiting for the watch', irlap: 'IrLAP connected', ias: 'IAS: answering service queries',
  ircomm: 'IrCOMM connected', scep: 'SCEP connected as CASSIOPEIA', 'file-received': 'File received; finishing the session',
  snrm: 'Opening the IrLAP connection (SNRM)', 'ias-connect': 'Opening the IAS catalogue', 'ias-query': 'Reading IAS service entries',
  'ias-disconnect': 'Closing the IAS channel', disconnect: 'Closing the IrLAP connection', 'ias-complete': 'IAS test complete. Save the ZIP.',
  'csi-ircomm-connect': 'Opening the IrCOMM service found in IAS', 'csi-scep-connect': 'Opening SCEP as CASSIOPEIA',
  'csi-capabilities': 'Reading RIMG, RINF and RCMD', 'csi-scep-disconnect': 'Closing SCEP',
  'csi-ircomm-disconnect': 'Closing IrCOMM', 'csi-complete': 'CSI capability test complete. Save the ZIP.' };
Object.assign(phases, { 'active-wait-scep': 'Connected. Waiting for the watch to start SCEP',
  'active-ircomm-disconnect': 'Closing IrCOMM', 'active-receiver-complete': 'Closing the IrLAP connection' });
Object.assign(phases, { 'send-put': 'Sending the UPF file', 'send-accepted': 'PUT acknowledged',
  'send-rejected': 'The watch rejected PUT; closing the session', 'send-complete': UPLOAD_ACKNOWLEDGED,
  'send-cancel-observe': 'Recording the cancellation response', 'peer-requested-disconnect': 'The watch requested a disconnect' });
let store, suiteStore, suiteUI, adapter, controller, receiver, active, journal, unlock, busy = false, broken = false, attempts = [];
let statusKey = 'Opening local journal…', statusError = false, statusDetail = '';
const journals = new Map(), urls = [];
let sendFile = null;
let sendFiles = [], generatedProbe = null, preparedSendFiles = [], featurePreviewURLs = [];

function status(key, detail = '', error = false) {
  statusKey = key; statusDetail = detail; statusError = error;
  $('status').textContent = t(key) + (detail ? '\n' + detail : ''); $('status').classList.toggle('error', error);
}
function render() {
  document.documentElement.lang = getLanguage(); $('language').value = getLanguage();
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
  for (const element of document.querySelectorAll('[data-placeholder]')) element.placeholder = t(element.dataset.placeholder);
  const opened = Boolean(adapter?.opened), exporting = Boolean(suiteUI?.editing),
    settingsLocked = busy || opened || exporting || Boolean(suiteUI?.selected),
    finishedSeries = Boolean(suiteUI?.selected && !suiteUI.step());
  for (const id of ['prepare', 'reset']) $(id).disabled = !store || busy || opened || exporting || finishedSeries || broken || !navigator.usb;
  $('release').disabled = busy || exporting || !opened; $('ready').disabled = busy || !opened;
  $('start').disabled = busy || exporting || !opened || !$('ready').checked || broken;
  $('seconds').disabled = settingsLocked; $('stop').disabled = !busy || active?.status !== 'running' || controller?.signal.aborted;
  for (const id of ['test', 'max-baud', 'frame-recovery']) $(id).disabled = settingsLocked;
  const ias = $('test').value === 'ias', csi = $('test').value === 'csi', sending = $('test').value === 'sender', receiving = ['receiver', 'active-receiver'].includes($('test').value),
    activeReceiver = $('test').value === 'active-receiver', passive = $('test').value === 'listen-selection';
  $('upload-settings').hidden = !sending;
  const selectedFeature = suiteUI?.step()?.feature, probeID = $('upload-probe').value;
  const probing = sending && probeID !== 'original';
  const recordedControl = probing && featureCase(probeID).recordedInput;
  $('upload-probe').disabled = settingsLocked;
  $('create-probe').hidden = !probing; $('create-probe').disabled = busy || opened || exporting || !store;
  $('create-probe').textContent = t(recordedControl ? (featureCase(probeID).copies ?? 1) > 1 ? 'Use the exact control files' : 'Use the exact control file' : 'Create numbered test image');
  $('feature-panel').hidden = !probing && !selectedFeature;
  if (probing || selectedFeature) {
    const item = featureCase(probing ? probeID : selectedFeature.caseID);
    const feature = selectedFeature ?? { caseID: item.id, role: 'write', copyIndex: 0 };
    $('feature-instructions').textContent = t(item.title) + ' · ' + featureInstructions(feature, t);
    $('feature-readback-note').textContent = missingPhotoInstructions(feature, t);
    $('feature-readback-note').hidden = feature.role !== 'read';
  }
  for (const option of $('upload-probe').options) option.textContent = t(option.dataset.title ?? 'Original watch UPF');
  $('copy-count-label').textContent = t(probing ? 'Files' : 'Copies');
  for (const option of $('copy-count').options) option.textContent = t(probing ?
    option.value === '1' ? 'One file' : 'Two files in one connection' :
    option.value === '1' ? 'One copy' : 'Two copies in one connection');
  for (const id of ['send-last', 'send-file', 'copy-count', 'send-pdu']) $(id).disabled = settingsLocked || !store || probing;
  $('send-last').hidden = probing; $('send-file').closest('label').hidden = probing;
  $('upload-original-note').hidden = probing;
  if (sending && !sendFile && !probing) for (const id of ['prepare', 'reset', 'start']) $(id).disabled = true;
  $('upload-source').textContent = sendFile ? (sendFiles.length ? sendFiles : [sendFile]).map(file =>
    `${file.filename} · ${file.bytes.length} B · SHA-256 ${file.sha256}`).join('\n') : t('Choose a watch UPF before preparing USB.');
  $('image-profile-field').hidden = !receiving; $('profile-note').hidden = !receiving; $('image-profile').disabled = settingsLocked;
  $('recovery-field').hidden = passive; $('speed-label').textContent = t(passive ? 'Fixed receive speed' : 'Speed limit');
  $('start').textContent = probing ? featureSendButtonText(probeID, t) : t(passive ? 'Start recording' : sending ? 'Send a watch photo back' : ias ? 'Connect and read IAS' : csi ? 'CSI capability queries' : activeReceiver ? 'Connect, then receive an image' : 'Start receiver');
  $('test-summary').textContent = t(passive ? 'Listen without discovery or acknowledgements. Unknown bytes are saved before strict CRC decoding.' : ias ? 'Discovery → SNRM → UA → IAS service queries → disconnect. No IrCOMM channel or image transfer.' : csi ?
    'IAS → IrCOMM → SCEP as CASSIOPEIA → RIMG, RINF, RCMD → disconnect. No image is sent.' : sending ?
    (probing ? 'Numbered test image and selected metadata. The watch will receive new test photos.' :
    'IAS → capabilities → unchanged UPF → PUT reply → disconnect. The watch will receive a new photo copy.') : activeReceiver ?
    'IAS → IrCOMM → wait for the watch to start SCEP and send an image. No outgoing image-transfer request.' :
    'CASSIOPEIA receiver profile · SCEP 4096 B · 128 KiB · JPEG 4:2:0');
  $('watch-mode').disabled = settingsLocked || csi || sending || passive;
  $('watch-instructions').textContent = t(passive ?
    'Start recording before entering the SEND image-selection screen. Mark entry, side-button changes and the final front SEND press. SigmaTel sends no infrared packets in this test.' : activeReceiver && $('watch-mode').value === 'others-receive' ?
    'OTHERS RECEIVE is a connection control: the page opens IrCOMM and waits. This test sends no image to the watch.' : (ias || csi || sending) && $('watch-mode').value === 'others-receive' ?
    'Select IR → OTHERS → RECEIVE. Face the watch toward SigmaTel, about 5–10 cm away. Start the test here, then activate reception on the watch.' : $('watch-mode').value === 'others-receive' ?
    'OTHERS RECEIVE can answer discovery, but this receiver does not initiate a connection or send images to the watch. This mode records discovery only.' :
    'Enter OTHERS SEND with the first front press and choose the photo with the side buttons. Start the receiver here, then press the front button again to transmit.');
  $('ready-text').textContent = t(passive ? 'The watch is positioned. I will open the SEND selection screen after starting the recording.' : 'The watch is positioned. I will press its front button after starting the test.');
  $('speed-note').textContent = passive ? t('Fixed receive speed') + ': ' + $('max-baud').value + ' bit/s · ' + t('Strict CRC only') :
    t('Discovery starts at 9600 bit/s. Connection speed limit:') + ' ' + $('max-baud').value + ' bit/s. ' + t('SCEP packet size is separate from the link speed.');
  const marking = busy && active?.status === 'running' && !controller?.signal.aborted;
  $('mark').disabled = !marking; $('mark').hidden = $('watch-mode').value === 'others-send';
  $('attempts').disabled = busy || opened || exporting;
  $('selection-markers').hidden = $('watch-mode').value !== 'others-send';
  for (const id of ['mark-selection', 'mark-previous', 'mark-next', 'mark-transmit']) $(id).disabled = !marking;
  $('frame-label').disabled = !marking;
  $('export').disabled = !selected() || exporting; $('notes').disabled = busy || exporting;
  $('save-notes').disabled = busy || exporting || !selected();
  $('usb-state').textContent = opened ? `${adapter.description.name} · ${adapter.description.usbId}` : '—';
  suiteUI?.render();
  status(statusKey, statusDetail, statusError);
}
function selected() { return active?.id === $('attempts').value ? active : attempts.find(a => a.id === $('attempts').value); }
function imageProfile() { return ['receiver', 'active-receiver'].includes($('test').value) ? $('image-profile').value : 'csi'; }
function profile() { return { ...CSI_PROFILE, capabilities: IMAGE_CAPABILITIES[imageProfile()] }; }
function showResult() {
  const item = selected(); $('result').textContent = item ? JSON.stringify(item, null, 2) : '—';
  $('notes').value = item?.notes ?? '';
  suiteUI?.showAttempt(item);
}
async function refresh(id = active?.id ?? suiteUI?.step()?.attemptIDs.at(-1) ?? (suiteUI?.selected ? '' : undefined)) {
  attempts = (await store.attempts()).filter(a => a.kind === 'irtranp').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (active) attempts = [...attempts.filter(a => a.id !== active.id), active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('attempts').replaceChildren(...attempts.map(a => {
    const option = document.createElement('option'); option.value = a.id;
    option.textContent = `${a.createdAt.slice(0, 19)} UTC · ${a.status}`; return option;
  }));
  if (id === '') $('attempts').selectedIndex = -1;
  else if (attempts.length) $('attempts').value = attempts.some(a => a.id === id) ? id : attempts.at(-1).id;
  showResult(); render(); suiteUI?.refreshReports();
}
function storageError(error) {
  broken = true; controller?.abort(error); adapter?.close().catch(() => {});
  status('Journal error. Recording stopped; the in-memory ZIP is still available.', String(error), true); render();
}
async function save() { try { await store.save(active); } catch (error) { storageError(error); throw error; } }
function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function clearImages() { urls.splice(0).forEach(url => URL.revokeObjectURL(url)); $('received').replaceChildren(); }
function showFile(file) {
  const card = document.createElement('figure'); card.style.margin = '8px';
  if (file.jpeg) {
    const url = URL.createObjectURL(new Blob([file.jpeg], { type: 'image/jpeg' })); urls.push(url);
    const image = document.createElement('img'); image.src = url; image.alt = file.filename;
    image.style.cssText = 'display:block;max-width:352px;image-rendering:pixelated'; card.append(image);
  }
  const label = document.createElement('figcaption'); label.textContent = `${file.filename} · ${file.bytes.length} B`; card.append(label);
  const upf = document.createElement('button'); upf.textContent = t('Save UPF');
  upf.onclick = () => download(new Blob([file.bytes]), file.filename); card.append(upf);
  if (file.jpeg) {
    const jpeg = document.createElement('button'); jpeg.textContent = t('Save JPEG');
    jpeg.onclick = () => download(new Blob([file.jpeg], { type: 'image/jpeg' }), file.filename.replace(/\.[^.]+$/, '.jpg')); card.append(jpeg);
  }
  $('received').append(card);
}
async function chooseSendFile(bytes, filename, source) {
  const file = validateSendFile(bytes, filename);
  sendFile = { ...file, sha256: await sha256(file.bytes), source }; sendFiles = [sendFile]; generatedProbe = null; $('ready').checked = false;
  status('Photo ready. Prepare USB, then select OTHERS RECEIVE on the watch.'); render();
}
function showFeaturePreview(files, details = null) {
  featurePreviewURLs.forEach(url => URL.revokeObjectURL(url)); featurePreviewURLs = [];
  for (const [index, suffix] of ['', '-secondary'].entries()) {
    const image = $('feature-preview' + suffix), file = files[index];
    $('feature-preview-card' + suffix).hidden = !file;
    if (file) {
      const url = URL.createObjectURL(new Blob([jpegFromUPF(file.bytes)], { type: 'image/jpeg' }));
      featurePreviewURLs.push(url); image.src = url;
      $('feature-preview-caption' + suffix).textContent = file.label ?? file.filename;
    } else { image.removeAttribute('src'); $('feature-preview-caption' + suffix).textContent = ''; }
  }
  $('feature-label').textContent = files.map(file => file.label).filter(Boolean).join(' · ');
  $('feature-details').textContent = details ? JSON.stringify(details, null, 2) : '';
}
async function generateFeatureImage() {
  const id = $('upload-probe').value;
  let nonce;
  do { nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase(); }
  while (attempts.some(attempt => attempt.feature?.nonce === nonce));
  generatedProbe = await createFeatureFiles(id, nonce);
  sendFiles = generatedProbe.files; sendFile = sendFiles[0];
  $('copy-count').value = String(sendFiles.length); $('send-pdu').value = String(featureCase(id).sendPDU ?? 512);
  showFeaturePreview(sendFiles, { case: featureCase(id).title, fields: featureCase(id).fields ?? {},
    transferAttributes: featureCase(id).transfer ?? {}, cancellation: generatedProbe.abortMode,
    files: sendFiles.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })) });
  $('ready').checked = false;
}
async function referenceForFeature(step) {
  if (step?.feature?.role !== 'read') return null;
  const sourceStep = suiteUI.selected.steps.find(item => item.id === step.feature.sourceStepID);
  const source = attempts.findLast(item => sourceStep.attemptIDs.includes(item.id) && item.startedAt &&
    !['preparing', 'prepared', 'running'].includes(item.status));
  if (!source) throw new Error(t('Run the matching upload step first, or skip this read-back explicitly.'));
  const events = journals.get(source.id)?.events ?? await store.events(source.id);
  const file = events.filter(e => e.kind === 'irtranp-upload-file')[step.feature.copyIndex];
  if (!file) throw new Error(t('The matching upload has no saved input file.'));
  const reference = { ...file, bytes: fromHex(file.dataHex), sourceAttemptID: source.id,
    uploadConfirmed: source.result?.putReplies?.[step.feature.copyIndex]?.accepted === true };
  showFeaturePreview([reference], { sourceAttemptID: source.id, uploadConfirmed: reference.uploadConfirmed,
    expectedFilename: reference.filename, transferMetadata: reference.transferMetadata ?? {} });
  return reference;
}
async function lastReceivedPhoto() {
  if (busy || adapter?.opened || suiteUI?.editing) return;
  busy = true; status('Loading the last received photo…'); render();
  try {
    for (const attempt of attempts.toReversed()) {
      if (!['receiver', 'active-receiver'].includes(attempt.test) || !(attempt.result?.fileCount > 0)) continue;
      const events = journals.get(attempt.id)?.events ?? await store.events(attempt.id);
      const file = events.findLast(event => event.kind === 'irtranp-file');
      if (!file) continue;
      await chooseSendFile(fromHex(file.dataHex), file.filename, { kind: 'received-watch-file', attemptID: attempt.id }); return;
    }
    status('No received watch photo is saved yet. Open a UPF file.', '', true);
  } catch (error) { status(String(error), '', true); }
  finally { busy = false; render(); }
}
async function prepare(reset = false) {
  if (busy || suiteUI?.editing || adapter?.opened || !store || broken || suiteUI?.selected && !suiteUI.step()) return;
  if (suiteUI?.selected && suiteUI.selected.planID !== $('suite-plan').value) {
    status('The plan and active series differ. Select the plan again before preparing USB.', '', true); return;
  }
  const test = $('test').value, maxBaud = Number($('max-baud').value),
    frameRecovery = test === 'listen-selection' ? 'strict' : $('frame-recovery').value;
  if (test === 'sender' && $('upload-probe').value === 'original' && !sendFile) { status('Choose a watch UPF before preparing USB.', '', true); return; }
  if (!TEST_RATES.includes(maxBaud) || !RECOVERY_MODES.includes(frameRecovery) || !$('seconds').reportValidity()) return;
  busy = true; active = null; journal = null; receiver = null; $('ready').checked = false; clearImages();
  status('Preparing SigmaTel…'); render(); controller = new AbortController();
  try {
    const selectedStep = suiteUI.step(), probing = test === 'sender' && $('upload-probe').value !== 'original';
    const transportProfile = selectedStep?.transportProfile ??
      (probing ? featureCase($('upload-probe').value).transportProfile : null) ?? 'current';
    if (probing && (generatedProbe?.caseID !== $('upload-probe').value || generatedProbe.used)) await generateFeatureImage();
    preparedSendFiles = test === 'sender' ? (sendFiles.length ? sendFiles : [sendFile]).map(file => ({ ...file, bytes: file.bytes.slice() })) : [];
    const reference = await referenceForFeature(selectedStep);
    const feature = selectedStep?.feature ? { ...selectedStep.feature } : probing ? { caseID: generatedProbe.caseID, role: 'write', copyIndex: 0 } : null;
    if (feature) Object.assign(feature, { nonce: reference?.source?.nonce ?? generatedProbe?.nonce ?? null,
      abortMode: featureCase(feature.caseID).abortMode ?? 'none',
      ...(reference ? { referenceAttemptID: reference.sourceAttemptID, referenceUploadConfirmed: reference.uploadConfirmed,
        label: reference.label } : { labels: preparedSendFiles.map(file => file.label) }) });
    const devices = await navigator.usb.getDevices();
    const device = devices.find(d => d.vendorId === 0x066f && d.productId === 0x4200) ??
      await navigator.usb.requestDevice({ filters: [{ vendorId: 0x066f, productId: 0x4200 }] });
    active = { id: crypto.randomUUID(), kind: 'irtranp', format: 'wqv-irtranp-research-v1', createdAt: new Date().toISOString(),
      status: 'preparing', test, feature, watchMode: $('watch-mode').value, baud: test === 'listen-selection' ? maxBaud : 9600,
      fixedReceiveBaud: test === 'listen-selection' ? maxBaud : null, maxBaud, frameRecovery, transportProfile,
      profile: profile(), imageProfile: imageProfile(), sendMarkers: 0, receiveMarkers: 0, notes: '',
      captureWindowMs: Number($('seconds').value) * 1000,
      device: { vendorId: device.vendorId, productId: device.productId, productName: device.productName },
      request: { usbReset: reset, ...testRequest(test), pcSwitchCommand: false, upload: test === 'sender',
        protocolCancellation: feature?.abortMode ?? 'none' },
      capture: { originalUSBBytes: true, syntheticData: false, generatedInput: probing && !generatedProbe?.reusedInput,
        reusedInput: Boolean(probing && generatedProbe?.reusedInput), automaticNextStep: false,
        receiveOnly: test === 'listen-selection', frameRecovery, transportProfile,
        sendWorkflow: ['front-button-opens-selection', 'side-buttons-select-photo', 'front-button-starts-transmission'] } };
    await suiteUI.bind(active);
    await save(); journal = new Journal(store, active, storageError); journals.set(active.id, journal);
    if (reference) journal.record('irtranp-reference-file', { filename: reference.filename, dataHex: reference.dataHex,
      label: reference.label, transferMetadata: reference.transferMetadata, sourceAttemptID: reference.sourceAttemptID,
      uploadConfirmed: reference.uploadConfirmed });
    if (test === 'sender') {
      const files = preparedSendFiles.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length }));
      active.upload = { ...files[0], files,
        copyCount: Number($('copy-count').value), sendPDU: Number($('send-pdu').value) };
      for (const [index, file] of preparedSendFiles.entries()) journal.record('irtranp-upload-file', { ...files[index], copy: index + 1, dataHex: toHex(file.bytes) });
      if (probing) generatedProbe.used = true;
    }
    const counters = { readCount: 0, emptyReads: 0, nonemptyReads: 0, rxBytes: 0 };
    const attempt = active;
    let transport;
    transport = new SigmaTel(captureUSB(device, journal.record, () => ({ baud: transport?.baud ?? null, phase: attempt.status }),
      { counters, receiveOnly: test === 'listen-selection' }),
      { log: (level, message) => journal.record('log', { level, message: String(message) }) });
    adapter = transport; adapter.usbStats = counters;
    journal.record('attempt-prepared', { profile: active.profile, imageProfile: active.imageProfile,
      test, maxBaud, frameRecovery, transportProfile, receiveOnly: test === 'listen-selection', suite: active.suite ?? null });
    if (reset) { await adapter.io(adapter.device.open(), 'opening USB for reset'); await adapter.io(adapter.device.reset(), 'resetting USB'); }
    await adapter.open(); await adapter.setupSIR(); controller.signal.throwIfAborted();
    if (test === 'listen-selection') await adapter.setSIRSpeed(maxBaud);
    controller.signal.throwIfAborted();
    active.adapter = adapter.description; active.chipRevision = adapter.revision; active.status = 'prepared';
    journal.record('irtranp-armed', { baud: adapter.baud, chipRevision: adapter.revision }); await journal.drain(); await save();
    status(test === 'sender' ? 'USB ready. Start the test here, then activate OTHERS RECEIVE on the watch.' :
      'USB ready. For passive recording, stay before the first front press. For image reception, choose a photo but do not press SEND again yet.');
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
  try { await adapter.close(); active.status = 'released-without-recording'; journal.record('usb-released'); await journal.drain(); await save(); }
  catch (error) { status(String(error), '', true); }
  finally { adapter = null; busy = false; $('ready').checked = false; status('USB released. Restart the watch mode before trying again.'); await refresh(); }
}
async function run() {
  if (busy || suiteUI?.editing || !adapter?.opened || !$('ready').checked || broken) return;
  if (!$('seconds').reportValidity()) return;
  busy = true; controller = new AbortController(); active.status = 'running'; active.startedAt = new Date().toISOString();
  const passive = active.test === 'listen-selection';
  active.notes = $('notes').value; $('ready').checked = false;
  status(passive ? 'Passive recording started. Enter the SEND selection screen now and mark each action.' : active.test === 'sender' ? 'Sender started. Now activate OTHERS RECEIVE on the watch.' : active.test === 'active-receiver' ? 'Active receiver started. Now press the front button on the watch.' : active.test === 'csi' ? 'CSI test started. Activate OTHERS RECEIVE on the watch. No image will be sent.' : active.test === 'ias' ? 'IAS test started. Activate the selected watch mode now.' : active.watchMode === 'others-receive' ? 'Discovery started. Activate OTHERS RECEIVE on the watch. No image will be sent.' :
    'Receiver started. Now press the final SEND button on the watch.'); render();
  try {
    await save(); journal.record('receiver-manual-start');
    if (passive) active.result = await listen(adapter,
      { baud: active.maxBaud, watchMode: active.watchMode, durationMs: active.captureWindowMs },
      { signal: controller.signal, record: journal.record });
    else {
      const Receiver = active.test === 'sender' ? IrTranPSender : active.test === 'active-receiver' ? IrTranPActiveReceiver : active.test === 'csi' ? IrTranPCSIProbe : active.test === 'ias' ? IrTranPIASProbe : IrTranPReceiver;
      receiver = new Receiver(adapter, { signal: controller.signal, record: journal.record,
        ...(active.test === 'sender' ? { sendFile: preparedSendFiles[0], sendFiles: preparedSendFiles,
          copyCount: active.upload.copyCount, sendPDU: active.upload.sendPDU, abortMode: active.feature?.abortMode ?? 'none' } : {}),
        imageProfile: active.imageProfile, maxBaud: active.maxBaud, frameRecovery: active.frameRecovery,
        transportProfile: active.transportProfile ?? 'current',
        progress: phase => { if (phase !== 'discovery') status(phases[phase] ?? phase); },
        onFile: async file => { showFile(file); await journal.drain(); } });
      active.capture.recoverFrames = Boolean(adapter.decoder.recoverFrames);
      active.capture.damagedBOFCandidateWithOriginalCRC = Boolean(adapter.decoder.recoverBOF);
      active.result = await receiver.run(active.captureWindowMs);
    }
    active.status = active.result.status;
  } catch (error) { active.status = controller.signal.aborted ? 'interrupted' : 'error'; active.error = String(error); journal.record('receiver-error', { error: String(error) }); }
  finally {
    try { await adapter.close(); } catch (error) { active.cleanupError = String(error); journal.record('cleanup-error', { error: String(error) }); }
    active.finishedAt = new Date().toISOString(); active.usbCounters = { ...adapter.usbStats };
    active.counters = { ...(adapter.irtranpStats ?? adapter.passiveStats), badCRC: adapter.decoder.badCRC, recoveredFrames: adapter.decoder.recoveredFrames,
      recoveredBOF: adapter.decoder.recoveredBOF, rejectedBOF: adapter.decoder.rejectedBOF,
      txFrames: adapter.txFrames, rxBytes: adapter.rxBytes, fifoRecoveries: adapter.fifoRecoveries };
    active.captureMayBeIncomplete = !(passive ? ['captured', 'no-data'].includes(active.result?.status) && active.usbCounters.readCount > 0 : active.result?.complete) || Boolean(active.cleanupError);
    journal.record('step-finished', { status: active.status, counters: active.counters });
    if (!broken) { await journal.drain(); await save(); }
    busy = false; adapter = null;
    if (!broken) {
      const sendStatus = { sent: ['multiple', 'multiple-csi', 'multiple-wince211'].includes(active.feature?.caseID) ? TWO_UPLOADS_ACKNOWLEDGED : UPLOAD_ACKNOWLEDGED,
        'cancel-observed': 'Cancellation test closed. This does not by itself prove that a photo was not stored. Save the ZIP.',
        'send-rejected': 'PUT was rejected or blocked by the peer capabilities. Save the ZIP.',
        'sent-incomplete-session': 'The watch acknowledged the upload, but the session did not close cleanly. Save the ZIP.',
        'send-incomplete': 'No complete PUT confirmation. The photo may have been written. Save the ZIP before retrying.' };
      status(sendStatus[active.status] ?? (active.status === 'captured' ? 'Passive recording complete. Save the ZIP; unknown bytes are preserved.' : active.status === 'receiver-no-image' ? 'Connection closed. No complete image was received. Save the ZIP.' : active.status === 'csi-complete' ? 'CSI capability test complete. Save the ZIP.' : active.status === 'ias-complete' ? 'IAS test complete. Save the ZIP.' : active.status === 'received' ? 'Transfer complete. Save the ZIP.' : active.status === 'received-incomplete-session' ? 'A file was received, but the session did not close cleanly. Save the ZIP.' :
        active.status === 'no-data' ? 'No USB bytes received. The cause of silence is not established.' :
        active.status === 'interrupted' ? 'Stopped. All received bytes are kept.' : active.status === 'error' ?
          'The test stopped after an error. Check the last protocol phase and save the ZIP.' : 'Receive window ended. Check the last protocol phase and save the ZIP.'),
      [active.error ?? active.result?.error?.message ?? '',
        active.result?.uploadOutcome === 'unconfirmed' ? t('No complete PUT confirmation. The photo may have been written. Save the ZIP before retrying.') : ''].filter(Boolean).join('\n'), active.status === 'error');
      await refresh();
    } else render();
    updateStats();
  }
}
function updateStats() {
  const item = busy || adapter ? active : selected();
  const stats = adapter?.irtranpStats ?? adapter?.passiveStats ?? item?.counters, usb = adapter?.usbStats ?? item?.usbCounters;
  const sending = item?.test === 'sender', csi = item?.test === 'csi' || sending, receiving = item?.test === 'active-receiver';
  if (stats || usb) $('stats').textContent = `RX ${usb?.rxBytes ?? 0} B · USB reads ${usb?.readCount ?? 0} · TX ${adapter?.txFrames ?? stats?.txFrames ?? 0} · ` +
    `XID ${stats?.xidCommands ?? 0}/${stats?.xidResponses ?? 0} · IAS ${stats?.iasQueries ?? 0}` +
    (csi ? ` · IrCOMM ${stats?.ircommConnections ?? 0} · CSI ${stats?.capabilityResponses ?? 0}/3 · ${t('RR retries')} ${stats?.finalPollRetries ?? 0}` : '') +
    (receiving ? ` · IrCOMM ${stats?.ircommConnections ?? 0} · replies ${stats?.queries ?? 0}` : '') +
    (sending ? ` · PUT ${stats?.putAccepted ?? 0}/${item.upload?.copyCount ?? 1}` : '') +
    ` · files ${stats?.files ?? 0} · CRC ${adapter?.decoder.badCRC ?? stats?.badCRC ?? 0} · BOF ${adapter?.decoder.recoveredBOF ?? stats?.recoveredBOF ?? 0}`;
  else $('stats').textContent = '';
  const visibleJournal = journals.get(item?.id);
  if (visibleJournal) showRecentEvents(visibleJournal.events);
}
function showRecentEvents(events) {
  const recent = [];
  for (let i = events.length - 1; i >= 0 && recent.length < 15; i--) {
    if (!['usb-call', 'usb-result'].includes(events[i].kind)) recent.push(events[i]);
  }
  $('events').textContent = recent.reverse().map(event => JSON.stringify(event)).join('\n') || '—';
}
async function exportZIP() {
  const attempt = selected(); if (!attempt) return;
  try {
    const live = journals.get(attempt.id), events = live?.events.slice() ?? await store.events(attempt.id);
    const meta = { ...attempt, exportedAt: new Date().toISOString(), snapshot: attempt.status === 'running', storageError: live?.error ? String(live.error) : null };
    download(zipFiles(attemptFiles(meta, events)), `WQV-IrTranP-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  } catch (error) { status(String(error), '', true); }
}
$('prepare').onclick = () => prepare(); $('reset').onclick = () => prepare(true); $('release').onclick = release; $('start').onclick = run;
$('send-last').onclick = lastReceivedPhoto;
$('create-probe').onclick = async () => {
  if (busy || adapter?.opened || suiteUI?.editing) return;
  busy = true; render();
  try {
    await generateFeatureImage();
    status(generatedProbe.reusedInput ? generatedProbe.files.length > 1 ? 'Exact control files loaded. Prepare USB next.' : 'Exact control file loaded. Prepare USB next.' : 'Numbered test image ready. Prepare USB next.');
  }
  catch (error) { status(String(error), '', true); }
  finally { busy = false; render(); }
};
$('upload-probe').onchange = () => {
  sendFile = null; sendFiles = []; generatedProbe = null; showFeaturePreview([]); $('ready').checked = false; render();
};
$('send-file').onchange = async () => {
  if (busy || adapter?.opened || suiteUI?.editing) return;
  const file = $('send-file').files[0]; if (!file) return;
  busy = true; render();
  try {
    if (file.size > CSI_PROFILE.maxFile) throw new Error('Choose a watch UPF file of at most 128 KiB.');
    await chooseSendFile(new Uint8Array(await file.arrayBuffer()), file.name, { kind: 'user-selected-file' });
  } catch (error) { status(String(error), '', true); }
  finally { busy = false; $('send-file').value = ''; render(); }
};
$('ready').onchange = render; $('stop').onclick = () => {
  if (!busy || active?.status !== 'running' || controller?.signal.aborted) return;
  journal?.record('manual-stop'); status('Stopping. Saving the raw recording…');
  controller?.abort(); render();
};
$('mark').onclick = () => {
  if (active?.status !== 'running' || controller?.signal.aborted) return;
  if (active.watchMode === 'others-receive') journal.record('watch-receive-mark', { marker: ++active.receiveMarkers });
  else journal.record('watch-send-mark', { marker: ++active.sendMarkers });
};
for (const [id, stage] of [['mark-selection', 'selection-open'], ['mark-previous', 'previous-image'],
  ['mark-next', 'next-image'], ['mark-transmit', 'transmit-start']]) {
  $(id).onclick = () => {
    if (!busy || active?.status !== 'running' || controller?.signal.aborted) return;
    journal.record('watch-stage-mark', { stage, frameLabel: $('frame-label').value.trim(),
      physicalAction: ['selection-open', 'transmit-start'].includes(stage) ? 'front-button' : 'side-button' });
  };
}
$('export').onclick = exportZIP; $('attempts').onchange = () => { showResult(); render(); };
$('save-notes').onclick = async () => { const item = selected(); if (item) { item.notes = $('notes').value; await store.save(item); status('Notes saved.'); showResult(); } };
$('language').onchange = () => { setLanguage($('language').value); suiteUI.updateSelect(); render(); suiteUI.showAttempt(selected()); };
$('watch-mode').onchange = () => { $('ready').checked = false; render(); };
$('image-profile').onchange = () => { $('ready').checked = false; render(); };
for (const id of ['max-baud', 'frame-recovery']) $(id).onchange = () => { $('ready').checked = false; render(); };
$('test').onchange = () => {
  $('watch-mode').value = ['receiver', 'active-receiver', 'listen-selection'].includes($('test').value) ? 'others-send' : 'others-receive';
  $('ready').checked = false; render();
};
suiteUI = new IrTranPSuiteUI({ t,
  getAttempts: () => attempts,
  getEvents: async id => journals.get(id)?.events.slice() ?? store.events(id),
  blocked: () => busy || Boolean(adapter?.opened) || broken || !store,
  applySettings: step => {
    for (const [id, value] of [['test', step.test], ['watch-mode', step.watchMode], ['max-baud', step.maxBaud],
      ['image-profile', step.imageProfile], ['frame-recovery', step.frameRecovery], ['seconds', step.seconds]]) $(id).value = value;
    $('upload-probe').value = step.feature?.role === 'write' ? step.feature.caseID : 'original';
    if (step.feature) {
      sendFile = null; sendFiles = []; generatedProbe = null; showFeaturePreview([]);
      $('copy-count').value = String(step.copyCount); $('send-pdu').value = String(step.sendPDU);
    }
    $('ready').checked = false; $('frame-label').value = '';
    const previous = step.attemptIDs.at(-1);
    if (previous && attempts.some(attempt => attempt.id === previous)) $('attempts').value = previous;
    else { $('attempts').selectedIndex = -1; clearImages(); showRecentEvents([]); }
    showResult(); updateStats();
  }, render, status, download,
  showFiles: events => {
    clearImages(); showRecentEvents(events);
    for (const event of events) if (event.kind === 'irtranp-file') {
      const bytes = fromHex(event.dataHex); let jpeg = null;
      try { jpeg = jpegFromUPF(bytes); } catch { /* Keep invalid file bodies downloadable. */ }
      showFile({ filename: event.filename, bytes, jpeg });
    }
  },
});
setInterval(() => {
  // A cancelled USB request may settle after the next attempt starts. Its
  // result still belongs to its original journal and must reach IndexedDB.
  for (const item of journals.values()) if (!item.error) item.flush().catch(() => {});
  updateStats();
}, 250);
window.addEventListener('pagehide', () => { controller?.abort(); adapter?.close().catch(() => {}); unlock?.(); urls.forEach(url => URL.revokeObjectURL(url)); featurePreviewURLs.forEach(url => URL.revokeObjectURL(url)); });
async function initialize() {
  render();
  try {
    if (navigator.locks && !await new Promise((resolve, reject) => {
      navigator.locks.request('wqv-command-research', { ifAvailable: true }, lock => {
        resolve(Boolean(lock)); if (lock) return new Promise(release => { unlock = release; });
      }).catch(reject);
    })) { status('Another research tab is open. Close it before preparing USB.', '', true); return; }
    [store, suiteStore] = await Promise.all([openResearchStore(), openResearchStore('wqv-irtranp-suites')]);
    for (const item of await store.attempts()) if (item.kind === 'irtranp' && ['preparing', 'prepared', 'running'].includes(item.status)) {
      item.status = 'interrupted-by-page-close'; item.captureMayBeIncomplete = true; await store.save(item);
    }
    await suiteUI.initialize(suiteStore);
    await refresh(); status(navigator.usb ? 'Prepare USB before activating the watch.' : 'WebUSB is unavailable in this browser.', '', !navigator.usb); render();
  } catch (error) { storageError(error); }
}
for (const item of FEATURE_CASES) {
  const option = document.createElement('option'); option.value = item.id; option.dataset.title = item.title; option.textContent = t(item.title); $('upload-probe').append(option);
}
initialize();

function testRequest(test) {
  return { receiveOnly: test === 'listen-selection', standaloneReceiver: test === 'receiver', acceptingConnections: test === 'receiver',
    initiateConnection: !['receiver', 'listen-selection'].includes(test),
    applicationCommands: ['csi', 'sender'].includes(test), capabilityQueries: ['csi', 'sender'].includes(test) ? [...CSI_QUERIES] : [],
    waitForPeerSCEP: test === 'active-receiver', outgoingSCEPConnect: ['csi', 'sender'].includes(test) };
}
