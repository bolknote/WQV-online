import { tr, getLanguage, setLanguage, onLanguageChange, translateDOM, locale } from './i18n.mjs';

export function installDesktopShell({ help, changed = () => {} } = {}) {
  const $ = id => document.getElementById(id);
  const closeMenus = () => {
    $('start-menu').hidden = true; $('start-menu-button').setAttribute('aria-expanded', 'false');
    document.querySelectorAll('details.menu').forEach(menu => { menu.open = false; });
  };
  $('start-menu-button').addEventListener('click', () => {
    const opening = $('start-menu').hidden; closeMenus();
    $('start-menu').hidden = !opening; $('start-menu-button').setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', event => { if (!event.target.closest('.start-menu,.start-button,.menu')) closeMenus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
  const showOptions = () => {
    closeMenus(); const dialog = $('options-dialog');
    const radio = dialog.querySelector('input[value="' + getLanguage() + '"]');
    radio.checked = true; dialog.showModal(); radio.focus();
  };
  for (const id of ['menu-options', 'start-options']) $(id)?.addEventListener('click', showOptions);
  $('options-accept').addEventListener('click', () => {
    const next = $('options-dialog').querySelector('input[name="display-language"]:checked').value;
    $('options-dialog').close(); setLanguage(next);
  });
  $('options-cancel').addEventListener('click', () => $('options-dialog').close());
  for (const id of ['help-top', 'help-menu', 'help-menu-bar']) $(id)?.addEventListener('click', () => { closeMenus(); help?.(); });
  const tick = () => { $('pc-clock').textContent = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }); };
  const apply = () => { translateDOM(); tick(); changed(); };
  onLanguageChange(apply); apply();
  const timer = setInterval(tick, 1000);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return { closeMenus };
}

export function messageDialog(title, text, { confirm = false, accept = 'OK' } = {}) {
  const dialog = document.getElementById('message-dialog');
  document.getElementById('dialog-title').textContent = title;
  document.getElementById('dialog-message').textContent = text;
  document.getElementById('dialog-accept').textContent = accept;
  document.getElementById('dialog-cancel').hidden = !confirm;
  return new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    document.getElementById('dialog-accept').onclick = () => finish(true);
    document.getElementById('dialog-cancel').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.showModal(); document.getElementById(confirm ? 'dialog-cancel' : 'dialog-accept').focus();
  });
}
