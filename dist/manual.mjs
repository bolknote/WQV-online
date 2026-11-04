import { tr, getLanguage } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';
import { watchModel } from './watch-models.mjs';
import { manualLanguage, manualLabel, manualSourceURL } from './manual-editions.mjs';

const $ = id => document.getElementById(id);
const requested = new URL(location.href).searchParams.get('model');
const profile = watchModel(requested);
const model = profile.id, name = profile.name;
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
  const language = manualLanguage(model, getLanguage());
  const file = model + '-' + language + '.html';
  const title = manualLabel(model, getLanguage()) ? name + ' — User’s Guide' : tr('{0} — User’s Guide', name);
  $('document-title').textContent = title;
  $('document-frame').title = manualLabel(model, getLanguage()) || tr('User’s Guide');
  document.title = title + ' · Pocket Word';
  $('original-pdf').href = manualSourceURL(model, getLanguage());
  $('original-pdf').removeAttribute('aria-disabled');
  if (file === opened) {
    const article = $('document-frame').contentDocument?.querySelector('article[data-pages]');
    if (article) $('document-status').textContent = tr('{0} pages', article.dataset.pages);
    if ($('document-contents').options.length) $('document-contents').options[0].textContent = tr('Contents');
    $('document-loading').textContent = tr('Opening document…');
    return;
  }
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
  if (doc.documentElement.lang !== manualLanguage(model, getLanguage())) return;
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
