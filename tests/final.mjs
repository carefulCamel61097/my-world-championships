/* Final validation: picker, skin/mode toggles, category switch, schedule. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8767, DBG = 9335;
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

const profile = path.join(process.env.TEMP, 'wc26-final-' + Date.now());
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
fx = await installFixtures(send, sessionId, { quiet: true });
await send('Page.navigate', { url: `http://localhost:${PORT}/#p=57945&c=ms&v=players` }, sessionId);
await new Promise(r => setTimeout(r, 12000));

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r?.result?.value;
};

let fail = 0;
const check = (label, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

console.log('=== schedule view ===');
const sched = await ev(`({
  cards: document.querySelectorAll('.match').length,
  mine: document.querySelectorAll('.mine').length,
  err: !!document.querySelector('.status.is-error'),
  heading: (document.querySelector('.daygroup-head h3')||{}).textContent||''
})`);
console.log(' ', JSON.stringify(sched));
check('schedule renders cards', sched.cards > 0);
check('followed player highlighted', sched.mine > 0);
check('no error banner', !sched.err);

console.log('\n=== picker ===');
const pick = await ev(`(() => { document.querySelector('#openPickerBtn').click();
  return { open: !document.querySelector('#picker').hidden,
           rows: document.querySelectorAll('.pk').length,
           on: document.querySelectorAll('.pk.is-on').length }; })()`);
console.log(' ', JSON.stringify(pick));
check('picker opens', pick.open);
check('picker lists all 64 draw entries', pick.rows === 64, pick.rows + ' rows');
check('followed entry marked', pick.on === 1, pick.on + ' marked');

const search = await ev(`(() => { const s=document.querySelector('#pickerSearch');
  s.value='ANTONSEN'; s.dispatchEvent(new Event('input'));
  return { rows: document.querySelectorAll('.pk').length,
           first: (document.querySelector('.pk-nm')||{}).textContent||'' }; })()`);
console.log('  search "ANTONSEN":', JSON.stringify(search));
check('search filters', search.rows > 0 && search.rows < 64 && /ANTONSEN/i.test(search.first));
await ev(`document.querySelector('#closePicker').click()`);

console.log('\n=== theming ===');
const theme = await ev(`(() => {
  const cs = () => getComputedStyle(document.body).backgroundColor;
  const acc = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const before = { skin: document.documentElement.dataset.skin, bg: cs(), accent: acc() };
  document.querySelector('#skinToggle').click();
  const after = { skin: document.documentElement.dataset.skin, bg: cs(), accent: acc() };
  document.querySelector('#modeToggle').click();
  const mode = { mode: document.documentElement.dataset.mode, bg: cs() };
  return { before, after, mode };
})()`);
console.log('  ', JSON.stringify(theme));
check('default skin is bwf', theme.before.skin === 'bwf');
check('bwf accent is BWF red', theme.before.accent.toLowerCase() === '#df2027', theme.before.accent);
check('skin toggles to sport', theme.after.skin === 'sport');
check('sport accent is orange', theme.after.accent.toLowerCase() === '#ff8000', theme.after.accent);
check('background actually changes', theme.before.bg !== theme.after.bg);
check('mode toggle sets data-mode', !!theme.mode.mode);

console.log('\n=== category switch (WD, doubles) ===');
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
await new Promise(r => setTimeout(r, 6000));
const wd = await ev(`(() => { document.querySelector('#openPickerBtn').click();
  const rows=[...document.querySelectorAll('.pk-nm')].map(n=>n.textContent);
  const r={ rows: rows.length, sample: rows[0]||'', pairs: rows.filter(t=>t.includes('/')).length };
  document.querySelector('#closePicker').click(); return r; })()`);
console.log('  ', JSON.stringify(wd));
check('WD draw loaded (48 pairs in a 64 bracket)', wd.rows === 48, wd.rows + ' entries');
check('doubles shown as pairs', wd.pairs === wd.rows, wd.pairs + ' pairs');
// Seeing every match of a discipline is now Follow Matches, across all days.
await ev(`(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='matches').click();
  state.matchDay = 'all'; renderAll();
})()`);
await new Promise(r => setTimeout(r, 2500));
const byes = await ev(`(() => {
  const cards=[...document.querySelectorAll('#matchesList .match')];
  return { total: cards.length,
           tbd: cards.filter(c=>c.textContent.includes('TBD')).length }; })()`);
console.log('  WD all matches:', JSON.stringify(byes));
check('byes excluded from schedule', byes.total === 63 - 16, byes.total + ' cards (expect 47)');

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
