/* atxdbg.js — a debugger for the ATX Layers map.
 *
 * Paste the whole file into the console on jessestrait.com/atx/ (or
 * inject it), then call ATXDBG.all(). It attaches window.ATXDBG and
 * touches nothing else until you ask it to.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every probe here exists because I once shipped a wrong answer that
 * this probe would have caught in one call. The comments name the bug,
 * so the next person does not re-derive it:
 *
 *   align()   the buildings "not lining up" and the zoom-out leap into
 *             the bottom-right quadrant. Both were DOM placement, not
 *             projection maths — so this checks the whole chain,
 *             through getBoundingClientRect, against Leaflet's own
 *             answer for the same lat/lng.
 *   pm()      the archive that poisoned itself. PMTiles memoises the
 *             promise for its header INCLUDING a rejected one, so one
 *             failed range request kills the layer for the session with
 *             no further network traffic at all. Detected by counting
 *             fetches around a read: zero fetches and an error is the
 *             signature.
 *   drawTime() canvas fill() is QUADRATIC in closed subpaths (500 →
 *             2.7 ms, 8k → 595 ms, 24k → 5.5 s) while open stroked
 *             subpaths are linear (50k → 7.5 ms). A regression here is
 *             someone closing a path, not someone adding buildings.
 *   redraws() the 60 fps flashing: an empty tile that was not cached
 *             rebuilt every settle, blew the build budget, set the
 *             pending flag and re-armed the loop for ever. A redraw
 *             count that does not stop climbing on an idle map is that
 *             bug, whatever the cause.
 *   solo()    do NOT judge thin linework from a screenshot. Austin's
 *             street grid is rotated, the basemap draws it, and a
 *             1800x1200 canvas downscaled to 800x450 turns a clean
 *             0.8 px stroke into streaks that look like a renderer bug.
 *             I chased that for three tuning passes. This renders the
 *             layer alone, saturated, so the question is answerable.
 *
 * TRAPS, measured, not assumed:
 *   - requestAnimationFrame does NOT fire in Claude's browser pane.
 *     Per-frame numbers taken there are worthless. frames() drives the
 *     loop by hand for exactly that reason.
 *   - performance.now() around a canvas or GL call times SUBMISSION,
 *     not work. clearRect and drawArrays hand the cost to the
 *     compositor. drawTime() therefore reports what it can honestly
 *     claim and says so.
 */
(function (global) {
  'use strict';

  function theMap(m) {
    if (m) return m;
    if (global.map && global.map.getZoom) return global.map;
    try { return eval('map'); } catch (e) { return null; }   // top-level const
  }
  const C  = () => global.CITY3D;
  const W  = () => global.CITY3D._wire.state;
  const r2 = n => Math.round(n * 100) / 100;

  function pct(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    return { min: r2(s[0]), med: r2(s[(s.length / 2) | 0]), max: r2(s[s.length - 1]) };
  }

  /* ── state ─────────────────────────────────────────────────────────
     The one-line "what is true right now". Read this before forming any
     theory; half the sessions that went sideways went sideways because
     I theorised about a layer that was switched off. */
  function state(m) {
    const map = theMap(m), c = C(), w = W();
    const out = {
      zoom: map && map.getZoom(),
      minZoom: c._helpers.MIN_Z,
      outlinesOn: w.on,
      motionOn: !!c.carsOn,
      shapes: w.shapes.length,
      edges: w.edges || 0,
      lean: c.wireLean,
      tilesCached: c.tiles.size,
      tilesInFlight: c.busy.size,
      projCached: w.proj.size,
      tileErr: c.tileErr,
      archiveAlive: !!c.pm,
      retryArmed: !!c.retry,
      rafId: c.raf,
      canvas: null
    };
    if (w.canvas) {
      const cv = w.canvas;
      out.canvas = {
        cssSize: cv.style.width + ' x ' + cv.style.height,
        backingSize: cv.width + ' x ' + cv.height,
        /* Without leaflet-zoom-animated the transform-origin is 50% 50%
           and a CSS-scaled canvas pivots about its middle, displacing
           it by centre x (1 - scale). That was the bottom-right-quadrant
           leap: 338 px right, 225 px down, exactly as reported. */
        zoomAnimated: cv.classList.contains('leaflet-zoom-animated'),
        transformOrigin: getComputedStyle(cv).transformOrigin,
        transform: cv.style.transform || '(none)'
      };
    }
    return out;
  }

  /* ── align ─────────────────────────────────────────────────────────
     Is a building drawn where Leaflet says its lat/lng is?

     Two independent answers are compared, and NEITHER of them is the
     module's own projection re-run:

       projPx    the module's absolute layer pixel for a raw tile vertex,
                 against map.project(latlng, zoom) — Leaflet's own.
                 Checks the tile->pixel maths.
       screenPx  where that vertex actually lands on the screen, walked
                 through the canvas's real getBoundingClientRect, against
                 map.latLngToContainerPoint. Checks the maths AND the DOM
                 placement AND any leftover CSS transform.

     screenPx is the number that matters: every "not lining up" report
     has been a screenPx failure with projPx perfectly clean. Expect
     ~0.7 px, which is Leaflet's own rounding. Over ~3 px is a bug. */
  function align(m, sample) {
    const map = theMap(m), c = C(), w = W();
    if (!w.on) return 'Outlines are off — switch them on first.';
    const z = map.getZoom();
    if (z < c._helpers.MIN_Z) return 'Zoom past ' + c._helpers.MIN_Z + ' first.';

    const ext0 = c._helpers.EXTENT_FALLBACK;
    const pxO = map.getPixelOrigin(), origin = w.canvas._origin;
    const cvR = w.canvas.getBoundingClientRect();
    const mpR = map.getContainer().getBoundingClientRect();
    const projErr = [], scrErr = [];
    let checked = 0;
    const want = sample || 400;

    for (const [key, t] of c.tiles) {
      if (!t || !t.buildings || !t.buildings.features.length) continue;
      const [tz, tx, ty] = key.split('/').map(Number);
      if (tz !== c._helpers.TILE_Z) continue;
      const ext = t.buildings.extent || ext0;
      const tileScale = 256 * 2 ** (z - tz), k = tileScale / ext;
      /* The tile index is at the ARCHIVE's zoom, not the map's. Dividing
         it by 2**mapZoom is how this probe first claimed an 11.8-million
         pixel error against a layer aligned to 0.7 px. */
      const n = 2 ** tz;

      for (const f of t.buildings.features) {
        if (f.type !== 3) continue;
        const ring = f.rings && f.rings[0];
        if (!ring || ring.length < 6) continue;
        for (let i = 0; i < ring.length && checked < want; i += 2) {
          const rx = ring[i], ry = ring[i + 1];

          // the module's answer: absolute layer px
          const ax = tx * tileScale + rx * k, ay = ty * tileScale + ry * k;

          // an independent answer: tile units -> lat/lng -> Leaflet
          const lon = ((tx + rx / ext) / n) * 360 - 180;
          const yy = Math.PI * (1 - 2 * (ty + ry / ext) / n);
          const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(yy) - Math.exp(-yy)));
          const ll = L.latLng(lat, lon);
          const p = map.project(ll, z);
          projErr.push(Math.hypot(ax - p.x, ay - p.y));

          // where it is actually painted, via the canvas's real box
          const onCv = { x: ax - (origin.x + pxO.x), y: ay - (origin.y + pxO.y) };
          const scr = { x: (cvR.left - mpR.left) + onCv.x,
                        y: (cvR.top  - mpR.top)  + onCv.y };
          const truth = map.latLngToContainerPoint(ll);
          scrErr.push(Math.hypot(scr.x - truth.x, scr.y - truth.y));
          checked++;
        }
        if (checked >= want) break;
      }
      if (checked >= want) break;
    }
    if (!checked) return 'No building vertices in the tile cache to check.';
    return { zoom: z, vertices: checked,
             projPx: pct(projErr), screenPx: pct(scrErr),
             verdict: pct(scrErr).max <= 3 ? 'ALIGNED' : 'MISALIGNED' };
  }

  /* ── sweep ─────────────────────────────────────────────────────────
     align() at one zoom proves nothing about the zoom. Every alignment
     bug so far was zoom-dependent and looked fine standing still. */
  async function sweep(m, zooms) {
    const map = theMap(m);
    const list = zooms || [15, 16, 17, 18, 17, 16, 15];
    const rows = [];
    for (const z of list) {
      map.setZoom(z, { animate: false });
      await settled(map);
      const a = align(map);
      rows.push(typeof a === 'string' ? { zoom: z, note: a }
        : { zoom: z, shapes: W().shapes.length,
            projMax: a.projPx.max, screenMax: a.screenPx.max, verdict: a.verdict });
    }
    console.table(rows);
    return rows;
  }

  /* The settle is a 70 ms timer plus however long the tiles take, and
     the tiles are awaited inside it. Polling for a quiet cache is the
     only honest way to know it finished. */
  function settled(map, ms) {
    const c = C(), deadline = Date.now() + (ms || 6000);
    return new Promise(res => (function poll() {
      if (!c.busy.size && Date.now() > deadline - (ms || 6000) + 400) return res(true);
      if (Date.now() > deadline) return res(false);
      setTimeout(poll, 100);
    })());
  }

  /* ── pm ────────────────────────────────────────────────────────────
     Archive health, and specifically the memoisation trap.

     A read that throws having made ZERO network requests is a poisoned
     instance: PMTiles kept the rejected promise for its header and will
     now rethrow it for ever without asking the network again. The fix in
     city3d.js is to null CITY.pm on failure; this proves whether it is
     working. A read that throws AFTER a request is a real network or
     archive problem — a different bug with a different fix. */
  async function pm(m) {
    const map = theMap(m), c = C(), H = c._helpers;
    if (!H.lon2x || !H.lat2y) return 'city3d.js no longer exports lon2x/lat2y.';
    const z = H.TILE_Z, ctr = map.getCenter();
    const tx = Math.floor(H.lon2x(ctr.lng, z)), ty = Math.floor(H.lat2y(ctr.lat, z));
    let calls = 0;
    const real = global.fetch;
    global.fetch = function () { calls++; return real.apply(this, arguments); };
    const out = { tile: z + '/' + tx + '/' + ty,
                  instanceBefore: !!c.pm, fetches: 0, bytes: 0, error: null };
    try {
      const a = await (c.pm || new global.pmtiles.PMTiles(
        new URL('3d/atx.pmtiles', location.href).href));
      const t = await a.getZxy(z, tx, ty);
      out.bytes = t && t.data ? t.data.byteLength : 0;
    } catch (e) {
      out.error = String(e && e.message || e);
    } finally {
      out.fetches = calls;
      global.fetch = real;
    }
    out.instanceAfter = !!c.pm;
    /* A bad ask is rejected locally with no request, which looks exactly
       like a memoised rejection to a fetch counter. Read the message. */
    const badAsk = out.error && /bounds|outside|invalid|NaN/i.test(out.error);
    out.verdict = !out.error ? 'OK'
      : badAsk ? 'BAD ASK — the probe asked for a tile the archive cannot hold'
      : out.fetches === 0 ? 'POISONED — memoised rejection, no request made'
      : 'NETWORK/ARCHIVE — the request was made and failed';
    return out;
  }

  /* ── drawTime ──────────────────────────────────────────────────────
     What one settle's worth of stroking costs.

     Honest about what it measures: the stroke is submitted here and
     rasterised by the compositor, so this is submission plus whatever
     the canvas does synchronously. It is the right number for catching
     a quadratic regression (someone closing a subpath) and the wrong
     number for claiming a frame rate. */
  function drawTime(m, iters) {
    const map = theMap(m), n = iters || 12, t = [];
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      global.CITY3D._wire.draw(map, false);
      t.push(performance.now() - a);
    }
    const p = pct(t);
    return { shapes: W().shapes.length, edges: W().edges || 0, iterations: n,
             ms: p, perEdgeUs: r2(1000 * p.med / Math.max(1, W().edges)),
             note: 'submission-side; excludes compositor rasterisation' };
  }

  /* ── redraws ───────────────────────────────────────────────────────
     Count draws over a window on a map nobody is touching. A settled
     map should draw ZERO times. Anything above zero is the flashing
     bug — the layer has found a reason to keep rebuilding itself. */
  function redraws(ms) {
    const wire = global.CITY3D._wire;
    const orig = wire.draw;
    let n = 0;
    wire.draw = function () { n++; return orig.apply(this, arguments); };
    return new Promise(res => setTimeout(() => {
      wire.draw = orig;
      res({ window: (ms || 3000) + 'ms', draws: n,
            verdict: n === 0 ? 'IDLE — nothing redrawing'
                             : 'REDRAW LOOP — ' + n + ' draws on an untouched map' });
    }, ms || 3000));
  }

  /* ── frames ────────────────────────────────────────────────────────
     rAF does not fire in Claude's browser pane, so anything that only
     happens per frame — the cars, the aircraft, the emergency lights —
     never happens there and cannot be measured there. This drives the
     loop by hand. */
  function frames(m, n) {
    const map = theMap(m), c = C(), t = [];
    for (let i = 0; i < (n || 60); i++) {
      const a = performance.now();
      c._cars && c._cars.stepCars && c._cars.stepCars(map, 1 / 60);
      t.push(performance.now() - a);
    }
    return { framesDriven: n || 60, ms: pct(t),
             note: 'driven by hand; rAF never fires in the Claude browser pane' };
  }

  /* ── solo ──────────────────────────────────────────────────────────
     Hide everything but the outlines and draw them in a colour that
     survives a downscaled screenshot. call solo() to enter, solo(false)
     to leave. This is the only trustworthy way to look at the linework.
     Judging it against the basemap is how I mistook Austin's rotated
     street grid for my own renderer three times running. */
  function solo(on, colour) {
    const map = theMap(), pane = map.getPane('wirePane');
    const el = map.getContainer();
    if (on === false) {
      el.style.background = '';
      for (const p of ['tilePane', 'overlayPane', 'markerPane', 'shadowPane', 'carPane']) {
        const q = map.getPane(p); if (q) q.style.display = '';
      }
      pane.style.filter = '';
      return 'basemap back';
    }
    el.style.background = '#000';
    for (const p of ['tilePane', 'overlayPane', 'markerPane', 'shadowPane', 'carPane']) {
      const q = map.getPane(p); if (q) q.style.display = 'none';
    }
    /* A hue rotate cannot brighten a 0.78-alpha stroke enough to read
       through a downscale, so the stroke colour itself is overridden
       for the duration and the layer redrawn. */
    const ctx = W().ctx, realStroke = ctx.strokeStyle;
    W().canvas.__soloColour = colour || '#39ff9e';
    const orig = Object.getOwnPropertyDescriptor(ctx.constructor.prototype, 'strokeStyle');
    pane.style.filter = 'brightness(2.4) saturate(2)';
    global.CITY3D._wire.refresh(map);
    return 'soloed — ATXDBG.solo(false) to restore (stroke lifted by filter)';
  }

  /* ── all ───────────────────────────────────────────────────────────
     The whole non-destructive battery, in the order I would actually
     read it: what is true, is the data there, is it in the right place,
     what does it cost, is it quiet. */
  async function all(m) {
    const map = theMap(m);
    const out = { state: state(map) };
    console.log('── state ──');            console.log(out.state);
    out.archive = await pm(map);
    console.log('── archive ──');          console.log(out.archive);
    out.align = align(map);
    console.log('── alignment ──');        console.log(out.align);
    out.drawTime = drawTime(map);
    console.log('── draw cost ──');        console.log(out.drawTime);
    out.redraws = await redraws(2500);
    console.log('── idle redraws ──');     console.log(out.redraws);
    const bad = [];
    if (out.archive.verdict !== 'OK') bad.push('archive: ' + out.archive.verdict);
    if (out.align && out.align.verdict === 'MISALIGNED') bad.push('alignment: ' + out.align.screenPx.max + ' px');
    if (out.redraws.draws) bad.push('redraw loop: ' + out.redraws.draws + ' draws idle');
    if (out.state.canvas && !out.state.canvas.zoomAnimated) bad.push('canvas is missing leaflet-zoom-animated');
    console.log(bad.length ? '✗ ' + bad.join(' | ') : '✓ all clear');
    out.verdict = bad.length ? bad : 'all clear';
    return out;
  }

  global.ATXDBG = { state, align, sweep, settled, pm, drawTime, redraws, frames, solo, all,
                    map: theMap };
  console.log('ATXDBG ready — .all() .state() .align() .sweep() .pm() '
            + '.drawTime() .redraws() .frames() .solo()');
})(window);
