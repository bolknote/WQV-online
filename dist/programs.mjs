import { tr } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';

installDesktopShell({ changed: () => { document.title = tr('Programs') + ' · CASSIOPEIA'; }, help: () => messageDialog('CASSIOPEIA · WQV Link',
  tr('Open WQV-2 or WQV-3 to use your wrist camera. Each application keeps its own photo collection. Use Tools → Options to choose the display language.')) });
bindApplicationNavigation();
