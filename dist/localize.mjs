import { translateDOM, tr } from './i18n.mjs';
import { installDesktopClock } from './desktop-clock.mjs';

// This small entry point blocks the first render, not HTML parsing or the
// application's downloads. Show the saved language before the USB stack loads.
translateDOM();
installDesktopClock();
document.title = document.title.replace(/^(.*)( · CASSIOPEIA)$/, (_, name, suffix) => tr(name) + suffix);
