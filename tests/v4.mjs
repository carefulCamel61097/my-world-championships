/* Validate v4: season filtering + proportional fill, F hotkey,
   no drag-selection, bracket click → head-to-head. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8778, DBG = 9348;
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

const profile = path.join(process.env.TEMP, 'wc26-v4-' + Date.now());
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
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r?.result?.value;
};
const key = async (k, code, kc) => {
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:k, code, windowsVirtualKeyCode:kc, text:k.length===1?k:undefined }, sessionId);
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:k, code, windowsVirtualKeyCode:kc }, sessionId);
  await new Promise(r => setTimeout(r, 600));
};
const mouse = async (type, x, y, extra={}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button:'left', clickCount: extra.clickCount ?? 1, ...extra }, sessionId);

await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945&c=ms&v=players` }, sessionId);
await new Promise(r => setTimeout(r, 12000));
// The player detail now lives behind the Players sub-tab of Follow Players.
await ev(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => x.dataset.ptab === 'list'); if (b) b.click(); })()`);
await new Promise(r => setTimeout(r, 12000));

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

console.log('=== season filtering + proportional fill ===');
const s = await ev(`(() => {
  const sq=[...document.querySelectorAll('#seasonBox .sq')];
  return { count: sq.length,
    items: sq.map(n=>({ t:(n.querySelector('.tn')||{}).textContent,
                        r:(n.querySelector('.box')||{}).textContent,
                        pct:(n.querySelector('.box')||{}).style.getPropertyValue('--pct'),
                        lv:(n.querySelector('.lv')||{}).textContent })) };
})()`);
s.items.forEach(i => console.log(`   ${String(i.t).padEnd(20)} ${String(i.r).padEnd(4)} ${String(i.pct).padStart(5)} ${i.lv}`));
check('World Championships excluded', !s.items.some(i=>/World Champs/i.test(i.t||'')||/Worlds/i.test(i.lv||'')));
check('team events excluded', !s.items.some(i=>/Team/i.test(i.lv||'')||/Thomas|Uber|Sudirman/i.test(i.t||'')));
check('no "–" placeholders left', !s.items.some(i=>i.r==='–'), s.items.map(i=>i.r).join(','));
const byLabel = Object.fromEntries(s.items.map(i=>[i.r, i.pct]));
console.log('  fills:', JSON.stringify(byLabel));
check('W fills 100%', byLabel['W']==='100%', byLabel['W']||'n/a');
check('F fills 80%', byLabel['F']==='80%', byLabel['F']||'n/a');
check('SF fills 60%', byLabel['SF']==='60%', byLabel['SF']||'n/a');
check('QF fills 40%', byLabel['QF']==='40%', byLabel['QF']||'n/a');
check('R16 fills 20%', byLabel['R16']==='20%', byLabel['R16']||'n/a');
check('first-round exit keeps a sliver', byLabel['R32']==='13%', byLabel['R32']||'n/a');
const grad = await ev(`getComputedStyle(document.querySelector('#seasonBox .box')).backgroundImage`);
check('fill rendered as gradient', /linear-gradient/.test(grad||''), (grad||'').slice(0,60));

console.log('\n=== bracket: click → head-to-head ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await new Promise(r => setTimeout(r, 4000));
const pos = await ev(`(() => { const n=document.querySelector('.bnode.is-mine')||document.querySelector('.bnode');
  const r=n.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
console.log('  clicking node at', JSON.stringify(pos));
await mouse('mousePressed', pos.x, pos.y);
await mouse('mouseReleased', pos.x, pos.y);
await new Promise(r => setTimeout(r, 9000));
const clicked = await ev(`({ open: !document.querySelector('#h2h').hidden,
  title: (document.querySelector('#h2hTitle')||{}).textContent||'' })`);
console.log(' ', JSON.stringify(clicked));
check('bracket match click opens H2H', clicked.open, clicked.title);
await ev(`document.querySelector('#closeH2h').click()`);
await new Promise(r => setTimeout(r, 600));

console.log('\n=== bracket: drag pans, does not select, and does not open H2H ===');
const before = await ev(`document.querySelector('#drawCanvas').style.transform`);
// Drag up-and-left: the canvas starts pinned at the top-left clamp limit, so
// dragging down-right is correctly refused and would prove nothing.
await mouse('mousePressed', pos.x, pos.y);
for (let i = 1; i <= 6; i++) await mouse('mouseMoved', pos.x - i*14, pos.y - i*6);
await mouse('mouseReleased', pos.x - 84, pos.y - 36);
await new Promise(r => setTimeout(r, 900));
const after = await ev(`({ transform: document.querySelector('#drawCanvas').style.transform,
  sel: String(window.getSelection?window.getSelection().toString():''),
  h2hOpen: !document.querySelector('#h2h').hidden })`);
check('drag pans the canvas', before !== after.transform, `${before} → ${after.transform}`);
check('drag selects no text', after.sel === '', JSON.stringify(after.sel));
check('drag does not open H2H', !after.h2hOpen);
const us = await ev(`getComputedStyle(document.querySelector('#drawViewport')).userSelect`);
check('viewport is user-select:none', us === 'none', String(us));

console.log('\n=== double-click does not highlight ===');
await mouse('mousePressed', pos.x, pos.y, { clickCount: 2 });
await mouse('mouseReleased', pos.x, pos.y, { clickCount: 2 });
await new Promise(r => setTimeout(r, 800));
const dsel = await ev(`String(window.getSelection?window.getSelection().toString():'')`);
check('double-click selects nothing', dsel === '', JSON.stringify(dsel));
await ev(`if(!document.querySelector('#h2h').hidden) document.querySelector('#closeH2h').click()`);
await new Promise(r => setTimeout(r, 500));

console.log('\n=== F hotkey ===');
await ev(`document.querySelector('#zoomIn').click(); document.querySelector('#zoomIn').click();`);
const zBefore = await ev(`document.querySelector('#zoomLevel').textContent`);
await key('f','KeyF',70);
const zAfter = await ev(`document.querySelector('#zoomLevel').textContent`);
check('F fits the draw', zBefore !== zAfter, `${zBefore} → ${zAfter}`);
const fitMatches = await ev(`(() => { const z=document.querySelector('#zoomLevel').textContent;
  document.querySelector('#zoomFit').click();
  return z === document.querySelector('#zoomLevel').textContent; })()`);
check('F matches the Fit button', fitMatches);

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
