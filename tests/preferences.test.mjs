import test from 'node:test';
import assert from 'node:assert/strict';
import { readWeekStart, getWeekStart, setWeekStart, onWeekStartChange, WEEK_START_KEY, weekdayOrder, monthOffset } from '../dist/preferences.mjs';
import { HolidayCalendar, ColourCalendar } from '../dist/calendar.mjs';
import { bindApplicationNavigation } from '../dist/application-navigation.mjs';

test('week starts on Monday by default and accepts only an explicit Sunday preference', () => {
  for (const value of [null, 'invalid', '0']) assert.equal(readWeekStart({ getItem: () => value }), 'mon');
  assert.equal(readWeekStart({ getItem: () => 'sun' }), 'sun');
  assert.equal(readWeekStart({ getItem() { throw Error('blocked'); } }), 'mon');
});
test('week preference persists independently and notifies once; blocked storage still permits a change', () => {
  const values = new Map(), changes = [], storage = { setItem: (key,value) => values.set(key,value), getItem: key => values.get(key) };
  setWeekStart('mon', { storage });
  const stop = onWeekStartChange(value => changes.push(value));
  setWeekStart('sun', { storage }); setWeekStart('sun', { storage });
  assert.equal(values.get(WEEK_START_KEY), 'sun'); assert.deepEqual(changes, ['sun']);
  assert.equal(getWeekStart(), 'sun');
  setWeekStart('mon', { storage: { setItem() { throw Error('blocked'); } } });
  assert.equal(getWeekStart(), 'mon'); assert.deepEqual(changes, ['sun','mon']); stop();
  assert.throws(() => setWeekStart('sat'), RangeError);
});
test('week ordering moves columns and month offsets, preserving every calendar date and raw flag', () => {
  assert.deepEqual(weekdayOrder('mon'), [1,2,3,4,5,6,0]); assert.deepEqual(weekdayOrder('sun'), [0,1,2,3,4,5,6]);
  // March 2026 begins on Sunday; February 2024 begins on Thursday.
  assert.equal(monthOffset(2026,3,'mon'), 6); assert.equal(monthOffset(2026,3,'sun'), 0);
  assert.equal(monthOffset(2024,2,'mon'), 3); assert.equal(monthOffset(2024,2,'sun'), 4);
  for (const calendar of [new HolidayCalendar(), new ColourCalendar()]) {
    calendar.set(2024,2,29,1); calendar.set(2026,3,1,1);
    const original = calendar.raw.slice();
    for (const start of ['mon','sun']) for (let day=1; day<=29; day++) {
      const cell = monthOffset(2024,2,start)+day-1;
      assert.equal(weekdayOrder(start)[cell%7], new Date(Date.UTC(2024,1,day)).getUTCDay());
    }
    assert.deepEqual(calendar.raw, original); assert.equal(Boolean(calendar.get(2024,2,29)), true);
  }
});
test('a driver link added by Settings after initialization still releases the owning application', async () => {
  let click, busy = true; const links=[], actions=[];
  const root={querySelectorAll:()=>links,addEventListener(type,handler){click=handler;}};
  const update=bindApplicationNavigation({root,isBusy:()=>busy,close:async()=>actions.push('released'),navigate:href=>actions.push(href)});
  const link={href:'drivers.html',setAttribute(){}};links.push(link);update();
  const event={button:0,target:{closest:()=>link},preventDefault(){}};
  await click(event);assert.deepEqual(actions,[]);
  busy=false;await click(event);assert.deepEqual(actions,['released','drivers.html']);
});
