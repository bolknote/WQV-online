import { localeDefinitions } from './locales.mjs';

const printEditions = Object.freeze({
  fr: { title: 'Mode d’emploi' },
  it: { title: 'Guida dell’utilizzatore' },
  sv: { title: 'Instruktionshäfte' },
  nl: { title: 'Gebruiksaanwijzing' },
  pt: { title: 'Guia do usuário' },
  ko: { title: '사용설명서' },
  'zh-Hant': { title: '用戶說明書' },
  ar: { title: 'دليل المستخدم' },
});

// Only use an edition whose original has been found and adapted.
const editions = {
  wqv2: ['en', 'ru', 'ja', 'de', 'es', ...Object.keys(printEditions)],
  wqv3: ['en', 'ru', 'ja', 'es', 'fi'],
  wqv10: ['en', 'ru', 'ja', 'de'],
};
export function manualLanguage(model, language) {
  return Object.hasOwn(editions, model) && editions[model].includes(language) ? language : 'en';
}
export function manualLabel(model, language) {
  if (manualLanguage(model, language) !== language) return 'User’s Guide';
  return Object.hasOwn(printEditions, language) ? printEditions[language].title : null;
}
export function manualLanguageChoices(model) {
  if (model !== 'wqv2') return [];
  return editions.wqv2.map(code => ({
    code,
    name: localeDefinitions[code].name,
  }));
}
export function manualSourceURL(model, language) {
  const edition = manualLanguage(model, language);
  if (Object.hasOwn(printEditions, edition)) return null;
  if (edition === 'es') return model === 'wqv3'
    ? 'https://www.baroli.es/wp-content/uploads/2015/12/2411.pdf'
    : 'https://web.archive.org/web/20120629191015/http://www.baroli.es/manuales/2220.pdf';
  if (edition === 'fi') return 'https://www.perkko.fi/wp-content/uploads/simple-file-list/Casio-2411.pdf';
  const module = String({ wqv2: 2220, wqv3: 2411, wqv10: 2412 }[model]);
  return edition === 'ru'
    ? `https://i-watch.ru/image/catalog/info/instruktsii/casio/${module}.pdf`
    : `https://www.casio.com/content/dam/casio/global/support/manuals/watches/pdf/${module.slice(0, 2)}/${module}/qw${module}_${edition.toUpperCase()}.pdf`;
}
