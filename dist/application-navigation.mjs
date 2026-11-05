// A program owns its USB connection. Release it before another page takes over.
export function bindApplicationNavigation({ isBusy = () => false, close = async () => {},
  root = document, navigate = href => window.location.assign(href) } = {}) {
  let leaving = false;
  const update = () => {
    for (const link of root.querySelectorAll('[data-application-exit]')) link.setAttribute('aria-disabled', String(leaving || isBusy()));
  };
  root.addEventListener('click', async event => {
    const link = event.target.closest?.('[data-application-exit]');
    if (!link || event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (leaving || isBusy()) return;
    leaving = true; update();
    try { await close(); navigate(link.href); }
    finally { leaving = false; update(); }
  });
  update(); return update;
}
