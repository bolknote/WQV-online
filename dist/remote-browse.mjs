// The original Palm controls step five photos on a tap and browse while held.
// Listen on the window as USB work disables the pressed button; release,
// pointer cancellation and loss of focus must still stop the watch.
export function bindRemoteBrowse(button, { step, hold, delay = 350 }) {
  const view = button.ownerDocument.defaultView;
  let press = null, pointerClick = false;
  button.addEventListener('pointerdown', event => {
    if (button.disabled || event.button !== 0 || press) return;
    const current = { id: event.pointerId, released: false, held: false, timer: null };
    press = current; pointerClick = true;
    current.timer = setTimeout(() => {
      if (press !== current || current.released) return;
      current.held = true; hold(() => current.released);
    }, delay);
  });
  function release(event, cancelled = false) {
    if (!press || (event.pointerId !== undefined && event.pointerId !== press.id)) return;
    const current = press; press = null;
    clearTimeout(current.timer); current.released = true;
    if (!current.held && !cancelled) step();
  }
  view.addEventListener('pointerup', event => release(event), true);
  view.addEventListener('pointercancel', event => release(event, true), true);
  view.addEventListener('blur', event => release(event, true));
  button.ownerDocument.addEventListener('visibilitychange', event => {
    if (button.ownerDocument.hidden) release(event, true);
  });
  button.addEventListener('click', event => {
    if (!event.detail || !pointerClick) step();
    pointerClick = false;
  });
  button.addEventListener('contextmenu', event => { if (press) event.preventDefault(); });
}
