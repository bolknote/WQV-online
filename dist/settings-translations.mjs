const rows = {
  'Settings': ['Настройки', '設定', 'Einstellungen', 'Configuración', 'Asetukset'],
  'Language': ['Язык', '言語', 'Sprache', 'Idioma', 'Kieli'],
  'Calendar display': ['Вид календаря', 'カレンダー表示', 'Kalenderanzeige', 'Vista del calendario', 'Kalenterin näkymä'],
  'First day of week': ['Первый день недели', '週の最初の曜日', 'Erster Wochentag', 'Primer día de la semana', 'Viikon ensimmäinen päivä'],
  'Monday': ['Понедельник', '月曜日', 'Montag', 'Lunes', 'Maanantai'],
  'Sunday': ['Воскресенье', '日曜日', 'Sonntag', 'Domingo', 'Sunnuntai'],
  'Back': ['Назад', '戻る', 'Zurück', 'Atrás', 'Takaisin'],
  'Close': ['Закрыть', '閉じる', 'Schließen', 'Cerrar', 'Sulje'],
  'Calendar preview': ['Порядок дней недели', '曜日の並び', 'Reihenfolge der Wochentage', 'Orden de los días', 'Viikonpäivien järjestys'],
  'Use Settings to change the language and the first day of week.': ['В «Настройках» можно выбрать язык и первый день недели.', '「設定」で言語と週の最初の曜日を変更できます。', 'Unter Einstellungen lassen sich Sprache und erster Wochentag ändern.', 'En Configuración puede cambiar el idioma y el primer día de la semana.', 'Asetuksissa voit vaihtaa kielen ja viikon ensimmäisen päivän.'],
};
const offsets = { ru: 0, ja: 1, de: 2, es: 3, fi: 4 };
export const settingsDictionary = language => Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[offsets[language]]]));
