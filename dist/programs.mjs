import { tr, getLanguage } from './i18n.mjs';
import { manualLabel } from './manual-editions.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';

installDesktopShell({ changed: () => {
  document.title = tr('Programs') + ' · CASSIOPEIA';
  const guide = document.querySelector('.document-icon[href="./manual.html?model=wqv3"]');
  guide.querySelector('[data-i18n="User’s Guide"]').textContent = manualLabel('wqv3', getLanguage()) || tr('User’s Guide');
}, help: () => messageDialog('CASSIOPEIA · WQV Link',
  tr('Open WQV-1/2, WQV-3 or WQV-10 to use your wrist camera. Each application keeps its own photo collection. Use Tools → Options to choose the display language.')) });
bindApplicationNavigation();
