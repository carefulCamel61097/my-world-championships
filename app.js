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
const IS_DOUBLES = { ms: false, ws: false, md: true, wd: true, xd: true };
const CATS = ['ms','ws','md','wd','xd'];
const VIEWS = ['schedule','players','bracket'];
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

let queueTail = Promise.resolve();

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
function getJSON(path, params) {
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

  const job = queueTail.then(run, run);
  queueTail = job.then(() => sleep(REQ_GAP_MS), () => sleep(REQ_GAP_MS));
  return job;
}

/* ============================ state ============================ */

const store = {
  read(k, fb) { try { return JSON.parse(localStorage.getItem('wc26.' + k)) ?? fb; } catch { return fb; } },
  write(k, v) { try { localStorage.setItem('wc26.' + k, JSON.stringify(v)); } catch {} },
};

const state = {
  view: 'schedule',
  cat: 'ms',
  day: 'all',
  onlyMine: true,
  selected: new Set(store.read('players', [])),
  active: null,          // highlighted player id in the Players view
  draws: {},             // cat -> { entries, cells, matches, maxCol }
  dayIndex: {},          // match id -> enriched match from day-matches
  daysLoaded: new Set(),
  playerCache: {},       // playerId:cat -> detail bundle promise
  ranks: {},             // cat -> { entryKey: bwfRank }
  zoom: 1,
  pan: { x: 0, y: 0 },
};

function persistSelection() {
  store.write('players', Array.from(state.selected));
  syncHash();
}

function syncHash() {
  const p = Array.from(state.selected).join(',');
  const h = new URLSearchParams();
  if (p) h.set('p', p);
  h.set('c', state.cat);
  h.set('v', state.view);
  history.replaceState(null, '', '#' + h.toString());
}

function readHash() {
  if (!location.hash || location.hash.length < 2) return;
  const h = new URLSearchParams(location.hash.slice(1));
  const p = h.get('p');
  if (p) state.selected = new Set(p.split(',').filter(Boolean));
  const c = h.get('c');
  if (c && CATS.includes(c)) state.cat = c;
  const v = h.get('v');
  if (VIEWS.includes(v)) state.view = v;
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

function localTime(m) {
  const d = utcDate(m);
  if (!d) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

async function loadDraw(cat) {
  if (state.draws[cat]) return state.draws[cat];

  const data = await getJSON('vue-tournament-draw-data', {
    tmtId: TMT.id, tmtType: 1, drawId: DRAW_ID[cat], isPara: 0,
  });

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
    });
    if (Array.isArray(list)) {
      for (const m of list) state.dayIndex[m.id] = m;
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

function rankCacheGet(cat) {
  try {
    const raw = localStorage.getItem('wc26.ranks.' + cat);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    return Date.now() - t > RANK_TTL_MS ? null : v;
  } catch { return null; }
}

function rankCacheSet(cat, v) {
  try { localStorage.setItem('wc26.ranks.' + cat, JSON.stringify({ t: Date.now(), v })); } catch {}
}

/** Ranking-table row → the same key shape as entryKey(). */
function rowKey(r) {
  const ids = [r.player1_id, r.player2_id].filter(x => x != null).map(String);
  return ids.sort().join('_');
}

async function loadRankIndex(cat) {
  if (state.ranks[cat]) return state.ranks[cat];

  const cached = rankCacheGet(cat);
  if (cached) { state.ranks[cat] = cached; return cached; }

  const draw = state.draws[cat];
  const need = new Set(draw ? Array.from(draw.entries.keys()) : []);
  const idx = {};
  state.ranks[cat] = idx;                 // publish early; fills in progressively

  for (let page = 1; page <= RANK_MAX_PAGES && need.size; page++) {
    let d;
    try {
      d = await getJSON('vue-rankingtable', {
        rankId: 2, catId: RANK_CAT[cat], page, doubles: IS_DOUBLES[cat],
      });
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
    if (state.view === 'players' || state.view === 'bracket') renderAll();
  }

  rankCacheSet(cat, idx);
  return idx;
}

function rankOf(cat, key) {
  const idx = state.ranks[cat];
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

function sideRow(m, which) {
  const team = m['team' + which];
  const seed = m['team' + which + 'seed'];
  const isWin = m.winner === which;
  const isLose = (m.winner === 1 || m.winner === 2) && !isWin;
  const mine = teamIsMine(team);

  const scores = (m.score || []).map(g => {
    const own = which === 1 ? g.home : g.away;
    const opp = which === 1 ? g.away : g.home;
    if (own == null) return '';
    return `<b class="${own > opp ? 'won' : ''}">${esc(own)}</b>`;
  }).join('');

  const names = team && team.players && team.players.length
    ? team.players.map(p => `<span class="${state.selected.has(String(p.id)) ? 'mine' : ''}">${esc(p.nameDisplay)}</span>`).join(' / ')
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
    m.courtName ? `<span class="sep">&middot;</span><span>${esc(m.courtName)}</span>` : '',
    `<span class="stat ${st.cls}">${st.text}</span>`,
  ].join('');

  const foot = [
    vt ? `<span>Venue ${esc(vt)}</span>` : '<span>Time to be confirmed</span>',
    showLocal ? `<span class="local">Your time ${esc(lt)}</span>` : '',
    m.duration ? `<span>${esc(m.duration)} min</span>` : '',
    m.oopText ? `<span>${esc(m.oopText)}</span>` : '',
  ].filter(Boolean).join('');

  const card = el('div', 'match' + (st.cls === 'live' ? ' is-live' : ''));
  card.innerHTML = `
    <div class="match-head">${head}</div>
    <div class="match-body">${sideRow(m, 1)}${sideRow(m, 2)}</div>
    <div class="match-foot">${foot}</div>`;

  // Any match with two known sides can open its head-to-head.
  const k1 = entryKey(m.team1), k2 = entryKey(m.team2);
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

/* ============================ view: schedule ============================ */

function renderDaybar() {
  const bar = $('#daybar');
  bar.innerHTML = '';

  const all = el('button', 'day' + (state.day === 'all' ? ' is-active' : ''), '<b>All</b>days');
  all.onclick = () => { state.day = 'all'; renderDaybar(); renderSchedule(); };
  bar.appendChild(all);

  for (const d of TMT.dates) {
    const s = shortDay(d);
    const b = el('button', 'day' + (state.day === d ? ' is-active' : ''), `<b>${esc(s.dom)}</b>${esc(s.dow)}`);
    b.onclick = () => { state.day = d; renderDaybar(); renderSchedule(); };
    bar.appendChild(b);
  }
}

function renderSchedule() {
  const wrap = $('#scheduleList');
  const draw = state.draws[state.cat];
  wrap.innerHTML = '';

  if (!draw) {
    wrap.appendChild(el('div', 'status', '<span class="spinner"></span>Loading the draw&hellip;'));
    return;
  }

  if (state.onlyMine && state.selected.size === 0) {
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

  // Byes are bracket bookkeeping, not fixtures — never list them.
  let matches = draw.matches.filter(m => !draw.byeCodes.has(String(m.code))).map(enrich);
  if (state.onlyMine) matches = matches.filter(matchIsMine);
  if (state.day !== 'all') matches = matches.filter(m => dayKeyOf(m) === state.day);

  if (!matches.length) {
    const e = el('div', 'empty');
    e.innerHTML = `<h3>Nothing here</h3><p>No ${esc(CAT_LABEL[state.cat])} matches${
      state.day === 'all' ? '' : ' on this day'} for your selection yet.</p>`;
    wrap.appendChild(e);
    return;
  }

  // Group: scheduled days first (chronological), then unscheduled by round.
  const groups = new Map();
  for (const m of matches) {
    const k = dayKeyOf(m) || 'tbc';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }

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
      return ROUND_ORDER.indexOf(a.roundName) - ROUND_ORDER.indexOf(b.roundName);
    });

    const g = el('div', 'daygroup');
    const head = el('div', 'daygroup-head');
    head.innerHTML = k === 'tbc'
      ? `<h3>Not yet scheduled</h3><span>${list.length} match${list.length === 1 ? '' : 'es'} &middot; times published nearer the day</span>`
      : `<h3>${esc(prettyDay(k))}</h3><span>${list.length} match${list.length === 1 ? '' : 'es'}</span>`;
    g.appendChild(head);
    for (const m of list) g.appendChild(matchCard(m));
    wrap.appendChild(g);
  }
}

/* ============================ view: players ============================ */

/** Every selected player we can describe, across the draws loaded so far. */
function selectedPlayers() {
  const out = new Map();
  for (const cat of CATS) {
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
  // Selected players whose draw isn't loaded yet still deserve a row.
  for (const id of state.selected) {
    if (!out.has(id)) out.set(id, { id, player: null, cats: [], entries: [] });
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
    const row = el('div', 'mp' + (rec.id === state.active ? ' is-active' : ''));
    row.innerHTML = `
      ${flagImg(p && p.countryFlagUrl, p && p.countryCode)}
      <span class="mp-nm">${esc(p ? p.nameDisplay : 'Player ' + rec.id)}
        <small>${esc(p ? (p.countryName || p.countryCode || '') : 'loading…')}</small></span>
      <span class="mp-cat">${rec.cats.map(c => c.toUpperCase()).join(' ')}</span>`;
    row.onclick = () => { state.active = rec.id; renderMyPlayers(); renderPlayerDetail(); };
    list.appendChild(row);
  }
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
  } else {
    $('#pathPanel').querySelector('.panel-body').textContent =
      'Draw not loaded for this discipline yet.';
  }

  // --- profile numbers (network, best-effort) ---
  const want = rec.id;
  try {
    const bundle = await playerBundle(rec.id, cat);
    if (state.active !== want) return;              // user moved on while loading
    renderStatCells(bundle, entry);
    const box = $('#seasonBox');
    if (box) box.innerHTML = seasonStrip(bundle.season, cat, `Season ${SEASON_YEAR}`);
  } catch {
    const cells = $('#statCells');
    if (cells) cells.innerHTML = '<div class="stat-cell"><div class="k">Profile</div><div class="v"><small>Unavailable</small></div></div>';
  }
}

function playerBundle(id, cat) {
  // Key by discipline as well as player: rankings are per-event, and the first
  // render can happen before the draw has loaded (discipline still unknown).
  // Keying on id alone would cache that early wrong-event answer for good.
  const key = id + ':' + (cat || '?');
  // Cache the *promise*, not the result: re-renders fire while the first
  // request is still in flight, and we must not queue it twice.
  if (!state.playerCache[key]) {
    state.playerCache[key] = fetchPlayerBundle(id, cat).catch(e => {
      delete state.playerCache[key];   // let a later render retry
      throw e;
    });
  }
  return state.playerCache[key];
}

async function fetchPlayerBundle(id, cat) {
  // Rankings are per discipline. Until the draw tells us which one this player
  // is in, ask only for the discipline-independent data.
  const rankEvent = RANK_CAT[cat];
  const [summary, current, highest, previous, season] = await Promise.all([
    getJSON('vue-player-summary', { playerId: id, isPara: 0, drawCount: 5 }).catch(() => null),
    rankEvent ? getJSON('vue-player-ranking-current', { playerId: id, isPara: 0, rankingEvent: rankEvent }).catch(() => null) : null,
    rankEvent ? getJSON('vue-player-ranking-highest', { playerId: id, isPara: 0, rankingEvent: rankEvent }).catch(() => null) : null,
    getJSON('vue-player-match-previous', { playerId: id, isPara: 0, drawCount: 5, activeTab: 0 }).catch(() => null),
    loadSeason(id).catch(() => []),
  ]);

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
  const rank = (b.rank && b.rank !== '-') ? b.rank : null;
  cells.push(`<div class="stat-cell"><div class="k">BWF World Ranking</div>
    <div class="v">${rank ? '#' + esc(rank) : '<small>&mdash;</small>'}</div></div>`);

  if (b.highest && b.highest.rank && b.highest.rank !== '-') {
    cells.push(`<div class="stat-cell"><div class="k">Career high</div>
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

  for (const r of rounds) {
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

function bracketSide(m, which, mine) {
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
    <span class="bn">${named ? esc(teamName(team)) : '<span class="muted">—</span>'}</span>
    <span class="bsc">${esc(pts)}</span>
  </div>`;
}

function renderBracket() {
  const canvas = $('#bracketCanvas');
  const draw = state.draws[state.cat];
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
    node.innerHTML = bracketSide(m, 1, mine1) + bracketSide(m, 2, mine2);

    if (entryKey(m.team1) && entryKey(m.team2)) {
      node.title = 'Head-to-head';
      // A click that ended a pan is swallowed by the capture-phase guard on the
      // viewport, so this only ever runs for a genuine click.
      node.addEventListener('click', () => openH2H(m.team1, m.team2));
    } else {
      node.style.cursor = 'default';
    }
    frag.appendChild(node);
  }

  canvas.appendChild(frag);
  applyTransform();
}

/**
 * Keep the bracket inside the viewport: centre it on whichever axis it is
 * smaller than the viewport, and otherwise stop it being dragged (or jumped)
 * off into empty space.
 */
function clampPan() {
  const vp = $('#bracketViewport').getBoundingClientRect();
  if (!vp.width || !vp.height) return;             // section still hidden
  const canvas = $('#bracketCanvas');
  const w = (parseFloat(canvas.style.width) || 0) * state.zoom;
  const h = (parseFloat(canvas.style.height) || 0) * state.zoom;
  const m = 24;                                     // breathing room at the edges

  state.pan.x = w <= vp.width
    ? (vp.width - w) / 2
    : Math.min(m, Math.max(vp.width - w - m, state.pan.x));
  state.pan.y = h <= vp.height
    ? (vp.height - h) / 2
    : Math.min(m, Math.max(vp.height - h - m, state.pan.y));
}

function applyTransform() {
  clampPan();
  const c = $('#bracketCanvas');
  c.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  $('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

function setZoom(z, originX, originY) {
  const next = Math.min(2, Math.max(0.12, z));
  const vp = $('#bracketViewport').getBoundingClientRect();
  // keep the point under the cursor (or the viewport centre) fixed
  const px = originX == null ? vp.width / 2 : originX - vp.left;
  const py = originY == null ? vp.height / 2 : originY - vp.top;
  const k = next / state.zoom;
  state.pan.x = px - (px - state.pan.x) * k;
  state.pan.y = py - (py - state.pan.y) * k;
  state.zoom = next;
  applyTransform();
}

function fitBracket() {
  const canvas = $('#bracketCanvas');
  const vp = $('#bracketViewport').getBoundingClientRect();
  const w = parseFloat(canvas.style.width) || 1;
  const h = parseFloat(canvas.style.height) || 1;
  if (!vp.width || !vp.height) return;
  state.zoom = Math.min(2, Math.max(0.12, Math.min(vp.width / w, vp.height / h)));
  state.pan.x = (vp.width - w * state.zoom) / 2;
  state.pan.y = (vp.height - h * state.zoom) / 2;
  applyTransform();
}

/** Centre the view on the first followed player in this draw. */
function jumpToMine() {
  const draw = state.draws[state.cat];
  if (!draw) return;
  const node = $('#bracketCanvas .bnode.is-mine');
  if (!node) { fitBracket(); return; }
  const vp = $('#bracketViewport').getBoundingClientRect();
  state.zoom = Math.min(1.1, Math.max(state.zoom, 0.75));
  const nx = parseFloat(node.style.left) + BR.CARD_W / 2;
  const ny = parseFloat(node.style.top) + BR.CARD_H / 2;
  state.pan.x = vp.width / 2 - nx * state.zoom;
  state.pan.y = vp.height / 2 - ny * state.zoom;
  applyTransform();
}

let canvasDidPan = false;

function initBracketInteraction() {
  const vp = $('#bracketViewport');
  let dragging = false, sx = 0, sy = 0, px = 0, py = 0;

  const onMove = e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) canvasDidPan = true;
    state.pan.x = px + dx; state.pan.y = py + dy;
    applyTransform();
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
    sx = e.clientX; sy = e.clientY; px = state.pan.x; py = state.pan.y;
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

  vp.addEventListener('wheel', e => {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX, e.clientY);
  }, { passive: false });

  $('#zoomIn').onclick = () => setZoom(state.zoom * 1.2);
  $('#zoomOut').onclick = () => setZoom(state.zoom / 1.2);
  $('#zoomFit').onclick = fitBracket;
  $('#zoomMine').onclick = jumpToMine;
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
  const cat = state.cat;
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

/* ============================ picker ============================ */

function openPicker() {
  $('#pickerCat').textContent = CAT_LABEL[state.cat];
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
  const draw = state.draws[state.cat];
  const q = $('#pickerSearch').value.trim().toLowerCase();
  list.innerHTML = '';

  if (!draw) {
    list.appendChild(el('div', 'status', '<span class="spinner"></span>Loading the draw&hellip;'));
    return;
  }

  const entries = Array.from(draw.entries.values())
    .filter(e => !q || e.name.toLowerCase().includes(q) || (e.countryCode || '').toLowerCase().includes(q))
    .sort((a, b) => {
      const sa = a.seed ? Number(a.seed) : 999, sb = b.seed ? Number(b.seed) : 999;
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });

  for (const e of entries) {
    const on = e.players.some(p => state.selected.has(String(p.id)));
    const row = el('div', 'pk' + (on ? ' is-on' : ''));
    row.innerHTML = `
      ${flagImg(e.flag, e.countryCode)}
      <span class="pk-nm">${esc(e.name)}<small>${esc(e.countryCode || '')}${
        e.seed ? ' &middot; seed ' + esc(seedText(e.seed)) : ''}</small></span>
      <span class="pk-add">${on ? 'Following' : 'Follow'}</span>`;
    row.onclick = () => {
      const nowOn = e.players.some(p => state.selected.has(String(p.id)));
      for (const p of e.players) {
        if (nowOn) state.selected.delete(String(p.id));
        else state.selected.add(String(p.id));
      }
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
  if (state.view === 'schedule') {
    renderDaybar();
    renderSchedule();
  } else if (state.view === 'players') {
    renderMyPlayers();
    renderPlayerDetail();
  } else {
    renderBracket();
  }
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
  if (v === 'bracket' && first) {
    requestAnimationFrame(() => (state.selected.size ? jumpToMine() : fitBracket()));
  }
}

async function setCat(c) {
  state.cat = c;
  $$('.cat').forEach(b => {
    const on = b.dataset.cat === c;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  syncHash();
  renderAll();
  try {
    await loadDraw(c);
  } catch (e) {
    showError(e);
    return;
  }
  renderAll();
  if (state.view === 'bracket') requestAnimationFrame(fitBracket);
  if (!$('#picker').hidden) renderPicker();
  loadRankIndex(c).catch(() => { /* opponents just stay in bracket order */ });
}

/** Cycle views / disciplines / highlighted player from the keyboard. */
function stepView(delta) {
  const i = VIEWS.indexOf(state.view);
  setView(VIEWS[(i + delta + VIEWS.length) % VIEWS.length]);
}

function stepCat(delta) {
  const i = CATS.indexOf(state.cat);
  setCat(CATS[(i + delta + CATS.length) % CATS.length]);
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
      return;
    }

    // Don't hijack typing, modifier combos, or keys while a dialog is up.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (!$('#picker').hidden || !$('#h2h').hidden) return;

    // Zoom the bracket. Covers the main row (+ needs Shift on most layouts, so
    // '=' counts too) and the numpad, via e.code so layout doesn't matter.
    if (state.view === 'bracket') {
      const zoomIn  = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' || e.code === 'Equal';
      const zoomOut = e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract' || e.code === 'Minus';
      if (zoomIn)  { e.preventDefault(); setZoom(state.zoom * 1.2); return; }
      if (zoomOut) { e.preventDefault(); setZoom(state.zoom / 1.2); return; }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitBracket(); return; }
    }

    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); stepView(-1); break;
      case 'ArrowRight': e.preventDefault(); stepView(1); break;
      case 'Shift':      if (!e.repeat) { e.preventDefault(); stepCat(1); } break;
      case 'ArrowUp':    if (state.view === 'players') { e.preventDefault(); stepPlayer(-1); } break;
      case 'ArrowDown':  if (state.view === 'players') { e.preventDefault(); stepPlayer(1); } break;
    }
  });
}

function showError(e) {
  const box = $('#scheduleStatus');
  box.hidden = false;
  box.className = 'status is-error';
  box.textContent = 'Could not reach the BWF data service. ' +
    'It rate-limits bursts of requests — wait a moment and reload. (' + (e && e.message ? e.message : 'unknown error') + ')';
}

function applyTheme() {
  const skin = store.read('skin', 'bwf');
  const mode = store.read('mode', null);
  document.documentElement.dataset.skin = skin;
  if (mode) document.documentElement.dataset.mode = mode;
  else delete document.documentElement.dataset.mode;
}

function initTheme() {
  applyTheme();

  $('#skinToggle').onclick = () => {
    store.write('skin', store.read('skin', 'bwf') === 'bwf' ? 'sport' : 'bwf');
    applyTheme();
  };

  $('#modeToggle').onclick = () => {
    const sysLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    const cur = store.read('mode', null) || (sysLight ? 'light' : 'dark');
    store.write('mode', cur === 'dark' ? 'light' : 'dark');
    applyTheme();
  };
}

async function init() {
  readHash();
  initTheme();

  $$('.tab').forEach(t => t.onclick = () => setView(t.dataset.view));
  $$('.cat').forEach(b => b.onclick = () => setCat(b.dataset.cat));

  $('#onlyMine').checked = state.onlyMine;
  $('#onlyMine').onchange = e => { state.onlyMine = e.target.checked; renderSchedule(); };

  $('#openPickerBtn').onclick = openPicker;
  $('#openPickerBtn2').onclick = openPicker;
  $('#closePicker').onclick = closePicker;
  $('#donePicker').onclick = closePicker;
  $('#pickerSearch').oninput = renderPicker;
  $('#picker').onclick = e => { if (e.target.id === 'picker') closePicker(); };
  $('#closeH2h').onclick = closeH2H;
  $('#h2h').onclick = e => { if (e.target.id === 'h2h') closeH2H(); };

  initBracketInteraction();
  initHotkeys();

  // Selections are shareable URLs, so honour back/forward and pasted links
  // arriving at an already-open page. syncHash() writes the same string we'd
  // read back, so compare first to avoid reacting to our own updates.
  window.addEventListener('hashchange', () => {
    const before = JSON.stringify([Array.from(state.selected).sort(), state.cat, state.view]);
    readHash();
    const after = JSON.stringify([Array.from(state.selected).sort(), state.cat, state.view]);
    if (before === after) return;
    store.write('players', Array.from(state.selected));
    setView(state.view);
    setCat(state.cat);
  });

  setView(state.view);
  await setCat(state.cat);

  // Everything below is progressive: the page is already usable. The shared
  // request queue serialises these, so they never burst the API.
  (async () => {
    // Other draws first — they let followed players resolve in every
    // discipline, not just the one currently selected.
    for (const c of CATS) {
      if (c === state.cat) continue;
      try { await loadDraw(c); renderAll(); } catch { /* keep going */ }
    }
    // Then scheduling data: times, courts and scores, once BWF publishes them.
    await loadAllDays(() => { if (state.view === 'schedule') renderSchedule(); })
      .catch(() => { /* schedule stays "time to be confirmed" */ });
  })();
}

document.addEventListener('DOMContentLoaded', init);
