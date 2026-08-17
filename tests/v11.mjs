/* Validate v11: the three-view restructure.
     - Follow Matches: whole day dimmed, star to light up, independent of players
     - Follow Players: Schedule / Players sub-tabs, independent of stars
     - Draw: one tree, one camera, four modes
     - old links still land somewhere sensible */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8802, DBG = 9374;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise(r => server.listen(PORT, r));

const profile = path.join(process.env.TEMP, 'wc26-v11-' + Date.now());
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1600,1100',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`, 'about:blank']);
chrome.stderr.on('data', () => {});
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await new Promise(r => setTimeout(r, 400));
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let fx = null;
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', e2 => {
  const m = JSON.parse(e2.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method) { events.push(m); if (fx) fx.handle(m); }
});
const send = (method, params = {}, sessionId) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Log.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
fx = await installFixtures(send, sessionId, { quiet: true });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||'') };
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const key = async (k, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await wait(700);
};
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  wrote', name);
};

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

await send('Page.navigate', { url: `http://localhost:${PORT}/` }, sessionId);
await wait(12000);

console.log('=== three views ===');
const nav = await ev(`({
  tabs: [...document.querySelectorAll('.tab')].map(t => t.dataset.view),
  labels: [...document.querySelectorAll('.tab')].map(t => t.textContent),
  active: [...document.querySelectorAll('.tab.is-active')].map(t => t.dataset.view)[0],
  sections: [...document.querySelectorAll('main > section')].map(s => s.id)
})`);
console.log(' ', JSON.stringify(nav));
check('exactly three top-level views', nav.tabs.length === 3, nav.tabs.join(','));
check('named Follow Matches / Follow Players / Draw',
  nav.labels.join('|') === 'Follow Matches|Follow Players|Draw', nav.labels.join('|'));
check('opens on Follow Matches', nav.active === 'matches', nav.active);
check('no orphan sections left behind', nav.sections.join(',') === 'view-matches,view-players,view-draw',
  nav.sections.join(','));

console.log('\n=== both day bars land on today during the tournament ===');
const days = await ev(`(() => {
  const today = todayIso();
  const inWeek = TMT.dates.includes(today);
  return { today, inWeek, matchDay: state.matchDay, day: state.day,
    matchBar: [...document.querySelectorAll('#mDaybar .day.is-active')].map(b=>b.textContent)[0],
    // The timezone trap: east of Greenwich, UTC still reads as yesterday
    // between local midnight and UTC midnight.
    localMidnight: todayIso(new Date('2026-08-17T00:30:00+02:00')),
    utcWouldSay: new Date('2026-08-17T00:30:00+02:00').toISOString().slice(0, 10),
    // …and outside the week neither bar should pin a day it invented.
    outside: (() => {
      const d = new Date('2026-09-01T12:00:00');
      return TMT.dates.includes(todayIso(d));
    })() };
})()`);
console.log(' ', JSON.stringify(days));
check('today really is a tournament day (so this is a live check)', days.inWeek === true, days.today);
check('Follow Matches opens on today', days.matchDay === days.today, `${days.matchDay} vs ${days.today}`);
check('Follow Players → Schedule opens on today too', days.day === days.today, `${days.day} vs ${days.today}`);
check('and the day bar shows it selected',
  new RegExp(String(Number(days.today.slice(8, 10)))).test(days.matchBar || ''),
  `${days.matchBar} for ${days.today}`);
check('local midnight resolves to the local day, not the UTC one',
  days.localMidnight === '2026-08-17' && days.utcWouldSay === '2026-08-16',
  `local ${days.localMidnight}, UTC would say ${days.utcWouldSay}`);
check('a date outside the week is not treated as a tournament day', days.outside === false);

console.log('\n=== Follow Matches: the day, dimmed ===');
// Auto-selection is tested above; from here the suite pins day one explicitly.
// Letting it follow "today" turned every count below into a test of how far the
// tournament has got — 64 first-round matches on the 17th, 16 on the 18th — and
// the court grid vanishes on days whose order of play the fixtures predate.
await ev(`(() => { state.matchDay = TMT.dates[0];
  renderDaybar('#mDaybar', state.matchDay, pickMatchDay); renderMatches(); })()`);
const day1 = await ev(`({
  day: state.matchDay,
  activeDay: [...document.querySelectorAll('#mDaybar .day.is-active')].map(b=>b.textContent)[0],
  cards: document.querySelectorAll('#matchesList .match').length,
  dim: document.querySelectorAll('#matchesList .match.is-dim').length,
  starred: document.querySelectorAll('#matchesList .match.is-starred').length,
  grid: document.querySelectorAll('#matchesList .oop-grid').length,
  courts: document.querySelectorAll('#matchesList .oop-head').length,
  h2hButtons: document.querySelectorAll('#matchesList .h2h-btn').length,
  count: document.querySelector('#starCount').textContent
})`);
console.log(' ', JSON.stringify(day1));
check('opens on a single day, not all 267 fixtures', day1.day !== 'all', String(day1.day));
check('the whole day is on screen', day1.cards === 64, String(day1.cards));
check('laid out by court', day1.grid === 1 && day1.courts === 4, `${day1.grid} grid, ${day1.courts} courts`);
check('everything starts dimmed', day1.dim === 64 && day1.starred === 0, `${day1.dim} dim, ${day1.starred} lit`);
check('head-to-head moved to its own button', day1.h2hButtons > 0, String(day1.h2hButtons));
check('the counter says nothing is starred', /Nothing starred/.test(day1.count), day1.count);
await shot('v11-matches-dim.png');

console.log('\n=== starring lights a match up ===');
const star = await ev(`(() => {
  const cards = [...document.querySelectorAll('#matchesList .match')];
  const target = cards[6];
  const before = target.className;
  target.click();
  const after = [...document.querySelectorAll('#matchesList .match')][6];
  return { before, after: after.className,
    glyph: after.querySelector('.star').textContent,
    lit: document.querySelectorAll('#matchesList .match.is-starred').length,
    dim: document.querySelectorAll('#matchesList .match.is-dim').length,
    stored: JSON.parse(localStorage.getItem('wc26.starred')||'[]').length,
    count: document.querySelector('#starCount').textContent,
    dayHead: document.querySelector('.daygroup-head span').textContent };
})()`);
console.log(' ', JSON.stringify(star));
check('the card stops being dimmed', /is-dim/.test(star.before) && !/is-dim/.test(star.after), star.after);
check('and is marked starred', /is-starred/.test(star.after), star.after);
check('the star fills in', star.glyph === '★', star.glyph);
check('exactly one lit, the rest still dim', star.lit === 1 && star.dim === 63, `${star.lit}/${star.dim}`);
check('persisted', star.stored === 1, String(star.stored));
check('counter updates', /1 starred/.test(star.count), star.count);
check('the day heading counts it too', /1<\/b> starred|1 starred/.test(star.dayHead), star.dayHead);

const unstar = await ev(`(() => {
  document.querySelector('#matchesList .match.is-starred').click();
  return { lit: document.querySelectorAll('#matchesList .match.is-starred').length,
           stored: JSON.parse(localStorage.getItem('wc26.starred')||'[]').length };
})()`);
check('clicking again un-stars', unstar.lit === 0 && unstar.stored === 0, JSON.stringify(unstar));

console.log('\n=== the head-to-head button does not star the match ===');
const h2h = await ev(`(() => {
  const btn = document.querySelector('#matchesList .h2h-btn');
  btn.click();
  return { open: !document.querySelector('#h2h').hidden,
           lit: document.querySelectorAll('#matchesList .match.is-starred').length };
})()`);
await wait(4000);
check('H2H opens from its button', h2h.open, JSON.stringify(h2h));
check('and starring is not triggered by it', h2h.lit === 0, String(h2h.lit));
await ev(`document.querySelector('#closeH2h').click()`);

console.log('\n=== starred only, and clear ===');
const only = await ev(`(() => {
  const cards = [...document.querySelectorAll('#matchesList .match')];
  [0, 9, 30].forEach(i => cards[i] && cards[i].click());
  document.querySelector('#starredOnly').click();
  return { shown: document.querySelectorAll('#matchesList .match').length,
           allLit: document.querySelectorAll('#matchesList .match.is-starred').length,
           cols: document.querySelectorAll('#matchesList .oop-head').length };
})()`);
console.log(' ', JSON.stringify(only));
check('starred-only shows just those three', only.shown === 3, String(only.shown));
check('and all of them are lit', only.allLit === 3, String(only.allLit));
await shot('v11-matches-starred.png');
const cleared = await ev(`(() => {
  document.querySelector('#starredOnly').click();
  document.querySelector('#clearStars').click();
  return { lit: document.querySelectorAll('#matchesList .match.is-starred').length,
           stored: JSON.parse(localStorage.getItem('wc26.starred')||'[]').length,
           disabled: document.querySelector('#clearStars').disabled };
})()`);
check('Clear removes every star', cleared.lit === 0 && cleared.stored === 0, JSON.stringify(cleared));
check('and disables itself when there is nothing to clear', cleared.disabled === true);

console.log('\n=== Follow Matches ignores the player selection entirely ===');
const sep = await ev(`(() => {
  // Follow some players, then look at the matches view.
  const d = state.draws.ms;
  const ids = [];
  for (const e of d.entries.values()) { ids.push(...e.players.map(p => String(p.id))); if (ids.length >= 8) break; }
  state.selected = new Set(ids);
  persistSelection();
  renderAll();
  return { redNames: document.querySelectorAll('#matchesList .nm .mine').length,
           mineRails: document.querySelectorAll('#matchesList .side.is-mine').length,
           lit: document.querySelectorAll('#matchesList .match.is-starred').length,
           followed: state.selected.size };
})()`);
console.log(' ', JSON.stringify(sep));
check('following 8 players lights up nothing here', sep.lit === 0, String(sep.lit));
check('no followed-player name highlighting', sep.redNames === 0, String(sep.redNames));
check('no followed-player row marking', sep.mineRails === 0, String(sep.mineRails));

console.log('\n=== Follow Players: two sub-tabs, and it does use the selection ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click()`);
await wait(3500);
const fp = await ev(`({
  subtabs: [...document.querySelectorAll('.subtab')].map(b=>b.dataset.ptab),
  active: [...document.querySelectorAll('.subtab.is-active')].map(b=>b.dataset.ptab)[0],
  schedVisible: document.querySelector('#ptab-schedule').classList.contains('is-active'),
  listVisible: document.querySelector('#ptab-list').classList.contains('is-active'),
  rows: document.querySelectorAll('#myPlayers .mp').length,
  detail: !!document.querySelector('#playerDetail .panel'),
  styled: [...document.querySelectorAll('.subtab')].map(b => {
    const cs = getComputedStyle(b);
    return { on: b.classList.contains('is-active'), border: cs.borderTopWidth, bg: cs.backgroundColor };
  })
})`);
console.log(' ', JSON.stringify(fp));
// Players first: the schedule is derived from the follow list, so the list is
// where you start.
check('two sub-tabs, Players then Schedule', fp.subtabs.join(',') === 'list,schedule', fp.subtabs.join(','));
check('opens on Players', fp.active === 'list' && fp.listVisible && !fp.schedVisible, fp.active);
// Both states must read as buttons \u2014 a transparent border made the unselected
// one look like a label.
check('both sub-tabs are drawn as buttons',
  fp.styled.length === 2 && fp.styled.every(b => b.border === '1px' && b.bg !== 'rgba(0, 0, 0, 0)'),
  JSON.stringify(fp.styled));
check('and the selected one is clearly distinct', fp.styled[0].bg !== fp.styled[1].bg,
  `${fp.styled[0].bg} vs ${fp.styled[1].bg}`);
check('follow list rendered', fp.rows > 0, String(fp.rows));
check('player detail rendered', fp.detail === true);

await ev(`[...document.querySelectorAll('.subtab')].find(b=>b.dataset.ptab==='schedule').click()`);
await wait(3500);
// Same reasoning as above: whether these eight players happen to be playing on
// whatever today is says nothing about whether the schedule works.
await ev(`(() => { state.day = 'all';
  renderDaybar('#daybar', state.day, pickScheduleDay); renderSchedule(); })()`);
const list = await ev(`({
  listVisible: document.querySelector('#ptab-list').classList.contains('is-active'),
  schedVisible: document.querySelector('#ptab-schedule').classList.contains('is-active'),
  cards: document.querySelectorAll('#scheduleList .match').length,
  redNames: document.querySelectorAll('#scheduleList .nm .mine').length,
  stars: document.querySelectorAll('#scheduleList .star').length,
  stored: localStorage.getItem('wc26.playerTab')
})`);
console.log(' ', JSON.stringify(list));
check('the Schedule sub-tab swaps in', list.schedVisible && !list.listVisible, JSON.stringify(list));
check('shows the followed players\u2019 matches', list.cards > 0, String(list.cards));
check('and DOES highlight followed players here', list.redNames > 0, String(list.redNames));
check('no stars in this view', list.stars === 0, String(list.stars));
check('the sub-tab choice is remembered', /schedule/.test(list.stored || ''), String(list.stored));

console.log('\n=== the one bridge: star this schedule in Follow Matches ===');
const bridge = await ev(`(() => {
  const btn = document.querySelector('#addToStars');
  return { hidden: btn.hidden, act: btn.dataset.act, label: btn.textContent,
           shown: document.querySelectorAll('#scheduleList .match').length,
           starredBefore: state.starred.size };
})()`);
console.log(' ', JSON.stringify(bridge));
check('the button offers to add exactly what is on screen',
  !bridge.hidden && bridge.act === 'add' && bridge.label === `Add ${bridge.shown} to Follow Matches`,
  JSON.stringify(bridge));
check('nothing starred yet', bridge.starredBefore === 0, String(bridge.starredBefore));

const added = await ev(`(() => {
  document.querySelector('#addToStars').click();
  const btn = document.querySelector('#addToStars');
  return { starred: state.starred.size,
           stored: JSON.parse(localStorage.getItem('wc26.starred')||'[]').length,
           act: btn.dataset.act, label: btn.textContent };
})()`);
console.log(' ', JSON.stringify(added));
check('every shown match is starred', added.starred === bridge.shown, `${added.starred} vs ${bridge.shown}`);
check('and persisted', added.stored === bridge.shown, String(added.stored));
// A button that would do nothing is worse than one that offers the way back.
check('the button flips to Remove', added.act === 'remove' &&
  added.label === `Remove ${bridge.shown} from Follow Matches`, added.label);

// They must actually be lit over in Follow Matches, and only those.
const overThere = await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='matches').click();
  state.matchDay = 'all'; renderMatches();
  return { lit: document.querySelectorAll('#matchesList .match.is-starred').length,
           total: document.querySelectorAll('#matchesList .match').length };
})()`);
console.log(' ', JSON.stringify(overThere));
check('they are lit in Follow Matches', overThere.lit === bridge.shown, JSON.stringify(overThere));
check('and nothing else is', overThere.total > overThere.lit, JSON.stringify(overThere));

const removed = await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click();
  document.querySelector('#addToStars').click();
  return { starred: state.starred.size, act: document.querySelector('#addToStars').dataset.act };
})()`);
check('Remove takes them all back out', removed.starred === 0 && removed.act === 'add', JSON.stringify(removed));

console.log('\n=== doubles pairs are written by surname everywhere ===');
// The picker: displayed short, searched long.
const picker = await ev(`(() => {
  document.querySelector('#openPickerBtn').click();
  const q = document.querySelector('#pickerSearch');
  q.value = 'gicquel'; q.dispatchEvent(new Event('input'));
  const row = document.querySelector('#pickerList .pk .pk-nm');
  const shown = row.childNodes[0].textContent.trim();
  const tip = row.title;
  // …and the same entry must still be findable by a given name.
  q.value = 'delphine'; q.dispatchEvent(new Event('input'));
  const byFirst = [...document.querySelectorAll('#pickerList .pk .pk-nm')]
    .map(n => n.childNodes[0].textContent.trim());
  q.value = ''; q.dispatchEvent(new Event('input'));
  return { shown, tip, byFirst };
})()`);
console.log(' ', JSON.stringify(picker));
check('picker shows a pair by surname', picker.shown === 'GICQUEL / DELRUE', picker.shown);
check('with the full names on hover', /Thom GICQUEL \/ Delphine DELRUE/.test(picker.tip), picker.tip);
check('and is still searchable by a given name',
  picker.byFirst.includes('GICQUEL / DELRUE'), JSON.stringify(picker.byFirst));

// Follow that pair, plus a singles player, and read the schedule cards.
await ev(`(() => {
  document.querySelector('#closePicker').click();
  state.selected = new Set(['68544','70762','57945']);   // GICQUEL/DELRUE + SHI Yu Qi
  persistSelection();
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click();
  [...document.querySelectorAll('.subtab')].find(x=>x.dataset.ptab==='schedule').click();
  state.day = 'all';
  renderAll();
})()`);
await wait(4000);
const cards = await ev(`(() => {
  const nms = [...document.querySelectorAll('#scheduleList .nm')];
  const pair = nms.find(n => n.textContent.includes('/'));
  const solo = nms.find(n => /SHI Yu Qi/.test(n.textContent));
  return { pair: pair ? pair.childNodes[0].textContent.trim() + ' / ' +
                        pair.childNodes[2].textContent.trim() : null,
           pairTip: pair ? pair.title : null,
           solo: solo ? solo.childNodes[0].textContent.trim() : null,
           soloTip: solo ? solo.title : '' };
})()`);
console.log(' ', JSON.stringify(cards));
check('schedule card names a pair by surname', cards.pair === 'GICQUEL / DELRUE', String(cards.pair));
check('with the full pair on hover', /Thom GICQUEL \/ Delphine DELRUE/.test(cards.pairTip || ''), cards.pairTip);
check('singles keep their full name', cards.solo === 'SHI Yu Qi', String(cards.solo));
check('and singles need no tooltip', !cards.soloTip, JSON.stringify(cards.soloTip));

// The head-to-head, opened from a first-round XD card — the pair's own next
// match is against a TBD opponent, which has no head-to-head to show.
const opened = await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click();
  [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='xd').click();
  return true;
})()`);
await wait(7000);
const clicked = await ev(`(() => {
  const node = [...document.querySelectorAll('#drawCanvas .bnode')]
    .find(n => [...n.querySelectorAll('.bn')].every(b => b.textContent.includes('/')));
  if (!node) return 'no doubles card with two known sides';
  node.click();
  return node.textContent.trim().slice(0, 40);
})()`);
console.log('  opened from:', JSON.stringify(clicked));
check('found a doubles card with both sides known', clicked !== 'no doubles card with two known sides', String(clicked));
await wait(6000);
const h2hNames = await ev(`(() => {
  const t = document.querySelector('#h2hTitle');
  const sides = [...document.querySelectorAll('.h2h-p .nm2')].map(n => ({
    text: n.childNodes[0].textContent.trim(), tip: n.title }));
  return { title: t.textContent, titleTip: t.title, sides };
})()`);
console.log(' ', JSON.stringify(h2hNames));
// A surname-only pair has no lower-case letters in it; the full form does.
const surnamesOnly = t => /\//.test(t) && !/\p{Ll}/u.test(t);
check('head-to-head title uses surnames for both pairs',
  h2hNames.title.split(' vs ').every(surnamesOnly), h2hNames.title);
check('with the full names on hover',
  /\p{Ll}/u.test(h2hNames.titleTip || '') && h2hNames.titleTip !== h2hNames.title, h2hNames.titleTip);
check('head-to-head side headers use surnames',
  h2hNames.sides.length === 2 && h2hNames.sides.every(s => surnamesOnly(s.text)),
  JSON.stringify(h2hNames.sides.map(s => s.text)));
check('…and each reveals its full pair on hover',
  h2hNames.sides.every(s => /\p{Ll}/u.test(s.tip || '')),
  JSON.stringify(h2hNames.sides.map(s => s.tip)));
await ev(`document.querySelector('#closeH2h').click()`);

console.log('\n=== Draw: one tree, one camera, four modes ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await wait(4000);
const draw = await ev(`({
  modes: [...document.querySelectorAll('.pmode')].map(b=>b.dataset.pmode),
  active: [...document.querySelectorAll('.pmode.is-active')].map(b=>b.dataset.pmode)[0],
  bnodes: document.querySelectorAll('#drawCanvas .bnode').length,
  pnodes: document.querySelectorAll('#drawCanvas .pnode').length,
  canvases: document.querySelectorAll('.bracket-canvas').length,
  viewports: document.querySelectorAll('.bracket-viewport').length,
  zoombars: document.querySelectorAll('.zoombar').length,
  png: document.querySelector('#predictPng').hidden,
  clear: document.querySelector('#predictClear').hidden
})`);
console.log(' ', JSON.stringify(draw));
check('four modes', draw.modes.join(',') === 'results,yours,world,race', draw.modes.join(','));
check('opens on Results', draw.active === 'results', draw.active);
check('showing the real bracket', draw.bnodes === 63 && draw.pnodes === 0, `${draw.bnodes} bnodes`);
check('one canvas, one viewport, one zoom bar',
  draw.canvases === 1 && draw.viewports === 1 && draw.zoombars === 1,
  `${draw.canvases}/${draw.viewports}/${draw.zoombars}`);
check('prediction-only buttons hidden in Results', draw.png === true && draw.clear === true,
  JSON.stringify({ png: draw.png, clear: draw.clear }));
await shot('v11-draw-results.png');

// The point of merging: the camera must survive a mode change.

const cam = await ev(`(() => {
  document.querySelector('#zoomIn').click();
  document.querySelector('#zoomIn').click();
  const zoom = document.querySelector('#zoomLevel').textContent;
  const t = document.querySelector('#drawCanvas').style.transform;
  [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='yours').click();
  return { zoom, t, after: document.querySelector('#zoomLevel').textContent,
           tAfter: document.querySelector('#drawCanvas').style.transform,
           bnodes: document.querySelectorAll('#drawCanvas .bnode').length,
           pnodes: document.querySelectorAll('#drawCanvas .pnode').length,
           png: document.querySelector('#predictPng').hidden,
           clear: document.querySelector('#predictClear').hidden };
})()`);
console.log(' ', JSON.stringify(cam));
check('switching to Predictions keeps the zoom', cam.zoom === cam.after, `${cam.zoom} -> ${cam.after}`);
check('and keeps the exact pan', cam.t === cam.tAfter, `${cam.t} -> ${cam.tAfter}`);
check('the tree swaps to the prediction sheet', cam.pnodes === 64 && cam.bnodes === 0, `${cam.pnodes} pnodes`);
check('prediction buttons appear', cam.png === false && cam.clear === false, JSON.stringify(cam));

const back = await ev(`(() => {
  [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='results').click();
  return { bnodes: document.querySelectorAll('#drawCanvas .bnode').length,
           zoom: document.querySelector('#zoomLevel').textContent,
           score: document.querySelector('#predictScore').textContent };
})()`);
check('and back to Results again', back.bnodes === 63, String(back.bnodes));
check('zoom still held', back.zoom === cam.after, `${back.zoom}`);
check('the picked/right tally is blank in Results', back.score.trim() === '', JSON.stringify(back.score));

console.log('\n=== hotkeys follow the new shape ===');
await ev(`document.body.focus()`);
await key('ArrowRight','ArrowRight',39);
const wrapped = await ev(`[...document.querySelectorAll('.tab.is-active')].map(t=>t.dataset.view)[0]`);
check('ArrowRight wraps Draw \u2192 Follow Matches', wrapped === 'matches', String(wrapped));
await key('ArrowLeft','ArrowLeft',37);
check('ArrowLeft returns to Draw',
  (await ev(`[...document.querySelectorAll('.tab.is-active')].map(t=>t.dataset.view)[0]`)) === 'draw');
const beforeCat = await ev(`state.drawCat`);
await key('Shift','ShiftLeft',16);
await wait(3500);
const afterCat = await ev(`({ cat: state.drawCat, chip: [...document.querySelectorAll('.dcat.is-active')].map(b=>b.dataset.dcat)[0] })`);
check('Shift steps the drawn discipline', afterCat.cat !== beforeCat && afterCat.chip === afterCat.cat,
  `${beforeCat} -> ${afterCat.cat}`);
await key('0','Digit0',48);
check('0 resets the zoom', (await ev(`document.querySelector('#zoomLevel').textContent`)) === '100%');

console.log('\n=== links made before the restructure still work ===');
for (const [old, want] of [['schedule', { view: 'players', sub: 'schedule' }],
                           ['bracket',  { view: 'draw', mode: 'results' }],
                           ['predict',  { view: 'draw', mode: 'yours' }]]) {
  await send('Page.navigate', { url: `http://localhost:${PORT}/#c=ms&v=${old}` }, sessionId);
  await wait(12000);
  const got = await ev(`({
    view: [...document.querySelectorAll('.tab.is-active')].map(t=>t.dataset.view)[0],
    sub: [...document.querySelectorAll('.subtab.is-active')].map(b=>b.dataset.ptab)[0],
    mode: [...document.querySelectorAll('.pmode.is-active')].map(b=>b.dataset.pmode)[0]
  })`);
  const ok = got.view === want.view && (!want.sub || got.sub === want.sub) && (!want.mode || got.mode === want.mode);
  check(`v=${old} lands on ${want.view}${want.sub ? '/' + want.sub : ''}${want.mode ? '/' + want.mode : ''}`,
    ok, JSON.stringify(got));
}

const exc = events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text);
const errs = events.filter(e=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map(e=>e.params.entry.text);
console.log('\n=== errors ===');
exc.slice(0,5).forEach(m=>console.log('  EXC '+m));
errs.slice(0,5).forEach(m=>console.log('  LOG '+m));
check('no uncaught exceptions', exc.length===0, exc.length+'');
check('no error logs', errs.length===0, errs.length+'');

console.log(' ', fixtureReport(fx));
console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill(); server.close();
try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
process.exit(fail?1:0);
