/* Validate the seven v2 changes in a real browser. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8772, DBG = 9342;
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

const profile = path.join(process.env.TEMP, 'wc26-v2-' + Date.now());
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1400,1000',
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
const key = async (k, code, keyCode) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await new Promise(r => setTimeout(r, 700));
};

await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945&c=ms&v=players` }, sessionId);
await new Promise(r => setTimeout(r, 12000));
// The player detail now lives behind the Players sub-tab of Follow Players.
await ev(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => x.dataset.ptab === 'list'); if (b) b.click(); })()`);
await new Promise(r => setTimeout(r, 4500));

let fail = 0;
const check = (label, cond, extra = '') => { if (!cond) fail++; console.log(`${cond?'PASS':'FAIL'}  ${label}${extra?'  — '+extra:''}`); };

console.log('=== 1. seeds in brackets ===');
const seeds = await ev(`({
  cardSeeds: [...document.querySelectorAll('.seed')].map(n=>n.textContent.trim()).filter(Boolean).slice(0,4),
  chipSeeds: [...document.querySelectorAll('.opp .sd')].map(n=>n.textContent.trim()).slice(0,4)
})`);
console.log(' ', JSON.stringify(seeds));
check('match-card seeds bracketed', seeds.cardSeeds.every(s=>/^\[\d+\]$/.test(s)), seeds.cardSeeds.join(','));
check('opponent-chip seeds bracketed', seeds.chipSeeds.length===0 || seeds.chipSeeds.every(s=>/^\[\d+\]$/.test(s)), seeds.chipSeeds.join(','));

console.log('\n=== 2. opponents ordered by BWF ranking ===');
const ord = await ev(`(() => {
  const blocks=[...document.querySelectorAll('.round-block')];
  const b=blocks.find(x=>x.querySelectorAll('.opp').length>=4);
  if(!b) return {none:true};
  const ranks=[...b.querySelectorAll('.opp .rk')].map(n=>parseInt(n.textContent.replace('#','')));
  return { round:(b.querySelector('b')||{}).textContent, chips:b.querySelectorAll('.opp').length,
           ranks, sorted: ranks.every((v,i)=>i===0||ranks[i-1]<=v) };
})()`);
console.log(' ', JSON.stringify(ord));
check('ranks present on chips', !ord.none && ord.ranks.length>0, ord.ranks?ord.ranks.length+' ranked':'');
check('ranks ascending', !!ord.sorted);

console.log('\n=== 3+4. round separation ===');
const rb = await ev(`({
  blocks: document.querySelectorAll('.round-block').length,
  counts: [...document.querySelectorAll('.rb-count')].map(n=>n.textContent.trim()).slice(0,3),
  clickableChips: document.querySelectorAll('button.opp').length,
  h2hCues: document.querySelectorAll('.h2h-cue').length
})`);
console.log(' ', JSON.stringify(rb));
check('round blocks rendered', rb.blocks === 6, rb.blocks+'');
check('opponent chips are buttons', rb.clickableChips > 0, rb.clickableChips+'');
check('current-round match shows H2H cue', rb.h2hCues > 0, rb.h2hCues+'');

console.log('\n=== 5. head-to-head popup (click a chip) ===');
await ev(`document.querySelector('button.opp').click()`);
await new Promise(r => setTimeout(r, 6000));
const h2h = await ev(`({
  open: !document.querySelector('#h2h').hidden,
  title: (document.querySelector('#h2hTitle')||{}).textContent||'',
  tally: (document.querySelector('.h2h-tally')||{}).textContent||'',
  meetings: document.querySelectorAll('.h2h-m').length,
  none: !!document.querySelector('.h2h-none')
})`);
console.log(' ', JSON.stringify(h2h));
check('H2H opens', h2h.open);
check('H2H resolved (tally or "never met")', /\d+–\d+|\d+-\d+/.test(h2h.tally) || h2h.none, h2h.tally);
await ev(`document.querySelector('#closeH2h').click()`);

console.log('\n=== 6. hotkeys ===');
await key('ArrowRight','ArrowRight',39);
const afterRight = await ev(`document.documentElement.dataset.v||[...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view`);
check('ArrowRight → Draw view', afterRight === 'draw', String(afterRight));
await key('ArrowLeft','ArrowLeft',37);
const afterLeft = await ev(`[...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view`);
check('ArrowLeft → back to Follow Players', afterLeft === 'players', String(afterLeft));
const catBefore = await ev(`[...document.querySelectorAll('.cat.is-active')].map(c=>c.dataset.cat).filter(c=>c!=='all').join(',')`);
await key('Shift','ShiftLeft',16);
await new Promise(r=>setTimeout(r,2500));
const catAfter = await ev(`[...document.querySelectorAll('.cat.is-active')].map(c=>c.dataset.cat).filter(c=>c!=='all').join(',')`);
check('Shift → next discipline', catBefore==='ms' && catAfter==='ws', `${catBefore}→${catAfter}`);
await key('Shift','ShiftLeft',16); await new Promise(r=>setTimeout(r,2000));
await key('Shift','ShiftLeft',16); await new Promise(r=>setTimeout(r,2000));
await key('Shift','ShiftLeft',16); await new Promise(r=>setTimeout(r,2000));
await key('Shift','ShiftLeft',16); await new Promise(r=>setTimeout(r,2000));
await key('Shift','ShiftLeft',16); await new Promise(r=>setTimeout(r,3000));
const catWrap = await ev(`[...document.querySelectorAll('.cat.is-active')].map(c=>c.dataset.cat).filter(c=>c!=='all').join(',')`);
check('Shift cycles through all and back to ms', catWrap === 'ms', String(catWrap));

console.log('\n=== 7. bracket view ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await new Promise(r => setTimeout(r, 4000));
const br = await ev(`({
  nodes: document.querySelectorAll('.bnode').length,
  lines: document.querySelectorAll('.bline').length,
  labels: [...document.querySelectorAll('.bcol-label')].map(n=>n.textContent),
  mine: document.querySelectorAll('.bnode.is-mine').length,
  w: document.querySelector('#drawCanvas').style.width,
  h: document.querySelector('#drawCanvas').style.height,
  zoom: (document.querySelector('#zoomLevel')||{}).textContent,
  transform: document.querySelector('#drawCanvas').style.transform
})`);
console.log(' ', JSON.stringify(br));
check('63 match nodes', br.nodes === 63, br.nodes+'');
check('connectors drawn (31 elbows x4)', br.lines === 124, br.lines+'');
check('column labels', br.labels.length === 6, br.labels.join(','));
check('canvas sized', parseFloat(br.w) > 1000 && parseFloat(br.h) > 1000, br.w+'x'+br.h);
check('transform applied', /scale/.test(br.transform||''));

const zoomed = await ev(`(() => { const b=document.querySelector('#zoomLevel').textContent;
  document.querySelector('#zoomIn').click();
  return { before:b, after: document.querySelector('#zoomLevel').textContent }; })()`);
check('zoom in changes level', zoomed.before !== zoomed.after, JSON.stringify(zoomed));

const exceptions = events.filter(e => e.method==='Runtime.exceptionThrown')
  .map(e => e.params.exceptionDetails.text+' '+(e.params.exceptionDetails.exception?.description||''));
const errLogs = events.filter(e => e.method==='Log.entryAdded' && e.params.entry.level==='error').map(e => e.params.entry.text);
console.log('\n=== errors ===');
exceptions.slice(0,6).forEach(m=>console.log('  EXC '+m));
errLogs.slice(0,6).forEach(m=>console.log('  LOG '+m));
check('no uncaught exceptions', exceptions.length===0, exceptions.length+'');
check('no error logs', errLogs.length===0, errLogs.length+'');

console.log(' ', fixtureReport(fx));
console.log(fail ? `\nFAILURES: ${fail}` : '\nALL CHECKS PASSED');
ws.close(); chrome.kill(); server.close();
try { fs.rmSync(profile, { recursive:true, force:true }); } catch {}
process.exit(fail?1:0);
