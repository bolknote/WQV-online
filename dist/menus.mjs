// The Start menu and the menu bar share one active popup.
export function installMenus() {
  const start = document.getElementById('start-menu');
  const button = document.getElementById('start-menu-button');
  const menus = [...document.querySelectorAll('.menubar details.menu')];
  function closeStart() {
    start.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  function closeMenus() {
    closeStart();
    for (const menu of menus) menu.open = false;
  }
  for (const menu of menus) {
    menu.setAttribute('name', 'application-menu');
    // Close synchronously on pointer and keyboard activation, including in
    // browsers without native exclusive-details support.
    menu.querySelector('summary').addEventListener('click', () => {
      closeStart();
      for (const other of menus) if (other !== menu) other.open = false;
    });
    menu.addEventListener('toggle', () => { if (menu.open) closeStart(); });
  }
  button.addEventListener('click', () => {
    const opening = start.hidden;
    closeMenus();
    start.hidden = !opening;
    button.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.start-menu,.start-button,.menu')) closeMenus();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenus(); });
  return closeMenus;
}
