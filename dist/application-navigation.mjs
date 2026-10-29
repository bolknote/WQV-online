// A program owns its USB connection. Release it before another page takes over.
export function bindApplicationNavigation({ isBusy = () => false, close = async () => {},
  root = document, navigate = href => window.location.assign(href) } = {}) {
  let leaving = false;
  const links = [...root.querySelectorAll('[data-application-exit]')];
  const update = () => {
    for (const link of links) link.setAttribute('aria-disabled', String(leaving || isBusy()));
  };
  for (const link of links) link.addEventListener('click', async event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (leaving || isBusy()) return;
    leaving = true; update();
    try { await close(); navigate(link.href); }
    finally { leaving = false; update(); }
  });
  update(); return update;
}
