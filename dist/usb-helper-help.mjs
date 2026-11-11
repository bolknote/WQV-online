import { tr } from './i18n.mjs';

export async function probeUSBHelper({ signal, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  try {
    const response = await fetcher('http://127.0.0.1:8768/usb', { cache: 'no-store', credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
    const reply = await response.json();
    return response.ok && reply.helper === 'WQV Link USB Helper' && reply.version === 1;
  } catch { return false; }
}

export function openUSBHelperHelp(script = 'irda_usb_helper.py') {
  if (!['irda_usb_helper.py', 'kingsun_bridge.py'].includes(script)) throw new Error('Unknown USB helper');
  let dialog = document.getElementById('usb-helper-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'usb-helper-dialog'; dialog.className = 'usb-helper-dialog';
    dialog.setAttribute('aria-labelledby', 'usb-helper-title');
    dialog.innerHTML = `<div class="dialog-title"><strong id="usb-helper-title" data-i18n="USB Helper">USB Helper</strong><button class="transfer-close" type="button" data-helper-close aria-label="Close" data-i18n-aria-label="Close">×</button></div>
      <div class="dialog-body"><p data-helper-state role="status" aria-live="polite"></p>
      <button type="button" data-helper-probe data-i18n="Check helper">Check helper</button>
      <details data-helper-steps open><summary data-i18n="Download and startup instructions">Download and startup instructions</summary>
      <p data-i18n="USB Helper runs on the computer with the adapter. Python 3 and libusb are required."></p>
      <ol><li><a data-helper-download download data-i18n="Download USB Helper"></a></li>
      <li><p data-i18n="Open a terminal in the folder where you saved the file, then run:"></p><code data-helper-command></code></li>
      <li><p data-i18n="Leave the terminal open. Return to WQV Link and connect again, or press Test in Drivers."></p></li></ol>
      <p data-i18n="If the helper reports missing Python or libusb, install the missing requirement before trying again."></p>
      <p data-i18n="Address already in use means another process is using the helper port. Check helper before starting another copy."></p>
      </details><div class="dialog-actions"><button type="button" data-helper-close data-i18n="Close">Close</button></div></div>`;
    document.querySelector('.screen').append(dialog);
    dialog.querySelectorAll('[data-helper-close]').forEach(button => button.onclick = () => dialog.close());
    dialog.addEventListener('close', () => dialog.helperProbe?.abort());
  }
  for (const node of dialog.querySelectorAll('[data-i18n]')) node.textContent = tr(node.dataset.i18n);
  dialog.querySelector('[aria-label]').setAttribute('aria-label', tr('Close'));
  dialog.querySelector('[data-helper-command]').textContent = 'python3 ' + script;
  const link = dialog.querySelector('[data-helper-download]'); link.href = './' + script; link.download = script;
  const probe = dialog.querySelector('[data-helper-probe]'), state = dialog.querySelector('[data-helper-state]');
  probe.hidden = script !== 'irda_usb_helper.py';
  const check = async () => {
    dialog.helperProbe?.abort(); const controller = dialog.helperProbe = new AbortController();
    probe.disabled = true; state.dataset.state = 'checking'; state.dataset.i18n = 'Checking USB Helper…'; state.textContent = tr(state.dataset.i18n);
    const running = await probeUSBHelper({ signal: controller.signal });
    if (controller.signal.aborted || !dialog.open) return;
    state.dataset.i18n = running ? 'USB Helper is running. No need to start another copy.' : 'USB Helper is not responding. Follow the instructions below, then check again.';
    state.textContent = tr(state.dataset.i18n);
    state.dataset.state = running ? 'running' : 'unavailable';
    dialog.querySelector('[data-helper-steps]').open = !running; probe.disabled = false;
  };
  probe.onclick = check;
  if (!dialog.open) dialog.showModal();
  if (!probe.hidden) void check();
  else { state.dataset.state = 'instructions'; state.dataset.i18n = 'Leave the terminal open while using the adapter.'; state.textContent = tr(state.dataset.i18n); dialog.querySelector('[data-helper-steps]').open = true; }
}

globalThis.document?.addEventListener('click', event => {
  const button = event.target.closest('[data-usb-helper-help]');
  if (button) openUSBHelperHelp(button.dataset.usbHelperHelp || undefined);
});
