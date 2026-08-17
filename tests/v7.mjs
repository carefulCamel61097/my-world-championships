/* Validate v7: disciplines as independent toggles across every view. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8788, DBG = 9360;
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

const profile = path.join(process.env.TEMP, 'wc26-v7-' + Date.now());
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
const key = async (k, code, kc) => {
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:k, code, windowsVirtualKeyCode:kc, text:k.length===1?k:undefined }, sessionId);
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:k, code, windowsVirtualKeyCode:kc }, sessionId);
  await new Promise(r => setTimeout(r, 900));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

// SHI Yu Qi (MS) + LIU Sheng Shu / TAN Ning (WD)
await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945,81599,59880&v=players` }, sessionId);
await wait(12000);
// Follow Players opens on the follow list now; these first sections are about
// how the discipline chips filter the schedule.
await ev(`[...document.querySelectorAll('.subtab')].find(x=>x.dataset.ptab==='schedule').click()`);
await wait(4000);
// The schedule now opens on today; these sections are about how the discipline
// chips filter it, so widen it back to the whole week.
await ev(`[...document.querySelectorAll('#daybar .day')].find(b=>/All/.test(b.textContent)).click()`);
await wait(2500);

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

console.log('=== defaults: every discipline on ===');
const init = await ev(`({
  chips: [...document.querySelectorAll('.cat')].map(c=>c.dataset.cat+':'+(c.classList.contains('is-active')?'on':'off')),
  hash: location.hash,
  cards: document.querySelectorAll('.match').length,
  events: [...new Set([...document.querySelectorAll('.match-head')].flatMap(h=>[...h.querySelectorAll('span')].map(s=>s.textContent.trim())).filter(t=>['MS','WS','MD','WD','XD'].includes(t)))]
})`);
console.log(' ', JSON.stringify(init));
check('all five disciplines on by default', init.chips.filter(c=>/:on/.test(c)).length === 6, init.chips.join(' '));
check('hash records "all"', /c=all/.test(init.hash), init.hash);
check('schedule mixes disciplines', init.events.length >= 2, init.events.join(','));

console.log('\n=== toggling one off ===');
const offWd = await ev(`(() => {
  document.querySelector('[data-cat="wd"]').click();
  return { cards: document.querySelectorAll('.match').length,
    events: [...new Set([...document.querySelectorAll('.match-head')].flatMap(h=>[...h.querySelectorAll('span')].map(s=>s.textContent.trim())).filter(t=>['MS','WS','MD','WD','XD'].includes(t)))],
    chipOff: !document.querySelector('[data-cat="wd"]').classList.contains('is-active'),
    allChip: document.querySelector('[data-cat="all"]').classList.contains('is-active'),
    hash: location.hash };
})()`);
console.log(' ', JSON.stringify(offWd));
check('WD chip turns off', offWd.chipOff);
check('WD matches disappear', !offWd.events.includes('WD'), offWd.events.join(','));
check('MS matches remain', offWd.events.includes('MS'), offWd.events.join(','));
check('"All" chip goes inactive', !offWd.allChip);
check('hash lists the remaining disciplines', /c=ms,ws,md,xd/.test(offWd.hash), offWd.hash);

console.log('\n=== "All" restores everything ===');
const allBack = await ev(`(() => {
  document.querySelector('[data-cat="all"]').click();
  return { on: [...document.querySelectorAll('.cat')].filter(c=>c.classList.contains('is-active')).length,
    events: [...new Set([...document.querySelectorAll('.match-head')].flatMap(h=>[...h.querySelectorAll('span')].map(s=>s.textContent.trim())).filter(t=>['MS','WS','MD','WD','XD'].includes(t)))] };
})()`);
console.log(' ', JSON.stringify(allBack));
check('All turns every chip back on', allBack.on === 6, allBack.on+'');
check('WD matches return', allBack.events.includes('WD'), allBack.events.join(','));

console.log('\n=== cannot switch everything off ===');
const lastOne = await ev(`(() => {
  for (const c of ['ws','md','wd','xd']) document.querySelector('[data-cat="'+c+'"]').click();
  document.querySelector('[data-cat="ms"]').click();      // the last one — no-op
  return { on: [...document.querySelectorAll('.cat')].filter(c=>c.classList.contains('is-active')).map(c=>c.dataset.cat) };
})()`);
console.log(' ', JSON.stringify(lastOne));
check('last discipline cannot be turned off', lastOne.on.join(',') === 'ms', lastOne.on.join(','));

console.log('\n=== picker spans switched-on disciplines ===');
await ev(`document.querySelector('[data-cat="all"]').click()`);
await wait(1500);
await ev(`document.querySelector('#openPickerBtn').click()`);
await wait(1500);
const pick = await ev(`({
  rows: document.querySelectorAll('.pk').length,
  cats: [...new Set([...document.querySelectorAll('.pk-cat')].map(n=>n.textContent.trim()))].sort(),
  title: document.querySelector('#pickerCat').textContent,
  countries: document.querySelectorAll('.cchip').length
})`);
console.log(' ', JSON.stringify(pick));
check('picker lists every discipline', pick.cats.length === 5, pick.cats.join(','));
check('picker row count spans all draws', pick.rows > 200, pick.rows+' entries');
check('title says all disciplines', /all disciplines/i.test(pick.title), pick.title);

console.log('\n=== one country, every discipline ===');
const tha = await ev(`(() => {
  const chip=[...document.querySelectorAll('.cchip')].find(c=>/THA/.test(c.textContent));
  const n=parseInt(chip.querySelector('i').textContent);
  const before=new Set([...document.querySelectorAll('.pk.is-on')].map(r=>r.textContent));
  chip.click();
  const marked=[...document.querySelectorAll('.pk.is-on')].filter(r=>!before.has(r.textContent));
  return { expectedEntries: n, markedRows: marked.length,
    cats: [...new Set(marked.map(r=>r.querySelector('.pk-cat').textContent.trim()))].sort(),
    selected: JSON.parse(localStorage.getItem('wc26.players')||'[]').length };
})()`);
console.log(' ', JSON.stringify(tha));
check('country chip counts entries across disciplines', tha.markedRows === tha.expectedEntries,
  `${tha.markedRows} vs ${tha.expectedEntries}`);
check('one click spans several disciplines', tha.cats.length >= 2, tha.cats.join(','));
await ev(`(() => { const c=[...document.querySelectorAll('.cchip')].find(x=>/THA/.test(x.textContent)); c.click();
  document.querySelector('#donePicker').click(); })()`);
await wait(1200);

console.log('\n=== players list follows the toggles ===');
// The follow list is the second sub-tab of Follow Players now.
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click()`);
await wait(1500);
await ev(`[...document.querySelectorAll('.subtab')].find(x=>x.dataset.ptab==='list').click()`);
await wait(3500);
const pAll = await ev(`({ rows: document.querySelectorAll('.mp').length,
  cats: [...document.querySelectorAll('.mp-cat')].map(n=>n.textContent.trim()) })`);
console.log('  all on:', JSON.stringify(pAll));
check('players list shows both disciplines', pAll.rows === 3, pAll.rows+'');
const pMs = await ev(`(() => {
  for (const c of ['ws','md','wd','xd']) document.querySelector('[data-cat="'+c+'"]').click();
  return { rows: document.querySelectorAll('.mp').length,
           names: [...document.querySelectorAll('.mp-nm')].map(n=>n.textContent.trim().split('\\n')[0]) };
})()`);
console.log('  MS only:', JSON.stringify(pMs));
check('turning off WD hides the WD pair', pMs.rows === 1 && /SHI/.test(pMs.names[0]||''), JSON.stringify(pMs.names));
await ev(`document.querySelector('[data-cat="all"]').click()`);
await wait(2000);

console.log('\n=== bracket keeps its own draw selector ===');
await ev(`[...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click()`);
await wait(4000);
const br = await ev(`({
  selectors: document.querySelectorAll('.dcat').length,
  active: (document.querySelector('.dcat.is-active')||{}).dataset ? document.querySelector('.dcat.is-active').dataset.dcat : null,
  nodes: document.querySelectorAll('.bnode').length
})`);
console.log(' ', JSON.stringify(br));
check('bracket has its own five selectors', br.selectors === 5, br.selectors+'');
check('bracket defaults to MS', br.active === 'ms', String(br.active));
check('bracket renders a draw', br.nodes === 63, br.nodes+'');

const brWd = await ev(`(() => { document.querySelector('[data-dcat="wd"]').click(); return 1; })()`);
await wait(5000);
const brAfter = await ev(`({
  active: document.querySelector('.dcat.is-active').dataset.dcat,
  nodes: document.querySelectorAll('.bnode').length,
  byes: document.querySelectorAll('.bnode.is-bye').length,
  filterUntouched: [...document.querySelectorAll('.cat')].filter(c=>c.classList.contains('is-active')).length
})`);
console.log(' ', JSON.stringify(brAfter));
check('bracket switches to WD', brAfter.active === 'wd', brAfter.active);
check('WD bracket shows its 16 byes', brAfter.byes === 16, brAfter.byes+'');
check('changing the bracket does not touch the filter', brAfter.filterUntouched === 6, brAfter.filterUntouched+'');

console.log('\n=== Shift in bracket view moves the drawn bracket ===');
await key('Shift','ShiftLeft',16);
const shifted = await ev(`document.querySelector('.dcat.is-active').dataset.dcat`);
check('Shift advances the bracket draw', shifted === 'xd', String(shifted));

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
