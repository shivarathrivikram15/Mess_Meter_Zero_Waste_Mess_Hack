/* Pure business logic: no DOM, no storage, no globals. Shared by server and browser, fully unit-testable. */
import { MEAL_IDS, MENU } from './data.js';

export const ENR = 50, SAFETY = 1.05, PER_MEAL_COST = 16, REBATE = 30, WASTE_PER_PLATE = 0.33;
export const CUTOFF_HOURS = 6, SURPLUS_BEACON_KG = 15, MAX_KG = 500, MAX_COMMENT = 280;
/* Impact assumptions (documented in README): one rescued plate is ~0.4 kg of food, ~2.5 kg CO2e per kg of food wasted. */
export const KG_PER_MEAL = 0.4, CO2_PER_KG = 2.5;

export const hsh = s => { let x = 7; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x };

/** Escape any user-supplied text before it reaches innerHTML. */
export const esc = s => String(s ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

/** Parse a numeric form value into a safe range; returns {ok, value, error}. */
export function parseKg(raw, label = 'Value', max = MAX_KG) {
  const v = Number(raw === '' || raw == null ? 0 : raw);
  if (!Number.isFinite(v)) return { ok: false, value: 0, error: `${label} must be a number.` };
  if (v < 0) return { ok: false, value: 0, error: `${label} cannot be negative.` };
  if (v > max) return { ok: false, value: 0, error: `${label} cannot exceed ${max} kg.` };
  return { ok: true, value: Math.round(v * 10) / 10 };
}

export function cleanComment(raw) {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_COMMENT) return { ok: false, text: '', error: `Keep comments under ${MAX_COMMENT} characters.` };
  return { ok: true, text: t };
}

/** Validate a (day, meal) reference. Used by the API for every request that names a meal. */
export const isMealRef = (day, meal) => Number.isInteger(day) && day >= 0 && day <= 6 && typeof meal === 'string' && MEAL_IDS.includes(meal) && !!MENU[day]?.[meal];

/** "HH:MM" -> {h, m} or null. */
export function parseClock(s) {
  const mt = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ''));
  return mt ? { h: +mt[1], m: +mt[2] } : null;
}

/**
 * Wall-clock time in the campus timezone as a "naive" Date (its local fields hold the campus clock),
 * so the same cutoff maths gives identical results on a UTC server and an IST browser.
 */
export function campusClock(instant = new Date(), tz = 'Asia/Kolkata') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(instant).map(p => [p.type, p.value]));
  const wall = new Date(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second, 0);
  const dayIdx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  return { wall, dayIdx };
}

/** Serialise / parse a naive wall-clock Date as 'YYYY-MM-DDTHH:MM:SS' (no timezone suffix, on purpose). */
export const wallToString = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
export function wallFromString(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)$/.exec(String(s));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Next occurrence of a meal (dayIdx 0=Mon) after `now`, given today's index. */
export function mealWhen(now, todayIdx, dayIdx, startHour) {
  const t = new Date(now);
  t.setDate(t.getDate() + ((dayIdx - todayIdx + 7) % 7));
  t.setHours(Math.floor(startHour), (startHour % 1) * 60, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 7);
  return t;
}

/** 6-hour opt-out rule. `left` is ms until cutoff; open when it has not passed. */
export function cutoffInfo(now, todayIdx, dayIdx, startHour) {
  const t = mealWhen(now, todayIdx, dayIdx, startHour);
  const cut = new Date(t.getTime() - CUTOFF_HOURS * 3600e3), left = cut - now;
  return { t, cut, left, open: left >= 0 };
}

export const fmtLeft = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return Math.floor(m / 60) + 'h ' + m % 60 + 'm' };

export const headcount = (enrolled, optOuts) => Math.max(0, enrolled - Math.max(0, optOuts));

/** Raw material to cook (kg) = headcount x grams-per-student x safety margin. */
export const rawKg = (heads, gramsPerStudent) => heads * gramsPerStudent * SAFETY / 1000;

export const savings = optOuts => ({ money: optOuts * PER_MEAL_COST, wasteKg: +(optOuts * WASTE_PER_PLATE).toFixed(1) });

export const shouldFireBeacon = surplusKg => surplusKg > SURPLUS_BEACON_KG;

/** Seeded baseline of opt-outs for a meal (demo data). Tomorrow's dinner starts clean for the live demo. */
export const baseOut = (day, meal, tomorrowIdx) => (day === tomorrowIdx && meal === 'dinner') ? 0 : (hsh(day + '-' + meal) % 6) + 1;

/** Impact of rescued surplus food. */
export const rescueImpact = kg => ({ meals: Math.floor(kg / KG_PER_MEAL), co2Kg: +(kg * CO2_PER_KG).toFixed(1) });

/**
 * Least-squares linear trend over a daily series; predicts the next value.
 * Returns {slope, next, r2}. `next` is clamped to [0, max].
 */
export function forecastNext(series, max = Infinity) {
  const n = series.length;
  if (n < 2) return { slope: 0, next: Math.min(max, Math.max(0, series[0] ?? 0)), r2: 0 };
  const xs = series.map((_, i) => i), mx = (n - 1) / 2, my = series.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  series.forEach((y, i) => { sxy += (xs[i] - mx) * (y - my); sxx += (xs[i] - mx) ** 2; syy += (y - my) ** 2 });
  const slope = sxy / sxx, icpt = my - slope * mx;
  return { slope: +slope.toFixed(3), next: Math.min(max, Math.max(0, Math.round(icpt + slope * n))), r2: syy ? +((sxy * sxy) / (sxx * syy)).toFixed(3) : 1 };
}

/** Neutralise spreadsheet formula injection when exporting user-influenced text to CSV. */
export function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
