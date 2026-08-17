/* Validate v3: zoom hotkeys, H2H rankings, season strip. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8776, DBG = 9346;
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

const profile = path.join(process.env.TEMP, 'wc26-v3-' + Date.now());
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
  await new Promise(r => setTimeout(r, 500));
};

await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945&c=ms&v=players` }, sessionId);
await new Promise(r => setTimeout(r, 12000));
// The player detail now lives behind the Players sub-tab of Follow Players.
await ev(`(() => { const b = [...document.querySelectorAll('.subtab')].find(x => x.dataset.ptab === 'list'); if (b) b.click(); })()`);
await new Promise(r => setTimeout(r, 12000));

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

console.log('=== season strip (Players view) ===');
const s = await ev(`(() => {
  const sq=[...document.querySelectorAll('#seasonBox .sq')];
  return { count: sq.length,
    title: (document.querySelector('#seasonBox .season-title')||{}).textContent||'',
    items: sq.map(n=>({ t:(n.querySelector('.tn')||{}).textContent,
                        r:(n.querySelector('.box')||{}).textContent,
                        cls:(n.querySelector('.box')||{}).className,
                        lv:(n.querySelector('.lv')||{}).textContent })),
    tips: sq.slice(0,2).map(n=>n.getAttribute('title')) };
})()`);
console.log('  title:', s.title, '| squares:', s.count);
s.items.forEach(i => console.log(`   ${String(i.t).padEnd(22)} ${String(i.r).padEnd(4)} ${String(i.lv).padEnd(12)} ${i.cls}`));
console.log('  tip:', s.tips[0]);
check('season squares rendered', s.count >= 8, s.count+'');
check('results labelled W/F/SF/QF/R..', s.items.every(i=>/^(W|F|SF|QF|R16|R32|R64|Q|–)$/.test(i.r)), s.items.map(i=>i.r).join(','));
check('levels shown', s.items.some(i=>/Super|Worlds|Team|Continental/.test(i.lv||'')), s.items.map(i=>i.lv).filter(Boolean).slice(0,3).join('/'));
check('colour tiers applied', s.items.every(i=>/\br-(w|f|sf|qf|r16|r1|q|na)\b/.test(i.cls||'')));
check('sponsor + year stripped from names', s.items.every(i=>!/\b20\d\d\b/.test(i.t||'')), s.items.map(i=>i.t).slice(0,3).join('/'));
check('tooltip has full name + result', /—/.test(s.tips[0]||''), s.tips[0]||'');

console.log('\n=== H2H rankings + season for both ===');
await ev(`(() => { const c=[...document.querySelectorAll('button.opp')].find(x=>/ANTONSEN/i.test(x.textContent));
  (c||document.querySelector('button.opp')).click(); })()`);
await new Promise(r => setTimeout(r, 12000));
const h = await ev(`({
  open: !document.querySelector('#h2h').hidden,
  ranks: [...document.querySelectorAll('.h2h-rank')].map(n=>n.textContent.replace(/\\s+/g,' ').trim()),
  seasonsA: document.querySelectorAll('#h2hSeasonA .sq').length,
  seasonsB: document.querySelectorAll('#h2hSeasonB .sq').length,
  titleA: (document.querySelector('#h2hSeasonA .season-title')||{}).textContent||'',
  titleB: (document.querySelector('#h2hSeasonB .season-title')||{}).textContent||'',
  meetings: document.querySelectorAll('.h2h-m').length
})`);
console.log(' ', JSON.stringify(h, null, 1));
check('H2H open', h.open);
check('rankings shown for both', h.ranks.length >= 1 && /#\d+/.test(h.ranks[0]), h.ranks[0]||'');
check('both rankings present in a row', (h.ranks[0]||'').match(/#\d+/g)?.length === 2, h.ranks[0]||'');
check('season strip for player A', h.seasonsA > 0, h.seasonsA+'');
check('season strip for player B', h.seasonsB > 0, h.seasonsB+'');
check('season strips labelled by name', /season/i.test(h.titleA) && /season/i.test(h.titleB), h.titleA);
await ev(`document.querySelector('#closeH2h').click()`);

console.log('\n=== zoom hotkeys ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await new Promise(r => setTimeout(r, 3000));
const z0 = await ev(`document.querySelector('#zoomLevel').textContent`);
await key('+','Equal',187);
const z1 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('"+" zooms in', z0 !== z1, `${z0} → ${z1}`);
await key('-','Minus',189);
const z2 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('"-" zooms out', z1 !== z2, `${z1} → ${z2}`);
await key('+','NumpadAdd',107);
const z3 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('numpad + zooms in', z2 !== z3, `${z2} → ${z3}`);
await key('-','NumpadSubtract',109);
const z4 = await ev(`document.querySelector('#zoomLevel').textContent`);
check('numpad - zooms out', z3 !== z4, `${z3} → ${z4}`);
const stillBracket = await ev(`[...document.querySelectorAll('.tab')].find(t=>t.classList.contains('is-active')).dataset.view`);
check('zoom keys did not change view', stillBracket === 'draw', String(stillBracket));

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
