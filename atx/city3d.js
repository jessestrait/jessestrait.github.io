/* Things that are actually moving over Austin.
 *
 * This file used to raise the city's buildings — footprints extruded on
 * the GPU, lit windows, sun-angle shadows. That is gone as of
 * 2026-09-26; it never sat convincingly on an orthographic basemap, the
 * lean shifted with the view so buildings slid against the roads on
 * every pan, and it was more trouble than it was worth. The whole
 * renderer is in the history if it is ever wanted back.
 *
 * What is left is the part that was never in doubt, and all of it is
 * real objects in real places:
 *
 *   - rivers and creeks drifting at the speed USGS gauges say they run
 *   - red and blue over the blocks AFD is working right now
 *   - aircraft from ADS-B, flown forward from their last fix
 *
 * plus the traffic model, which draws nothing of its own any more but
 * still turns TomTom's corridor readings and live incidents into the
 * congestion figure this layer reports.
 *
 * Geometry — the road and river lines everything is placed along —
 * comes from the same PMTiles archive the tilted view at /atx/3d/ uses:
 * one 43 MB file of the whole metro, read over HTTP range requests, so
 * only the handful of tiles under the viewport are ever fetched.
 *
 * It adds one pane below the marks and takes nothing away: every other
 * layer, popup, control and readout behaves exactly as it did.
 */
(function (global) {
  'use strict';

  /* ── A small Mapbox Vector Tile reader ──────────────────────────────
     Only what is needed: layer names, feature ids, a couple of numeric
     and string properties, and polygon or line geometry. The official
     decoder is ESM-only now and this page is a classic script; writing
     the ~90 lines is cheaper than a module shim and has no CDN to fail. */

  function Reader(buf) { this.b = buf; this.p = 0; this.end = buf.length; }
  Reader.prototype.varint = function () {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
    return r >>> 0;
  };
  Reader.prototype.svarint = function () { const n = this.varint(); return (n >> 1) ^ -(n & 1); };
  Reader.prototype.skip = function (wire) {
    if (wire === 0) this.varint();
    else if (wire === 2) this.p += this.varint();
    else if (wire === 5) this.p += 4;
    else if (wire === 1) this.p += 8;
    else throw new Error('bad wire ' + wire);
  };
  Reader.prototype.msg = function () { const n = this.varint(); const r = new Reader(this.b);
    r.p = this.p; r.end = this.p + n; this.p += n; return r; };
  Reader.prototype.str = function () { const n = this.varint();
    const s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n)); this.p += n; return s; };
  Reader.prototype.dbl = function () { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 8)
      .getFloat64(0, true); this.p += 8; return v; };
  Reader.prototype.flt = function () { const v = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4)
      .getFloat32(0, true); this.p += 4; return v; };

  function readValue(r) {
    let v = null;
    while (r.p < r.end) {
      const k = r.varint(), f = k >> 3, w = k & 7;
      if (f === 1 && w === 2) v = r.str();
      else if (f === 2 && w === 5) v = r.flt();
      else if (f === 3 && w === 1) v = r.dbl();
      else if ((f === 4 || f === 5) && w === 0) v = r.varint();
      else if (f === 6 && w === 0) v = r.svarint();
      else if (f === 7 && w === 0) v = !!r.varint();
      else r.skip(w);
    }
    return v;
  }

  /* Returns { extent, features:[{id, props, type, rings:[[x,y,...]]}] } in
     tile-local units. Geometry is kept as flat arrays because a tile can
     hold a couple of thousand rings and objects per point would cost more
     than the drawing does. */
  function decodeLayer(buf, wanted) {
    const r = new Reader(buf);
    let out = null;
    while (r.p < r.end) {
      const k = r.varint(), f = k >> 3, w = k & 7;
      if (f === 3 && w === 2) {
        const lr = r.msg();
        const keys = [], vals = [], feats = [];
        let name = null, extent = 4096;
        const featureBodies = [];
        while (lr.p < lr.end) {
          const kk = lr.varint(), ff = kk >> 3, ww = kk & 7;
          if (ff === 1 && ww === 2) name = lr.str();
          else if (ff === 2 && ww === 2) featureBodies.push(lr.msg());
          else if (ff === 3 && ww === 2) keys.push(lr.str());
          else if (ff === 4 && ww === 2) vals.push(readValue(lr.msg()));
          else if (ff === 5 && ww === 0) extent = lr.varint();
          else lr.skip(ww);
        }
        if (name !== wanted) continue;
        for (const fr of featureBodies) {
          let id = null, tags = null, type = 0, geom = null;
          while (fr.p < fr.end) {
            const kk = fr.varint(), ff = kk >> 3, ww = kk & 7;
            if (ff === 1 && ww === 0) id = fr.varint();
            else if (ff === 2 && ww === 2) { const g = fr.msg(); tags = [];
              while (g.p < g.end) tags.push(g.varint()); }
            else if (ff === 3 && ww === 0) type = fr.varint();
            else if (ff === 4 && ww === 2) { const g = fr.msg(); geom = [];
              while (g.p < g.end) geom.push(g.varint()); }
            else fr.skip(ww);
          }
          const props = {};
          if (tags) for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = vals[tags[i + 1]];
          feats.push({ id: id, props: props, type: type, rings: geometry(geom) });
        }
        out = { extent: extent, features: feats };
      } else r.skip(w);
    }
    return out;
  }

  // MVT geometry commands: 1 MoveTo, 2 LineTo, 7 ClosePath.
  function geometry(g) {
    const rings = [];
    if (!g) return rings;
    let i = 0, x = 0, y = 0, cur = null;
    while (i < g.length) {
      const cmd = g[i] & 7, count = g[i] >> 3; i++;
      if (cmd === 1) {
        for (let n = 0; n < count; n++) {
          x += (g[i] >> 1) ^ -(g[i] & 1); i++;
          y += (g[i] >> 1) ^ -(g[i] & 1); i++;
          cur = [x, y]; rings.push(cur);
        }
      } else if (cmd === 2) {
        for (let n = 0; n < count; n++) {
          x += (g[i] >> 1) ^ -(g[i] & 1); i++;
          y += (g[i] >> 1) ^ -(g[i] & 1); i++;
          cur.push(x, y);
        }
      } else if (cmd === 7) {
        if (cur && cur.length > 2) cur.push(cur[0], cur[1]);
      }
    }
    return rings;
  }

  global.MVT = { decodeLayer: decodeLayer };
})(window);

/* ── The city layer ─────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  const ARCHIVE = '/atx/3d/austin.pmtiles';
  // Buildings are only individually mapped at z15 in this archive; below
  // that it holds merged blocks, which extrude into mush. So the layer
  // simply does not draw until the map is deep enough to mean it.
  /* Which build this is, shown in the layer's own readout.

     Two rounds of "it looks broken" turned out to be a stale script:
     the page and city3d.js are cached independently, so a reader can
     hold a ten-minute-old renderer while the HTML is current. Rather
     than ask anyone to trust that a deploy landed, the layer says what
     it is running. If this does not match the newest deploy, the
     answer is a cache and not the code. */
  const BUILD = 'w3';

  const MIN_Z = 15;
  const TILE_Z = 15;
  const EXTENT_FALLBACK = 4096;

  const CITY = {
    pm: null, tiles: new Map(), busy: new Set(), roadCache: new Map(),
    roadTotal: 0, holdSum: 0, jamLift: 1, traffic: null,
    carsOn: true, tileErr: null,
    here: null,
    alarms: [], t0: performance.now(), air: null,
    roads: null, raf: null, last: 0,
    carCanvas: null, carCtx: null,
    note: ''
  };

  const lon2x = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
  const lat2y = (lat, z) => {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  };

  async function archive() {
    if (CITY.pm) return CITY.pm;
    if (!global.pmtiles) throw new Error('pmtiles library missing');
    CITY.pm = new global.pmtiles.PMTiles(new URL(ARCHIVE, location.origin).href);
    return CITY.pm;
  }

  async function tile(z, x, y) {
    const key = z + '/' + x + '/' + y;
    if (CITY.tiles.has(key)) return CITY.tiles.get(key);
    if (CITY.busy.has(key)) return null;
    CITY.busy.add(key);
    try {
      const a = await archive();
      const r = await a.getZxy(z, x, y);
      let parsed = { roads: null, buildings: null };
      if (r && r.data) {
        let buf = new Uint8Array(r.data);
        // Tiles in this archive are gzipped; the browser will not do it
        // for us here because we fetched bytes, not a response.
        if (buf[0] === 0x1f && buf[1] === 0x8b) {
          buf = new Uint8Array(await new Response(
            new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
          ).arrayBuffer());
        }
        parsed = {
          roads: global.MVT.decodeLayer(buf, 'roads'),
          buildings: global.MVT.decodeLayer(buf, 'buildings')
        };
      }
      CITY.tiles.set(key, parsed);
      CITY.tileErr = null;
    } catch (e) {
      /* Do NOT cache a failure.

         This used to write an empty tile into the cache, which turned
         one bad fetch into a permanently blank layer: the entry looked
         like a tile with no buildings in it, so nothing ever asked
         again. Seen live — a transient range-request failure during
         service-worker activation left sixteen tiles cached as empty
         and the skyline gone for the rest of the session, while the
         very same request from the console came back 206 immediately.

         A tile that genuinely holds nothing is still cached: that is
         the `r && r.data` path above, where the archive answered and
         had nothing to give. This is only for when the ask itself
         failed. */
      CITY.tileErr = String((e && e.message) || e);
      /* Throw the archive away, do not just record the error.

         PMTiles memoises the promise for its header and directory —
         including a REJECTED one. So a single failure, which on this
         page happens when a range request races the service worker at
         load, poisons the instance permanently: every later read
         rethrows the same error with no network request at all.
         Proved by intercepting fetch during a failing getZxy and
         seeing zero requests, then building a fresh instance against
         the same URL and getting 114,703 bytes back immediately.

         That is why the buildings were sometimes simply absent, and
         why the symptom looked like a dead CDN when the CDN was fine.
         A new instance costs one header read. */
      CITY.pm = null;
      return null;
    } finally { CITY.busy.delete(key); }
  }

  /* A height for a building OSM has not measured.
     Deterministic from the feature id, so the same building is the same
     height on every visit and between reloads — a skyline that reshuffled
     when you panned would be worse than a flat one. Two to five storeys,
     which is what central Austin mostly is. */
  function guessHeight(id) {
    const h = ((id * 2654435761) >>> 0) % 1000 / 1000;
    return 6 + h * h * 16;        // biased low: most buildings are small
  }

  function visibleTiles(map) {
    const b = map.getBounds(), n = Math.pow(2, TILE_Z);
    const x0 = Math.floor(lon2x(b.getWest(), TILE_Z));
    const x1 = Math.floor(lon2x(b.getEast(), TILE_Z));
    const y0 = Math.floor(lat2y(b.getNorth(), TILE_Z));
    const y1 = Math.floor(lat2y(b.getSouth(), TILE_Z));
    const out = [];
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        if (x >= 0 && y >= 0 && x < n && y < n) out.push([TILE_Z, x, y]);
    // Past about forty tiles the view is too wide for this to be legible
    // anyway, and fetching them all would be rude to nobody's benefit.
    return out.slice(0, 40);
  }

  global.CITY3D = CITY;
  global.CITY3D.BUILD = BUILD;
  global.CITY3D._helpers = { lon2x, lat2y, tile, visibleTiles, guessHeight, TILE_Z, MIN_Z,
                             EXTENT_FALLBACK };
})(window);

/* ── Drawing ────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers;

  function ensurePanes(map) {
    if (C.carCanvas) return;
    // Below every mark, above the basemap. The city is scenery; the data
    // it sits under is the point of the page and must never be occluded.
    if (!map.getPane('carPane')) { map.createPane('carPane').style.zIndex = 268; }
    /* `leaflet-zoom-animated` is not decoration.

       During a zoom, Leaflet scales this canvas with a CSS transform
       rather than redrawing it, and the offset it computes assumes the
       element scales about its TOP-LEFT corner. That is what the class
       carries: `transform-origin: 0 0`, from Leaflet's own stylesheet,
       which its own canvas layers get in onAdd.

       A bare canvas defaults to `transform-origin: 50% 50%`, so it
       scaled about its middle instead — and on a zoom out the city
       shrank away into one quadrant for the length of the animation,
       then snapped back when the real redraw landed. The origin is
       also set inline, so this still holds if the stylesheet is ever
       served from somewhere that fails. */
    const mk = pane => {
      const cv = document.createElement('canvas');
      cv.className = 'leaflet-zoom-animated';
      cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;'
                       + 'transform-origin:0 0;-webkit-transform-origin:0 0';
      map.getPane(pane).appendChild(cv);
      return cv;
    };
    C.carCanvas = mk('carPane'); C.carCtx = C.carCanvas.getContext('2d');
  }

  /* Sized to the viewport plus a margin and positioned in *layer*
     coordinates, which is exactly what L.Canvas does and for the same
     reason: layer coordinates do not change as you pan, so Leaflet's own
     translation of the map pane carries the canvas along for free and
     nothing has to be redrawn until you let go. The margin is what keeps
     the edges from being blank while you drag into them. */
  const PAD = 0.25;

  /* The car canvas is cleared and repainted sixty times a second, so
     every pixel in it is paid for continuously rather than once per
     settle. Giving it the buildings' 25% margin made it 2.25 times
     larger than the window for no benefit at all — a car that leaves
     the screen is recycled, so nothing is ever drawn in the margin. */
  function sizeCanvas(map, cv, pad) {
    const s = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const f = pad == null ? PAD : pad;
    const padPx = L.point(s.x * f, s.y * f).round();
    const w = s.x + padPx.x * 2, h = s.y + padPx.y * 2;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
      C.carWipe = true;
    }
    const origin = map.containerPointToLayerPoint(padPx.multiplyBy(-1));
    /* Only touch the DOM when the answer changed.

       This runs sixty times a second for the car canvas, and
       setPosition writes a CSS transform every time — a style write
       the compositor has to look at, to move the element to where it
       already was. On a pan the origin genuinely changes; the rest of
       the time it does not. */
    if (!cv._origin || cv._origin.x !== origin.x || cv._origin.y !== origin.y) {
      L.DomUtil.setPosition(cv, origin);
      cv._origin = origin;
    }
    cv._pad = padPx;
    return dpr;
  }

  /* Gather the footprints in view, projected to screen pixels, with a
     height in metres. Done once per settle rather than per frame: the
     buildings do not move. */
  /* Projected geometry, cached per tile per zoom.
     Layer coordinates depend only on the zoom, so a tile projected once at
     z16 is still correct at z16 an hour later however far you have panned.
     Returning to a zoom you have already seen therefore costs nothing but
     a cull. */
  /* The buildings were removed on 2026-09-26.

     Everything that drew them lived here: the tile projection, the
     footprint collection, the 2.5D extrusion, the sun and shadows,
     the lit windows, and the WebGL renderer above. It is all in the
     history if it is ever wanted back — the last build with it is
     tagged in the commit that took it out.

     What remains of this module is the two things the motion layer
     needs: a pane to draw into and a canvas kept the right size. */

  global.CITY3D._draw = { ensurePanes, sizeCanvas };
})(window);

/* ── Invented traffic ───────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers, D = C._draw;

  /* How busy a road is, before any live data.

     Road class is the only volume proxy in the tiles, and it is a good
     one: a motorway carries orders of magnitude more traffic than a
     residential street, and OSM's classification is exactly that
     judgement. Free-flow speeds are the posted-ish speeds for each class
     in metres per second. */
  /* Road classes, kept for what they still answer: how fast a road of
     this kind runs when it is clear, which is what turns TomTom's
     percentage into a speed and feeds the congestion readout.

     The drawn vehicles are gone — see the layer entry in index.html —
     so `lanes` now only weights how much a road contributes to that
     reading, which is right: a six-lane freeway crawling matters more
     to "how is traffic here" than a crawling cul-de-sac. */
  const CLASS = {
    highway:      { lanes: 3, free: 31 },   // ~70 mph
    major_road:   { lanes: 2, free: 18 },   // ~40 mph
    medium_road:  { lanes: 1, free: 13 },   // ~30 mph
    minor_road:   { lanes: 1, free: 9 }
  };

  /* 7.5 m is a vehicle plus the gap left when stopped, and two seconds
     is the headway people keep when moving. Together they say how many
     vehicles a stretch of road is holding at the speed it is running —
     which is the honest way to weight a congestion average, because a
     jammed road holds four times the traffic it does when clear and
     should count for four times as much. */
  const JAM_M = 7.5;
  const HEADWAY_S = 2.0;

  /* ── The traffic model ──────────────────────────────────────────────

     Four things decide how many cars are on a street and how fast they
     are moving, in order of how much they matter:

       1. the hour of the week          — measured, see CONGEST_WD
       2. the class of the road         — from the tiles
       3. the live corridor probes      — nine of them, TomTom, freeway only
       4. live incidents                — citywide, TomTom, with geometry

     The first is by far the biggest effect and the one the old code
     ignored completely: it asked the nearest of nine freeway probes and
     applied that answer to every residential street in Austin. At two in
     the morning a side street in Hyde Park was told it was moving at
     I-35's speed, and the same number of cars was drawn on it as at six
     in the evening. */

  const TRAFFIC_URL = 'https://raw.githubusercontent.com/jessestrait/'
                    + 'jessestrait.github.io/data/traffic/';

  /* Congestion by local hour, weekdays: 0 is free-flow, 1 is the worst
     the city gets.

     Measured. The archive on the data branch holds every TomTom jam
     episode this repo has recorded — 2,161 of them across three
     weekdays — and this is when they started, corrected for the fact
     that the collector polls every five minutes during rush hour and
     every forty-five otherwise, so off-peak jams are under-detected.
     The raw shape:

       07 ████      17 ██████████████████████
       08 ███       18 ███████████
       09 ██        19 ▌
       ...02-06 essentially nothing

     Austin's evening peak is far heavier than its morning one, which is
     what the data says and what anyone who drives I-35 already knows.
     Three weekdays is a thin sample, so the measured curve is blended
     55/45 with a smooth commute prior; that fills holes like 15:00,
     where the chain simply missed a poll, without flattening the peaks.

     That was the whole basis for these curves until 2026-10-08; see the
     note directly below for what replaced the daytime hours and why. */
  /* Revised 2026-10-08 against the city's own Bluetooth travel-time
     archive (Socrata v7zg-5jg9): 61.8 million 15-minute records, 2013 to
     2021, aggregated per sensor pair per hour and normalised to each
     segment's own free-flow. 257 well-sampled segments on weekdays, 209
     at weekends.

     Hours 07-19 are those measurements. 00-06 are the previous prior,
     and 20-23 are a taper between the two. The night is NOT measured
     here and the distinction matters: these sensors sit on signalised
     arterials, where the 5 a.m. reference speed reflects favourable
     signal progression as much as an empty road, so `1 - speed/freeflow`
     after about 20:00 is reading green waves rather than traffic.

     Two things changed and both came out of the data rather than taste.

     The morning peak was too low. Measured across 257 segments the
     median morning peak is 0.77 of the evening one; this curve said
     0.50. Austin's morning rush is about half again as heavy, relative
     to its evening, as I had it.

     Midday was much too low — 0.15 to 0.23 here against 0.44 to 0.83
     measured. That gap has a cause worth remembering: the old numbers
     came from counting TomTom JAM EPISODES, which only begin when flow
     collapses. The steady delay of an arterial at one in the afternoon —
     a light cycle at every intersection, all afternoon — never registers
     as a jam and so was invisible to the old method, while a travel-time
     sensor measures exactly that. The two sources were right about
     different things; for a map that draws arterials, this is the one
     that applies.

     The weekend curve was previously prior only, with no weekend in the
     sample at all. It is now measured through the middle of the day, and
     it peaks at 18:00 rather than the 15:00 I had guessed.

     What this archive cannot do: stand in for the whole network. Its 30
     corridors are the ones ATD chose to instrument — Lamar alone is 22%
     of the segments — with no residential streets and partial freeway
     coverage. It is a good measurement of arterial Austin and is used
     here only for the SHAPE of the day, with SWING below still deciding
     how far each class of road actually falls. */
  const CONGEST_WD = [0.02, 0.01, 0.01, 0.01, 0.01, 0.03, 0.12, 0.60,
                      0.84, 0.66, 0.44, 0.44, 0.67, 0.83, 0.78, 0.72,
                      0.83, 1.00, 0.87, 0.68, 0.34, 0.17, 0.08, 0.04];
  const CONGEST_WE = [0.06, 0.04, 0.02, 0.01, 0.01, 0.02, 0.20, 0.31,
                      0.37, 0.54, 0.76, 0.88, 0.97, 0.95, 0.89, 0.90,
                      0.91, 0.96, 1.00, 0.96, 0.55, 0.32, 0.18, 0.10];

  /* How many vehicles are out, by local hour, peak hour = 1.

     Volume and congestion are not the same curve and must not share
     one. Delay rises far faster than volume, because a road near
     capacity falls apart: midday carries about eighty per cent of the
     peak hour's traffic at a fifth of its delay, and that gap is the
     whole reason rush hour feels the way it does.

     Getting this wrong in the other direction is just as visible. The
     first version of this curve read 0.16 at eleven at night and drew
     thirty cars across downtown, which is not what eleven at night in
     Austin looks like. Real hourly counts put the 23:00 hour at about
     28% of the peak hour and the 03:00 hour at 6%; these are those
     proportions. Unlike CONGEST_WD this curve is not measured from the
     archive — the archive records jams, and an empty road at 3 a.m.
     produces no record of the cars that are on it. */
  const VOLUME_WD = [0.18, 0.12, 0.08, 0.06, 0.07, 0.15, 0.40, 0.78,
                     0.88, 0.70, 0.66, 0.72, 0.80, 0.78, 0.82, 0.90,
                     0.97, 1.00, 0.90, 0.72, 0.60, 0.52, 0.42, 0.28];
  const VOLUME_WE = [0.38, 0.30, 0.22, 0.12, 0.08, 0.09, 0.14, 0.22,
                     0.34, 0.48, 0.62, 0.74, 0.84, 0.88, 0.92, 0.94,
                     0.92, 0.90, 0.86, 0.78, 0.70, 0.64, 0.56, 0.48];

  /* How far below free-flow each class of road falls at peak. A freeway
     at capacity loses most of its speed; a residential street with no
     through traffic barely notices. */
  const SWING = { highway: 72, major_road: 48, medium_road: 30, minor_road: 16 };

  const DOWNTOWN = [30.2672, -97.7431];

  /* Austin's clock, not the reader's. The page is about one city, so a
     phone left on Pacific time should still see Austin's rush hour. */
  function austinClock() {
    let h = 12, m = 0, wd = 3;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit',
        weekday: 'short', hour12: false }).formatToParts(new Date());
      const g = t => (parts.find(p => p.type === t) || {}).value;
      h = +g('hour') % 24; m = +g('minute');
      wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(g('weekday'));
    } catch (e) {
      const d = new Date(); h = d.getHours(); m = d.getMinutes(); wd = d.getDay();
    }
    return { h: h, m: m, wd: wd, t: h + m / 60 };
  }

  /* Read a 24-point curve at a fractional hour, so the city eases into
     rush hour over the minutes rather than stepping into it on the hour. */
  function curveAt(curve, t) {
    const i = Math.floor(t) % 24, f = t - Math.floor(t);
    return curve[i] * (1 - f) + curve[(i + 1) % 24] * f;
  }

  /* Everything time-dependent, computed once per settle. */
  function clockState() {
    const c = austinClock();
    // Friday evening drives like a weekday; Sunday morning does not.
    const weekend = c.wd === 0 || c.wd === 6;
    return {
      hour: c.h, min: c.m, wd: c.wd, t: c.t, weekend: weekend,
      cong: curveAt(weekend ? CONGEST_WE : CONGEST_WD, c.t),
      vol:  curveAt(weekend ? VOLUME_WE  : VOLUME_WD,  c.t),
      // Commute direction. +1 is inbound (toward downtown), -1 outbound.
      // Strongest at 08:00 and 17:30, nothing at night or at weekends.
      flow: weekend ? 0
          : c.t >= 6 && c.t < 11 ?  Math.max(0, 1 - Math.abs(c.t - 8.0) / 2.5)
          : c.t >= 14 && c.t < 20 ? -Math.max(0, 1 - Math.abs(c.t - 17.5) / 2.5)
          : 0
    };
  }

  /* The incident grid.

     A cell is about 280 m of latitude and a lookup checks the nine
     cells around a point, so nothing further than roughly 400 m is even
     considered — and then the real distance is measured, and anything
     over HIT_M is dropped.

     Both halves are necessary. The first version used half-kilometre
     cells with no distance check, which meant a match anywhere in a
     1.65 km box. TomTom had 122 closures open across the metro that
     night, mostly overnight ramp and lane work, and at that radius
     essentially every street in Austin was next to one: the model
     reported the entire city at 12% of free-flow, at eleven at night,
     with empty roads. A closure on I-35 does not close a side street
     eight hundred metres away. */
  const GRID = 0.0025;
  const HIT_M = 130;

  /* An incident's other effect. A closed lane does not mostly make
     traffic slow — it mostly makes traffic go somewhere else, and the
     stretch itself carries fewer vehicles than its class would suggest.
     Modelling a closure purely as a speed limit put Austin's freeways
     at 69% of free-flow at three in the morning, when they are empty
     and fast; what is true at three in the morning is that a few
     downtown ramps have nobody on them at all. trafficAt sets this as
     a side effect of its last call, which harvestRoads reads. */
  let hitLoad = 1;

  /* The live files: nine corridor probes, and every incident TomTom
     currently has open in the metro. Both are sampled by the scheduled
     job rather than by the browser, so a thousand readers cost one
     reading. */
  async function loadTraffic() {
    if (C.traffic && Date.now() - C.traffic.at < 300000) return C.traffic;
    const fresh = { at: Date.now(), cells: [], grid: new Map(), incidents: 0,
                    live: false };
    try {
      const d = await fetch(TRAFFIC_URL + 'corridors.json', { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('corridors ' + r.status); return r.json(); });
      fresh.cells = (d.corridors || [])
        .filter(c => c.lat != null && c.pct != null)
        .map(c => ({ lat: c.lat, lng: c.lng, pct: c.pct, name: c.name,
                     where: c.where, closed: !!c.closed }));
      fresh.live = true;
      fresh.fetchedAt = d.fetched_at || null;
    } catch (e) { /* the model still runs on the clock alone */ }

    /* Incidents carry a polyline rather than a point, so a two-mile
       backup slows the whole two miles and not one spot in the middle
       of it. They go into a coarse grid — about half a kilometre a cell
       — because a road lookup happens once per line per tile and there
       are a few thousand of those. */
    try {
      const d = await fetch(TRAFFIC_URL + 'open.json', { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('open ' + r.status); return r.json(); });
      const add = (lat, lng, rec) => {
        const k = Math.round(lat / GRID) + ':' + Math.round(lng / GRID);
        let a = fresh.grid.get(k); if (!a) fresh.grid.set(k, a = []);
        if (a.length < 8) a.push({ lat: lat, lng: lng, cat: rec.cat, delay: rec.delay });
      };
      for (const v of Object.values(d.tomtom || {})) {
        if (!v.geom || !v.geom.length) continue;
        if (v.cat !== 'jam' && v.cat !== 'closure' && v.cat !== 'roadwork') continue;
        const rec = { cat: v.cat, delay: v.delay_s || 0 };
        /* Every vertex, and a point every ~100 m along any longer gap,
           so a match is decided by distance from the line itself rather
           than by luck of where the vendor placed its vertices. */
        for (let i = 0; i < v.geom.length; i++) {
          const g = v.geom[i]; add(g[1], g[0], rec);
          const n = v.geom[i + 1]; if (!n) continue;
          const dy = n[1] - g[1], dx = (n[0] - g[0]) * 0.86;
          const steps = Math.min(12, Math.floor(Math.hypot(dy, dx) * 111000 / 100));
          for (let k = 1; k < steps; k++)
            add(g[1] + (n[1] - g[1]) * k / steps, g[0] + (n[0] - g[0]) * k / steps, rec);
        }
        fresh.incidents++;
      }
    } catch (e) { /* incidents are a refinement, not a requirement */ }

    C.traffic = fresh;
    return C.traffic;
  }

  /* What is happening on one stretch of road, right now, as a percentage
     of its free-flow speed. */
  function trafficAt(lat, lng, kindName) {
    const st = C.clock || (C.clock = clockState());
    hitLoad = 1;
    const swing = SWING[kindName] || 30;

    // 1. The clock. This is the part that is always available and that
    //    carries most of the signal.
    let pct = 100 - st.cong * swing;

    // 2. The corridor probes, which measure freeways and only freeways.
    //    Applying I-35's reading to a cul-de-sac was the old bug, so a
    //    probe only speaks for roads of its own kind, and only nearby.
    const cells = (C.traffic && C.traffic.cells) || [];
    if (cells.length && (kindName === 'highway' || kindName === 'major_road')) {
      let best = null, bd = Infinity;
      for (const c of cells) {
        const dy = c.lat - lat, dx = (c.lng - lng) * 0.86;
        const d = dy * dy + dx * dx;
        if (d < bd) { bd = d; best = c; }
      }
      // Full weight within ~3 km, fading out by ~12 km.
      const km = Math.sqrt(bd) * 111;
      const w = (kindName === 'highway' ? 0.85 : 0.45)
              * Math.max(0, Math.min(1, (12 - km) / 9));
      if (best && w > 0) pct = pct * (1 - w) + best.pct * w;
    }

    // 3. Live incidents, but only ones actually on this stretch.
    const grid = C.traffic && C.traffic.grid;
    if (grid && grid.size) {
      const gy = Math.round(lat / GRID), gx = Math.round(lng / GRID);
      for (let iy = -1; iy <= 1; iy++) for (let ix = -1; ix <= 1; ix++) {
        const a = grid.get((gy + iy) + ':' + (gx + ix));
        if (!a) continue;
        for (const r of a) {
          const dy = (r.lat - lat) * 111320, dx = (r.lng - lng) * 96000;
          if (dy * dy + dx * dx > HIT_M * HIT_M) continue;
          if (r.cat === 'closure') { pct = Math.min(pct, 30); hitLoad = Math.min(hitLoad, 0.2); }
          else if (r.cat === 'roadwork') { pct = Math.min(pct, 72); hitLoad = Math.min(hitLoad, 0.6); }
          // A jam's delay in seconds, against a nominal two-minute
          // free-flow run through the segment it was reported on.
          else pct = Math.min(pct, 100 * 120 / (120 + Math.min(r.delay, 900)));
        }
      }
    }
    return Math.max(6, Math.min(100, pct));
  }

  /* Roads in view only, cached per tile.
     The first version harvested every tile the cache held — 939 lines, of
     which 132 were anywhere near the screen — so six cars in seven were
     spawned somewhere you could not see. That is why moving the map left
     the streets empty. */
  function harvestRoads(map) {
    /* One stamp for "the model's answers may have changed": the minute
       of the clock, and which fetch of the incident file we are on. */
    const st = C.clock || (C.clock = clockState());
    C.readStamp = st.hour * 60 + st.min + ':'
                + ((C.traffic && C.traffic.at) || 0);
    const out = [];
    // total: picking weight (includes the focus term)
    // jamT:  congestion only, for jamLift
    // plain: road supply only, for density
    let total = 0, jamT = 0, plain = 0;
    for (const [tz, tx, ty] of H.visibleTiles(map)) {
      const key = tz + '/' + tx + '/' + ty;
      const t = C.tiles.get(key);
      if (!t || !t.roads) continue;
      let lines = C.roadCache.get(key);
      if (!lines) {
        lines = [];
        const ext = t.roads.extent || H.EXTENT_FALLBACK;
        const n = Math.pow(2, tz);
        for (const f of t.roads.features) {
          if (f.type !== 2) continue;
          const cls = CLASS[f.props.kind];
          if (!cls) continue;
          for (const ring of f.rings) {
            if (ring.length < 4) continue;
            const ll = [];
            let len = 0;
            for (let i = 0; i < ring.length; i += 2) {
              const lon = (tx + ring[i] / ext) / n * 360 - 180;
              const yy = (ty + ring[i + 1] / ext) / n;
              const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI;
              if (ll.length) {
                const p = ll[ll.length - 1];
                len += Math.hypot((lon - p[1]) * 96000, (lat - p[0]) * 111320);
              }
              ll.push([lat, lon]);
            }
            if (len < 20) continue;
            const mid = ll[ll.length >> 1];
            /* Cumulative metres along the line, so a car can hold a
               single distance-from-the-start instead of a segment index
               and a fraction. Everything the traffic model wants —
               spacing, gaps, queueing — is a subtraction in metres once
               this exists, and none of it is expressible in segments. */
            const cum = new Float64Array(ll.length);
            for (let q = 1; q < ll.length; q++) {
              cum[q] = cum[q - 1] + Math.hypot(
                (ll[q][1] - ll[q - 1][1]) * 96000,
                (ll[q][0] - ll[q - 1][0]) * 111320);
            }
            lines.push({ ll: ll, cum: cum, cls: cls, len: len, kind: f.props.kind,
                         lat: mid[0], lng: mid[1], pct: 100,
                         pxs: null, pxZoom: null });
          }
        }
        C.roadCache.set(key, lines);
        if (C.roadCache.size > 80) C.roadCache.delete(C.roadCache.keys().next().value);
      }
      for (const l of lines) {
        /* The geometry is cached per tile; the reading is cached for a
           minute.

           Asking the model afresh for every road on every settle cost
           between 4 and 13 ms on a fast machine, which is a tax on
           every pan for an answer that cannot have changed: the hour
           moves by a minute at a time and the incident file is
           refetched every five. `stamp` is bumped whenever either of
           those actually changes, so a real change still lands on the
           next settle rather than waiting out a timer. */
        if (l.stamp !== C.readStamp) {
          l.pct = trafficAt(l.lat, l.lng, l.kind);
          l.load = hitLoad;
          l.stamp = C.readStamp;
        }
        hitLoad = l.load;
        // Busier roads get more of the cars, and a jammed road gets more
        // still — traffic moving at a third of free-flow has about three
        // times as many vehicles on the same tarmac.
        /* How many vehicles this road would actually hold.

           The old weight was an invented score — length times a class
           number times a jam factor — which put cars roughly where you
           would expect but had no physical meaning, so nothing about
           the picture followed from the traffic reading except in the
           vaguest way.

           This is the real relationship. A queue of stopped traffic
           sits at about 7.5 m per vehicle, bumper to bumper. Moving
           traffic keeps roughly a two-second headway on top of that,
           so spacing grows with speed and the number of vehicles a
           given stretch holds falls as it clears. That is the whole
           reason a jammed road looks jammed: not because something
           multiplied a weight, but because thirty cars fit where six
           fit at sixty miles an hour. */
        const vms = l.cls.free * (l.pct / 100);
        const spacing = JAM_M + vms * HEADWAY_S;
        l.hold = l.cls.lanes * l.len / spacing;

        /* Your own street gets a little more of everything.

           Kept deliberately gentle — up to 1.8x within half a
           kilometre, gone by about two. The bug this page had for
           weeks was cars clustering where you had already been and
           leaving the rest of Austin empty, so the whole city is
           correct first and only then does your own block get the
           benefit of the doubt. */
        let near = 1;
        if (C.here) {
          const dy = (l.lat - C.here.lat) * 111320, dx = (l.lng - C.here.lng) * 96000;
          near = 1 + 0.8 * Math.exp(-(dy * dy + dx * dx) / (700 * 700));
        }
        l.w = l.hold * hitLoad * near;
        total += l.w;
        jamT += l.hold * hitLoad;
        // Not `near`: that one redistributes cars, it does not add any.
        // Folding it in here would raise the whole city's density
        // instead of concentrating it, which is the opposite.
        plain += l.cls.lanes * l.len / (JAM_M + l.cls.free * HEADWAY_S) * hitLoad;
        out.push(l);
      }
    }
    C.roads = out;
    C.roadTotal = total;

    /* How many vehicles are really out there, on the roads in view,
       at the speeds they are really moving. Not a score — a count. */
    C.holdSum = jamT;
    // Congestion, as a ratio against the same network running free.
    C.jamLift = jamT / Math.max(plain, 1);
  }

  /* ── Aircraft ───────────────────────────────────────────────────────

     Real positions, carried forward.

     The file is written by a scheduled Action, because no ADS-B feed
     will answer a browser or a Cloudflare Worker — the measurements are
     in tools/capture_aircraft.py. It lands about every two minutes,
     which for anything else on this map would be uselessly stale.

     Aircraft are the exception. An airliner at cruise is a straight
     line at a known speed on a known heading, so carrying a two-minute
     old fix forward is arithmetic rather than invention. The page does
     that, and the readout says how old the underlying fix is so the
     extrapolation is never mistaken for a live position. Anything
     manoeuvring — on approach, in the pattern — drifts from the truth,
     and that is the honest limit of it.

     Altitude is drawn as separation: the marker sits above its own
     shadow on the ground by an amount proportional to height, which is
     the same trick the buildings use and reads immediately as "this one
     is high and that one is landing". */
  const AIR_URL = 'https://raw.githubusercontent.com/jessestrait/'
                + 'jessestrait.github.io/data/aircraft/open.json';
  const KT_MS = 0.514444;          // knots to metres per second
  const FPM_MS = 0.00508;          // feet per minute to metres per second

  async function loadAircraft() {
    if (C.air && Date.now() - C.air.at < 45000) return C.air;
    try {
      const d = await fetch(AIR_URL, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('aircraft ' + r.status); return r.json(); });
      const t0 = Date.parse(d.fetched_at || '') || Date.now();
      C.air = {
        at: Date.now(), fetchedAt: t0,
        planes: (d.aircraft || []).filter(a => isFinite(a.lat) && isFinite(a.lng))
      };
    } catch (e) {
      C.air = C.air || { at: Date.now(), fetchedAt: 0, planes: [] };
      C.air.at = Date.now();       // do not hammer a feed that is down
    }
    return C.air;
  }

  /* Where an aircraft is now, given where it was and what it was doing.
     Great-circle curvature over a couple of minutes at these speeds is
     far below a pixel, so this is a straight line on the sphere. */
  function deadReckon(a, secs) {
    if (a.ground || !isFinite(a.gs_kt) || !isFinite(a.track)) {
      return { lat: a.lat, lng: a.lng, alt: a.ground ? 0 : (a.alt_ft || 0) };
    }
    const d = a.gs_kt * KT_MS * secs;                 // metres along track
    const th = a.track * Math.PI / 180;
    const dLat = d * Math.cos(th) / 111320;
    const dLng = d * Math.sin(th) / (111320 * Math.cos(a.lat * Math.PI / 180));
    let alt = a.alt_ft || 0;
    if (isFinite(a.vs_fpm)) alt = Math.max(0, alt + a.vs_fpm * (secs / 60));
    return { lat: a.lat + dLat, lng: a.lng + dLng, alt: alt };
  }

  function stepCars(map, dt) {
    if (!C.carCanvas) return;
    const dpr = D.sizeCanvas(map, C.carCanvas, 0);
    const ctx = C.carCtx;
    const w = C.carCanvas.width / dpr, h = C.carCanvas.height / dpr;
    const origin = C.carCanvas._origin || L.point(0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* Clear where the cars were, not the whole canvas.

       This is the one piece of work that happens sixty times a second.
       Clearing the full canvas meant wiping the entire window — some
       five million device pixels on a Retina display — every frame,
       whether anything had moved or not. Three hundred four-pixel
       squares is about one ten-thousandth of that. On a machine with
       integrated graphics the difference is the fans. */
    /* The canvas moves with the map. Once it has, last frame's
       rectangles point at the wrong places, so the whole thing goes. */
    const ok = C.carOrigin && C.carOrigin.x === origin.x && C.carOrigin.y === origin.y;
    C.carOrigin = origin;
    const prev = C.carRects;
    if (prev && prev.length && ok && !C.carWipe) {
      for (let i = 0; i < prev.length; i += 4)
        ctx.clearRect(prev[i], prev[i + 1], prev[i + 2], prev[i + 3]);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    C.carWipe = false;
    const rects = [];
    C.carRects = rects;
    if (!C.carsOn) return;

    /* Aircraft, on the same canvas and in the same frame.

       Drawn above their own ground shadow, separated by altitude, so a
       departure climbing out of AUS visibly lifts away from the map
       while something on short final sits almost on it. */
    /* Seven minutes, and the number is set by a CDN rather than by
       aerodynamics.

       raw.githubusercontent serves this file with max-age=300 and
       holds a version for up to five and a half minutes — measured,
       polling every 35 seconds: the same fetched_at came back three
       times running at 259s, 294s and 329s old before it rolled over.
       So the page's view of the data is capped by that cache no matter
       how often the collector commits. The floor is roughly
       300s + the commit interval, which is why the collector polls
       every two minutes rather than every five: it measurably narrows
       the window even though it cannot close it.

       The cut-off therefore has to sit above that, or the layer blanks
       for a large fraction of every cycle, which looks like breakage
       rather than honesty. Past seven minutes the chain has genuinely
       stopped and nothing is drawn.

       What this costs in accuracy is real and the readout states it:
       the position shown is the last fix carried forward, which is
       close for something flying straight and progressively wrong for
       anything turning onto final. It is an estimate of where a real
       aircraft is, labelled as one. */
    const air = C.air;
    const airAge = air ? (Date.now() - air.fetchedAt) / 1000 : Infinity;
    if (air && air.planes.length && airAge < 420 && map.getZoom() >= 9) {
      const secs = Math.max(0, airAge);
      const zf = Math.pow(2, map.getZoom() - 15);
      for (const a of air.planes) {
        const p = deadReckon(a, secs);
        const g = map.latLngToLayerPoint([p.lat, p.lng]);
        // 10,000 ft reads as ~26 px of lift at zoom 15, and scales with
        // the map so the separation means the same thing at every zoom.
        const lift = Math.min(90, (p.alt / 10000) * 26 * zf);
        const gx = g.x - origin.x, gy = g.y - origin.y;
        const ax = gx, ay = gy - lift;
        if (ax < -40 || ay < -40 || ax > w + 40 || ay > h + 40) continue;

        if (lift > 3) {
          // the shadow it would cast, straight down
          ctx.fillStyle = 'rgba(8,12,20,0.35)';
          ctx.beginPath(); ctx.ellipse(gx, gy, 2.4, 1.1, 0, 0, 6.2832); ctx.fill();
          rects.push(gx - 4, gy - 3, 8, 6);
          ctx.strokeStyle = 'rgba(150,180,220,0.20)';
          ctx.lineWidth = 0.6;
          ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(ax, ay); ctx.stroke();
          rects.push(Math.min(gx, ax) - 2, Math.min(gy, ay) - 2,
                     Math.abs(ax - gx) + 4, Math.abs(ay - gy) + 4);
        }

        // A chevron pointed along the track, so heading is readable.
        const th = (isFinite(a.track) ? a.track : 0) * Math.PI / 180;
        const co = Math.cos(th), si = Math.sin(th);
        const R = a.ground ? 2.2 : 3.6;
        ctx.fillStyle = a.ground ? 'rgba(150,170,200,0.75)' : '#e8f1ff';
        ctx.beginPath();
        ctx.moveTo(ax + si * R * 1.6, ay - co * R * 1.6);
        ctx.lineTo(ax - si * R + co * R, ay + co * R + si * R);
        ctx.lineTo(ax - si * R * 0.4, ay + co * R * 0.4);
        ctx.lineTo(ax - si * R - co * R, ay + co * R - si * R);
        ctx.closePath(); ctx.fill();
        rects.push(ax - R * 2 - 1, ay - R * 2 - 1, R * 4 + 2, R * 4 + 2);
      }
    }


    /* The ground-level marks need streets under them, so they stop
       where the streets stop being legible. Aircraft do not — they are most of
       the point of the layer when you are zoomed out far enough to see
       the whole approach — so they are drawn above this line. */
    if (map.getZoom() < H.MIN_Z - 1) return;

    // Density follows the road network on screen rather than a flat
    // number, so a motorway junction is busy and a quiet grid is quiet —
    // and a given street looks the same at every zoom. See harvestRoads
    // for why this counts pixels and not metres.
    /* Emergency lights, where AFD is actually working.

       The dispatch feed marks a call ACTIVE while crews are on it, and
       those are real addresses with real times. What is *not* known is
       the route an engine took to get there, so nothing here pretends
       to drive one: inventing a path through streets, at a speed, to a
       fire that is already burning would be making up the most
       specific-looking part of the picture. What is drawn instead is
       the thing anyone standing on that block would actually see —
       red and blue washing over the buildings.

       Two lights out of phase at about 1.4 Hz, which is roughly what a
       light bar does. */
    const alarms = C.alarms;
    if (alarms.length) {
      const ms = (performance.now() - C.t0) / 1000;
      for (const a of alarms) {
        const p = map.latLngToLayerPoint([a.lat, a.lng]);
        const x = p.x - origin.x, y = p.y - origin.y;
        const R = map.getZoom() >= 17 ? 46 : map.getZoom() >= 16 ? 30 : 20;
        if (x < -R || y < -R || x > w + R || y > h + R) continue;
        const ph = Math.sin((ms * 1.4 + a.off) * Math.PI * 2);
        const red = ph > 0;
        const amp = Math.abs(ph);
        if (amp < 0.08) continue;
        const g = ctx.createRadialGradient(x, y, 0, x, y, R);
        g.addColorStop(0, red ? 'rgba(255,70,60,' + (0.42 * amp).toFixed(3) + ')'
                              : 'rgba(80,140,255,' + (0.42 * amp).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - R, y - R, R * 2, R * 2);
        rects.push(x - R - 1, y - R - 1, R * 2 + 2, R * 2 + 2);
      }
    }

  }

  global.CITY3D._cars = { harvestRoads, stepCars, loadTraffic, trafficAt,
                          loadAircraft, deadReckon,
                          clockState, austinClock, CLASS, CONGEST_WD, VOLUME_WD };
})(window);

/* ── The buildings, in outline ────────────────────────────────────────

   The solid 3D layer was removed on 2026-09-26 and this is what took
   its place. The difference is not the shading, it is the projection.

   WHAT WENT WRONG BEFORE. Buildings leaned away from the centre of the
   SCREEN, imitating a camera. Leaflet has no camera — it is a plan view
   — so that made a building's shape depend on where it happened to sit
   in the window: it slid against the roads on every pan, and a zoom
   could not be a uniform scale because the lean did not scale with it.
   Hence the jump. The footprints were always exact (0.71 px against
   Leaflet's own projection over 240 vertices); it was the extrusion
   that lied.

   WHAT IS DIFFERENT. Every building now leans the same way, by a
   fixed vector — an axonometric projection rather than a fake
   perspective. Nothing depends on where a building sits in the
   window, so nothing slides when you pan.

   ON ZOOM, honestly: the FOOTPRINTS scale exactly, measured at 0.25 px
   against Leaflet's own answer for the target zoom, so the part that
   has to be right is right. The roofs do not quite: the lean goes as
   the square root of height (see leanOf), so it scales by 0.707 per
   level where a CSS scale applies 0.5, and a roof drifts by about
   thirty per cent of its own lean during the animation before the
   redraw corrects it. At these lean lengths that is a few pixels. The
   old screen-relative lean moved by 338. I am not claiming exact; I
   am claiming small, and bounded, and only on the roofs.

   WHY LINES. Measured, because it decided the architecture: canvas
   fill is quadratic in closed subpaths — 8,000 of them took 273 ms —
   which is what made the old renderer need a GPU. Open stroked
   subpaths are linear: 500 in 0.3 ms, 50,000 in 7.5 ms. A wireframe is
   nothing but open subpaths, so it needs no WebGL, gets antialiasing
   for free, and cannot z-fight or occlude anything. It also reads as
   what it is — an overlay on a map, rather than a solid object
   pretending to sit in the world. */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers;

  /* Up, and a little to the right. The exact angle is taste; that it
     is CONSTANT is the whole point — a constant lean scales with the
     zoom, so the zoom animation is exact and nothing jumps. */
  const DIR_X = 0.323, DIR_Y = -0.946;        // unit vector

  /* Height is drawn on a square root, not straight.

     Downtown Austin at zoom 17 runs from 6 px of building to 305 —
     the Independent is 315 m and that is 1 m per pixel here. Drawn
     linearly as lines, the towers become three-hundred-pixel cages
     that span the screen while the median eleven-pixel building has
     nothing to see at all. Filled, that range works, because mass
     reads as mass; as wireframe it is unusable at both ends.

     So: 4.6 * sqrt(height in pixels). Eleven pixels becomes fifteen,
     forty-six becomes thirty-one, three hundred and five becomes
     eighty. Taller is still reliably taller — the order is never
     wrong — but the range is compressed from fifty to one down to
     five to one. It is a log-ish axis on a chart, and like one it is
     a deliberate distortion for legibility rather than a measurement.
     The footprint underneath is always exact. */
  function leanOf(hpx) { return C.wireLean * Math.sqrt(Math.max(0, hpx)); }

  const W = { on: false, canvas: null, ctx: null, proj: new Map(), shapes: [] };
  /* How hard it leans. Tunable live from the console, because thin
     lines on a dark map are a matter of taste and a screenshot is a
     bad way to judge them:

         CITY3D.wireLean = 0;    CITY3D._wire.refresh(map)

     0 is the default and means flat: just the footprint outlines,
     which sit exactly on the streets and scale exactly under a zoom,
     because with no lean there is nothing that can drift. Raise it
     for a pop of height and you trade that exactness back — see the
     note at the top of this module. 2.4 is gentle, 4.6 is a tall
     cage. */
  C.wireLean = 0;

  function ensure(map) {
    if (W.canvas) return;
    if (!map.getPane('wirePane')) map.createPane('wirePane').style.zIndex = 264;
    const cv = document.createElement('canvas');
    // leaflet-zoom-animated carries transform-origin: 0 0, without which
    // a CSS-scaled canvas pivots about its middle and leaps a third of
    // the screen on every zoom. This cost days the first time round.
    cv.className = 'leaflet-zoom-animated';
    cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;'
                     + 'transform-origin:0 0;-webkit-transform-origin:0 0';
    map.getPane('wirePane').appendChild(cv);
    W.canvas = cv; W.ctx = cv.getContext('2d');
  }

  /* Footprints in absolute layer coordinates, cached per tile and zoom.
     Panning never invalidates this; only a zoom does. */
  function projectTile(map, key, t) {
    const z = map.getZoom(), ck = key + '@' + z;
    const hit = W.proj.get(ck);
    if (hit) return hit;

    const [tz, tx, ty] = key.split('/').map(Number);
    const lay = t.buildings;
    const ext = (lay && lay.extent) || H.EXTENT_FALLBACK;
    const tileScale = 256 * Math.pow(2, z - tz);
    const k = tileScale / ext;
    const ax = tx * tileScale, ay = ty * tileScale;
    const c = map.getCenter();
    const mpp = 40075016.686 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, z + 8);

    const out = [];
    for (const f of (lay ? lay.features : [])) {
      if (f.type !== 3) continue;             // address POINTS share this layer
      const kind = f.props.kind;
      if (kind !== 'building' && kind !== 'building_part') continue;
      const real = f.props.height != null;
      const hpx = (real ? +f.props.height : H.guessHeight(f.id || 1)) / mpp;
      for (const full of f.rings) {
        // Every ring in this archive closes itself; the repeated point
        // is harmless to a stroke but skews the bounds, so it goes.
        const n0 = full.length;
        const closed = n0 >= 4 && full[0] === full[n0 - 2] && full[1] === full[n0 - 1];
        // subarray only exists on typed arrays, and the decoder hands
        // back plain ones; do not assume which.
        const ring = !closed ? full
                   : (full.subarray ? full.subarray(0, n0 - 2)
                                    : full.slice(0, n0 - 2));
        if (ring.length < 6) continue;
        const pts = new Float32Array(ring.length);
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let i = 0; i < ring.length; i += 2) {
          const x = ax + ring[i] * k, y = ay + ring[i + 1] * k;
          pts[i] = x; pts[i + 1] = y;
          if (x < x0) x0 = x; if (y < y0) y0 = y;
          if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
        if ((x1 - x0) < 3 && (y1 - y0) < 3) continue;   // too small to read
        out.push({ pts: pts, h: hpx, real: real, x0: x0, y0: y0, x1: x1, y1: y1 });
      }
    }
    W.proj.set(ck, out);
    if (W.proj.size > 120) W.proj.delete(W.proj.keys().next().value);
    return out;
  }

  function collect(map) {
    const cv = W.canvas;
    const origin = cv._origin, pxO = map.getPixelOrigin();
    const size = map.getSize(), pad = cv._pad || L.point(0, 0);
    const bx0 = origin.x + pxO.x - 40, by0 = origin.y + pxO.y - 40;
    const bx1 = bx0 + size.x + pad.x * 2 + 80;
    const by1 = by0 + size.y + pad.y * 2 + 200;

    const out = [];
    for (const [tz, tx, ty] of H.visibleTiles(map)) {
      const t = C.tiles.get(tz + '/' + tx + '/' + ty);
      if (!t || !t.buildings) continue;
      for (const b of projectTile(map, tz + '/' + tx + '/' + ty, t)) {
        if (b.x1 < bx0 || b.y1 < by0 || b.x0 > bx1 || b.y0 > by1) continue;
        out.push(b);
      }
    }
    /* Zoom 15 holds eleven thousand shapes two pixels tall, which is
       not a skyline, it is hatching. Tallest first, then cut. */
    const lim = map.getZoom() <= 15 ? 2500 : map.getZoom() === 16 ? 5000 : 9000;
    if (out.length > lim) { out.sort((p, q) => q.h - p.h); out.length = lim; }
    return out;
  }

  function draw(map, resize) {
    if (!W.canvas) return;
    const dpr = resize === false
      ? Math.min(window.devicePixelRatio || 1, 2)
      : C._draw.sizeCanvas(map, W.canvas);
    const ctx = W.ctx;
    const w = W.canvas.width / dpr, h = W.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!W.on || map.getZoom() < H.MIN_Z) return;

    const b = W.shapes;
    if (!b.length) return;

    const origin = W.canvas._origin, pxO = map.getPixelOrigin();
    ctx.save();
    ctx.translate(-(origin.x + pxO.x), -(origin.y + pxO.y));

    /* One path, one stroke. Open subpaths, so this is linear in edges
       — the whole reason the layer can live on a 2D canvas again. */
    let edges = 0;
    ctx.lineJoin = 'round';

    /* Flat is a different drawing, not the same one with a zero
       offset. With no lean the roof outline, the footprint outline
       and the posts all collapse onto the same path, so drawing the
       three passes would stroke the identical line three times —
       triple the work and triple the alpha, which is why it would
       look heavier rather than cleaner. One pass, and brighter. */
    if (C.wireLean <= 0.01) {
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(176,202,242,0.78)';
      ctx.beginPath();
      for (const bl of b) {
        const p = bl.pts, m = p.length;
        ctx.moveTo(p[0], p[1]);
        for (let i = 2; i < m; i += 2) ctx.lineTo(p[i], p[i + 1]);
        ctx.lineTo(p[0], p[1]);
        edges += m / 2;
      }
      ctx.stroke();
      ctx.restore();
      W.edges = edges;
      return;
    }

    /* Corner posts first, and only where they carry information.

       The first cut drew a post at every vertex of every building
       above three pixels. The median building here leans eleven
       pixels, so that was seven thousand short parallel strokes — not
       a city, a hatch pattern. Anything under fourteen pixels now
       gets no posts at all: its roof outline, offset from its
       footprint outline, already says everything a post would. Only
       buildings with real height get the cage, and at most six posts
       each so a complex footprint does not turn back into hatching. */
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = 'rgba(150,180,225,0.45)';
    ctx.beginPath();
    for (const bl of b) {
      if (leanOf(bl.h) < 9) continue;
      const p = bl.pts, m = p.length;
      const L = leanOf(bl.h), dx = L * DIR_X, dy = L * DIR_Y;
      const step = Math.max(2, 2 * Math.ceil((m / 2) / 6));
      for (let i = 0; i < m; i += step) {
        ctx.moveTo(p[i], p[i + 1]);
        ctx.lineTo(p[i] + dx, p[i + 1] + dy);
        edges++;
      }
    }
    ctx.stroke();

    /* The footprint: where the building actually stands. Faint, and
       drawn under everything, because the base is the truth and the
       lean is only a convention. */
    ctx.strokeStyle = 'rgba(132,158,200,0.40)';
    ctx.beginPath();
    for (const bl of b) {
      const p = bl.pts, m = p.length;
      ctx.moveTo(p[0], p[1]);
      for (let i = 2; i < m; i += 2) ctx.lineTo(p[i], p[i + 1]);
      ctx.lineTo(p[0], p[1]);
      edges += m / 2;
    }
    ctx.stroke();

    // The roof, brightest, because it is the shape the eye should read.
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(182,208,246,0.85)';
    ctx.beginPath();
    for (const bl of b) {
      const p = bl.pts, m = p.length;
      const L = leanOf(bl.h), dx = L * DIR_X, dy = L * DIR_Y;
      ctx.moveTo(p[0] + dx, p[1] + dy);
      for (let i = 2; i < m; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
      ctx.lineTo(p[0] + dx, p[1] + dy);
      edges += m / 2;
    }
    ctx.stroke();
    ctx.restore();
    W.edges = edges;
  }

  function refresh(map) {
    if (!W.on) { if (W.canvas) draw(map); return; }
    if (map.getZoom() < H.MIN_Z) { W.shapes = []; draw(map); return; }
    C._draw.sizeCanvas(map, W.canvas);
    W.shapes = collect(map);
    draw(map, false);
  }

  global.CITY3D._wire = {
    ensure: ensure,
    refresh: refresh,
    draw: draw,
    state: W,
    setOn: function (map, on) {
      ensure(map);
      W.on = !!on;
      if (!W.on) W.shapes = [];
      refresh(map);
    },
    /* Carried through the zoom by a CSS scale. Exact for the
       footprints, a few pixels out on the roofs for the length of the
       animation — see the note at the top of this module. */
    onZoomAnim: function (map, e) {
      const cv = W.canvas;
      if (!cv || !W.on) return;
      const scale = map.getZoomScale(e.zoom, map.getZoom());
      const offset = map._latLngToNewLayerPoint(
        map.layerPointToLatLng(cv._origin || L.point(0, 0)), e.zoom, e.center);
      L.DomUtil.setTransform(cv, offset, scale);
    },
    status: function (map) {
      if (!W.on) return 'Off';
      if (map.getZoom() < H.MIN_Z) return 'Zoom past ' + H.MIN_Z + ' to raise the outlines';
      if (!W.shapes.length) return 'No buildings mapped here';
      const real = W.shapes.filter(s => s.real).length;
      return W.shapes.length.toLocaleString() + ' buildings · '
        + Math.round(100 * real / W.shapes.length) + '% at their real height · '
        + (W.edges || 0).toLocaleString() + ' lines';
    }
  };
})(window);

/* ── Wiring it to the map ───────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers, D = C._draw, CAR = C._cars;
  let settle = null;

  /* The buildings and the traffic are two separate switches over one
     set of machinery.

     They were one switch, and that was wrong in a way that only showed
     up once the costs were measured. Drawing the buildings is the
     expensive half — 10 to 25 ms a settle, and worse on an older
     machine. The traffic was the cheap half: emergency
     lights together come to well under a millisecond a frame, because
     they are a few hundred small rectangles on a canvas that clears
     only what it drew last time.

     Tying them together meant you could not have the living city
     without paying for the skyline. Now you can. */
  function live() { return C.carsOn || global.CITY3D._wire.state.on; }

  async function refresh(map) {
    // Drop whatever transform the zoom animation left behind; sizeCanvas
    // is about to position this properly again.
    if (!live()) return;
    if (map.getZoom() < H.MIN_Z) {
      C.roads = [];
      C.onNote && C.onNote(); return;
    }
    const want = H.visibleTiles(map);
    await Promise.all(want.map(([z, x, y]) => H.tile(z, x, y)));
    C.clock = CAR.clockState();
    global.CITY3D._wire.refresh(map);
    if (C.carsOn) {
      await CAR.loadTraffic();
      CAR.loadAircraft();   // never awaited: a slow feed must not hold the settle
      CAR.harvestRoads(map);
    }
    scheduleRetry(map);
    C.onNote && C.onNote();
  }

  /* 180 ms was the right wait when a settle cost 33 ms of CPU and
     redrawing early meant doing it twice. On the GPU a settle is under
     a millisecond, so the only thing the delay buys now is a pause
     before the city reappears — which is precisely the lag this was
     supposed to avoid. */
  function scheduleRefresh(map) {
    clearTimeout(settle);
    settle = setTimeout(() => refresh(map), 70);
  }

  /* If the archive failed, come back for it. Without this the layer
     waits for the reader to pan before it will try again, which on a
     page they are just looking at means for ever. */
  function scheduleRetry(map) {
    if (!C.tileErr || C.retry) return;
    C.retry = setTimeout(() => {
      C.retry = null;
      if (C.tileErr) { C.tileErr = null; refresh(map); }
    }, 4000);
  }

  function frame(map) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - (C.last || now)) / 1000);
    C.last = now;
    // Not while the map is animating: the frames are wanted by the zoom,
    // and two hundred squares drawn behind it help nobody.
    if (!document.hidden && C.carsOn && !C.zooming) CAR.stepCars(map, dt);
    /* Tiles still waiting for their buffers get another slice here,
       one frame at a time, so the map keeps running while it fills in. */
    C.raf = requestAnimationFrame(() => frame(map));
  }

  C.attach = function (map, onNote) {
    C.onNote = onNote;
    D.ensurePanes(map);
    // Wired once. attach() is called every time the layer is ticked, and
    // without this each tick would add another set of map handlers and
    // another redraw per move — a leak that only shows up as the map
    // getting heavier the more you fiddle with the checkbox.
    if (C.wired) return;
    C.wired = true;

    /* The city is redrawn only when the view settles.
     *
     * The first version redrew on every `move`, which during a zoom meant
     * several thousand canvas paths per frame — and drew them from
     * coordinates collected at the *last* settle, so it was paying that
     * price to render the wrong positions. That is the lag.
     *
     * Leaflet's own canvas layers do not work that way and neither does
     * this now. Panning moves the canvas because it is positioned in
     * layer coordinates and Leaflet translates the pane. Zooming scales
     * it with a CSS transform, which is one GPU composite rather than
     * thousands of paths. Only when the map comes to rest is anything
     * recomputed. It is locked to the other layers because it is doing
     * what the other layers do. */
    map.on('zoomstart', () => { C.zooming = true; });
    map.on('zoomend', () => { C.zooming = false; });
    /* The motion canvas is redrawn each frame from live coordinates,
       so it needs no zoom transform — only to not be left behind a
       stale one. The outline canvas is the opposite: it is drawn once
       per settle and carried through the zoom by a CSS scale, which is
       exact for it because every coordinate scales with the zoom. */
    map.on('zoomanim', e => {
      if (C.carCanvas) L.DomUtil.setTransform(C.carCanvas, L.point(0, 0), 1);
      global.CITY3D._wire.onZoomAnim(map, e);
    });

    map.on('moveend zoomend resize', () => scheduleRefresh(map));
    if (!C.raf) frame(map);
  };

  // The building outlines.
  C.setOn = function (map, on) {
    global.CITY3D._wire.setOn(map, !!on);
  };
  C.wireStatus = function (map) { return global.CITY3D._wire.status(map); };

  // The emergency lights and the aircraft.
  C.setCars = function (map, on) {
    C.carsOn = !!on;
    if (!C.carsOn) {
      C.roads = [];
      C.carWipe = true; CAR.stepCars(map, 0);
    }
    if (live()) refresh(map);
  };

  C.status = function (map) {
    if (!C.carsOn) return 'Off';
    const bits = [];
    /* Aircraft are visible from zoom 9, so the readout must not tell
       you to zoom in while something is plainly being drawn. Only the
       street-level half has a floor. */
    const close = map.getZoom() >= H.MIN_Z;

    const roads = close ? (C.roads || []) : [];
    if (roads.length) {
      /* Weighted by how much traffic each stretch is actually holding,
         not by how many segments a tile split it into. A crawling
         freeway and a crawling cul-de-sac are not the same fact about
         "how is traffic here". */
      let num = 0, den = 0, km = 0;
      for (const r of roads) { num += r.pct * r.hold; den += r.hold; km += r.len; }
      bits.push('traffic at ' + Math.round(num / Math.max(den, 1e-9))
        + '% of free-flow across ' + (km / 1000).toFixed(0) + ' km of road');
    }
    const st = C.clock;
    if (st && close) {
      const hh = (st.hour < 10 ? '0' : '') + st.hour
               + ':' + (st.min < 10 ? '0' : '') + st.min;
      /* Recalibrated with the curve. These thresholds were set against a
         curve whose midday sat at 0.18; the measured one puts it at 0.83,
         so the old bands would have announced one in the afternoon as
         "peak". The word has to keep meaning rush hour, and the measured
         fact — that an arterial midday really does carry most of the
         delay of a rush hour — is better said than mislabelled. */
      const peak = st.cong > 0.92 ? 'peak' : st.cong > 0.72 ? 'heavy'
                 : st.cong > 0.40 ? 'busy' : st.cong > 0.12 ? 'light' : 'quiet';
      bits.push(hh + ' in Austin, ' + peak);
    }
    const inc = C.traffic && C.traffic.incidents;
    if (inc && close) bits.push(inc + ' live incidents on the network');
    if (C.alarms.length) bits.push(C.alarms.length + ' call'
      + (C.alarms.length === 1 ? '' : 's') + ' AFD is on right now');
    if (C.air && C.air.planes.length) {
      const up = C.air.planes.filter(a => !a.ground).length;
      const age = Math.round((Date.now() - C.air.fetchedAt) / 1000);
      const said = age < 90 ? age + 's' : Math.round(age / 60) + ' min';
      bits.push(age < 420
        ? up + ' aircraft up, flown forward from a fix ' + said + ' old'
        : 'aircraft feed is ' + said + ' behind \u2014 not drawing them');
    }
    if (!bits.length) {
      return close ? 'Nothing moving here'
                   : 'Zoom past ' + H.MIN_Z + ' to read the streets';
    }
    return bits.join(' \u00b7 ');

  };

})(window);
