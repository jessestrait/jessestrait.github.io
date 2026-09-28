# Debugging this map

Two tools. One runs in a browser on the live page, one runs here before a
deploy.

```bash
python3 tools/debug/audit.py          # static; exits non-zero on a failure
```

```js
// paste tools/debug/atxdbg.js into the console on jessestrait.com/atx/
ATXDBG.all()
```

## Symptom → probe

| What you are told | What to run | What it means |
|---|---|---|
| "the buildings aren't lining up" | `ATXDBG.align()` then `ATXDBG.sweep()` | `screenPx.max` over ~3 px. Standing still proves nothing; every alignment bug so far was zoom-dependent, so run the sweep. |
| "the layer jumps to the corner then snaps" | `ATXDBG.state().canvas` | `zoomAnimated: false` or a `transformOrigin` that is not `0px 0px`. A CSS-scaled canvas pivots about its middle and leaps by centre × (1 − scale). |
| "the buildings are gone" / "zoom breaks it" | `ATXDBG.pm()` | `POISONED` means PMTiles memoised a rejected promise and will never ask the network again. `NETWORK/ARCHIVE` is a different bug with a different fix. |
| "it keeps redrawing / flashing" | `ATXDBG.redraws()` | On an untouched map the answer must be `0`. |
| "it's slow / clunky" | `ATXDBG.drawTime()` | Watch `perEdgeUs`. A jump of two orders of magnitude is a **closed** subpath, not more buildings. |
| "the cars/planes aren't moving" (in the Claude pane) | `ATXDBG.frames()` | rAF never fires in that pane, so nothing per-frame runs there. This is usually not a bug. |
| "the lines look wrong" | `ATXDBG.solo()` | Look at the layer alone before believing this. |
| a new page is live but untracked | `audit.py` | GoatCounter is required on every page. |
| a fix is deployed but the reader still sees the bug | `audit.py` | An asset edited without bumping its `?v=`, or a shell change without an `sw.js` VERSION bump. |

## Traps, each one measured rather than assumed

- **`requestAnimationFrame` never fires in Claude's browser pane.** Any
  per-frame number taken there is worthless. `frames()` drives the loop by
  hand so there is something honest to measure.
- **`performance.now()` around a canvas or GL call times *submission*, not
  work.** `clearRect` and `drawArrays` hand the cost to the compositor.
  `drawTime()` says so in its own output rather than letting the number be
  read as a frame budget. For real GPU timing you need `gl.finish()`.
- **Canvas `fill()` is quadratic in *closed* subpaths** — 500 → 2.7 ms,
  8,000 → 595 ms, 24,000 → 5.5 s — while 96,000 vertices in *one* subpath
  is 10.6 ms and open stroked subpaths are linear (50,000 → 7.5 ms). The
  outline layer is fast because it strokes open subpaths. Keep it that way.
- **PMTiles memoises the promise for its header, including a rejected
  one.** One failed range request poisons the instance for the whole
  session with *zero* further network traffic. The fix is to throw the
  instance away, not to stop caching the error.
- **Every polygon ring in the archive is closed** (the last point repeats
  the first). Harmless to a stroke, fatal to ear clipping, and it skews any
  bounds you compute.
- **Do not judge thin linework from a screenshot of the browser pane.** An
  1800×1200 canvas downscaled to 800×450 turns a clean 0.8 px stroke into
  streaks, and Austin's street grid is rotated, so the basemap supplies
  convincing diagonals of its own. Use `solo()`.
- **Leaflet is orthographic.** There is no camera, so any screen-relative
  extrusion lean makes buildings slide on pan and jump on zoom. This is why
  `CITY3D.wireLean` defaults to `0`: with no lean there is nothing that can
  drift.
- **GitHub Pages serves HTML and JS with independent `max-age=600`.** A new
  page against old JS for ten minutes presents as any bug you like.
- **`raw.githubusercontent` serves `max-age=300`** and can hold a version
  for ~5.5 minutes, which caps how fresh any `data`-branch feed can be.
- **Never `npx wrangler deploy` from the repo root** — it publishes `.git/`.
  `cd workers/capmetro && npx wrangler deploy`.
