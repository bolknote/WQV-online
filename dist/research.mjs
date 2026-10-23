import { SigmaTel } from './sigmatel.mjs';
import { getLanguage, setLanguage } from './i18n.mjs';
import { toHex } from './formats.mjs';
import { zipFiles } from './zip.mjs';
import { PROBE_PLAN, ManualSteps, ResearchClient, captureUSB, attemptFiles } from './research-core.mjs';
import { openResearchStore, Journal } from './research-store.mjs';
import { LISTEN_RATES, LISTEN_MODES, listenSettings, listen } from './listen-core.mjs';
import { DISCOVERY_MODES, discoverySettings, discoverXID } from './discovery-core.mjs';
import { SERIAL_PROBES, serialSettings, probeSerial, finishSerialCapture } from './serial-core.mjs';

const $ = id => document.getElementById(id);
const ru = {
  'Serial bytes': 'Сырые байты', 'Raw serial experiment': 'Проверка последовательного обмена',
  Probe: 'Проба', 'Next probe →': 'Следующая проба →', 'Listen only': 'Только приём',
  'Fixed 9600 bit/s, 8N1. Each probe is a separate manual experiment; restart the watch mode between probes.': 'Фиксированные 9600 бит/с, 8N1. Каждая проба запускается вручную; между пробами заново включайте обмен на часах.',
  'Sends plain serial bytes through infrared. No IrLAP framing, discovery or automatic acknowledgements. These are WonderWitch-based hypotheses, not known Casio commands.': 'Передаёт простые байты через ИК. Без обрамления IrLAP, поиска устройств и автоматических подтверждений. Это гипотезы по WonderWitch, а не известные команды Casio.',
  '15 (NAK) repeats every 2 seconds while no bytes arrive. The first received byte stops further transmissions. No XMODEM block is acknowledged.': '15 (NAK) повторяется раз в 2 секунды, пока нет входящих байтов. Первый полученный байт прекращает дальнейшую передачу. Блоки XMODEM не подтверждаются.',
  '0D (Enter) is sent once. This opens the WonderWitch shell in the original guide; its effect on Casio SWAN is unknown.': '0D (Enter) отправляется один раз. В исходной инструкции это обращение к оболочке WonderWitch; действие на Casio SWAN неизвестно.',
  'Receives plain serial bytes at 9600 bit/s without transmitting anything. No IrDA decoder or CRC recovery is used.': 'Принимает простые байты на 9600 бит/с без передачи. Декодер кадров IrDA и восстановление CRC не используются.',
  'Original bytes, including local echo, are saved without decoding or repair. Complete checksum-XMODEM blocks are reported as candidates only.': 'Исходные байты, включая эхо, сохраняются без декодирования и исправления. Полные блоки XMODEM с верной суммой отмечаются как кандидаты.',
  'Start serial test': 'Начать пробу',
  'The first probe byte is sent after 0.5 seconds. Any incoming byte stops further transmissions; recording continues. No file or firmware data is sent.': 'Первый байт пробы отправляется через 0,5 секунды. Любой входящий байт прекращает дальнейшую передачу; запись продолжается. Данные файлов и прошивок не отправляются.',
  'Serial recording started. Now press SEND on the watch.': 'Запись сырых байтов началась. Теперь нажмите SEND на часах.',
  'Serial test finished. No USB bytes received; check TX completion before interpreting silence.': 'Проба завершена. Входящих байтов USB нет; перед выводами проверьте завершение передачи TX.',
  'Serial bytes captured. Further transmissions stopped; save the ZIP to inspect the original stream.': 'Получены сырые байты. Дальнейшая передача прекращена; сохраните ZIP для изучения исходного потока.',
  'The probe was not sent. A pending USB read may have prevented transmission; this is not a watch response test.': 'Байт пробы не был отправлен. Передаче могло помешать незавершённое чтение USB; это не проверка ответа часов.',
  'The capture reached its byte limit. All delivered bytes are preserved.': 'Достигнут предел объёма записи. Все переданные адаптером байты сохранены.',
  'Raw SIR transmission did not finish before the capture deadline.': 'Передача сырых байтов SIR не завершилась до конца записи.',
  'TX attempts': 'Попыток TX', 'TX completed': 'Завершено TX', 'Before probe': 'До пробы', 'After probe': 'После пробы',
  'IR research': 'Исследование ИК', Listen: 'Слушать', Commands: 'Команды', Discovery: 'Обнаружение',
  'Active discovery': 'Активное обнаружение',
  '2. Prepare PC / REMOTE, then start discovery': '2. Включите PC / REMOTE и начните обнаружение',
  'Active discovery. Waiting for a PC / REMOTE reply.': 'Идёт активное обнаружение. Ожидаем ответ в режиме PC / REMOTE.',
  'USB ready. Restart IR → PC → F / REMOTE, tick the checkbox and start discovery.': 'USB готов. Заново включите IR → ПК → F / REMOTE, отметьте готовность и начните обнаружение.',
  'PC / REMOTE is a reception control. Only XID discovery frames are sent, at a fixed 9600 bit/s; no application command is sent.': 'PC / REMOTE — контроль приёма. Передаются только поисковые кадры XID на фиксированных 9600 бит/с; прикладные команды не отправляются.',
  'Sends complete XID searches at 9600 bit/s and answers peer searches. No application commands are sent. Connection requests are recorded but not accepted.': 'Отправляет полные поисковые циклы XID на 9600 бит/с и отвечает на поиск другого устройства. Прикладные команды не отправляются. Запросы соединения записываются, но не принимаются.',
  'Advertises WEB-WQV using the same service hints as our PC receiver. Records peer names, XID replies and connection requests with the original USB bytes.': 'Представляется как WEB-WQV с теми же признаками служб, что у нашего приёмника для ПК. Сохраняет имена устройств, ответы XID, запросы соединения и исходные байты USB.',
  'Fixed 9600 bit/s. One watch mode per attempt. Discovery stops on an incoming connection request; each new attempt starts manually.': 'Фиксированные 9600 бит/с. Одна попытка — один режим часов. При входящем запросе соединения тест останавливается; следующая попытка запускается вручную.',
  'Start discovery': 'Начать обнаружение',
  'Six search slots and a final identity packet, followed by a listening interval. Answers incoming searches; stops before accepting a connection. Mark SEND presses to help match events.': 'Шесть поисковых слотов и завершающий пакет с именем, затем ожидание ответа. Отвечает на входящий поиск; останавливается до принятия соединения. Отметки SEND помогут сопоставить события.',
  'Active discovery. Now press SEND on the watch.': 'Идёт активное обнаружение. Теперь нажмите SEND на часах.',
  'Discovery finished. No USB bytes received; the cause of silence is still unknown.': 'Обнаружение завершено. По USB не получено ни одного байта; причина тишины пока неизвестна.',
  'Discovery finished. USB bytes were received, but no addressed peer XID was recognized.': 'Обнаружение завершено. Байты USB получены, но адресованный нам XID другого устройства не распознан.',
  'Peer discovered. Save the ZIP to inspect its identity and replies.': 'Устройство обнаружено. Сохраните ZIP, чтобы изучить его имя и ответы.',
  'The peer requested a connection. The request was saved; no connection was accepted.': 'Устройство запросило соединение. Запрос сохранён; соединение не принималось.',
  'USB reads': 'Чтений USB', 'With data': 'С данными', 'Search cycles': 'Поисковых циклов',
  'XID replies': 'Ответов XID', 'XID replies sent': 'Отправлено ответов XID',
  'Capture setup': 'Настройка записи', 'Watch mode': 'Режим часов', 'Fixed speed': 'Фиксированная скорость',
  'Choose one mode and speed per recording. The page never switches speed or starts another recording automatically.': 'Для каждой записи выберите один режим и скорость. Страница сама не переключает скорость и не начинает следующую запись.',
  'Passive listening': 'Пассивное прослушивание',
  'Listen only. The receiver sends no discovery, commands or acknowledgements. USB bulk OUT is blocked.': 'Только приём. Приёмник не отправляет поиск, команды или подтверждения. USB bulk OUT заблокирован.',
  'Records every byte delivered by SigmaTel. IrDA frames are shown only if their original CRC is valid; raw data is always kept.': 'Записываются все байты, которые отдаёт SigmaTel. Кадры IrDA показываются только при верной исходной CRC; сырые данные сохраняются всегда.',
  '2. Start recording, then press SEND on the watch': '2. Начните запись, затем отправку на часах',
  'Restart the watch transfer mode. Select {mode} and an image, then face the watch toward the adapter. Start recording here before pressing the final SEND button on the watch.': 'Заново включите обмен на часах. Выберите {mode} и снимок, поставьте часы напротив адаптера. Начните запись здесь перед последним нажатием SEND на часах.',
  'The watch is facing the adapter. I am ready to start recording, then press SEND.': 'Часы напротив адаптера. Я готов начать запись и затем нажать SEND.',
  'Capture window, seconds': 'Продолжительность записи, секунд', 'Start recording': 'Начать запись',
  'Mark SEND press': 'Отметить нажатие SEND',
  'The speed stays fixed. No packets are sent back to the watch. You can mark SEND presses in the log; the marker records your click on this page.': 'Скорость остаётся фиксированной. Ответные пакеты часам не отправляются. Нажатия SEND можно отметить в журнале; отметка фиксирует ваш щелчок на этой странице.',
  'USB ready. Prepare the selected SEND mode on the watch, then start recording before sending the image.': 'USB готов. Выберите нужный режим SEND на часах, затем начните запись перед отправкой снимка.',
  'USB released. Choose the next mode and speed when ready.': 'USB освобождён. Можно выбрать следующий режим и скорость.',
  'Recording. Now press SEND on the watch.': 'Идёт запись. Теперь нажмите SEND на часах.',
  'Recording finished. USB released. Each new recording starts manually.': 'Запись завершена. USB освобождён. Каждая следующая запись запускается вручную.',
  'Recording finished with no bytes delivered by SigmaTel. Check the watch mode, speed and alignment before retrying.': 'Запись завершена: SigmaTel не отдал ни одного байта. Перед повтором проверьте режим часов, скорость и положение.',
  'Recording interrupted. All USB data received so far is kept.': 'Запись прервана. Все уже полученные данные USB сохранены.',
  'Recording ended with an error. USB data received so far is kept.': 'Запись закончилась с ошибкой. Уже полученные данные USB сохранены.',
  'CRC-valid frames': 'Кадров с верной CRC', 'Empty reads': 'Пустых чтений', 'SEND markers': 'Отметок SEND',
  'Command research': 'Исследование команд', 'Back to WQV Link': 'К WQV Link', Language: 'Язык', Steps: 'Шаги', Step: 'Шаг',
  'The unknown commands may change watch data or settings. Their effects are not established. Each step sends one command with no parameters; this is not a firmware reader.': 'Неизвестные команды могут менять данные или настройки часов. Их действие не установлено. На каждом шаге отправляется один код без параметров; это не программа чтения прошивки.',
  'AA is a control request. AD exists in Casio Link 3. The remaining codes are guesses from gaps or neighboring numbers.': 'AA — контрольный запрос. AD найден в Casio Link 3. Остальные коды выбраны по пропускам или соседним номерам.',
  '1. Prepare USB first': '1. Сначала подготовьте USB',
  'Disconnect this adapter in other apps. Prepare USB before enabling transfer mode on the watch. No watch command is sent during preparation.': 'Отключите адаптер в других программах. Подготовьте USB до включения обмена на часах. При подготовке команды часам не отправляются.',
  'Prepare SigmaTel USB…': 'Подготовить SigmaTel USB…', 'Release USB': 'Освободить USB',
  'Reset SigmaTel USB…': 'Сбросить SigmaTel USB…',
  'If USB transfers stall, release USB and try Reset SigmaTel USB. Restart the watch transfer mode afterwards. If the reset does not help, unplug and reconnect the adapter.': 'Если передачи USB зависают, освободите USB и попробуйте сбросить SigmaTel. После этого заново включите обмен на часах. Если сброс не помог, выньте и снова подключите адаптер.',
  'USB XID transmission did not complete before the capture deadline.': 'Передача XID через USB не завершилась до конца записи.',
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
const RESEARCH_MODES = ['listen', 'discovery', 'serial', 'commands'];
let mode = 'listen', selectedWatchMode = 'watch-send', selectedBaud = 9600, selectedSerialProbe = 'nak';
try {
  const savedMode = localStorage.getItem('wqv-research.mode');
  if (RESEARCH_MODES.includes(savedMode)) mode = savedMode;
  const saved = JSON.parse(localStorage.getItem('wqv-research.listen') || '{}');
  if (DISCOVERY_MODES.includes(saved.watchMode)) selectedWatchMode = saved.watchMode;
  if (LISTEN_RATES.includes(saved.baud)) selectedBaud = saved.baud;
  const serialProbe = localStorage.getItem('wqv-research.serial-probe');
  if (SERIAL_PROBES.some(item => item.id === serialProbe)) selectedSerialProbe = serialProbe;
} catch {}
const requestedMode = new URL(location.href).searchParams.get('mode');
if (RESEARCH_MODES.includes(requestedMode)) mode = requestedMode;
if (mode === 'serial') selectedWatchMode = 'swan-send';
else if (mode === 'listen' && !LISTEN_MODES.includes(selectedWatchMode)) selectedWatchMode = 'watch-send';
$('watch-mode').value = selectedWatchMode; $('listen-baud').value = selectedBaud;
$('serial-probe').value = selectedSerialProbe;
$('response-seconds').value = mode === 'commands' ? 5 : 20;
const isListening = () => mode === 'listen';
const isDiscovery = () => mode === 'discovery';
const isSerial = () => mode === 'serial';
const isCapture = () => mode !== 'commands';
const isRecordingAttempt = attempt => ['listen', 'discovery', 'serial'].includes(attempt?.kind);
const watchModeName = value => value.replaceAll('-', ' ').toUpperCase();
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
  const ready = Boolean(adapter?.opened), passive = isListening(), discovery = isDiscovery(), serial = isSerial(), capture = isCapture(), done = !capture && plan.state === 'done';
  const pcRemote = discovery && selectedWatchMode === 'pc-remote';
  document.documentElement.lang = getLanguage(); $('language').value = getLanguage();
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
  for (const option of RESEARCH_MODES) $('mode-' + option).setAttribute('aria-pressed', String(mode === option));
  for (const id of [...RESEARCH_MODES.map(option => 'mode-' + option), 'watch-mode', 'listen-baud', 'serial-probe']) $(id).disabled = !store || busy || ready;
  $('listen-settings').hidden = !capture; $('command-sidebar').hidden = capture; $('command-navigation').hidden = capture;
  $('listen-rate-setting').hidden = discovery || serial; $('discovery-rate').hidden = !discovery;
  $('serial-settings').hidden = !serial; $('serial-rate').hidden = !serial;
  $('serial-next').disabled = !store || busy || ready || SERIAL_PROBES.at(-1).id === selectedSerialProbe;
  $('serial-probe-note').textContent = t(selectedSerialProbe === 'nak' ? '15 (NAK) repeats every 2 seconds while no bytes arrive. The first received byte stops further transmissions. No XMODEM block is acknowledged.' : selectedSerialProbe === 'cr' ?
    '0D (Enter) is sent once. This opens the WonderWitch shell in the original guide; its effect on Casio SWAN is unknown.' : 'Receives plain serial bytes at 9600 bit/s without transmitting anything. No IrDA decoder or CRC recovery is used.');
  $('pc-remote-mode').hidden = !discovery; $('pc-remote-mode').disabled = !discovery;
  $('capture-setup-note').textContent = t(serial ? 'Fixed 9600 bit/s, 8N1. Each probe is a separate manual experiment; restart the watch mode between probes.' : discovery ? 'Fixed 9600 bit/s. One watch mode per attempt. Discovery stops on an incoming connection request; each new attempt starts manually.' :
    'Choose one mode and speed per recording. The page never switches speed or starts another recording automatically.');
  $('research-grid').classList.toggle('listening', capture);
  $('research-notice').classList.toggle('passive', passive);
  $('research-notice').textContent = t(serial ? 'Sends plain serial bytes through infrared. No IrLAP framing, discovery or automatic acknowledgements. These are WonderWitch-based hypotheses, not known Casio commands.' : discovery ? 'Sends complete XID searches at 9600 bit/s and answers peer searches. No application commands are sent. Connection requests are recorded but not accepted.' : passive ? 'Listen only. The receiver sends no discovery, commands or acknowledgements. USB bulk OUT is blocked.' :
    'The unknown commands may change watch data or settings. Their effects are not established. Each step sends one command with no parameters; this is not a firmware reader.');
  $('step-heading').textContent = serial ? t('Raw serial experiment') : discovery ? t('Active discovery') : passive ? t('Passive listening') : `${t('Step')} ${plan.index + 1} / ${PROBE_PLAN.length} · ${codeHex(plan.step.code)}`;
  $('step-evidence').textContent = t(serial ? 'Original bytes, including local echo, are saved without decoding or repair. Complete checksum-XMODEM blocks are reported as candidates only.' : discovery ? 'Advertises WEB-WQV using the same service hints as our PC receiver. Records peer names, XID replies and connection requests with the original USB bytes.' : passive ? 'Records every byte delivered by SigmaTel. IrDA frames are shown only if their original CRC is valid; raw data is always kept.' : evidence[plan.step.evidence]);
  $('run-heading').textContent = t(pcRemote ? '2. Prepare PC / REMOTE, then start discovery' : capture ? '2. Start recording, then press SEND on the watch' : '2. Reset the watch, then run this step');
  $('watch-instructions').textContent = capture && !pcRemote ? t('Restart the watch transfer mode. Select {mode} and an image, then face the watch toward the adapter. Start recording here before pressing the final SEND button on the watch.').replace('{mode}', watchModeName(selectedWatchMode)) :
    t('Exit the previous transfer session on the watch. Select IR → PC → F / REMOTE again and face the watch toward the adapter. No factory reset is needed.');
  $('ready-label').textContent = t(capture && !pcRemote ? 'The watch is facing the adapter. I am ready to start recording, then press SEND.' : 'I restarted IR → PC for this step; the watch is ready now.');
  $('window-label').textContent = t(capture ? 'Capture window, seconds' : 'Response window, seconds');
  $('response-seconds').max = capture ? 120 : 30;
  $('run-note').textContent = t(serial ? selectedSerialProbe === 'listen' ? 'Receives plain serial bytes at 9600 bit/s without transmitting anything. No IrDA decoder or CRC recovery is used.' : 'The first probe byte is sent after 0.5 seconds. Any incoming byte stops further transmissions; recording continues. No file or firmware data is sent.' : pcRemote ? 'PC / REMOTE is a reception control. Only XID discovery frames are sent, at a fixed 9600 bit/s; no application command is sent.' : discovery ? 'Six search slots and a final identity packet, followed by a listening interval. Answers incoming searches; stops before accepting a connection. Mark SEND presses to help match events.' : passive ? 'The speed stays fixed. No packets are sent back to the watch. You can mark SEND presses in the log; the marker records your click on this page.' :
    'One application command, no automatic retransmission. Normal IrDA discovery, negotiation and acknowledgements are still sent. The page stops after the response window and releases USB; it does not advance to another command.');
  $('steps').replaceChildren(...PROBE_PLAN.map((step, i) => {
    const li = document.createElement('li'); li.textContent = codeHex(step.code);
    if (i === plan.index) li.setAttribute('aria-current', 'step');
    if (i < plan.index) li.className = 'done';
    return li;
  }));
  $('prepare').disabled = !store || busy || ready || done || storageFailed || !navigator.usb;
  $('reset-prepare').disabled = $('prepare').disabled;
  $('disconnect').disabled = busy || !ready;
  $('watch-ready').disabled = !ready || busy || done;
  $('response-seconds').disabled = busy || ready && done;
  $('send').textContent = serial ? t('Start serial test') : discovery ? t('Start discovery') : passive ? t('Start recording') : t('Watch ready — send') + ' ' + codeHex(plan.step.code);
  $('send').disabled = !ready || busy || done || storageFailed || !$('watch-ready').checked;
  $('stop').disabled = !busy || !adapter;
  $('mark-send').hidden = !capture || pcRemote;
  $('mark-send').disabled = !busy || active?.status !== 'running' || active?.kind === 'command';
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
  const c = a?.serialStats ?? a?.passiveStats ?? a?.discoveryStats ?? active?.counters;
  const usb = a?.usbStats ?? active?.usbCounters ?? c;
  $('capture-stats').textContent = `${t('Events')}: ${journal.events.length} · ${t('Saved')}: ${journal.saved}` +
    (isRecordingAttempt(active) ? ` · ${active?.baud} bit/s · RX ${usb?.rxBytes ?? 0} B · ${t('USB reads')}: ${usb?.readCount ?? 0} · ${t('With data')}: ${usb?.nonemptyReads ?? 0} · ${t('Empty reads')}: ${usb?.emptyReads ?? 0} · ${t('SEND markers')}: ${active?.sendMarkers ?? 0}` +
      (active?.kind === 'serial' ? ` · ${t('TX attempts')}: ${c?.txAttempts ?? 0} · ${t('TX completed')}: ${c?.txCompleted ?? 0} · ${t('Before probe')}: ${c?.rxBeforeProbe ?? 0} B · ${t('After probe')}: ${c?.rxAfterProbe ?? 0} B` :
        ` · ${t('CRC-valid frames')}: ${c?.validFrames ?? 0} · CRC ${a?.decoder.badCRC ?? c?.badCRC ?? 0}`) +
      (active?.kind === 'discovery' ? ` · TX ${a?.txFrames ?? c?.txFrames ?? 0} · ${t('Search cycles')}: ${c?.completedCycles ?? 0} · ${t('XID replies')}: ${c?.xidResponses ?? 0} · ${t('XID replies sent')}: ${c?.xidRepliesSent ?? 0}` : '') :
      a ? ` · ${a.baud ?? '—'} bit/s · RX ${a.rxBytes} B · CRC ${a.decoder.badCRC} · recovered ${a.decoder.recoveredFrames}` : '');
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
    const label = isRecordingAttempt(attempt) ? `${t(attempt.kind === 'serial' ? 'Serial bytes' : attempt.kind === 'discovery' ? 'Discovery' : 'Listen')} · ${watchModeName(attempt.watchMode)} · ${attempt.baud}${attempt.kind === 'serial' ? ' · ' + (attempt.probeHex?.toUpperCase() || t('Listen only')) : ''}` : attempt.commandHex.toUpperCase();
    option.textContent = `${attempt.createdAt.slice(0, 19).replace('T', ' ')} UTC · ${label} · ${attempt.status}`;
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
  $('reply').textContent = JSON.stringify(isRecordingAttempt(attempt) ? {
    status: attempt.status, watchMode: attempt.watchMode, baud: attempt.baud,
    ...(attempt.kind === 'serial' ? { probe: attempt.probe, probeHex: attempt.probeHex } : {}), result,
    usbCounters: attempt.usbCounters ?? null,
    sendMarkers: attempt.sendMarkers ?? 0, error: attempt.error ?? null, cleanupError: attempt.cleanupError ?? null,
  } : { status: attempt.status, commandHex: attempt.commandHex,
    commandAttempted: result?.commandAttempted ?? false, commandSent: result?.commandSent ?? false, responseBytes: result?.responseBytes ?? 0,
    responseHex: result?.responseHex ?? '', error: result?.error ?? attempt.error ?? null,
    cleanupError: attempt.cleanupError ?? null }, null, 2);
  $('notes').value = attempt.notes ?? '';
}
async function saveActive() {
  try { await store.save(active); }
  catch (error) { storageError(error); throw error; }
}
async function prepare({ reset = false } = {}) {
  if (busy || adapter?.opened || !isCapture() && plan.state !== 'idle' || storageFailed) return;
  const passive = isListening(), discovery = isDiscovery(), serial = isSerial(), capture = isCapture();
  const settings = serial ? serialSettings({ probe: selectedSerialProbe, watchMode: selectedWatchMode, durationMs: Number($('response-seconds').value) * 1000 }) :
    discovery ? discoverySettings({ watchMode: selectedWatchMode, durationMs: Number($('response-seconds').value) * 1000 }) :
    passive ? listenSettings({ baud: selectedBaud, watchMode: selectedWatchMode, durationMs: Number($('response-seconds').value) * 1000 }) : null;
  active = null; journal = null; $('capture-stats').textContent = ''; $('recent').textContent = '—';
  busy = true; client = null; $('watch-ready').checked = false; controller = new AbortController(); render();
  try {
    const devices = await navigator.usb.getDevices();
    const device = devices.find(d => d.vendorId === 0x066f && d.productId === 0x4200) ||
      await navigator.usb.requestDevice({ filters: [{ vendorId: 0x066f, productId: 0x4200 }] });
    controller.signal.throwIfAborted();
    active = { id: crypto.randomUUID(), kind: serial ? 'serial' : discovery ? 'discovery' : passive ? 'listen' : 'command',
      format: serial ? 'wqv-serial-research-v1' : discovery ? 'wqv-discovery-research-v1' : passive ? 'wqv-listen-research-v1' : 'wqv-command-research-v1', createdAt: new Date().toISOString(),
      ...(capture ? { watchMode: settings.watchMode, baud: settings.baud, sendMarkers: 0 } : { commandHex: codeHex(plan.step.code).toLowerCase(), step: plan.index }),
      ...(serial ? { probe: settings.probe, probeHex: settings.probeHex, repeatMs: settings.repeatMs, framing: 'raw-sir-8n1' } : {}),
      status: 'preparing', notes: '',
      device: { vendorId: device.vendorId, productId: device.productId, productName: device.productName,
        manufacturerName: device.manufacturerName, serialNumber: device.serialNumber, deviceVersionMajor: device.deviceVersionMajor,
        deviceVersionMinor: device.deviceVersionMinor, deviceVersionSubminor: device.deviceVersionSubminor },
      request: { parametersHex: '', usbReset: reset, applicationTransmissions: serial ? null : capture ? 0 : 1, automaticRetransmission: false,
        ...(capture ? { discovery, acknowledgements: false, bulkOutAllowed: discovery || serial && Boolean(settings.probeHex), acceptingConnections: false } : {}),
        ...(serial ? { serialProbe: settings.probe, probeHex: settings.probeHex, repeatMs: settings.repeatMs,
          irlap: false, stopTransmittingOnAnyRX: true, automaticAcknowledgements: false } : {}) },
      capture: { originalUSBBytes: true, syntheticData: false, automaticNextStep: false } };
    await saveActive();
    journal = new Journal(store, active, storageError); journals.set(active.id, journal);
    const record = journal.record;
    record('attempt-prepared', capture ? settings : { commandHex: active.commandHex });
    const attempt = active;
    const usbCounters = { readCount: 0, nonemptyReads: 0, emptyReads: 0, rxBytes: 0 };
    let transport;
    transport = new SigmaTel(captureUSB(device, record, () => ({ baud: transport?.baud ?? null, phase: attempt.status }), { receiveOnly: passive || serial && !settings.probeHex, counters: usbCounters }),
      { log: (level, message) => record('log', { level, message: String(message) }) });
    adapter = transport; adapter.usbStats = usbCounters;
    if (reset) {
      record('usb-reset-request');
      await adapter.io(adapter.device.open(), 'opening USB for reset'); controller.signal.throwIfAborted();
      await adapter.io(adapter.device.reset(), 'resetting SigmaTel USB'); controller.signal.throwIfAborted();
    }
    await adapter.open(); controller.signal.throwIfAborted();
    if (capture) {
      await adapter.setupSIR(); controller.signal.throwIfAborted();
      await adapter.setSIRSpeed(settings.baud); controller.signal.throwIfAborted();
      record(serial ? 'serial-armed' : discovery ? 'discovery-armed' : 'listen-armed', { baud: adapter.baud, watchMode: settings.watchMode,
        ...(serial ? { probe: settings.probe, probeHex: settings.probeHex, repeatMs: settings.repeatMs } : {}) });
    }
    active.status = 'prepared'; active.adapter = adapter.description; active.chipRevision = adapter.revision;
    await journal.drain(); await saveActive();
    status(discovery && settings.watchMode === 'pc-remote' ? 'USB ready. Restart IR → PC → F / REMOTE, tick the checkbox and start discovery.' : capture ? 'USB ready. Prepare the selected SEND mode on the watch, then start recording before sending the image.' :
      'USB ready. Now restart IR → PC on the watch, tick the checkbox and send this command.');
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
    if (active.status === 'prepared') active.status = active.kind === 'command' ? 'released-without-command' : 'released-without-recording';
    journal.record('usb-released'); await journal.drain(); await saveActive();
    status(isCapture() ? 'USB released. Choose the next mode and speed when ready.' : 'USB released. Restart IR → PC before a new attempt.');
  } catch (error) { journal.record('cleanup-error', { error: String(error) }); status(String(error), '', true); }
  finally { adapter = null; busy = false; $('watch-ready').checked = false; await refreshAttempts(active.id); }
}
async function run() {
  const passive = isListening(), discovery = isDiscovery(), serial = isSerial(), capture = isCapture();
  if (busy || !adapter?.opened || !$('watch-ready').checked || !capture && plan.state !== 'idle' || storageFailed) return;
  const seconds = Number($('response-seconds').value);
  if (!$('response-seconds').checkValidity() || !Number.isFinite(seconds) || seconds < 2 || seconds > (capture ? 120 : 30)) { $('response-seconds').reportValidity(); return; }
  if (!capture) plan.begin();
  busy = true; controller = new AbortController(); $('watch-ready').checked = false;
  active.status = 'running'; active.startedAt = new Date().toISOString();
  if (capture) active.captureWindowMs = seconds * 1000; else active.responseWindowMs = seconds * 1000;
  active.notes = $('notes').value; showAttemptOptions(active.id);
  const timer = capture ? null : setTimeout(() => { controller.abort(new Error('Overall step timeout (50 seconds).')); adapter?.close().catch(() => {}); }, 50000);
  if (!capture) client = new ResearchClient(adapter, { signal: controller.signal, record: journal.record,
    log: (level, message) => journal.record('log', { level, message: String(message) }),
    progress: (heading, detail) => status(String(heading), String(detail ?? '')) });
  try {
    await saveActive();
    journal.record('watch-ready', { [capture ? 'captureWindowMs' : 'responseWindowMs']: seconds * 1000 });
    if (serial) {
      status('Serial recording started. Now press SEND on the watch.', `${watchModeName(active.watchMode)} · ${active.probeHex.toUpperCase() || t('Listen only')} · 9600 bit/s`);
      active.result = await probeSerial(adapter, { probe: active.probe, watchMode: active.watchMode, durationMs: seconds * 1000 },
        { signal: controller.signal, record: journal.record });
    } else if (discovery) {
      status(active.watchMode === 'pc-remote' ? 'Active discovery. Waiting for a PC / REMOTE reply.' : 'Active discovery. Now press SEND on the watch.', watchModeName(active.watchMode));
      active.result = await discoverXID(adapter, { watchMode: active.watchMode, durationMs: seconds * 1000 },
        { signal: controller.signal, record: journal.record });
    } else if (passive) {
      status('Recording. Now press SEND on the watch.', `${watchModeName(active.watchMode)} · ${active.baud} bit/s`);
      active.result = await listen(adapter, { baud: active.baud, watchMode: active.watchMode, durationMs: seconds * 1000 },
        { signal: controller.signal, record: journal.record });
    } else {
      await client.openPrimary();
      active.model = client.model; active.negotiatedBaud = adapter.baud;
      active.result = await client.probe(plan.step.code, seconds * 1000);
    }
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
    if (serial && active.result) {
      active.result = finishSerialCapture(active.result, journal.events);
      active.status = controller.signal.aborted ? 'interrupted' : active.result.status;
      for (const key of ['rxBytes', 'rxBeforeProbe', 'rxAfterProbe', 'readCount', 'nonemptyReads', 'emptyReads']) adapter.serialStats[key] = active.result[key];
    }
    active.finishedAt = new Date().toISOString();
    active.captureMayBeIncomplete = ['interrupted', 'error', 'byte-limit', 'probe-not-sent'].includes(active.status) || Boolean(active.cleanupError);
    active.counters = { rxBytes: adapter.rxBytes, txFrames: adapter.txFrames, badCRC: adapter.decoder.badCRC,
      recoveredFrames: adapter.decoder.recoveredFrames, fifoRecoveries: adapter.fifoRecoveries, ...adapter.passiveStats, ...adapter.discoveryStats, ...adapter.serialStats };
    active.usbCounters = { ...adapter.usbStats };
    if (discovery && active.result) Object.assign(active.result, active.usbCounters);
    if (!capture && !active.result && client.probing) active.result = { commandAttempted: client.commandAttempted, commandSent: client.commandSent,
      responseHex: toHex(client.appBuffer), responseBytes: client.appBuffer.length };
    journal.record('step-finished', { status: active.status, counters: active.counters });
    if (!storageFailed) { try { await journal.drain(); await saveActive(); } catch {} }
    if (!capture) { plan.finish(); savePosition(); }
    busy = false; adapter = null;
    if (!storageFailed) {
      status(capture ? active.status === 'error' ? 'Recording ended with an error. USB data received so far is kept.' :
        active.status === 'interrupted' ? 'Recording interrupted. All USB data received so far is kept.' :
        serial ? ({ captured: 'Serial bytes captured. Further transmissions stopped; save the ZIP to inspect the original stream.',
          'probe-not-sent': 'The probe was not sent. A pending USB read may have prevented transmission; this is not a watch response test.',
          'byte-limit': 'The capture reached its byte limit. All delivered bytes are preserved.' })[active.status] ?? 'Serial test finished. No USB bytes received; check TX completion before interpreting silence.' :
        discovery ? ({ 'connection-request': 'The peer requested a connection. The request was saved; no connection was accepted.',
          'peer-found': 'Peer discovered. Save the ZIP to inspect its identity and replies.',
          'data-no-peer': 'Discovery finished. USB bytes were received, but no addressed peer XID was recognized.' })[active.status] ?? 'Discovery finished. No USB bytes received; the cause of silence is still unknown.' :
        active.status === 'no-data' ? 'Recording finished with no bytes delivered by SigmaTel. Check the watch mode, speed and alignment before retrying.' :
          'Recording finished. USB released. Each new recording starts manually.' :
        active.status === 'interrupted' ? 'Step interrupted. Raw data received so far is kept.' :
          'Step finished. Reset the watch transfer session before continuing. The next step is manual.',
      t(active.error ?? active.result?.error?.message ?? ''), active.status === 'error' || Boolean(active.cleanupError));
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
      const label = isRecordingAttempt(attempt) ? `${attempt.kind}-${attempt.watchMode}-${attempt.baud}${attempt.kind === 'serial' ? '-' + attempt.probe : ''}` : attempt.commandHex;
      const folder = `${attempt.createdAt.replace(/[:.]/g, '-')}-${label}-${attempt.id}`;
      for (const file of attemptFiles(meta, events)) files.push({ ...file, name: `${folder}/${file.name}` });
    }
    download(zipFiles(files), `WQV-command-research-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  } catch (error) { status(String(error), '', true); }
}

$('prepare').onclick = () => prepare().catch(error => status(String(error), '', true));
$('reset-prepare').onclick = () => prepare({ reset: true }).catch(error => status(String(error), '', true));
$('disconnect').onclick = () => release().catch(error => status(String(error), '', true));
$('send').onclick = () => run().catch(error => status(String(error), '', true));
$('stop').onclick = () => { journal?.record('manual-stop'); controller?.abort(new DOMException('Stopped by user.', 'AbortError')); adapter?.close().catch(() => {}); };
$('watch-ready').onchange = render;
for (const nextMode of RESEARCH_MODES) $('mode-' + nextMode).onclick = () => {
  if (busy || adapter?.opened) return;
  mode = nextMode; $('watch-ready').checked = false; $('response-seconds').value = isCapture() ? 20 : 5;
  if (isSerial()) { selectedWatchMode = 'swan-send'; $('watch-mode').value = selectedWatchMode; }
  else if (!isDiscovery() && !LISTEN_MODES.includes(selectedWatchMode)) { selectedWatchMode = 'watch-send'; $('watch-mode').value = selectedWatchMode; }
  try { localStorage.setItem('wqv-research.mode', mode); } catch {}
  status('Prepare USB. Keep the watch out of transfer mode until the adapter is ready.'); render();
};
function selectSerialProbe(value) {
  if (busy || adapter?.opened || !SERIAL_PROBES.some(item => item.id === value)) return;
  selectedSerialProbe = value; $('serial-probe').value = value; $('watch-ready').checked = false;
  try { localStorage.setItem('wqv-research.serial-probe', value); } catch {}
  status('Prepare USB. Keep the watch out of transfer mode until the adapter is ready.'); render();
}
$('serial-probe').onchange = () => selectSerialProbe($('serial-probe').value);
$('serial-next').onclick = () => selectSerialProbe(SERIAL_PROBES[SERIAL_PROBES.findIndex(item => item.id === selectedSerialProbe) + 1]?.id);
for (const id of ['watch-mode', 'listen-baud']) $(id).onchange = () => {
  selectedWatchMode = $('watch-mode').value; selectedBaud = Number($('listen-baud').value); $('watch-ready').checked = false;
  try { localStorage.setItem('wqv-research.listen', JSON.stringify({ watchMode: selectedWatchMode, baud: selectedBaud })); } catch {}
  render();
};
$('mark-send').onclick = () => {
  if (!busy || !isRecordingAttempt(active) || active.status !== 'running') return;
  active.sendMarkers++; journal.record('watch-send-mark', { watchMode: active.watchMode, baud: active.baud, marker: active.sendMarkers });
  showReport(); drawCapture();
};
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
$('language').onchange = () => { setLanguage($('language').value); render(); drawCapture(); };
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
