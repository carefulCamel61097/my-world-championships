/* Validate v5: round dividers, themed scrollbars, remove buttons,
   wheel-scrolls-the-bracket, and the 100% zoom hotkey. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8780, DBG = 9352;
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

const profile = path.join(process.env.TEMP, 'wc26-v5-' + Date.now());
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
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r?.result?.value;
};
const key = async (k, code, kc) => {
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:k, code, windowsVirtualKeyCode:kc, text:k.length===1?k:undefined }, sessionId);
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:k, code, windowsVirtualKeyCode:kc }, sessionId);
  await new Promise(r => setTimeout(r, 500));
};
const wheel = async (x, y, dx, dy, mods = 0) => {
  await send('Input.dispatchMouseEvent',
    { type:'mouseWheel', x, y, deltaX:dx, deltaY:dy, modifiers: mods }, sessionId);
  await new Promise(r => setTimeout(r, 350));
};

// two singles + a doubles pair, so the remove-button partner rule gets exercised
await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945,68322,87857,55942,58089,97115,85563,69345,34810,49932,59695,69253,77042,86672,78890,79517,91554,81599,59880&c=all&v=players` }, sessionId);
await new Promise(r => setTimeout(r, 12000));
// The player detail now lives behind the Players sub-tab of Follow Players.
await ev(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => x.dataset.ptab === 'list'); if (b) b.click(); })()`);
await new Promise(r => setTimeout(r, 4500));

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

console.log('=== round dividers ===');
const sep = await ev(`({
  blocks: document.querySelectorAll('.round-block').length,
  seps: document.querySelectorAll('.round-sep').length,
  visible: (()=>{ const s=document.querySelector('.round-sep'); if(!s) return null;
    const cs=getComputedStyle(s,'::before'); return { h: cs.height, bg: cs.backgroundColor }; })()
})`);
console.log(' ', JSON.stringify(sep));
check('a divider between every pair of rounds', sep.seps === sep.blocks - 1, `${sep.seps} seps / ${sep.blocks} blocks`);
check('divider rule is drawn', sep.visible && sep.visible.h !== '0px' && sep.visible.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(sep.visible));

console.log('\n=== themed scrollbars ===');
const sb = await ev(`(() => {
  const el=document.querySelector('.mylist');
  const cs=getComputedStyle(el);
  return { width: cs.scrollbarWidth, color: cs.scrollbarColor,
           overflow: cs.overflowY, scrollable: el.scrollHeight > el.clientHeight };
})()`);
console.log(' ', JSON.stringify(sb));
check('scrollbar-width thin', sb.width === 'thin', sb.width);
check('scrollbar-color themed', /rgb/.test(sb.color||''), sb.color);
check('list actually overflows (scrollbar present)', sb.scrollable === true, JSON.stringify(sb.scrollable));

console.log('\n=== remove buttons ===');
const rm = await ev(`({
  rows: document.querySelectorAll('.mp').length,
  buttons: document.querySelectorAll('.mp .mp-x').length,
  labels: [...document.querySelectorAll('.mp .mp-nm')].map(n=>n.textContent.trim().split('\\n')[0])
})`);
console.log(' ', JSON.stringify(rm));
check('every row has a remove button', rm.buttons === rm.rows && rm.rows === 19, `${rm.buttons}/${rm.rows}`);

// remove a single → one row goes
const afterSingle = await ev(`(() => {
  const rows=[...document.querySelectorAll('.mp')];
  const target=rows.find(r=>/ANTONSEN/i.test(r.textContent));
  target.querySelector('.mp-x').click();
  return { rows: document.querySelectorAll('.mp').length,
           names: [...document.querySelectorAll('.mp .mp-nm')].map(n=>n.textContent.trim().split('\\n')[0]) };
})()`);
console.log('  after removing a single:', JSON.stringify(afterSingle));
check('removing a single drops one row', afterSingle.rows === 18, afterSingle.rows+'');
check('right player removed', !afterSingle.names.some(n=>/ANTONSEN/i.test(n)), afterSingle.names.join(','));

// remove half a doubles pair → both halves go
const afterPair = await ev(`(() => {
  const rows=[...document.querySelectorAll('.mp')];
  const target=rows.find(r=>/LIU Sheng Shu/i.test(r.textContent));
  target.querySelector('.mp-x').click();
  return { rows: document.querySelectorAll('.mp').length,
           names: [...document.querySelectorAll('.mp .mp-nm')].map(n=>n.textContent.trim().split('\\n')[0]) };
})()`);
console.log('  after removing half a pair:', JSON.stringify(afterPair));
check('removing one of a pair removes both', afterPair.rows === 16, afterPair.rows+'');
check('partner gone too', !afterPair.names.some(n=>/TAN Ning/i.test(n)), afterPair.names.join(','));
const persisted = await ev(`JSON.parse(localStorage.getItem('wc26.players')||'[]').length`);
check('removal persisted', persisted === 16, persisted+' stored');
const clickStillSelects = await ev(`(() => {
  const r=document.querySelector('.mp'); r.click();
  return r.classList.contains('is-active'); })()`);
check('row click still selects (X did not swallow it)', clickStillSelects);

console.log('\n=== bracket: wheel scrolls, ctrl+wheel zooms ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await new Promise(r => setTimeout(r, 3500));
await ev(`document.querySelector('#zoomIn').click(); document.querySelector('#zoomIn').click();`);
const vpBox = await ev(`(() => { const r=document.querySelector('#drawViewport').getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
const t0 = await ev(`({ t: document.querySelector('#drawCanvas').style.transform, z: document.querySelector('#zoomLevel').textContent })`);
await wheel(vpBox.x, vpBox.y, 0, 220);
const t1 = await ev(`({ t: document.querySelector('#drawCanvas').style.transform, z: document.querySelector('#zoomLevel').textContent })`);
const ty = s => parseFloat((s.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)||[])[2]||'0');
const tx = s => parseFloat((s.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)||[])[1]||'0');
console.log(`  wheel down: y ${ty(t0.t)} → ${ty(t1.t)}, zoom ${t0.z} → ${t1.z}`);
check('wheel down moves the view down', ty(t1.t) < ty(t0.t), `${ty(t0.t)} → ${ty(t1.t)}`);
check('wheel does not zoom', t0.z === t1.z, `${t0.z} → ${t1.z}`);

await wheel(vpBox.x, vpBox.y, 200, 0);
const t2 = await ev(`document.querySelector('#drawCanvas').style.transform`);
console.log(`  wheel right: x ${tx(t1.t)} → ${tx(t2)}`);
check('horizontal wheel moves the view right', tx(t2) < tx(t1.t), `${tx(t1.t)} → ${tx(t2)}`);

const zBefore = await ev(`document.querySelector('#zoomLevel').textContent`);
await wheel(vpBox.x, vpBox.y, 0, -120, 2 /* ctrl */);
const zAfter = await ev(`document.querySelector('#zoomLevel').textContent`);
check('ctrl+wheel still zooms', zBefore !== zAfter, `${zBefore} → ${zAfter}`);

console.log('\n=== 0 resets to 100% ===');
await key('0','Digit0',48);
const z100 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('"0" sets zoom to 100%', z100 === '100%', z100);
await ev(`document.querySelector('#zoomFit').click()`);
await key('0','Numpad0',96);
const z100b = await ev(`document.querySelector('#zoomLevel').textContent`);
check('numpad 0 sets zoom to 100%', z100b === '100%', z100b);

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
