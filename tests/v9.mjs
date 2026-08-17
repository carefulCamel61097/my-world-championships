/* Validate v9: the Predictions view — picks, propagation, auto brackets,
   PNG export, and the new dark-by-default theme. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8790, DBG = 9362;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const DL = path.join(process.env.TEMP, 'wc26-dl-' + Date.now());
fs.mkdirSync(DL, { recursive: true });

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

const profile = path.join(process.env.TEMP, 'wc26-v9-' + Date.now());
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1500,1050',
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
// Browser-level first: Page.setDownloadBehavior is deprecated and current
// Chrome quietly ignores it, which strands the file rather than failing loudly.
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }, sessionId);

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description||'') };
  return r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const key = async (k, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await wait(600);
};

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

// Force the OS-light case so "dark is the default" is actually being tested.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=ms&v=predict` }, sessionId);
await wait(12000);

console.log('=== dark BWF red is the default even on a light system ===');
const theme = await ev(`(() => {
  const r = document.documentElement, cs = getComputedStyle(r);
  return { skin: r.dataset.skin, mode: r.dataset.mode,
           bg: cs.getPropertyValue('--bg').trim(),
           accent: cs.getPropertyValue('--accent').trim(),
           stored: localStorage.getItem('wc26.mode') };
})()`);
console.log(' ', JSON.stringify(theme));
check('skin is bwf', theme.skin === 'bwf', theme.skin);
check('mode is dark despite prefers-color-scheme: light', theme.mode === 'dark', theme.mode);
check('dark palette actually applied', theme.bg === '#1a1a1a' || /^#(1|2)/.test(theme.bg), theme.bg);
check('accent is BWF red', theme.accent.toLowerCase() === '#df2027', theme.accent);

const flip = await ev(`(() => { document.querySelector('#modeToggle').click();
  const a = document.documentElement.dataset.mode;
  document.querySelector('#modeToggle').click();
  return { light: a, back: document.documentElement.dataset.mode }; })()`);
check('mode toggle still flips both ways', flip.light === 'light' && flip.back === 'dark', JSON.stringify(flip));

console.log('\n=== the view renders ===');
const built = await ev(`({
  tab: [...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view,
  nodes: document.querySelectorAll('#drawCanvas .pnode').length,
  ws: document.querySelectorAll('#drawCanvas .pw:not(.is-void)').length,
  champ: document.querySelectorAll('#drawCanvas .pchamp').length,
  labels: [...document.querySelectorAll('#drawCanvas .bcol-label')].map(n=>n.textContent),
  lines: document.querySelectorAll('#drawCanvas .bline').length,
  score: document.querySelector('#predictScore').textContent,
  transform: document.querySelector('#drawCanvas').style.transform
})`);
console.log(' ', JSON.stringify(built));
check('an old v=predict link lands on Draw', built.tab === 'draw', built.tab);
check('...in the predictions mode it named',
  (await ev(`[...document.querySelectorAll('.pmode.is-active')].map(b=>b.dataset.pmode)[0]`)) === 'yours');
check('63 match cards + champion card', built.nodes === 64, built.nodes+'');
check('champion card present', built.champ === 1);
check('column headings incl. Champion', built.labels.length === 7 && built.labels[6] === 'Champion', built.labels.join(','));
// The denominator must be every match that will ever need a pick, so the
// target does not move as the draw fills in.
check('reads 0/63 from the start', /^0\/63picked$/.test(built.score.replace(/\s+/g,'')), built.score);
check('camera applied', /scale/.test(built.transform||''));

console.log('\n=== picking a winner carries them up the draw ===');
const pick = await ev(`(() => {
  // First real (non-bye) round-one card.
  const node = [...document.querySelectorAll('#drawCanvas .pnode')]
    .find(n => !n.classList.contains('is-bye') && !n.classList.contains('is-locked')
               && parseFloat(n.style.left) < 40);
  const sides = node.querySelectorAll('.pnode-side');
  const name = sides[0].querySelector('.bn').textContent.trim();
  const top = parseFloat(node.style.top);
  sides[0].click();
  const after = [...document.querySelectorAll('#drawCanvas .pnode')]
    .find(n => Math.abs(parseFloat(n.style.top) - top) < 1 && parseFloat(n.style.left) < 40);
  // the round-two card this feeds
  const next = [...document.querySelectorAll('#drawCanvas .pnode')]
    .filter(n => parseFloat(n.style.left) > 200 && parseFloat(n.style.left) < 300)
    .map(n => ({ top: parseFloat(n.style.top), names: [...n.querySelectorAll('.bn')].map(x=>x.textContent.trim()) }))
    .filter(n => n.names.includes(name));
  return { name,
    pickedSide: after.querySelectorAll('.pnode-side')[0].className,
    otherSide: after.querySelectorAll('.pnode-side')[1].className,
    carried: next.length,
    score: document.querySelector('#predictScore').textContent,
    stored: JSON.parse(localStorage.getItem('wc26.predict')||'{}'),
    stamped: JSON.parse(localStorage.getItem('wc26.predictAt')||'{}') };
})()`);
console.log(' ', JSON.stringify({ ...pick, stored: Object.keys(pick.stored.ms||{}).length }));
check('picked side is marked', /is-pick/.test(pick.pickedSide), pick.pickedSide);
check('other side is dimmed', /is-out/.test(pick.otherSide), pick.otherSide);
check('winner appears in the next card', pick.carried === 1, pick.carried+'');
check('tally counts the pick', /^1\/63/.test(pick.score.replace(/\s+/g,'')), pick.score);
check('pick persisted', Object.keys(pick.stored.ms||{}).length === 1, JSON.stringify(pick.stored.ms));
check('date stamped for the PNG', !!(pick.stamped.ms||'').match(/^\d{4}-\d{2}-\d{2}/), pick.stamped.ms);

const unpick = await ev(`(() => {
  const node = [...document.querySelectorAll('#drawCanvas .pnode')]
    .find(n => n.querySelector('.pnode-side.is-pick') && parseFloat(n.style.left) < 40);
  node.querySelector('.pnode-side.is-pick').click();
  return { picks: Object.keys(JSON.parse(localStorage.getItem('wc26.predict')||'{}').ms||{}).length,
           score: document.querySelector('#predictScore').textContent };
})()`);
check('clicking the same side again un-picks it', unpick.picks === 0, JSON.stringify(unpick));

console.log('\n=== filling a whole path through to the champion ===');
const path1 = await ev(`(() => {
  // Walk column by column, always backing the top side that exists.
  for (let round = 0; round < 6; round++) {
    const x = round * 242;
    const nodes = [...document.querySelectorAll('#drawCanvas .pnode')]
      .filter(n => Math.abs(parseFloat(n.style.left) - (26 + x)) < 2
                   && !n.classList.contains('is-locked'));
    for (const n of nodes) n.querySelectorAll('.pnode-side')[0].click();
  }
  const champ = document.querySelector('#drawCanvas .pchamp .bn').textContent.trim();
  return { champ, score: document.querySelector('#predictScore').textContent,
           picks: Object.keys(JSON.parse(localStorage.getItem('wc26.predict')||'{}').ms||{}).length };
})()`);
console.log(' ', JSON.stringify(path1));
check('every match picked', /63\/63/.test(path1.score.replace(/\s+/g,'')), path1.score);
check('a champion is named', path1.champ && path1.champ !== 'Not decided yet', path1.champ);

console.log('\n=== played matches are scored right or wrong on the sheet ===');
// Real results, live: back the actual winner of one decided match and the
// loser of another, and check the sheet says so.
const scored = await ev(`(() => {
  const d = state.draws.ms;
  const decided = [];
  for (const [k, m] of Object.entries(d.cells)) {
    if (!m || d.byeCodes.has(String(m.code))) continue;
    if (m.winner !== 1 && m.winner !== 2) continue;
    decided.push(m);
  }
  if (decided.length < 2) return { tooEarly: decided.length };
  const [a, b] = decided;
  state.predict.ms = {
    [String(a.code)]: entryKey(a['team' + a.winner]),                      // right
    [String(b.code)]: entryKey(b['team' + (b.winner === 1 ? 2 : 1)]),      // wrong
  };
  persistPredictions('ms');
  renderDraw();
  const pw = s => [...document.querySelectorAll('#drawCanvas .pw.' + s)];
  return {
    played: decided.length,
    hitNodes: document.querySelectorAll('#drawCanvas .pnode.is-hit').length,
    missNodes: document.querySelectorAll('#drawCanvas .pnode.is-miss').length,
    ticks: pw('is-hit').map(n => n.textContent),
    crosses: pw('is-miss').map(n => n.textContent),
    crossTip: (pw('is-miss')[0] || {}).title || '',
    // the mark must sit on the side that was backed, not the other one
    tickOnPick: pw('is-hit').every(n => n.closest('.pnode-side').classList.contains('is-pick')),
    crossOnPick: pw('is-miss').every(n => n.closest('.pnode-side').classList.contains('is-pick')),
    tally: document.querySelector('#predictScore').textContent.trim(),
  };
})()`);
console.log(' ', JSON.stringify(scored));
check('there are real results to score against', !scored.tooEarly, JSON.stringify(scored));
check('one card marked right, one wrong', scored.hitNodes === 1 && scored.missNodes === 1,
  `${scored.hitNodes} hit / ${scored.missNodes} miss`);
check('the right one shows a tick', scored.ticks.join('') === '✓', JSON.stringify(scored.ticks));
check('the wrong one shows a cross', scored.crosses.join('') === '✗', JSON.stringify(scored.crosses));
check('both marks sit on the side that was backed', scored.tickOnPick && scored.crossOnPick,
  JSON.stringify({ tick: scored.tickOnPick, cross: scored.crossOnPick }));
check('the cross says who actually won', /Wrong — .+ won this/.test(scored.crossTip), scored.crossTip);
// Two predicted, one right — and the four other played matches were never
// predicted, so they must not count against you.
check('the tally counts only what was played AND predicted',
  /1\/2 right so far/.test(scored.tally.replace(/\s+/g, ' ')), scored.tally);

console.log('\n=== doubles: byes must carry the pair, not the gap ===');
// XD is 48 pairs in a 64 draw, so 16 first-round cells have one empty side —
// and BWF fills that side with a players-less team object rather than null.
await ev(`[...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='xd').click()`);
await wait(6000);
const dbl = await ev(`(() => {
  const d = state.draws.xd, res = resolvePredictions(d, 'yours');
  let byes = 0, carried = 0, gaps = 0;
  for (const [k, m] of Object.entries(d.cells)) {
    if (!k.startsWith('0-') || !m || !d.byeCodes.has(String(m.code))) continue;
    byes++;
    const w = res.winner[k];
    if (entryKey(w)) carried++; else gaps++;
  }
  // …and the pair must actually appear in the round-two card it feeds.
  const r0 = Object.keys(d.cells).find(k => k.startsWith('0-') && d.cells[k]
    && d.byeCodes.has(String(d.cells[k].code)) && !entryKey(d.cells[k].team1));
  const row = Number(r0.split('-')[1]);
  const nextTeams = res.teams['1-' + Math.floor(row / 2)].map(t => teamName(t));
  return { byes, carried, gaps, emptyTeam1Cell: r0,
           pair: teamName(d.cells[r0].team2), nextTeams,
           tally: document.querySelector('#predictScore').textContent.trim() };
})()`);
console.log(' ', JSON.stringify(dbl));
check('XD has 16 byes', dbl.byes === 16, dbl.byes+'');
check('every bye carries its pair forward', dbl.carried === 16 && dbl.gaps === 0, JSON.stringify(dbl));
check('a bye with an empty team1 still reaches round two',
  dbl.nextTeams.includes(dbl.pair), `${dbl.pair} → ${JSON.stringify(dbl.nextTeams)}`);
check('denominator excludes byes', /\/47picked/.test(dbl.tally.replace(/\s+/g,'')), dbl.tally);

// Fill it to the title, unlocking cards as feeders resolve.
const dblChamp = await ev(`(() => {
  for (let pass = 0; pass < 12; pass++) {
    const open = [...document.querySelectorAll('#drawCanvas .pnode')]
      .filter(n => !n.classList.contains('is-locked') && !n.classList.contains('pchamp')
                   && !n.querySelector('.pnode-side.is-pick'));
    if (!open.length) break;
    for (const el of open) el.querySelectorAll('.pnode-side')[0].click();
  }
  return { champ: document.querySelector('.pchamp .bn').textContent.trim(),
           title: document.querySelector('.pchamp').title,
           tally: document.querySelector('#predictScore').textContent.trim() };
})()`);
console.log(' ', JSON.stringify(dblChamp));
check('a doubles draw fills to a champion', dblChamp.champ && dblChamp.champ !== 'Not decided yet', dblChamp.champ);
check('all 47 doubles matches picked', /^47\/47/.test(dblChamp.tally.replace(/\s+/g,'')), dblChamp.tally);

console.log('\n=== doubles cards show surnames only ===');
const names = await ev(`({
  cards: [...document.querySelectorAll('#drawCanvas .pnode .bn')]
    .map(n=>n.textContent.trim()).filter(t=>t && t!=='—' && t!=='Bye').slice(0,6),
  champTitle: document.querySelector('.pchamp').title
})`);
// The real bracket is the Results mode of the same view now.
await ev(`[...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='xd').click()`);
await wait(5000);
await ev(`[...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='results').click()`);
await wait(2500);
const bnames = await ev(`({
  cards: [...document.querySelectorAll('#drawCanvas .bnode .bn')]
    .map(n=>n.textContent.trim()).filter(t=>t && t!=='—' && t!=='Bye').slice(0,6),
  tip: (document.querySelector('#drawCanvas .bnode[title]')||{}).title || ''
})`);
console.log('  predict:', JSON.stringify(names.cards));
console.log('  bracket:', JSON.stringify(bnames.cards));
console.log('  tooltip:', JSON.stringify(bnames.tip));
const surnameish = t => /^[^a-z]+ \/ [^a-z]+$/.test(t.replace(/…/g, 'X'));
check('prediction cards show SURNAME / SURNAME', names.cards.every(surnameish), names.cards.join(' | '));
check('bracket cards show SURNAME / SURNAME', bnames.cards.every(surnameish), bnames.cards.join(' | '));
check('full names survive on the tooltip', /\p{Ll}/u.test(bnames.tip) && / v /.test(bnames.tip), bnames.tip);
check('champion card keeps a full-name tooltip', /\p{Ll}/u.test(names.champTitle), names.champTitle);

// The wider surfaces must be untouched.
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='schedule').click()`);
await wait(2500);
const sched = await ev(`[...document.querySelectorAll('#scheduleList .nm')].map(n=>n.textContent.trim()).slice(0,3)`);
console.log('  schedule:', JSON.stringify(sched));
check('schedule keeps full names', !sched.length || sched.some(s => /\p{Ll}/u.test(s)), JSON.stringify(sched));
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click();
          [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='ms').click()`);
await wait(5000);

console.log('\n=== auto brackets from the two ranking tables ===');
await ev(`document.querySelector('[data-pmode="world"]').click()`);
await wait(2000);
const modeUi = await ev(`({
  active: [...document.querySelectorAll('.pmode.is-active')].map(b=>b.dataset.pmode).join(','),
  copyShown: !document.querySelector('#predictCopy').hidden,
  clearShown: !document.querySelector('#predictClear').hidden,
  locked: document.querySelectorAll('#drawCanvas .pnode.is-locked').length,
  score: document.querySelector('#predictScore').textContent
})`);
console.log(' ', JSON.stringify(modeUi));
check('world mode selected', modeUi.active === 'world', modeUi.active);
check('"Use as mine" appears, "Clear" hides', modeUi.copyShown && !modeUi.clearShown, JSON.stringify(modeUi));
check('auto bracket is read-only', modeUi.locked >= 63, modeUi.locked+'');

// wait for the ranking walk to finish
for (let i = 0; i < 45; i++) {
  const done = await ev(`!!(window.__ok = (JSON.parse(localStorage.getItem('wc26.ranks.world:ms')||'{}').v||{}).__done)`);
  if (done) break;
  await wait(2000);
}
await ev(`document.querySelector('[data-pmode="yours"]').click(); document.querySelector('[data-pmode="world"]').click()`);
await wait(1500);
const world = await ev(`(() => {
  const idx = (JSON.parse(localStorage.getItem('wc26.ranks.world:ms')||'{}').v)||{};
  const ranked = Object.keys(idx).filter(k=>k!=='__done').length;
  return { ranked, done: !!idx.__done,
    champ: document.querySelector('#drawCanvas .pchamp .bn').textContent.trim(),
    score: document.querySelector('#predictScore').textContent.trim(),
    top: Object.entries(idx).filter(([k,v])=>v===1||v===2).length };
})()`);
console.log(' ', JSON.stringify(world));
check('world ranking index loaded', world.done && world.ranked > 40, world.ranked + ' entries');
check('ranking bracket names a champion', world.champ && world.champ !== 'Not decided yet', world.champ);
check('champion is the world no. 1 or 2 seed path', !!world.champ);

await ev(`document.querySelector('[data-pmode="race"]').click()`);
await wait(2000);
for (let i = 0; i < 45; i++) {
  const done = await ev(`!!((JSON.parse(localStorage.getItem('wc26.ranks.race:ms')||'{}').v||{}).__done)`);
  if (done) break;
  await wait(2000);
}
await ev(`document.querySelector('[data-pmode="yours"]').click(); document.querySelector('[data-pmode="race"]').click()`);
await wait(1500);
const race = await ev(`(() => {
  const idx = (JSON.parse(localStorage.getItem('wc26.ranks.race:ms')||'{}').v)||{};
  return { ranked: Object.keys(idx).filter(k=>k!=='__done').length, done: !!idx.__done,
    champ: document.querySelector('#drawCanvas .pchamp .bn').textContent.trim(),
    score: document.querySelector('#predictScore').textContent.trim() };
})()`);
console.log(' ', JSON.stringify(race));
check('race index is a different table', race.done && race.ranked > 40, race.ranked + ' entries');
check('race bracket names a champion', race.champ && race.champ !== 'Not decided yet', race.champ);
check('race label shown in the readout', /Race to Finals/.test(race.score), race.score);
console.log(`  world champion: ${world.champ}   |   race champion: ${race.champ}`);

console.log('\n=== "Use as mine" copies the auto bracket into your sheet ===');
const copied = await ev(`(() => {
  document.querySelector('#predictCopy').click();
  return { mode: [...document.querySelectorAll('.pmode.is-active')].map(b=>b.dataset.pmode).join(','),
           picks: Object.keys(JSON.parse(localStorage.getItem('wc26.predict')||'{}').ms||{}).length,
           champ: document.querySelector('#drawCanvas .pchamp .bn').textContent.trim(),
           score: document.querySelector('#predictScore').textContent.trim() };
})()`);
console.log(' ', JSON.stringify(copied));
check('switches back to your sheet', copied.mode === 'yours', copied.mode);
check('all 63 copied', copied.picks === 63, copied.picks+'');
check('same champion carried over', copied.champ === race.champ, `${copied.champ} vs ${race.champ}`);

console.log('\n=== semi-final routes traced for the PNG ===');
const routes = await ev(`(() => {
  const d = state.draws[state.drawCat];
  const res = resolvePredictions(d, state.drawMode);
  const paths = semiFinalPaths(d, res);
  const sfCol = d.maxCol - 1;
  const out = paths.map(p => {
    const cols = p.cells.map(c => c.c);
    const top = p.cells[0];
    // At every cell, the half the route claims must actually hold this player.
    const player = res.teams[top.c + '-' + top.r][top.side - 1];
    const key = entryKey(player);
    const sidesMatch = p.cells.every(c =>
      entryKey(res.teams[c.c + '-' + c.r][c.side - 1]) === key);
    // Contiguous, one cell per column, descending to the entry round.
    const contiguous = cols.every((c, i) => c === cols[0] - i) && cols[cols.length - 1] === 0;
    // A route may run no further than the player actually got.
    const lastWon = res.winner[top.c + '-' + top.r];
    const stoppedCorrectly = top.c === d.maxCol || entryKey(lastWon) !== key;
    return { name: teamName(player), colour: p.colour, top: top.c,
             champion: !!p.champion, sidesMatch, contiguous, stoppedCorrectly };
  });
  return { n: out.length, sfCol, maxCol: d.maxCol,
           colours: new Set(out.map(o => o.colour)).size,
           tops: out.map(o => o.top),
           reachedFinal: out.filter(o => o.top === d.maxCol).length,
           champions: out.filter(o => o.champion).length,
           allMatch: out.every(o => o.sidesMatch),
           allContiguous: out.every(o => o.contiguous),
           allStopCorrectly: out.every(o => o.stoppedCorrectly),
           names: out.map(o => o.name) };
})()`);
console.log(' ', JSON.stringify(routes));
check('one route per semi-finalist', routes.n === 4, routes.n+'');
check('four distinct colours', routes.colours === 4, routes.colours+'');
check('each route is contiguous down to the entry round', routes.allContiguous, JSON.stringify(routes.tops));
check('each cell claims the half that really holds the player', routes.allMatch);
// The point of this change: a route runs on past the semi-final only as far as
// that player actually got.
check('both finalists carry on to the Final card', routes.reachedFinal === 2, String(routes.reachedFinal));
check('the two beaten semi-finalists stop at the semi-final',
  routes.tops.filter(t => t === routes.sfCol).length === 2, JSON.stringify(routes.tops));
check('no route runs past where that player got', routes.allStopCorrectly);
check('exactly one route is flagged as the champion', routes.champions === 1, String(routes.champions));

// A half-filled sheet must simply trace fewer routes, not throw.
const partial = await ev(`(() => {
  const d = state.draws[state.drawCat];
  const saved = JSON.stringify(state.predict[state.drawCat]);
  const picks = state.predict[state.drawCat];
  const codes = Object.keys(picks);
  for (const c of codes.slice(0, 40)) delete picks[c];
  const res = resolvePredictions(d, 'yours');
  const n = semiFinalPaths(d, res).length;
  state.predict[state.drawCat] = JSON.parse(saved);
  return n;
})()`);
check('a half-filled sheet traces fewer routes without erroring',
  typeof partial === 'number' && partial < 4, String(partial));

console.log('\n=== PNG export ===');
const before = fs.readdirSync(DL).length;
await ev(`document.querySelector('#predictPng').click()`);
await wait(9000);
const files = fs.readdirSync(DL).filter(f => f.endsWith('.png'));
const png = files[0] && fs.statSync(path.join(DL, files[0]));
console.log('  downloaded:', files, png ? png.size + ' bytes' : '');
check('a PNG was produced', files.length > before, files.join(','));
check('filename carries discipline and date', /^wc2026-ms-predictions-\d{4}-\d{2}-\d{2}\.png$/.test(files[0]||''), files[0]||'');
// The filename must agree with the date printed inside the image — both are
// the local day the picks were made, not the UTC one.
const localToday = await ev(`todayIso()`);
check('and the date is the local day, matching the caption',
  (files[0]||'').includes(localToday), `${files[0]} vs ${localToday}`);
check('image is a real render, not a blank', png && png.size > 60000, png ? png.size+' bytes' : 'missing');
if (png) {
  const head = fs.readFileSync(path.join(DL, files[0])).subarray(0, 24);
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  console.log(`  dimensions: ${w}x${h}`);
  check('exported at 2x', w > 2800 && h > 3000, `${w}x${h}`);
}

console.log('\n=== clear, and the bracket view keeps its own camera ===');
const cleared = await ev(`(() => { document.querySelector('#predictClear').click();
  return { picks: Object.keys(JSON.parse(localStorage.getItem('wc26.predict')||'{}').ms||{}).length,
           champ: document.querySelector('#drawCanvas .pchamp .bn').textContent.trim() }; })()`);
check('clear empties the sheet', cleared.picks === 0 && cleared.champ === 'Not decided yet', JSON.stringify(cleared));

// Results and the prediction sheet are modes of ONE view now, so they share a
// camera on purpose: flipping between them must not move the draw. (The old
// assertion here was the opposite — that the two views had separate cameras.)
const cams = await ev(`(() => {
  document.querySelector('#zoomIn').click(); document.querySelector('#zoomIn').click();
  const predict = document.querySelector('#zoomLevel').textContent;
  const pan = document.querySelector('#drawCanvas').style.transform;
  [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='results').click();
  const results = document.querySelector('#zoomLevel').textContent;
  const panAfter = document.querySelector('#drawCanvas').style.transform;
  [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='yours').click();
  return { predict, results, samePan: pan === panAfter };
})()`);
console.log(' ', JSON.stringify(cams));
check('flipping to Results holds the same zoom', cams.predict === cams.results, JSON.stringify(cams));
check('…and the same pan', cams.samePan === true, JSON.stringify(cams));

console.log('\n=== every draw opens at 100%, and zoom survives a view switch ===');
// A different discipline, so this is genuinely a fresh draw. (Clicking the chip
// you are already on is deliberately a no-op — it must not throw away your zoom.)
const zSame = await ev(`(() => { const before = document.querySelector('#zoomLevel').textContent;
  [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='ms').click();
  return { before, after: document.querySelector('#zoomLevel').textContent }; })()`);
check('re-clicking the current discipline keeps your zoom', zSame.before === zSame.after, JSON.stringify(zSame));
await ev(`[...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='ws').click()`);
await wait(6000);
const z0 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('a freshly opened draw is at 100%', z0 === '100%', String(z0));
await ev(`document.querySelector('#zoomIn').click()`);
const z1 = await ev(`document.querySelector('#zoomLevel').textContent`);
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click()`);
await wait(1500);
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await wait(1500);
const z2 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('zoom survives tabbing away and back', z2 === z1, `${z1} -> ${z2}`);
await ev(`[...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='wd').click()`);
await wait(6000);
const z3 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('switching discipline resets to 100%', z3 === '100%', String(z3));
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await wait(3000);
check('the bracket opens at 100% too',
  (await ev(`document.querySelector('#zoomLevel').textContent`)) === '100%');

console.log('\n=== byes read as information, not as broken cells ===');
// The real bracket, which is where byes are drawn.
await ev(`[...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='results').click()`);
await ev(`[...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='wd').click()`);
await wait(7000);
const byes = await ev(`(() => {
  const n = document.querySelector('#drawCanvas .bnode.is-bye');
  const cs = getComputedStyle(n);
  return { opacity: cs.opacity, border: cs.borderTopStyle,
           text: [...n.querySelectorAll('.bn')].map(x=>x.textContent.trim()),
           count: document.querySelectorAll('#drawCanvas .bnode.is-bye').length };
})()`);
console.log(' ', JSON.stringify(byes));
check('bye cards are no longer dimmed', byes.opacity === '1', byes.opacity);
check('bye cards are marked with a dashed border', byes.border === 'dashed', byes.border);
check('the empty half says "Bye"', byes.text.includes('Bye'), JSON.stringify(byes.text));
check('WD has 16 byes', byes.count === 16, byes.count+'');
const carried = await ev(`(() => {
  const d = state.draws.wd; let ok = 0, tot = 0;
  for (let r = 0; r < cellsInCol(d, 0); r++) {
    const m = d.cells['0-' + r];
    if (!m || !d.byeCodes.has(String(m.code))) continue;
    tot++;
    const pair = entryKey(m.team1) ? teamName(m.team1) : teamName(m.team2);
    const nx = d.cells['1-' + Math.floor(r/2)];
    if (nx && [teamName(nx.team1), teamName(nx.team2)].includes(pair)) ok++;
  }
  return { tot, ok };
})()`);
check('the bracket carries every bye into round two',
  carried.ok === 16 && carried.tot === 16, JSON.stringify(carried));
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click();
          [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='ms').click()`);
await wait(6000);

console.log('\n=== hotkeys reach the new view ===');
await ev(`document.body.focus()`);
await key('ArrowRight','ArrowRight',39);          // draw -> matches (wraps)
const wrapped = await ev(`[...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view`);
check('ArrowRight wraps Draw round to Follow Matches', wrapped === 'matches', String(wrapped));
await key('ArrowLeft','ArrowLeft',37);
const backToPredict = await ev(`[...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view`);
check('ArrowLeft returns to Draw', backToPredict === 'draw', String(backToPredict));
const catBefore = await ev(`state.drawCat`);
await key('Shift','ShiftLeft',16);
await wait(3500);
const catStep = await ev(`({ dcat: [...document.querySelectorAll('.dcat.is-active')].map(b=>b.dataset.dcat).join(','),
                             state: state.drawCat })`);
console.log(' ', JSON.stringify(catStep));
// There is one draw selector now, shared by every mode of the view.
check('Shift steps the drawn discipline', catStep.dcat !== catBefore && catStep.dcat === catStep.state,
  `${catBefore} -> ${JSON.stringify(catStep)}`);
await key('0','Digit0',48);
const zeroed = await ev(`document.querySelector('#zoomLevel').textContent`);
check('0 resets the zoom', zeroed === '100%', String(zeroed));

console.log('\n=== survives a reload, on the draw you were last on ===');
// Put the view back on the prediction sheet, note which draw we are on, and
// make a pick there. Reloading from a URL that does NOT pin a discipline must
// come back to the same draw with the pick still drawn.
await ev(`[...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='yours').click()`);
await wait(2500);
const pickCat = await ev(`(() => {
  const n = [...document.querySelectorAll('#drawCanvas .pnode')]
    .find(n => !n.classList.contains('is-locked'));
  if (n) n.querySelectorAll('.pnode-side')[0].click();
  return state.drawCat;
})()`);
await wait(800);
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=all&v=predict` }, sessionId);
await wait(12000);
const after = await ev(`({
  view: [...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view,
  dcat: [...document.querySelectorAll('.dcat.is-active')].map(b=>b.dataset.dcat).join(','),
  picks: Object.keys(JSON.parse(localStorage.getItem('wc26.predict')||'{}')['${pickCat}']||{}).length,
  nodes: document.querySelectorAll('#drawCanvas .pnode').length,
  marked: document.querySelectorAll('#drawCanvas .pnode-side.is-pick').length
})`);
console.log(' ', JSON.stringify({ pickCat, ...after }));
check('comes back on the same draw', after.dcat === pickCat, `${after.dcat} vs ${pickCat}`);
check('picks survive a reload', after.picks >= 1, JSON.stringify(after));
check('and are drawn again', after.marked >= 1, after.marked+'');

// …but a link that names a discipline still wins.
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=xd&v=predict` }, sessionId);
await wait(12000);
const pinned = await ev(`[...document.querySelectorAll('.dcat.is-active')].map(b=>b.dataset.dcat).join(',')`);
check('a shared link overrides the remembered draw', pinned === 'xd', String(pinned));

const exc = events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails.text+' '+(e.params.exceptionDetails.exception?.description||''));
const errs = events.filter(e=>e.method==='Log.entryAdded'&&e.params.entry.level==='error').map(e=>e.params.entry.text);
console.log('\n=== errors ===');
exc.slice(0,6).forEach(m=>console.log('  EXC '+m));
errs.slice(0,6).forEach(m=>console.log('  LOG '+m));
check('no uncaught exceptions', exc.length===0, exc.length+'');
check('no error logs', errs.length===0, errs.length+'');

console.log(' ', fixtureReport(fx));
console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill(); server.close();
try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
process.exit(fail?1:0);
