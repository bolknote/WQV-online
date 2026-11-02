// An English guide remains English when no German edition has been found.
export function manualLanguage(model, language) {
  return model === 'wqv3' && language === 'de' ? 'en' : language;
}
export function manualLabel(model, language) {
  return model === 'wqv3' && language === 'de' ? 'User’s Guide' : null;
}
