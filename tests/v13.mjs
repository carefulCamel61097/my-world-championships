/* Head-to-head orientation.
 *
 * The h2h payload mixes two frames of reference: `stats` and `ranking` are
 * oriented to the query, but every match in the list keeps the team1/team2 it
 * had in its own draw. Reading result.winner as "team1 is the player I asked
 * about" credits roughly half of all past meetings to the loser.
 *
 * The assertion that matters is the self-consistency one: the rows must add up
 * to the tally printed above them. That holds for any pair, so it keeps working
 * when this fixture goes stale — unlike checking a specific scoreline.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installFixtures, fixtureReport } from './fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8777, DBG = 9345;
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

const profile = path.join(process.env.TEMP, 'wc26-v13-' + process.pid);
const chrome = spawn(CHROME, ['--no-first-run','--no-default-browser-check',
  '--window-position=-2400,0','--window-size=1200,900',
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
await send('Page.navigate', { url: `http://localhost:${PORT}/#c=ms&v=draw` }, sessionId);

const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
  return r?.result?.value;
};
async function waitFor(expr, ms = 40000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(expr) === true) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

let fail = 0;
const check = (label, cond, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
};

check('MS draw loaded', await waitFor(`typeof state !== 'undefined' && !!state.draws.ms`));

/** Open the popup for a pair of MS entries and read the rendered rows back. */
const openAndRead = (aRe, bRe) => ev(`(async () => {
  const pick = re => [...state.draws.ms.entries.values()].find(e => re.test(e.name));
  const A = pick(${aRe}), B = pick(${bRe});
  if (!A || !B) return { __missing: true };
  await openH2H(A, B);
  for (let i = 0; i < 80 && !document.querySelector('.h2h-list, .h2h-none'); i++)
    await new Promise(r => setTimeout(r, 100));

  // Text nodes only: the element also carries a <small>4 meetings</small>, and
  // textContent would hand back "3-14 meetings".
  const tEl = document.querySelector('.h2h-tally');
  const tally = tEl ? [...tEl.childNodes].filter(n => n.nodeType === 3)
    .map(n => n.textContent).join('').trim() : '';
  const rows = [...document.querySelectorAll('.h2h-m')].map(r => {
    const small = (r.querySelector('.what small') || {}).textContent || '';
    const parts = small.split('\\u00b7').map(s => s.trim());
    const won = (parts[1] || '').replace(/ won$/, '');
    return {
      when: (r.querySelector('.when') || {}).textContent || '',
      tmt: (r.querySelector('.what b') || {}).textContent || '',
      won,
      games: [...r.querySelectorAll('.games .g')].map(g =>
        [...g.querySelectorAll('i')].map(i => i.textContent).join('-')),
      // Which number is emboldened as the game winner, from the left.
      leftWonGames: [...r.querySelectorAll('.games .g')]
        .filter(g => g.querySelector('i').classList.contains('w')).length,
    };
  });
  document.querySelector('#closeH2h').click();
  return { a: cardName(A), b: cardName(B), tally: tally.split('\\u2013'), rows };
})()`);

console.log('=== SHI Yu Qi vs Ayush SHETTY, opened from SHI ===');
const shi = await openAndRead('/SHI Yu Qi/i', '/Ayush SHETTY/i');
console.log(' ', JSON.stringify(shi));
check('the popup found both players', !shi.__missing && !shi.__err, JSON.stringify(shi).slice(0, 120));

const winsA = Number((shi.tally[0] || '').trim());
const winsB = parseInt((shi.tally[1] || '').trim(), 10);
const byA = shi.rows.filter(r => r.won === shi.a).length;
const byB = shi.rows.filter(r => r.won === shi.b).length;
console.log(`  tally ${winsA}-${winsB}, rows credit ${byA}-${byB}`);

// The heart of it. These two numbers come from different parts of the payload
// and are rendered by different code; if they disagree, the popup is lying in
// one of the two places and the user cannot tell which.
check('the rows add up to the tally', byA === winsA && byB === winsB,
      `${byA}-${byB} vs ${winsA}-${winsB}`);
check('every played row names a winner', shi.rows.every(r => r.won === shi.a || r.won === shi.b),
      shi.rows.map(r => r.won).join(' | '));

// A game that a player won must be the emboldened number on their side.
const consistent = shi.rows.every(r => {
  const gamesLeftWon = r.games.filter(g => {
    const [l, rr] = g.split('-').map(Number);
    return l > rr;
  }).length;
  return r.won === shi.a ? gamesLeftWon > r.games.length / 2 : gamesLeftWon < r.games.length / 2;
});
check('the scores are told from the left player\'s side', consistent,
      shi.rows.map(r => r.won + ' ' + r.games.join(' ')).join(' | '));

const asia = shi.rows.find(r => /Asia Championships 2026/i.test(r.tmt));
check('the Asia Championships 2026 final is listed', !!asia, asia && asia.tmt);
check('…and SHI Yu Qi is credited with it', !!asia && asia.won === shi.a, asia && asia.won);
check('…with the scoreline his way round', !!asia && asia.games.join(',') === '21-8,21-10',
      asia && asia.games.join(','));

console.log('\n=== the same meeting, opened from SHETTY ===');
const shetty = await openAndRead('/Ayush SHETTY/i', '/SHI Yu Qi/i');
console.log(' ', JSON.stringify(shetty));
const asia2 = shetty.rows.find(r => /Asia Championships 2026/i.test(r.tmt));
const wA = Number((shetty.tally[0] || '').trim()), wB = parseInt((shetty.tally[1] || '').trim(), 10);
check('the tally flips with the popup', wA === winsB && wB === winsA, `${wA}-${wB}`);
check('the same winner is named either way', !!asia2 && asia2.won === (asia && asia.won),
      asia2 && asia2.won);
check('the scoreline flips with the popup', !!asia2 && asia2.games.join(',') === '8-21,10-21',
      asia2 && asia2.games.join(','));
check('rows still add up from this side',
      shetty.rows.filter(r => r.won === shetty.a).length === wA &&
      shetty.rows.filter(r => r.won === shetty.b).length === wB);

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
ws.close(); chrome.kill(); server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
