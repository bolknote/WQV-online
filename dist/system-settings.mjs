import { tr, getLanguage, setLanguage, translateDOM } from './i18n.mjs';
import { getWeekStart, setWeekStart, weekdayOrder } from './preferences.mjs';

export function installSystemSettings({ closeMenus = () => {} } = {}) {
  const appWindow = document.getElementById('settings-window');
  if (!appWindow || appWindow.dataset.installed) return;
  const screen = document.querySelector('.screen');
  if (!screen) return;
  appWindow.dataset.installed = 'true';
  screen.append(appWindow);
  appWindow.innerHTML = `
    <header class="titlebar settings-titlebar"><span class="app-title"><svg class="icon" aria-hidden="true"><use href="./icons.svg#settings"/></svg><strong id="options-title" data-i18n="Settings">Settings</strong></span><button type="button" id="settings-close" class="window-close" aria-label="Close application" title="Close application" data-i18n-aria-label="Close application" data-i18n-title="Close application">×</button></header>
    <div class="dialog-body">
      <section id="settings-home">
        <div class="system-settings-grid">
          <button type="button" class="system-setting" id="settings-language"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#language"/></svg><span data-i18n="Language">Language</span></button>
          <button type="button" class="system-setting" id="settings-calendar"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#calendar"/></svg><span data-i18n="Calendar display">Calendar display</span></button>
          <a class="system-setting" href="./drivers.html" data-application-exit><svg viewBox="0 0 16 16" aria-hidden="true"><use href="./icons.svg#chip"/></svg><span data-i18n="Infrared drivers">Infrared drivers</span></a>
        </div>
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
  const $ = id => appWindow.querySelector('#' + id);
  const panels = ['home', 'language-panel', 'calendar-panel'];
  function showPanel(panel) {
    for (const name of panels) $('settings-' + name).hidden = name !== panel;
    const title = panel === 'home' ? 'Settings' : panel === 'language-panel' ? 'Language' : 'Calendar display';
    $('options-title').dataset.i18n = title;
    translateDOM(appWindow);
  }
  let opener;
  function close() {
    if (appWindow.hidden) return;
    closeMenus(); appWindow.hidden = true;
    opener?.focus({ preventScroll: true });
  }
  const open = () => {
    closeMenus(); showPanel('home');
    if (appWindow.hidden) {
      opener = document.activeElement?.closest('.start-menu,.menu') ? document.getElementById('start-menu-button') : document.activeElement;
      appWindow.hidden = false;
    }
    $('settings-language').focus({ preventScroll: true });
  };
  for (const id of ['start-options', 'menu-options']) {
    const button = document.getElementById(id); if (!button) continue;
    button.dataset.i18n = 'Settings'; button.textContent = String(tr('Settings')); button.addEventListener('click', open);
  }
  document.addEventListener('click', event => {
    if (event.target.closest('[data-system-settings]')) { event.preventDefault(); open(); }
    else if (event.target.closest('.start-menu [data-tab]')) close();
  });
  $('settings-language').addEventListener('click', () => {
    appWindow.querySelector('input[name="display-language"][value="' + getLanguage() + '"]').checked = true;
    showPanel('language-panel'); appWindow.querySelector('input[name="display-language"]:checked').focus();
  });
  function preview() {
    const start = appWindow.querySelector('input[name="week-start"]:checked').value;
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    $('settings-week-preview').replaceChildren(...weekdayOrder(start).map(day => {
      const span = document.createElement('span'); span.textContent = String(tr(names[day])); span.classList.toggle('weekend', day === 0 || day === 6); return span;
    }));
  }
  $('settings-calendar').addEventListener('click', () => {
    appWindow.querySelector('input[name="week-start"][value="' + getWeekStart() + '"]').checked = true;
    showPanel('calendar-panel'); preview(); appWindow.querySelector('input[name="week-start"]:checked').focus();
  });
  for (const input of appWindow.querySelectorAll('input[name="week-start"]')) input.addEventListener('change', preview);
  for (const button of appWindow.querySelectorAll('[data-settings-back]')) button.addEventListener('click', () => { showPanel('home'); $('settings-language').focus(); });
  for (const id of ['settings-close', 'options-cancel', 'week-start-cancel']) $(id).addEventListener('click', close);
  appWindow.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    close();
  });
  $('options-accept').addEventListener('click', () => {
    const next = appWindow.querySelector('input[name="display-language"]:checked').value;
    close(); setLanguage(next);
  });
  $('week-start-accept').addEventListener('click', () => {
    const next = appWindow.querySelector('input[name="week-start"]:checked').value;
    close(); setWeekStart(next);
  });
}
