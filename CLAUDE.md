# jessestrait.com

A static site served straight from this repo by GitHub Pages. **There is no
build step** — no bundler, no framework, no `package.json`. The HTML and JS in
the repo are the files the browser gets, so edit them directly and keep them
readable.

## Layout

```
index.html        the landing page: a grid of project cards
atx/              ATX Layers — the Austin open-data map (the big one)
atx/3d/           "Austin, from above" — a separate page, 43 MB PMTiles archive
img/              card thumbnails, thumb-<project>.jpg|png, 16:9
tools/            Python builders for the prebuilt data under atx/data/
tools/debug/      audit.py (pre-deploy) and atxdbg.js (in the browser)
workers/capmetro/ the one Cloudflare Worker — a relay for feeds that refuse CORS
.github/workflows/ self-dispatch chains that refresh archived data
NOTES.md          endpoints and findings established by looking, so nobody has
                  to establish them twice. Read it before reverse-engineering
                  any city API.
```

## Adding a page

1. Make `newthing/index.html`. One self-contained page; no build step to wire up.
2. Add the GoatCounter script (below) before `</body>`.
3. Add a card to the grid in root `index.html` — copy an existing `<a class="card">`
   block; it wants a thumbnail at `img/thumb-newthing.jpg` (16:9), a
   `<div class="card-label">`, an `<h2>`, a one-paragraph description, and the
   `<span class="arrow">Open &rarr;</span>`.
4. Run `python3 tools/debug/audit.py` and fix anything it fails on.

## Analytics

Every HTML page on this site must include the GoatCounter tracking script right before `</body>`:

```html
<script data-goatcounter="https://jesserstrait.goatcounter.com/count" async src="//gc.zgo.at/count.js"></script>
```

This applies to any new page added to this repo. All pages across jessestrait.com, training.jessestrait.com, maps.jessestrait.com, archetype-atlas, modal-keyboard, and yt-recs-wordcloud report to this single GoatCounter site (`jesserstrait`), so don't create a different site code without asking first.

## Running it locally

```bash
python3 tools/serve_range.py 8777
```

Then open `http://localhost:8777/atx/`. Use this rather than `python3 -m http.server`:
the stdlib server ignores HTTP Range requests and returns the whole 43 MB PMTiles
archive with a 200, which makes a working archive look broken.

## Deploying

Push to `main`. GitHub Pages publishes in about a minute.

**Caching is the thing that bites.** Pages serves HTML and JS with *independent*
`max-age=600`, so a new page against ten-minute-old JS is a real state a reader
can be in, and it presents as any bug you like. Two defences, both manual:

- **Versioned assets — this is the one that matters.** `atx/sw.js` has *no rule*
  for `atx/city3d.js`, so it goes straight to the network and the browser's own
  HTTP cache is all that stands there. The `?v=<date><letter>` string on its
  `<script src>` is the only way to force a refetch. **Change the file, bump the
  string**, or readers run new HTML against up to ten-minute-old JS.
- **`atx/sw.js`'s `VERSION` constant** (`atx-v13` at the time of writing) is
  narrower than it looks. `activate()` drops every cache whose name does not
  match, so bumping it clears the icons, `manifest.json`, the unpkg Leaflet
  files and the prebuilt geometry. It does **not** gate `atx/index.html`, which
  is fetched network-first with `cache:'reload'` precisely to beat Pages'
  `max-age=600`, and it does not gate `city3d.js`, which it never touches.
  Bump it when a precached asset changes or to force everyone onto a clean
  slate — not as a general deploy ritual. Geometry under `/atx/data/` is served
  cache-then-refresh and lands on the next load by itself.

`tools/debug/audit.py` checks both of these, plus GoatCounter and dead
references, and exits non-zero on a failure. Run it before every push.

## Gotchas

- **Never run `npx wrangler deploy` from the repo root** — it publishes `.git/`,
  the entire history, publicly. The only correct form is:
  ```bash
  cd workers/capmetro && npx wrangler deploy
  ```
- **GitHub Actions `schedule:` does not fire reliably here** — measured on this
  account, a plain `*/15` fired zero times in 97 minutes. The frequent workflows
  keep a `schedule:` only as a backstop, offset off the quarter-hour because
  GitHub's scheduler is congested at :00/:15/:30/:45, and do the real work with a
  self-dispatch chain (a job that re-triggers itself). Copy that pattern for
  anything that has to run on time; `refresh-gtfs.yml` is weekly and gets away
  with a plain schedule.
- **Archived data lives on an orphan `data` branch**, not on `main`.
- **`raw.githubusercontent` serves `max-age=300`** and can hold a version for
  ~5.5 minutes, which caps how fresh any `data`-branch feed can be — and means a
  file you just pushed is not the file you fetch back.
- **Browser-side map work has its own trap list** in `tools/debug/README.md`
  (Leaflet panes, canvas fill cost, PMTiles, iOS viewport units). Read it before
  debugging the map; most of it was expensive to learn.
