# BWF World Championships 2026 — Player Tracker

### ▶ [Open the tool](https://carefulcamel61097.github.io/my-world-championships/)

A lightweight, static web tool (GitHub Pages) that turns the overwhelming BWF World
Championships schedule into a **personal** schedule: pick the players you care about,
and see only their matches, results, times and opponents.

> **Status:** working v1. Three files, no backend, no build step.
> Data comes straight from BWF's public JSON API in the visitor's browser.

## Run it

Any static host works; it is plain HTML/CSS/JS.

```bash
# locally — must be over http://, not file://
python -m http.server 8000
# → http://localhost:8000
```

To publish: push to GitHub and enable Pages on the branch root.

| File | Role |
|---|---|
| `index.html` | Page shell: top bar, discipline chips, both views, picker modal |
| `styles.css` | Two skins (BWF / SportsPort) x light + dark, via CSS custom properties |
| `app.js` | Request queue + cache, draw parsing, bracket maths, rendering |

### Design

Default skin mirrors the BWF site (red `#df2027`, Roboto, dense cards). The **Theme**
button swaps to the SportsPort palette (orange `#FF8000`, Inter, rounded cards); the
**Mode** button forces light/dark. Both choices persist in `localStorage`. With no
explicit choice the page follows `prefers-color-scheme`, falling back to dark.

### Views

1. **Schedule** — the followed players' matches only, grouped by day, with venue time,
   your local time, court, round, per-game scores and duration. Discipline chips switch
   MS/WS/MD/WD/XD; a day bar filters to one day or shows all.
2. **Players** — the follow list on the left, the highlighted player's detail on the
   right: photo, country, seed, BWF world ranking, career-high ranking, age, and the
   **road through the draw** — each round as its own band, showing either the confirmed
   match or every opponent they could still meet, **ordered by BWF world ranking** so the
   dangerous ones come first.
3. **Bracket** — the whole 63-match draw as one pannable, zoomable map, in the same shape
   as the SportsPort tournament map: feeders on the left, Final on the right, elbow
   connectors between. Followed players are outlined. *Fit* frames the entire draw;
   *Jump to my player* zooms to a readable level and centres on them.

**Head-to-head** opens from anywhere a real pairing is shown: any match card in the
Schedule or Players view, any opponent chip, or any node in the Bracket. It shows the
career record, a win-share bar, **both players' BWF World and Race-to-Finals rankings**,
**both players' season strips**, and every previous meeting with tournament, round,
winner and game scores. The rankings and season strips matter most exactly when the
record is empty — two players who have never met still get a useful comparison.

**Season strip** — one square per tournament this year, in chronological order. The
square shows how far the player got (`W`, `F`, `SF`, `QF`, `R16`, `R32`, `R64`, `Q`), the
tournament name sits above it and the level below, both tiny.

Each square is a **gauge**: it fills from the bottom in proportion to how much of that
tournament the player got through, and the colour ramps deep green (title) → red
(first-round exit). So the strip reads as a bar chart before you register a single
label:

| Result | Fill | | Result | Fill |
|---|---|---|---|---|
| Champion | 100% | | Quarter-final | 40% |
| Runner-up | 80% | | Round of 16 | 20% |
| Semi-final | 60% | | First-round exit | 13% (a visible sliver) |

The fraction is *rounds won ÷ rounds available in that tournament*, not a fixed ladder,
so a Super 300 quarter-final and a Super 1000 quarter-final read the same instead of
being skewed by draw size. The player's entry round is derived from where they went out
and how many matches they played: `entry = exitDepth − matchesPlayed + 1`.

The label carries the same information as the colour, so it survives colour-blindness;
the full name, level and win-loss record are in the tooltip, and each square links to the
BWF tournament page. It appears on the highlighted player in the Players view and for
both players in every head-to-head.

**Left out of the strip:** the World Championships itself (not played yet — an `R64`
square would read as a bad result rather than no result) and team events (Thomas/Uber,
Sudirman, continental team), where BWF returns no individual position at all.

Seeds are shown bracketed — `[1]`, `[16]` — everywhere they appear.

Selections live in `localStorage` and in the URL hash
(`#p=57945,87442&c=ms&v=players`), so a selection is shareable and bookmarkable;
`hashchange` is honoured, so pasted links and back/forward work on an open page.

### Keyboard

| Key | Action |
|---|---|
| `←` `→` | Previous / next view (Schedule → Players → Bracket, wrapping) |
| `Shift` | Next discipline (MS → WS → MD → WD → XD, wrapping) |
| `↑` `↓` | Previous / next followed player (Players view only) |
| `+` `−` | Zoom the bracket in / out (Bracket view only; main row **and** numpad) |
| `F` | Fit the whole draw to the viewport (Bracket view only) |
| `Esc` | Close the head-to-head or the player picker |

Keys are ignored while typing in the search box and while a dialog is open. Zoom is
matched on `e.code` as well as `e.key`, so `NumpadAdd` / `NumpadSubtract` and the
unshifted `=` / `-` keys all work regardless of keyboard layout.

---

## 1. The tournament

| | |
|---|---|
| Event | BWF World Championships 2026 (30th edition) |
| Dates | **17 – 23 August 2026** |
| Venue | Indira Gandhi Arena, New Delhi, India |
| Events | MS, WS, MD, WD, XD |
| Draw size | 64 entries per event (63 matches, straight knockout) |
| BWF tournament id (`tmtId`) | `5601` |
| BWF `tournamentCode` (GUID) | `B671FB97-491C-46D3-982F-56525168C3AA` |
| BWF site slug | `bwf-world-championships-2026` |

Public tournament page:
`https://bwfworldchampionships.bwfbadminton.com/results/5601/bwf-world-championships-2026/draws/draw/ms`

---

## 2. What the tool should do

### Core (MVP)

- **Follow list** — search and select players; persisted in `localStorage`, shareable via URL.
- **My schedule** — only the followed players' matches: day, local time, your-timezone time,
  court, round, opponent, and result once played.
- **Category switch** — MS / WS / MD / WD / XD.
- **Results** — scores per game, match duration, winner.

### Player detail

- **Player card** — BWF World Ranking, Race-to-Finals ranking, career W/L, recent form,
  and (if obtainable) Elo rating + Elo ranking.
- **Head-to-head** — record vs a given opponent, with the match history.
- **Path to the title** — the player's position in the bracket and the list of
  *potential opponents* in each subsequent round, with seeds and rankings.

### Nice-to-have (later)

- Live score polling during play.
- "Match of the day" / clash highlighting between two followed players.
- Upset tracking vs seeding.
- Calendar (`.ics`) export of a followed player's matches.

---

## 3. Data source investigation — findings

Both intended sources were probed directly. **Summary: the BWF side is fully usable and
covers almost everything. badmintonranks.com is not usable programmatically without
permission.**

### 3.1 BWF — ✅ usable, and better than expected

The BWF public sites (`bwfbadminton.com`, `bwfworldchampionships.bwfbadminton.com`) are
WordPress shells whose match/draw/ranking widgets are **Vue components that fetch JSON**
from a single backend:

```
https://extranet-lv.bwfbadminton.com
```

Properties confirmed by testing:

| Property | Result |
|---|---|
| Authentication | **None** — no key, no token, no cookie |
| CORS | **`Access-Control-Allow-Origin` reflects any `Origin`** — tested with `https://thabiso.github.io`, `https://example.com` and `http://localhost`, all echoed back |
| Callable from GitHub Pages in the browser | **Yes** — verified end-to-end in a real Chrome |
| Response format | Clean JSON |
| Gotcha | Behind Cloudflare bot mitigation. See below — this is the one that bites. |
| Gotcha | Rate limiting exists — a burst of ~12 rapid requests started returning empty bodies. The app serialises requests ~320 ms apart and caches in `sessionStorage`. |

#### ⚠️ Cloudflare blocks automated browsers, not real ones

This cost real debugging time and is worth recording. Loading the tool in **headless
Chrome** produced:

```
Access to fetch at 'https://extranet-lv.bwfbadminton.com/api/…' has been blocked
by CORS policy: No 'Access-Control-Allow-Origin' header is present
```

That message is misleading. Capturing the raw response over the DevTools Protocol showed
the truth: **HTTP 403 with an HTML body and no CORS headers** — Cloudflare's bot
challenge. The identical page in a **normal (headful) Chrome returns HTTP 200** with
`Access-Control-Allow-Origin` correctly reflected, and everything renders.

So: real visitors are fine; automated clients are blocked. This is consistent with
`extranet-lv.bwfbadminton.com/robots.txt` being `Disallow: /` — BWF blocks bots and
allows browsers. It also means **a scheduled scraper (e.g. GitHub Actions) would be
blocked**, which rules out the caching fallback described in §4 unless it uses a real
browser. Client-side fetching is not just the simplest design here, it is the one that
works.

Because CORS is open, **the tool can be a pure static site with no backend and no build
step** — the visitor's browser talks to BWF directly. That is the single most important
finding here.

#### Verified endpoints

All tested live against WC2026 unless noted.

**Schedule & results (per day)**

```
GET /api/tournaments/day-matches?tournamentCode={GUID}&date=YYYY-MM-DD&order=2&court=0
GET /api/tournaments/day-matches/courts?tournamentCode={GUID}&date=YYYY-MM-DD
GET /api/tournaments/day-matches/players?tournamentCode={GUID}&date=YYYY-MM-DD
```

`order`: `1` = by time, `2` = by court. `court=0` = all courts.

A match object contains essentially everything the tool needs:

```jsonc
{
  "id": 1436172,
  "eventName": "XD",              // MS | WS | MD | WD | XD
  "roundName": "R16",
  "drawName": "XD", "drawCode": "5",
  "matchTime": "2025-06-05 09:05:00",      // local venue time
  "matchTimeUtc": "2025-06-05 02:05:00",   // UTC → convert to user's timezone
  "oopText": "Starting at 9:00 AM",        // order-of-play wording
  "matchStatus": "F", "matchStatusValue": "Finished",
  "courtName": "Court 1", "locationName": "Istora Senayan",
  "duration": 35,
  "winner": 1,                              // 1 = team1, 2 = team2
  "team1seed": null, "team2seed": null,
  "score": [ { "set": 1, "home": 21, "away": 19 },
             { "set": 2, "home": 21, "away": 11 } ],
  "team1": { "countryCode": "INA",
             "players": [ { "id": "63571", "nameDisplay": "Adnan MAULANA",
                            "slug": "adnan-maulana", "countryCode": "INA",
                            "avatar": { "thumbnailUrl": "…" } } ] },
  "team2": { … }
}
```

> ⚠️ As of **14 Aug 2026** `day-matches` returns `[]` for all WC2026 dates — the order of
> play is not published yet (BWF typically publishes it 1–2 days ahead). The endpoint is
> confirmed working against the 2025 Indonesia Open. Re-check from ~16 Aug.

**Draws / brackets — live now**

```
GET /api/vue-tournament-draws?tmtId=5601&tmtType=1
GET /api/vue-tournament-draw-data?tmtId=5601&tmtType=1&drawId={1-5}&isPara=0
GET /api/tournaments/draw/players?tournament_id=5601&draw_code={1-5}
```

`drawId`: **1 = MS, 2 = WS, 3 = MD, 4 = WD, 5 = XD.**

`vue-tournament-draw-data` returns `{ results, matches, drawsize, drawendcol, gameTypeId }`
where `results` is a **grid keyed `"col-row"`** (`"0-0"`, `"0-1"`, …) — i.e. the literal
bracket layout — and `matches` is a flat array of all 63 matches. This is exactly what
"show me the potential opponents this player can face" needs: locate the player's cell,
then walk the columns.

Two things to know about this payload:

- **The grid cells and `matches[]` are the same 63 matches but not the same objects.**
  Only `matches[]` carries `id` (and, later, times and scores); the grid cells carry
  `code`. They join on `code`, which is unique within a draw. `app.js` substitutes the
  richer object into the grid so both views enrich identically.
- **Byes are real.** Column 0 always has 32 cells, but a doubles field can be smaller
  than the bracket — WD 2026 has **48 pairs in a 64 slot draw**, so 16 first-round cells
  have one side filled and the other empty. Those are not fixtures and must be excluded
  from the schedule, or you show 16 phantom "vs TBD" matches. MS/WS are full 64-entry
  fields with no byes.

**Head-to-head**

```
GET /api/h2h/statistics?t1p1={id}&t1p2={id}&t2p1={id}&t2p2={id}
GET /api/h2h/match
GET /api/h2h/opponents
GET /api/h2h/player-search
GET /api/h2h/player-options
```

(`t1p2`/`t2p2` omitted for singles.) `statistics` returns `matches`, `stats`, `prizeMoney`,
`players` (with height, plays, etc.), plus:

```jsonc
"ranking": { "team1": [
  { "rankingId": 2, "rankingCategoryId": 6,  "rankingName": "BWF World Rankings",          "currentRank": 1 },
  { "rankingId": 9, "rankingCategoryId": 57, "rankingName": "HSBC Race to Guangzhou Rankings", "currentRank": 20 } ] },
"careerStats": { "team1": { "careerWins": 377, "careerLosses": 123,
                            "currentYearWins": 22, "currentYearLosses": 6,
                            "winningForm": ["W","L","W","W","L"] } }
```

So BWF gives us **both** the world ranking *and* the road-to-finals ranking, plus form —
several things originally assumed to require badmintonranks.

**Rankings tables**

```
GET /api/vue-rankingtable?rankId={id}&catId={id}&page=1&doubles=false[&drawCount=&searchKey=&publicationId=]
GET /api/vue-rankingweek     GET /api/vue-rankinginfo?rankId=2
GET /api/vue-rankingdata     GET /api/vue-rankingbreakdown
```

Category IDs confirmed by reading off the current world no. 1 in each:

| Event | `rankId=2` (BWF World Rankings) | `rankId=9` (HSBC Race to Guangzhou) |
|---|---|---|
| MS | `catId=6` — SHI Yu Qi | `catId=57` — CHOU Tien Chen |
| WS | `catId=7` — AN Se Young | `catId=58` — CHEN Yu Fei |
| MD | `catId=8` — KIM Won Ho / SEO Seung Jae | `catId=59` — GOH Sze Fei / Nur IZZUDDIN |
| WD | `catId=9` — LIU Sheng Shu / TAN Ning | `catId=60` — LIU Sheng Shu / TAN Ning |
| XD | `catId=10` — FENG Yan Zhe / HUANG Dong Ping | `catId=61` — M. CHRISTIANSEN / A. BØJE |

⚠️ `results` is polymorphic: a **plain array** when `drawCount` is passed, a **paginated
object** (`{current_page, data, …}`) otherwise. Handle both.

⚠️ **Paging is hard-locked at 15 rows.** `per_page`, `perPage`, `limit`, `pageSize`,
`size` and `count` are all ignored, and `drawCount` changes the response *shape* but not
the row count. MS is 143 pages / 2131 rows. So there is no bulk ranking fetch.

To order opponents by ranking, `app.js` walks the ranking table page by page until every
entrant in the draw is accounted for (capped at 20 pages), keying rows the same way as
draw entries — `player1_id` for singles, both ids sorted and joined for doubles. Rankings
only change weekly, so the resulting index is cached in **`localStorage` with a 12-hour
TTL**, which makes repeat visits free. Unranked entrants sort last.

**Per-player profile** (what the Players view actually uses)

```
GET /api/vue-player-summary?playerId={id}&isPara=0&drawCount=5
GET /api/vue-player-ranking-current?playerId={id}&isPara=0&rankingEvent={catId}
GET /api/vue-player-ranking-highest?playerId={id}&isPara=0&rankingEvent={catId}
GET /api/vue-player-match-previous?playerId={id}&isPara=0&drawCount=5&activeTab=0
GET /api/vue-player-match-next   … also: -bio, -gallery, -tournaments, -ranking-history
```

- `vue-player-summary` → bio: `date_of_birth`, `nationality`, avatar URLs, slug.
- `vue-player-ranking-current` → `{"results": 1}`, the rank as a bare number.
  `rankingEvent` is the **ranking category id** (6/7/8/9/10), *not* the draw id.
  It works for doubles too — pass either partner's `playerId`.
- `vue-player-ranking-highest` → `{"rank": 1, "date": "2026-08-11", "total": 101}`.
- Both ranking endpoints return `"-"` if `rankingEvent` doesn't match the player's
  discipline — so never call them before you know which draw the player is in, and
  never cache the answer under the player id alone.

⚠️ `/api/h2h/statistics` **requires both sides** — calling it with only `t1p1` returns
HTTP 500. Use it for head-to-heads, not for single-player profiles. It returns
`stats` (`totalWins` / `totalLosses` / `totalMatches`), `matches[]`
(`info.matchTime`, `info.roundName`, `result.winner`, `progress.games[]`,
`tournament.name`), **and `ranking.team1` / `ranking.team2`** — so both players'
World and Race-to rankings come free with the head-to-head, no extra request.

**Season results**

```
GET /api/vue-player-tournaments?playerId={id}&isPara=0&drawCount=1&activeTab=0&tmtYear=2026
```

Returns the player's season newest-first, each entry carrying `tournament_model` and a
`draws[]` array with `position`, `match_win` and `match_lose`.

⚠️ **BWF spells the podium as placings, not rounds.** `position` is one of
`1st` / `2nd` / `3rd` for champion / runner-up / semi-final — there is no `SF` string —
then `QF`, `R16`, `R32`, `R64`, `Qual. QF`, `Qual. R16`, and `N/A` for team events.

`tournament_category_id` gives the level. No name field is exposed, so the mapping was
derived by sampling several players' seasons across tiers:

| id | Level | id | Level |
|---|---|---|---|
| `5` | International Challenge | `21` | Major team event (Thomas/Uber, Sudirman) |
| `6` | International Series | `22` | World Tour Finals |
| `11` | Continental Championships | `23` | Super 1000 |
| `17` | Continental Team Championships | `24` | Super 750 |
| `20` | World Championships | `25` | Super 500 |
| | | `26` | Super 300 |
| | | `27` | Super 100 |

**Note on `robots.txt`:** `extranet-lv.bwfbadminton.com/robots.txt` is `Disallow: /` for all
agents. That governs *crawlers*, and Cloudflare enforces it in practice (see the headless
finding above). A user's own browser fetching data to render a page they requested is the
same traffic the BWF site itself generates — but it is the reason the client-side design
is the correct one here, and the reason to cache aggressively. See §6.

### 3.2 badmintonranks.com — ⛔ blocked, needs permission

`badmintonranks.com` is a Vue SPA (RuoYi framework) with its API at `/prod-api`. The full
endpoint list was recovered from the JS bundles and it is rich — exactly the data wanted:

```
/tournament/eloRanking/list      /tournament/eloRanking/listPeakElo
/tournament/bwfRanking/listCurrent   /tournament/bwfRanking/list
/tournament/match/listByH2H      /tournament/event/getDraw
/tournament/playerRanking/list   /tournament/battle/getDrawDetail    …
```

**However, the data endpoints are deliberately protected.** The request interceptor runs
obfuscated code (`jsjiami.com.v7`) that computes a signed **`Bpoint`** header for any URL
outside `dict/data` and `system`. Without it the API returns `{"code":430}`.

Tested:

| Endpoint | Result |
|---|---|
| `/tournament/eloRanking/listDate` | ✅ open (returns list of ranking dates, latest `2026-08-09`) |
| `/tournament/bwfRanking/listDate` | ✅ open (latest `2026-08-11`) |
| `/tournament/index/getNewList`, `getPopularList` | ✅ open (small teaser payloads) |
| `/tournament/eloRanking/list` | ⛔ `430` |
| `/tournament/bwfRanking/listCurrent` / `list` | ⛔ `430` |
| `/tournament/eloRanking/listPeakElo` | ⛔ `430` |
| `/tournament/match/listByH2H` | ⛔ `430` |
| `/tournament/event/list` | ⛔ `430` |

Only metadata teasers are open; **every bulk data endpoint is signature-gated**. Swagger is
exposed at `/prod-api/v3/api-docs` but documents only RuoYi's demo user controller.

The signing is an intentional anti-scraping measure by the site owner. **This project will
not attempt to reverse-engineer or defeat it.**

**Decision: badmintonranks is not used.** The site owner has not been contacted and no
approach will be made. Elo rating and Elo ranking are therefore out of scope — see §3.3
for what that costs (very little). Everything the tool ships comes from BWF.

### 3.3 Coverage matrix

| Feature | Source | Status |
|---|---|---|
| Match schedule, days, times, courts | BWF `day-matches` | ✅ available (WC2026 order of play publishes ~16 Aug) |
| Results & scores | BWF `day-matches` | ✅ |
| Draws / brackets | BWF `vue-tournament-draw-data` | ✅ live now |
| Potential opponents | derived from BWF draw grid | ✅ |
| Head-to-head | BWF `h2h/statistics` | ✅ |
| BWF World Ranking | BWF `vue-rankingtable` / h2h | ✅ |
| Road-to-Finals ranking | BWF `rankId=9` | ✅ |
| Career W/L + recent form | BWF `h2h/statistics` | ✅ |
| Player photos, flags, country | BWF (`img.bwfbadminton.com`) | ✅ |
| **Elo rating & Elo ranking** | — | ⛔ **out of scope** (badmintonranks not used) |

Everything except Elo is obtainable from BWF. Nothing else depends on Elo, so its absence
costs one stat cell on the player panel and nothing else. If it is ever wanted, the only
route consistent with the decision above is computing it from BWF match history — a
separate project, and the numbers would not match badmintonranks'.

---

## 4. Architecture as built

Because the BWF API is CORS-open and unauthenticated, the simplest design that works is
also the best one:

```
GitHub Pages (static)
 └── index.html + styles.css + app.js
      ├── fetch() → extranet-lv.bwfbadminton.com   (draws, schedule, rankings, h2h)
      ├── localStorage                              (followed players, skin, mode)
      ├── sessionStorage                            (5-minute response cache)
      └── serialised request queue, ~320 ms apart   (be polite to BWF)
```

- **No backend, no build step, no API keys, no secrets.**
- Followed players are encoded in the URL hash (`#p=57945,87442&c=ms&v=players`) so a
  selection is shareable and bookmarkable.
- **The draw is the backbone, not the schedule.** Draws are published well in advance and
  contain every entrant, every fixture and the full bracket; `day-matches` only adds
  times, courts and scores. So the app loads the draw first and renders immediately, then
  merges scheduling data in the background as each day arrives. This is why the tool is
  fully usable *before* the order of play exists.
- In-flight requests are de-duplicated by caching the *promise*, not the result.

**No scraped-cache fallback.** The obvious fallback — a GitHub Actions cron job that
fetches JSON and commits it — **does not work**: Cloudflare blocks non-browser clients
(§3.1). If the client-side route ever fails, the fallback would have to drive a real
browser, which is a much bigger commitment.

---

## 5. Build order — v1 complete

1. ✅ Draw fetch + parse (entries, bracket grid, byes).
2. ✅ Player picker with search, follow list in `localStorage` + URL hash.
3. ✅ Schedule filtered to followed players → *the actual product*.
4. ✅ Timezone conversion from `matchTimeUtc`.
5. ✅ Discipline switching across MS/WS/MD/WD/XD.
6. ✅ Potential-opponents list derived from the bracket grid, ranked by BWF ranking.
7. ✅ Player detail: ranking, career high, seed, age.
8. ✅ Head-to-head popup from schedule, players and bracket, with both rankings.
9. ✅ Full bracket map view with pan/zoom.
10. ✅ Keyboard navigation, including bracket zoom.
11. ✅ Season results strip, in the Players view and both sides of every head-to-head.
12. ⬜ Recent form strip (`vue-player-match-previous` is already fetched, not yet shown).
13. ⬜ Calendar (`.ics`) export.
14. ⬜ Elo — not planned; badmintonranks is off the table by choice.

### Verified against live data

- Bracket maths unit-tested over all 64 MS entries: opponent pools are exactly
  1 → 2 → 4 → 8 → 16 → 32, reciprocal at R64, never include the player themselves, and
  the top seed's pools union to all 63 rivals.
- End-to-end in a real Chrome: both skins and both modes apply; picker lists 64 entries
  and filters; WD loads 48 pairs with 16 byes correctly excluded (47 fixtures, not 63);
  seeds render bracketed; opponent chips carry ranks in ascending order; head-to-head
  resolves real meeting histories (SHI Yu Qi vs Anders Antonsen: 9–4 across 13 meetings
  back to 2017) plus both rankings and both season strips; every hotkey works including
  wrap-around and numpad zoom; the bracket renders 63 nodes, 124 connector segments and
  6 column labels; no uncaught exceptions.
- Season strip checked against a real season: SHI Yu Qi 2026 renders
  `F · R32 · W · SF · R16 · R16 · QF · QF` with the right levels, colours and fills
  (100 / 80 / 60 / 40 / 20 / 13 %), with the World Championships and Thomas & Uber Cup
  correctly dropped.
- Bracket interaction driven with synthetic mouse events: a click opens the head-to-head,
  a drag pans without selecting text or opening the popup, a double-click selects
  nothing, and `F` reproduces the Fit button exactly.

### Bracket geometry

Node positions are computed rather than derived by walking the tree. A match at
`(col c, row r)` is fed by `(c-1, 2r)` and `(c-1, 2r+1)`, so its vertical centre is the
midpoint of its feeders, which closes to:

```
centre(c, r) = (r + 0.5) * 2^c * SLOT        SLOT = CARD_H + GAP_Y
left(c)      = c * (CARD_W + CONN_W)
```

Each column is simply a doubling of the one before it. Panning is clamped so the canvas
cannot be dragged into empty space, and centres on whichever axis is smaller than the
viewport.

**Two pointer-handling traps worth remembering**, both of which silently broke clicking a
match to open its head-to-head:

- `setPointerCapture()` on the viewport **retargets the follow-up `click` to the
  capturing element**, so match nodes never received it. Panning instead attaches
  `pointermove` / `pointerup` to `window` for the duration of the drag.
- `preventDefault()` on `pointerdown` can suppress the compatibility `click` entirely in
  some browsers. Text selection is blocked with `user-select: none` plus a `selectstart`
  handler instead — which also fixes the trackpad case where a drag turned into a
  double-click-and-highlight.

A click that merely ended a pan is swallowed by a **capture-phase** `click` listener on
the viewport, so it never reaches the node underneath.

---

## 6. Etiquette & attribution

- All data belongs to **BWF**. This is an unofficial fan tool and says so in the footer.
- The tool carries no BWF logo or wordmark and does not present itself as official. It
  borrows BWF's *layout conventions* (match-card anatomy, discipline chips, round labels)
  because that is what makes a schedule readable — not their identity.
- The BWF endpoints are **undocumented and unofficial**; they can change or disappear
  without notice. The app fails gracefully and says so rather than showing a blank page.
- Cache aggressively; do not poll faster than ~30 s even for live scores. Rate limiting is
  real (observed at ~12 rapid requests) — hence the serialised queue.
- Credit the source visibly and link back to the BWF tournament page.
- No attempt is made to bypass badmintonranks' request signing, and none should be added.

---

## 7. Open questions

- **Once the order of play publishes (~16 Aug), re-check the schedule view.** `day-matches`
  returns `[]` for every WC2026 date as of 14 Aug, so the merge path — times, courts,
  live scores — has been exercised only against the 2025 Indonesia Open, not against this
  tournament. This is the main untested surface.
- Does `matchStatus` use `L` for live? `F` (Finished) is confirmed from real data; the live
  code is inferred. Worth confirming on day one.
- Are qualification rounds present? The draws list shows `qualification: 0` for all five,
  so main draw only.
- Should the day bar default to today once the tournament starts, rather than "All"?
