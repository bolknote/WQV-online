import { SigmaTel, withTimeout } from './sigmatel.mjs';
import { fromHex } from './formats.mjs';
import { getLanguage, setLanguage } from './i18n.mjs';
import { captureUSB } from './research-core.mjs';
import { openResearchStore, Journal } from './research-store.mjs';
import { listen } from './listen-core.mjs';
import { SWAN_LISTEN_PLAN, confirmedConditions, analyseSwanListening, swanListeningFiles } from './swan-listen-core.mjs';
import { ManualSerialTrigger, probeSerialPacket } from './serial-core.mjs';
import { SWAN_SYNC_PLAN, SWAN_REPLAYS, ReplayTiming, canReplayNow, syncConditions, analyseSwanSync, swanSyncFiles } from './swan-sync-core.mjs';
import { SWAN_PHYSICAL_PLAN, physicalSettings, applySwanPhysical, physicalConditions, swanPhysicalFiles } from './swan-physical-core.mjs';
import { SWAN_AUTOTUNE_PLAN, AUTOTUNE_PROFILES, listenAutotune, autoTuneConditions, swanAutotuneFiles } from './swan-autotune-core.mjs';
import { SWAN_PEER_PLAN, SWAN_PEER_VARIANT_PLAN, PEER_CADENCE, makePeerPayloadPlan, PeerSeriesTrigger, replayPeer, peerConditions, swanPeerFiles } from './swan-peer-core.mjs';
import { zipFiles } from './zip.mjs';

const ru = {
  'SWAN listening': 'Прослушивание SWAN', 'Packet probes': 'Пробы пакетов', Language: 'Язык',
  'Compare 9600 and 38400 bit/s with a separate background capture at each speed. The adapter only receives. The watch speed is still unknown.': 'Сравнение 9600 и 38400 бит/с с отдельной фоновой записью на каждой скорости. Адаптер только принимает. Скорость обмена часов пока неизвестна.',
  'Manual steps': 'Шаги вручную', 'Each step starts manually. Restart the watch mode for every watch capture.': 'Каждый шаг запускается вручную. Перед каждой записью с часами заново включайте режим обмена.',
  '1. Prepare USB': '1. Подготовьте USB', 'Release SigmaTel in other tabs or apps. Prepare the adapter before activating the watch.': 'Освободите SigmaTel в других вкладках и приложениях. Подготовьте адаптер до включения обмена на часах.',
  'Prepare SigmaTel USB…': 'Подготовить SigmaTel USB…', 'Release USB': 'Освободить USB',
  '2. Confirm this setup and record': '2. Подтвердите условия и начните запись', Seconds: 'Секунды',
  'Start recording': 'Начать запись', 'Mark watch button press': 'Отметить нажатие на часах', Stop: 'Остановить',
  'Start recording first. Then press the final SEND or RECEIVE button on the watch and mark it here immediately. Keep the watch and adapter in position.': 'Сначала начните запись. Затем нажмите последнюю кнопку SEND или RECEIVE на часах и сразу отметьте нажатие здесь. Не меняйте положение часов и адаптера.',
  '← Previous step': '← Предыдущий шаг', 'Next step →': 'Следующий шаг →', 'Saved recordings': 'Сохранённые записи', Attempt: 'Попытка',
  'Prepare attempt ZIP…': 'Подготовить ZIP попытки…', 'Prepare raw RX…': 'Подготовить сырой RX…',
  'Final watch display': 'Экран часов после опыта', 'Not recorded': 'Ещё не записано', 'I did not observe it': 'Я не следил за экраном',
  'Small SEND remained': 'Осталась маленькая надпись SEND', 'Cancelled manually': 'Отменил вручную', 'No visible change': 'Видимых изменений нет',
  'Background control, watch removed': 'Фоновый контроль, часы убраны', Notes: 'Заметки', 'Save observation': 'Сохранить наблюдение',
  'Attempt details': 'Подробности попытки', 'Recent events': 'Последние события',
  'Raw USB bytes and timestamps · no automatic next step': 'Сырые USB-байты и время · без автоматического перехода',
  '9600 · signal and byte replay': '9600 · сигнал и повтор полученных байтов',
  'Previously received bytes': 'Байты из предыдущих записей', 'Send once': 'Отправить один раз',
  'One contiguous transmission. No added framing, CRC, acknowledgements or repeats. Use the same bytes for the control and watch test.': 'Одна посылка подряд. Без добавленных рамок, CRC, подтверждений и повторов. Для контроля и теста с часами выбирайте одинаковые байты.',
  'Mark every front-button press separately. After RX appears, cover the optical path with an opaque card for about 3 seconds, then uncover it. Mark each change here. Page marks may lag the physical action.': 'Отмечайте каждое нажатие передней кнопки отдельно. После появления RX перекройте ИК-луч непрозрачной карточкой примерно на 3 секунды, затем откройте. Отметьте оба действия здесь. Метки могут запаздывать относительно действия.',
  'IR path covered': 'ИК-луч закрыт', 'IR path uncovered': 'ИК-луч открыт',
  'Send chosen bytes once': 'Отправить выбранные байты один раз',
  'Entered photo selection': 'Вошёл в выбор снимка', 'Changed the selected photo': 'Сменил снимок',
  'Started sending on the watch': 'Начал передачу на часах',
  'Send timing': 'Когда отправить', 'With the Start button': 'По кнопке начала опыта',
  'After incoming bytes, once': 'После входящих байтов, один раз', 'Separate Send button': 'Отдельной кнопкой отправки',
  'With the RECEIVE mark': 'По отметке нажатия RECEIVE',
  'Prepare all recordings…': 'Подготовить все записи…',
  '9600 · pulse width and receiver': '9600 · длительность импульса и приёмник',
  'Infrared settings': 'Параметры ИК-связи', 'Register readback': 'Прочитанные регистры',
  'Keep the same photo, placement and recording duration for every comparison. Each step prepares USB again before you activate the watch.': 'Для сравнения оставляйте тот же снимок, положение часов и длительность записи. Перед каждым опытом заново подготовьте USB, затем включите обмен на часах.',
  'Automatic comparison in one SEND': 'Автоподбор за одну передачу SEND',
  'Automatic receiver comparison': 'Автоматическое сравнение приёмника',
  'Receiver setting': 'Настройка приёмника', Samples: 'Посылок',
  'Most repeated bytes': 'Чаще всего принято', Repeatability: 'Повторяемость',
  'The page compares unmodified bursts without requiring 7A 06 F0. A stable output is a candidate, not proof of correct decoding. No bytes are sent to the watch.': 'Сравниваются исходные посылки без требования получить 7A 06 F0. Устойчивый результат — кандидат, а не доказательство правильного декодирования. На часы ничего не отправляется.',
  'RECEIVE · repeated greeting': 'RECEIVE · повтор приветствия',
  'RECEIVE · byte / bit / random': 'RECEIVE · байты / биты / случайные',
  'Planned triples': 'Запланированные тройки',
  'Recorded SEND cadence → watch RECEIVE': 'Ритм записанного SEND → RECEIVE часов',
  '22 copies of 7A 06 F0 over about 14.31 seconds. Start records only; the RECEIVE mark starts the series once. Any RX after TX pauses the remaining repeats while recording continues.': '22 посылки 7A 06 F0 примерно за 14,31 секунды. Начало опыта только запускает запись; отметка RECEIVE один раз запускает серию. При любом RX после TX повторы прекращаются, запись продолжается.',
  'The cadence uses USB timestamps. The adapter sends normal SIR bytes, without reproducing hypothetical stretched start bits or source byte gaps. All received bytes, including possible echo, are preserved.': 'Ритм взят из отметок USB. Адаптер передаёт обычные SIR-байты, без воспроизведения предполагаемых растянутых старт-битов и промежутков внутри посылки. Все входящие байты, включая возможное эхо, сохраняются.',
};
const $ = id => document.getElementById(id), t = key => getLanguage() === 'ru' ? ru[key] ?? key : key;
const words = (en, russian) => getLanguage() === 'ru' ? russian : en;
const experiment = new URLSearchParams(location.search).get('experiment');
const variantMode = experiment === 'variants', peerMode = variantMode || experiment === 'peer', autoMode = experiment === 'auto', physicalMode = peerMode || autoMode || experiment === 'physical', syncMode = physicalMode || experiment === 'sync';
const plan = variantMode ? SWAN_PEER_VARIANT_PLAN : peerMode ? SWAN_PEER_PLAN : autoMode ? SWAN_AUTOTUNE_PLAN : physicalMode ? SWAN_PHYSICAL_PLAN : syncMode ? SWAN_SYNC_PLAN : SWAN_LISTEN_PLAN;
const suiteName = variantMode ? 'peer-variants' : peerMode ? 'peer' : autoMode ? 'autotune' : physicalMode ? 'physical' : syncMode ? 'signal' : 'listening';
let index = 0, store, adapter, active, journal, controller, unlock, busy = false, broken = false, attempts = [];
let message = ['Opening the journal…', 'Открываем журнал…'], messageError = false;
let downloadURL, exporting = false;
let trigger, replayTiming, path = 'open', signalAnalysis, lastAnalysedEvents = -1;
let autoSummary = null;
let peerSummary = null;
const journals = new Map();
const step = () => plan[index];
const selected = () => active?.id === $('attempts').value ? active : attempts.find(item => item.id === $('attempts').value);
const label = item => {
  const preset = [...SWAN_PEER_VARIANT_PLAN, ...SWAN_PEER_PLAN, ...SWAN_AUTOTUNE_PLAN, ...SWAN_PHYSICAL_PLAN, ...SWAN_SYNC_PLAN].find(value => value.id === (item.stepId ?? item.id));
  return `${preset ? words(preset.en, preset.ru) : item.watchPresent ? item.watchMode.toUpperCase().replace('-', ' ') : words('Background, watch removed', 'Фон, часы убраны')} · ${item.baud}`;
};
function status(en, russian, error = false) { message = [en, russian]; messageError = error; $('status').textContent = words(...message); $('status').classList.toggle('error', error); }
const profileLabel = p => `~${Math.round(p.estimatedBaud)} bit/s · RX ${p.rxSamples}`;
function renderPeer(summary = peerSummary) {
  if (!peerMode) return;
  const text = summary ? words(`TX: ${summary.fifoCompleted}/${summary.planned} USB + FIFO; skipped: ${summary.skipped}. `, `TX: ${summary.fifoCompleted}/${summary.planned} USB + FIFO; пропущено: ${summary.skipped}. `) +
    (summary.pausedByRX ? words('RX arrived; further repeats are paused.', 'Получен RX; дальнейшие повторы остановлены.') : summary.finished ? words('Recording finished.', 'Запись завершена.') : summary.started ? words('Recording continues.', 'Запись продолжается.') : words('Waiting for the RECEIVE mark.', 'Ожидаем отметку RECEIVE.')) : words('Waiting for recording and the RECEIVE mark.', 'Ожидаем начало записи и отметку RECEIVE.');
  $('peer-progress').textContent = text; $('replay-tx-status').textContent = text;
  $('peer-timeline').textContent = (summary?.entries ?? []).slice(-6).map(e =>
    `#${e.repetition}${e.dataHex ? ` · ${e.dataHex.toUpperCase().match(/../g).join(' ')}` : ''} · ${e.state} · ${words('plan', 'план')} ${e.plannedOffsetMs.toFixed(1)} ms · ${words('request', 'запрос')} ${e.requestedOffsetMs.toFixed(1)} ms · Δ ${e.lateMs.toFixed(1)} ms`).join('\n');
}
function renderAutoTune(summary = autoSummary) {
  if (!autoMode) return;
  const profiles = AUTOTUNE_PROFILES[summary?.group ?? step().tuneGroup];
  const phases = { scan: words('Comparing seven settings', 'Сравниваем семь настроек'), verify: words('Rechecking two candidates', 'Перепроверяем два варианта'), hold: words('Recording with the provisional choice', 'Записываем с предварительно выбранной настройкой') };
  const current = profiles.find(p => p.id === summary?.currentProfileId);
  $('auto-progress').textContent = summary ? `${phases[summary.phase]} · ${summary.studiedBursts} / ${summary.sampleBudget}` + (current ? ` · ${profileLabel(current)}` : '') : words('Waiting. One watch SEND compares seven settings and rechecks two candidates using about 20 repeats.', 'Ожидаем запуск. За одну передачу SEND сравним семь настроек и перепроверим два варианта, используя около 20 повторов.');
  $('auto-rows').replaceChildren(...profiles.map(p => {
    const row = summary?.rows.find(row => row.id === p.id), tr = document.createElement('tr');
    if (p.id === summary?.currentProfileId) tr.setAttribute('aria-current', 'true');
    for (const value of [profileLabel(p), row?.samples ?? 0, row?.modeHex?.toUpperCase().match(/../g).join(' ') ?? '—', row?.samples ? `${row.equalToMode} / ${row.samples}` : '—']) {
      const cell = document.createElement('td'); cell.textContent = value; tr.append(cell);
    }
    return tr;
  }));
  const winner = profiles.find(p => p.id === summary?.winnerId);
  $('auto-choice').textContent = winner ? words(`Provisional choice: ${profileLabel(winner)}. Decoding correctness is unverified.`, `Предварительный выбор: ${profileLabel(winner)}. Правильность декодирования не подтверждена.`) : words('No setting selected yet.', 'Настройка пока не выбрана.');
}
function render() {
  const ready = Boolean(adapter?.opened), running = busy && active?.status === 'running',
    replayMode = physicalMode ? step().replayTrigger ?? 'manual' : $('replay-timing').value;
  document.documentElement.lang = getLanguage(); $('language').value = getLanguage();
  for (const element of document.querySelectorAll('[data-text]')) element.textContent = t(element.dataset.text);
  if (syncMode) {
    document.title = 'WQV Link · SWAN signal / replay';
    $('app-title').textContent = words('SWAN · signal / replay', 'SWAN · сигнал / повтор байтов');
    document.querySelector('.desktop-caption span:last-child').textContent = 'SWAN / 9600';
    document.querySelector('.research-notice').textContent = words('9600 bit/s. Check button stages and the optical path, then try received bytes as a reply. Each experiment starts manually; replay timing is selectable.', '9600 бит/с. Проверяем этапы нажатий и ИК-луч, затем пробуем полученные байты как ответ. Каждый опыт запускается вручную; момент отправки выбирается.');
    $('experiment-link').href = './swan-listen.html'; $('experiment-link').textContent = words('Previous passive recordings', 'Прежние пассивные записи');
  }
  $('physical-link').hidden = physicalMode;
  $('physical-settings').hidden = !physicalMode || autoMode;
  $('auto-link').hidden = autoMode; $('auto-settings').hidden = !autoMode;
  $('peer-link').hidden = peerMode && !variantMode; $('peer-settings').hidden = !peerMode;
  $('variants-link').hidden = variantMode;
  $('peer-payload-description').hidden = !variantMode; $('peer-payload-details').hidden = !variantMode;
  if (physicalMode) {
    document.title = 'WQV Link · SWAN physical settings';
    $('app-title').textContent = words('SWAN · pulse width / receiver', 'SWAN · импульс / приёмник');
    $('experiment-link').href = './swan-listen.html?experiment=sync';
    $('experiment-link').textContent = words('Signal and byte replay recordings', 'Записи сигнала и повтора байтов');
    document.querySelector('.research-notice').textContent = words('First compare two transmit pulse widths with the same reply. Then compare receiver thresholds without transmitting. All steps use 9600 bit/s and start manually.', 'Сначала сравните две длительности передающего импульса с одинаковым ответом. Затем — пороги приёмника без отправки байтов. Во всех опытах 9600 бит/с; каждый запускается вручную.');
    const settings = physicalSettings(step());
    const pulse = settings.txPulseUs.toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 });
    $('physical-setting-summary').textContent = words(
      `9600 bit/s · SWAN SEND · TX pulse ${pulse} µs · RX threshold ${settings.rxSamples} samples. ` + (step().transmit ? 'Reply: 7A 06 F0, once after 12 ms without incoming bytes. RX threshold stays at 8 samples.' : 'Receive only; no bytes are sent. More required samples means a stricter pulse threshold.'),
      `9600 бит/с · SWAN SEND · импульс TX ${pulse} мкс · порог RX ${settings.rxSamples} отсчётов. ` + (step().transmit ? 'Ответ: 7A 06 F0, один раз после паузы во входящих данных 12 мс. Порог RX остаётся 8 отсчётов.' : 'Только приём, без отправки байтов. Больше отсчётов — строже порог распознавания импульса.'));
    const applied = active?.stepId === step().id ? active.physicalSettings : null;
    $('physical-readback').textContent = applied?.verified ? words('Settings accepted and verified by USB readback.', 'Настройка принята и проверена чтением через USB.') : active?.stepId === step().id && active.status === 'preparation-error' ? words('Settings were not verified. Recording has not started.', 'Настройка не подтверждена. Запись не запущена.') : words('Settings will be applied and checked when you prepare USB.', 'Настройка будет применена и проверена при подготовке USB.');
    $('physical-registers').textContent = applied ? JSON.stringify(applied, null, 2) : '—';
  }
  $('step-heading').textContent = `${index + 1}. ${label(step())}`;
  const mode = step().watchMode === 'swan-send' ? 'SEND' : 'RECEIVE';
  $('step-note').textContent = step().watchPresent ? words(`Restart IR → SWAN → ${mode}. Select a photo for SEND. Face the watch toward SigmaTel at 5–10 cm. Leave the final button until recording starts.`, `Заново выберите IR → SWAN → ${mode}. Для SEND выберите снимок. Поставьте часы напротив SigmaTel на расстоянии 5–10 см. Последнюю кнопку нажмите после начала записи.`) : words('Remove the watch from the infrared path. Leave the adapter, lighting and USB connection unchanged for this background control.', 'Уберите часы из ИК-луча. Оставьте адаптер, освещение и подключение USB прежними — это фоновая контрольная запись.');
  $('ready-label').textContent = step().watchPresent ? words(`I restarted SWAN ${mode}; the watch faces the adapter; the final button is still pending.`, `Я заново включил SWAN ${mode}; часы напротив адаптера; последняя кнопка ещё не нажата.`) : words('I removed the watch from the infrared path for this control.', 'Я убрал часы из ИК-луча для контрольной записи.');
  if (syncMode && step().watchPresent) {
    $('step-note').textContent = words(`Restart IR → SWAN → ${mode}${mode === 'SEND' ? ' and select a photo' : ''}. Face the watch toward SigmaTel at 5–10 cm. Start recording before the front-button presses. Mark each press separately; continue until the small SEND/RECEIVE indicator appears.${step().transmit ? ' When RX appears, send the selected bytes once. Leave the optical path open for this replay test.' : ' Once RX appears, cover and uncover the IR path, marking both actions.'}`, `Заново выберите IR → SWAN → ${mode}${mode === 'SEND' ? ' и снимок' : ''}. Поставьте часы напротив SigmaTel на расстоянии 5–10 см. Начните запись до нажатий передней кнопки. Отмечайте каждое нажатие отдельно; включите маленький индикатор SEND/RECEIVE.${step().transmit ? ' Когда появится RX, отправьте выбранные байты один раз. В этом опыте ИК-луч оставьте открытым.' : ' После появления RX закройте и откройте ИК-луч, отмечая оба действия.'}`);
  }
  if (syncMode && step().watchMode === 'swan-send') {
    $('step-note').textContent = words('Select IR → SWAN → SEND, before the first front-button press. Start recording. Press the front button once to enter photo selection and mark that stage below. Wait 3 seconds; change the photo with the right-hand buttons and mark each change. Wait 3 seconds again. Press the front button a second time to send; mark that stage too. ' + (step().transmit ? replayMode === 'rx' ? 'The chosen bytes will be sent once after incoming bytes, without another click.' : 'Click Send now at the chosen moment; no RX is required.' : 'While RX continues, cover the IR path for about 3 seconds and uncover it; mark both changes.'), 'Выберите IR → SWAN → SEND, пока не нажимая переднюю кнопку. Начните запись. Первым нажатием войдите в выбор снимка и отметьте этот этап ниже. Подождите 3 секунды; смените снимок правыми кнопками и отметьте смену. Подождите ещё 3 секунды. Вторым нажатием передней кнопки начните передачу и отметьте её начало. ' + (step().transmit ? replayMode === 'rx' ? 'На входящие байты уйдёт одна выбранная посылка; дополнительное нажатие не нужно.' : 'Нажмите «Отправить сейчас» в выбранный момент; ждать RX не требуется.' : 'Пока поступает RX, закройте ИК-луч примерно на 3 секунды и откройте, отметив оба действия.'));
    $('ready-label').textContent = words('SWAN SEND is selected before photo selection; the IR path is open.', 'Выбран SWAN SEND до входа в выбор снимка; ИК-луч открыт.');
  }
  const stageButtons = syncMode && !autoMode && step().watchMode === 'swan-send';
  $('activation-note').hidden = syncMode && !step().watchPresent;
  if (stageButtons) $('activation-note').textContent = words('Record before the first front-button press. Use the three stage buttons below to separate photo selection, photo changes and transmission.', 'Начните запись до первого нажатия передней кнопки. Три кнопки ниже отмечают выбор снимка, его смену и начало передачи отдельно.');
  if (syncMode && step().transmit) {
    $('signal-note').textContent = words('One transmission per capture, at the selected time. The separate Send button is shown only for Manual timing. Keep the optical path open and use the same replay for the no-watch control.', 'На запись — одна посылка в выбранный момент. Отдельная кнопка отправки видна только в ручном режиме. Оставьте ИК-луч открытым; для контроля без часов выбирайте те же байты.');
    $('activation-note').hidden = !step().watchPresent;
    $('activation-note').textContent = replayMode === 'start' ? words('Activate SEND or RECEIVE on the watch first, then click Start recording and send once.', 'Сначала включите передачу SEND или приём RECEIVE на часах, затем нажмите «Начать запись и отправить один раз».') : words('Start recording before activating the watch. RX timing sends once after incoming bytes; Manual timing waits for Send now.', 'Начните запись до включения часов. При выборе ответа на RX посылка уйдёт один раз после входящих байтов; ручной вариант ждёт кнопки отправки.');
    if (replayMode === 'start') {
      const modeName = step().watchMode === 'swan-send' ? 'SEND' : 'RECEIVE';
      $('step-note').textContent = step().watchPresent ? words(`Restart IR → SWAN → ${modeName} and activate it. Then click Start recording and send once immediately. There is no need to wait for RX or click another send button.`, `Заново выберите IR → SWAN → ${modeName} и включите ${modeName === 'SEND' ? 'передачу вторым нажатием передней кнопки' : 'приём'}. Сразу нажмите «Начать запись и отправить один раз». Ждать RX и нажимать ещё одну кнопку отправки не нужно.`) : words('Remove the watch from the infrared path. Start recording and send once writes the selected bytes immediately, to check USB, FIFO and possible echo.', 'Уберите часы из ИК-луча. Кнопка «Начать запись и отправить один раз» сразу отправит выбранные байты для проверки USB, FIFO и возможного эха.');
      if (step().watchPresent) $('ready-label').textContent = words(`The watch is facing SigmaTel with ${modeName} activated.`, `Часы напротив SigmaTel; ${modeName} уже включён.`);
    }
    if (replayMode === 'receive-mark') {
      $('step-note').textContent = words('Select IR → SWAN → RECEIVE, leaving the final front-button press until recording starts. Start recording, activate reception on the watch, then immediately click Mark RECEIVE and send once. That click queues one transmission; later marks do not send again.', 'Выберите IR → SWAN → RECEIVE, пока не нажимая последнюю кнопку на часах. Начните запись, включите приём на часах и сразу нажмите «Отметить RECEIVE и отправить один раз». Эта кнопка запросит одну отправку; следующие отметки повторно ничего не отправляют.');
      $('activation-note').textContent = words('Start only begins recording. The RECEIVE mark queues the bytes. A page click may lag the watch button; both the mark and actual USB transmission are recorded separately.', 'Начало опыта только запускает запись. Отметка RECEIVE запрашивает отправку. Нажатие на странице может запаздывать относительно кнопки часов; время отметки и фактической USB-записи сохраняется отдельно.');
    }
  }
  if (physicalMode) {
    $('step-note').textContent = words('Prepare USB first. Select IR → SWAN → SEND on the watch, before the first front-button press. Start recording. Press the front button once to enter photo selection; select the same photo as in the other tests. Press it a second time to start sending. Mark each stage below. ' + (step().transmit ? 'The page replies once to the first incoming burst; no Send click is needed.' : 'The adapter only receives during this step.'), 'Сначала подготовьте USB. На часах выберите IR → SWAN → SEND до первого нажатия передней кнопки. Начните запись. Первым нажатием войдите в выбор снимка; выберите тот же снимок, что в остальных опытах. Вторым нажатием начните передачу. Отметьте оба этапа ниже. ' + (step().transmit ? 'Страница один раз ответит на первую группу входящих байтов; нажимать кнопку отправки не нужно.' : 'В этом опыте адаптер только принимает.'));
    $('ready-label').textContent = words('SWAN SEND is selected before photo selection; I will use the same photo, placement and recording duration.', 'Выбран SWAN SEND до выбора снимка; снимок, положение часов и длительность записи будут одинаковыми.');
    $('activation-note').textContent = words('Start recording before the two front-button presses. Mark photo selection first, then the actual transmission.', 'Начните запись до двух нажатий передней кнопки. Сначала отметьте выбор снимка, затем начало передачи.');
    $('signal-note').textContent = step().transmit ? words('One fixed reply after incoming bytes. Only the transmit pulse width changes between the first two tests. Keep the IR path open.', 'Один фиксированный ответ после входящих байтов. В первых двух опытах меняется только длительность передающего импульса. ИК-луч оставьте открытым.') : words('Passive recording. Only the receive threshold changes; keep the IR path open and the watch in the same position.', 'Пассивная запись. Меняется только порог приёмника; ИК-луч оставьте открытым, часы — в том же положении.');
  }
  if (autoMode) {
    document.title = 'WQV Link · SWAN automatic receiver';
    $('app-title').textContent = words('SWAN · automatic receiver', 'SWAN · автоподбор приёмника');
    document.querySelector('.desktop-caption span:last-child').textContent = 'SWAN / AUTO RX';
    $('experiment-link').href = './swan-listen.html?experiment=physical';
    $('experiment-link').textContent = words('Manual comparison recordings', 'Записи ручного сравнения');
    $('physical-link').hidden = true;
    document.querySelector('.research-notice').textContent = words('One watch SEND session per mode. The page automatically switches settings between repeats, then rechecks two candidates. During sampling it sends no bytes and never resets FIFO.', 'Одна передача часов SEND на режим. Страница сама переключает настройки между повторами и перепроверяет два варианта. Во время подбора байты не отправляются, FIFO не сбрасывается.');
    $('step-note').textContent = words('Prepare USB, then start recording. On the watch select IR → SWAN → SEND. Press the front button once to select the photo, then a second time to start sending. Keep the watch in position; no further clicks are needed until the comparison finishes. ' + (step().tuneGroup === 'clock' ? 'This mode tests seven clock divisors around 9600 bit/s with RX fixed at 24 samples.' : 'This mode tests all seven legal RX thresholds with the rate fixed at 9600 bit/s.'), 'Подготовьте USB и начните запись. На часах выберите IR → SWAN → SEND. Первым нажатием передней кнопки войдите в выбор снимка, вторым начните передачу. Оставьте часы на месте; до завершения сравнения больше ничего нажимать не нужно. ' + (step().tuneGroup === 'clock' ? 'Этот режим проверит семь делителей частоты около 9600 бит/с при пороге RX 24 отсчёта.' : 'Этот режим проверит все семь допустимых порогов RX на скорости 9600 бит/с.'));
    $('ready-label').textContent = words('The watch faces the adapter. I will start SEND after recording begins.', 'Часы напротив адаптера. Запущу SEND после начала записи.');
    $('activation-note').textContent = words('Record first, then activate SEND with the two front-button presses. Button marks are optional; settings switch automatically after receive pauses.', 'Сначала запись, затем SEND двумя нажатиями передней кнопки. Метки нажатий необязательны; настройки переключаются автоматически в паузах приёма.');
  }
  if (peerMode) {
    document.title = 'WQV Link · SWAN RECEIVE greeting';
    $('app-title').textContent = words('SWAN · RECEIVE greeting', 'SWAN · приветствие для RECEIVE');
    document.querySelector('.desktop-caption span:last-child').textContent = 'SWAN / PEER REPLAY';
    $('experiment-link').href = './swan-listen.html?experiment=sync';
    $('experiment-link').textContent = words('Single-packet recordings', 'Записи одиночных посылок');
    $('physical-link').hidden = true;
    document.querySelector('.research-notice').textContent = words('Send the observed greeting 22 times to a watch in SWAN RECEIVE. The RECEIVE mark starts one bounded series. RX pauses further transmissions so we can record the possible reply.', 'Отправляем наблюдавшееся приветствие 22 раза часам в SWAN RECEIVE. Отметка RECEIVE запускает одну ограниченную серию. При RX отправка прекращается, чтобы записать возможный ответ.');
    $('step-note').textContent = words('Prepare USB and start recording. On the watch select IR → SWAN → RECEIVE, activate reception with its final front-button press, then immediately click Mark RECEIVE and start 22 repeats. Leave the watch and adapter in position. The second step repeats the test with the other transmit pulse width.', 'Подготовьте USB и начните запись. На часах выберите IR → SWAN → RECEIVE, включите приём последним нажатием передней кнопки и сразу нажмите «Отметить RECEIVE и запустить 22 повтора». Оставьте часы и адаптер на месте. Второй шаг повторяет опыт с другой длительностью передающего импульса.');
    $('ready-label').textContent = words('The watch faces SigmaTel; I will activate RECEIVE after recording starts.', 'Часы напротив SigmaTel; включу RECEIVE после начала записи.');
    $('activation-note').textContent = words('Start does not transmit. After activating RECEIVE on the watch, mark it here once. Later marks cannot restart the series.', 'Начало записи ничего не отправляет. Включив RECEIVE на часах, один раз отметьте нажатие здесь. Последующие отметки серию не перезапускают.');
    const pulse = physicalSettings(step()).txPulseUs.toLocaleString(getLanguage() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2 });
    $('physical-setting-summary').textContent = `9600 bit/s · SWAN RECEIVE · TX ${pulse} µs · RX 8 · 22 × 7A 06 F0`;
    $('physical-position-note').textContent = words('Keep the watch and adapter in position. Restart RECEIVE before each manually selected step.', 'Оставьте часы и адаптер в одном положении. Перед каждым выбранным вручную шагом заново включайте RECEIVE.');
  }
  if (variantMode) {
    document.title = 'WQV Link · SWAN byte / bit / random';
    $('app-title').textContent = words('SWAN · byte / bit / random', 'SWAN · байты / биты / случайные');
    document.querySelector('.desktop-caption span:last-child').textContent = 'SWAN / FIVE EXPERIMENTS';
    document.querySelector('.research-notice').textContent = words('Five separate RECEIVE experiments: reverse byte order, reverse eight bits within each byte, random triples, and bit-inverted versions of the first two. Every step starts manually; an incoming byte pauses further TX.', 'Пять отдельных опытов в RECEIVE: обратный порядок байтов, обратный порядок восьми битов в каждом байте, случайные тройки и первые два варианта с инверсией битов. Каждый шаг запускается вручную; при входящих байтах дальнейшая отправка прекращается.');
    $('step-note').textContent = words('Prepare USB and start recording. Activate IR → SWAN → RECEIVE on the watch, then immediately click Mark RECEIVE and start 22 transmissions. When the recording ends, restart RECEIVE before selecting the next experiment.', 'Подготовьте USB и начните запись. Включите IR → SWAN → RECEIVE на часах, затем сразу нажмите «Отметить RECEIVE и запустить 22 посылки». После окончания записи заново включите RECEIVE перед следующим опытом.');
    const strategy = step().payloadStrategy, payload = step().probeHex.toUpperCase().match(/../g)?.join(' ');
    $('physical-setting-summary').textContent = `9600 bit/s · SWAN RECEIVE · TX 1.6 µs · RX 8 · 22 × ` + (payload ?? words('3 random bytes', '3 случайных байта'));
    $('peer-description').textContent = words('22 three-byte transmissions over about 14.31 seconds. The RECEIVE mark starts the series once. Any RX after TX pauses remaining transmissions while recording continues.', '22 посылки по три байта примерно за 14,31 секунды. Отметка RECEIVE один раз запускает серию. При любом RX после TX оставшиеся посылки отменяются, запись продолжается.');
    $('peer-payload-description').textContent = strategy === 'reverse-bytes' ? '7A 06 F0 → F0 06 7A' : strategy === 'reverse-bits' ? words('Reverse eight bits within each byte: 7A 06 F0 → 5E 60 0F. Byte order and UART 8N1 framing stay the same.', 'Разворачиваем восемь битов каждого байта: 7A 06 F0 → 5E 60 0F. Порядок байтов и формат UART 8N1 сохраняются.') : strategy.endsWith('-inverted') ?
      (strategy === 'reverse-bytes-inverted' ? '7A 06 F0 → F0 06 7A → 0F F9 85. ' : '7A 06 F0 → 5E 60 0F → A1 9F F0. ') + words('Flip each payload bit (0 ↔ 1), XOR FF per byte. UART start/stop bits are unchanged.', 'Инвертируем каждый бит данных (0 ↔ 1), XOR FF для каждого байта. Стартовые и стоповые биты UART сохраняются.') :
      words('Each of the 22 slots gets three new random bytes (0–255). Prepare USB generates and saves the full plan; recording and export use these exact bytes.', 'Для каждой из 22 посылок — три новых случайных байта (0–255). Подготовка USB создаёт и сохраняет весь план; при записи и выгрузке используются именно эти байты.');
    const planAttempt = ready || running ? active : selected();
    const savedPlan = planAttempt?.stepId === step().id ? planAttempt.peerPayloadPlan : null;
    $('peer-payload-preview').textContent = savedPlan ? savedPlan.packetsHex.map((hex, at) => `#${at + 1} · ${hex.toUpperCase().match(/../g).join(' ')}`).join('\n') : words('The exact plan will be saved when you prepare USB.', 'Точный план будет сохранён при подготовке USB.');
  }
  $('send-stage-controls').hidden = !stageButtons;
  for (const id of ['stage-selection', 'stage-transmission', 'picture-change']) $(id).disabled = !running || !stageButtons;
  $('mark').hidden = stageButtons;
  $('replay-settings').hidden = physicalMode || !syncMode || !step().transmit;
  $('signal-controls').hidden = !syncMode || autoMode || peerMode;
  $('replay').disabled = busy || ready; $('replay-timing').disabled = busy || ready;
  const receiveMarkOption = $('replay-timing').querySelector('[value="receive-mark"]');
  receiveMarkOption.disabled = receiveMarkOption.hidden = step().watchMode !== 'swan-receive';
  for (const option of $('replay').options) { const item = SWAN_REPLAYS.find(value => value.id === option.value); option.textContent = words(item.en, item.ru); }
  const choice = SWAN_REPLAYS.find(item => item.id === $('replay').value);
  if (choice) $('replay-preview').textContent = choice.hex.toUpperCase().match(/../g).join(' ');
  const replayEnabled = canReplayNow({ running, transmit: active?.transmit, triggerState: trigger?.state, mode: active?.replayTrigger ?? 'manual', broken });
  $('send-replay').hidden = !syncMode || !step().transmit || replayMode !== 'manual'; $('send-replay').disabled = !replayEnabled;
  $('send-replay').textContent = words('Send now, once', 'Отправить сейчас, один раз');
  $('replay-tx-status').hidden = !syncMode || !step().transmit;
  $('start').textContent = syncMode && step().transmit ? replayMode === 'start' ? words('Start recording and send once', 'Начать запись и отправить один раз') : replayMode === 'rx' ? words('Record; reply once to incoming bytes', 'Записывать; ответить один раз на RX') : replayMode === 'receive-mark' ? words('Record; wait for RECEIVE mark', 'Записывать; ждать отметки RECEIVE') : words('Start recording; send manually', 'Начать запись; отправка вручную') : t('Start recording');
  if (autoMode) $('start').textContent = words('Start automatic comparison', 'Начать автоподбор');
  if (peerMode) $('start').textContent = words('Record; wait for RECEIVE mark', 'Записывать; ждать отметки RECEIVE');
  for (const [id, value] of [['path-covered', 'covered'], ['path-open', 'open']]) {
    $(id).hidden = physicalMode || Boolean(step().transmit); $(id).disabled = !running || !active.watchPresent || path === value;
  }
  $('plan').replaceChildren(...plan.map((item, at) => {
    const li = document.createElement('li'), button = document.createElement('button');
    button.textContent = label(item); button.disabled = busy || ready || !store || broken;
    button.onclick = () => choose(at); li.setAttribute('aria-current', at === index ? 'step' : 'false'); li.append(button); return li;
  }));
  $('prepare').disabled = !store || busy || ready || broken || !navigator.usb;
  $('release').disabled = busy || !ready; $('ready').disabled = busy || !ready;
  $('start').disabled = busy || !ready || !$('ready').checked || broken;
  $('mark').disabled = !running || !active.watchPresent; $('stop').disabled = !running;
  $('mark').textContent = active?.watchMode === 'swan-receive' ? words('Mark RECEIVE press', 'Отметить нажатие RECEIVE') : words('Mark SEND press', 'Отметить нажатие SEND');
  if (autoMode) $('mark').textContent = words('Mark SEND (optional)', 'Отметить SEND (необязательно)');
  if (syncMode && step().transmit && step().watchMode === 'swan-receive' && replayMode === 'receive-mark') $('mark').textContent = running && trigger?.state !== 'waiting' ? words('Mark another RECEIVE press (no TX)', 'Отметить ещё RECEIVE (без отправки)') : words('Mark RECEIVE and send once', 'Отметить RECEIVE и отправить один раз');
  if (peerMode) $('mark').textContent = running && trigger?.state !== 'waiting' ? words('Mark another RECEIVE press (no restart)', 'Отметить ещё RECEIVE (без перезапуска)') : words('Mark RECEIVE and start 22 repeats', 'Отметить RECEIVE и запустить 22 повтора');
  if (variantMode) $('mark').textContent = running && trigger?.state !== 'waiting' ? words('Mark another RECEIVE press (no restart)', 'Отметить ещё RECEIVE (без перезапуска)') : words('Mark RECEIVE and start 22 transmissions', 'Отметить RECEIVE и запустить 22 посылки');
  $('seconds').disabled = busy; $('previous').disabled = busy || ready || index === 0 || !store;
  $('next').disabled = busy || ready || index === plan.length - 1 || !store;
  $('attempts').disabled = busy || ready;
  for (const id of ['notes', 'observation', 'save-notes', 'export', 'raw']) $(id).disabled = busy || ready || !selected();
  if (exporting) { $('export').disabled = true; $('raw').disabled = true; }
  $('export-all').disabled = busy || ready || exporting || !attempts.length;
  $('usb-state').textContent = ready ? `${adapter.description.name} · ${Math.round(adapter.baud)} bit/s` : '—';
  updateReplayState();
  status(...message, messageError);
}
function updateReplayState() {
  if (peerMode) { renderPeer(); return; }
  const a = busy && active?.status === 'running' ? signalAnalysis : active?.stepId === step().id ? active.analysis : null;
  $('replay-tx-status').textContent = a?.fifoDrainCompleted ? words('TX completed once (USB + FIFO).', 'TX: отправлено один раз (USB + FIFO).') :
    a?.usbWriteCompleted ? words('USB write completed; FIFO drain not confirmed.', 'TX: запись USB завершена; FIFO не подтверждён.') :
    trigger?.state === 'queued' && busy ? words('TX queued; waiting for USB.', 'TX: запрос принят, ожидаем USB.') : words('TX: not sent yet.', 'TX: пока не отправлено.');
}
function choose(at) {
  if (busy || adapter?.opened || !plan[at]) return;
  index = at; active = journal = null; autoSummary = peerSummary = null; $('ready').checked = false; $('seconds').value = step().seconds; $('replay-timing').value = step().replayTrigger ?? 'manual'; render(); renderAutoTune();
}
function showResult() {
  const item = selected(), a = item?.analysis;
  if (!busy && !adapter?.opened) $('stats').textContent = a ? `${item.baud} bit/s · RX ${a.rxBytes} B · USB ${a.readCount} · ${words('with data', 'с данными')} ${a.nonemptyReads} · ${words('empty', 'пустых')} ${a.emptyReads} · ${words('markers', 'отметок')} ${a.markers.length}` : '';
  $('notes').value = item?.notes ?? ''; $('observation').value = item?.observation?.display ?? 'unrecorded';
  $('result').textContent = item ? JSON.stringify(item, null, 2) : '—';
  $('summary').textContent = a ? `RX ${a.rxBytes} B · USB ${a.readCount} · ${words('with data', 'с данными')} ${a.nonemptyReads} · TX ${a.bulkOutCalls}\n${words('Byte counts', 'Частоты байтов')}: ${a.histogram.map(item => `${item.hex.toUpperCase()} × ${item.count}`).join(', ') || '—'}\n${words('The source of received bytes is unverified.', 'Источник принятых байтов пока не установлен.')}` : '';
  $('signal-summary').hidden = !syncMode || !a || autoMode || peerMode;
  if (syncMode && a && !autoMode && !peerMode) $('signal-summary').textContent = signalSummary(a);
  if (autoMode) { autoSummary = item?.result?.autoTune ?? null; renderAutoTune(); }
  if (peerMode) { peerSummary = item?.result?.series ?? null; renderPeer(); }
}
function signalSummary(a) {
  return words('Candidate bursts (USB gaps >30 ms): ', 'Группы по паузам USB >30 мс: ') + (a.groupedBursts?.length ?? 0) + '\n' +
    (a.variants ?? []).map(item => `${item.hex.toUpperCase().match(/../g).join(' ')} × ${item.count}${item.dataBitShiftMatches.some(match => match.shift !== 0) ? words(' · data-bit shift matches', ' · совпадение при сдвиге битов данных') : ''}`).join('\n') + '\n' +
    words('USB write / FIFO drain: ', 'Запись USB / опустошение FIFO: ') + `${Boolean(a.usbWriteCompleted)} / ${Boolean(a.fifoDrainCompleted)}` + '\n' +
    words('Replay request source: ', 'Причина отправки: ') + (a.replayRequestSource ?? '—') + '\n' +
    words('First RX after USB write: ', 'Первый RX относительно USB-записи: ') + (Number.isFinite(a.firstRXmsAfterUSBWrite) ? `${a.firstRXmsAfterUSBWrite.toFixed(1)} ms` : '—') + '\n' +
    words('Exact TX matches after USB write (possible echo): ', 'Совпадения с TX после USB-записи (возможное эхо): ') + (a.exactMatchesAfterUSBWrite?.length ?? 0) + '\n' +
    words('Optical path, by page marks / USB completion: ', 'ИК-луч по меткам страницы / завершению USB: ') + (a.opticalPhasesByUSBCompletion ?? []).map(p => `${p.path}: ${p.rxBytes} B`).join(' → ') + '\n' +
    words('Watch stage, by page marks / USB completion: ', 'Этап часов по меткам страницы / завершению USB: ') + (a.selectionPhasesByUSBCompletion ?? []).map(p => `${p.stage}${p.changeNumber ? ` #${p.changeNumber}` : ''}: ${p.rxBytes} B`).join(' → ') + '\n' +
    words('Grouping and bit shifts do not decode UART or identify a watch response. Raw bytes are unchanged.', 'Группировка и сдвиги не расшифровывают UART и не определяют ответ часов. Сырые байты сохранены без изменений.');
}
async function refresh(id = active?.id) {
  attempts = (await store.attempts()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (active) attempts = [...attempts.filter(item => item.id !== active.id), active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('attempts').replaceChildren(...attempts.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.createdAt.slice(0, 19)} UTC · ${label(item)} · ${item.status}`; return option; }));
  if (attempts.length) $('attempts').value = attempts.some(item => item.id === id) ? id : attempts.at(-1).id;
  showResult(); render();
}
function storageError(error) {
  broken = true; controller?.abort(); adapter?.close().catch(() => {});
  status(`Journal error: ${error}`, `Ошибка журнала: ${error}`, true); render();
}
async function save() { try { await store.save(active); } catch (error) { storageError(error); throw error; } }
async function prepare() {
  if (!store || busy || adapter?.opened || broken) return;
  busy = true; active = journal = null; $('ready').checked = false; controller = new AbortController(); render();
  status('Preparing SigmaTel…', 'Подготавливаем SigmaTel…');
  try {
    const devices = await withTimeout(navigator.usb.getDevices(), 5000, words('listing permitted USB devices', 'получение списка разрешённых USB-устройств'));
    let device = devices.find(item => item.vendorId === 0x066f && item.productId === 0x4200);
    if (!device) {
      status('Select IrDA/USB Bridge in the browser USB chooser.', 'Выберите IrDA/USB Bridge в диалоге USB браузера.');
      device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x066f, productId: 0x4200 }] });
    }
    const current = step();
    const peerPayloadPlan = peerMode ? makePeerPayloadPlan(current.payloadStrategy ?? 'original') : null;
    const replay = physicalMode ? SWAN_REPLAYS[0] : SWAN_REPLAYS.find(item => item.id === $('replay').value);
    const replayTrigger = current.transmit ? physicalMode ? current.replayTrigger : $('replay-timing').value : null;
    if (syncMode && current.transmit && !replay) throw new Error('Select received bytes to replay.');
    active = { id: crypto.randomUUID(), kind: syncMode && current.transmit ? 'serial' : 'listen', format: variantMode ? 'wqv-swan-peer-v2' : peerMode ? 'wqv-swan-peer-v1' : autoMode ? 'wqv-swan-autotune-v1' : physicalMode ? 'wqv-swan-physical-v1' : syncMode ? 'wqv-swan-sync-v1' : 'wqv-swan-listening-v1', createdAt: new Date().toISOString(), status: 'preparing',
      stepId: current.id, stepIndex: index, baud: current.baud, watchPresent: current.watchPresent, watchMode: current.watchMode,
      ...(syncMode ? { transmit: current.transmit, probeHex: peerPayloadPlan ? peerPayloadPlan.strategy === 'random' ? '' : peerPayloadPlan.packetsHex[0] : current.transmit ? replay.hex : '', replayTrigger, postRxQuietMs: 12,
        replay: peerPayloadPlan ? { strategy: peerPayloadPlan.strategy, timing: 'per-slot-recorded-cadence' } : current.transmit ? { ...replay, timing: 'contiguous-no-original-pauses' } : null } : {}),
      ...(physicalMode ? { physicalPhase: current.phase, physicalSettings: { requested: physicalSettings(current), verified: false } } : {}),
      ...(autoMode ? { tuneGroup: current.tuneGroup, variableReceiverSettings: true } : {}),
      ...(peerMode ? { peerCadence: PEER_CADENCE, peerPayloadPlan } : {}),
      conditions: null, observation: { display: 'unrecorded' }, notes: '',
      device: { vendorId: device.vendorId, productId: device.productId, productName: device.productName },
      capture: { originalUSBBytes: true, receiveOnly: !activeTransmission(current), automaticNextStep: false, echoRemoval: false, crcRecovery: false,
        automaticReplies: activeTransmission(current) && replayTrigger === 'rx', maxReplayTransmissions: peerMode ? 22 : activeTransmission(current) ? 1 : 0 } };
    await save(); journal = new Journal(store, active, storageError); journals.set(active.id, journal);
    const attempt = active, record = journal.record, counters = { readCount: 0, nonemptyReads: 0, emptyReads: 0, rxBytes: 0 };
    adapter = new SigmaTel(captureUSB(device, record, () => ({ baud: adapter?.baud ?? null, phase: attempt.status, ...(autoMode ? { receiverProfile: adapter?.autotuneIO ?? null } : {}) }), { receiveOnly: !active.transmit, counters }),
      { log: (level, text) => record('log', { level, message: String(text) }) });
    adapter.usbStats = counters; record('attempt-prepared', { step: current, ...(peerMode ? { payloadPlan: peerPayloadPlan } : {}) });
    await adapter.open(); await adapter.setupSIR(); await adapter.setSIRSpeed(current.baud); controller.signal.throwIfAborted();
    if (physicalMode) active.physicalSettings = await applySwanPhysical(adapter, current, { record, signal: controller.signal });
    active.status = 'prepared'; active.adapter = adapter.description; active.chipRevision = adapter.revision;
    record('listen-armed', { baud: adapter.baud, watchPresent: current.watchPresent, watchMode: current.watchMode, bulkOutAllowed: Boolean(active.transmit), probeHex: active.probeHex ?? '', ...(physicalMode ? { physicalSettings: active.physicalSettings } : {}) });
    await journal.drain(); await save(); status('USB ready. Confirm the setup, then start recording.', 'USB готов. Подтвердите условия и начните запись.');
  } catch (error) {
    if (physicalMode && active && error.physicalSettings) active.physicalSettings = error.physicalSettings;
    if (active) { active.status = 'preparation-error'; active.error = String(error); journal?.record('preparation-error', { error: String(error) }); }
    await adapter?.close().catch(() => {}); adapter = null;
    if (active && !broken) { await journal?.drain(); await save(); }
    if (!broken) status(String(error), String(error), true);
  } finally { busy = false; if (active && !broken) await refresh(); else render(); }
}
function activeTransmission(current) { return syncMode && Boolean(current.transmit); }
async function release() {
  if (busy || !adapter) return;
  busy = true; render();
  try { await adapter.close(); active.status = 'released-without-recording'; journal.record('usb-released'); await journal.drain(); await save(); status('USB released.', 'USB освобождён.'); }
  catch (error) { status(String(error), String(error), true); }
  finally { adapter = null; busy = false; $('ready').checked = false; await refresh(); }
}
async function run() {
  if (busy || !adapter?.opened || !$('ready').checked || broken || !$('seconds').reportValidity() || (physicalMode && !active.physicalSettings?.verified)) return;
  busy = true; active.status = 'running'; active.startedAt = new Date().toISOString();
  active.conditions = peerMode ? peerConditions(step(), active.startedAt) : autoMode ? autoTuneConditions(step(), active.startedAt) : physicalMode ? physicalConditions(step(), active.startedAt) : syncMode ? syncConditions(step(), active.startedAt) : confirmedConditions(step(), active.startedAt); active.captureWindowMs = Number($('seconds').value) * 1000;
  if (active.transmit) Object.assign(active.conditions, { activationPending: active.watchPresent && active.replayTrigger !== 'start', replayTrigger: active.replayTrigger });
  trigger = active.transmit ? peerMode ? new PeerSeriesTrigger() : new ManualSerialTrigger() : null; path = active.watchPresent ? 'open' : 'watch-removed'; signalAnalysis = null; lastAnalysedEvents = -1;
  peerSummary = null;
  replayTiming = active.transmit ? new ReplayTiming(trigger, active.replayTrigger ?? 'manual', source => {
    journal.record('serial-manual-send-request', { dataHex: active.probeHex, watchPresent: active.watchPresent, source, replayTrigger: active.replayTrigger,
      ...(peerMode ? { payloadStrategy: active.peerPayloadPlan.strategy, plannedTransmissions: active.peerPayloadPlan.packetsHex.length } : {}) });
    if (peerMode) status('The 22-repeat series is queued; waiting for USB.', 'Серия из 22 повторов запрошена; ожидаем USB.');
    else status('One replay queued; waiting for USB.', 'Одна посылка запрошена; ожидаем USB.');
  }, active.postRxQuietMs ?? 12) : null;
  controller = new AbortController(); $('ready').checked = false; render();
  try {
    await save(); journal.record('physical-conditions-confirmed', active.conditions);
    const mode = active.watchMode === 'swan-send' ? 'SEND' : 'RECEIVE';
    status(active.watchPresent ? `Recording. Press ${mode} on the watch now, then mark it here.` : 'Background recording. Keep the watch away.', active.watchPresent ? `Идёт запись. Теперь нажмите ${mode} на часах и отметьте нажатие здесь.` : 'Фоновая запись. Держите часы в стороне.');
    if (syncMode && active.watchMode === 'swan-send') status('Recording. Enter photo selection first and mark it below; wait and change photos before starting transmission.', 'Идёт запись. Сначала войдите в выбор снимка и отметьте этап ниже; подождите и смените снимок перед запуском передачи.');
    if (physicalMode) status('Recording. Press the front button for photo selection, then press it again to send the same photo. Mark both stages.', 'Идёт запись. Передней кнопкой войдите в выбор снимка, затем нажмите её ещё раз для передачи того же снимка. Отметьте оба этапа.');
    if (autoMode) status('Recording. Start SWAN SEND now. The comparison needs no further page clicks.', 'Идёт запись. Теперь запустите SWAN SEND. Дальше страница выполнит сравнение сама.');
    if (peerMode) status('Recording. Activate SWAN RECEIVE, then mark it here to start the series.', 'Идёт запись. Включите SWAN RECEIVE, затем отметьте нажатие здесь для запуска серии.');
    if (syncMode && active.transmit && !active.watchPresent) status('Recording without the watch. Send the chosen bytes once.', 'Запись без часов. Отправьте выбранные байты один раз.');
    const serialRecord = (kind, details) => {
      journal.record(kind, { ...details, watchMode: active.watchMode });
      if (kind === 'serial-start') replayTiming?.start();
      if (kind === 'serial-rx') replayTiming?.received();
      if (kind === 'serial-finished') replayTiming?.close();
    };
    const recording = peerMode ? replayPeer(adapter, { durationMs: active.captureWindowMs, payloadPlan: active.peerPayloadPlan }, {
      signal: controller.signal, manualTrigger: trigger, record: serialRecord, update: summary => { peerSummary = summary; renderPeer(summary); },
    }) : autoMode ? listenAutotune(adapter, { group: active.tuneGroup, durationMs: active.captureWindowMs }, {
      signal: controller.signal, record: journal.record, update: summary => { autoSummary = summary; renderAutoTune(summary); },
    }) : active.transmit ? probeSerialPacket(adapter,
      { bytes: fromHex(active.probeHex), watchMode: active.watchMode ?? 'swan-send', durationMs: active.captureWindowMs },
      { signal: controller.signal, record: serialRecord, manualTrigger: trigger }) :
      listen(adapter, { baud: active.baud, watchMode: active.watchMode ?? 'background', durationMs: active.captureWindowMs }, { signal: controller.signal, record: journal.record });
    render(); active.result = await recording;
    active.status = active.result.status;
  } catch (error) { active.status = controller.signal.aborted ? 'interrupted' : 'error'; active.error = String(error); journal.record('step-error', { error: String(error) }); }
  finally {
    replayTiming?.close();
    trigger?.close();
    try { await adapter.close(); } catch (error) { active.cleanupError = String(error); journal.record('cleanup-error', { error: String(error) }); }
    active.finishedAt = new Date().toISOString(); active.analysis = syncMode ? analyseSwanSync(journal.events, active.probeHex) : analyseSwanListening(journal.events).analysis;
    if (active.result) Object.assign(active.result, { rxBytes: active.analysis.rxBytes, readCount: active.analysis.readCount, emptyReads: active.analysis.emptyReads, nonemptyReads: active.analysis.nonemptyReads, watchMode: active.watchMode });
    if (autoMode) active.tuningComplete = ['complete', 'deadline'].includes(active.result?.reason) && Boolean(active.result?.autoTune?.winnerId);
    if (active.status === 'no-data' && active.analysis.rxBytes) active.status = active.result.status = 'captured';
    active.captureMayBeIncomplete = !['captured', 'no-data'].includes(active.status) || Boolean(active.cleanupError) || active.analysis.pendingUSBCalls.length > 0 || active.analysis.failedReads > 0;
    if (!active.watchPresent) active.observation = { display: 'control', at: active.finishedAt };
    journal.record('step-finished', { status: active.status, analysis: active.analysis });
    if (!broken) { try { await journal.drain(); await save(); } catch {} }
    busy = false; adapter = null;
    if (!broken) { await refresh();
      if (active.status === 'error' || active.cleanupError) status(`Recording failed: ${active.error ?? active.result?.error?.message ?? active.cleanupError}. Save the ZIP.`, `Ошибка записи: ${active.error ?? active.result?.error?.message ?? active.cleanupError}. Сохраните ZIP.`, true);
      else if (peerMode) {
        const s = active.result?.series;
        status(`Series finished: TX ${s?.fifoCompleted ?? 0}/${s?.planned ?? 22}; RX ${active.analysis.rxBytes} B.` + (s?.pausedByRX ? ' Further repeats paused on RX.' : ''), `Серия завершена: TX ${s?.fifoCompleted ?? 0}/${s?.planned ?? 22}; RX ${active.analysis.rxBytes} Б.` + (s?.pausedByRX ? ' Повторы остановлены после появления RX.' : ''), ['probe-not-sent', 'series-incomplete'].includes(active.status));
      }
      else if (active.status === 'probe-not-sent') status('The bytes were not transmitted. Check the TX status and save the ZIP.', 'Байты не были отправлены. Проверьте состояние TX и сохраните ZIP.', true);
      else if (autoMode) status(active.tuningComplete ? 'Automatic comparison finished. The provisional choice and raw data are ready to export.' : 'Recording finished; no complete setting comparison was obtained. Partial results and all raw bytes are saved.', active.tuningComplete ? 'Автосравнение завершено. Предварительный выбор и сырые данные готовы к выгрузке.' : 'Запись завершена; полного сравнения не получилось. Частичные результаты и все сырые байты сохранены.');
      else status('Recording finished. Save the observation and ZIP. The next step starts only when you select it.', 'Запись завершена. Сохраните наблюдение и ZIP. Следующий шаг запустится только по вашему выбору.');
    }
    else { attempts = [...attempts.filter(item => item.id !== active.id), active]; render(); }
  }
}
function offerDownload(data, name) {
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/octet-stream' });
  downloadURL = URL.createObjectURL(blob);
  const link = $('download-link'); link.href = downloadURL; link.download = name;
  link.textContent = words('Download ', 'Скачать ') + name; link.hidden = false;
  $('download-status').textContent = words(`File ready (${blob.size.toLocaleString()} bytes). Click the download link below.`, `Файл готов (${blob.size.toLocaleString()} байт). Нажмите ссылку «Скачать» ниже.`);
  link.focus();
}
function recordingFiles(item, events) {
  return ['wqv-swan-peer-v1', 'wqv-swan-peer-v2'].includes(item.format) ? swanPeerFiles(item, events) : item.format === 'wqv-swan-autotune-v1' ? swanAutotuneFiles(item, events) : item.format === 'wqv-swan-physical-v1' ? swanPhysicalFiles(item, events) : item.format === 'wqv-swan-sync-v1' ? swanSyncFiles(item, events) : swanListeningFiles(item, events);
}
async function exportAttempt(raw = false) {
  const item = selected(); if (!item || busy || exporting) return;
  exporting = true; render();
  $('download-status').textContent = words('Preparing the complete recording…', 'Готовим полную запись…');
  try {
    const events = journals.get(item.id)?.events.slice() ?? await store.events(item.id), stamp = item.createdAt.replace(/[:.]/g, '-');
    if (raw) offerDownload(analyseSwanListening(events).bytes, `WQV-SWAN-${item.stepId}-${stamp}.bin`);
    else offerDownload(zipFiles(recordingFiles(item, events)), `WQV-SWAN-${suiteName}-${item.stepId}-${stamp}.zip`);
  } catch (error) { $('download-status').textContent = String(error); status(String(error), String(error), true); }
  finally { exporting = false; render(); }
}
async function exportAll() {
  if (!store || busy || adapter?.opened || exporting || !attempts.length) return;
  exporting = true; render();
  const exportedAt = new Date().toISOString(), snapshot = structuredClone(attempts), files = [];
  try {
    for (const [at, item] of snapshot.entries()) {
      $('download-status').textContent = words(`Preparing recording ${at + 1} of ${snapshot.length}…`, `Готовим запись ${at + 1} из ${snapshot.length}…`);
      const events = journals.get(item.id)?.events.slice() ?? await store.events(item.id);
      const contents = recordingFiles(item, events);
      files.push(...contents.map(file => ({ ...file, name: `${item.id}/${file.name}` })));
    }
    files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ format: 'wqv-swan-bundle-v1', exportedAt, attempts: snapshot }, null, 2)) });
    const zip = zipFiles(files), name = `WQV-SWAN-${suiteName}-all-${exportedAt.replace(/[:.]/g, '-')}.zip`;
    if (typeof CompressionStream === 'function') {
      const compressed = await new Response(zip.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      offerDownload(compressed, `${name}.gz`);
    } else offerDownload(zip, name);
  } catch (error) { $('download-status').textContent = String(error); status(String(error), String(error), true); }
  finally { exporting = false; render(); }
}
$('prepare').onclick = prepare; $('release').onclick = release; $('ready').onchange = render; $('start').onclick = run;
$('previous').onclick = () => choose(index - 1); $('next').onclick = () => choose(index + 1);
$('stop').onclick = () => { journal?.record('manual-stop'); controller?.abort(); };
$('mark').onclick = () => {
  if (!busy || active?.status !== 'running' || !active.watchPresent) return;
  journal.record(active.watchMode === 'swan-send' ? 'watch-send-mark' : 'watch-receive-mark', { baud: active.baud, watchMode: active.watchMode, markerSource: 'page-click' });
  if (active.transmit && active.watchMode === 'swan-receive') replayTiming?.receiveMark();
  render();
};
for (const [id, value] of [['path-covered', 'covered'], ['path-open', 'open']]) $(id).onclick = () => {
  if (physicalMode || !syncMode || !busy || active?.status !== 'running' || !active.watchPresent || active.transmit || path === value) return;
  path = value; journal.record('sync-path-mark', { path, markerSource: 'page-click', watchMode: active.watchMode }); render();
};
$('replay').onchange = render;
$('replay-timing').onchange = render;
for (const [id, stage] of [['stage-selection', 'image-selection'], ['stage-transmission', 'transmitting']]) $(id).onclick = () => {
  if (!syncMode || !busy || active?.status !== 'running' || active.watchMode !== 'swan-send') return;
  journal.record('watch-send-mark', { stage, markerSource: 'page-click', watchMode: active.watchMode });
};
$('picture-change').onclick = () => {
  if (!syncMode || !busy || active?.status !== 'running' || active.watchMode !== 'swan-send') return;
  journal.record('watch-picture-mark', { markerSource: 'page-click', watchMode: active.watchMode,
    changeNumber: journal.events.filter(event => event.kind === 'watch-picture-mark').length + 1 });
};
$('send-replay').onclick = () => {
  if (!syncMode || !canReplayNow({ running: busy && active?.status === 'running', transmit: active?.transmit, triggerState: trigger?.state, mode: active?.replayTrigger ?? 'manual', broken })) return;
  if (replayTiming.request('send-button')) render();
};
$('attempts').onchange = () => { showResult(); render(); }; $('export').onclick = () => exportAttempt(); $('raw').onclick = () => exportAttempt(true); $('export-all').onclick = exportAll;
$('save-notes').onclick = async () => {
  const item = selected(); if (!item || busy) return;
  try { item.notes = $('notes').value; item.observation = { display: $('observation').value, at: new Date().toISOString() }; await store.save(item); showResult(); status('Observation saved.', 'Наблюдение сохранено.'); }
  catch (error) { storageError(error); }
};
$('language').onchange = () => { setLanguage($('language').value); if (store) refresh(); else render(); };
setInterval(() => {
  if (!journal) return;
  if (!journal.error) journal.flush().catch(() => {});
  const c = adapter?.usbStats;
  if (c) $('stats').textContent = `${Math.round(adapter.baud)} bit/s · RX ${c.rxBytes} B · USB ${c.readCount} · ${words('with data', 'с данными')} ${c.nonemptyReads} · ${words('empty', 'пустых')} ${c.emptyReads}` + (autoMode || peerMode ? '' : ` · ${words('markers', 'отметок')} ${journal.events.filter(event => event.kind === 'watch-send-mark' || event.kind === 'watch-receive-mark').length}`);
  $('events').textContent = journal.events.slice(-12).map(event => JSON.stringify(event)).join('\n');
  if (syncMode && !autoMode && !peerMode && busy && active?.status === 'running' && journal.events.length !== lastAnalysedEvents) {
    lastAnalysedEvents = journal.events.length; signalAnalysis = analyseSwanSync(journal.events, active.probeHex);
    const sent = signalAnalysis.fifoDrainCompleted, markers = signalAnalysis.buttonPressCount;
    $('signal-live').textContent = `${words('Button marks', 'Отметок нажатия')}: ${markers} · ${words('IR path', 'ИК-луч')}: ${path} · ` +
      (signalAnalysis.rxBytes ? words(`RX present: ${signalAnalysis.groupedBursts.at(-1)?.hex.toUpperCase() ?? ''}.`, `Есть RX: ${signalAnalysis.groupedBursts.at(-1)?.hex.toUpperCase() ?? ''}.`) : words('Waiting for RX.', 'Ожидаем RX.'));
    $('signal-summary').hidden = false; $('signal-summary').textContent = signalSummary(signalAnalysis);
    if (sent) status('Chosen bytes sent once. Recording the response without further transmissions.', 'Выбранные байты отправлены один раз. Записываем ответ без дальнейших посылок.');
    $('send-replay').disabled = !canReplayNow({ running: true, transmit: active.transmit, triggerState: trigger?.state, mode: active?.replayTrigger ?? 'manual', broken });
    updateReplayState();
  }
}, 250);
window.addEventListener('pagehide', () => { replayTiming?.close(); controller?.abort(); adapter?.close().catch(() => {}); if (downloadURL) URL.revokeObjectURL(downloadURL); unlock?.(); });
async function initialize() {
  $('replay').replaceChildren(...SWAN_REPLAYS.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = words(item.en, item.ru); return option; }));
  $('seconds').value = step().seconds;
  $('replay-timing').value = step().replayTrigger ?? 'manual';
  render();
  renderAutoTune();
  try {
    if (navigator.locks && !await new Promise((resolve, reject) => {
      navigator.locks.request('wqv-command-research', { ifAvailable: true }, lock => { resolve(Boolean(lock)); if (lock) return new Promise(releaseLock => { unlock = releaseLock; }); }).catch(reject);
    })) { status('Another research tab is open. Close it first.', 'Открыта другая исследовательская вкладка. Сначала закройте её.', true); return; }
    store = await openResearchStore(variantMode ? 'wqv-swan-peer-variants' : peerMode ? 'wqv-swan-peer' : autoMode ? 'wqv-swan-autotune' : physicalMode ? 'wqv-swan-physical' : syncMode ? 'wqv-swan-sync' : 'wqv-swan-listening');
    for (const item of await store.attempts()) if (['preparing', 'prepared', 'running'].includes(item.status)) { item.status = 'interrupted-by-page-close'; item.captureMayBeIncomplete = true; await store.save(item); }
    await refresh(); status('Prepare USB first. The watch can stay off.', 'Сначала подготовьте USB. Часы пока можно не включать.'); render();
  } catch (error) { storageError(error); }
}
initialize();
