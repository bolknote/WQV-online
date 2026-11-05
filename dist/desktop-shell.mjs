import { tr, onLanguageChange, translateDOM, locale } from './i18n.mjs';
import { installMenus } from './menus.mjs';
import { installScreenDialogs } from './screen-dialogs.mjs';
import { installSystemSettings } from './system-settings.mjs';

export function installDesktopShell({ help, changed = () => {} } = {}) {
  installScreenDialogs();
  const $ = id => document.getElementById(id);
  const closeMenus = installMenus();
  installSystemSettings({ closeMenus });
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
