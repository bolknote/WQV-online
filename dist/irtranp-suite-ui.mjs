import { createSuite, currentStep, bindAttempt, advanceSuite, stepCanAdvance, repeatSuiteStep, cancelSuiteRepeat,
  analyseAttempt, suiteFiles } from './irtranp-suite.mjs';
import { zipFiles } from './zip.mjs';
import { featureStepTitle, reportResultKey, UPLOAD_ACKNOWLEDGED, TWO_UPLOADS_ACKNOWLEDGED, UPLOAD_EVIDENCE_NOTE } from './irtranp-presentation.mjs';

export const SUITE_RU = {
  'Two photos: Windows CE 2.11 transport': 'Два снимка: транспорт Windows CE 2.11',
  'Two photos with Windows CE 2.11 transport': 'Два снимка с транспортом Windows CE 2.11',
  'On the watch: OTHERS RECEIVE. Photos 10 and 11 / 07FB use one connection at 9600 bit/s. Transport: Windows CE 2.11. Activate reception after starting the test here. Keep the watch facing the adapter until the test ends.':
    'На часах: OTHERS RECEIVE. Снимки 10 и 11 / 07FB отправятся за одно соединение на 9600 бит/с. Транспорт: Windows CE 2.11. Включите приём после запуска теста здесь. Оставьте часы напротив адаптера до окончания теста.',
  'Two photos: CSI packet size': 'Два снимка: размер пакетов как в CSI',
  'Two photos with CSI negotiated packets': 'Два снимка с размером пакетов как в CSI',
  'Use the exact control files': 'Загрузить исходную пару файлов',
  'Exact control files loaded. Prepare USB next.': 'Исходная пара файлов загружена. Теперь подготовьте USB.',
  'On the watch: OTHERS RECEIVE. Both photos use one connection at 9600 bit/s. SCEP packets follow CSI: the watch limit (2048 bytes in the saved reply), instead of 512 bytes.':
    'На часах: OTHERS RECEIVE. Оба снимка отправятся за одно соединение на 9600 бит/с. Размер пакетов SCEP — как у CSI: предел часов (ранее 2048 байт) вместо 512 байт.',
  'One at a time: exact photos 10 and 11': 'По одному: точные файлы 10 и 11',
  'Photo 10 alone: unchanged file': 'Снимок 10 отдельно: исходный файл',
  'Photo 11 alone: unchanged file': 'Снимок 11 отдельно: исходный файл',
  'Use the exact control file': 'Загрузить точный контрольный файл',
  'Exact control file loaded. Prepare USB next.': 'Точный контрольный файл загружен. Теперь подготовьте USB.',
  'Send only photo {number}': 'Отправить только снимок {number}',
  'Send photos 10 and 11': 'Отправить снимки 10 и 11',
  'The plan and active series differ. Select the plan again before preparing USB.':
    'План и активная серия не совпадают. Выберите план заново перед подготовкой USB.',
  'On the watch: OTHERS RECEIVE. Only photo {number} from the failed two-photo attempt will be sent, unchanged, in its own connection.':
    'На часах: OTHERS RECEIVE. Отправится только снимок {number} из неудачной пары, без изменений, за отдельное соединение.',
  'Upload acknowledged': 'Передача подтверждена',
  'Files': 'Файлы', 'One file': 'Один файл', 'Two files in one connection': 'Два файла за одно соединение',
  [UPLOAD_ACKNOWLEDGED]: 'Передача подтверждена, сеанс закрыт. Наличие снимков проверяется следующими шагами чтения. Сохраните ZIP.',
  [TWO_UPLOADS_ACKNOWLEDGED]: 'Обе передачи подтверждены. В следующих двух шагах прочитайте отдельно снимки 10 и 11. Сохраните ZIP.',
  [UPLOAD_EVIDENCE_NOTE]: 'Здесь показаны подтверждения обмена. Наличие снимков в памяти проверяется обратным чтением.',
  'Read back photo {number}': 'Прочитать снимок {number}',
  'On the watch: OTHERS SEND. Select photo {number}. Send one photo in this step.':
    'На часах: OTHERS SEND. Выберите снимок {number}. В этом шаге передайте один снимок.',
  'On the watch: OTHERS RECEIVE. The computer sends photos 10 and 11 automatically in one connection. Keep the watch in receive mode until the test ends.':
    'На часах: OTHERS RECEIVE. Компьютер сам отправит снимки 10 и 11 за одно соединение. Оставьте часы в режиме приёма до окончания теста.',
  'If photo {number} is missing, release USB if prepared, enter the missing photo number as the skip reason, and choose Skip step.':
    'Если снимка {number} нет, освободите USB, если он подготовлен, укажите номер отсутствующего снимка в причине пропуска и нажмите «Пропустить шаг».',
  'Metadata: send and read back': 'Метаданные: запись и чтение обратно',
  'Multiple files, cancellation and fast upload': 'Несколько файлов, отмена и быстрая запись',
  'Current feature test': 'Текущая проверка', 'Test image': 'Тестовый снимок', 'Original watch UPF': 'Исходный UPF с часов',
  'Create numbered test image': 'Создать снимок с номером', 'Exact test values': 'Точные значения теста',
  'Control: labelled test image': 'Контроль: снимок с номером', 'File name (FIL0)': 'Имя файла (FIL0)',
  'File date (TIM0)': 'Дата файла (TIM0)', 'Long name (LFL0)': 'Длинное имя (LFL0)',
  'UPF creation and edit dates': 'Даты создания и изменения UPF', 'UPF title': 'Заголовок UPF', 'UPF comment': 'Комментарий UPF',
  'UPF author and editor': 'Автор и редактор UPF', 'UPF index image (80 × 64)': 'Миниатюра UPF (80 × 64)',
  'Two different images in one connection': 'Два разных снимка за соединение', 'SCEP Stop during PUT': 'SCEP Stop во время PUT',
  'Normal upload after Stop': 'Обычная запись после Stop', 'SCEP Abort after PUT': 'SCEP Abort после PUT',
  'Normal upload after Abort': 'Обычная запись после Abort', 'Labelled upload at 115200': 'Снимок с номером на 115200',
  'On the watch, SEND the numbered image shown here. The received image must match before metadata is compared.':
    'На часах выберите SEND и снимок с указанным номером. Сначала проверим совпадение изображения, затем метаданные.',
  'The watch will RECEIVE the numbered image. Prepare USB before activating reception.':
    'Часы будут ПРИНИМАТЬ снимок с номером. Сначала подготовьте USB, затем включите приём на часах.',
  'Writes add test photos to the watch. File dates do not set its clock. Start and advance every step manually.':
    'При записи на часах добавляются тестовые снимки. Даты файлов не меняют время часов. Запуск и переход к следующему шагу — вручную.',
  'Run the matching upload step first, or skip this read-back explicitly.':
    'Сначала выполните соответствующий шаг записи либо явно пропустите это чтение обратно.',
  'The matching upload has no saved input file.': 'В соответствующем шаге записи нет сохранённого исходного файла.',
  'Numbered test image ready. Prepare USB next.': 'Снимок с номером готов. Теперь подготовьте USB.',
  'Cancellation test closed. This does not by itself prove that a photo was not stored. Save the ZIP.':
    'Тест отмены завершён. Само по себе это не доказывает отсутствие записи снимка. Сохраните ZIP.',
  'Received metadata': 'Полученные метаданные', 'Feature evidence': 'Результат проверки',
  'Send test image': 'Отправить тестовый снимок',
  'Numbered test image and selected metadata. The watch will receive new test photos.': 'Снимок с номером и выбранными метаданными. На часах добавятся тестовые снимки.',
  'Recording the cancellation response': 'Записываем ответ на отмену',
  'image-matches': 'Изображение совпало', 'image-matches-metadata-differs': 'Изображение совпало; метаданные изменились или отсутствуют',
  'wrong-or-changed-image': 'Данные изображения отличаются: метаданные без вывода',
  'image-matches-unconfirmed-upload': 'Изображение совпало; подтверждение записи не получено',
  'image-matches-metadata-unparsed': 'Изображение совпало; метаданные не разобраны',
  'Image matches the upload': 'Изображение совпало с отправленным',
  'Different image; metadata result is inconclusive': 'Другое изображение: результат проверки метаданных не определён',
  'Write': 'Запись', 'Read back': 'Чтение обратно',
  Repeating: 'Повтор', 'Finish repeat': 'Завершить повтор', 'Cancel repeat': 'Отменить повтор',
  'Start recording': 'Начать запись',
  'Listen without discovery or acknowledgements. Unknown bytes are saved before strict CRC decoding.':
    'Прослушивание без поиска и подтверждений. Неизвестные байты сохраняются до строгой проверки CRC.',
  'Discovery starts at 9600 bit/s. Connection speed limit:': 'Поиск начинается на 9600 бит/с. Предел скорости соединения:',
  'SCEP packet size is separate from the link speed.': 'Размер пакета SCEP не связан со скоростью соединения.',
  'The watch is positioned. I will open the SEND selection screen after starting the recording.':
    'Часы напротив адаптера. Открою экран выбора SEND после запуска записи.',
  'Passive recording complete. Save the ZIP; unknown bytes are preserved.':
    'Пассивная запись завершена. Сохраните ZIP: неизвестные байты тоже сохранены.',
  'Comparison baseline': 'Исходный снимок для сравнения',
  'Test series': 'Серия проверок', Plan: 'План', Series: 'Серия', 'Single test': 'Один тест', 'New series': 'Новая серия',
  'SEND screen: passive recording': 'Экран SEND: пассивная запись',
  'Photos: profiles, speed and repeatability': 'Снимки: профили, скорость и повторы',
  'RECEIVE: IAS and capabilities': 'RECEIVE: IAS и возможности', 'Full comparison': 'Полное сравнение',
  'Save series ZIP…': 'Сохранить ZIP серии…', 'Save all attempts ZIP…': 'Сохранить все попытки в ZIP…',
  'Repeat step': 'Повторить шаг', 'Next step': 'Следующий шаг', 'Skip step': 'Пропустить шаг',
  'Reason for skipping': 'Причина пропуска', Step: 'Шаг', Attempts: 'Попытки', Result: 'Результат',
  'Speed limit': 'Предел скорости', 'Fixed receive speed': 'Скорость приёма', 'Frame recovery': 'Восстановление кадров',
  'Current defaults': 'Как в текущем тесте', 'Strict CRC only': 'Только строгая CRC',
  'PAD-5 data and end marker': 'PAD-5: данные и конец кадра', 'PAD-5 and damaged start marker': 'PAD-5 и повреждённое начало кадра',
  'Each step is manual. Leave the watch transfer mode and prepare it again between steps. Use the same photo throughout image comparisons.':
    'Каждый шаг запускается вручную. Между шагами выходите из обмена на часах и включайте его заново. Для сравнения снимков выбирайте один и тот же кадр.',
  'SEND screen: listen only': 'Экран SEND: только слушать',
  'Mark what is on the watch': 'Отметить действие на часах',
  'Selection screen opened': 'Открылся выбор снимка', 'Previous image': 'Предыдущий снимок', 'Next image': 'Следующий снимок',
  'Final SEND pressed': 'Нажата последняя SEND', 'Frame label on watch (optional)': 'Номер кадра на часах (если виден)',
  'First front press opens the SEND image-selection screen. Side buttons choose an image. The next front press starts transmission. Mark each action here; page timestamps are approximate.':
    'Первое нажатие передней кнопки открывает выбор снимка с надписью SEND. Боковыми кнопками выберите кадр. Следующее нажатие передней кнопки запускает передачу. Отмечайте действия здесь; время отметок приблизительное.',
  'Start recording before entering the SEND image-selection screen. Mark entry, side-button changes and the final front SEND press. SigmaTel sends no infrared packets in this test.':
    'Начните запись до входа на экран выбора снимка SEND. Отметьте вход, перелистывания боковыми кнопками и последнее нажатие передней кнопки. SigmaTel в этом тесте не отправляет ИК-пакеты.',
  'Enter OTHERS SEND with the first front press and choose the photo with the side buttons. Start the receiver here, then press the front button again to transmit.':
    'Первым нажатием передней кнопки войдите в OTHERS SEND и выберите снимок боковыми кнопками. Запустите приём здесь, затем снова нажмите переднюю кнопку для передачи.',
  'Passive recording started. Enter the SEND selection screen now and mark each action.':
    'Пассивная запись запущена. Теперь войдите на экран выбора SEND и отмечайте действия.',
  'USB ready. For passive recording, stay before the first front press. For image reception, choose a photo but do not press SEND again yet.':
    'USB готов. Для пассивной записи пока не нажимайте переднюю кнопку. Для приёма снимка откройте выбор кадра, но последнее нажатие SEND пока не делайте.',
  'Protocol evidence': 'Этапы протокола', observed: 'Есть в записи', 'not-observed': 'Нет в записи',
  passed: 'Пройдено', failed: 'Ошибка', interrupted: 'Прервано', incomplete: 'Неполная запись', 'not-run': 'Не запущено',
  recorded: 'Записаны данные', 'no-data': 'Данных нет', 'negative-reply': 'Отрицательный ответ',
  skipped: 'Пропущено', pending: 'Ожидает', running: 'Запущено', prepared: 'USB готов', finished: 'Шаги завершены',
  'Series finished. Save its ZIP; failed and skipped steps remain in the report.':
    'Шаги серии завершены. Сохраните ZIP: ошибки, повторы и пропуски остаются в отчёте.',
  'Exit transfer mode on the watch, then prepare this step again.': 'Выйдите из обмена на часах, затем подготовьте этот шаг заново.',
  'Preparing the complete ZIP…': 'Собираем полный ZIP…', 'The complete ZIP has been saved.': 'Полный ZIP сохранён.',
  'No attempts to export yet.': 'Пока нет попыток для выгрузки.', 'Analysis unavailable': 'Разбор недоступен',
  'JPEG matches the first photo': 'JPEG совпадает с первым снимком', 'JPEG differs from the first photo': 'JPEG отличается от первого снимка',
  'Use the same watch photo to interpret a hash difference.': 'При различии хешей проверьте, что на часах выбран тот же кадр.',
  'First frame after start': 'Первый кадр после запуска', 'Front-button markers': 'Отметок передней кнопки',
  'Pending USB calls': 'Незавершённых вызовов USB', 'Recorded status': 'Статус исходной записи',
  'Captured USB bytes by marked stage': 'Байты USB между отметками этапов', 'No automatic next step': 'Без автоматического перехода',
};

const $ = id => document.getElementById(id);
const testTitle = test => ({ receiver: 'CSI image receiver', sender: 'Send a watch photo back', ias: 'Connect and read IAS', csi: 'CSI capability queries',
  'active-receiver': 'Connect, then receive an image', 'listen-selection': 'SEND screen: listen only' })[test] ?? test;
const stepTitle = (step, t) => step.feature ? featureStepTitle(step, t) : t(testTitle(step.test));

export class IrTranPSuiteUI {
  constructor({ t, getAttempts, getEvents, blocked, applySettings, render, status, download, showFiles }) {
    Object.assign(this, { t, getAttempts, getEvents, blocked, applySettings, renderMain: render, status, download, showFiles });
    this.store = null; this.suites = []; this.selected = null; this.exporting = false; this.working = false; this.reports = new Map(); this.view = 0;
    $('suite-new').onclick = () => {
      const planID = $('suite-plan').value;
      return this.action(() => this.create(planID));
    };
    $('suite-plan').onchange = () => {
      const planID = $('suite-plan').value;
      return this.action(() => this.choosePlan(planID));
    };
    $('suite-select').onchange = () => {
      const id = $('suite-select').value;
      return this.action(() => this.select(id));
    };
    $('suite-next').onclick = () => this.action(() => this.advance());
    $('suite-skip').onclick = () => this.action(() => this.advance(true));
    $('suite-retry').onclick = () => { if (!this.blocked()) { this.apply(); this.status('Exit transfer mode on the watch, then prepare this step again.'); } };
    $('suite-export').onclick = () => this.export(true); $('all-export').onclick = () => this.export(false);
  }
  get editing() { return this.exporting || this.working; }
  async action(callback) {
    if (this.blocked() || this.editing) return;
    this.working = true; this.renderMain();
    try { await callback(); } catch (error) { this.updateSelect(); this.status(String(error), '', true); }
    finally { this.working = false; this.renderMain(); }
  }
  async initialize(store) {
    this.store = store; this.suites = (await store.attempts()).filter(item => item.format === 'wqv-irtranp-suite-v1');
    this.suites.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const saved = localStorage.getItem('wqv-irtranp-current-suite');
    this.selected = this.suites.find(suite => suite.id === saved) ?? null;
    this.updateSelect(); this.apply();
  }
  step() { return currentStep(this.selected); }
  async choosePlan(planID) {
    if (this.selected?.planID === planID) return;
    const suite = this.suites.findLast(item => item.planID === planID && currentStep(item));
    if (suite) this.select(suite.id);
    else await this.create(planID);
  }
  async create(planID = $('suite-plan').value) {
    const suite = createSuite(planID);
    await this.store.save(suite); this.suites.push(suite); this.selected = suite;
    localStorage.setItem('wqv-irtranp-current-suite', suite.id); this.updateSelect(); this.apply();
  }
  select(id) {
    this.selected = this.suites.find(suite => suite.id === id) ?? null;
    if (this.selected) localStorage.setItem('wqv-irtranp-current-suite', id);
    else localStorage.removeItem('wqv-irtranp-current-suite');
    this.updateSelect(); this.apply(); this.refreshReports();
  }
  apply() { const selected = this.step(); if (selected) this.applySettings(selected); }
  async bind(attempt) {
    if (!this.selected) return;
    const suite = structuredClone(this.selected);
    bindAttempt(suite, attempt); await this.store.save(suite); this.replace(suite); this.updateSelect();
  }
  async advance(skip = false) {
    if (skip && this.selected?.repeat) {
      const suite = structuredClone(this.selected); cancelSuiteRepeat(suite, this.getAttempts());
      await this.store.save(suite); this.replace(suite); this.apply();
      this.status('Exit transfer mode on the watch, then prepare this step again.'); return;
    }
    if (skip && !$('skip-reason').value.trim()) { $('skip-reason').setCustomValidity(this.t('Reason for skipping')); $('skip-reason').reportValidity(); return; }
    $('skip-reason').setCustomValidity('');
    const suite = structuredClone(this.selected);
    advanceSuite(suite, this.getAttempts(), skip ? { skipReason: $('skip-reason').value } : {});
    await this.store.save(suite); this.replace(suite); $('skip-reason').value = ''; this.updateSelect(); this.apply();
    if (!this.step()) this.status('Series finished. Save its ZIP; failed and skipped steps remain in the report.');
    else this.status('Exit transfer mode on the watch, then prepare this step again.');
  }
  async repeat(index) {
    const suite = structuredClone(this.selected); repeatSuiteStep(suite, index, this.getAttempts());
    await this.store.save(suite); this.replace(suite); this.apply();
    this.status('Exit transfer mode on the watch, then prepare this step again.');
  }
  replace(suite) { this.suites[this.suites.findIndex(item => item.id === suite.id)] = suite; this.selected = suite; }
  updateSelect() {
    const single = document.createElement('option'); single.value = ''; single.textContent = this.t('Single test');
    $('suite-select').replaceChildren(single, ...this.suites.map(suite => {
      const option = document.createElement('option'); option.value = suite.id;
      option.textContent = `${suite.createdAt.slice(0, 19)} UTC · ${this.t(suite.title)}`; return option;
    }));
    $('suite-select').value = this.selected?.id ?? '';
    if (this.selected) $('suite-plan').value = this.selected.planID;
  }
  render() {
    const blocked = this.blocked() || this.editing, suite = this.selected, selected = this.step(), attempts = this.getAttempts();
    $('suite-new').disabled = blocked || !this.store; $('suite-plan').disabled = blocked || !this.store;
    $('suite-select').disabled = blocked; $('suite-current').hidden = !suite;
    $('suite-next').disabled = blocked || !stepCanAdvance(suite, attempts);
    $('suite-next').textContent = this.t(suite?.repeat ? 'Finish repeat' : 'Next step');
    $('suite-skip').textContent = this.t(suite?.repeat ? 'Cancel repeat' : 'Skip step');
    $('suite-retry').disabled = blocked || !selected; $('suite-skip').disabled = blocked || !selected;
    $('skip-reason').disabled = blocked || !selected;
    $('skip-reason').hidden = Boolean(suite?.repeat);
    $('suite-export').disabled = blocked || !suite; $('all-export').disabled = blocked || !attempts.length && !this.suites.length;
    if (!suite) return;
    $('suite-progress').textContent = selected ? (suite.repeat ? this.t('Repeating') + ' · ' : '') +
      `${this.t('Step')} ${suite.cursor + 1} / ${suite.steps.length} · ${stepTitle(selected, this.t)} · ${selected.maxBaud} bit/s` : this.t('Series finished. Save its ZIP; failed and skipped steps remain in the report.');
    $('suite-steps').replaceChildren(...suite.steps.map((item, index) => {
      const row = document.createElement('tr'); if (index === suite.cursor) row.setAttribute('aria-current', 'step');
      if (item.skipped) row.classList.add('skipped');
      const runs = attempts.filter(attempt => item.attemptIDs.includes(attempt.id));
      const last = runs.at(-1), report = last && this.reports.get(last.id);
      const verdict = item.skipped ? 'skipped' : last ? report ? reportResultKey(report) : last.status : 'pending';
      for (const value of [index + 1, stepTitle(item, this.t), item.watchMode.toUpperCase().replace('-', ' '), item.maxBaud,
        item.test === 'receiver' ? item.imageProfile === 'csi' ? 'CSI' : 'Nokia' : '—',
        ({ strict: 'CRC', pad5: 'PAD-5', 'pad5-bof': 'PAD-5 + BOF' })[item.frameRecovery] ?? this.t('Current defaults'), item.attemptIDs.length,
        this.t(verdict) + (item.skipped ? ': ' + item.skipReason : '')]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      const action = document.createElement('td'), repeat = document.createElement('button');
      repeat.textContent = this.t('Repeat step'); repeat.dataset.stepIndex = index;
      repeat.setAttribute('aria-label', `${this.t('Repeat step')} ${index + 1}`);
      repeat.disabled = blocked || Boolean(suite.repeat) || index >= suite.cursor;
      repeat.onclick = () => this.action(() => this.repeat(index)); action.append(repeat); row.append(action);
      return row;
    }));
  }
  async refreshReports() {
    const suite = this.selected;
    if (!suite || this.blocked()) return;
    const ids = new Set(suite.steps.flatMap(step => step.attemptIDs));
    for (const attempt of this.getAttempts()) {
      if (this.blocked() || this.selected !== suite) return;
      if (!ids.has(attempt.id) || this.reports.has(attempt.id)) continue;
      try { this.reports.set(attempt.id, await analyseAttempt(attempt, await this.getEvents(attempt.id))); }
      catch { /* A selected attempt shows its analysis error separately. Raw export remains available. */ }
    }
    if (this.selected === suite) this.render();
  }
  async showAttempt(attempt) {
    const version = ++this.view;
    $('attempt-analysis').hidden = !attempt; if (!attempt) return;
    attempt = structuredClone(attempt);
    try {
      const events = await this.getEvents(attempt.id), report = await analyseAttempt(attempt, events);
      if (version !== this.view) return;
      this.reports.set(attempt.id, report);
      this.render();
      $('analysis-verdict').textContent = `${this.t(reportResultKey(report))} · ${this.t('Recorded status')}: ${report.recordedStatus} · ${report.lastPhase} · ` +
        `${report.negotiatedBaud ?? report.receiveBaud ?? '—'} bit/s · CRC ${report.badCRC} · ${this.t('Pending USB calls')}: ${report.pendingUSBCalls.length}`;
      $('analysis-layers').replaceChildren(...report.layers.map(layer => {
        const item = document.createElement('li'); item.className = layer.status; item.textContent = layer.name;
        item.title = this.t(layer.status) + ': ' + JSON.stringify(layer.detail); return item;
      }));
      const fileNodes = report.files.map(file => {
        const item = document.createElement('p'); item.textContent = `${file.filename} · ${file.bytes} B · ${file.width ?? '?'} × ${file.height ?? '?'}\nUPF SHA-256: ${file.upfSHA256}\nJPEG SHA-256: ${file.jpegSHA256 ?? file.previewError}`;
        if (file.metadata) {
          const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
          summary.textContent = this.t('Received metadata'); pre.textContent = JSON.stringify(file.metadata, null, 2);
          details.append(summary, pre); item.append(details);
        }
        return item;
      });
      if (report.test === 'sender') {
        const note = document.createElement('p'); note.textContent = this.t(UPLOAD_EVIDENCE_NOTE); fileNodes.push(note);
      }
      for (const [index, file] of report.uploads.entries()) {
        const item = document.createElement('p');
        const replies = report.uploads.length > 1 ? report.putReplies.filter(reply => reply.copy === index + 1) : report.putReplies;
        item.textContent = `PUT: ${file.filename} · ${file.bytes} B\nUPF SHA-256: ${file.upfSHA256}\n` +
          `RPL0: ${replies.filter(r => r.accepted).map(r => r.storedFilename || '(empty)').join(', ') || '—'} · ${report.uploadOutcome ?? '—'}`;
        fileNodes.push(item);
      }
      if (report.featureEvidence) {
        const details = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre');
        summary.textContent = this.t('Feature evidence') + (report.featureEvidence.imageMatches === null ? '' : ' · ' + this.t(
          report.featureEvidence.imageMatches ? 'Image matches the upload' : 'Different image; metadata result is inconclusive'));
        pre.textContent = JSON.stringify(report.featureEvidence, null, 2); details.open = true; details.append(summary, pre); fileNodes.push(details);
      }
      if (attempt.suite?.comparisonGroup && report.files[0]?.jpegSHA256) {
        const candidates = this.getAttempts().filter(other => other.suite?.id === attempt.suite.id &&
          other.suite?.comparisonGroup === attempt.suite.comparisonGroup);
        let baseline;
        for (const candidate of candidates) {
          const analysed = candidate.id === report.id ? report : this.reports.get(candidate.id) ??
            await analyseAttempt(candidate, await this.getEvents(candidate.id));
          this.reports.set(candidate.id, analysed);
          if (analysed.files[0]?.jpegSHA256) { baseline = analysed; break; }
        }
        if (version !== this.view) return;
        if (baseline) {
          const comparison = document.createElement('p');
          comparison.textContent = this.t(baseline.id === report.id ? 'Comparison baseline' :
            baseline.files[0].jpegSHA256 === report.files[0].jpegSHA256 ? 'JPEG matches the first photo' : 'JPEG differs from the first photo') +
            ' · ' + baseline.id + '\n' + this.t('Use the same watch photo to interpret a hash difference.');
          fileNodes.push(comparison);
        }
      }
      $('analysis-files').replaceChildren(...fileNodes);
      $('analysis-timing').textContent = `${this.t('First frame after start')}: ${report.firstFrameMs === null ? '—' : Math.round(report.firstFrameMs) + ' ms'} · ` +
        `${this.t('Front-button markers')}: ${report.frontButtonMarkers}` +
        (attempt.test === 'listen-selection' ? '\n' + this.t('Captured USB bytes by marked stage') + ': ' + report.windows.map(window => `${window.stage} ${window.rxBytes} B`).join(' · ') : '');
      if (!this.blocked()) this.showFiles(events);
    } catch (error) {
      if (version === this.view) $('analysis-verdict').textContent = this.t('Analysis unavailable') + ': ' + String(error);
    }
  }
  async export(onlySuite) {
    if (this.editing || this.blocked()) return;
    this.exporting = true; this.renderMain(); this.status('Preparing the complete ZIP…');
    try {
      const suite = onlySuite ? this.selected : null, ids = new Set(suite?.steps.flatMap(step => step.attemptIDs) ?? []);
      const attempts = this.getAttempts().filter(attempt => !suite || attempt.suite?.id === suite.id || ids.has(attempt.id));
      if (!attempts.length && !suite && !this.suites.length) { this.status('No attempts to export yet.'); return; }
      const records = [];
      for (const attempt of attempts) records.push({ attempt: structuredClone(attempt), events: await this.getEvents(attempt.id) });
      const files = await suiteFiles(structuredClone(suite), records, { suites: structuredClone(this.suites) });
      this.download(zipFiles(files), `WQV-IrTranP-series-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
      this.status('The complete ZIP has been saved.');
    } catch (error) { this.status(String(error), '', true); }
    finally { this.exporting = false; this.renderMain(); }
  }
}
