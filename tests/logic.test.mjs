import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

// Monday 2026-11-23 local; todayIdx 0 = Monday
const mon = h => { const d = new Date(2026, 10, 23); d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0); return d };

test('headcount = enrolled minus opt-outs, never negative', () => {
  assert.equal(L.headcount(50, 15), 35);
  assert.equal(L.headcount(50, 80), 0);
  assert.equal(L.headcount(50, -3), 50);
});
test('raw material scaling uses 1.05 safety margin', () => {
  assert.equal(+L.rawKg(50, 80).toFixed(2), 4.2);
  assert.equal(+L.rawKg(35, 80).toFixed(2), 2.94);
});
test('cutoff: dinner (20:00) closes at 14:00 same day', () => {
  assert.equal(L.cutoffInfo(mon(13.9), 0, 0, 20).open, true);
  assert.equal(L.cutoffInfo(mon(14), 0, 0, 20).open, true);   // exactly 6h left
  assert.equal(L.cutoffInfo(mon(14.1), 0, 0, 20).open, false);
});
test('cutoff: a meal already started rolls to next week and is open', () => {
  const c = L.cutoffInfo(mon(21), 0, 0, 20);
  assert.equal(c.open, true);
  assert.equal(c.t.getDate(), 30);
});
test('cutoff: breakfast 08:00 is locked from 02:00 same morning', () => {
  assert.equal(L.cutoffInfo(mon(3), 0, 0, 8).open, false);
  assert.equal(L.cutoffInfo(mon(21), 0, 1, 8).open, true);
});
test('esc neutralises HTML/script injection', () => {
  assert.equal(L.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(L.esc(`"'&`), '&quot;&#39;&amp;');
  assert.equal(L.esc(null), '');
});
test('parseKg validates range and type', () => {
  assert.equal(L.parseKg('2.26').value, 2.3);
  assert.equal(L.parseKg('').value, 0);
  assert.equal(L.parseKg('-1').ok, false);
  assert.equal(L.parseKg('abc').ok, false);
  assert.equal(L.parseKg('501').ok, false);
});
test('cleanComment trims, collapses whitespace and caps length', () => {
  assert.equal(L.cleanComment('  less   salt ').text, 'less salt');
  assert.equal(L.cleanComment('x'.repeat(281)).ok, false);
});
test('NGO beacon fires only above 15 kg', () => {
  assert.equal(L.shouldFireBeacon(15), false);
  assert.equal(L.shouldFireBeacon(15.5), true);
});
test('savings maths', () => assert.deepEqual(L.savings(15), { money: 240, wasteKg: 5 }));
test('hsh is deterministic', () => assert.equal(L.hsh('a'), L.hsh('a')));

test('isMealRef accepts only real menu slots', () => {
  assert.equal(L.isMealRef(0, 'lunch'), true);
  assert.equal(L.isMealRef(7, 'lunch'), false);
  assert.equal(L.isMealRef(0, 'brunch'), false);
  assert.equal(L.isMealRef('0', 'lunch'), false);
  assert.equal(L.isMealRef(0, '__proto__'), false);
});
test('parseClock accepts only HH:MM', () => {
  assert.deepEqual(L.parseClock('09:05'), { h: 9, m: 5 });
  for (const bad of ['24:00', '9:05', '12:60', '', null, 'noon']) assert.equal(L.parseClock(bad), null);
});
test('campusClock returns the same wall time regardless of the host timezone', () => {
  const instant = new Date('2026-11-23T06:30:00Z');       // 12:00 Monday in Kolkata
  const c = L.campusClock(instant, 'Asia/Kolkata');
  assert.equal(c.dayIdx, 0);
  assert.equal(L.wallToString(c.wall), '2026-11-23T12:00:00');
  assert.equal(L.wallToString(L.campusClock(instant, 'America/New_York').wall), '2026-11-23T01:30:00');
});
test('wall string round-trips and rejects junk', () => {
  const d = new Date(2026, 10, 23, 14, 5, 9);
  assert.equal(L.wallFromString(L.wallToString(d)).getTime(), d.getTime());
  assert.equal(L.wallFromString('nope'), null);
});
test('baseOut keeps tomorrow-dinner clean and others in 1..6', () => {
  assert.equal(L.baseOut(3, 'dinner', 3), 0);
  for (let d = 0; d < 7; d++) for (const m of ['breakfast', 'lunch', 'snack']) { const v = L.baseOut(d, m, 3); assert.ok(v >= 1 && v <= 6) }
});
test('forecastNext fits a straight line exactly', () => {
  const f = L.forecastNext([10, 12, 14, 16]);
  assert.equal(f.next, 18); assert.equal(f.slope, 2); assert.equal(f.r2, 1);
});
test('forecastNext clamps to range and handles tiny input', () => {
  assert.equal(L.forecastNext([10, 8, 6, 4, 2, 0], 100).next, 0);
  assert.equal(L.forecastNext([5, 6, 7], 6).next, 6);
  assert.equal(L.forecastNext([7]).next, 7);
  assert.equal(L.forecastNext([4, 4, 4]).r2, 1);
});
test('rescueImpact converts kg to meals and CO2e', () => assert.deepEqual(L.rescueImpact(20), { meals: 50, co2Kg: 50 }));
test('csvCell quotes and neutralises formula injection', () => {
  assert.equal(L.csvCell('a,b'), '"a,b"');
  assert.equal(L.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(L.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(L.csvCell('+1'), "'+1");
  assert.equal(L.csvCell(null), '');
});
