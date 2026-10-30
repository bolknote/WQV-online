import { tr, getLanguage } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';

const $ = id => document.getElementById(id);
const requested = new URL(location.href).searchParams.get('model');
const model = ['wqv2', 'wqv3'].includes(requested) ? requested : 'wqv3';
const name = model === 'wqv2' ? 'WQV-2' : 'WQV-3';
const watchModule = model === 'wqv2' ? '2220' : '2411';
let opened = '';
let stopFollowingContents = () => {};
let updateContents = () => {};

function followContents(doc, headings) {
  const view = doc.defaultView;
  let pending = 0;
  const update = () => {
    pending = 0;
    const scroll = doc.scrollingElement;
    let current = '';
    if (scroll.scrollTop > 0 && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 1) {
      current = headings.at(-1)?.id || '';
    } else {
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > 8) break;
        current = heading.id;
      }
    }
    $('document-contents').value = current;
  };
  const schedule = () => { if (!pending) pending = requestAnimationFrame(update); };
  doc.addEventListener('scroll', schedule, { passive: true });
  view.addEventListener('resize', schedule);
  const observer = new ResizeObserver(schedule);
  observer.observe(doc.body);
  updateContents = schedule;
  stopFollowingContents = () => {
    doc.removeEventListener('scroll', schedule);
    view.removeEventListener('resize', schedule);
    observer.disconnect();
    cancelAnimationFrame(pending);
    updateContents = () => {};
  };
  schedule();
}

function applySize() {
  const root = $('document-frame').contentDocument?.documentElement;
  if (root) root.className = 'size-' + $('document-size').value;
  updateContents();
}
function showDocument() {
  const language = getLanguage();
  const file = model + '-' + language + '.html';
  const title = tr('{0} — User’s Guide', name);
  $('document-title').textContent = title;
  document.title = title + ' · Pocket Word';
  $('original-pdf').href = language === 'ru'
    ? `https://i-watch.ru/image/catalog/info/instruktsii/casio/${watchModule}.pdf`
    : `https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/${watchModule.slice(0, 2)}/${watchModule}/qw${watchModule}_${language.toUpperCase()}.pdf`;
  $('original-pdf').removeAttribute('aria-disabled');
  if (file === opened) return;
  stopFollowingContents();
  stopFollowingContents = () => {};
  opened = file;
  $('document-contents').replaceChildren(new Option(String(tr('Contents')), ''));
  $('document-contents').disabled = true;
  $('document-loading').hidden = false;
  $('document-loading').textContent = tr('Opening document…');
  $('document-status').textContent = tr('Opening document…');
  $('document-frame').src = './manuals/' + file;
}
$('document-frame').addEventListener('load', () => {
  const doc = $('document-frame').contentDocument;
  if (doc?.URL === 'about:blank') return;
  const article = doc?.querySelector('article[data-pages]');
  if (!article) {
    $('document-loading').hidden = false;
    $('document-loading').textContent = tr('Could not open the manual.');
    $('document-status').textContent = tr('Could not open the manual.');
    return;
  }
  if (doc.documentElement.lang !== getLanguage()) return;
  $('document-loading').hidden = true;
  $('document-status').textContent = tr('{0} pages', article.dataset.pages);
  const placeholder = new Option(String(tr('Contents')), '');
  const headings = [...doc.querySelectorAll('h2[id], h3[id]')];
  $('document-contents').replaceChildren(placeholder, ...headings.map(heading => new Option(heading.textContent, heading.id)));
  $('document-contents').disabled = headings.length === 0;
  applySize();
  followContents(doc, headings);
});
$('document-size').addEventListener('change', applySize);
$('document-contents').addEventListener('change', event => {
  const heading = $('document-frame').contentDocument?.getElementById(event.target.value);
  heading?.scrollIntoView({ block: 'start' });
  updateContents();
});
installDesktopShell({ changed: showDocument, help: () => messageDialog('Pocket Word · WQV Link',
  tr('Open a manual from Programs. It follows the display language chosen in Options. Text wraps to the window; illustrations come from the original PDF.')) });
bindApplicationNavigation();
