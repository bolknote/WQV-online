import { tr, getLanguage, setLanguage, translateDOM } from './i18n.mjs';
import { getWeekStart, setWeekStart, weekdayOrder } from './preferences.mjs';

export function installSystemSettings({ closeMenus = () => {} } = {}) {
  const dialog = document.getElementById('options-dialog');
  if (!dialog || dialog.dataset.installed) return;
  dialog.dataset.installed = 'true'; dialog.className = 'system-settings-dialog';
  dialog.innerHTML = `
    <div class="dialog-title"><svg class="icon" aria-hidden="true"><use href="./icons.svg#settings"/></svg><strong id="options-title" data-i18n="Settings">Settings</strong></div>
    <div class="dialog-body">
      <section id="settings-home">
        <div class="system-settings-grid">
          <button type="button" class="system-setting" id="settings-language"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#language"/></svg><span data-i18n="Language">Language</span></button>
          <button type="button" class="system-setting" id="settings-calendar"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#calendar"/></svg><span data-i18n="Calendar display">Calendar display</span></button>
          <a class="system-setting" href="./drivers.html" data-application-exit><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#chip"/></svg><span data-i18n="Infrared drivers">Infrared drivers</span></a>
        </div>
        <div class="dialog-actions"><button type="button" id="settings-close" data-i18n="Close">Close</button></div>
      </section>
      <section id="settings-language-panel" hidden>
        <fieldset><legend data-i18n="Display language">Display language</legend>
          <label class="language-choice" translate="no" lang="en"><input type="radio" name="display-language" value="en">English</label>
          <label class="language-choice" translate="no" lang="ru"><input type="radio" name="display-language" value="ru">Русский</label>
          <label class="language-choice" translate="no" lang="ja"><input type="radio" name="display-language" value="ja">日本語</label>
          <label class="language-choice" translate="no" lang="de"><input type="radio" name="display-language" value="de">Deutsch</label>
          <label class="language-choice" translate="no" lang="es"><input type="radio" name="display-language" value="es">Español</label>
          <label class="language-choice" translate="no" lang="fi"><input type="radio" name="display-language" value="fi">Suomi</label>
        </fieldset>
        <div class="dialog-actions"><button type="button" class="settings-back" data-settings-back data-i18n="Back">Back</button><button type="button" id="options-accept">OK</button><button type="button" id="options-cancel" data-i18n="Cancel">Cancel</button></div>
      </section>
      <section id="settings-calendar-panel" hidden>
        <fieldset><legend data-i18n="First day of week">First day of week</legend>
          <label class="language-choice"><input type="radio" name="week-start" value="mon"><span data-i18n="Monday">Monday</span></label>
          <label class="language-choice"><input type="radio" name="week-start" value="sun"><span data-i18n="Sunday">Sunday</span></label>
          <div class="settings-week-preview" id="settings-week-preview" role="img" data-i18n-aria-label="Calendar preview" aria-label="Calendar preview"></div>
        </fieldset>
        <div class="dialog-actions"><button type="button" class="settings-back" data-settings-back data-i18n="Back">Back</button><button type="button" id="week-start-accept">OK</button><button type="button" id="week-start-cancel" data-i18n="Cancel">Cancel</button></div>
      </section>
    </div>`;
  const $ = id => dialog.querySelector('#' + id);
  const panels = ['home', 'language-panel', 'calendar-panel'];
  function showPanel(panel) {
    for (const name of panels) $('settings-' + name).hidden = name !== panel;
    const title = panel === 'home' ? 'Settings' : panel === 'language-panel' ? 'Language' : 'Calendar display';
    $('options-title').dataset.i18n = title;
    translateDOM(dialog);
  }
  const open = () => { closeMenus(); showPanel('home'); if (!dialog.open) dialog.showModal(); $('settings-language').focus(); };
  for (const id of ['start-options', 'menu-options']) {
    const button = document.getElementById(id); if (!button) continue;
    button.dataset.i18n = 'Settings'; button.textContent = String(tr('Settings')); button.addEventListener('click', open);
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-system-settings]')) { event.preventDefault(); open(); }
  });
  $('settings-language').addEventListener('click', () => {
    dialog.querySelector('input[name="display-language"][value="' + getLanguage() + '"]').checked = true;
    showPanel('language-panel'); dialog.querySelector('input[name="display-language"]:checked').focus();
  });
  function preview() {
    const start = dialog.querySelector('input[name="week-start"]:checked').value;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    $('settings-week-preview').replaceChildren(...weekdayOrder(start).map(day => {
      const span = document.createElement('span'); span.textContent = String(tr(names[day])); span.classList.toggle('weekend', day === 0 || day === 6); return span;
    }));
  }
  $('settings-calendar').addEventListener('click', () => {
    dialog.querySelector('input[name="week-start"][value="' + getWeekStart() + '"]').checked = true;
    showPanel('calendar-panel'); preview(); dialog.querySelector('input[name="week-start"]:checked').focus();
  });
  for (const input of dialog.querySelectorAll('input[name="week-start"]')) input.addEventListener('change', preview);
  for (const button of dialog.querySelectorAll('[data-settings-back]')) button.addEventListener('click', () => { showPanel('home'); $('settings-language').focus(); });
  for (const id of ['settings-close', 'options-cancel', 'week-start-cancel']) $(id).addEventListener('click', () => dialog.close());
  $('options-accept').addEventListener('click', () => {
    const next = dialog.querySelector('input[name="display-language"]:checked').value;
    dialog.close(); setLanguage(next);
  });
  $('week-start-accept').addEventListener('click', () => {
    const next = dialog.querySelector('input[name="week-start"]:checked').value;
    dialog.close(); setWeekStart(next);
  });
}
