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
  tr('Choose your watch to open its application.') + '\n\n' + tr('Use Settings to change the language and the first day of week.')) });
bindApplicationNavigation();
