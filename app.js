/* =============================================================================
   My World Championships 2026 — unofficial BWF fan tool
   Static, no backend. Talks directly to BWF's public JSON API, which reflects
   any Origin in Access-Control-Allow-Origin.

   NOTE: requests are deliberately plain GETs with no custom headers. Adding a
   header would turn these into preflighted CORS requests, and the API does not
   answer OPTIONS. Keep them "simple requests".
   ============================================================================= */

'use strict';

const API = 'https://extranet-lv.bwfbadminton.com/api';

const TMT = {
  id: 5601,
  code: 'B671FB97-491C-46D3-982F-56525168C3AA',
  slug: 'bwf-world-championships-2026',
  dates: ['2026-08-17','2026-08-18','2026-08-19','2026-08-20','2026-08-21','2026-08-22','2026-08-23'],
};

/** drawId per discipline (verified against the live tournament). */
const DRAW_ID = { ms: 1, ws: 2, md: 3, wd: 4, xd: 5 };
/** ranking category id per discipline, for rankId=2 (BWF World Rankings). */
const RANK_CAT = { ms: 6, ws: 7, md: 8, wd: 9, xd: 10 };
/** …and for rankId=9, the HSBC Race to Finals (road-to-finals) standings. */
const RACE_CAT = { ms: 57, ws: 58, md: 59, wd: 60, xd: 61 };
/** The two ranking tables, addressed by a short board name. */
const BOARDS = {
  world: { rankId: 2, cats: RANK_CAT, label: 'BWF World Ranking' },
  race:  { rankId: 9, cats: RACE_CAT, label: 'Race to Finals' },
};
const IS_DOUBLES = { ms: false, ws: false, md: true, wd: true, xd: true };
const CATS = ['ms','ws','md','wd','xd'];
const VIEWS = ['matches','players','draw'];
/** Old links keep working: v=schedule|bracket|predict predate the restructure. */
const VIEW_ALIAS = { schedule: 'players', bracket: 'draw', predict: 'draw' };
/** …and those aliases imply a sub-selection. */
const ALIAS_SUB = { schedule: { playerTab: 'schedule' }, bracket: { drawMode: 'results' },
                    predict: { drawMode: 'yours' } };
/* Players first: the schedule is derived from the follow list. */
const PLAYER_TABS = ['list','schedule'];
const CAT_LABEL = { ms:'Men’s Singles', ws:'Women’s Singles', md:'Men’s Doubles', wd:'Women’s Doubles', xd:'Mixed Doubles' };
const ROUND_ORDER = ['R64','R32','R16','QF','SF','Final'];
const ROUND_LABEL = { R64:'Round of 64', R32:'Round of 32', R16:'Round of 16', QF:'Quarter-final', SF:'Semi-final', Final:'Final' };

/* ============================ tiny helpers ============================ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
}

/** Escape for safe interpolation into innerHTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================ request layer ============================

   The API rate-limits bursts (observed: ~12 rapid requests start returning
   empty bodies). Everything therefore goes through a single serialised queue
   with a small gap, plus a sessionStorage cache so re-renders are free.
   ======================================================================== */

const REQ_GAP_MS = 320;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Two lanes, not one chain. Background work (ranking tables are paginated 15 at
 * a time, so a full index is dozens of calls) would otherwise sit in front of
 * whatever the user just clicked and leave the panel spinning for half a
 * minute. Anything the visible view needs goes in the fast lane.
 */
const lanes = { high: [], low: [] };
let laneBusy = false;

function pumpLanes() {
  if (laneBusy) return;
  const job = lanes.high.shift() || lanes.low.shift();
  if (!job) return;
  laneBusy = true;
  job.run().then(job.resolve, job.reject).finally(() => {
    setTimeout(() => { laneBusy = false; pumpLanes(); }, REQ_GAP_MS);
  });
}

function enqueue(run, priority) {
  return new Promise((resolve, reject) => {
    lanes[priority === 'low' ? 'low' : 'high'].push({ run, resolve, reject });
    pumpLanes();
  });
}

function cacheGet(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > CACHE_TTL_MS) return null;
    return v;
  } catch { return null; }
}

function cacheSet(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); }
  catch { /* quota — caching is best-effort */ }
}

/**
 * Serialised, cached GET. Retries once on an empty body (the shape a
 * rate-limit rejection takes here).
 */
function getJSON(path, params, priority) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${API}/${path}${qs ? '?' + qs : ''}`;
  const key = 'wc26:' + url;

  const hit = cacheGet(key);
  if (hit !== null) return Promise.resolve(hit);

  const run = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1200);
      try {
        const res = await fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' });
        if (!res.ok) continue;
        const text = await res.text();
        if (!text.trim()) continue;              // rate-limited → retry
        const data = JSON.parse(text);
        cacheSet(key, data);
        return data;
      } catch (e) {
        if (attempt) throw e;
      }
    }
    throw new Error('No data from BWF for ' + path);
  };

  return enqueue(run, priority);
}

/* ============================ state ============================ */

const store = {
  read(k, fb) { try { return JSON.parse(localStorage.getItem('wc26.' + k)) ?? fb; } catch { return fb; } },
  write(k, v) { try { localStorage.setItem('wc26.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  view: 'matches',
  // Disciplines are independent on/off filters, all on by default: a personal
  // schedule should show your MS and WD players together without switching.
  cats: new Set(CATS),
  // Which sub-tab of Follow Players is showing.
  playerTab: 'list',
  // A draw is one discipline at a time by definition, so the Draw view keeps
  // its own choice rather than trying to render five trees at once.
  drawCat: 'ms',
  // 'results' | 'yours' | 'world' | 'race' — the real draw, your own sheet, or
  // one derived from a ranking. All four are the same tree.
  drawMode: 'results',
  // cat -> { matchCode: entryKey } — who you think wins each match.
  predict: {},
  // cat -> ISO date the sheet was last touched, stamped onto the PNG export.
  predictAt: {},
  // Match ids starred in Follow Matches. Deliberately unrelated to `selected`:
  // following a player and starring a match are two separate ways of using the
  // tool, and mixing them makes both harder to read.
  starred: new Set(),
  starredOnly: false,
  day: 'all',
  // Follow Matches is about reading one day's order of play, so it opens on a
  // day rather than on all 267 fixtures at once. Set properly in init().
  matchDay: TMT.dates[0],
  selected: new Set(store.read('players', [])),
  active: null,          // highlighted player id in the Players view
  draws: {},             // cat -> { entries, cells, matches, maxCol }
  dayIndex: {},          // match id -> enriched match from day-matches
  daysLoaded: new Set(),
  playerCache: {},       // playerId:cat -> detail bundle promise
  ranks: {},             // cat -> { entryKey: bwfRank }
  presets: [],           // saved named selections
  activePreset: null,    // which one the working set came from, if any
};

function persistSelection() {
  store.write('players', Array.from(state.selected));
  syncHash();
  if (document.getElementById('selList')) renderPresetPanel();
}

/** Enabled disciplines in canonical order. */
function activeCats() {
  return CATS.filter(c => state.cats.has(c));
}

function allCatsOn() {
  return state.cats.size === CATS.length;
}

function syncHash() {
  // Built by hand rather than with URLSearchParams, which percent-encodes the
  // commas and turns a shareable link into p=57945%2C87442.
  const parts = [];
  const p = Array.from(state.selected).join(',');
  if (p) parts.push('p=' + p);
  parts.push('c=' + (allCatsOn() ? 'all' : activeCats().join(',')));
  parts.push('v=' + state.view);
  history.replaceState(null, '', '#' + parts.join('&'));
}

function readHash() {
  if (!location.hash || location.hash.length < 2) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const p = h.get('p');
  if (p) state.selected = new Set(p.split(',').filter(Boolean));

  const c = h.get('c');
  if (c === 'all') {
    state.cats = new Set(CATS);
  } else if (c) {
    // Comma list now; a bare "ms" from an older link means just that one.
    const want = c.split(',').map(s => s.trim()).filter(s => CATS.includes(s));
    if (want.length) {
      state.cats = new Set(want);
      // A link that names disciplines outranks whatever draw you were last on.
      state.drawCat = want[0];
      state.catsFromLink = true;
    }
  }

  const v = h.get('v');
  if (VIEWS.includes(v)) {
    state.view = v;
  } else if (VIEW_ALIAS[v]) {
    // A link made before the restructure. Land on the view that absorbed it,
    // with the sub-selection that matches what the sender was looking at —
    // and record that the link chose it, so the remembered sub-view from
    // localStorage does not quietly overrule what was shared.
    state.view = VIEW_ALIAS[v];
    Object.assign(state, ALIAS_SUB[v]);
    state.subFromLink = Object.keys(ALIAS_SUB[v]);
  }
}

/* ============================ model helpers ============================ */

/** Stable key for a draw entry (one player, or a doubles pair). */
function entryKey(team) {
  if (!team || !team.players || !team.players.length) return null;
  return team.players.map(p => String(p.id)).sort().join('_');
}

function teamName(team) {
  if (!team || !team.players || !team.players.length) return 'TBD';
  return team.players.map(p => p.nameDisplay).join(' / ');
}

/**
 * The family name out of a BWF display name, which capitalises it: "Thom
 * GICQUEL" → GICQUEL, "SHI Yu Qi" → SHI. Checked against all 416 entrants;
 * 400 have exactly one all-caps token and the rest are handled here:
 *
 *   compound surnames  Kelly VAN BUITEN → VAN BUITEN, Nour AHMED YOUSSRI
 *   initials           M.R. ARJUN → ARJUN, PUSARLA V. Sindhu → PUSARLA
 *   disambiguators     VU Thi Trang (B) → VU
 *   no case signal     THET HTAR THUZAR, CHEN ZHI YI — every token is caps, so
 *                      there is nothing to key on. Kept whole: a name that is
 *                      too long merely gets truncated, whereas guessing which
 *                      token to drop would be wrong about half the time (the
 *                      family name leads in Chinese and Korean names and
 *                      trails in Indian ones, and Burmese names have none).
 */
function surnameOf(nameDisplay) {
  const toks = String(nameDisplay || '').trim().split(/\s+/).filter(t => t && t[0] !== '(');
  const isCaps = t => /\p{Lu}/u.test(t) && t === t.toUpperCase() && !t.includes('.');
  const caps = toks.filter(isCaps);
  if (!caps.length) return toks[toks.length - 1] || '';
  if (caps.length === toks.length) return toks.join(' ');
  return caps.join(' ');
}

/**
 * Name for the small bracket and prediction cards. A doubles pair does not fit
 * at 208px — the second player was being cut off entirely — so pairs show both
 * surnames. Singles are left alone, and so is every wider surface (schedule,
 * player panel, head-to-head), which has room for the full names.
 */
function cardName(team) {
  if (!team || !team.players || !team.players.length) return 'TBD';
  if (team.players.length < 2) return teamName(team);
  return team.players.map(p => surnameOf(p.nameDisplay)).join(' / ');
}

/** Draw entry → the team shape openH2H() and teamName() expect. */
function entryTeam(entry) {
  if (!entry) return null;
  return {
    players: entry.players || [],
    countryCode: entry.countryCode,
    countryFlagUrl: entry.flag,
  };
}

function teamIsMine(team) {
  if (!team || !team.players) return false;
  return team.players.some(p => state.selected.has(String(p.id)));
}

function matchIsMine(m) {
  return teamIsMine(m.team1) || teamIsMine(m.team2);
}

/** Which side (1|2) a given entry key is on, or 0. */
function sideOf(m, key) {
  if (entryKey(m.team1) === key) return 1;
  if (entryKey(m.team2) === key) return 2;
  return 0;
}

/* ---- time ---- */

function utcDate(m) {
  if (!m.matchTimeUtc) return null;
  const d = new Date(m.matchTimeUtc.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}

function venueTime(m) {
  if (!m.matchTime) return null;
  const t = m.matchTime.split(' ')[1];
  return t ? t.slice(0, 5) : null;
}

/**
 * Always 24-hour. Venue times arrive from BWF as "HH:MM" already, so a local
 * time rendered as "6:10 PM" beside one would be two clocks in one card.
 * hourCycle h23 rather than hour12:false, which can render midnight as 24:00.
 */
function localTime(m) {
  const d = utcDate(m);
  if (!d) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** BWF writes its own strings in 12-hour ("Starting at 9:00 AM"). Restyle them. */
function to24h(text) {
  return String(text == null ? '' : text).replace(
    /\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?/g,
    (_, h, min, ap) => String((Number(h) % 12) + (/[Pp]/.test(ap) ? 12 : 0)).padStart(2, '0') + ':' + min);
}

function dayKeyOf(m) {
  if (m.matchTime) return m.matchTime.split(' ')[0];
  return null;
}

function prettyDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function shortDay(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return {
    dow: d.toLocaleDateString([], { weekday: 'short' }),
    dom: d.toLocaleDateString([], { day: 'numeric', month: 'short' }),
  };
}

/* ============================ draw loading ============================ */

async function loadDraw(cat, priority) {
  if (state.draws[cat]) return state.draws[cat];

  const data = await getJSON('vue-tournament-draw-data', {
    tmtId: TMT.id, tmtType: 1, drawId: DRAW_ID[cat], isPara: 0,
  }, priority);

  // The bracket grid and the flat match list describe the same 63 matches, but
  // only the flat list carries `id` (and later, times and scores). They join on
  // `code`, which is unique within a draw — so store the richer object in the
  // grid and everything downstream can be enriched the same way.
  const allMatches = data.matches || [];
  const byCode = new Map(allMatches.map(m => [String(m.code), m]));

  const cells = {};
  let maxCol = 0;
  for (const [k, cell] of Object.entries(data.results || {})) {
    const [c, r] = k.split('-').map(Number);
    if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
    const gm = cell && cell.match ? cell.match : null;
    cells[k] = gm ? (byCode.get(String(gm.code)) || gm) : null;
    if (c > maxCol) maxCol = c;
  }

  // Entries come from column 0 — every competitor enters there.
  // A first-round cell with only one side filled is a BYE, not a fixture:
  // doubles draws here run 48 pairs in a 64 bracket, so 16 pairs sit out
  // round one. Those are not real matches and must not be scheduled.
  const entries = new Map();
  const byeCodes = new Set();
  for (const [k, m] of Object.entries(cells)) {
    if (!k.startsWith('0-') || !m) continue;
    const row = Number(k.split('-')[1]);

    const filled = ['team1', 'team2'].filter(s => entryKey(m[s]));
    const isBye = filled.length === 1;
    if (isBye) byeCodes.add(String(m.code));

    for (const side of ['team1', 'team2']) {
      const t = m[side];
      const key = entryKey(t);
      if (!key || entries.has(key)) continue;
      entries.set(key, {
        key, cat, row,
        players: t.players || [],
        countryCode: t.countryCode,
        flag: t.countryFlagUrl,
        seed: side === 'team1' ? m.team1seed : m.team2seed,
        name: teamName(t),
        bye: isBye,
      });
    }
  }

  const draw = { cat, cells, entries, maxCol, byeCodes, matches: allMatches };
  state.draws[cat] = draw;
  return draw;
}

/** Enrich a draw match with scheduling/score data once the OOP is published. */
function enrich(m) {
  const live = state.dayIndex[m.id];
  return live ? Object.assign({}, m, live) : m;
}

async function loadDay(date) {
  if (state.daysLoaded.has(date)) return;
  state.daysLoaded.add(date);
  try {
    const list = await getJSON('tournaments/day-matches', {
      tournamentCode: TMT.code, date, order: 1, court: 0,
    }, 'low');
    if (Array.isArray(list)) {
      // The array order IS the order of play. Do not trust matchTime for
      // sequence: BWF spaces the estimates a flat 50 minutes apart and they are
      // not even monotonic — on a court with an evening session the times run
      // backwards (…14:10, 13:40…). Only the first match of a court has a real
      // time; the rest carry oopText "Followed by".
      const seen = new Map();                  // court -> how many so far
      list.forEach((m, i) => {
        const court = m.courtName || '';
        const seq = seen.get(court) || 0;
        seen.set(court, seq + 1);
        state.dayIndex[m.id] = Object.assign({}, m, { oopIndex: i, courtSeq: seq });
      });
    }
  } catch {
    state.daysLoaded.delete(date);   // allow a later retry
  }
}

/** Load all tournament days in the background, re-rendering as they arrive. */
async function loadAllDays(onProgress) {
  for (const d of TMT.dates) {
    await loadDay(d);
    if (onProgress) onProgress(d);
  }
}

/* ============================ bracket maths ============================

   Column 0 holds the 32 first-round matches. A match at (c, R) is fed by
   (c-1, 2R) and (c-1, 2R+1). So an entry starting at column-0 row r0 sits at
   row floor(r0 / 2^c) in column c, and its round-c opponent must come out of
   the sibling feeder — i.e. from column-0 rows [sib*2^(c-1), (sib+1)*2^(c-1)).
   ======================================================================== */

function cellsInCol(draw, col) {
  return Object.keys(draw.cells)
    .filter(k => k.startsWith(col + '-'))
    .length;
}

function findStart(draw, key) {
  for (const [k, m] of Object.entries(draw.cells)) {
    if (!k.startsWith('0-') || !m) continue;
    if (sideOf(m, key)) return Number(k.split('-')[1]);
  }
  return -1;
}

function isEliminated(draw, key) {
  for (const m of Object.values(draw.cells)) {
    if (!m) continue;
    const s = sideOf(m, key);
    if (!s) continue;
    if (m.winner === 1 || m.winner === 2) {
      if (m.winner !== s) return true;
    }
  }
  return false;
}

/** Entry keys sitting in the column-0 rows [from, to). */
function entriesInRange(draw, from, to) {
  const out = [];
  for (let r = from; r < to; r++) {
    const m = draw.cells['0-' + r];
    if (!m) continue;
    for (const side of ['team1', 'team2']) {
      const k = entryKey(m[side]);
      if (k) out.push(k);
    }
  }
  return out;
}

/**
 * Round-by-round path for an entry: the match it plays (if any) and the pool of
 * opponents it could still meet.
 */
function pathFor(draw, key) {
  const r0 = findStart(draw, key);
  if (r0 < 0) return [];

  const rounds = [];
  for (let c = 0; c <= draw.maxCol; c++) {
    const row = Math.floor(r0 / Math.pow(2, c));
    const m = draw.cells[`${c}-${row}`];
    if (!m) continue;

    let pool, bye = false;
    if (c === 0) {
      const other = sideOf(m, key) === 1 ? m.team2 : m.team1;
      const k = entryKey(other);
      pool = k ? [k] : [];
      bye = !k;                    // nobody opposite → walkover into round two
    } else {
      const step = Math.pow(2, c - 1);
      const mine = Math.floor(r0 / step);          // my row in column c-1
      const sib  = mine % 2 === 0 ? mine + 1 : mine - 1;
      pool = entriesInRange(draw, sib * step, (sib + 1) * step)
        .filter(k => !isEliminated(draw, k));
    }

    rounds.push({
      col: c,
      round: m.roundName || ROUND_ORDER[c] || ('Round ' + (c + 1)),
      match: enrich(m),
      side: sideOf(m, key),
      pool,
      bye,
      settled: pool.length === 1,
    });
  }
  return rounds;
}

/* ============================ rendering: shared ============================ */

function flagImg(url, alt) {
  if (!url) return '<span class="flag"></span>';
  return `<img class="flag" src="${esc(url)}" alt="${esc(alt || '')}" loading="lazy">`;
}

/** Seeds are always shown bracketed, e.g. [2]. */
function seedText(seed) {
  return seed ? '[' + seed + ']' : '';
}

/* ---- BWF ranking index, for ordering opponents ----

   There is no bulk endpoint: vue-rankingtable is hard-paginated at 15 rows
   (per_page/limit/size are all ignored), and the per-player endpoint would be
   one request per entrant. So walk the ranking table page by page until every
   entrant in the draw is resolved, and cache the result in localStorage —
   rankings only change weekly, so a 12-hour TTL makes repeat visits free.
*/

const RANK_TTL_MS = 12 * 60 * 60 * 1000;
const RANK_MAX_PAGES = 20;               // 300 players — beyond any WC field

/** Cache slot for one table: 'world:ms', 'race:xd', … */
const rankSlot = (board, cat) => board + ':' + cat;

function rankCacheGet(slot) {
  try {
    const raw = localStorage.getItem('wc26.ranks.' + slot);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t > RANK_TTL_MS ? null : v;
  } catch { return null; }
}

function rankCacheSet(slot, v) {
  try { localStorage.setItem('wc26.ranks.' + slot, JSON.stringify({ t: Date.now(), v })); } catch {}
}

/** Ranking-table row → the same key shape as entryKey(). */
function rowKey(r) {
  const ids = [r.player1_id, r.player2_id].filter(x => x != null).map(String);
  return ids.sort().join('_');
}

async function loadRankIndex(cat, board) {
  board = board || 'world';
  const slot = rankSlot(board, cat);
  if (state.ranks[slot]) return state.ranks[slot];

  const cached = rankCacheGet(slot);
  if (cached) { state.ranks[slot] = cached; return cached; }

  const draw = state.draws[cat];
  const need = new Set(draw ? Array.from(draw.entries.keys()) : []);
  const idx = {};
  state.ranks[slot] = idx;                // publish early; fills in progressively

  for (let page = 1; page <= RANK_MAX_PAGES && need.size; page++) {
    let d;
    try {
      d = await getJSON('vue-rankingtable', {
        rankId: BOARDS[board].rankId, catId: BOARDS[board].cats[cat],
        page, doubles: IS_DOUBLES[cat],
      }, 'low');                                  // never ahead of the visible view
    } catch { break; }

    const res = d && d.results;
    const rows = Array.isArray(res) ? res : (res && res.data) || [];
    if (!rows.length) break;

    for (const r of rows) {
      const k = rowKey(r);
      if (!k) continue;
      if (idx[k] == null) idx[k] = r.rank;
      need.delete(k);
    }
    if (state.view !== 'schedule') renderAll();
  }

  idx.__done = true;                      // distinguishes "no rank" from "not loaded yet"
  rankCacheSet(slot, idx);
  return idx;
}

function rankOf(cat, key, board) {
  const idx = state.ranks[rankSlot(board || 'world', cat)];
  const r = idx && idx[key];
  return typeof r === 'number' ? r : Infinity;
}

/** Sort entry keys by BWF ranking, then seed, then name. */
function sortByRank(draw, keys) {
  return keys.slice().sort((a, b) => {
    const ra = rankOf(draw.cat, a), rb = rankOf(draw.cat, b);
    if (ra !== rb) return ra - rb;
    const ea = draw.entries.get(a), eb = draw.entries.get(b);
    const sa = ea && ea.seed ? Number(ea.seed) : 999;
    const sb = eb && eb.seed ? Number(eb.seed) : 999;
    if (sa !== sb) return sa - sb;
    return ((ea && ea.name) || '').localeCompare((eb && eb.name) || '');
  });
}

function statusOf(m) {
  const s = (m.matchStatus || '').toUpperCase();
  if (s === 'F') return { cls: 'finished', text: 'Finished' };
  if (s === 'L' || s === 'P') return { cls: 'live', text: 'Live' };
  if (m.matchTime) return { cls: 'upcoming', text: 'Scheduled' };
  return { cls: 'upcoming', text: 'Not scheduled' };
}

function sideRow(m, which, opts) {
  const team = m['team' + which];
  const seed = m['team' + which + 'seed'];
  const isWin = m.winner === which;
  const isLose = (m.winner === 1 || m.winner === 2) && !isWin;
  // Follow Matches is a separate way of using the tool from Follow Players, so
  // the followed-player cues are suppressed there rather than half-applied.
  const usePlayers = !(opts && opts.ignorePlayers);
  const mine = usePlayers && teamIsMine(team);

  const scores = (m.score || []).map(g => {
    const own = which === 1 ? g.home : g.away;
    const opp = which === 1 ? g.away : g.home;
    if (own == null) return '';
    return `<b class="${own > opp ? 'won' : ''}">${esc(own)}</b>`;
  }).join('');

  const names = team && team.players && team.players.length
    ? team.players.map(p => `<span class="${usePlayers && state.selected.has(String(p.id)) ? 'mine' : ''}">${esc(p.nameDisplay)}</span>`).join(' / ')
    : '<span class="muted">TBD</span>';

  const cls = ['side', isWin ? 'is-winner' : '', isLose ? 'is-loser' : '', mine ? 'is-mine' : ''].join(' ');

  return `
    <div class="${cls}">
      ${flagImg(team && team.countryFlagUrl, team && team.countryCode)}
      <span class="seed">${esc(seedText(seed))}</span>
      <span class="nm">${names}<small class="sub">${esc((team && team.countryCode) || '')}</small></span>
      <span class="sets">${scores}</span>
    </div>`;
}

function matchCard(m, opts) {
  const st = statusOf(m);
  const vt = venueTime(m);
  const lt = localTime(m);
  const showLocal = vt && lt && vt !== lt;
  // Inside the draw path the round is already the block heading — don't repeat it.
  const hideRound = opts && opts.hideRound;

  const head = [
    hideRound ? '' : `<span class="rnd">${esc(ROUND_LABEL[m.roundName] || m.roundName || '')}</span>`,
    m.eventName ? `${hideRound ? '' : '<span class="sep">&middot;</span>'}<span>${esc(m.eventName)}</span>` : '',
    m.courtName ? `<span class="sep court">&middot;</span><span class="court">${esc(m.courtName)}</span>` : '',
    `<span class="stat ${st.cls}">${st.text}</span>`,
  ].join('');

  // Only the first match on a court has a real start time. Everything after it
  // is "Followed by", and BWF's clock for those is a flat 50-minute estimate
  // that on some courts even runs backwards — so mark them as approximate
  // rather than presenting a fabricated time as fact.
  const est = m.oopText && !/^\s*starting/i.test(m.oopText);
  const tip = est ? ' title="Estimated — this match follows the one before it on court"' : '';
  const approx = est ? '&asymp;' : '';

  const foot = [
    vt ? `<span${tip}>${approx}Venue ${esc(vt)}</span>` : '<span>Time to be confirmed</span>',
    showLocal ? `<span class="local"${tip}>${approx}Your time ${esc(lt)}</span>` : '',
    m.duration ? `<span>${esc(m.duration)} min</span>` : '',
    m.oopText ? `<span>${esc(to24h(m.oopText))}</span>` : '',
  ].filter(Boolean).join('');

  const starred = isStarred(m);
  const card = el('div', 'match'
    + (st.cls === 'live' ? ' is-live' : '')
    + (opts && opts.selectable ? ' is-selectable' + (starred ? ' is-starred' : ' is-dim') : ''));
  card.innerHTML = `
    <div class="match-head">${head}</div>
    <div class="match-body">${sideRow(m, 1, opts)}${sideRow(m, 2, opts)}</div>
    <div class="match-foot">${foot}</div>`;

  const k1 = entryKey(m.team1), k2 = entryKey(m.team2);

  if (opts && opts.selectable) {
    // Starring is the point of this view, so the card itself is the target and
    // the head-to-head moves onto its own button rather than sharing the click.
    card.querySelector('.match-head').insertAdjacentHTML('afterbegin',
      `<span class="star" aria-hidden="true">${starred ? '&#9733;' : '&#9734;'}</span>`);
    card.title = starred ? 'Starred — click to remove' : 'Click to star this match';
    card.addEventListener('click', () => toggleStar(m));
    if (k1 && k2) {
      const cue = el('button', 'h2h-cue h2h-btn', 'H2H');
      cue.type = 'button';
      cue.title = 'Show head-to-head';
      cue.addEventListener('click', e => { e.stopPropagation(); openH2H(m.team1, m.team2); });
      card.querySelector('.match-head').appendChild(cue);
    }
    return card;
  }

  // Any match with two known sides can open its head-to-head.
  if (k1 && k2) {
    const sides = card.querySelectorAll('.side');
    sides.forEach(s => s.classList.add('side-clickable'));
    card.querySelector('.match-head').insertAdjacentHTML('beforeend',
      '<span class="h2h-cue">H2H</span>');
    card.addEventListener('click', () => openH2H(m.team1, m.team2));
    card.title = 'Show head-to-head';
  }
  return card;
}

/* ============================ starred matches ============================

   Follow Matches is its own way of using the tool: you read a day's order of
   play and mark the matches worth watching. It deliberately shares nothing
   with the followed-player list — a star means "I picked this", full stop.

   Keyed by match id, which is unique across the whole tournament. The `code`
   is only unique within one draw, so MS and WD would collide.
   ======================================================================== */

const isStarred = m => state.starred.has(String(m.id));

function persistStars() {
  store.write('starred', Array.from(state.starred));
}

function toggleStar(m) {
  const k = String(m.id);
  if (state.starred.has(k)) state.starred.delete(k); else state.starred.add(k);
  persistStars();
  renderMatches();
}

function clearStars() {
  state.starred.clear();
  persistStars();
  renderMatches();
}

/* ============================ view: schedule ============================ */

/** "Court 10" after "Court 2", not before it. */
function courtNum(name) {
  const n = parseInt(String(name).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 9999;
}

/**
 * A day's order of play as a grid: one column per court, one row per position
 * in that court's running order.
 *
 * The y-axis is the running order, not the clock. Badminton matches follow one
 * another on a court — BWF says so itself, with oopText "Followed by" on every
 * match after the first — and the per-match times it publishes are flat
 * 50-minute estimates that on some courts run backwards. So row 3 means "third
 * on this court", which is both true and the way an order of play is read.
 *
 * Rows with nothing to show are skipped, so filtering to a handful of followed
 * players gives a dense grid rather than sixteen mostly-empty rows — while two
 * matches on the same row are still genuinely at the same point in the day.
 */
function renderCourtGrid(list, into, cardOpts) {
  const placed = list.filter(m => m.courtName && m.courtSeq != null);
  if (placed.length !== list.length) return false;      // OOP not out for this day

  const courts = Array.from(new Set(placed.map(m => m.courtName)))
    .sort((a, b) => courtNum(a) - courtNum(b));
  if (courts.length < 2) return false;                  // one column is just a list

  const colOf = new Map(courts.map((c, i) => [c, i]));
  const rows = Array.from(new Set(placed.map(m => m.courtSeq))).sort((a, b) => a - b);
  const rowOf = new Map(rows.map((s, i) => [s, i]));

  const grid = el('div', 'oop-grid');
  grid.style.setProperty('--cols', courts.length);

  for (const c of courts) {
    const h = el('div', 'oop-head', esc(c));
    h.style.gridColumn = colOf.get(c) + 1;
    h.style.gridRow = 1;
    grid.appendChild(h);
  }

  // Row-major DOM order, so the narrow-screen fallback — which drops the grid
  // and simply stacks these — still reads down the day in running order.
  const ordered = placed.slice().sort((a, b) =>
    (a.courtSeq - b.courtSeq) || (colOf.get(a.courtName) - colOf.get(b.courtName)));

  for (const m of ordered) {
    const card = matchCard(m, cardOpts);
    card.style.gridColumn = colOf.get(m.courtName) + 1;
    card.style.gridRow = rowOf.get(m.courtSeq) + 2;     // row 1 is the court header
    grid.appendChild(card);
  }

  into.appendChild(grid);
  return true;
}

/** One day bar, shared by both schedules but driven by its own day key. */
function renderDaybar(sel, current, pick) {
  const bar = $(sel);
  if (!bar) return;
  bar.innerHTML = '';

  const all = el('button', 'day' + (current === 'all' ? ' is-active' : ''), '<b>All</b>days');
  all.onclick = () => pick('all');
  bar.appendChild(all);

  for (const d of TMT.dates) {
    const s = shortDay(d);
    const b = el('button', 'day' + (current === d ? ' is-active' : ''), `<b>${esc(s.dom)}</b>${esc(s.dow)}`);
    b.onclick = () => pick(d);
    bar.appendChild(b);
  }
}

/** Every non-bye match in the switched-on disciplines, schedule data merged in. */
function allMatches() {
  const out = [];
  for (const c of activeCats()) {
    const draw = state.draws[c];
    if (!draw) continue;
    for (const m of draw.matches) {
      // Byes are bracket bookkeeping, not fixtures — never list them.
      if (draw.byeCodes.has(String(m.code))) continue;
      out.push(enrich(m));
    }
  }
  return out;
}

/**
 * Days as headed groups, each laid out by court once its order of play is out.
 * Shared by both schedules — the only difference between them is which matches
 * they hand over and how the cards behave.
 */
function renderDayGroups(matches, wrap, cardOpts) {
  const groups = new Map();
  for (const m of matches) {
    const k = dayKeyOf(m) || 'tbc';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

  // Scheduled days first, chronologically; anything unscheduled last.
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'tbc') return 1;
    if (b === 'tbc') return -1;
    return a < b ? -1 : 1;
  });

  for (const k of keys) {
    const list = groups.get(k);
    list.sort((a, b) => {
      const ta = utcDate(a), tb = utcDate(b);
      if (ta && tb) return ta - tb;
      // Unscheduled: earliest round first, then keep disciplines together.
      const ra = ROUND_ORDER.indexOf(a.roundName), rb = ROUND_ORDER.indexOf(b.roundName);
      if (ra !== rb) return ra - rb;
      return CATS.indexOf((a.eventName || '').toLowerCase()) -
             CATS.indexOf((b.eventName || '').toLowerCase());
    });

    const g = el('div', 'daygroup');
    const head = el('div', 'daygroup-head');
    const n = `${list.length} match${list.length === 1 ? '' : 'es'}`;
    const starred = list.filter(isStarred).length;
    head.innerHTML = k === 'tbc'
      ? `<h3>Not yet scheduled</h3><span>${n} &middot; times published nearer the day</span>`
      : `<h3>${esc(prettyDay(k))}</h3><span>${n}${
          cardOpts && cardOpts.selectable && starred ? ` &middot; <b>${starred}</b> starred` : ''}</span>`;
    g.appendChild(head);
    // Once the order of play is out, lay the day out by court; until then a
    // plain chronological list is all the data supports.
    if (k === 'tbc' || !renderCourtGrid(list, g, cardOpts)) {
      for (const m of list) g.appendChild(matchCard(m, cardOpts));
    }
    wrap.appendChild(g);
  }
}

/** Exactly what Follow Players → Schedule is showing, day filter included. */
function myScheduleMatches() {
  if (!state.selected.size) return [];
  let ms = allMatches().filter(matchIsMine);
  if (state.day !== 'all') ms = ms.filter(m => dayKeyOf(m) === state.day);
  return ms;
}

/**
 * The one bridge between the two halves of the tool: take the matches this
 * schedule is showing and star them, so tomorrow's fixtures for the players you
 * follow light up in Follow Matches without re-picking them by hand.
 *
 * Deliberately a button rather than automatic. A star still means "I chose
 * this" — it just does not have to be chosen one card at a time.
 */
function paintAddToStars() {
  const btn = $('#addToStars');
  if (!btn) return;
  const shown = myScheduleMatches();
  if (!shown.length) { btn.hidden = true; return; }

  const missing = shown.filter(m => !isStarred(m));
  btn.hidden = false;
  if (missing.length) {
    btn.dataset.act = 'add';
    btn.textContent = `Add ${missing.length} to Follow Matches`;
    btn.title = 'Star these matches so they light up in Follow Matches';
  } else {
    // Everything on screen is already starred, so offer the way back out
    // rather than leaving a button that would do nothing.
    btn.dataset.act = 'remove';
    btn.textContent = `Remove ${shown.length} from Follow Matches`;
    btn.title = 'Un-star these matches';
  }
}

function addScheduleToStars() {
  const shown = myScheduleMatches();
  if (!shown.length) return;
  const remove = $('#addToStars').dataset.act === 'remove';
  for (const m of shown) {
    if (remove) state.starred.delete(String(m.id));
    else state.starred.add(String(m.id));
  }
  persistStars();
  paintAddToStars();
}

/** Follow Players → Schedule: the matches of the players you follow. */
function renderSchedule() {
  const wrap = $('#scheduleList');
  if (!wrap) return;
  const cats = activeCats();
  const loaded = cats.filter(c => state.draws[c]);
  wrap.innerHTML = '';
  paintAddToStars();

  if (!loaded.length) {
    wrap.appendChild(el('div', 'status', '<span class="spinner"></span>Loading the draws&hellip;'));
    return;
  }

  if (state.selected.size === 0) {
    const e = el('div', 'empty');
    e.innerHTML = `
      <h3>No players selected yet</h3>
      <p>Pick the players you want to follow and this becomes your personal schedule.</p>`;
    const b = el('button', 'btn btn-primary', 'Add players');
    b.onclick = openPicker;
    e.appendChild(b);
    wrap.appendChild(e);
    return;
  }

  const matches = myScheduleMatches();

  if (!matches.length) {
    const label = cats.length === CATS.length ? 'matches'
      : cats.map(c => c.toUpperCase()).join('/') + ' matches';
    const e = el('div', 'empty');
    e.innerHTML = `<h3>Nothing here</h3><p>No ${esc(label)}${
      state.day === 'all' ? '' : ' on this day'} for your selection yet.</p>`;
    wrap.appendChild(e);
    return;
  }

  renderDayGroups(matches, wrap);
}

/**
 * Follow Matches: the whole day, dimmed, laid out by court. Star what looks
 * worth watching and it stays lit. Nothing here consults the followed-player
 * list — that is the other half of the tool.
 */
function renderMatches() {
  const wrap = $('#matchesList');
  if (!wrap) return;
  const loaded = activeCats().filter(c => state.draws[c]);
  wrap.innerHTML = '';
  paintStarBar();

  if (!loaded.length) {
    wrap.appendChild(el('div', 'status', '<span class="spinner"></span>Loading the draws&hellip;'));
    return;
  }

  let matches = allMatches();
  if (state.matchDay !== 'all') matches = matches.filter(m => dayKeyOf(m) === state.matchDay);
  if (state.starredOnly) matches = matches.filter(isStarred);

  if (!matches.length) {
    const e = el('div', 'empty');
    e.innerHTML = state.starredOnly
      ? `<h3>Nothing starred${state.matchDay === 'all' ? '' : ' on this day'}</h3>
         <p>Turn off <em>Starred only</em> and click the matches you want to watch.</p>`
      : `<h3>Nothing here</h3><p>No matches in the switched-on disciplines${
          state.matchDay === 'all' ? '' : ' on this day'} yet.</p>`;
    wrap.appendChild(e);
    return;
  }

  renderDayGroups(matches, wrap, { selectable: true, ignorePlayers: true });
}

function paintStarBar() {
  const n = state.starred.size;
  const box = $('#starCount');
  if (box) box.textContent = n === 0 ? 'Nothing starred yet' : `${n} starred`;
  const clear = $('#clearStars');
  if (clear) clear.disabled = n === 0;
}

/* ============================ view: players ============================ */

/**
 * Every selected player we can describe, across the draws loaded so far,
 * restricted to the disciplines currently switched on.
 */
function selectedPlayers() {
  const out = new Map();
  for (const cat of activeCats()) {
    const draw = state.draws[cat];
    if (!draw) continue;
    for (const entry of draw.entries.values()) {
      for (const p of entry.players) {
        const id = String(p.id);
        if (!state.selected.has(id)) continue;
        if (!out.has(id)) out.set(id, { id, player: p, cats: [], entries: [] });
        const rec = out.get(id);
        if (!rec.cats.includes(cat)) { rec.cats.push(cat); rec.entries.push(entry); }
      }
    }
  }
  // Selected players whose draw isn't loaded yet still deserve a row — but
  // only while something is still loading, otherwise a player filtered out by
  // the discipline toggles would reappear as an anonymous "Player 12345".
  const pending = activeCats().some(c => !state.draws[c]);
  if (pending) {
    for (const id of state.selected) {
      if (!out.has(id)) out.set(id, { id, player: null, cats: [], entries: [] });
    }
  }
  return Array.from(out.values());
}

function renderMyPlayers() {
  const list = $('#myPlayers');
  list.innerHTML = '';
  const players = selectedPlayers();

  if (!players.length) {
    list.appendChild(el('div', 'empty', '<p class="muted">No players selected.</p>'));
    return;
  }

  if (!state.active || !players.some(p => p.id === state.active)) {
    state.active = players[0].id;
  }

  for (const rec of players) {
    const p = rec.player;
    const name = p ? p.nameDisplay : 'Player ' + rec.id;
    const row = el('div', 'mp' + (rec.id === state.active ? ' is-active' : ''));
    row.innerHTML = `
      ${flagImg(p && p.countryFlagUrl, p && p.countryCode)}
      <span class="mp-nm">${esc(name)}
        <small>${esc(p ? (p.countryName || p.countryCode || '') : 'loading…')}</small></span>
      <span class="mp-cat">${rec.cats.map(c => c.toUpperCase()).join(' ')}</span>
      <button class="mp-x" type="button" title="Stop following ${esc(name)}"
        aria-label="Stop following ${esc(name)}">&times;</button>`;

    row.onclick = () => { state.active = rec.id; renderMyPlayers(); renderPlayerDetail(); };
    row.querySelector('.mp-x').onclick = e => {
      e.stopPropagation();                       // don't also select the row
      unfollow(rec.id);
    };
    list.appendChild(row);
  }
}

/**
 * Drop a player from the follow list. Doubles pairs are followed as a unit, so
 * removing one half removes the partner too — otherwise their matches would
 * still show up and the row would be impossible to get rid of.
 */
function unfollow(playerId) {
  const ids = new Set([String(playerId)]);
  for (const cat of CATS) {
    const draw = state.draws[cat];
    if (!draw) continue;
    for (const entry of draw.entries.values()) {
      if (!entry.players.some(p => String(p.id) === String(playerId))) continue;
      for (const p of entry.players) ids.add(String(p.id));
    }
  }
  for (const id of ids) state.selected.delete(id);

  if (ids.has(String(state.active))) state.active = null;
  state.activePreset = null;          // hand-edited, no longer a saved selection
  persistSelection();
  renderAll();
}

async function renderPlayerDetail() {
  const box = $('#playerDetail');
  const rec = selectedPlayers().find(p => p.id === state.active);

  if (!rec) {
    box.innerHTML = '<div class="empty"><h3>Select a player</h3><p>Choose someone from the list to see their details.</p></div>';
    return;
  }

  const p = rec.player;
  const entry = rec.entries[0];
  const cat = rec.cats[0];

  box.innerHTML = `
    <div class="panel">
      <div class="phero">
        ${p && p.avatar && p.avatar.thumbnailUrl
          ? `<img class="avatar" src="${esc(p.avatar.thumbnailUrl)}" alt="${esc(p.nameDisplay)}">`
          : '<div class="avatar"></div>'}
        <div class="phero-txt">
          <h2>${esc(p ? p.nameDisplay : 'Player ' + rec.id)}</h2>
          <div class="meta">${esc(p ? (p.countryName || p.countryCode || '') : '')}${
            cat ? ' &middot; ' + esc(CAT_LABEL[cat]) : ''}${
            entry && entry.seed ? ' &middot; Seed ' + esc(entry.seed) : ''}</div>
        </div>
      </div>
      <div class="stats" id="statCells">
        <div class="stat-cell"><div class="k">Loading</div><div class="v"><span class="spinner"></span></div></div>
      </div>
      <div id="seasonBox"></div>
    </div>
    <div class="panel" id="pathPanel">
      <div class="panel-head">Road through the draw</div>
      <div class="panel-body"><span class="spinner"></span>Working out the bracket&hellip;</div>
    </div>`;

  // --- bracket path (local, no network) ---
  if (entry && state.draws[cat]) {
    renderPath(state.draws[cat], entry, $('#pathPanel'));
    // Ordering the opponent chips by ranking needs this discipline's index.
    // Fetch it only now, and only for the discipline actually on screen.
    if (!state.ranks[rankSlot('world', cat)]) {
      loadRankIndex(cat, 'world')
        .then(() => { if (state.active === rec.id && state.view === 'players') renderPlayerDetail(); })
        .catch(() => { /* chips just stay in bracket order */ });
    }
  } else {
    $('#pathPanel').querySelector('.panel-body').textContent =
      'Draw not loaded for this discipline yet.';
  }

  // --- profile numbers (network, best-effort) ---
  const want = rec.id;
  const partner = entry && (entry.players || [])
    .map(p => String(p.id)).find(pid => pid !== String(rec.id));
  try {
    const bundle = await playerBundle(rec.id, cat, partner);
    if (state.active !== want) return;              // user moved on while loading
    renderStatCells(bundle, entry);
    const box = $('#seasonBox');
    if (box) box.innerHTML = seasonStrip(bundle.season, cat, `Season ${SEASON_YEAR}`);
  } catch {
    const cells = $('#statCells');
    if (cells) cells.innerHTML = '<div class="stat-cell"><div class="k">Profile</div><div class="v"><small>Unavailable</small></div></div>';
  }
}

function playerBundle(id, cat, partnerId) {
  // Key by discipline as well as player: rankings are per-event, and the first
  // render can happen before the draw has loaded (discipline still unknown).
  // Keying on id alone would cache that early wrong-event answer for good.
  const key = id + ':' + (cat || '?');
  // Cache the *promise*, not the result: re-renders fire while the first
  // request is still in flight, and we must not queue it twice.
  if (!state.playerCache[key]) {
    state.playerCache[key] = fetchPlayerBundle(id, cat, partnerId).catch(e => {
      delete state.playerCache[key];   // let a later render retry
      throw e;
    });
  }
  return state.playerCache[key];
}

/** BWF returns "-" (or a "-" rank) when it has no ranking for that player. */
function blankRank(v) {
  if (v == null || v === '-' || v === '') return true;
  return typeof v === 'object' && (v.rank == null || v.rank === '-');
}

async function fetchPlayerBundle(id, cat, partnerId) {
  // Rankings are per discipline. Until the draw tells us which one this player
  // is in, ask only for the discipline-independent data.
  const rankEvent = RANK_CAT[cat];
  const askRank = who => rankEvent
    ? getJSON('vue-player-ranking-current', { playerId: who, isPara: 0, rankingEvent: rankEvent }).catch(() => null)
    : Promise.resolve(null);
  const askHighest = who => rankEvent
    ? getJSON('vue-player-ranking-highest', { playerId: who, isPara: 0, rankingEvent: rankEvent }).catch(() => null)
    : Promise.resolve(null);

  let [summary, current, highest, previous, season] = await Promise.all([
    getJSON('vue-player-summary', { playerId: id, isPara: 0, drawCount: 5 }).catch(() => null),
    askRank(id),
    askHighest(id),
    getJSON('vue-player-match-previous', { playerId: id, isPara: 0, drawCount: 5, activeTab: 0 }).catch(() => null),
    loadSeason(id).catch(() => []),
  ]);

  // A doubles ranking belongs to the pair, and BWF only resolves it against
  // whichever half it stores as player1 — the man in mixed doubles, and the
  // first-named player in level doubles. Asking with the other half returns
  // "-", which is why the second-named player showed no ranking at all. Retry
  // with the partner and report the pair's figures for both of them.
  if (partnerId && blankRank(current && current.results)) {
    const [c2, h2] = await Promise.all([askRank(partnerId), askHighest(partnerId)]);
    if (!blankRank(c2 && c2.results)) current = c2;
    if (!blankRank(h2 && h2.results)) highest = h2;
  }

  return {
    summary: summary && summary.results,
    rank: current && current.results,
    highest: highest && highest.results,
    previous: previous && previous.results,
    season,
  };
}

function renderStatCells(b, entry) {
  const cells = [];
  // A doubles ranking is the pair's, not the individual's — say so.
  const isPair = !!(entry && entry.players && entry.players.length > 1);
  const suffix = isPair ? ' &middot; pair' : '';

  const rank = (b.rank && b.rank !== '-') ? b.rank : null;
  cells.push(`<div class="stat-cell"><div class="k">BWF World Ranking${suffix}</div>
    <div class="v">${rank ? '#' + esc(rank) : '<small>&mdash;</small>'}</div></div>`);

  if (b.highest && b.highest.rank && b.highest.rank !== '-') {
    cells.push(`<div class="stat-cell"><div class="k">Career high${suffix}</div>
      <div class="v">#${esc(b.highest.rank)} <small>${esc(b.highest.date || '')}</small></div></div>`);
  }
  if (entry && entry.seed) {
    cells.push(`<div class="stat-cell"><div class="k">Seeded</div><div class="v">${esc(entry.seed)}</div></div>`);
  }
  const dob = b.summary && b.summary.date_of_birth;
  if (dob) {
    const age = Math.floor((Date.now() - new Date(dob.replace(' ', 'T') + 'Z')) / 31557600000);
    cells.push(`<div class="stat-cell"><div class="k">Age</div><div class="v">${age}</div></div>`);
  }

  $('#statCells').innerHTML = cells.join('');
}

function renderPath(draw, entry, panel) {
  const rounds = pathFor(draw, entry.key);
  const body = el('div');

  if (!rounds.length) {
    body.className = 'panel-body';
    body.textContent = 'This player was not found in the draw.';
    panel.replaceChild(body, panel.querySelector('.panel-body'));
    return;
  }

  const out = state.selected.size && isEliminated(draw, entry.key);

  let first = true;
  for (const r of rounds) {
    if (!first) body.appendChild(el('div', 'round-sep', '<i>&#9660;</i>'));
    first = false;

    const block = el('div', 'round-block');
    const head = el('div', 'round-block-head');

    const played = r.match.winner === 1 || r.match.winner === 2;
    const won = played && r.match.winner === r.side;
    const note = r.bye ? 'Bye'
      : played ? (won ? 'Won' : 'Lost')
      : r.settled ? 'Opponent confirmed'
      : `${r.pool.length} possible opponents`;

    head.innerHTML = `<b>${esc(ROUND_LABEL[r.round] || r.round)}</b>` +
      `<span class="rb-count${played || r.settled || r.bye ? ' done' : ''}">${esc(note)}</span>`;
    block.appendChild(head);

    if (r.bye) {
      const b = el('div', 'opp-grid');
      b.innerHTML = '<span class="muted">No opponent in this round — through to the next round.</span>';
      block.appendChild(b);
    } else if (played || r.settled) {
      block.appendChild(matchCard(r.match, { hideRound: true }));
    } else if (r.pool.length) {
      const grid = el('div', 'opp-grid');
      // Strongest possible opponents first.
      for (const k of sortByRank(draw, r.pool)) {
        const e = draw.entries.get(k);
        if (!e) continue;
        const rk = rankOf(draw.cat, k);
        const chip = el('button', 'opp');
        chip.type = 'button';
        chip.innerHTML = `${e.flag ? `<img src="${esc(e.flag)}" alt="">` : ''}
          ${e.seed ? `<span class="sd">${esc(seedText(e.seed))}</span>` : ''}${esc(e.name)}
          ${rk !== Infinity ? `<span class="rk">#${esc(rk)}</span>` : ''}`;
        chip.title = `Head-to-head vs ${e.name}`;
        chip.onclick = () => openH2H(entryTeam(entry), entryTeam(e));
        grid.appendChild(chip);
      }
      block.appendChild(grid);
    }

    body.appendChild(block);
    if (played && !won) break;   // their tournament ended here
  }

  if (out) {
    const n = el('div', 'panel-body');
    n.innerHTML = '<span class="muted">Eliminated from this event.</span>';
    body.appendChild(n);
  }

  panel.replaceChild(body, panel.querySelector('.panel-body'));
}

/* ============================ season strip ============================

   vue-player-tournaments returns a player's season, newest first, each with
   draws[].position. BWF spells the podium as 1st / 2nd / 3rd rather than
   W / F / SF, and team events come back as N/A.
   ==================================================================== */

const SEASON_YEAR = 2026;

/**
 * BWF position string → short label, colour tier, and where that round sits on
 * the ladder (R64 = 1 … Final = 6). `depth` is the round they exited at, which
 * combined with matches played tells us how big their draw was.
 */
const POSITION = {
  '1st':  { label: 'W',   tier: 'w',   depth: 6, full: 'Champion' },
  '2nd':  { label: 'F',   tier: 'f',   depth: 6, full: 'Runner-up' },
  '3rd':  { label: 'SF',  tier: 'sf',  depth: 5, full: 'Semi-final' },
  'QF':   { label: 'QF',  tier: 'qf',  depth: 4, full: 'Quarter-final' },
  'R16':  { label: 'R16', tier: 'r16', depth: 3, full: 'Round of 16' },
  'R32':  { label: 'R32', tier: 'r1',  depth: 2, full: 'Round of 32' },
  'R64':  { label: 'R64', tier: 'r1',  depth: 1, full: 'Round of 64' },
};
const FINAL_DEPTH = 6;
const MIN_FILL = 0.13;          // a first-round exit still shows a sliver

function positionInfo(pos) {
  if (!pos || pos === 'N/A') return { label: '–', tier: 'na', full: 'Played' };
  if (POSITION[pos]) return POSITION[pos];
  if (/^Qual/i.test(pos)) return { label: 'Q', tier: 'q', depth: 0, full: pos };
  return { label: String(pos), tier: 'na', full: String(pos) };
}

/**
 * How full the square should be: rounds won ÷ rounds available *in that
 * tournament*, so a Super 300 quarter-final and a Super 1000 quarter-final
 * read the same rather than being skewed by draw size.
 *
 * The player's entry round is derived from where they went out and how many
 * matches they played: entry = exitDepth − matchesPlayed + 1. A champion fills
 * the square; a first-round loss keeps a minimum sliver so it stays visible.
 */
function fillFraction(info, draw) {
  if (!draw || info.tier === 'na') return 0;
  const wins = Number(draw.win) || 0;
  const played = wins + (Number(draw.lose) || 0);
  if (!played || !info.depth) return MIN_FILL;

  const entry = info.depth - played + 1;
  const rounds = FINAL_DEPTH - entry + 1;
  if (rounds <= 0) return MIN_FILL;

  return Math.max(MIN_FILL, Math.min(1, wins / rounds));
}

/** tournament_category_id → short level label (verified by sampling seasons). */
const TMT_LEVEL = {
  5:  'Challenge',
  6:  'Series',
  11: 'Continental',
  17: 'Cont. Team',
  20: 'Worlds',
  21: 'Team event',
  22: 'Tour Finals',
  23: 'Super 1000',
  24: 'Super 750',
  25: 'Super 500',
  26: 'Super 300',
  27: 'Super 100',
};

/**
 * "PETRONAS Malaysia Open 2026" → "Malaysia Open".
 *
 * The square is ~52px wide and gets two lines, so this has to be aggressive:
 * drop the sponsor, the year and the filler words, then abbreviate. The full
 * name is always kept in the tooltip, so nothing is actually lost.
 */
function shortTmtName(name) {
  let s = String(name || '')
    .replace(/\s*(19|20)\d{2}\s*$/, '')      // trailing year
    .replace(/^\s*(19|20)\d{2}\s+/, '')      // leading year ("2026 European …")
    .trim();

  // Drop a leading run of sponsor tokens (all-caps, or known mixed-case ones).
  const words = s.split(/\s+/);
  const sponsorish = w =>
    /^[A-Z][A-Z&.'-]{1,}$/.test(w) && w !== 'BWF'
    || /^(TotalEnergies|Yonex|Victor|Daihatsu|Petronas|Perodua|Toyota|Crowne|Blibli)$/i.test(w);
  let i = 0;
  while (i < words.length - 1 && sponsorish(words[i])) i++;
  s = words.slice(i).join(' ');

  s = s
    .replace(/^BWF\s+/i, '')                 // space is tight; BWF is implied
    .replace(/\bBadminton\b/gi, '')
    .replace(/\bOpen\s+Championships?\b/i, 'Open')
    .replace(/\bChampionships?\b/gi, 'Champs')
    .replace(/\bInternational\b/gi, 'Intl')
    .replace(/\bMen's\s*&\s*Women's\s*Team\b/i, 'Team')
    .replace(/\bIndividual\b/gi, '')
    .replace(/\bThomas\s*&\s*Uber\s*Cup\s*Finals?\b/i, 'Thomas & Uber')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length > 24) s = s.slice(0, 23).trimEnd() + '…';
  return s || String(name || '');
}

/**
 * Categories left out of the season strip:
 *   20 — the World Championships itself. It hasn't been played yet, so an
 *        R64 square would read as a bad result rather than no result.
 *   21 — Thomas/Uber/Sudirman, and 17 continental team events. Team ties have
 *        no individual position (BWF returns N/A), so there is nothing to show.
 */
const SEASON_SKIP_CATS = new Set([17, 20, 21]);

async function loadSeason(playerId) {
  const d = await getJSON('vue-player-tournaments', {
    playerId, isPara: 0, drawCount: 1, activeTab: 0, tmtYear: SEASON_YEAR,
  });
  const list = (d && d.results) || [];

  // API is newest-first; a season reads left-to-right.
  return list.slice().reverse().filter(t => {
    const tm = t.tournament_model || {};
    if (SEASON_SKIP_CATS.has(tm.tournament_category_id)) return false;
    if (tm.id === TMT.id) return false;                   // this tournament
    return (t.draws || []).some(dr => dr.position && dr.position !== 'N/A');
  }).map(t => {
    const tm = t.tournament_model || {};
    return {
      id: tm.id,
      name: tm.name || '',
      short: shortTmtName(tm.name),
      level: TMT_LEVEL[tm.tournament_category_id] || '',
      start: (tm.start_date || '').slice(0, 10),
      url: t.tmt_url || '',
      draws: (t.draws || []).map(dr => ({ name: dr.name, position: dr.position,
        win: dr.match_win, lose: dr.match_lose })),
    };
  });
}

/** Pick the draw matching the current discipline, else the first one. */
function pickDraw(tmt, cat) {
  if (!tmt.draws.length) return null;
  const want = (cat || '').toUpperCase();
  return tmt.draws.find(d => (d.name || '').toUpperCase() === want) || tmt.draws[0];
}

/**
 * @param opts {align:'right'} mirrors the strip so it reads outward from the
 *             player it belongs to; {flag} repeats the country badge in the
 *             heading, which is what actually makes ownership obvious when two
 *             strips are stacked.
 */
function seasonStrip(season, cat, title, opts) {
  const o = opts || {};
  const cls = 'season-wrap' + (o.align === 'right' ? ' align-right' : '');
  const badge = o.flag ? `<img class="ttl-flag" src="${esc(o.flag)}" alt="">` : '';
  const head = `<div class="season-title">${badge}<span>${esc(title || 'Season ' + SEASON_YEAR)}</span></div>`;

  if (!season || !season.length) {
    return `<div class="${cls}">${head}
      <div class="season-empty">No ${SEASON_YEAR} tournaments recorded.</div></div>`;
  }

  const squares = season.map(t => {
    const dr = pickDraw(t, cat);
    const info = positionInfo(dr && dr.position);
    const pct = Math.round(fillFraction(info, dr) * 100);
    const wl = dr && (dr.win != null) ? ` · ${dr.win}-${dr.lose}` : '';
    const tip = `${t.name}${t.level ? ' (' + t.level + ')' : ''} — ${info.full}${wl}`;
    const inner = `
      <span class="tn">${esc(t.short)}</span>
      <span class="box r-${info.tier}" style="--pct:${pct}%">${esc(info.label)}</span>
      <span class="lv">${esc(t.level)}</span>`;
    return t.url
      ? `<a class="sq" href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(tip)}">${inner}</a>`
      : `<span class="sq" title="${esc(tip)}">${inner}</span>`;
  }).join('');

  return `<div class="${cls}">${head}
    <div class="season">${squares}</div>
  </div>`;
}

/* ============================ bracket view ============================

   Same shape as the SportsPort map view: feeders on the left, Final on the
   right, elbow connectors between, the whole thing pannable and zoomable.

   Positions are computed directly rather than by recursing the tree. A match at
   (col c, row r) is fed by (c-1, 2r) and (c-1, 2r+1), so its vertical centre is
   the midpoint of its feeders — which closes to:

       centre(c, r) = (r + 0.5) * 2^c * SLOT      where SLOT = CARD_H + GAP_Y

   i.e. every column is just a doubling of the one before it.
   ==================================================================== */

const BR = { CARD_W: 208, CARD_H: 54, GAP_Y: 10, CONN_W: 34, PAD: 26, LABEL_H: 26 };
const SLOT = BR.CARD_H + BR.GAP_Y;

const brCentre = (c, r) => (r + 0.5) * Math.pow(2, c) * SLOT;
const brLeft   = c => c * (BR.CARD_W + BR.CONN_W);

function bracketSide(m, which, mine, isBye) {
  const team = m['team' + which];
  const seed = m['team' + which + 'seed'];
  const isWin = m.winner === which;
  const isLose = (m.winner === 1 || m.winner === 2) && !isWin;
  const pts = (m.score || []).filter(g => (which === 1 ? g.home : g.away) != null)
    .map(g => (which === 1 ? g.home : g.away)).join(' ');
  const named = team && team.players && team.players.length;

  const cls = ['bnode-side', isWin ? 'win' : '', isLose ? 'lose' : '', mine ? 'mine' : ''].join(' ');
  return `<div class="${cls}">
    ${team && team.countryFlagUrl ? `<img src="${esc(team.countryFlagUrl)}" alt="" loading="lazy">` : '<span></span>'}
    <span class="bs">${esc(seedText(seed))}</span>
    <span class="bn">${named ? esc(cardName(team))
      : `<span class="muted">${isBye ? 'Bye' : '—'}</span>`}</span>
    <span class="bsc">${esc(pts)}</span>
  </div>`;
}

function renderBracket() {
  const canvas = $(CAM.canvas);
  const draw = state.draws[state.drawCat];
  canvas.innerHTML = '';

  if (!draw) {
    canvas.innerHTML = '<div class="status" style="margin:16px"><span class="spinner"></span>Loading the draw&hellip;</div>';
    return;
  }

  const cols = draw.maxCol + 1;
  const rows0 = Object.keys(draw.cells).filter(k => k.startsWith('0-')).length;
  const width  = brLeft(cols - 1) + BR.CARD_W + BR.PAD * 2;
  const height = rows0 * SLOT + BR.PAD * 2 + BR.LABEL_H;

  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const frag = document.createDocumentFragment();
  const ox = BR.PAD, oy = BR.PAD + BR.LABEL_H;

  // column headings
  for (let c = 0; c < cols; c++) {
    const any = draw.cells['' + c + '-0'];
    const name = (any && any.roundName) || ROUND_ORDER[c] || '';
    const lab = el('div', 'bcol-label', esc(ROUND_LABEL[name] || name));
    lab.style.left = (ox + brLeft(c)) + 'px';
    lab.style.top = BR.PAD + 'px';
    lab.style.width = BR.CARD_W + 'px';
    frag.appendChild(lab);
  }

  // elbow connectors: feeders (c-1, 2r) and (c-1, 2r+1) → (c, r)
  for (let c = 1; c < cols; c++) {
    const n = Object.keys(draw.cells).filter(k => k.startsWith(c + '-')).length;
    for (let r = 0; r < n; r++) {
      const y1 = oy + brCentre(c - 1, 2 * r);
      const y2 = oy + brCentre(c - 1, 2 * r + 1);
      const yc = oy + brCentre(c, r);
      const x0 = ox + brLeft(c - 1) + BR.CARD_W;
      const xm = x0 + BR.CONN_W / 2;

      const line = (l, t, w, h) => {
        const d = el('div', 'bline');
        d.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
        frag.appendChild(d);
      };
      line(x0, y1, BR.CONN_W / 2, 1);              // out of top feeder
      line(x0, y2, BR.CONN_W / 2, 1);              // out of bottom feeder
      line(xm, y1, 1, Math.max(1, y2 - y1));       // the vertical join
      line(xm, yc, BR.CONN_W / 2, 1);              // into the next match
    }
  }

  // match nodes
  for (const [k, m] of Object.entries(draw.cells)) {
    if (!m) continue;
    const [c, r] = k.split('-').map(Number);
    const isBye = c === 0 && draw.byeCodes.has(String(m.code));
    const mine1 = teamIsMine(m.team1), mine2 = teamIsMine(m.team2);

    const node = el('div', 'bnode' + (mine1 || mine2 ? ' is-mine' : '') + (isBye ? ' is-bye' : ''));
    node.style.left = (ox + brLeft(c)) + 'px';
    node.style.top = (oy + brCentre(c, r) - BR.CARD_H / 2) + 'px';
    node.style.width = BR.CARD_W + 'px';
    node.style.height = BR.CARD_H + 'px';
    node.innerHTML = bracketSide(m, 1, mine1, isBye) + bracketSide(m, 2, mine2, isBye);

    if (entryKey(m.team1) && entryKey(m.team2)) {
      // Doubles cards show surnames only, so the full pair lives on the tooltip.
      node.title = `${teamName(m.team1)}  v  ${teamName(m.team2)}\nHead-to-head`;
      // A click that ended a pan is swallowed by the capture-phase guard on the
      // viewport, so this only ever runs for a genuine click.
      node.addEventListener('click', () => openH2H(m.team1, m.team2));
    } else {
      node.style.cursor = 'default';
    }
    frag.appendChild(node);
  }

  canvas.appendChild(frag);
  frameMap();
}

/* ---- camera ----

   The Draw view is one pannable map showing one tree. Results and the three
   prediction sources are modes of it, not separate views, so they share a
   camera: flipping between what you predicted and what actually happened keeps
   your zoom and your place on the draw.
*/

const CAM = {
  vp: '#drawViewport', canvas: '#drawCanvas', readout: '#zoomLevel',
  node: '.bnode, .pnode',            // only one kind is on the canvas at a time
  zoom: 1, pan: { x: 0, y: 0 },
};

const mapFor = () => CAM;

/**
 * Keep the canvas inside its viewport: centre it on whichever axis it is
 * smaller than the viewport, and otherwise stop it being dragged (or jumped)
 * off into empty space.
 */
function clampPan(cam) {
  const vp = $(cam.vp).getBoundingClientRect();
  if (!vp.width || !vp.height) return;             // section still hidden
  const canvas = $(cam.canvas);
  const w = (parseFloat(canvas.style.width) || 0) * cam.zoom;
  const h = (parseFloat(canvas.style.height) || 0) * cam.zoom;
  const m = 24;                                     // breathing room at the edges

  cam.pan.x = w <= vp.width
    ? (vp.width - w) / 2
    : Math.min(m, Math.max(vp.width - w - m, cam.pan.x));
  cam.pan.y = h <= vp.height
    ? (vp.height - h) / 2
    : Math.min(m, Math.max(vp.height - h - m, cam.pan.y));
}

function applyTransform(cam) {
  clampPan(cam);
  const c = $(cam.canvas);
  c.style.transform = `translate(${cam.pan.x}px, ${cam.pan.y}px) scale(${cam.zoom})`;
  $(cam.readout).textContent = Math.round(cam.zoom * 100) + '%';
}

function setZoom(cam, z, originX, originY) {
  const next = Math.min(2, Math.max(0.12, z));
  const vp = $(cam.vp).getBoundingClientRect();
  // keep the point under the cursor (or the viewport centre) fixed
  const px = originX == null ? vp.width / 2 : originX - vp.left;
  const py = originY == null ? vp.height / 2 : originY - vp.top;
  const k = next / cam.zoom;
  cam.pan.x = px - (px - cam.pan.x) * k;
  cam.pan.y = py - (py - cam.pan.y) * k;
  cam.zoom = next;
  applyTransform(cam);
}

function fitBracket(cam) {
  cam = cam || mapFor();
  const canvas = $(cam.canvas);
  const vp = $(cam.vp).getBoundingClientRect();
  const w = parseFloat(canvas.style.width) || 1;
  const h = parseFloat(canvas.style.height) || 1;
  if (!vp.width || !vp.height) return;
  cam.zoom = Math.min(2, Math.max(0.12, Math.min(vp.width / w, vp.height / h)));
  cam.pan.x = (vp.width - w * cam.zoom) / 2;
  cam.pan.y = (vp.height - h * cam.zoom) / 2;
  applyTransform(cam);
}

/**
 * Centre the view on the first followed player in this draw, at the zoom you
 * are already using — except when that is so far out the names are unreadable,
 * which would make "jump to my player" land on an unrecognisable speck.
 */
function jumpToMine(cam) {
  cam = cam || mapFor();
  const node = $(cam.canvas + ' ' + cam.node + '.is-mine');
  if (!node) { applyTransform(cam); return; }
  const vp = $(cam.vp).getBoundingClientRect();
  if (cam.zoom < 0.5) cam.zoom = 1;
  const nx = parseFloat(node.style.left) + BR.CARD_W / 2;
  const ny = parseFloat(node.style.top) + BR.CARD_H / 2;
  cam.pan.x = vp.width / 2 - nx * cam.zoom;
  cam.pan.y = vp.height / 2 - ny * cam.zoom;
  applyTransform(cam);
}

/**
 * Frame a map view once its section is visible and has a size.
 *
 * Every draw opens at 100% — a bracket scaled to fit is 63 cards of unreadable
 * text, and *Fit* is right there for anyone who wants the overview. The zoom
 * is only reset when the discipline changes, so tabbing away to the Players
 * view and back does not throw away where you were looking.
 */
function frameMap() {
  const cam = CAM;
  const cat = state.drawCat;
  // Nothing to frame against until the draw is in: leave framedFor unset so
  // the render that follows the fetch does the framing instead. Note this keys
  // on the discipline only — switching between Results and a prediction sheet
  // is the same tree, so it must not move the camera.
  if (!state.draws[cat] || cam.framedFor === cat) {
    requestAnimationFrame(() => applyTransform(cam));
    return;
  }
  cam.framedFor = cat;
  cam.zoom = 1;
  cam.pan.x = cam.pan.y = 24;
  requestAnimationFrame(() => (state.selected.size ? jumpToMine(cam) : applyTransform(cam)));
}

let canvasDidPan = false;

function initBracketInteraction(cam) {
  const vp = $(cam.vp);
  let dragging = false, sx = 0, sy = 0, px = 0, py = 0;

  const onMove = e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) canvasDidPan = true;
    cam.pan.x = px + dx; cam.pan.y = py + dy;
    applyTransform(cam);
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    vp.classList.remove('is-panning');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  vp.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true; canvasDidPan = false;
    sx = e.clientX; sy = e.clientY; px = cam.pan.x; py = cam.pan.y;
    vp.classList.add('is-panning');
    // NB: deliberately no preventDefault here and no setPointerCapture.
    // preventDefault on pointerdown can suppress the follow-up click in some
    // browsers, and pointer capture retargets that click to the viewport —
    // either one stops match nodes from ever seeing it. Selection is blocked by
    // `user-select: none` plus the selectstart handler below instead.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  // Capture phase: runs before any node's own handler, so a click that merely
  // ended a pan never reaches the match card.
  vp.addEventListener('click', e => {
    if (!canvasDidPan) return;
    e.stopPropagation();
    e.preventDefault();
    canvasDidPan = false;
  }, true);

  // Selecting bracket text is never useful and makes dragging feel broken.
  vp.addEventListener('selectstart', e => e.preventDefault());
  vp.addEventListener('dragstart', e => e.preventDefault());

  // The wheel scrolls the bracket rather than zooming it: two-finger up/down
  // and left/right pan, which is what a big map wants. Zooming stays on the
  // buttons and +/-, plus ctrl+wheel — which is also what a trackpad pinch
  // sends, so pinch-to-zoom keeps working.
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      setZoom(cam, cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
      return;
    }
    // deltaMode 1 = lines, 2 = pages; normalise both to something pixel-ish.
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    let dx = e.deltaX * k, dy = e.deltaY * k;
    // A plain mouse has no horizontal axis; shift+wheel is the usual stand-in.
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    cam.pan.x -= dx;
    cam.pan.y -= dy;
    applyTransform(cam);
  }, { passive: false });
}

/** Wire one map view's zoom buttons. */
function initZoomBar(cam, ids) {
  $(ids.in).onclick   = () => setZoom(cam, cam.zoom * 1.2);
  $(ids.out).onclick  = () => setZoom(cam, cam.zoom / 1.2);
  $(ids.fit).onclick  = () => fitBracket(cam);
  $(ids.mine).onclick = () => jumpToMine(cam);
}

/* ============================ predictions ============================

   The same tree as the Bracket view, but filled in by *you* rather than by
   BWF. Each side of a match carries a dimmed W; click one and that entry is
   carried into the next card, and the one after that, all the way to the title.

   Three sources, switched by the buttons in the toolbar:
     yours  — your own clicks, kept in localStorage per discipline
     world  — auto: the better BWF World Ranking wins every match
     race   — auto: the better Race to Finals standing wins every match

   The auto brackets are read-only. They exist to answer "what does the form
   book say?" — and can be copied into your own sheet as a starting point.
   ==================================================================== */

/** The four ways the same tree can be filled in. */
const DRAW_MODES = ['results', 'yours', 'world', 'race'];

/** Your picks for one discipline: { matchCode: entryKey }. */
function predPicks(cat) {
  if (!state.predict[cat]) state.predict[cat] = {};
  return state.predict[cat];
}

/**
 * Stamp the sheet as touched today. The PNG carries this date, so it has to be
 * when the picks were made — not when the image was exported.
 */
function persistPredictions(cat) {
  if (cat) state.predictAt[cat] = new Date().toISOString();
  store.write('predict', state.predict);
  store.write('predictAt', state.predictAt);
}

/**
 * Auto-pick between two entries on a ranking board. Unranked entries (outside
 * the pages we walked) fall back to the seeding, and an otherwise dead heat
 * keeps the top side — arbitrary, but stable, so the bracket never flickers.
 */
function autoWinner(draw, board, t1, t2) {
  const k1 = entryKey(t1), k2 = entryKey(t2);
  const r1 = rankOf(draw.cat, k1, board), r2 = rankOf(draw.cat, k2, board);
  if (r1 !== r2) return r1 < r2 ? t1 : t2;
  const s = k => {
    const e = draw.entries.get(k);
    return e && e.seed ? Number(e.seed) : 999;
  };
  const s1 = s(k1), s2 = s(k2);
  if (s1 !== s2) return s1 < s2 ? t1 : t2;
  return t1;
}

/**
 * Carry winners up the tree, column by column.
 *
 * Reality is deliberately NOT merged in: this is a prediction sheet, so the
 * cards show who *you* said would be there. Real results only score it.
 */
function resolvePredictions(draw, mode) {
  const picks = mode === 'yours' ? predPicks(draw.cat) : null;
  const board = mode === 'yours' ? null : mode;

  const teams = {}, winner = {}, verdict = {};
  let open = 0, made = 0, decided = 0, hits = 0;

  for (let c = 0; c <= draw.maxCol; c++) {
    const n = cellsInCol(draw, c);
    for (let r = 0; r < n; r++) {
      const k = c + '-' + r;
      const m = draw.cells[k];
      const t1 = c === 0 ? (m && m.team1) || null : winner[(c - 1) + '-' + (2 * r)] || null;
      const t2 = c === 0 ? (m && m.team2) || null : winner[(c - 1) + '-' + (2 * r + 1)] || null;
      teams[k] = [t1, t2];

      const k1 = entryKey(t1), k2 = entryKey(t2);
      const isBye = c === 0 && m && draw.byeCodes.has(String(m.code));
      let w = null;

      // The denominator is every match that will ever need a pick, not just the
      // ones with both sides known — otherwise the tally reads "1/32" early on
      // and climbs to "63/63" as you fill the draw in, which looks like the
      // target is moving away from you.
      if (m && !isBye) open++;

      if (isBye) {
        // Through on a walkover. Test with entryKey, not truthiness: BWF fills
        // the empty half of a bye with a team object that has no players, so
        // `t1 || t2` happily advances the *gap* — and when the gap is team1
        // (which is half of them) the pair never reaches round two at all.
        w = k1 ? t1 : (k2 ? t2 : null);
      } else if (k1 && k2) {
        if (board) {
          w = autoWinner(draw, board, t1, t2);
          made++;
        } else {
          const pick = m && picks[String(m.code)];
          if (pick === k1) w = t1; else if (pick === k2) w = t2;
          if (w) made++;
        }
      }
      // A half-empty card above round one means a feeder is still open — nobody
      // advances from it, or the whole draw would fill itself in.

      winner[k] = w;

      // Score against what actually happened, whoever we thought would be here.
      if (!isBye && m && (m.winner === 1 || m.winner === 2)) {
        const real = entryKey(m['team' + m.winner]);
        if (real) {
          decided++;
          if (w) {
            const right = entryKey(w) === real;
            verdict[k] = right ? 'hit' : 'miss';
            if (right) hits++;
          }
          verdict[k + ':real'] = real;
        }
      }
    }
  }

  const champion = winner[draw.maxCol + '-0'] || null;
  return { teams, winner, verdict, champion, open, made, decided, hits };
}

/** Stale picks are kept, not pruned: flip an upset back and your sheet returns. */
function setPick(draw, code, key) {
  const picks = predPicks(draw.cat);
  if (picks[String(code)] === key) delete picks[String(code)];
  else picks[String(code)] = key;
  persistPredictions(draw.cat);
  renderDraw();
}

function predSide(m, t, which, isBye, res) {
  const seed = m && m['team' + which + 'seed'];
  const named = t && t.players && t.players.length;
  const mine = teamIsMine(t);
  const cls = ['pnode-side',
    res.picked === which ? 'is-pick' : (res.picked ? 'is-out' : ''),
    mine ? 'mine' : ''].join(' ');

  // Column 0 carries BWF's own seeding; later cards are hypothetical, so the
  // seed is looked up from the entry rather than from the (empty) draw cell.
  const seedShown = seed || (res.seedOf ? res.seedOf(t) : '');

  return `<div class="${cls}" data-side="${which}">
    ${t && t.countryFlagUrl ? `<img src="${esc(t.countryFlagUrl)}" alt="" loading="lazy">` : '<span></span>'}
    <span class="bs">${esc(seedText(seedShown))}</span>
    <span class="bn">${named ? esc(cardName(t))
      : `<span class="muted">${isBye ? 'Bye' : '&mdash;'}</span>`}</span>
    ${isBye || !named ? '<span class="pw is-void"></span>'
                      : `<span class="pw" title="Pick to win">W</span>`}
  </div>`;
}

function renderPredict() {
  const canvas = $(CAM.canvas);
  const cat = state.drawCat;
  const draw = state.draws[cat];
  canvas.innerHTML = '';
  paintPredictBar(null);

  if (!draw) {
    canvas.innerHTML = '<div class="status" style="margin:16px"><span class="spinner"></span>Loading the draw&hellip;</div>';
    return;
  }

  const mode = state.drawMode;
  const res = resolvePredictions(draw, mode);
  const editable = mode === 'yours';
  const seedOf = t => {
    const e = draw.entries.get(entryKey(t));
    return e ? e.seed : '';
  };

  const cols = draw.maxCol + 1;
  const rows0 = cellsInCol(draw, 0);
  // One extra column for the champion card.
  const width  = brLeft(cols) + BR.CARD_W + BR.PAD * 2;
  const height = rows0 * SLOT + BR.PAD * 2 + BR.LABEL_H;
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';

  const frag = document.createDocumentFragment();
  const ox = BR.PAD, oy = BR.PAD + BR.LABEL_H;

  for (let c = 0; c < cols; c++) {
    const any = draw.cells['' + c + '-0'];
    const name = (any && any.roundName) || ROUND_ORDER[c] || '';
    const lab = el('div', 'bcol-label', esc(ROUND_LABEL[name] || name));
    lab.style.cssText = `left:${ox + brLeft(c)}px;top:${BR.PAD}px;width:${BR.CARD_W}px`;
    frag.appendChild(lab);
  }
  const champLab = el('div', 'bcol-label', 'Champion');
  champLab.style.cssText = `left:${ox + brLeft(cols)}px;top:${BR.PAD}px;width:${BR.CARD_W}px`;
  frag.appendChild(champLab);

  // elbow connectors, plus one more into the champion card
  for (let c = 1; c <= cols; c++) {
    const n = c === cols ? 1 : cellsInCol(draw, c);
    for (let r = 0; r < n; r++) {
      const y1 = oy + brCentre(c - 1, 2 * r);
      const y2 = oy + brCentre(c - 1, 2 * r + 1);
      const yc = oy + brCentre(c, r);
      const x0 = ox + brLeft(c - 1) + BR.CARD_W;
      const xm = x0 + BR.CONN_W / 2;
      const line = (l, t, w, h) => {
        const d = el('div', 'bline');
        d.style.cssText = `left:${l}px;top:${t}px;width:${w}px;height:${h}px`;
        frag.appendChild(d);
      };
      if (c === cols) {
        // The Final feeds one card, so it is a straight run, not an elbow.
        line(x0, oy + brCentre(c - 1, 0), BR.CONN_W, 1);
      } else {
        line(x0, y1, BR.CONN_W / 2, 1);
        line(x0, y2, BR.CONN_W / 2, 1);
        line(xm, y1, 1, Math.max(1, y2 - y1));
        line(xm, yc, BR.CONN_W / 2, 1);
      }
    }
  }

  for (let c = 0; c <= draw.maxCol; c++) {
    const n = cellsInCol(draw, c);
    for (let r = 0; r < n; r++) {
      const k = c + '-' + r;
      const m = draw.cells[k];
      if (!m) continue;
      const [t1, t2] = res.teams[k];
      const w = res.winner[k];
      const isBye = c === 0 && draw.byeCodes.has(String(m.code));
      const live = !isBye && entryKey(t1) && entryKey(t2);
      // A walkover has nothing to choose, so neither side is styled as a pick.
      const picked = !isBye && w ? (entryKey(w) === entryKey(t1) ? 1 : 2) : 0;
      const mark = res.verdict[k];

      const node = el('div', 'pnode'
        + (teamIsMine(t1) || teamIsMine(t2) ? ' is-mine' : '')
        + (isBye ? ' is-bye' : '')
        + (editable && live ? '' : ' is-locked')
        + (mark ? ' is-' + mark : ''));
      node.style.cssText =
        `left:${ox + brLeft(c)}px;top:${oy + brCentre(c, r) - BR.CARD_H / 2}px;` +
        `width:${BR.CARD_W}px;height:${BR.CARD_H}px`;
      node.innerHTML = predSide(c === 0 ? m : null, t1, 1, isBye, { picked, seedOf })
                     + predSide(c === 0 ? m : null, t2, 2, isBye, { picked, seedOf });

      // Doubles cards show surnames only, so the full pairs live on the tooltip.
      const full = entryKey(t1) && entryKey(t2)
        ? `${teamName(t1)}  v  ${teamName(t2)}` : '';
      if (mark) {
        const realKey = res.verdict[k + ':real'];
        const realTeam = [m.team1, m.team2].find(t => entryKey(t) === realKey);
        node.title = (full ? full + '\n' : '') +
          (mark === 'hit' ? 'Right — ' : 'Wrong — ') + teamName(realTeam) + ' won this';
      } else if (full) {
        node.title = full;
      }

      if (editable && live) {
        node.addEventListener('click', e => {
          const side = e.target.closest('.pnode-side');
          if (!side) return;
          const t = side.dataset.side === '1' ? t1 : t2;
          setPick(draw, m.code, entryKey(t));
        });
      }
      frag.appendChild(node);
    }
  }

  // champion card
  const champ = el('div', 'pnode pchamp' + (res.champion && teamIsMine(res.champion) ? ' is-mine' : ''));
  champ.style.cssText =
    `left:${ox + brLeft(cols)}px;top:${oy + brCentre(draw.maxCol, 0) - BR.CARD_H / 2}px;` +
    `width:${BR.CARD_W}px;height:${BR.CARD_H}px`;
  if (res.champion) champ.title = teamName(res.champion);
  champ.innerHTML = res.champion
    ? `<div class="pnode-side is-pick">
         ${res.champion.countryFlagUrl ? `<img src="${esc(res.champion.countryFlagUrl)}" alt="" loading="lazy">` : '<span></span>'}
         <span class="bs">&#127942;</span>
         <span class="bn">${esc(cardName(res.champion))}</span>
         <span class="pw is-void"></span>
       </div>`
    : '<div class="pnode-side"><span></span><span class="bs">&#127942;</span><span class="bn muted">Not decided yet</span><span class="pw is-void"></span></div>';
  frag.appendChild(champ);

  canvas.appendChild(frag);
  frameMap();
  paintPredictBar(res);
}

/**
 * The Draw view. Results and the three prediction sources are the same tree
 * filled in four different ways, so they share this one entry point — and the
 * camera, which is why switching mode never moves the draw under you.
 */
function renderDraw() {
  if (state.drawMode !== 'results') {
    // renderPredict paints the bar itself, tally included. Repainting the
    // chrome afterwards would blank the tally it just worked out.
    renderPredict();
    return;
  }
  renderBracket();
  paintPredictBar(null, true);
}

const DRAW_HINTS = {
  results: 'Scroll or drag to move · <kbd>+</kbd>&thinsp;/&thinsp;<kbd>&minus;</kbd> zoom · <kbd>0</kbd> 100% · <kbd>F</kbd> fit · click a match for the head-to-head',
  yours:   'Click the <b>W</b> beside whoever you think wins — they carry up the draw',
  world:   'Read-only: the better BWF World Ranking wins every match',
  race:    'Read-only: the better Race to Finals standing wins every match',
};

/** Mode buttons, tally and the action buttons beside them. */
function paintPredictBar(res, chromeOnly) {
  $$('.dcat').forEach(b => b.classList.toggle('is-active', b.dataset.dcat === state.drawCat));
  $$('.pmode').forEach(b => b.classList.toggle('is-active', b.dataset.pmode === state.drawMode));

  const results = state.drawMode === 'results';
  const auto = !results && state.drawMode !== 'yours';
  $('#predictCopy').hidden = !auto;
  $('#predictClear').hidden = results || auto;
  $('#predictPng').hidden = results;
  $('#drawHint').innerHTML = DRAW_HINTS[state.drawMode] || '';

  const box = $('#predictScore');
  if (results) { box.textContent = ''; return; }
  if (chromeOnly || !res) { if (!res) box.textContent = ''; return; }

  const parts = [];
  if (auto) {
    const idx = state.ranks[rankSlot(state.drawMode, state.drawCat)];
    if (!idx || !idx.__done) parts.push('Loading rankings&hellip;');
    else parts.push(BOARDS[state.drawMode].label + ' bracket');
  } else {
    parts.push(`<b>${res.made}</b>/${res.open} picked`);
  }
  if (res.decided) parts.push(`<b>${res.hits}</b>/${res.decided} right so far`);
  box.innerHTML = parts.join(' &middot; ');
}

function setDrawCat(c) {
  state.drawCat = c;
  store.write('drawCat', c);
  paintCatChips();
  renderDraw();
  frameMap();
  loadDraw(c).then(() => renderDraw()).catch(() => {});
  ensurePredictRanks();
}

function setDrawMode(mode) {
  state.drawMode = mode;
  store.write('drawMode', mode);
  renderDraw();
  ensurePredictRanks();
}

/** Auto brackets need the ranking table for the board they are built on. */
function ensurePredictRanks() {
  const mode = state.drawMode;
  if (mode === 'yours' || mode === 'results') return;
  const cat = state.drawCat;
  if (!state.draws[cat] || state.ranks[rankSlot(mode, cat)]) return;
  loadRankIndex(cat, mode)
    .then(() => { if (state.view === 'draw') renderDraw(); })
    .catch(() => { /* falls back to seeding */ });
}

/** Copy the ranking-based bracket into your own sheet as a starting point. */
function copyAutoToPicks() {
  const draw = state.draws[state.drawCat];
  if (!draw) return;
  const res = resolvePredictions(draw, state.drawMode);
  const picks = {};
  for (const [k, m] of Object.entries(draw.cells)) {
    if (!m) continue;
    const w = res.winner[k];
    const [t1, t2] = res.teams[k];
    if (!w || !entryKey(t1) || !entryKey(t2)) continue;
    if (k.startsWith('0-') && draw.byeCodes.has(String(m.code))) continue;
    picks[String(m.code)] = entryKey(w);
  }
  state.predict[state.drawCat] = picks;
  persistPredictions(state.drawCat);
  setDrawMode('yours');
}

function clearPicks() {
  state.predict[state.drawCat] = {};
  delete state.predictAt[state.drawCat];
  persistPredictions();
  renderDraw();
}

/* ---- PNG export ----

   Drawn by hand onto a 2× canvas rather than by rasterising the DOM: that
   needs a library, and this file has no build step and loads nothing from a
   CDN. The upside is a sheet laid out for sharing — title, discipline, and the
   date the predictions were made baked in.

   Flags are fetched with crossOrigin="anonymous". If BWF's image host declines
   the CORS header the load simply fails and the flag is skipped, which is much
   better than a tainted canvas that cannot be exported at all.
*/

const PNG_SCALE = 2;

/**
 * One colour per semi-finalist, for tracing their route back through the draw
 * on the exported sheet. Only four routes are drawn, which is what makes this
 * palette possible: blue / green / orange / purple sit roughly 90° apart on
 * the wheel, are taken from Okabe-Ito (designed to stay distinguishable under
 * every common form of colour blindness), and are mid-toned enough to read on
 * the white surface and the dark one alike. All four are also kept clear of
 * the BWF red the W badges use, so a route never reads as a badge.
 */
const PATH_COLOURS = ['#1f7fd0', '#00a878', '#e08a00', '#c05fb4'];

const flagPending = new Map();   // url -> Promise
const flagReady = new Map();     // url -> HTMLImageElement | null (null = unusable)

function loadFlag(url) {
  if (!url) return Promise.resolve(null);
  if (flagPending.has(url)) return flagPending.get(url);
  const p = new Promise(res => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { flagReady.set(url, img); res(img); };
    img.onerror = () => { flagReady.set(url, null); res(null); };
    img.src = url;
  });
  flagPending.set(url, p);
  return p;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Trim a name to fit a column, with an ellipsis if it has to be cut. */
function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

/**
 * The full route of each predicted semi-finalist: walk back from the
 * semi-final card asking at each column which feeder produced the side we are
 * following, then walk forward again for as long as they keep winning. So a
 * beaten semi-finalist's route stops at the semi-final, a beaten finalist's
 * runs one card further, and the champion's runs the length of the draw.
 *
 * Returns up to four { colour, champion, cells } chains, each cell tagged with
 * the half of the card that belongs to that player.
 *
 * The colour is taken before the empty check, so a slot keeps its colour
 * whether or not the sheet has been filled in that far.
 */
function semiFinalPaths(draw, res) {
  const sfCol = draw.maxCol - 1;                 // the column before the Final
  if (sfCol < 1) return [];
  const paths = [];
  let n = 0;
  for (let r = 0; r < cellsInCol(draw, sfCol); r++) {
    const slot = res.teams[sfCol + '-' + r] || [null, null];
    for (const side of [1, 2]) {
      const colour = PATH_COLOURS[n++ % PATH_COLOURS.length];
      const team = slot[side - 1];
      const key = entryKey(team);
      if (!key) continue;                        // nobody predicted this far yet

      const cells = [{ c: sfCol, r, side }];
      let c = sfCol, row = r, s = side;
      while (c > 0) {
        row = 2 * row + (s - 1);                 // the feeder this side came out of
        c -= 1;
        const feeder = res.teams[c + '-' + row] || [null, null];
        s = entryKey(feeder[0]) === key ? 1 : 2;
        cells.push({ c, r: row, side: s });
      }

      // Forward, for as long as they keep winning. A match at (c, r) feeds
      // (c+1, r/2), landing on the top half from an even row and the bottom
      // half from an odd one.
      let fc = sfCol, fr = r;
      while (fc < draw.maxCol) {
        const won = res.winner[fc + '-' + fr];
        if (!won || entryKey(won) !== key) break;
        const nextSide = fr % 2 === 0 ? 1 : 2;
        fc += 1;
        fr = Math.floor(fr / 2);
        cells.unshift({ c: fc, r: fr, side: nextSide });
      }
      // Winning the Final is the one step with no card of its own — it lands
      // on the champion cell, which is drawn separately.
      const champion = entryKey(res.winner[draw.maxCol + '-0']) === key;

      paths.push({ colour, champion, cells });
    }
  }
  return paths;
}

async function exportPredictionsPng(btn) {
  const cat = state.drawCat;
  const draw = state.draws[cat];
  if (!draw) return;

  const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Rendering…'; }
  try {
    const mode = state.drawMode;
    const res = resolvePredictions(draw, mode);

    const HEAD = 76, FOOT = 34;
    const cols = draw.maxCol + 1;
    const rows0 = cellsInCol(draw, 0);
    const w = brLeft(cols) + BR.CARD_W + BR.PAD * 2;
    const h = rows0 * SLOT + BR.PAD * 2 + BR.LABEL_H + HEAD + FOOT;

    const cv = document.createElement('canvas');
    cv.width = Math.round(w * PNG_SCALE);
    cv.height = Math.round(h * PNG_SCALE);
    const ctx = cv.getContext('2d');
    ctx.scale(PNG_SCALE, PNG_SCALE);

    const font = cssVar('--font') || 'system-ui, sans-serif';
    const C = {
      bg: cssVar('--bg') || '#111', surface: cssVar('--surface') || '#1e1e1e',
      border: cssVar('--border') || '#444', soft: cssVar('--border-soft') || '#333',
      text: cssVar('--text') || '#eee', dim: cssVar('--text-dim') || '#bbb',
      muted: cssVar('--text-muted') || '#888',
      accent: cssVar('--accent') || '#df2027', accentFg: cssVar('--accent-fg') || '#fff',
      accentText: cssVar('--accent-text') || '#ff5f64',
    };

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    // --- header ---
    const made = state.predictAt[cat];
    const stamp = new Date(made || Date.now())
      .toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
    const source = mode === 'yours'
      ? 'Predictions made ' + stamp
      : BOARDS[mode].label + ' — the better-ranked side wins every match';

    ctx.fillStyle = C.accent;
    ctx.fillRect(0, 0, w, 4);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.text;
    ctx.font = `700 21px ${font}`;
    ctx.fillText(`BWF World Championships 2026 · ${CAT_LABEL[cat]}`, BR.PAD, 34);
    ctx.fillStyle = C.muted;
    ctx.font = `400 12.5px ${font}`;
    ctx.fillText(`New Delhi, 17–23 August 2026 · ${source}`, BR.PAD, 54);

    const oy = HEAD + BR.PAD + BR.LABEL_H, ox = BR.PAD;

    // --- round headings ---
    ctx.font = `700 11px ${font}`;
    ctx.fillStyle = C.muted;
    for (let c = 0; c < cols; c++) {
      const any = draw.cells['' + c + '-0'];
      const name = (any && any.roundName) || ROUND_ORDER[c] || '';
      ctx.fillText((ROUND_LABEL[name] || name).toUpperCase(), ox + brLeft(c), HEAD + BR.PAD + 12);
    }
    ctx.fillText('CHAMPION', ox + brLeft(cols), HEAD + BR.PAD + 12);

    // --- connectors ---
    ctx.fillStyle = C.border;
    for (let c = 1; c <= cols; c++) {
      const n = c === cols ? 1 : cellsInCol(draw, c);
      for (let r = 0; r < n; r++) {
        const x0 = ox + brLeft(c - 1) + BR.CARD_W, xm = x0 + BR.CONN_W / 2;
        if (c === cols) { ctx.fillRect(x0, oy + brCentre(c - 1, 0), BR.CONN_W, 1); continue; }
        const y1 = oy + brCentre(c - 1, 2 * r), y2 = oy + brCentre(c - 1, 2 * r + 1);
        ctx.fillRect(x0, y1, BR.CONN_W / 2, 1);
        ctx.fillRect(x0, y2, BR.CONN_W / 2, 1);
        ctx.fillRect(xm, y1, 1, Math.max(1, y2 - y1));
        ctx.fillRect(xm, oy + brCentre(c, r), BR.CONN_W / 2, 1);
      }
    }

    // Warm the flag cache first so drawing itself stays synchronous.
    const flags = new Set();
    for (const [k] of Object.entries(res.teams)) {
      for (const t of res.teams[k]) if (t && t.countryFlagUrl) flags.add(t.countryFlagUrl);
    }
    await Promise.all(Array.from(flags).map(loadFlag));

    const drawSide = (t, x, y, seed, picked, dimmed, bye) => {
      const cx = x + 9;
      // BWF fills the empty half of a bye with a players-less team object, so
      // "is there a team here" has to be entryKey, not truthiness.
      const named = !!entryKey(t);
      const bitmap = t && t.countryFlagUrl ? flagReady.get(t.countryFlagUrl) : null;
      ctx.globalAlpha = dimmed ? 0.45 : 1;
      if (bitmap) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx + 7, y + BR.CARD_H / 4, 7, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(bitmap, cx, y + BR.CARD_H / 4 - 7, 14, 14);
        ctx.restore();
      }
      if (seed) {
        ctx.fillStyle = C.accentText;
        ctx.font = `700 9.5px ${font}`;
        ctx.fillText('[' + seed + ']', x + 26, y + BR.CARD_H / 4 + 3.5);
      }
      ctx.fillStyle = named ? C.text : C.muted;
      ctx.font = `${picked ? 700 : 400} 11.5px ${font}`;
      const nameX = x + 50, nameMax = BR.CARD_W - 50 - 24;
      ctx.fillText(fitText(ctx, named ? cardName(t) : (bye ? 'Bye' : '—'), nameMax),
        nameX, y + BR.CARD_H / 4 + 4);
      if (named) {
        const bx = x + BR.CARD_W - 22, by = y + BR.CARD_H / 4 - 7;
        ctx.fillStyle = picked ? C.accent : 'transparent';
        if (picked) { ctx.fillRect(bx, by, 15, 14); }
        ctx.fillStyle = picked ? C.accentFg : C.muted;
        ctx.font = `700 9.5px ${font}`;
        ctx.fillText('W', bx + 4, by + 10.5);
      }
      ctx.globalAlpha = 1;
    };

    // --- semi-final routes ---
    // Indexed by cell so the highlight can be painted between a card's
    // background and its text: a tint drawn afterwards would sit on top of the
    // names it is meant to pick out.
    const routes = semiFinalPaths(draw, res);
    const routeAt = new Map();
    for (const p of routes) {
      for (const cell of p.cells) {
        const k = cell.c + '-' + cell.r;
        if (!routeAt.has(k)) routeAt.set(k, []);
        routeAt.get(k).push({ side: cell.side, colour: p.colour });
      }
    }

    // --- cards ---
    for (let c = 0; c <= draw.maxCol; c++) {
      const n = cellsInCol(draw, c);
      for (let r = 0; r < n; r++) {
        const k = c + '-' + r;
        const m = draw.cells[k];
        if (!m) continue;
        const [t1, t2] = res.teams[k];
        const win = res.winner[k];
        const isBye = c === 0 && draw.byeCodes.has(String(m.code));
        const p1 = !isBye && win && entryKey(win) === entryKey(t1);
        const p2 = !isBye && win && entryKey(win) === entryKey(t2);
        const x = ox + brLeft(c), y = oy + brCentre(c, r) - BR.CARD_H / 2;

        ctx.globalAlpha = isBye ? 0.5 : 1;
        ctx.fillStyle = C.surface;
        ctx.fillRect(x, y, BR.CARD_W, BR.CARD_H);
        ctx.strokeStyle = C.soft;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, BR.CARD_W - 1, BR.CARD_H - 1);
        ctx.fillStyle = C.border;
        ctx.fillRect(x, y, 3, BR.CARD_H);                     // accent rail
        ctx.fillRect(x, y + BR.CARD_H / 2, BR.CARD_W, 1);     // split
        ctx.globalAlpha = 1;

        // Box the half of the card that belongs to a semi-finalist, so the
        // route is legible at the name itself and not only in the gaps.
        for (const hit of routeAt.get(k) || []) {
          const hy = y + (hit.side === 1 ? 0 : BR.CARD_H / 2);
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = hit.colour;
          ctx.fillRect(x, hy, BR.CARD_W, BR.CARD_H / 2);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = hit.colour;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, hy + 0.75, BR.CARD_W - 1.5, BR.CARD_H / 2 - 1.5);
          ctx.fillRect(x, hy, 3, BR.CARD_H / 2);              // the rail, solid
        }

        const seedOf = t => {
          if (c === 0) return t === t1 ? m.team1seed : m.team2seed;
          const e = draw.entries.get(entryKey(t));
          return e ? e.seed : '';
        };
        drawSide(t1, x, y, seedOf(t1), p1, !!win && !p1, isBye);
        drawSide(t2, x, y + BR.CARD_H / 2, seedOf(t2), p2, !!win && !p2, isBye);
      }
    }

    // --- the connectors joining each route's cards ---
    for (const p of routes) {
      ctx.fillStyle = p.colour;
      for (const cell of p.cells) {
        const to = p.cells.find(o => o.c === cell.c + 1);
        if (!to) continue;
        const x0 = ox + brLeft(cell.c) + BR.CARD_W, xm = x0 + BR.CONN_W / 2;
        const y1 = oy + brCentre(cell.c, cell.r);
        const y2 = oy + brCentre(to.c, to.r);
        ctx.fillRect(x0, y1 - 1, BR.CONN_W / 2, 2);
        ctx.fillRect(xm - 1, Math.min(y1, y2), 2, Math.max(2, Math.abs(y2 - y1)));
        ctx.fillRect(xm, y2 - 1, BR.CONN_W / 2, 2);
      }
      // The Final feeds the champion cell down a straight run, not an elbow.
      if (p.champion) {
        const x0 = ox + brLeft(draw.maxCol) + BR.CARD_W;
        ctx.fillRect(x0, oy + brCentre(draw.maxCol, 0) - 1, BR.CONN_W, 2);
      }
    }

    // --- champion ---
    // Carries the winner's route colour, so the trace runs unbroken from the
    // round they entered right through to the trophy.
    const winnerRoute = routes.find(p => p.champion);
    const champColour = winnerRoute ? winnerRoute.colour : C.accent;
    const cx0 = ox + brLeft(cols), cy0 = oy + brCentre(draw.maxCol, 0) - BR.CARD_H / 2;
    ctx.fillStyle = C.surface;
    ctx.fillRect(cx0, cy0, BR.CARD_W, BR.CARD_H);
    if (winnerRoute) {
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = champColour;
      ctx.fillRect(cx0, cy0, BR.CARD_W, BR.CARD_H);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = champColour;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(cx0 + 0.75, cy0 + 0.75, BR.CARD_W - 1.5, BR.CARD_H - 1.5);
    ctx.fillStyle = champColour;
    ctx.fillRect(cx0, cy0, 3, BR.CARD_H);                     // the rail
    ctx.fillStyle = C.muted;
    ctx.font = `700 9px ${font}`;
    ctx.fillText('CHAMPION', cx0 + 12, cy0 + 19);
    ctx.fillStyle = res.champion ? C.text : C.muted;
    ctx.font = `700 13px ${font}`;
    ctx.fillText(fitText(ctx, res.champion ? cardName(res.champion) : 'Not decided yet', BR.CARD_W - 24),
      cx0 + 12, cy0 + 39);

    // --- footer ---
    ctx.fillStyle = C.muted;
    ctx.font = `400 11px ${font}`;
    ctx.fillText('Unofficial fan tool · draw data © BWF · not affiliated with the Badminton World Federation',
      BR.PAD, h - 14);

    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    if (!blob) throw new Error('canvas export failed');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wc2026-${cat}-predictions-${(made || new Date().toISOString()).slice(0, 10)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) {
    if (btn) { btn.textContent = 'Export failed'; setTimeout(() => { btn.textContent = label; }, 2200); }
    return;
  } finally {
    if (btn) { btn.disabled = false; if (btn.textContent === 'Rendering…') btn.textContent = label; }
  }
}

/* ============================ head-to-head ============================

   /api/h2h/statistics needs BOTH sides — it 500s with only t1p1. Teams here are
   the same {players:[…]} shape used everywhere else, so doubles works by
   passing t1p2 / t2p2.
   ==================================================================== */

/** Strip BWF's <span class="name-1">…</span> markup down to plain text. */
function plainName(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

/** Which discipline a team belongs to, by finding it in a loaded draw. */
function h2hCat(team) {
  const key = entryKey(team);
  if (!key) return null;
  for (const cat of CATS) {
    const draw = state.draws[cat];
    if (draw && draw.entries.has(key)) return cat;
  }
  return null;
}

function h2hParams(teamA, teamB) {
  const pa = (teamA.players || []).map(p => p.id);
  const pb = (teamB.players || []).map(p => p.id);
  const q = { t1p1: pa[0], t2p1: pb[0] };
  if (pa[1]) q.t1p2 = pa[1];
  if (pb[1]) q.t2p2 = pb[1];
  return q;
}

function teamFlag(team) {
  return (team && team.countryFlagUrl)
    || (team && team.players && team.players[0] && team.players[0].countryFlagUrl)
    || '';
}

function h2hSide(team, side) {
  const flag = teamFlag(team);
  const avatar = team.players.length === 1 && team.players[0].avatar
    ? team.players[0].avatar.thumbnailUrl : null;

  // Portrait with the flag as a corner badge; doubles pairs have no single
  // portrait, so the flag stands in for it at full size.
  const art = avatar
    ? `<span class="h2h-av">
         <img class="av" src="${esc(avatar)}" alt="">
         ${flag ? `<img class="fl" src="${esc(flag)}" alt="${esc(team.countryCode || '')}">` : ''}
       </span>`
    : `<span class="h2h-av">${flag
         ? `<img class="av av-flag" src="${esc(flag)}" alt="${esc(team.countryCode || '')}">`
         : '<span class="av"></span>'}</span>`;

  return `<div class="h2h-p ${side}">${art}
    <span class="nm2">${esc(teamName(team))}<small>${esc(team.countryCode || '')}</small></span></div>`;
}

async function openH2H(teamA, teamB) {
  if (!teamA || !teamB || !(teamA.players || []).length || !(teamB.players || []).length) return;

  const box = $('#h2hBody');
  $('#h2hTitle').textContent = `${teamName(teamA)} vs ${teamName(teamB)}`;
  $('#h2h').hidden = false;
  box.innerHTML = `<div class="h2h-head">${h2hSide(teamA, 'left')}
      <div class="h2h-tally"><span class="spinner"></span><small>loading</small></div>
      ${h2hSide(teamB, 'right')}</div>`;

  let data;
  try {
    data = await getJSON('h2h/statistics', h2hParams(teamA, teamB));
  } catch {
    box.innerHTML = `<div class="h2h-head">${h2hSide(teamA, 'left')}
        <div class="h2h-tally">&ndash;<small>unavailable</small></div>
        ${h2hSide(teamB, 'right')}</div>
      <div class="h2h-none">Could not load the head-to-head just now.</div>`;
    return;
  }

  const st = (data && data.stats) || null;
  const winsA = st ? st.team1.totalWins : 0;
  const winsB = st ? st.team2.totalWins : 0;
  const total = st ? st.totalMatches : 0;
  const pctA = total ? (winsA / total) * 100 : 50;

  const rows = (data.matches || []).slice().sort((a, b) => {
    const ta = (a.info && a.info.matchTime) || '', tb = (b.info && b.info.matchTime) || '';
    return ta < tb ? 1 : ta > tb ? -1 : 0;      // newest first
  }).map(m => {
    const info = m.info || {}, res = m.result || {}, prog = m.progress || {};
    const when = (info.matchTime || '').slice(0, 10);
    const games = (prog.games || []).map(g =>
      `<span class="g"><i class="${g.team1 > g.team2 ? 'w' : ''}">${esc(g.team1)}</i>-<i class="${g.team2 > g.team1 ? 'w' : ''}">${esc(g.team2)}</i></span>`
    ).join('');
    const who = res.winner === 1 ? teamName(teamA) : res.winner === 2 ? teamName(teamB) : null;
    const tmt = (m.tournament && m.tournament.name) || info.eventName || '';
    return `<div class="h2h-m">
        <span class="when">${esc(when)}</span>
        <span class="what"><b>${esc(tmt)}</b>
          <small>${esc(info.roundName || '')}${who ? ' &middot; ' + esc(who) + ' won' : ''}</small></span>
        <span class="games">${games}</span>
      </div>`;
  }).join('');

  const rk = (data && data.ranking) || {};
  box.innerHTML = `
    <div class="h2h-head">
      ${h2hSide(teamA, 'left')}
      <div class="h2h-tally">${winsA}&ndash;${winsB}<small>${total} meeting${total === 1 ? '' : 's'}</small></div>
      ${h2hSide(teamB, 'right')}
    </div>
    ${total ? `<div class="h2h-bar"><i class="a" style="width:${pctA}%"></i><i class="b" style="width:${100 - pctA}%"></i></div>` : ''}
    ${rankingRows(rk.team1, rk.team2)}
    <div id="h2hSeasonA"></div>
    <div id="h2hSeasonB"></div>
    ${rows ? `<div class="h2h-list">${rows}</div>` : '<div class="h2h-none">These two have never met on the BWF tour.</div>'}`;

  // Season strips for both sides. Doubles pairs are represented by the first
  // named player, since a season belongs to a person, not a partnership.
  // The pair's own discipline decides which draw column to read.
  const cat = h2hCat(teamA) || h2hCat(teamB) || activeCats()[0];
  const idA = teamA.players[0] && teamA.players[0].id;
  const idB = teamB.players[0] && teamB.players[0].id;
  const token = ++h2hToken;

  for (const [id, slot, team, align] of [
    [idA, '#h2hSeasonA', teamA, 'left'],
    [idB, '#h2hSeasonB', teamB, 'right'],
  ]) {
    if (!id) continue;
    loadSeason(id).then(season => {
      if (token !== h2hToken) return;               // a newer popup opened
      const node = $(slot);
      if (node) {
        node.innerHTML = seasonStrip(season, cat,
          `${teamName(team)} — season ${SEASON_YEAR}`,
          { align, flag: teamFlag(team) });
      }
    }).catch(() => {});
  }
}

let h2hToken = 0;

/** Both sides' current rankings — useful precisely when they have never met. */
function rankingRows(a, b) {
  const byName = list => {
    const out = {};
    for (const r of list || []) if (r && r.rankingName) out[r.rankingName] = r.currentRank;
    return out;
  };
  const A = byName(a), B = byName(b);
  const names = Array.from(new Set([...Object.keys(A), ...Object.keys(B)]));
  if (!names.length) return '';

  const shorten = n => n.replace(/\s*Rankings?$/i, '').replace(/^HSBC\s+/i, '');
  const cell = v => (v == null ? '&ndash;' : '#' + esc(v));
  return `<div class="h2h-ranks">${names.map(n =>
    `<div class="h2h-rank"><span class="ra">${cell(A[n])}</span>
       <span class="rl">${esc(shorten(n))}</span>
       <span class="rb">${cell(B[n])}</span></div>`).join('')}</div>`;
}

function closeH2H() { $('#h2h').hidden = true; }

/* ============================ saved selections ============================

   A selection is just a named list of player ids kept in localStorage. The
   live follow list is always the working set; saving snapshots it, loading
   replaces it. The discipline is stored too, so loading an all-WD selection
   lands you on WD rather than whatever you happened to be looking at.
   ======================================================================== */

function loadPresets() {
  const list = store.read('presets', []);
  return Array.isArray(list) ? list : [];
}

function writePresets(list) {
  state.presets = list;
  store.write('presets', list);
}

function presetId() {
  // Date.now() is fine here; ids only need to be unique within one browser.
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
}

function saveCurrentSelection(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || !state.selected.size) return false;

  const list = loadPresets();
  const players = Array.from(state.selected);
  const existing = list.find(p => p.name.toLowerCase() === clean.toLowerCase());

  if (existing) {
    existing.players = players;
    existing.cats = activeCats();
  } else {
    list.push({ id: presetId(), name: clean, players, cats: activeCats() });
  }
  writePresets(list);
  state.activePreset = (existing && existing.id) || list[list.length - 1].id;
  return true;
}

function applyPreset(id) {
  const p = loadPresets().find(x => x.id === id);
  if (!p) return;
  state.selected = new Set(p.players);
  state.active = null;
  state.activePreset = p.id;

  // Restore the discipline filter it was saved with. `cat` is the older
  // single-discipline field, kept readable so existing saves still load.
  const cats = Array.isArray(p.cats) ? p.cats.filter(c => CATS.includes(c))
    : (p.cat && CATS.includes(p.cat) ? [p.cat] : []);
  if (cats.length) {
    state.cats = new Set(cats);
    store.write('cats', activeCats());
    paintCatChips();
  }

  persistSelection();
  renderAll();
  renderPresetPanel();
  ensureCats();
}

function deletePreset(id) {
  writePresets(loadPresets().filter(p => p.id !== id));
  if (state.activePreset === id) state.activePreset = null;
  renderPresetPanel();
}

function presetCatLabel(p) {
  const cats = Array.isArray(p.cats) ? p.cats : (p.cat ? [p.cat] : []);
  if (!cats.length || cats.length === CATS.length) return 'All disciplines';
  return cats.map(c => c.toUpperCase()).join(' ');
}

function renderPresetPanel() {
  const list = loadPresets();
  const box = $('#selList');
  box.innerHTML = '';

  if (!list.length) {
    box.innerHTML = '<div class="sel-empty">Nothing saved yet. Pick some players, then name and save them here.</div>';
  }

  for (const p of list) {
    const row = el('div', 'sel-row' + (p.id === state.activePreset ? ' is-active' : ''));
    row.innerHTML = `
      <button class="sel-load" type="button">
        <span class="sel-nm">${esc(p.name)}</span>
        <span class="sel-meta">${p.players.length} player${p.players.length === 1 ? '' : 's'}
          &middot; ${esc(presetCatLabel(p))}</span>
      </button>
      <button class="sel-x" type="button" title="Delete ${esc(p.name)}" aria-label="Delete ${esc(p.name)}">&times;</button>`;
    row.querySelector('.sel-load').onclick = () => { applyPreset(p.id); closeSelPanel(); };
    row.querySelector('.sel-x').onclick = e => { e.stopPropagation(); deletePreset(p.id); };
    box.appendChild(row);
  }

  // Label the button with whatever is currently loaded.
  const current = list.find(p => p.id === state.activePreset);
  const n = state.selected.size;
  $('#selCurrent').textContent = current
    ? current.name
    : (n ? `${n} player${n === 1 ? '' : 's'}` : 'Selections');

  const save = $('#selSave');
  save.disabled = !state.selected.size;
  save.title = state.selected.size ? '' : 'Select some players first';
}

function openSelPanel() {
  renderPresetPanel();
  $('#selPanel').hidden = false;
  $('#selToggle').setAttribute('aria-expanded', 'true');
  const cur = loadPresets().find(p => p.id === state.activePreset);
  $('#selName').value = cur ? cur.name : '';
}

function closeSelPanel() {
  $('#selPanel').hidden = true;
  $('#selToggle').setAttribute('aria-expanded', 'false');
}

/* ============================ picker ============================ */

/** All entries across the switched-on disciplines, each tagged with its draw. */
function pickerEntries() {
  const out = [];
  for (const cat of activeCats()) {
    const draw = state.draws[cat];
    if (!draw) continue;
    for (const entry of draw.entries.values()) out.push(entry);
  }
  return out;
}

/**
 * Countries across the switched-on disciplines, with the player ids that make
 * them up. With every discipline on, one click on THA follows every Thai
 * player in the tournament.
 */
function countriesInScope() {
  const map = new Map();
  for (const entry of pickerEntries()) {
    const code = entry.countryCode || '—';
    if (!map.has(code)) map.set(code, { code, flag: entry.flag, players: new Set(), entries: 0 });
    const c = map.get(code);
    c.entries++;
    for (const p of entry.players) c.players.add(String(p.id));
  }
  return Array.from(map.values()).sort((a, b) =>
    b.entries - a.entries || a.code.localeCompare(b.code));
}

function renderCountryChips() {
  const bar = $('#countryChips');
  bar.innerHTML = '';

  for (const c of countriesInScope()) {
    const ids = Array.from(c.players);
    const on = ids.length && ids.every(id => state.selected.has(id));
    const chip = el('button', 'cchip' + (on ? ' is-on' : ''));
    chip.type = 'button';
    chip.title = on ? `Remove all ${c.code}` : `Follow all ${c.code} (${c.entries})`;
    chip.innerHTML = `${c.flag ? `<img src="${esc(c.flag)}" alt="">` : ''}
      <span>${esc(c.code)}</span><i>${c.entries}</i>`;
    chip.onclick = () => {
      // Toggle the whole country: add every player unless they're all already
      // followed, in which case clear them.
      for (const id of ids) {
        if (on) state.selected.delete(id);
        else state.selected.add(id);
      }
      state.activePreset = null;      // the working set no longer matches a saved one
      persistSelection();
      renderPicker();
    };
    bar.appendChild(chip);
  }
}

function openPicker() {
  $('#pickerCat').textContent = allCatsOn()
    ? 'all disciplines'
    : activeCats().map(c => c.toUpperCase()).join(', ');
  $('#picker').hidden = false;
  $('#pickerSearch').value = '';
  renderPicker();
  $('#pickerSearch').focus();
}

function closePicker() {
  $('#picker').hidden = true;
  persistSelection();
  renderAll();
}

function renderPicker() {
  const list = $('#pickerList');
  const q = $('#pickerSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  renderCountryChips();

  const all = pickerEntries();
  if (!all.length) {
    list.appendChild(el('div', 'status', '<span class="spinner"></span>Loading the draws&hellip;'));
    return;
  }

  const entries = all
    .filter(e => !q || e.name.toLowerCase().includes(q)
      || (e.countryCode || '').toLowerCase().includes(q)
      || e.cat === q)
    .sort((a, b) => {
      // Seeds first within a discipline, then disciplines in canonical order.
      const sa = a.seed ? Number(a.seed) : 999, sb = b.seed ? Number(b.seed) : 999;
      if (sa !== sb) return sa - sb;
      const ca = CATS.indexOf(a.cat), cb = CATS.indexOf(b.cat);
      if (ca !== cb) return ca - cb;
      return a.name.localeCompare(b.name);
    });

  for (const e of entries) {
    const on = e.players.some(p => state.selected.has(String(p.id)));
    const row = el('div', 'pk' + (on ? ' is-on' : ''));
    row.innerHTML = `
      ${flagImg(e.flag, e.countryCode)}
      <span class="pk-nm">${esc(e.name)}<small><b class="pk-cat">${esc(e.cat.toUpperCase())}</b>
        ${esc(e.countryCode || '')}${
        e.seed ? ' &middot; seed ' + esc(seedText(e.seed)) : ''}</small></span>
      <span class="pk-add">${on ? 'Following' : 'Follow'}</span>`;
    row.onclick = () => {
      const nowOn = e.players.some(p => state.selected.has(String(p.id)));
      for (const p of e.players) {
        if (nowOn) state.selected.delete(String(p.id));
        else state.selected.add(String(p.id));
      }
      state.activePreset = null;      // hand-edited, no longer a saved selection
      persistSelection();
      renderPicker();
      updatePickerCount();
    };
    list.appendChild(row);
  }

  updatePickerCount();
}

function updatePickerCount() {
  const n = state.selected.size;
  $('#pickerCount').textContent = n === 0 ? 'No players selected' : `${n} player${n === 1 ? '' : 's'} selected`;
}

/* ============================ wiring ============================ */

function renderAll() {
  if (state.view === 'matches') {
    renderDaybar('#mDaybar', state.matchDay, pickMatchDay);
    renderMatches();
  } else if (state.view === 'players') {
    if (state.playerTab === 'schedule') {
      renderDaybar('#daybar', state.day, pickScheduleDay);
      renderSchedule();
    } else {
      renderMyPlayers();
      renderPlayerDetail();
    }
  } else {
    renderDraw();
  }
}

function pickScheduleDay(d) {
  state.day = d;
  renderDaybar('#daybar', state.day, pickScheduleDay);
  renderSchedule();
}

function pickMatchDay(d) {
  state.matchDay = d;
  renderDaybar('#mDaybar', state.matchDay, pickMatchDay);
  renderMatches();
}

function setView(v) {
  const first = state.view !== v;
  state.view = v;
  $$('.tab').forEach(t => {
    const on = t.dataset.view === v;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  for (const name of VIEWS) {
    $('#view-' + name).classList.toggle('is-active', name === v);
  }
  syncHash();
  renderAll();

  // The viewport has no size until the section is visible, so fit afterwards.
  if (v === 'draw') {
    if (first) frameMap();
    ensurePredictRanks();
  }
}

/** Follow Players holds two ways of looking at the same follow list. */
function setPlayerTab(t) {
  state.playerTab = PLAYER_TABS.includes(t) ? t : 'list';
  $$('.subtab').forEach(b => {
    const on = b.dataset.ptab === state.playerTab;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  for (const name of PLAYER_TABS) {
    $('#ptab-' + name).classList.toggle('is-active', name === state.playerTab);
  }
  store.write('playerTab', state.playerTab);
  if (state.view === 'players') renderAll();
}

function paintCatChips() {
  $$('.cat').forEach(b => {
    const c = b.dataset.cat;
    if (c === 'all') {
      b.classList.toggle('is-active', allCatsOn());
      return;
    }
    const on = state.cats.has(c);
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  $$('.dcat').forEach(b => b.classList.toggle('is-active', b.dataset.dcat === state.drawCat));
}

/** Toggle one discipline on or off. Turning the last one off is a no-op. */
function toggleCat(c) {
  if (c === 'all') {
    state.cats = new Set(CATS);
  } else if (state.cats.has(c)) {
    if (state.cats.size === 1) return;          // never leave nothing showing
    state.cats.delete(c);
  } else {
    state.cats.add(c);
  }
  store.write('cats', activeCats());
  paintCatChips();
  syncHash();
  renderAll();
  if (!$('#picker').hidden) renderPicker();
  ensureCats();
}

/** Show only this discipline (used by the Shift hotkey). */
function soloCat(c) {
  state.cats = new Set([c]);
  store.write('cats', activeCats());
  paintCatChips();
  syncHash();
  renderAll();
  if (!$('#picker').hidden) renderPicker();
  ensureCats();
}

/** Make sure every switched-on discipline (and the Draw view's) is loaded. */
async function ensureCats() {
  const want = Array.from(new Set([...activeCats(), state.drawCat]));
  for (const c of want) {
    if (state.draws[c]) continue;
    try {
      await loadDraw(c);
      renderAll();
      if (!$('#picker').hidden) renderPicker();
    } catch (e) {
      showError(e);
      return;
    }
  }
  // Ranking indexes are deliberately NOT loaded here. They only order the
  // opponent chips, cost dozens of paginated calls per discipline, and are
  // fetched on demand for whichever player is actually on screen.
}

/** Cycle views / disciplines / highlighted player from the keyboard. */
function stepView(delta) {
  const i = VIEWS.indexOf(state.view);
  setView(VIEWS[(i + delta + VIEWS.length) % VIEWS.length]);
}

/**
 * Shift cycles disciplines. In the Draw view that means the tree on screen;
 * elsewhere it solos each discipline in turn and then returns to showing all,
 * which keeps the "move the category to the right" feel now that the chips are
 * independent toggles.
 */
function stepCat(delta) {
  if (state.view === 'draw') {
    const i = CATS.indexOf(state.drawCat);
    setDrawCat(CATS[(i + delta + CATS.length) % CATS.length]);
    return;
  }
  const ring = [...CATS, 'all'];
  const cur = allCatsOn() ? 'all' : (state.cats.size === 1 ? activeCats()[0] : null);
  const i = cur === null ? -1 : ring.indexOf(cur);
  const next = ring[(i + delta + ring.length) % ring.length];
  if (next === 'all') toggleCat('all'); else soloCat(next);
}

function stepPlayer(delta) {
  const players = selectedPlayers();
  if (players.length < 2) return;
  const i = Math.max(0, players.findIndex(p => p.id === state.active));
  state.active = players[(i + delta + players.length) % players.length].id;
  renderMyPlayers();
  renderPlayerDetail();
  const row = $('#myPlayers .mp.is-active');
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function initHotkeys() {
  document.addEventListener('keydown', e => {
    // Escape always closes whatever is open.
    if (e.key === 'Escape') {
      if (!$('#h2h').hidden) { closeH2H(); return; }
      if (!$('#picker').hidden) { closePicker(); return; }
      if (!$('#selPanel').hidden) { closeSelPanel(); return; }
      return;
    }

    // Don't hijack typing, modifier combos, or keys while a dialog is up.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!$('#picker').hidden || !$('#h2h').hidden || !$('#selPanel').hidden) return;

    // Zoom the bracket. Covers the main row (+ needs Shift on most layouts, so
    // '=' counts too) and the numpad, via e.code so layout doesn't matter.
    if (state.view === 'draw') {
      const cam = CAM;
      const zoomIn  = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' || e.code === 'Equal';
      const zoomOut = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.code === 'Minus';
      if (zoomIn)  { e.preventDefault(); setZoom(cam, cam.zoom * 1.2); return; }
      if (zoomOut) { e.preventDefault(); setZoom(cam, cam.zoom / 1.2); return; }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitBracket(cam); return; }
      // 0 resets to 100%, the same convention browsers use for ctrl+0.
      if (e.key === '0' || e.code === 'Numpad0' || e.code === 'Digit0') {
        e.preventDefault(); setZoom(cam, 1); return;
      }
    }

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); stepView(-1); break;
      case 'ArrowRight': e.preventDefault(); stepView(1); break;
      case 'Shift':      if (!e.repeat) { e.preventDefault(); stepCat(1); } break;
      // Stepping the highlighted player only means anything on its own sub-tab.
      case 'ArrowUp':
        if (state.view === 'players' && state.playerTab === 'list') { e.preventDefault(); stepPlayer(-1); }
        break;
      case 'ArrowDown':
        if (state.view === 'players' && state.playerTab === 'list') { e.preventDefault(); stepPlayer(1); }
        break;
    }
  });
}

function showError(e) {
  const box = $(state.view === 'matches' ? '#matchesStatus' : '#scheduleStatus');
  if (!box) return;
  box.hidden = false;
  box.className = 'status is-error';
  box.textContent = 'Could not reach the BWF data service. ' +
    'It rate-limits bursts of requests — wait a moment and reload. (' + (e && e.message ? e.message : 'unknown error') + ')';
}

/**
 * BWF red on dark is the default look, regardless of the system setting — the
 * tool is meant to feel like a scoreboard. Both toggles still stick once used.
 */
function applyTheme() {
  const skin = store.read('skin', 'bwf');
  const mode = store.read('mode', 'dark');
  document.documentElement.dataset.skin = skin;
  document.documentElement.dataset.mode = mode;
}

function initTheme() {
  applyTheme();

  $('#skinToggle').onclick = () => {
    store.write('skin', store.read('skin', 'bwf') === 'bwf' ? 'sport' : 'bwf');
    applyTheme();
  };

  $('#modeToggle').onclick = () => {
    store.write('mode', store.read('mode', 'dark') === 'dark' ? 'light' : 'dark');
    applyTheme();
  };
}

async function init() {
  readHash();
  initTheme();

  $$('.tab').forEach(t => t.onclick = () => setView(t.dataset.view));
  $$('.subtab').forEach(b => b.onclick = () => setPlayerTab(b.dataset.ptab));
  $$('.cat').forEach(b => b.onclick = () => toggleCat(b.dataset.cat));
  $$('.dcat').forEach(b => b.onclick = () => setDrawCat(b.dataset.dcat));
  $$('.pmode').forEach(b => b.onclick = () => setDrawMode(b.dataset.pmode));

  // --- predictions ---
  state.predict = store.read('predict', {}) || {};
  state.predictAt = store.read('predictAt', {}) || {};
  const fromLink = new Set(state.subFromLink || []);
  const savedMode = store.read('drawMode', 'results');
  if (!fromLink.has('drawMode') && DRAW_MODES.includes(savedMode)) state.drawMode = savedMode;
  $('#predictClear').onclick = clearPicks;
  $('#predictCopy').onclick = copyAutoToPicks;
  $('#predictPng').onclick = e => exportPredictionsPng(e.currentTarget);

  // --- starred matches ---
  state.starred = new Set((store.read('starred', []) || []).map(String));
  // Land on today during the tournament, on day one before it starts. Reading
  // a whole week of fixtures at once is not what this view is for.
  const today = new Date().toISOString().slice(0, 10);
  state.matchDay = TMT.dates.includes(today) ? today : TMT.dates[0];
  $('#starredOnly').checked = state.starredOnly;
  $('#starredOnly').onchange = e => { state.starredOnly = e.target.checked; renderMatches(); };
  $('#clearStars').onclick = clearStars;
  $('#addToStars').onclick = addScheduleToStars;

  // Restore the discipline filter unless the URL already specified one.
  if (!/[?&#]c=/.test(location.hash)) {
    const saved = store.read('cats', null);
    if (Array.isArray(saved) && saved.length) {
      const valid = saved.filter(c => CATS.includes(c));
      if (valid.length) { state.cats = new Set(valid); state.drawCat = valid[0]; }
    }
  }

  // The Draw view shows one discipline at a time and remembers which — your
  // half-filled prediction sheet should still be there tomorrow. A link that
  // names disciplines wins, since that is what the sender meant to show.
  if (!state.catsFromLink) {
    const dc = store.read('drawCat', null);
    if (CATS.includes(dc)) state.drawCat = dc;
  }
  const savedTab = store.read('playerTab', null);
  if (!fromLink.has('playerTab') && PLAYER_TABS.includes(savedTab)) state.playerTab = savedTab;
  setPlayerTab(state.playerTab);

  $('#openPickerBtn').onclick = openPicker;
  $('#openPickerBtn2').onclick = openPicker;
  $('#closePicker').onclick = closePicker;
  $('#donePicker').onclick = closePicker;
  $('#pickerSearch').oninput = renderPicker;
  $('#picker').onclick = e => { if (e.target.id === 'picker') closePicker(); };
  $('#closeH2h').onclick = closeH2H;
  $('#h2h').onclick = e => { if (e.target.id === 'h2h') closeH2H(); };

  // --- saved selections ---
  state.presets = loadPresets();
  $('#selToggle').onclick = e => {
    e.stopPropagation();
    if ($('#selPanel').hidden) openSelPanel(); else closeSelPanel();
  };
  $('#selPanel').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => { if (!$('#selPanel').hidden) closeSelPanel(); });

  const doSave = () => {
    if (saveCurrentSelection($('#selName').value)) {
      renderPresetPanel();
      $('#selName').blur();
    }
  };
  $('#selSave').onclick = doSave;
  $('#selName').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSelPanel(); }
  };
  renderPresetPanel();

  initBracketInteraction(CAM);
  initZoomBar(CAM, { in: '#zoomIn', out: '#zoomOut', fit: '#zoomFit', mine: '#zoomMine' });
  initHotkeys();

  // Selections are shareable URLs, so honour back/forward and pasted links
  // arriving at an already-open page. syncHash() writes the same string we'd
  // read back, so compare first to avoid reacting to our own updates.
  window.addEventListener('hashchange', () => {
    // The sub-selections are part of the snapshot: a pre-restructure link like
    // v=predict resolves to the same top-level view as v=bracket, and differs
    // only in the mode it asks for. Watching the view alone would read the new
    // hash into state and then never repaint it.
    const snap = () => JSON.stringify([Array.from(state.selected).sort(), activeCats(),
                                       state.view, state.playerTab, state.drawMode]);
    const before = snap();
    readHash();
    if (before === snap()) return;
    store.write('players', Array.from(state.selected));
    store.write('cats', activeCats());
    paintCatChips();
    setPlayerTab(state.playerTab);
    setView(state.view);
    ensureCats();
  });

  paintCatChips();
  setView(state.view);

  // Everything below is progressive: the page is already usable. The shared
  // request queue serialises these, so they never burst the API.
  (async () => {
    await ensureCats();
    // Any discipline not switched on is still worth having: it lets followed
    // players resolve everywhere and makes toggling one back on instant.
    for (const c of CATS) {
      if (state.draws[c]) continue;
      try { await loadDraw(c, 'low'); renderAll(); } catch { /* keep going */ }
    }
    // Then scheduling data: times, courts and scores, once BWF publishes them.
    // Both schedules gain times, courts and the court grid as each day lands.
    await loadAllDays(() => {
      if (state.view === 'matches' || (state.view === 'players' && state.playerTab === 'schedule')) {
        renderAll();
      }
    })
      .catch(() => { /* schedule stays "time to be confirmed" */ });
  })();
}

document.addEventListener('DOMContentLoaded', init);
