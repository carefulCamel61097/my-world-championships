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

Deployment is GitHub Pages straight from `main` at the repository root — no workflow, no
build step, so pushing to `main` *is* the deploy:

```bash
git push                     # that's the whole deploy
```

It was enabled once with:

```bash
gh repo create my-world-championships --public --source=. --push
gh api -X POST repos/<owner>/my-world-championships/pages \
  -f "source[branch]=main" -f "source[path]=/"
```

| File | Role |
|---|---|
| `index.html` | Page shell: top bar, discipline chips, the three views, picker modal |
| `styles.css` | Two skins (BWF / SportsPort) x light + dark, via CSS custom properties |
| `app.js` | Request queue + cache, draw parsing, bracket maths, rendering |
| `tests/` | 13 suites driving a real Chrome over CDP, plus the fixture harness |

### Design

Default skin mirrors the BWF site (red `#df2027`, Roboto, dense cards). The **Theme**
button swaps to the SportsPort palette (orange `#FF8000`, Inter, rounded cards); the
**Mode** button flips light/dark. Both choices persist in `localStorage`.

**The default is BWF red on dark**, whatever the system is set to — the tool reads as a
scoreboard, and a scoreboard is dark. `index.html` ships `data-mode="dark"` on the root
element as well as setting it in JS, so a light-mode machine gets no flash of white on
first paint. The `prefers-color-scheme` rules are still in the stylesheet and still
correct; they simply no longer decide the default.

### Views

Three of them, each answering one question. The organising principle is **what you are
selecting**: matches, players, or nothing at all.

| View | Question | What it holds |
|---|---|---|
| **Follow Matches** | What's on, when, and on which court? | A day's order of play, everything dimmed. Star what's worth watching. |
| **Follow Players** | How are the people I follow doing? | Sub-tabs: *Players* (the follow list + detail) and *Schedule* (their matches by day). |
| **Draw** | What does the bracket look like — and who do I say wins? | One tree, four modes: *Results · Your predictions · By world ranking · By race ranking*. |

**Follow Matches and Follow Players are deliberately independent.** Starring a match has
nothing to do with the players you follow, and following a player never lights anything up
in the matches view — no red names, no accent rails, no automatic stars. They are two
separate ways of using the tool and mixing them makes both harder to read.

There is exactly one bridge between them, and it is a button rather than a rule:
**Add *n* to Follow Matches**, in Follow Players → Schedule. It stars whatever that
schedule is currently showing — day filter and discipline chips included — so tomorrow's
fixtures for the players you follow light up without re-picking them one card at a time.
The count is what would actually change, so it reads `Add 4` when two of the six are
already starred; once everything on screen is starred it flips to **Remove *n* from Follow
Matches**, because a button that would do nothing is worse than one that offers the way
back. A star still only ever gets set by something you clicked.


**Bracket and Predictions used to be two views and are now one.** They were always the
same tree — same geometry, same connectors, same pan and zoom — differing only in where
the names came from. Merging them removes a tab and a near-duplicate renderer, and buys
something neither had: flipping between what you predicted and what actually happened
**keeps your zoom and your place on the draw**, because there is now one camera rather
than two. The camera re-frames on a change of discipline, never on a change of mode.

Links made before the restructure still work: `v=schedule` lands on Follow Players →
Schedule, `v=bracket` on Draw → Results, `v=predict` on Draw → Your predictions. A link
that names a sub-view beats the one you last had open, so a shared URL shows what the
sender meant.


The **discipline chips are independent on/off filters, all on by default** — not a
single-choice switch. Following a men's singles player and a women's doubles pair shows
both in one list, which is the point of a personal schedule. **All** turns everything back
on; the last remaining discipline cannot be switched off, so the page is never empty. The
choice persists and travels in the URL (`c=all`, or `c=ms,wd`).

**Both day bars land on today** once the tournament is on. Follow Matches has to pick
*some* day either way, so outside the week it opens on day one; the player schedule is
short enough to be worth seeing whole, so it falls back to *All days*. "Today" is the
**viewer's** local date, not UTC — `toISOString().slice(0,10)` still reads as yesterday
east of Greenwich between local midnight and UTC midnight, so in central Europe the tool
would have opened on the wrong day every night until 02:00, which is exactly when you
would be looking ahead to the next one.

**Follow Matches** shows one day at a time — with every match of the switched-on disciplines laid out by court
and **dimmed**. Click a match to star it and it lights up: full-strength card, accent
header, filled star. *Starred only* collapses the day to just those, keeping each one in
its true position in the running order, so you can see at a glance when and on which
court your evening is. Stars are kept in `localStorage`, keyed by match id (the `code` is
only unique within one draw, so MS and WD would collide). In this view the head-to-head
moves to a button of its own, because the card itself is the star toggle.

**Follow Players opens on the list**, not the schedule: the schedule is *derived* from who
you follow, so the list is where you start. Both sub-tabs are drawn as buttons — an
unselected tab with a transparent border reads as a label sitting next to a button, not as
something you can click.

**Follow Players → Schedule** is the old Schedule view: the followed players' matches
only, across every switched-on discipline, grouped by day, with venue time, your local
time, court, round, per-game scores and duration. Same court grid.
**Follow Players → Players** is the follow list on the left, filtered to the switched-on
disciplines, and the highlighted player's detail on the right: photo, country, seed, BWF
world ranking, career-high ranking, age, and the **road through the draw** — each round as
its own band, showing either the confirmed match or every opponent they could still meet,
**ordered by BWF world ranking** so the dangerous ones come first.

**Draw** is the whole 63-match draw as one pannable, zoomable map, in the same shape as
the SportsPort tournament map: feeders on the left, Final on the right, elbow connectors
between. Followed players are outlined. *Fit* frames the entire draw; *Jump to my player*
centres on them. Scrolling moves the view (both axes); zooming is on the buttons, `+`/`−`
and ctrl+wheel. A draw is one discipline by definition, so this view keeps **its own
MS/WS/MD/WD/XD selector**, independent of the filter chips above. Its other three modes
fill the same tree in from your picks or from a ranking — see *Predictions*.

**A doubles pair is always written `SURNAME / SURNAME`** — `GICQUEL / DELRUE`,
`LIU / TAN` — everywhere it is named: match cards, the court grid, the player picker, the
head-to-head, the bracket, the prediction sheet and the PNG. Two full names is a lot of
text for what is really one competitor, and it stopped fitting long before the 208px
bracket cards did. Singles keep their full name.

Nothing is lost. The full form is still what **search matches against**, so the picker
finds `Delphine` as happily as `DELRUE`, and it is what **hover reveals** on any shortened
name. Individual players are still named in full where they appear as people rather than
as half of a pair — the follow list and the player detail panel.

BWF capitalises the family name, which is what `surnameOf()` keys on; see
[Verified against live data](#verified-against-live-data) for how the awkward cases are
handled.

**Byes.** In doubles, 48 pairs enter a 64 draw, so 16 first-round cells have one side
empty. Those cards are drawn at full strength with a dashed border, and the empty half
reads *Bye* rather than an em-dash: that pair is already through to round two, which is
information, not an inactive cell.

**Zoom.** The Draw view opens each discipline at **100%**, because a bracket scaled to fit
is 63 cards of unreadable text (*Fit* is one button away for the overview). The zoom resets
only when you change discipline — changing mode, or tabbing away and back, keeps where you
were looking.

Each followed player has an **×** to stop following them. Removing one half of a doubles
pair removes the partner too — otherwise their matches would keep appearing and the row
could never be cleared.

### The order of play, and why the y-axis is not a clock

Once BWF publishes a day's order of play, that day is laid out as a grid: **one column
per court, one row per position in that court's running order**. Row 3 means "third on
this court".

It is tempting to put the y-axis on a clock instead, and the data appears to support it —
every match carries a `matchTime`. It does not survive contact with the real feed:

```
Court 1  09:00 09:50 10:40 11:30 12:20 13:10 14:00 14:50 15:40 16:30 17:20 …
Court 3  09:10 10:00 10:50 11:40 12:30 13:20 14:10 13:40 14:30 15:20 16:10 …
                                                    ↑ goes backwards
```

Those times are a flat 50-minute estimate stamped on every match, and on the courts with
an evening session they are **not even monotonic** — court 3's eighth match is timed
half an hour *before* its seventh. BWF says as much itself: only the first match on each
court has a real time (`oopText: "Starting at 9:00 AM"`), and everything after it reads
**`"Followed by"`**. Badminton matches follow one another; they do not start at a clock
time. A time axis would have to draw court 3's eighth match above its seventh.

So the running order is the axis, and it is honest as well as convenient: all four courts
run 16 matches starting within ten minutes of each other, so a row lines up across
columns anyway. Rows with nothing to show are skipped, which means filtering to a handful
of followed players gives a dense grid rather than sixteen mostly-empty rows — while two
cards on the same row are still genuinely at the same point in the day.

Follow-on times are shown but marked **≈**, with the reason on hover, rather than
presenting a fabricated time as fact. All times are 24-hour, including BWF's own strings
(`"Starting at 9:00 AM"` is restyled to `09:00`) — a venue time of `09:00` next to a local
time of `6:10 PM` is two clocks in one card.

Below 900px the grid is dropped entirely and the cards stack. Nothing switches on a
resize listener: the cards are emitted row-major, so the same DOM reads down the day when
the grid is off, and the card shows its court name again once the column headers go.

### Predictions

Every card carries a dimmed **W** beside both names. Click one and that entry is your
pick: it lights up, the other side dims, and the winner is carried into the next card,
and the one after that, all the way to a **Champion** cell past the Final. Clicking the
same side again un-picks it. Picks are stored per discipline in `localStorage`, so a
half-filled sheet is still there tomorrow — and the view reopens on the draw you were
last working on rather than resetting to MS.

Three sources, switched by the buttons under the toolbar:

| Button | What it shows |
|---|---|
| **Your predictions** | Your own clicks. Editable; this is the only mode you can change. |
| **By world ranking** | Auto: the better BWF World Ranking wins every match (`rankId=2`). |
| **By race ranking** | Auto: the better HSBC Race to Finals standing wins every match (`rankId=9`). |

The two auto brackets answer "what does the form book say?" and are read-only — but
**Use as mine** copies one into your own sheet as a starting point, so you can take the
seeding-by-ranking bracket and change only the matches you disagree with. They also
disagree with each other in a useful way: world ranking is a rolling 52-week average
while the Race is calendar-year form, so the two often name different champions.

Entries outside the pages walked from the ranking table fall back to the tournament
seeding, and a genuine dead heat keeps the top side — arbitrary, but stable, so the
bracket never flickers between renders.

**Scoring.** Once BWF publishes results, each card is marked against reality. On the side
you backed the **W becomes a verdict** — a green ✓ if that is who won, a red ✗ if it is
not — with a matching tint across that half of the card and a coloured left rail, so how
you are doing reads from across the draw rather than out of a hairline. Hovering a wrong
pick names who actually won. The readout adds `5/6 right so far`, and the ✓/✗ carry into
the PNG, so a sheet saved mid-tournament shows how it is going rather than only what was
predicted.

"Wrong" gets its own `--bad` token rather than reusing the accent: on the BWF skin the
accent *is* red, and a red mark among red seeds and red badges says nothing.

The denominator counts matches that have been **played and predicted**. Counting every
played match would report `1/6 right` on a part-filled sheet, implying five wrong answers
where five were simply never answered.

Real results are deliberately **not** merged into the tree — the cards keep showing who
*you* said would be there, so a wrong pick still carries your player forward. If your
predicted finalist went out in the last 16, your final pick is simply wrong, which is how
a prediction bracket is supposed to work.

**Save PNG** exports the sheet as an image, stamped with the date the predictions were
made (not the date of the export), in the viewer's own timezone — both in the caption and
in the filename, which used to disagree by a day for anyone east of Greenwich filling in a
sheet late in the evening. It is drawn onto a canvas by hand rather than by
rasterising the DOM, which would need a library — this repo has no build step and loads
nothing from a CDN. Flags are fetched with `crossOrigin="anonymous"`; if BWF's image host
ever stops sending the CORS header the flag is skipped rather than tainting the canvas
and making the export impossible.

The export also **traces each of the four semi-finalists' routes** in its own colour,
from where they entered the draw through to **the last round that player actually
reaches**: a beaten semi-finalist's route stops at the semi-final, a beaten finalist's
runs one card further, and the champion's runs the length of the draw and finishes on
the champion cell, which takes the winner's colour rather than the usual accent. At
every step the player's **half of the card is boxed and tinted** — not just the
connectors between cards — so the route is legible at the names themselves rather than
only in the gaps. Since a highlight drawn over a card would sit on top of the name it is
meant to pick out, the routes are indexed by cell and painted between each card's
background and its text. There is no legend: the colours are for tracing a line with
your eye, and each one ends at a card with the name on it.

Four routes rather than eight is what makes the palette work. Blue `#1f7fd0`, green
`#00a878`, orange `#e08a00` and purple `#c05fb4` sit roughly 90° apart, derive from
[Okabe-Ito](https://jfly.uni-koeln.de/color/) so they stay distinguishable under every
common form of colour blindness, and are mid-toned enough to read on the white surface
and the dark one alike. All four also steer clear of the BWF red used by the W badges, so
a route never reads as a badge.

The trace walks *back* from the semi-final card, asking at each column which feeder
produced the side being followed, then walks *forward* again for as long as that player
keeps winning. Neither direction has to guess, so the half it highlights is by
construction the half that holds that player. A sheet filled in only part-way simply
traces fewer routes.

### Selections

The follow list is a working set you can name and keep. **Selections** in the top bar
saves the current list under a name, lists everything you have saved, and loads or
deletes any of them. Loading a selection also restores the discipline it was saved in,
so an all-WD selection lands you on WD rather than wherever you happened to be.

Editing the list by hand (adding, removing, or picking a country) drops the saved name —
the button falls back to showing a plain count — so you always know whether you are
looking at a saved selection or a scratch one. Saving under an existing name overwrites
it.

**Whole country** — the picker has a strip of country chips above the list, each with the
number of entries that country has **across every switched-on discipline**. With all five
on, one click on THA follows all 12 Thai entries — singles, doubles and mixed at once.
Clicking again clears them. It composes with hand-picking, so "all of Japan plus Axelsen"
is quick. It is a bulk action rather than a live filter: the chip fills your selection
once, and you are then free to trim it.

The picker itself spans every switched-on discipline (272 entries with all five on), with
a small MS/WS/MD/WD/XD badge on each row so you can tell which draw an entry belongs to.

Everything lives in `localStorage` on the one browser — there is no account and nothing
is uploaded. A selection is still shareable through the URL hash.

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
| `←` `→` | Previous / next view (Follow Matches → Follow Players → Draw, wrapping) |
| `Shift` | Next discipline. In the Draw view it changes the tree on screen; elsewhere it shows one discipline at a time, cycling MS → WS → MD → WD → XD → all |
| `↑` `↓` | Previous / next followed player (Follow Players → Players only) |
| `+` `−` | Zoom in / out (Draw view; main row **and** numpad) |
| `0` | Reset to 100% (main row and numpad) |
| `F` | Fit the whole draw to the viewport |
| `Esc` | Close the head-to-head or the player picker |

Keys are ignored while typing in the search box and while a dialog is open. Zoom is
matched on `e.code` as well as `e.key`, so `NumpadAdd` / `NumpadSubtract` / `Numpad0` and
the unshifted `=` / `-` / `0` keys all work regardless of keyboard layout.

**Mouse in the Draw view:** the wheel and two-finger trackpad gestures **scroll** the
draw on both axes rather than zooming — a bracket this size is a map, and having to
click-drag everywhere was the annoyance. `shift`+wheel scrolls horizontally for mice with
no second axis. Zooming stays on the buttons, `+`/`−`, and **ctrl+wheel** — which is also
what a trackpad pinch emits, so pinch-to-zoom still works. Wheel deltas are normalised
across `deltaMode` 0/1/2, so line- and page-based mice scroll a sane distance.

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
- ✅ *Done:* a prediction bracket, scored against the real results, exportable as a PNG.

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

> ✅ **Update, 16 Aug 2026:** the order of play is publishing. `day-matches` now returns
> 64 matches for 2026-08-17 across 4 courts (16 each); 18 Aug onward is still `[]`, so
> BWF releases it a day or two ahead rather than all at once. The court grid, times,
> `oopText` and the merge path are all confirmed against this live data.
>
> ⚠️ Superseded — as of **14 Aug 2026** `day-matches` returned `[]` for all WC2026 dates — the order of
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

⚠️ **A doubles ranking only resolves against `player1_id` of the pair.** Asking with the
other half returns `"-"`, not the pair's rank. In mixed doubles BWF stores the man as
`player1`, so every woman showed no ranking at all; in level doubles it hits whichever
player is named second. `app.js` retries with the partner's id and labels the figure
"· pair", since the ranking belongs to the partnership rather than the person.

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
| Road-to-Finals ranking | BWF `rankId=9` | ✅ (drives the Predictions "by race ranking" bracket) |
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
      ├── localStorage                              (followed players, saved
      │                                              selections, predictions, ranks,
      │                                              skin, mode)
      ├── sessionStorage                            (5-minute response cache)
      └── two-lane request queue, ~320 ms apart     (be polite to BWF)
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
- **Requests run in two lanes, not one chain.** Everything the visible view needs (draws,
  player profiles, head-to-heads) goes in the fast lane; bulk background work (ranking
  tables, day schedules, draws for switched-off disciplines) goes in the slow one. A
  single chain meant a ranking index — paginated 15 rows at a time, so dozens of calls per
  discipline — could sit in front of whatever the user had just clicked and leave the
  panel spinning. Ranking indexes are also fetched only for the discipline actually on
  screen, not for all five up front.

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
12. ✅ Predictions: pick every match, winners carry up the draw, scored against real
    results, with ranking-derived brackets and PNG export.
13. ✅ Order of play as a court grid, once BWF publishes it.
14. ✅ Restructured to three views: Follow Matches (star what's worth watching),
    Follow Players (schedule + detail), Draw (results and predictions in one tree).
15. ⬜ Recent form strip (`vue-player-match-previous` is already fetched, not yet shown).
16. ⬜ Calendar (`.ics`) export.
17. ⬜ Elo — not planned; badmintonranks is off the table by choice.

## Tests

```bash
node tests/run.mjs               # everything (~9 min)
node tests/run.mjs unit          # no browser at all (~1 s)
node tests/run.mjs draw          # only the suites touching the Draw view
node tests/run.mjs v9 v11        # named suites
node tests/run.mjs --live draw   # ignore the fixtures, hit the real API
node tests/run.mjs --record v6   # top the fixture set up
```

There is no test framework and no headless browser. BWF's Cloudflare **403s headless
Chrome** — see §3.1 — so every suite launches a real windowed Chrome and drives it over
the DevTools Protocol. That is not a preference; it is the only way to exercise this app
against this API.

**Fixtures.** The app politely spaces its own requests 320 ms apart, so between that and
network latency a suite used to spend ~45 seconds loading before it could assert anything
— about **14 minutes of pure waiting** across a full run, and the answers drifted as the
tournament progressed. `tests/fixtures.mjs` intercepts at CDP's `Fetch` domain and
replays recorded responses from disk:

- **replay** pauses at the *request* stage and fulfils from a file. A request with no
  fixture falls through to the live API and is **reported**, so a gap shows up as a slow
  test rather than a silently wrong answer.
- **record** (`--record`) pauses at the *response* stage, saves the body, and lets the
  request continue.

Interception is at the network layer rather than through a local proxy so the app needs
no test-only code path — what runs is exactly what ships. Recorded responses are **not
committed**: they are a large snapshot of someone else's data and they go stale. Run
`node tests/record.mjs` to rebuild the set (~4 minutes against the live API).

Full run: **~9.5 minutes**, down from ~50.

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
- Predictions driven end-to-end in a real Chrome: a pick marks its side and dims the
  other, the winner appears in the next card, clicking the same side again un-picks it,
  and 63 picks name a champion. The world-ranking walk resolved 210 MS entries and the
  race walk 273 — two genuinely different tables, which named two different champions
  (SHI Yu Qi vs CHOU Tien Chen). *Use as mine* copied all 63 and kept the champion.
  The PNG came out 3424 × 4472 at 2×, ~1 MB, with flags intact — so BWF's image host does
  send `Access-Control-Allow-Origin`. Picks and the chosen draw both survive a reload,
  and a link naming a discipline still overrides the remembered one.
- Dark BWF red is the default with `prefers-color-scheme: light` emulated, and the Mode
  button still flips both ways from there.
- Court grid checked against the live day-one order of play: 4 columns in court order,
  all 64 matches placed, 16 rows, 16 per column, and one card per court on a row. The
  premise is asserted directly — BWF's times really are non-monotonic on two of the four
  courts, `courtSeq` is a clean 0–15 on every court, and only the first match of a court
  carries a real start time. Filtering collapses the rows (8 matches → 6 contiguous rows,
  not 16 sparse ones). Below 900px the grid becomes a block, headers hide, the court name
  returns to the card, and the cards still read top to bottom in running order.
- Card height measured, not eyeballed: **160px → 106px**, with head, both sides and foot
  all still present and no name clipped horizontally (checked over 64 doubles pairs,
  which are the ones at risk in a quarter-width column).
- No 12-hour times survive anywhere in the cards, including BWF's own `oopText`; follow-on
  times are marked ≈ and the first match on a court is not.
- Surnames everywhere, checked in the browser: the picker shows `GICQUEL / DELRUE` and
  still finds it by searching `delphine`; a schedule card shows the pair by surname with
  the full names on hover while a singles card keeps `SHI Yu Qi` and needs no tooltip; the
  head-to-head title and both side headers use surnames and each reveals its full pair.
- `surnameOf()` unit-tested against **all 416 entrants** in the five draws. 400 have
  exactly one all-caps token; the rest are covered explicitly — compound surnames
  (`Kelly VAN BUITEN` → VAN BUITEN, `Nour AHMED YOUSSRI`, `Serena AU YEONG`), initials
  (`M.R. ARJUN` → ARJUN, `PUSARLA V. Sindhu` → PUSARLA), a disambiguator
  (`VU Thi Trang (B)` → VU), and five fully-caps names with no case signal at all
  (`THET HTAR THUZAR`, `CHEN ZHI YI`) which are kept whole rather than guessed at. Every
  entrant yields a surname; average doubles card label drops from 30.8 to 14.7 characters.
- Doubles byes exercised end-to-end on XD: all 16 carry their pair into round two, the
  denominator excludes them (47 matches, not 63), a draw with byes fills to a champion,
  and the cards are undimmed with the empty half reading *Bye*.
- Zoom: a fresh discipline opens at 100%, re-clicking the discipline you are already on
  keeps your zoom, tabbing away and back keeps it, and changing discipline resets it.
- The restructure end-to-end: three views and no orphan sections; Follow Matches opens on
  a day with all 64 cards dimmed and none starred; a click lights exactly one and dims the
  other 63, persists it, and updates both counters; the head-to-head button opens without
  starring; *Starred only* narrows to the starred set; *Clear* empties and disables itself.
  Following eight players lights up nothing in Follow Matches — no names, no rails, no
  stars — while the same selection does highlight in Follow Players. Draw shows one canvas,
  one viewport and one zoom bar, and switching Results → Predictions holds the **exact**
  transform, not just the zoom percentage. `v=schedule` / `v=bracket` / `v=predict` still
  land on the right view *and* sub-view.
- Verdicts checked against **live results** on day one: backing the actual winner of one
  decided match and the loser of another produces exactly one ✓ card and one ✗ card, both
  marks land on the side that was backed, the cross names who really won, and the tally
  reads `1/2 right so far` — not `1/6`, because the other four played matches were never
  predicted.
- Card heights measured for played and unplayed separately, since a finished card also
  carries game scores: a player row is 27px against the old 47px, and a full-width card is
  106px against the old ~160px. No name overflows its column, including single unbroken
  surnames like ONGBAMRUNGPHAN that are wider than a quarter-width column.
- Day selection checked live on a tournament day: both bars open on today, the bar shows
  it selected, a date outside the week is not treated as one, and `todayIso()` resolves
  00:30 CEST on 17 Aug to the 17th where UTC would have said the 16th.
- The schedule → stars bridge: the button offers exactly what is on screen, starring them
  persists and lights precisely those matches in Follow Matches and nothing else, and the
  button then flips to Remove and takes them all back out again.
- Semi-final routes: four routes, four distinct colours, each contiguous with exactly one
  cell per column down to the entry round, and every highlighted half verified to hold
  that player. The forward extension is checked against reality too — both finalists carry
  on to the Final card, the two beaten semi-finalists stop at the semi-final, no route
  runs past where that player actually got, and exactly one is flagged as the champion.
  Checked in both colour modes — the tints read on the white surface as well as the dark.
- Bracket interaction driven with synthetic mouse events: a click opens the head-to-head,
  a drag pans without selecting text or opening the popup, a double-click selects
  nothing, and `F` reproduces the Fit button exactly.
- **Checked against the deployed site, not just localhost.** Loading
  `carefulcamel61097.github.io` in a real Chrome produced 31 BWF API requests, all HTTP
  200, with `Access-Control-Allow-Origin` reflecting the Pages origin exactly — the
  page renders rankings, season strip and full draw with no console errors. This is the
  assumption the whole no-backend design rests on, so it is worth re-checking if the
  page ever goes blank.

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
