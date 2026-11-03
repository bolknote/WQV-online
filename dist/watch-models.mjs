// WQV-3 and WQV-10 share the colour-camera PC protocol. Calendar payloads differ.
export const WATCH_MODELS = Object.freeze({
  wqv2: Object.freeze({ id: 'wqv2', number: 2, name: 'WQV-1/2', module: 2220,
    application: './wqv2.html', album: 'casio-wqv2-webusb' }),
  wqv3: Object.freeze({ id: 'wqv3', number: 3, name: 'WQV-3', module: 2411,
    application: './wqv3.html', album: 'casio-wqv-webusb', calendarBytes: 1840, colourCalendar: false }),
  wqv10: Object.freeze({ id: 'wqv10', number: 10, name: 'WQV-10', module: 2412,
    application: './wqv3.html?model=wqv10', album: 'casio-wqv10-webusb', calendarBytes: 7305, colourCalendar: true }),
});
export function watchModel(value, fallback = 'wqv3') {
  return Object.hasOwn(WATCH_MODELS, value) ? WATCH_MODELS[value] : WATCH_MODELS[fallback];
}
export function colourWatchModel(value) {
  return watchModel(value === 'wqv10' ? value : 'wqv3');
}
