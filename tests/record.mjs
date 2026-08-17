/* Populate the fixture set by driving one wide session against the live API.
 *
 * The aim is coverage of every call the suites provoke: all five draws, every
 * day of the order of play, both ranking boards for several disciplines, and
 * the per-player and head-to-head endpoints for the players the suites click.
 * Anything missed simply falls through to the network on replay and is
 * reported, so this does not have to be perfect on the first pass. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { installFixtures, fixtureCount, FIX_DIR } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8810, DBG = 9380;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
  const f = path.join(ROOT, rel === '/' ? 'index.html' : rel);
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise(r => server.listen(PORT, r));

const profile = path.join(process.env.TEMP, 'wc26-rec-' + Date.now());
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1600,1100',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`, 'about:blank']);
chrome.stderr.on('data', () => {});
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  await new Promise(r => setTimeout(r, 400));
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl; } catch {}
}
const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
let fx = null;
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method && fx) fx.handle(m);
});
const send = (method, params = {}, sessionId) => new Promise(res => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
fx = await installFixtures(send, sessionId, { record: true });

const ev = async x => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }, sessionId);
  return r?.exceptionDetails ? { __err: r.exceptionDetails.text } : r?.result?.value;
};
const wait = ms => new Promise(r => setTimeout(r, ms));
const step = async (label, ms, fn) => {
  process.stdout.write(`  ${label} … `);
  if (fn) await ev(fn);
  await wait(ms);
  console.log(fixtureCount() + ' fixtures');
};

console.log('recording against the live API (this one is slow on purpose)\n');

// The suites use several different player sets; seeding the URL with all of
// them means their profile and season calls get recorded too.
const PLAYERS = '57945,81599,59880,68544,70762,87442,68322,87857,55942,58089,97115,85563,69345';
await send('Page.navigate', { url: `http://localhost:${PORT}/#p=${PLAYERS}&c=all&v=matches` }, sessionId);
await step('draws + all seven days', 75000);

await step('every day of the order of play', 8000, `(() => {
  const bar = [...document.querySelectorAll('#mDaybar .day')];
  bar.forEach((b, i) => setTimeout(() => b.click(), i * 400));
})()`);
await wait(6000);

// Follow Players → both sub-tabs, stepping through the list so every followed
// player's profile, ranking and season strip is fetched.
await step('player profiles and season strips', 45000, `(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='players').click();
  const rows = [...document.querySelectorAll('#myPlayers .mp')];
  rows.forEach((r, i) => setTimeout(() => r.click(), i * 2500));
})()`);

await step('the player schedule', 6000, `(() => {
  [...document.querySelectorAll('.subtab')].find(x=>x.dataset.ptab==='schedule').click();
  state.day = 'all'; renderAll();
})()`);

// Draw view: every discipline, and both ranking boards, which are the calls
// that paginate 15 rows at a time and cost the most.
await step('all five draws in Results', 12000, `(() => {
  [...document.querySelectorAll('.tab')].find(t=>t.dataset.view==='draw').click();
  const cats = [...document.querySelectorAll('.dcat')];
  cats.forEach((b, i) => setTimeout(() => b.click(), i * 1500));
})()`);

for (const board of ['world', 'race']) {
  for (const cat of ['ms', 'ws', 'md', 'wd', 'xd']) {
    await step(`${board} ranking · ${cat}`, 26000, `(() => {
      [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat==='${cat}').click();
      [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='${board}').click();
    })()`);
  }
}

// Head-to-heads: the suites open several, and each is a separate endpoint.
await step('head-to-heads', 30000, `(async () => {
  [...document.querySelectorAll('.pmode')].find(b=>b.dataset.pmode==='results').click();
  for (const cat of ['ms','ws','md','wd','xd']) {
    [...document.querySelectorAll('.dcat')].find(b=>b.dataset.dcat===cat).click();
    await new Promise(r=>setTimeout(r,1200));
    const nodes = [...document.querySelectorAll('#drawCanvas .bnode')]
      .filter(n => [...n.querySelectorAll('.bn')].every(b => !/^—|Bye/.test(b.textContent.trim())))
      .slice(0, 3);
    for (const n of nodes) {
      n.click();
      await new Promise(r=>setTimeout(r,2200));
      document.querySelector('#closeH2h').click();
      await new Promise(r=>setTimeout(r,300));
    }
  }
})()`);

// v13 needs one specific pair, both ways round: SHI Yu Qi vs Ayush SHETTY have
// met four times with the team1/team2 orientation flipping between meetings,
// which is the whole point of that suite. Clicking bracket nodes would never
// produce the reversed query, so ask for it directly.
await step('the orientation pair, both ways round', 8000, `(async () => {
  const pick = re => [...state.draws.ms.entries.values()].find(e => re.test(e.name));
  const A = pick(/SHI Yu Qi/i), B = pick(/Ayush SHETTY/i);
  if (!A || !B) return;
  for (const [x, y] of [[A, B], [B, A]]) {
    await getJSON('h2h/statistics', h2hParams(x, y), 'high', true);
  }
})()`);

console.log(`\ndone — ${fixtureCount()} fixtures in ${FIX_DIR}`);
ws.close(); chrome.kill(); server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
