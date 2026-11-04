import { tr, getLanguage } from './i18n.mjs';
import { manualLabel } from './manual-editions.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';
import { watchModel } from './watch-models.mjs';

installDesktopShell({ changed: () => {
  document.title = tr('Programs') + ' · CASSIOPEIA';
  for (const guide of document.querySelectorAll('.document-icon')) {
    const model = new URL(guide.href).searchParams.get('model');
    const label = manualLabel(model, getLanguage()) || tr('User’s Guide');
    guide.querySelector('[data-i18n="User’s Guide"]').textContent = label;
    guide.setAttribute('aria-label', manualLabel(model, getLanguage())
      ? watchModel(model).name + ' ' + label : tr(guide.getAttribute('data-i18n-aria-label')));
  }
}, help: () => messageDialog('CASSIOPEIA · WQV Link',
  tr('Open WQV-1/2, WQV-3 or WQV-10 to use your wrist camera. Each application keeps its own photo collection. Use Tools → Options to choose the display language.')) });
bindApplicationNavigation();
