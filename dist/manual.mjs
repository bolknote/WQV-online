import { tr, getLanguage } from './i18n.mjs';
import { installDesktopShell, messageDialog } from './desktop-shell.mjs';
import { bindApplicationNavigation } from './application-navigation.mjs';
import { watchModel } from './watch-models.mjs';
import { manualLanguage, manualLabel, manualLanguageChoices, manualSourceURL } from './manual-editions.mjs';

const $ = id => document.getElementById(id);
const address = new URL(location.href);
const profile = watchModel(address.searchParams.get('model'));
const model = profile.id, name = profile.name;
const languageSelect = $('document-language');
const languageChoices = manualLanguageChoices(model);
for (const { code, name } of languageChoices) {
  const option = new Option(name, code);
  option.lang = code;
  languageSelect.add(option);
}
$('document-language-picker').hidden = languageChoices.length === 0;
const requestedEdition = address.searchParams.get('edition');
if (languageChoices.some(choice => choice.code === requestedEdition)) languageSelect.value = requestedEdition;
const preferredLanguage = () => languageSelect.value || getLanguage();
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
function setDocumentTitle(title) {
  const text = String(title);
  const prefix = name + ' — ';
  $('document-title').textContent = text;
  $('document-frame').title = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  document.title = text + ' · Pocket Word';
}
function showDocument() {
  const language = manualLanguage(model, preferredLanguage());
  const file = model + '-' + language + '.html';
  const label = manualLabel(model, preferredLanguage());
  const title = label ? name + ' — ' + label : tr('{0} — User’s Guide', name);
  const loadedTitle = file === opened && $('document-loading').hidden
    ? $('document-frame').contentDocument?.title
    : null;
  setDocumentTitle(loadedTitle || title);
  const original = $('original-pdf');
  const sourceURL = manualSourceURL(model, preferredLanguage());
  original.hidden = !sourceURL;
  if (sourceURL) {
    original.href = sourceURL;
    original.removeAttribute('aria-disabled');
  } else {
    original.removeAttribute('href');
    original.setAttribute('aria-disabled', 'true');
  }
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
  if (doc.documentElement.lang !== manualLanguage(model, preferredLanguage())) return;
  setDocumentTitle(doc.title);
  $('document-loading').hidden = true;
  $('document-status').textContent = tr('{0} pages', article.dataset.pages);
  const placeholder = new Option(String(tr('Contents')), '');
  const headings = [...doc.querySelectorAll('h2[id], h3[id]')];
  $('document-contents').replaceChildren(placeholder, ...headings.map(heading => new Option(heading.textContent, heading.id)));
  $('document-contents').disabled = headings.length === 0;
  applySize();
  followContents(doc, headings);
});
languageSelect.addEventListener('change', () => {
  if (languageSelect.value) address.searchParams.set('edition', languageSelect.value);
  else address.searchParams.delete('edition');
  history.replaceState(history.state, '', address);
  showDocument();
});
$('document-size').addEventListener('change', applySize);
$('document-contents').addEventListener('change', event => {
  const heading = $('document-frame').contentDocument?.getElementById(event.target.value);
  heading?.scrollIntoView({ block: 'start' });
  updateContents();
});
installDesktopShell({ changed: showDocument, help: () => messageDialog('Pocket Word · WQV Link',
  tr('Open a manual from Programs. Choose the display language in Settings. The WQV-1/2 reader can also switch editions directly.')) });
bindApplicationNavigation();
