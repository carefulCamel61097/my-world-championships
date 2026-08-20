/* Live refresh: does the page pick up new scores while it sits open?
 *
 * The interesting part is not the timer — it is that a refresh has to re-fetch
 * past its own five-minute cache, notice what actually moved, mark those cards,
 * and leave the page alone when nothing moved. The fixture layer serves a
 * *changed* body from the second fetch of the day onward, which is the only way
 * to test any of this without waiting for real badminton to happen.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8776, DBG = 9344;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

// Two different days, and the distinction is the whole reason this suite kept
// breaking. POLL_DAY is what the timer goes after: today, or nothing outside
// the week. DAY is the day the fixture is changed under the page — pinned to
// day one, because that is the only date guaranteed to have a real order of
// play recorded. Depending on "today" made this a test of whether BWF had
// published a schedule yet, and it went red at midnight on its first night.
const TMT_DATES = ['2026-08-17','2026-08-18','2026-08-19','2026-08-20',
                   '2026-08-21','2026-08-22','2026-08-23'];
const p2 = n => String(n).padStart(2, '0');
const now = new Date();
const TODAY = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
const IN_WEEK = TMT_DATES.includes(TODAY);
const POLL_DAY = IN_WEEK ? TODAY : null;
const DAY = TMT_DATES[0];

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

/* ---- the moving part: day one gains a result on every fetch after the first ---- */
let mutatedId = null, mutatedName = '';
function mutate(url, body, nth) {
  if (nth < 2 || !url.includes('day-matches') || !url.includes('date=' + DAY)) return null;
  let list;
  try { list = JSON.parse(body); } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;

  // Pick a match that has not finished, so the change is a real transition.
  const m = list.find(x => (x.matchStatus || '').toUpperCase() !== 'F' && x.team1 && x.team2) || list[0];
  m.matchStatus = 'F';
  m.winner = 1;
  m.duration = 47;
  m.score = [{ home: 21, away: 15 }, { home: 21, away: 18 }];
  mutatedId = String(m.id);
  mutatedName = ((m.team1 && m.team1.players) || []).map(p => p.nameDisplay).join(' / ');
  return JSON.stringify(list);
}

const profile = path.join(process.env.TEMP, 'wc26-v12-' + process.pid);
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1200,900',
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
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
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
fx = await installFixtures(send, sessionId, { quiet: true, mutate });
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=all&v=matches` }, sessionId);

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r?.result?.value;
};

/** Poll rather than sleep a fixed span — fixtures make this fast and variable. */
async function waitFor(expr, ms = 40000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr) === true) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

let fail = 0;
const check = (label, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

// Wait for the *whole* background sweep, not just day one: loadAllDays calls
// renderAll() as each day lands, which would rebuild the list underneath the
// "was the page repainted?" assertion below and fail it for the wrong reason.
// `state` is a top-level const in a classic script, so it is a global lexical
// binding and NOT a property of window — test the binding, not window.state.
const ready = await waitFor(
  `typeof state !== 'undefined' && !!state.draws.ms && !!state.draws.xd
   && state.daysLoaded.size === TMT.dates.length`);
check('every draw and day loaded', ready);
// daysLoaded is stamped when a day's fetch *starts*, so let the last one land
// and paint before anything below watches the DOM for changes.
await new Promise(r => setTimeout(r, 1500));

console.log('=== the indicator ===');
const idle = await ev(`({
  present: !!document.querySelector('#liveBtn'),
  label: (document.querySelector('#liveLabel')||{}).textContent||'',
  on: document.querySelector('#liveBtn').classList.contains('is-on'),
  timer: liveTimer !== null,
  day: liveDay(),
  at: liveAt,
})`);
console.log(' ', JSON.stringify(idle));
check('live button is in the topbar', idle.present);
// In the week the poll is armed on today; outside it, standing down *is* the
// behaviour under test, so assert that instead of skipping.
check(IN_WEEK ? 'polling is armed on today' : 'polling stands down out of week',
  IN_WEEK ? (idle.on && idle.day === POLL_DAY) : (!idle.on && idle.day === null),
  `${idle.day} / on=${idle.on}`);
check('interval is running', idle.timer);
check(`reads "${IN_WEEK ? 'Live' : 'Refresh'}" before the first check`,
  idle.label === (IN_WEEK ? 'Live' : 'Refresh'), idle.label);

// From here the suite drives every refresh by hand: a 90-second interval firing
// in the middle of a timing assertion is a flake waiting to happen.
await ev('clearInterval(liveTimer)');

console.log('\n=== a hidden tab does not poll ===');
if (!IN_WEEK) console.log('  (out of week — the timer would stand down anyway)');
const hidden = await ev(`(async () => {
  Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
  await refreshLive();
  const at = liveAt;
  delete document.hidden;
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  return at;
})()`);
check('no fetch while the tab is in the background', hidden === 0, 'liveAt=' + hidden);

console.log('\n=== a refresh that finds something ===');
// Look at day one, so the forced refresh takes it in as the day on screen and
// the changed card is actually rendered.
await ev(`(() => { state.matchDay = '${DAY}';
  renderDaybar('#mDaybar', state.matchDay, pickMatchDay); renderMatches(); })()`);
const news = await ev(`(async () => { await refreshLive(true); return {
  news: liveNews, at: liveAt,
  label: document.querySelector('#liveLabel').textContent,
  hasNews: document.querySelector('#liveBtn').classList.contains('is-news'),
  fresh: document.querySelectorAll('.match.is-fresh').length,
  freshIds: [...state.fresh.keys()],
}; })()`);
console.log(' ', JSON.stringify(news));
console.log('  mutated:', mutatedId, mutatedName);
check('the changed match was noticed', news.news === 1, news.news + ' changed');
check('…and it is the one the fixture moved', news.freshIds.length === 1 && news.freshIds[0] === mutatedId,
      news.freshIds.join(',') + ' vs ' + mutatedId);
check('exactly one card is marked new', news.fresh === 1, news.fresh + ' marked');
check('the label announces it', news.label === '1 new', news.label);
check('the button lights up', news.hasNews);

const card = await ev(`(() => {
  const c = document.querySelector('.match.is-fresh');
  if (!c) return null;
  const sets = [...c.querySelectorAll('.sets')].map(s => s.textContent.replace(/\\s+/g,''));
  return { status: (c.querySelector('.stat')||{}).textContent||'',
           winner: !!c.querySelector('.side.is-winner'),
           sets,
           badge: getComputedStyle(c.querySelector('.match-head'), '::after').content };
})()`);
console.log(' ', JSON.stringify(card));
check('the new score is on the card', !!card && card.sets[0] === '2121', JSON.stringify(card && card.sets));
check('the winner is marked', !!card && card.winner);
check('the card reads Finished', !!card && /finished/i.test(card.status), card && card.status);
check('a "new" badge is drawn', !!card && /new/i.test(card.badge || ''), card && card.badge);

console.log('\n=== a refresh that finds nothing ===');
const quiet = await ev(`(async () => {
  const c = document.querySelector('#matchesList .match');
  c.dataset.marker = 'kept';
  const before = liveAt;
  await refreshLive(true);
  const still = document.querySelector('#matchesList .match');
  return { news: liveNews, moved: liveAt > before,
           label: document.querySelector('#liveLabel').textContent,
           repainted: !(still && still.dataset.marker === 'kept'),
           drawFresh: Date.now() - state.drawAt[state.drawCat] < 20000 };
})()`);
console.log(' ', JSON.stringify(quiet));
check('nothing reported the second time', quiet.news === 0, quiet.news + '');
check('the check still happened', quiet.moved);
check('the page was NOT rebuilt', !quiet.repainted);
check('the label falls back to the clock', /^\d\d:\d\d$/.test(quiet.label), quiet.label);
check('the draw was refetched too', quiet.drawFresh);

console.log('\n=== the cache is genuinely bypassed ===');
// The five-minute sessionStorage cache is what a naive refresh would hit, and
// if it did, none of the above could ever have been observed. Counting fixture
// serves from this side proves a request left the page at all.
const call = (fresh) => ev(`getJSON('tournaments/day-matches',
  { tournamentCode: TMT.code, date: '${DAY}', order: 1, court: 0 }, 'high'${fresh ? ', true' : ''})
  .then(r => r.length)`);
const cached = await ev(
  `!![...Object.keys(sessionStorage)].find(k => k.includes('day-matches') && k.includes('${DAY}'))`);
const s0 = fx.stats.served;
const nCached = await call(false);
const s1 = fx.stats.served;
const nFresh = await call(true);
const s2 = fx.stats.served;
console.log(`  served ${s0} -> ${s1} -> ${s2}, ${nCached}/${nFresh} matches`);
check('the day is in the session cache', cached);
check('a normal call never leaves the page', s1 === s0);
check('a fresh call goes back to the network', s2 === s1 + 1);
check('both answers agree', nCached === nFresh && nFresh > 0);

const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description||''));
const errLogs = events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  .map(e => e.params.entry.text);
console.log('\n=== errors ===');
exceptions.slice(0,5).forEach(m => console.log('  EXC ' + m));
errLogs.slice(0,5).forEach(m => console.log('  LOG ' + m));
check('no uncaught exceptions', exceptions.length === 0, exceptions.length + '');
check('no error-level console logs', errLogs.length === 0, errLogs.length + '');

console.log(' ', fixtureReport(fx));
console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
ws.close(); killChrome(); server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
