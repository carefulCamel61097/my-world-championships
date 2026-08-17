/* Validate v6: saved selections, country quick-pick, switcher. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8782, DBG = 9354;
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

const profile = path.join(process.env.TEMP, 'wc26-v6-' + Date.now());
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
const wait = ms => new Promise(r => setTimeout(r, ms));

await send('Page.navigate', { url: `http://localhost:${PORT}/#c=ms&v=players` }, sessionId);
await wait(12000);

let fail = 0;
const check = (l, c, x='') => { if(!c) fail++; console.log(`${c?'PASS':'FAIL'}  ${l}${x?'  — '+x:''}`); };

console.log('=== country quick-pick ===');
await ev(`document.querySelector('#openPickerBtn').click()`);
await wait(1200);
const chips = await ev(`(() => {
  const c=[...document.querySelectorAll('.cchip')];
  return { n: c.length, first: c.slice(0,5).map(x=>x.textContent.replace(/\\s+/g,'')),
           titles: c.slice(0,2).map(x=>x.title) };
})()`);
console.log(' ', JSON.stringify(chips));
check('country chips rendered', chips.n > 20, chips.n + ' countries');
check('chips show a count', /[0-9]/.test(chips.first[0]||''), chips.first.join(' '));

const added = await ev(`(() => {
  const chip=[...document.querySelectorAll('.cchip')].find(c=>/CHN/.test(c.textContent));
  const n=parseInt(chip.querySelector('i').textContent);
  chip.click();
  const fresh=[...document.querySelectorAll('.cchip')].find(c=>/CHN/.test(c.textContent));
  return { expected: n, selected: JSON.parse(localStorage.getItem('wc26.players')||'[]').length,
           on: fresh.classList.contains('is-on'),
           marked: document.querySelectorAll('.pk.is-on').length };
})()`);
console.log('  after clicking CHN:', JSON.stringify(added));
check('clicking a country follows its entries', added.selected === added.expected, `${added.selected} vs ${added.expected}`);
check('country chip shows active', added.on);
check('picker rows marked too', added.marked === added.expected, `${added.marked}`);

const removed = await ev(`(() => {
  const chip=[...document.querySelectorAll('.cchip')].find(c=>/CHN/.test(c.textContent));
  chip.click();
  const fresh=[...document.querySelectorAll('.cchip')].find(c=>/CHN/.test(c.textContent));
  return { selected: JSON.parse(localStorage.getItem('wc26.players')||'[]').length,
           on: fresh.classList.contains('is-on') };
})()`);
console.log('  after clicking CHN again:', JSON.stringify(removed));
check('clicking again clears the country', removed.selected === 0 && !removed.on, JSON.stringify(removed));

// build a real selection: CHN + DEN
const built = await ev(`(() => {
  for (const code of ['CHN','DEN']) {
    const chip=[...document.querySelectorAll('.cchip')].find(c=>c.textContent.includes(code));
    if (chip && !chip.classList.contains('is-on')) chip.click();
  }
  document.querySelector('#donePicker').click();
  return JSON.parse(localStorage.getItem('wc26.players')||'[]').length;
})()`);
await wait(1500);
console.log('  CHN+DEN selection size:', built);
check('two countries combine', built > 4, built + ' players');

console.log('\n=== save a selection ===');
const saved = await ev(`(() => {
  document.querySelector('#selToggle').click();
  document.querySelector('#selName').value = 'China + Denmark';
  document.querySelector('#selSave').click();
  const list = JSON.parse(localStorage.getItem('wc26.presets')||'[]');
  return { count: list.length, name: list[0] && list[0].name,
           players: list[0] && list[0].players.length, cat: list[0] && (list[0].cats||[list[0].cat]).join('+'),
           rows: document.querySelectorAll('.sel-row').length,
           label: document.querySelector('#selCurrent').textContent };
})()`);
console.log(' ', JSON.stringify(saved));
check('selection persisted to localStorage', saved.count === 1 && saved.name === 'China + Denmark', JSON.stringify(saved.name));
check('stores players and discipline', saved.players === built && saved.cat === 'ms', `${saved.players} players, ${saved.cat}`);
check('appears in the panel', saved.rows === 1, saved.rows+'');
check('button shows the loaded name', saved.label === 'China + Denmark', saved.label);

console.log('\n=== second selection, in another discipline ===');
await ev(`document.querySelector('#selToggle').click()`);          // close panel
await ev(`(() => { const want='wd';
  // Turn the target ON first: if it were left until last, switching the others
  // off would hit the "never leave nothing showing" guard and become a no-op.
  const w=document.querySelector('[data-cat="'+want+'"]');
  if (!w.classList.contains('is-active')) w.click();
  for (const c of ['ms','ws','md','wd','xd']) {
    if (c===want) continue;
    const b=document.querySelector('[data-cat="'+c+'"]');
    if (b.classList.contains('is-active')) b.click();
  }
})()`);
await wait(7000);
const second = await ev(`(() => {
  document.querySelector('#openPickerBtn').click();
  const chip=[...document.querySelectorAll('.cchip')].find(c=>/JPN/.test(c.textContent));
  chip.click();
  document.querySelector('#donePicker').click();
  document.querySelector('#selToggle').click();
  document.querySelector('#selName').value = 'Japan WD';
  document.querySelector('#selSave').click();
  const list = JSON.parse(localStorage.getItem('wc26.presets')||'[]');
  return { count: list.length, names: list.map(p=>p.name), cats: list.map(p=>(p.cats||[p.cat]).join('+')),
           rows: document.querySelectorAll('.sel-row').length };
})()`);
console.log(' ', JSON.stringify(second));
check('two saved selections', second.count === 2, JSON.stringify(second.names));
check('each remembers its discipline', second.cats.join(',') === 'ms,wd', second.cats.join(','));

console.log('\n=== switch between selections ===');
const switched = await ev(`(() => {
  const rows=[...document.querySelectorAll('.sel-row')];
  const target=rows.find(r=>/China \\+ Denmark/.test(r.textContent));
  target.querySelector('.sel-load').click();
  return { players: JSON.parse(localStorage.getItem('wc26.players')||'[]').length,
           cat: [...document.querySelectorAll('.cat.is-active')].map(c=>c.dataset.cat).filter(c=>c!=='all').join(','),
           label: document.querySelector('#selCurrent').textContent,
           panelClosed: document.querySelector('#selPanel').hidden };
})()`);
await wait(6000);
console.log(' ', JSON.stringify(switched));
check('loading restores the player list', switched.players === built, `${switched.players} vs ${built}`);
check('loading switches discipline back to MS', switched.cat === 'ms', switched.cat);
check('button reflects the loaded selection', switched.label === 'China + Denmark', switched.label);
check('panel closes on load', switched.panelClosed);

const schedule = await ev(`({ cards: document.querySelectorAll('.match').length,
  err: !!document.querySelector('.status.is-error') })`);
console.log('  schedule after switching:', JSON.stringify(schedule));
check('schedule re-renders for the loaded selection', schedule.cards > 0 && !schedule.err, schedule.cards+' cards');

console.log('\n=== edit marks the selection as unsaved, delete works ===');
const edited = await ev(`(() => {
  document.querySelector('#openPickerBtn').click();
  document.querySelector('.pk').click();
  document.querySelector('#donePicker').click();
  return document.querySelector('#selCurrent').textContent;
})()`);
check('hand-editing drops the saved name', !/China \+ Denmark/.test(edited), edited);

const deleted = await ev(`(() => {
  document.querySelector('#selToggle').click();
  document.querySelector('.sel-row .sel-x').click();
  return { rows: document.querySelectorAll('.sel-row').length,
           stored: JSON.parse(localStorage.getItem('wc26.presets')||'[]').length };
})()`);
console.log(' ', JSON.stringify(deleted));
check('delete removes one selection', deleted.rows === 1 && deleted.stored === 1, JSON.stringify(deleted));

console.log('\n=== survives a reload ===');
await send('Page.reload', {}, sessionId);
await wait(12000);
const afterReload = await ev(`(() => {
  document.querySelector('#selToggle').click();
  return { rows: document.querySelectorAll('.sel-row').length,
           names: [...document.querySelectorAll('.sel-nm')].map(n=>n.textContent) };
})()`);
console.log(' ', JSON.stringify(afterReload));
check('saved selections survive reload', afterReload.rows === 1, JSON.stringify(afterReload.names));

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
