import { tr, getLanguage } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';

const $ = id => document.getElementById(id);
const requested = new URL(location.href).searchParams.get('model');
const model = ['wqv2', 'wqv3'].includes(requested) ? requested : 'wqv3';
const name = model === 'wqv2' ? 'WQV-2' : 'WQV-3';
let opened = '';
function applySize() {
  const root = $('document-frame').contentDocument?.documentElement;
  if (root) root.className = 'size-' + $('document-size').value;
}
function showDocument() {
  const file = model + '-' + getLanguage() + '.html';
  const title = tr('{0} — User’s Guide', name);
  $('document-title').textContent = title;
  document.title = title + ' · Pocket Word';
  if (file === opened) return;
  opened = file;
  $('document-loading').hidden = false;
  $('document-status').textContent = tr('Opening document…');
  $('document-frame').src = './manuals/' + file;
}
$('document-frame').addEventListener('load', () => {
  const doc = $('document-frame').contentDocument;
  const article = doc?.querySelector('article[data-pages]');
  if (!article) {
    $('document-loading').hidden = false;
    $('document-loading').textContent = tr('Could not open the manual.');
    $('document-status').textContent = tr('Could not open the manual.');
    return;
  }
  $('document-loading').hidden = true;
  $('document-status').textContent = tr('{0} pages', article.dataset.pages);
  const original = doc.querySelector('footer a');
  if (original) $('original-pdf').href = original.href;
  const placeholder = new Option(String(tr('Contents')), '');
  const headings = [...doc.querySelectorAll('h2[id], h3[id]')];
  $('document-contents').replaceChildren(placeholder, ...headings.map(heading => new Option(heading.textContent, heading.id)));
  applySize();
});
$('document-size').addEventListener('change', applySize);
$('document-contents').addEventListener('change', event => {
  const heading = $('document-frame').contentDocument?.getElementById(event.target.value);
  heading?.scrollIntoView({ block: 'start' });
});
installDesktopShell({ changed: showDocument, help: () => messageDialog('Pocket Word · WQV Link',
  tr('Open a manual from Programs. It follows the display language chosen in Options. Text wraps to the window; illustrations come from the original PDF.')) });
bindApplicationNavigation();
