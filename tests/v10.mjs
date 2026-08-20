/* Validate v10: the order-of-play court grid, and the compact match card. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8800, DBG = 9372;
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

const profile = path.join(process.env.TEMP, 'wc26-v10-' + Date.now());
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1600,1100',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`, 'about:blank']);
chrome.stderr.on('data', () => {});

/* Chrome's launcher is not the browser on Windows: kill() reaps the process we
   spawned while the real browser lives on holding the debugging port, so the
   next run of this suite cannot attach. Take the whole tree down. */
function killChrome() {
  try { spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { /* fall through */ }
  try { chrome.kill(); } catch {}
}

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
const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('  wrote', name);
};

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

// Follow Matches shows the whole day, so the grid has all four courts to place.
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=all&v=matches` }, sessionId);
await wait(12000);
// Day one is the day whose order of play is published.
await ev(`(() => { const b = [...document.querySelectorAll('.day')].find(x => /17/.test(x.textContent));
  if (b) b.click(); })()`);
await wait(4000);

console.log('=== the order of play is out, and lands in the grid ===');
const grid = await ev(`(() => {
  const g = document.querySelector('.oop-grid');
  if (!g) return { none: true, cards: document.querySelectorAll('.match').length };
  const heads = [...g.querySelectorAll('.oop-head')].map(h => ({
    text: h.textContent.trim(), col: h.style.gridColumn }));
  const cards = [...g.querySelectorAll('.match')].map(c => ({
    col: +c.style.gridColumn, row: +c.style.gridRow }));
  return { heads, n: cards.length, cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
           rows: new Set(cards.map(c => c.row)).size,
           perCol: heads.map((h, i) => cards.filter(c => c.col === i + 1).length) };
})()`);
console.log(' ', JSON.stringify(grid));
check('a court grid was rendered', !grid.none, JSON.stringify(grid));
check('four court columns, in order', grid.heads &&
  grid.heads.map(h => h.text).join('|') === 'Court 1|Court 2|Court 3|Court 4',
  grid.heads && grid.heads.map(h => h.text).join('|'));
check('all 64 matches placed', grid.n === 64, String(grid.n));
check('16 rows, one per position in the running order', grid.rows === 16, String(grid.rows));
check('16 matches in every column', grid.perCol && grid.perCol.every(n => n === 16), JSON.stringify(grid.perCol));

console.log('\n=== the row is the running order, not the clock ===');
const order = await ev(`(() => {
  const d = state.dayIndex;
  const day = Object.values(d).filter(m => (m.matchTime||'').startsWith('2026-08-17'));
  const byCourt = {};
  for (const m of day) (byCourt[m.courtName] = byCourt[m.courtName] || []).push(m);
  const out = {};
  for (const [c, ms] of Object.entries(byCourt)) {
    ms.sort((a,b) => a.courtSeq - b.courtSeq);
    out[c] = { seq: ms.map(m => m.courtSeq),
               times: ms.map(m => m.matchTime.slice(11,16)),
               monotonic: ms.every((m,i) => i===0 || m.matchTime >= ms[i-1].matchTime),
               oop: ms.slice(0,2).map(m => m.oopText) };
  }
  return out;
})()`);
for (const [c, v] of Object.entries(order)) {
  console.log(`  ${c}: times ${v.times.join(' ')}  monotonic=${v.monotonic}`);
}
const anyNonMono = Object.values(order).some(v => !v.monotonic);
check('BWF times really are non-monotonic on some court', anyNonMono,
  'this is why the y-axis is the running order');
check('courtSeq is a clean 0..15 on every court',
  Object.values(order).every(v => v.seq.join() === [...Array(16).keys()].join()));
check('only the first match of a court has a real time',
  Object.values(order).every(v => /Starting at/.test(v.oop[0]) && /Followed by/.test(v.oop[1])),
  JSON.stringify(Object.values(order)[0].oop));

// Two cards on the same grid row must be at the same point in the day.
const sameRow = await ev(`(() => {
  const cards = [...document.querySelectorAll('.oop-grid .match')];
  const row2 = cards.filter(c => +c.style.gridRow === 3);   // header is row 1
  return row2.map(c => ({ col: +c.style.gridColumn,
    t: (c.querySelector('.match-foot')||{}).textContent.trim().slice(0, 40) }));
})()`);
console.log(' ', JSON.stringify(sameRow));
check('a row holds one card per court', sameRow.length === 4, String(sameRow.length));

console.log('\n=== filtering collapses empty rows ===');
// Star a scattered handful, then show only those.
await ev(`(() => {
  const cards = [...document.querySelectorAll('.oop-grid .match')];
  for (const i of [0, 5, 9, 14, 22, 31, 40, 55]) if (cards[i]) cards[i].click();
  document.querySelector('#starredOnly').click();
})()`);
await wait(2500);
const filtered = await ev(`(() => {
  const g = document.querySelector('.oop-grid');
  if (!g) return { none: true, cards: document.querySelectorAll('.match').length };
  const cards = [...g.querySelectorAll('.match')].map(c => ({ col:+c.style.gridColumn, row:+c.style.gridRow }));
  const rows = [...new Set(cards.map(c => c.row))].sort((a,b)=>a-b);
  return { n: cards.length, rows: rows.length, contiguous: rows.every((r,i) => r === rows[0] + i),
           cols: g.querySelectorAll('.oop-head').length };
})()`);
console.log(' ', JSON.stringify(filtered));
if (!filtered.none) {
  check('filtered grid still renders', filtered.n > 0, JSON.stringify(filtered));
  check('rows are collapsed, not sparse', filtered.contiguous && filtered.rows <= filtered.n,
    JSON.stringify(filtered));
}

console.log('\n=== the card got shorter ===');
// Measured separately for played and unplayed matches: a finished card also
// carries up to five game scores per side, so comparing whichever card happens
// to be first would just track how far into the day the tournament is.
const size = await ev(`(() => {
  const cards = [...document.querySelectorAll('.oop-grid .match')];
  const h = c => Math.round(c.getBoundingClientRect().height);
  const scored = c => c.querySelectorAll('.sets b:not(.mk)').length;
  const played = cards.find(c => scored(c));
  const unplayed = cards.find(c => !scored(c));
  const c = unplayed || cards[0];
  return { unplayed: unplayed ? h(unplayed) : null,
           played: played ? h(played) : null,
           subInline: getComputedStyle(c.querySelector('.nm .sub')).display,
           head: Math.round(c.querySelector('.match-head').getBoundingClientRect().height),
           side: Math.round(c.querySelector('.side').getBoundingClientRect().height),
           foot: Math.round(c.querySelector('.match-foot').getBoundingClientRect().height),
           clipped: [...document.querySelectorAll('.oop-grid .nm')]
             .filter(n => n.scrollWidth > n.clientWidth + 1)
             .map(n => n.textContent.trim()) };
})()`);
console.log(' ', JSON.stringify(size));
// Assert on the chrome, not the total. In a quarter-width column the total now
// depends on whether the names and footer wrap, which is content, not layout —
// the compaction was about the padding and the wasted line per side.
// Before: head 30, side 47 each, foot 27 -> a ~160px card with nothing in it.
check('a player row is far shorter than the old 47px', size.side <= 32, size.side + 'px');
// Deliberately NOT measured in the court grid. At a quarter of the width
// "Scheduled - Round of 64 - MS - Court 1" legitimately takes two lines, and
// this only ever passed there because the card it happened to pick was a
// finished one with a shorter status word. The chrome is what was compacted,
// so it is measured where nothing has to wrap; see the single-column card below.
check('country no longer takes its own line', size.subInline !== 'block', size.subInline);
check('all four parts still present', size.head > 0 && size.side > 0 && size.foot > 0,
  JSON.stringify(size));
// And in the single-column schedule, where nothing has to wrap, the whole card
// comes in well under what an empty one used to cost.
const wide = await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click();
  [...document.querySelectorAll('.subtab')].find(x=>x.dataset.ptab==='schedule').click();
  state.selected = new Set(['57945','81599','59880']); persistSelection();
  state.day = 'all'; renderAll();
  return true;
})()`);
await wait(4000);
const wideCard = await ev(`(() => {
  const c = document.querySelector('#scheduleList .match');
  if (!c) return null;
  const h = n => Math.round(c.querySelector(n).getBoundingClientRect().height);
  return { total: Math.round(c.getBoundingClientRect().height),
           head: h('.match-head'), side: h('.side'), foot: h('.match-foot') };
})()`);
console.log('  single-column card:', JSON.stringify(wideCard));
check('a full-width card is well under the old ~160px', wideCard && wideCard.total < 115,
  wideCard && wideCard.total + 'px');
// Before compaction: head 30, side 47 each, foot 27 -> a ~160px card with
// nothing in it.
check('the head is tighter than the old 30px', wideCard && wideCard.head <= 30,
  wideCard && wideCard.head + 'px');
check('a player row is far shorter than the old 47px, at full width too',
  wideCard && wideCard.side <= 32, wideCard && wideCard.side + 'px');
await ev(`(() => { [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='matches').click(); })()`);
await wait(2500);
// A long unbroken surname is wider than a quarter-width column and has no
// space to wrap at, so it has to be allowed to break mid-word.
check('no name overflows its column', size.clipped.length === 0, JSON.stringify(size.clipped));

await shot('schedule-grid.png');

console.log('\n=== 24-hour clock, and estimates marked as estimates ===');
// Show the whole day again: only four matches all day are "first on court".
await ev(`(() => { const c = document.querySelector('#starredOnly'); if (c.checked) c.click(); })()`);
await wait(2500);
const times = await ev(`(() => {
  const feet = [...document.querySelectorAll('.oop-grid .match-foot')];
  const txt = feet.map(f => f.textContent.trim());
  const first = feet.find(f => /Starting at/.test(f.textContent));
  const follow = feet.find(f => /Followed by/.test(f.textContent));
  const clean = n => n ? n.textContent.replace(/\\s+/g, ' ').trim() : null;
  return { any12h: txt.some(t => /[0-9]:[0-9]{2}\\s*[AaPp][.]?[Mm]/.test(t)),
           sample: txt.slice(0, 3),
           firstOnCourt: clean(first),
           followOn: clean(follow),
           followTitle: follow ? ((follow.querySelector('[title]') || {}).title || '') : '' };
})()`);
console.log(' ', JSON.stringify(times));
check('no 12-hour times anywhere in the cards', times.any12h === false, JSON.stringify(times.sample));
check('BWF’s own "Starting at 9:00 AM" restyled to 24h',
  !!times.firstOnCourt && /Starting at \d{2}:\d{2}/.test(times.firstOnCourt), times.firstOnCourt);
check('a follow-on match marks its time approximate',
  !!times.followOn && times.followOn.includes('≈'), times.followOn);
check('and explains why on hover', /Estimated/.test(times.followTitle), times.followTitle);
check('the first match on a court is NOT marked approximate',
  !!times.firstOnCourt && !times.firstOnCourt.includes('≈'), times.firstOnCourt);

console.log('\n=== doubles names wrap rather than truncate in a narrow column ===');
const dbl = await ev(`(() => {
  const nm = [...document.querySelectorAll('.oop-grid .nm')];
  const cs = nm.length ? getComputedStyle(nm[0]) : {};
  const clipped = nm.filter(n => n.scrollWidth > n.clientWidth + 1).length;
  const pairs = nm.filter(n => n.textContent.includes('/')).length;
  return { whiteSpace: cs.whiteSpace, clipped, n: nm.length, pairs };
})()`);
console.log(' ', JSON.stringify(dbl));
check('names are allowed to wrap', dbl.whiteSpace !== 'nowrap', String(dbl.whiteSpace));
check('no name is clipped horizontally', dbl.clipped === 0, String(dbl.clipped));

console.log('\n=== narrow screens drop the grid and stack in running order ===');
await send('Emulation.setDeviceMetricsOverride',
  { width: 700, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await wait(1200);
const narrow = await ev(`(() => {
  const g = document.querySelector('.oop-grid');
  if (!g) return { none: true };
  const cards = [...g.querySelectorAll('.match')];
  const tops = cards.map(c => Math.round(c.getBoundingClientRect().top));
  return { display: getComputedStyle(g).display,
           headHidden: getComputedStyle(g.querySelector('.oop-head')).display,
           courtShown: getComputedStyle(cards[0].querySelector('.match-head .court')).display,
           stacked: tops.every((t, i) => i === 0 || t >= tops[i-1]) };
})()`);
console.log(' ', JSON.stringify(narrow));
check('grid collapses on a narrow screen', narrow.display === 'block', String(narrow.display));
check('court headers hidden when stacked', narrow.headHidden === 'none', String(narrow.headHidden));
check('the card shows its court again when stacked', narrow.courtShown !== 'none', String(narrow.courtShown));
check('cards stack top to bottom in running order', narrow.stacked === true, String(narrow.stacked));
await shot('schedule-narrow.png');
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);

const exc = events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text);
const errs = events.filter(e=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map(e=>e.params.entry.text);
console.log('\n=== errors ===');
exc.slice(0,5).forEach(m=>console.log('  EXC '+m));
errs.slice(0,5).forEach(m=>console.log('  LOG '+m));
check('no uncaught exceptions', exc.length===0, exc.length+'');
check('no error logs', errs.length===0, errs.length+'');

console.log(' ', fixtureReport(fx));
console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
ws.close(); killChrome(); server.close();
try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
process.exit(fail?1:0);
