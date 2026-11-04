// Only use an edition whose original has been found and adapted.
const editions = {
  wqv2: ['en', 'ru', 'ja', 'de', 'es'],
  wqv3: ['en', 'ru', 'ja', 'fi'],
  wqv10: ['en', 'ru', 'ja', 'de'],
};
export function manualLanguage(model, language) {
  return Object.hasOwn(editions, model) && editions[model].includes(language) ? language : 'en';
}
export function manualLabel(model, language) {
  return manualLanguage(model, language) !== language ? 'User’s Guide' : null;
}
export function manualSourceURL(model, language) {
  const edition = manualLanguage(model, language);
  if (edition === 'es') return 'https://web.archive.org/web/20120629191015/http://www.baroli.es/manuales/2220.pdf';
  if (edition === 'fi') return 'https://www.perkko.fi/wp-content/uploads/simple-file-list/Casio-2411.pdf';
  const module = String({ wqv2: 2220, wqv3: 2411, wqv10: 2412 }[model]);
  return edition === 'ru'
    ? `https://i-watch.ru/image/catalog/info/instruktsii/casio/${module}.pdf`
    : `https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/${module.slice(0, 2)}/${module}/qw${module}_${edition.toUpperCase()}.pdf`;
}
