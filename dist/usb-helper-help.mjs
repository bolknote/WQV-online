import { tr } from './i18n.mjs';

const helpers = {
  'irda_usb_helper.py': { url: 'http://127.0.0.1:8768/usb', name: 'WQV Link USB Helper' },
  'kingsun_bridge.py': { url: 'http://127.0.0.1:8767/usb', name: 'WQV Link / KingSun KS-959' },
};
export async function probeUSBHelper({ script = 'irda_usb_helper.py', signal, fetcher = globalThis.fetch.bind(globalThis) } = {}) {
  const helper = helpers[script]; if (!helper) throw new Error('Unknown USB helper');
  try {
    const response = await fetcher(helper.url, { cache: 'no-store', credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500) });
    const reply = await response.json();
    return response.ok && reply.helper === helper.name && reply.version === 1;
  } catch { return false; }
}
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
// Probe sequentially: no overlapping requests or timers survive cancellation.
export async function waitForUSBHelper({ signal, probe = probeUSBHelper, interval = 600, onWaiting = () => {} } = {}) {
  signal?.throwIfAborted();
  let waiting = false;
  for (;;) {
    const ready = await probe({ signal }); signal?.throwIfAborted();
    if (ready) return;
    if (!waiting) { onWaiting(); waiting = true; }
    await pause(interval, signal);
  }
}

let activeWait = false;
export async function ensureUSBHelperReady({ script = 'irda_usb_helper.py', signal } = {}) {
  if (!helpers[script]) throw new Error('Unknown USB helper');
  if (activeWait) throw new DOMException('Another USB connection is pending.', 'InvalidStateError');
  const controller = new AbortController();
  const waitingSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let dialog;
  activeWait = true;
  try {
    await waitForUSBHelper({ signal: waitingSignal, probe: options => probeUSBHelper({ ...options, script }), onWaiting: () => {
      dialog = document.createElement('dialog'); dialog.id = 'usb-helper-dialog'; dialog.className = 'usb-helper-dialog';
      dialog.setAttribute('aria-labelledby', 'usb-helper-title');
      dialog.innerHTML = `<div class="dialog-title"><strong id="usb-helper-title" data-i18n="USB Helper"></strong></div>
        <div class="dialog-body"><p data-helper-state role="status" aria-live="polite" data-i18n="Waiting for the helper. The connection will continue automatically when it starts."></p>
        <section data-helper-steps>
        <p data-i18n="USB Helper runs on the computer with the adapter. Python 3 and libusb are required."></p>
        <ol><li><a data-helper-download download data-i18n="Download USB Helper"></a></li>
        <li><p data-i18n="Open a terminal in the folder where you saved the file, then run:"></p><code data-helper-command></code></li>
        <li><p data-i18n="Leave the terminal open. This window will close and the connection will continue automatically."></p></li></ol>
        <p data-i18n="If the helper reports missing Python or libusb, install the missing requirement before trying again."></p>
        <p data-i18n="If the browser asks for access to the local network, allow it for this connection."></p>
        <p data-i18n="Address already in use means the port is occupied. If the helper is already running, check that you started the correct file on this computer."></p>
        </section><div class="dialog-actions"><button type="button" data-helper-cancel data-i18n="Cancel connection"></button></div></div>`;
      for (const node of dialog.querySelectorAll('[data-i18n]')) node.textContent = tr(node.dataset.i18n);
      const link = dialog.querySelector('[data-helper-download]'); link.href = './' + script; link.download = script;
      dialog.querySelector('[data-helper-command]').textContent = 'python3 ' + script;
      dialog.querySelector('[data-helper-cancel]').onclick = () => controller.abort(new DOMException('Connection cancelled.', 'AbortError'));
      dialog.addEventListener('cancel', event => event.preventDefault());
      document.querySelector('.screen').append(dialog); dialog.showModal();
    } });
  } finally {
    if (dialog?.open) dialog.close(); dialog?.remove(); activeWait = false;
  }
}
