import { ENR, PER_MEAL_COST, hsh, REBATE, esc, parseKg, cleanComment, cutoffInfo as coreCutoff, fmtLeft, headcount as coreHead, rawKg, savings, forecastNext, wallFromString } from './logic.js';
import { MEALS, DAYS, MENU, HIST_WASTE, HIST_SKIPS, ALL_DISHES, POLL, RAW } from './data.js';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const toastEl = $('#toast'); let tt;
function toast(m) { toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => toastEl.classList.remove('on'), 3200) }
const K = (d, m) => d + '-' + m;
const pad = n => String(n).padStart(2, '0');

/* ---------- API client: the server owns all state, rules and the clock ---------- */
const TOKEN_KEY = 'messmeter_token';
const getToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null } };
const setToken = t => { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY) } catch { /* private mode */ } };
class ApiError extends Error { constructor(status, message) { super(message); this.status = status } }
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(getToken() ? { Authorization: 'Bearer ' + getToken() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { setStatus(false); throw new ApiError(0, 'Cannot reach the server. Check your connection.') }
  setStatus(true);
  if (r.status === 401 && url !== '/api/login') { signOut(); throw new ApiError(401, 'Please sign in again.') }
  const type = r.headers.get('content-type') || '';
  const data = type.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new ApiError(r.status, data.error || 'Request failed');
  return data;
}
function setStatus(ok) { const el = $('#storageStatus'); el.textContent = ok ? '● Connected · SQLite' : '● Offline: retrying'; el.classList.toggle('connected', ok) }

/* ---------- state ---------- */
let S = null, clockBase = null, todayIdx = 0, tmrIdx = 1, focus = { day: 1, meal: 'dinner' }, menuDay = 1, firstLoad = true;
function applyState(st) {
  S = st; todayIdx = st.clock.dayIdx; tmrIdx = (todayIdx + 1) % 7;
  clockBase = { wall: wallFromString(st.clock.wall), at: performance.now(), frozen: st.clock.demo };
  document.body.dataset.role = st.user.role;
  $('#userChip').hidden = false; $('#userName').textContent = `${st.user.name} (${st.user.role})`;
  $('#passName').textContent = st.user.name;
  const sup = st.user.role === 'supervisor';
  $('#clock').disabled = !(sup && st.clock.demoAvailable);
  $('#clockLabel').textContent = st.clock.demo ? '🕒 Demo clock' : '🕒 Server time';
  syncClockInput();
  if (firstLoad) { focus = { day: tmrIdx, meal: 'dinner' }; menuDay = tmrIdx; firstLoad = false; buildSelectors(); syncSelectors(); renderTabs(); renderPoll() }
}
/** Current campus time: the server's wall clock plus time elapsed since it was fetched (frozen in demo mode). */
const simNow = () => clockBase.frozen ? new Date(clockBase.wall) : new Date(clockBase.wall.getTime() + (performance.now() - clockBase.at));
function syncClockInput() { const d = simNow(); if (document.activeElement !== $('#clock')) $('#clock').value = `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const cutoffInfo = (d, mid) => coreCutoff(simNow(), todayIdx, d, MEALS.find(x => x.id === mid).start);
const optCount = (d, mid) => S.optCounts[K(d, mid)] || 0;
const headcount = (d, mid) => coreHead(ENR, optCount(d, mid));
const isStudent = () => S?.user.role === 'student', isSup = () => S?.user.role === 'supervisor';

/** Run a server action, refresh state from its response, and surface errors as toasts. */
async function act(method, url, body) {
  try { const r = await api(method, url, body); if (r.state) { applyState(r.state); renderAll() } return r }
  catch (e) { if (e.status !== 401) toast('⛔ ' + e.message); return null }
}
async function refresh() { try { applyState(await api('GET', '/api/state')); renderAll() } catch (e) { if (e.status !== 401) console.warn(e.message) } }

/* ---------- login ---------- */
const dlg = $('#loginDlg');
function showLogin(msg = '') { $('#loginErr').textContent = msg; $('#loginPass').value = ''; if (!dlg.open) dlg.showModal(); $('#loginUser').focus() }
function signOut() { setToken(null); S = null; firstLoad = true; delete document.body.dataset.role; $('#userChip').hidden = true; showLogin() }
dlg.addEventListener('cancel', e => e.preventDefault());   // sign-in is mandatory
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('#loginBtn').disabled = true;
  try {
    const r = await api('POST', '/api/login', { username: $('#loginUser').value.trim(), password: $('#loginPass').value });
    setToken(r.token); dlg.close(); await refresh(); toast(`Welcome, ${r.user.name} 👋`);
  } catch (err) { $('#loginErr').textContent = err.message; $('#loginPass').select() }
  finally { $('#loginBtn').disabled = false }
});
$$('#demoCreds [data-fill]').forEach(b => b.onclick = () => { const [u, p] = b.dataset.fill.split('|'); $('#loginUser').value = u; $('#loginPass').value = p; $('#loginPass').focus() });
$('#logoutBtn').onclick = signOut;

/* ---------- demo clock (supervisor only; the server decides whether to honour it) ---------- */
$('#clock').addEventListener('change', e => { if (e.target.value) act('PUT', '/api/demo-clock', { time: e.target.value }).then(r => r && toast('Demo clock set. Cutoffs now follow it for everyone.')) });
$('#clockLive').onclick = () => act('PUT', '/api/demo-clock', { time: null }).then(r => r && toast('Back to live server time'));

/* ---------- selectors synced everywhere ---------- */
function buildSelectors() {
  ['pass', 'kitchen', 'waste', 'rate'].forEach(id => {
    $('#sel-' + id).innerHTML = `<select data-f="day" aria-label="Day">${DAYS.map((n, i) => `<option value="${i}">${n}${i === tmrIdx ? ' (tomorrow)' : i === todayIdx ? ' (today)' : ''}</option>`).join('')}</select>
    <select data-f="meal" aria-label="Meal">${MEALS.map(m => `<option value="${m.id}">${m.icon} ${m.label}</option>`).join('')}</select>`;
  });
  $$('.selrow select').forEach(s => s.addEventListener('change', () => {
    const f = s.dataset.f; if (f === 'day') focus.day = +s.value; else focus.meal = s.value;
    syncSelectors(); renderAll();
  }));
}
function syncSelectors() { $$('.selrow select[data-f=day]').forEach(s => s.value = focus.day); $$('.selrow select[data-f=meal]').forEach(s => s.value = focus.meal) }

/* ---------- MENU ---------- */
function renderTabs() {
  $('#dayTabs').innerHTML = DAYS.map((n, i) => `<button class="tab ${i === menuDay ? 'on' : ''} ${i === todayIdx ? 'today' : ''}" aria-pressed="${i === menuDay}" aria-label="${n}${i === todayIdx ? ' (today)' : ''}" data-i="${i}">${n.slice(0, 3)}</button>`).join('');
  $$('#dayTabs .tab').forEach(b => b.onclick = () => { menuDay = +b.dataset.i; renderTabs(); renderMenu() });
}
function renderMenu() {
  $('#mealGrid').innerHTML = MEALS.map(m => {
    const meal = MENU[menuDay][m.id], k = K(menuDay, m.id), c = cutoffInfo(menuDay, m.id), skipped = !!S.me[k];
    const hh = Math.floor(m.start), mm = (m.start % 1) * 60;
    const time = `${((hh + 11) % 12) + 1}:${pad(mm)} ${hh >= 12 ? 'PM' : 'AM'}`;
    const canAct = c.open && isStudent();
    return `<div class="card meal ${skipped ? 'skipped' : ''}" data-k="${k}">
      <div class="icon">${m.icon}</div><div class="meta">${m.label.toUpperCase()} · ${time}</div>
      <h3>${esc(meal.t)}</h3>
      <span class="badge ${meal.nv ? 'nv' : 'veg'}">${meal.nv ? '🍗 Non-Veg' : '🌿 Veg'}</span>${meal.tags.map(t => `<span class="badge tag">${esc(t)}</span>`).join('')}
      <div class="dishes">${meal.d.map(x => `<span class="dish">${esc(x)}</span>`).join('')}</div>
      <div class="cut ${c.open ? 'ok' : 'bad'}">${c.open ? `⏳ Opt-out closes in ${fmtLeft(c.left)}` : '🔒 Cutoff passed'}</div>
      <button class="btn small ${skipped ? 'alt' : ''}" data-d="${menuDay}" data-m="${m.id}" ${canAct ? '' : 'disabled'}>${!isStudent() ? 'Students only' : skipped ? '↩ Undo skip' : '✋ Skip this meal'}</button>
    </div>`
  }).join('');
  $$('#mealGrid button').forEach(b => b.onclick = async () => {
    const r = await act('POST', '/api/optout', { day: +b.dataset.d, meal: b.dataset.m });
    if (!r) return;
    toast(r.on ? `Skipped! You earn a ₹${REBATE} rebate 💰` : 'Welcome back to the table 🍽️');
    focus = { day: +b.dataset.d, meal: b.dataset.m }; syncSelectors(); renderAll();
  });
  $('#wallet').textContent = '₹' + Object.keys(S.me).length * REBATE;
}

/* ---------- PASS ---------- */
const hashBit = (k, i) => hsh(k + i) % 2;
function renderPass() {
  const k = K(focus.day, focus.meal), meal = MENU[focus.day][focus.meal], out = !!S.me[k];
  $('#passMeal').textContent = `${DAYS[focus.day]} · ${meal.t}`;
  $('#qr').innerHTML = Array.from({ length: 169 }, (_, i) => `<i class="${hashBit(k, i) ? 'f' : ''}"></i>`).join('');
  $('#passCard').classList.toggle('out', out);
  $('#passValid').textContent = out ? '⛔ Not valid: opted out' : '✅ Valid for this meal';
  $('#passValid').style.background = out ? 'var(--tomato)' : 'var(--chilli)';
}
const pc = $('#passCard');
pc.parentElement.addEventListener('mousemove', e => { if (matchMedia('(prefers-reduced-motion:reduce)').matches) return; const r = pc.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5; pc.style.transform = `rotateY(${x * 28}deg) rotateX(${-y * 28}deg)` });
pc.parentElement.addEventListener('mouseleave', () => pc.style.transform = '');

/* ---------- KITCHEN ---------- */
function tween(el, to) { const from = +el.textContent || 0, t0 = performance.now(); (function f(t) { const p = Math.min(1, (t - t0) / 500); el.textContent = Math.round(from + (to - from) * p); if (p < 1) requestAnimationFrame(f) })(t0) }
function renderKitchen() {
  const n = headcount(focus.day, focus.meal), out = ENR - n;
  tween($('#headcount'), n); $('#enrolled').textContent = ENR;
  $('#dots').innerHTML = Array.from({ length: ENR }, (_, i) => `<span class="${i < n ? '' : 'off'}">${i < n ? '🍽️' : '🚫'}</span>`).join('');
  $('#rawBody').innerHTML = RAW.map(([nm, g]) => {
    const cook = rawKg(n, g), full = rawKg(ENR, g);
    return `<tr><td>${nm}</td><td>${g} g</td><td><b>${cook.toFixed(1)} kg</b></td><td class="delta">−${(full - cook).toFixed(1)} kg</td></tr>`
  }).join('');
  const sv = savings(out); $('#saveBox').innerHTML = out ? `💸 ${out} students skipped → saving about <b>₹${sv.money}</b> and preventing roughly <b>${sv.wasteKg} kg</b> of waste.` : 'No opt-outs yet for this meal. Cooking for everyone.';
}
function renderForecast() {
  const el = $('#forecastBox'); if (!el || !isSup()) return;
  const f = forecastNext(HIST_SKIPS, ENR * MEALS.length), perMeal = Math.round(f.next / MEALS.length), plan = coreHead(ENR, perMeal);
  const [nm, g] = RAW[0], actual = headcount(focus.day, focus.meal);
  el.innerHTML = `<div class="forecast">Trend <b>${f.slope >= 0 ? '+' : ''}${f.slope} skips/day</b> (fit R² ${f.r2}). Expect about <b>${f.next}</b> skips tomorrow across all meals, ≈ <b>${perMeal}</b> per meal.<br>
    Pre-plan for <b>${plan}</b> diners: <b>${rawKg(plan, g).toFixed(1)} kg</b> ${nm.replace(/^\S+\s/, '').toLowerCase()}. Live headcount for ${esc(DAYS[focus.day])} ${esc(focus.meal)} is <b>${actual}</b> → ${rawKg(actual, g).toFixed(1)} kg.</div>`;
}
$('#simBtn').onclick = async () => { if (await act('POST', '/api/simulate', focus)) toast('15 students opted out 🎉 Headcount dropped!') };
$('#resetBtn').onclick = async () => { if (await act('POST', '/api/reset', {})) toast('Reset to a fresh mess') };

/* ---------- WASTE LOG ---------- */
function renderWasteForm() {
  const meal = MENU[focus.day][focus.meal];
  $('#wasteForm').innerHTML = meal.d.map((d, i) => `<div class="row"><label for="w${i}">${esc(d)} waste (kg)</label><input id="w${i}" type="number" inputmode="decimal" min="0" max="500" step="0.5" value="0" data-i="${i}"></div>`).join('');
}
function renderLogs() {
  $('#logList').innerHTML = S.logs.length ? S.logs.slice(0, 7).map(l => `<div class="log"><span><b>${esc(l.meal)}</b><br><small>${esc(l.items)}</small></span><b>${esc(l.total)} kg${l.surplus ? `<br><small>🚚 ${esc(l.surplus)} kg surplus</small>` : ''}</b></div>`).join('') : '<p style="color:var(--muted)">No logs yet. Save one on the left.</p>';
}
function renderNgo() {
  const el = $('#ngoList'); if (!el) return;
  el.innerHTML = S.ngoAlerts.length ? S.ngoAlerts.map(a => `<div class="ngo-entry"><span>🚚 <b>${esc(a.ngo)}</b> · ${esc(a.kg)} kg · ${esc(a.meal)}</span><small>${new Date(a.at).toLocaleString()}</small></div>`).join('') : 'No alerts yet.';
}
$('#logBtn').onclick = async () => {
  const meal = MENU[focus.day][focus.meal], ins = $$('#wasteForm input');
  const parsed = ins.map((x, i) => parseKg(x.value, meal.d[i] + ' waste')), ps = parseKg($('#surplus').value, 'Surplus');
  const bad = [...parsed, ps].find(r => !r.ok); if (bad) return toast('⛔ ' + bad.error);   // instant feedback; the server re-validates
  const r = await act('POST', '/api/logs', { ...focus, waste: parsed.map(p => p.value), surplus: ps.value });
  if (!r) return;
  const b = $('#beacon');
  if (r.beacon) { b.className = 'beacon on'; b.innerHTML = `🚨 NGO Beacon fired! ${esc(r.beacon.kg)} kg surplus → <u>${esc(r.beacon.ngo)}</u> notified for pickup.`; b.setAttribute('role', 'alert'); toast('NGO alerted for food rescue 🚚') }
  else { b.className = 'beacon'; toast('Waste logged ✅') }
  ins.forEach(x => x.value = 0); $('#surplus').value = 0;
};
$('#exportBtn').onclick = async () => {
  try {
    const blob = await api('GET', '/api/export/logs.csv'), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'messmeter-waste-logs.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast('⛔ ' + e.message) }
};

/* ---------- RATINGS ---------- */
const seedR = d => ({ a: Math.min(5, 2.3 + (hsh(d) % 28) / 10), c: 8 + hsh(d) % 15 });
function avg(d) { const s = seedR(d), x = S.ratings[d] || [0, 0]; return (s.a * s.c + x[0]) / (s.c + x[1]) }
let pending = {};
function renderRate() {
  const meal = MENU[focus.day][focus.meal];
  $('#rateList').innerHTML = `<h3 style="margin-bottom:8px">${esc(meal.t)}</h3>` + meal.d.map(d => `<div class="dishrate"><span>${esc(d)}<br><small class="meta">Avg ${avg(d).toFixed(1)} ★</small></span><span class="stars" data-d="${esc(d)}">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" class="${(pending[d] || 0) >= n ? 'on' : ''}" aria-label="Rate ${esc(d)} ${n} of 5 stars" aria-pressed="${(pending[d] || 0) >= n}" ${isStudent() ? '' : 'disabled'}>★</button>`).join('')}</span></div>`).join('');
  $$('#rateList .stars button').forEach(b => b.onclick = () => { pending[b.parentElement.dataset.d] = +b.dataset.n; renderRate() });
  $('#cmtList').innerHTML = S.comments.length ? S.comments.map(c => `<div class="cmt"><b>${esc(c.meal)}</b> ${esc(c.stars)}<br>${esc(c.text)}</div>`).join('') : '<p style="color:var(--muted)">No comments yet. Be the first.</p>';
  $('#rateBtn').disabled = !isStudent();
}
$('#rateBtn').onclick = async () => {
  const ds = Object.keys(pending); if (!ds.length) return toast('Tap some stars first ⭐');
  const cc = cleanComment($('#comment').value); if (!cc.ok) return toast('⛔ ' + cc.error);
  const meal = MENU[focus.day][focus.meal];
  const ratings = Object.fromEntries(ds.filter(d => meal.d.includes(d)).map(d => [d, pending[d]]));
  if (await act('POST', '/api/ratings', { ...focus, ratings, comment: cc.text })) { pending = {}; $('#comment').value = ''; renderRate(); toast('Thanks! The kitchen will hear it 🍳') }
};

/* ---------- POLL ---------- */
function renderPoll() {
  const tot = S.votes.reduce((a, b) => a + b, 0);
  $('#pollBox').innerHTML = POLL.map((o, i) => `<div class="opt ${S.voted === i ? 'mine' : ''}" data-i="${i}" role="button" tabindex="0" aria-pressed="${S.voted === i}"><div class="bar" style="width:${S.votes[i] / tot * 100}%"></div><span>${['🧈', '🍚', '🥘', '🍞'][i]} ${esc(o)}</span><span>${Math.round(S.votes[i] / tot * 100)}%</span></div>`).join('') + `<small class="meta">${tot} votes · ${!isStudent() ? 'Students vote here' : S.voted === null ? 'Tap to vote' : 'You voted. Thanks!'}</small>`;
  $$('.opt').forEach(el => {
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } };
    el.onclick = async () => {
      if (!isStudent()) return toast('Only students can vote 🗳️');
      if (S.voted !== null) return toast('You already voted 🗳️');
      if (await act('POST', '/api/vote', { option: +el.dataset.i })) toast('Vote counted!');
    };
  });
}

/* ---------- CHARTS ---------- */
let cW, cM, cR;
const labels = [...Array.from({ length: 14 }, (_, i) => 'D-' + (13 - i)), 'Today'];
function dishLists() { const arr = ALL_DISHES.map(d => [d, avg(d)]).sort((a, b) => b[1] - a[1]); return [...arr.slice(0, 5), ...arr.slice(-5)] }
function updateCharts() {
  const logged = S.loggedKg;
  const wData = [...HIST_WASTE, logged || null];
  let tmrSkips = 0; MEALS.forEach(m => tmrSkips += optCount(tmrIdx, m.id));
  const skips = [...HIST_SKIPS, tmrSkips];
  const first = HIST_WASTE.slice(0, 7).reduce((a, b) => a + b), second = HIST_WASTE.slice(7).reduce((a, b) => a + b);
  $('#k1').textContent = '−' + Math.round((1 - second / first) * 100) + '%';
  $('#k2').textContent = '₹' + (skips.reduce((a, b) => a + b) * PER_MEAL_COST).toLocaleString('en-IN');
  $('#k3').textContent = skips.reduce((a, b) => a + b);
  $('#k4').textContent = (ALL_DISHES.reduce((a, d) => a + avg(d), 0) / ALL_DISHES.length).toFixed(1) + ' ★';
  $('#k5').textContent = S.impact.kg + ' kg';
  $('#k5s').textContent = `Surplus rescued · ≈ ${S.impact.meals} meals · ${S.impact.co2Kg} kg CO₂e avoided`;
  if (typeof Chart === 'undefined') return;
  const dl = dishLists();
  if (!cW) {
    Chart.defaults.font.family = "'DM Sans',sans-serif"; Chart.defaults.color = '#2A1A10';
    cW = new Chart($('#cWaste'), { type: 'line', data: { labels, datasets: [{ label: 'kg wasted', data: wData, borderColor: '#D4472B', backgroundColor: '#D4472B', borderWidth: 4, tension: .3, pointRadius: 5, pointBackgroundColor: '#E9A21B', pointBorderColor: '#2A1A10', pointBorderWidth: 2, spanGaps: false }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: '#E5D6B8' } }, x: { grid: { display: false } } } } });
    cM = new Chart($('#cMoney'), { type: 'bar', data: { labels, datasets: [{ data: skips.map(x => x * PER_MEAL_COST), backgroundColor: skips.map((_, i) => i === 14 ? '#E9A21B' : '#4F7B3B'), borderColor: '#2A1A10', borderWidth: 2, borderRadius: 6 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: '#E5D6B8' } }, x: { grid: { display: false } } } } });
    cR = new Chart($('#cRate'), { type: 'bar', data: { labels: dl.map(x => x[0]), datasets: [{ data: dl.map(x => +x[1].toFixed(2)), backgroundColor: dl.map((_, i) => i < 5 ? '#4F7B3B' : '#D4472B'), borderColor: '#2A1A10', borderWidth: 2, borderRadius: 6 }] }, options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { min: 0, max: 5, grid: { color: '#E5D6B8' } }, y: { grid: { display: false } } } } });
  } else {
    cW.data.datasets[0].data = wData; cW.update();
    cM.data.datasets[0].data = skips.map(x => x * PER_MEAL_COST); cM.update();
    cR.data.labels = dl.map(x => x[0]); cR.data.datasets[0].data = dl.map(x => +x[1].toFixed(2)); cR.update();
  }
}

function renderAudit() { const el = $('#auditList'); if (!el) return; el.innerHTML = S.audit.length ? S.audit.slice(0, 6).map(a => `<div class="audit-entry"><span><b>${esc(a.action)}</b> · ${esc(a.actor)} · ${esc(a.details)}</span><small>${new Date(a.at).toLocaleString()}</small></div>`).join('') : '<p>No actions recorded yet.</p>' }

/* ---------- master render ---------- */
function renderAll() {
  if (!S) return;
  for (const f of [renderMenu, renderPass, renderKitchen, renderForecast, renderWasteForm, renderLogs, renderNgo, renderRate, renderPoll, updateCharts, renderAudit]) {
    try { f() } catch (e) { console.error(f.name, e); toast('⚠️ Something went wrong updating the page. Please refresh.') }
  }
}
addEventListener('error', e => { console.error(e.error || e.message) });
addEventListener('unhandledrejection', e => { console.error(e.reason) });

/* ---------- 3D scroll ---------- */
const plate = $('#plate'); let mx = 0, my = 0;
window.addEventListener('mousemove', e => { mx = (e.clientX / innerWidth - .5) * 20; my = (e.clientY / innerHeight - .5) * 14 });
function onScroll() {
  const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
  $('#progress').style.width = (y / max * 100) + '%';
  const p = Math.min(1, y / (innerHeight * .9));
  plate.style.setProperty('--rx', (58 - p * 38 + my) + 'deg');
  plate.style.setProperty('--rz', (-20 + p * 160 + mx) + 'deg');
  plate.style.setProperty('--lift', (20 + p * 90) + 'px');
  const vh = innerHeight, calm = matchMedia('(prefers-reduced-motion:reduce)').matches;
  $$('.rev').forEach(el => {
    if (calm) { el.style.transform = 'none'; return }
    const r = el.getBoundingClientRect();
    let q = Math.min(1, Math.max(0, (vh - r.top) / (vh * .55))); q = q * q * (3 - 2 * q);
    if (q >= .995) { el.style.transform = 'none'; el.style.opacity = 1; return }
    const dir = +(el.dataset.dir || 0);
    el.style.transform = `perspective(1000px) rotateX(${(1 - q) * 32}deg) rotateY(${dir * (1 - q) * 30}deg) translateY(${(1 - q) * 60}px) scale(${.9 + .1 * q})`;
    el.style.opacity = .2 + .8 * q;
  });
}
let tick = false;
addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(() => { onScroll(); tick = false }) } }, { passive: true });
addEventListener('resize', onScroll);

/* ---------- boot ---------- */
try { const h = await api('GET', '/api/health'); $('#demoCreds').hidden = !h.demo } catch { /* status badge already shows offline */ }
if (getToken()) { try { applyState(await api('GET', '/api/state')); renderAll() } catch { /* 401 already opened the login dialog */ } } else showLogin();
if (!S && !dlg.open) showLogin();
setInterval(() => { if (!S) return; syncClockInput(); renderMenu() }, 30_000);          // live cutoff countdowns
setInterval(() => { if (S && !document.hidden) refresh() }, 60_000);                    // pick up other users' changes
onScroll();
