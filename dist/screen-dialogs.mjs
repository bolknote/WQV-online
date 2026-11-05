// Keep native dialog focus/inert behavior, while painting it inside the LCD.
const installed = new WeakSet();
export function installScreenDialogs(screen = document.querySelector('.screen')) {
  if (!screen || installed.has(screen)) return;
  installed.add(screen);
  const doc = screen.ownerDocument, win = doc.defaultView;
  const layout = () => {
    const dialogs = [...doc.querySelectorAll('dialog[open]')];
    screen.classList.toggle('screen-modal-open', dialogs.length > 0);
    if (!dialogs.length) return;
    let rect = screen.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= win.innerHeight) {
      screen.scrollIntoView({ block: 'center' });
      rect = screen.getBoundingClientRect();
    }
    const viewport = win.visualViewport;
    const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
    const left = Math.max(rect.left + 8, x + 8);
    const right = Math.min(rect.right - 8, x + (viewport?.width ?? win.innerWidth) - 8);
    const top = Math.max(rect.top + 8, y + 8);
    const bottom = Math.min(rect.bottom - 8, y + (viewport?.height ?? win.innerHeight) - 8);
    for (const dialog of dialogs) {
      dialog.classList.add('screen-dialog');
      dialog.style.setProperty('--dialog-x', (left + right) / 2 + 'px');
      dialog.style.setProperty('--dialog-y', (top + bottom) / 2 + 'px');
      dialog.style.setProperty('--dialog-width', Math.max(0, right - left) + 'px');
      dialog.style.setProperty('--dialog-height', Math.max(0, bottom - top) + 'px');
    }
  };
  const observer = new MutationObserver(layout);
  observer.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
  const resize = new ResizeObserver(layout);
  resize.observe(screen);
  win.addEventListener('resize', layout);
  win.addEventListener('scroll', layout, { passive: true, capture: true });
  win.visualViewport?.addEventListener('resize', layout);
  win.visualViewport?.addEventListener('scroll', layout);
  win.addEventListener('pagehide', event => {
    if (event.persisted) return;
    observer.disconnect(); resize.disconnect();
    win.removeEventListener('resize', layout);
    win.removeEventListener('scroll', layout, true);
    win.visualViewport?.removeEventListener('resize', layout);
    win.visualViewport?.removeEventListener('scroll', layout);
  });
  layout();
}
