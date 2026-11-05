import { locale, onLanguageChange } from './i18n.mjs';

let installed = false;
export function installDesktopClock() {
  if (installed) return;
  const clock = document.getElementById('pc-clock');
  if (!clock) return;
  installed = true;
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  let timer;
  const start = () => { tick(); timer ??= setInterval(tick, 1000); };
  start();
  onLanguageChange(tick);
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = undefined; });
  window.addEventListener('pageshow', start);
}
