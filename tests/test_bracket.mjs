/* Verify the bracket maths in app.js against the real WC2026 MS draw. */
import fs from 'fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = nodePath.dirname(fileURLToPath(import.meta.url));

const src = fs.readFileSync(nodePath.join(HERE, '..', 'app.js'), 'utf8');
const data = JSON.parse(fs.readFileSync(nodePath.join(HERE, 'draw_ms.json'), 'utf8'));

// --- pull the pure functions out of app.js so we test the real code ---
const names = ['entryKey','teamName','sideOf','cellsInCol','findStart','isEliminated','entriesInRange','pathFor'];
let extracted = '';
for (const n of names) {
  const re = new RegExp(`\\nfunction ${n}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) { console.error('MISSING FN', n); process.exit(1); }
  extracted += m[0] + '\n';
}
// stubs for the few globals those functions touch
const prelude = `
const ROUND_ORDER = ['R64','R32','R16','QF','SF','Final'];
const state = { selected: new Set(), dayIndex: {} };
function enrich(m){ return m; }
`;
const mod = await import('data:text/javascript;base64,' + Buffer.from(
  prelude + extracted + '\nexport {' + names.join(',') + '};'
).toString('base64'));

const { entryKey, findStart, pathFor, isEliminated } = mod;

// --- build the draw object exactly like loadDraw() does ---
const cells = {};
let maxCol = 0;
for (const [k, cell] of Object.entries(data.results || {})) {
  const [c, r] = k.split('-').map(Number);
  if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
  cells[k] = cell && cell.match ? cell.match : null;
  if (c > maxCol) maxCol = c;
}
const entries = new Map();
for (const [k, m] of Object.entries(cells)) {
  if (!k.startsWith('0-') || !m) continue;
  const row = Number(k.split('-')[1]);
  for (const side of ['team1','team2']) {
    const t = m[side];
    const key = entryKey(t);
    if (!key || entries.has(key)) continue;
    entries.set(key, { key, row, players: t.players || [], flag: t.countryFlagUrl,
      countryCode: t.countryCode, seed: side==='team1'?m.team1seed:m.team2seed,
      name: (t.players||[]).map(p=>p.nameDisplay).join(' / ') });
  }
}
const draw = { cells, entries, maxCol };

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}${ok ? '' : ' want ' + JSON.stringify(want)}`);
};

console.log('=== structure ===');
check('maxCol', maxCol, 5);
check('entries', entries.size, 64);
check('col0 cells', Object.keys(cells).filter(k=>k.startsWith('0-')).length, 32);
check('col5 cells', Object.keys(cells).filter(k=>k.startsWith('5-')).length, 1);

console.log('\n=== path for the top seed ===');
const shi = [...entries.values()].find(e => e.name.includes('SHI Yu Qi'));
console.log('entry:', shi.name, '| seed', shi.seed, '| col0 row', shi.row, '| key', shi.key);
check('findStart matches entry row', findStart(draw, shi.key), shi.row);

const path = pathFor(draw, shi.key);
check('rounds in path', path.length, 6);
check('round names', path.map(r=>r.round), ['R64','R32','R16','QF','SF','Final']);
check('opponent pool sizes', path.map(r=>r.pool.length), [1,2,4,8,16,32]);

console.log('\nround-by-round:');
for (const r of path) {
  const opp = r.pool.map(k => entries.get(k)?.name).filter(Boolean);
  console.log(`  ${r.round.padEnd(6)} side=${r.side} pool=${String(r.pool.length).padStart(2)}  ${opp.slice(0,3).join(' | ')}${opp.length>3?' | …':''}`);
}

console.log('\n=== every entry: pool sizes must be 1,2,4,8,16,32 ===');
let bad = 0;
for (const e of entries.values()) {
  const p = pathFor(draw, e.key);
  const sizes = p.map(r => r.pool.length).join(',');
  if (sizes !== '1,2,4,8,16,32') { bad++; if (bad<4) console.log('  BAD', e.name, sizes); }
}
check('entries with a well-formed path', 64 - bad, 64);

console.log('\n=== opponent pools are disjoint from self ===');
let selfInPool = 0;
for (const e of entries.values()) {
  for (const r of pathFor(draw, e.key)) if (r.pool.includes(e.key)) selfInPool++;
}
check('self never appears in own opponent pool', selfInPool, 0);

console.log('\n=== R64 opponent is reciprocal ===');
let recip = 0;
for (const e of entries.values()) {
  const mine = pathFor(draw, e.key)[0].pool[0];
  const theirs = pathFor(draw, mine)[0].pool[0];
  if (theirs !== e.key) recip++;
}
check('R64 pairings reciprocal', recip, 0);

console.log('\n=== union of all pools = all other entries ===');
const shiPools = new Set(pathFor(draw, shi.key).flatMap(r => r.pool));
check('top seed could meet everyone else', shiPools.size, 63);

console.log(`\n${fail ? 'FAILURES: ' + fail : 'ALL CHECKS PASSED'}`);
process.exit(fail ? 1 : 0);
