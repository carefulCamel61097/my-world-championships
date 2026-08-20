/* Folding away rounds that are over, and saying so when a match ended early.
 *
 * The folding assertion that matters is geometric, not cosmetic: hiding columns
 * while keeping the spacing law would leave exactly the same acres of white
 * space, so this measures the canvas and the gap between sibling cards rather
 * than counting how many nodes are on screen.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8778, DBG = 9346;
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

const profile = path.join(process.env.TEMP, 'wc26-v14-' + process.pid);
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1400,1000',
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
// Chrome occasionally survives a previous suite's kill() on Windows and keeps
// the debugging port, and `new WebSocket(null)` then throws deep inside undici
// with no hint of the real cause.
if (!wsUrl) {
  console.error(`FAILURES: 1 — Chrome never answered on port ${DBG}. ` +
    'A previous run probably still holds it; check with `netstat -ano | grep ' + DBG + '`.');
  process.exit(1);
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
fx = await installFixtures(send, sessionId, { quiet: true });
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=all&v=draw` }, sessionId);

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||'') };
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(expr, ms = 60000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr) === true) return true;
    await wait(400);
  }
  return false;
}
let fail = 0;
const check = (l, c, x = '') => { if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  — ' + x : ''}`); };

check('draws and days loaded', await waitFor(
  `typeof state !== 'undefined' && !!state.draws.ms && !!state.draws.xd && state.daysLoaded.size === TMT.dates.length`));
await wait(1200);

const MEASURE = `(() => {
  const nodes = [...document.querySelectorAll('#drawCanvas .bnode, #drawCanvas .pnode')];
  const cv = document.querySelector('#drawCanvas');
  return {
    nodes: nodes.length,
    lines: document.querySelectorAll('#drawCanvas .bline').length,
    labels: [...document.querySelectorAll('#drawCanvas .bcol-label')].map(l => l.textContent),
    h: Math.round(parseFloat(cv.style.height)),
    w: Math.round(parseFloat(cv.style.width)),
    active: [...document.querySelectorAll('.rfrom.is-active')].map(b => b.dataset.round)[0],
  };
})()`;
const setFrom = async r => { await ev(`setFromRound('${r}')`); await wait(500); return ev(MEASURE); };

console.log('=== the whole draw ===');
const all = await setFrom('all');
console.log(' ', JSON.stringify(all));
check('63 nodes and 124 connector segments', all.nodes === 63 && all.lines === 124,
  `${all.nodes}/${all.lines}`);
check('all six rounds labelled', all.labels.length === 6, all.labels.join(','));

console.log('\n=== folded to the quarter-finals ===');
const qf = await setFrom('QF');
console.log(' ', JSON.stringify(qf));
check('only QF, SF and Final are drawn', qf.labels.join(',') === 'Quarter-final,Semi-final,Final',
  qf.labels.join(','));
check('7 nodes, 12 connector segments', qf.nodes === 7 && qf.lines === 12, `${qf.nodes}/${qf.lines}`);
// The whole point. Hiding three columns while keeping the (r+0.5)x2^c spacing
// would have left the height untouched.
check('the tree actually gets shorter', qf.h < all.h / 4, `${all.h}px -> ${qf.h}px`);
check('...and narrower', qf.w < all.w, `${all.w}px -> ${qf.w}px`);
check('the QF chip is lit', qf.active === 'QF', qf.active);

const sf = await setFrom('SF');
console.log('  SF:', JSON.stringify(sf));
check('SF folds to 3 nodes and 4 segments', sf.nodes === 3 && sf.lines === 4, `${sf.nodes}/${sf.lines}`);
check('and is shorter still', sf.h < qf.h, `${qf.h}px -> ${sf.h}px`);

console.log('\n=== the cards are evenly spaced again ===');
const gaps = await ev(`(() => {
  setFromRound('QF');
  const cards = [...document.querySelectorAll('#drawCanvas .bnode')]
    .map(n => ({ x: Math.round(parseFloat(n.style.left)), y: parseFloat(n.style.top) }));
  const firstCol = Math.min(...cards.map(c => c.x));
  const ys = cards.filter(c => c.x === firstCol).map(c => c.y).sort((a, b) => a - b);
  return { count: ys.length, deltas: ys.slice(1).map((y, i) => Math.round(y - ys[i])) };
})()`);
console.log(' ', JSON.stringify(gaps));
check('the four QF cards sit one slot apart', gaps.count === 4 &&
  gaps.deltas.length === 3 && gaps.deltas.every(d => d === gaps.deltas[0]) && gaps.deltas[0] < 100,
  JSON.stringify(gaps.deltas));

console.log('\n=== the default suits how far the tournament has got ===');
const auto = await ev(`(() => {
  state.fromRound = null;
  const out = {};
  for (const c of CATS) {
    const d = state.draws[c];
    out[c] = { from: resolvedFromRound(d), col: fromCol(d), auto: autoFromCol(d) };
  }
  return out;
})()`);
console.log(' ', JSON.stringify(auto));
const NAMES = ['all', 'R32', 'R16', 'QF', 'SF'];
check('every discipline resolves to a round the chips offer',
  Object.values(auto).every(v => NAMES.includes(v.from)), JSON.stringify(auto));
// However finished a draw is, auto must never strand you on the final alone.
check('auto never folds past the quarter-finals',
  Object.values(auto).every(v => v.col <= 3), JSON.stringify(auto));

console.log('\n=== predictions share the geometry ===');
const pred = await ev(`(async () => {
  setFromRound('QF');
  [...document.querySelectorAll('.pmode')].find(b => b.dataset.pmode === 'yours').click();
  await new Promise(r => setTimeout(r, 800));
  const nodes = [...document.querySelectorAll('#drawCanvas .pnode')];
  const last = nodes[nodes.length - 1];
  return { nodes: nodes.length, bnodes: document.querySelectorAll('#drawCanvas .bnode').length,
    labels: [...document.querySelectorAll('#drawCanvas .bcol-label')].map(l => l.textContent),
    champLeft: last ? Math.round(parseFloat(last.style.left)) : -1,
    canvasW: Math.round(parseFloat(document.querySelector('#drawCanvas').style.width)) };
})()`);
console.log(' ', JSON.stringify(pred));
check('the prediction sheet folds the same way', pred.nodes === 8 && pred.bnodes === 0, String(pred.nodes));
check('the champion column comes along',
  pred.labels.join(',') === 'Quarter-final,Semi-final,Final,Champion', pred.labels.join(','));
check('the champion card is inside the canvas',
  pred.champLeft > 0 && pred.champLeft < pred.canvasW, `${pred.champLeft} of ${pred.canvasW}`);

console.log('\n=== a pick made on a folded sheet still counts ===');
const picks = await ev(`(async () => {
  // Fold to the round that is actually being played: further in, both sides of
  // every card are still TBD, so there is nothing pickable and the only loose
  // .pw on the canvas is the champion card's inert one.
  state.fromRound = null; renderDraw();
  clearPicks();
  await new Promise(r => setTimeout(r, 500));
  const w = document.querySelector(
    '#drawCanvas .pnode:not(.is-locked):not(.pchamp) .pw:not(.is-void)');
  if (w) { w.click(); await new Promise(r => setTimeout(r, 400)); }
  return { clicked: !!w, from: resolvedFromRound(state.draws[state.drawCat]),
           picked: Object.keys(state.predict[state.drawCat] || {}).length,
           score: document.querySelector('#predictScore').textContent.replace(/\\s+/g, ' ').trim() };
})()`);
console.log(' ', JSON.stringify(picks));
check('a visible card is still clickable', picks.clicked);
check('the pick is recorded', picks.picked > 0, String(picks.picked));
// The sheet is about the tournament, not about the viewport: the denominator
// must stay the whole draw even when most of it is folded away.
check('the tally still speaks for all 63 matches', /\/63/.test(picks.score), picks.score);

console.log('\n=== retirements and walkovers ===');
const ret = await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t => t.dataset.view === 'matches').click();
  const out = { days: {} };
  for (const d of TMT.dates) {
    state.matchDay = d; renderMatches();
    const marks = [...document.querySelectorAll('#matchesList .sets b.mk')].map(b => b.textContent);
    const stats = [...document.querySelectorAll('#matchesList .stat.is-ret, #matchesList .stat.is-wo')]
      .map(n => n.textContent);
    if (marks.length || stats.length) out.days[d] = { marks, stats };
  }
  const played = Object.values(state.dayIndex);
  out.wo = played.filter(m => m.scoreStatus === 1).length;
  out.ret = played.filter(m => m.scoreStatus === 2).length;
  out.expect = out.wo + out.ret;
  return out;
})()`);
console.log(' ', JSON.stringify(ret));
const marks = Object.values(ret.days).flatMap(d => d.marks);
const labels = Object.values(ret.days).flatMap(d => d.stats);
check('there is something to test', ret.expect > 0, `${ret.wo} walkovers, ${ret.ret} retirements`);
// One mark per match, never two: it belongs to the side it happened to.
check('every one is marked, exactly once', marks.length === ret.expect, `${marks.length} of ${ret.expect}`);
check('walkovers read W/O', marks.filter(m => m === 'W/O').length === ret.wo, String(ret.wo));
check('retirements read RET', marks.filter(m => m === 'RET').length === ret.ret, String(ret.ret));
check('and the status badge says it in words',
  labels.length === ret.expect && labels.every(t => /Retired|Walkover/.test(t)), labels.join(','));

const sides = await ev(`(() => {
  const m = Object.values(state.dayIndex).find(x => x.scoreStatus === 2);
  if (!m) return null;
  state.matchDay = (m.matchTime || '').slice(0, 10); renderMatches();
  const card = [...document.querySelectorAll('#matchesList .match')]
    .find(c => c.querySelector('.sets b.mk'));
  if (!card) return null;
  const rows = [...card.querySelectorAll('.side')].map(s => ({
    winner: s.classList.contains('is-winner'), mark: !!s.querySelector('.mk') }));
  return rows;
})()`);
console.log('  sides:', JSON.stringify(sides));
check('the mark sits on the loser, not the winner',
  !!sides && sides.length === 2 && sides.every(r => r.mark !== r.winner),
  JSON.stringify(sides));

// "Off court" is a finished match awaiting sign-off. It used to read Scheduled.
const off = await ev(`(() => {
  const m = Object.values(state.dayIndex).find(x => (x.matchStatus || '') === 'O');
  return m ? { st: statusOf(m), winner: m.winner, games: (m.score || []).length } : null;
})()`);
console.log('  off court:', JSON.stringify(off));
if (off) check('an off-court match reads as played, not scheduled',
  off.st.text !== 'Scheduled' && off.st.text !== 'Not scheduled', off.st.text);
else console.log('SKIP  no off-court match in the data right now');

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
