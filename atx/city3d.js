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
  const BUILD = 'm1';

  const MIN_Z = 15;
  const TILE_Z = 15;
  const EXTENT_FALLBACK = 4096;

  const CITY = {
    pm: null, tiles: new Map(), busy: new Set(), roadCache: new Map(),
    roadTotal: 0, holdSum: 0, jamLift: 1, traffic: null,
    carsOn: true, tileErr: null,
    here: null,
    water: [], waterCache: new Map(), drops: [], gauges: null, waterLen: 0,
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
      let parsed = { buildings: null, roads: null, water: null };
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
          buildings: global.MVT.decodeLayer(buf, 'buildings'),
          roads: global.MVT.decodeLayer(buf, 'roads'),
          water: global.MVT.decodeLayer(buf, 'water')
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

     There is no weekend in the sample at all — the three days are a
     Monday, a Tuesday and a Wednesday — so CONGEST_WE below is prior
     only, and is marked as such in the readout. */
  const CONGEST_WD = [0.02, 0.01, 0.01, 0.01, 0.01, 0.03, 0.14, 0.42,
                      0.50, 0.33, 0.18, 0.15, 0.18, 0.19, 0.19, 0.23,
                      0.55, 1.00, 0.86, 0.35, 0.14, 0.10, 0.06, 0.04];
  const CONGEST_WE = [0.06, 0.04, 0.02, 0.01, 0.01, 0.02, 0.04, 0.08,
                      0.14, 0.22, 0.32, 0.42, 0.50, 0.54, 0.56, 0.58,
                      0.56, 0.52, 0.46, 0.38, 0.30, 0.22, 0.14, 0.09];

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

  /* ── Moving water ───────────────────────────────────────────────────

     The same tiles that carry the buildings carry a `water` layer, and
     in it the rivers and creeks are LINES, not just the blue polygons
     the basemap paints. OpenStreetMap draws a waterway in the direction
     it flows, which is the one piece of information needed to make the
     Colorado run east through town rather than in whichever direction
     the vertices happened to be stored.

     How fast it runs comes from USGS, which gauges discharge in cubic
     feet per second every fifteen minutes at a few dozen sites around
     Travis County. The page already fetches those for the creek-gauge
     layer, so setFlow passes them through rather than asking twice.
     After a storm Shoal Creek goes from a trickle to a torrent inside
     an hour, and that is visible here.

     If USGS is unreachable — which it genuinely is about one request in
     five, and was completely down while this was written — the water
     still moves, at the slow default below, and the readout does not
     claim a measurement it does not have. */
  const WATER_KIND = { river: 2.2, stream: 1.2, canal: 1.6, drain: 0.9 };
  const DEFAULT_CFS = 120;

  function harvestWater(map) {
    const out = [];
    let len = 0;
    for (const [tz, tx, ty] of H.visibleTiles(map)) {
      const key = tz + '/' + tx + '/' + ty;
      const t = C.tiles.get(key);
      if (!t || !t.water) continue;
      let lines = C.waterCache.get(key);
      if (!lines) {
        lines = [];
        const ext = t.water.extent || H.EXTENT_FALLBACK;
        const n = Math.pow(2, tz);
        for (const f of t.water.features) {
          if (f.type !== 2) continue;                 // lines only
          const wide = WATER_KIND[f.props.kind];
          if (!wide) continue;
          for (const ring of f.rings) {
            if (ring.length < 4) continue;
            const ll = [];
            let m = 0;
            for (let i = 0; i < ring.length; i += 2) {
              const lon = (tx + ring[i] / ext) / n * 360 - 180;
              const yy = (ty + ring[i + 1] / ext) / n;
              const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI;
              if (ll.length) {
                const p = ll[ll.length - 1];
                m += Math.hypot((lon - p[1]) * 96000, (lat - p[0]) * 111320);
              }
              ll.push([lat, lon]);
            }
            if (m < 40) continue;
            const mid = ll[ll.length >> 1];
            lines.push({ ll: ll, wide: wide, len: m,
                         lat: mid[0], lng: mid[1],
                         named: !!f.props.name });
          }
        }
        C.waterCache.set(key, lines);
        if (C.waterCache.size > 80) C.waterCache.delete(C.waterCache.keys().next().value);
      }
      for (const l of lines) { l.cfs = flowAt(l.lat, l.lng); len += l.len * l.wide; out.push(l); }
    }
    C.water = out;
    C.waterLen = len;
  }

  /* Discharge at the nearest gauge. Nearest is crude on a river system —
     a gauge on Barton Creek says nothing about Walnut Creek — so it is
     capped at 12 km, beyond which the default stands in. */
  function flowAt(lat, lng) {
    const g = C.gauges;
    if (!g || !g.length) return null;
    let best = null, bd = Infinity;
    for (const s of g) {
      const dy = s.lat - lat, dx = (s.lng - lng) * 0.86;
      const d = dy * dy + dx * dx;
      if (d < bd) { bd = d; best = s; }
    }
    return (best && Math.sqrt(bd) * 111 < 12) ? best.cfs : null;
  }

  /* Discharge to a drift speed in metres per second. Real channel
     velocity goes roughly as the cube root of discharge, which is why
     a hundredfold flood is not a hundred times faster — about five
     times. Clamped either end so a dry creek still creeps and a flood
     does not turn into streaks. */
  function dropSpeed(cfs) {
    const q = Math.max(1, cfs == null ? DEFAULT_CFS : cfs);
    return Math.max(0.25, Math.min(4.5, 0.22 * Math.pow(q, 1 / 3)));
  }

  function spawnDrop() {
    const ws = C.water;
    if (!ws || !ws.length) return null;
    let r = Math.random() * C.waterLen;
    let road = ws[ws.length - 1];
    for (let i = 0; i < ws.length; i++) { r -= ws[i].len * ws[i].wide; if (r <= 0) { road = ws[i]; break; } }
    const line = road.ll;
    return { line: line, w: road, i: (Math.random() * Math.max(1, line.length - 2)) | 0,
             t: Math.random(), v: dropSpeed(road.cfs) * (0.8 + Math.random() * 0.4),
             wide: road.wide };
  }

  /* Roads in layer pixels, recomputed only when the zoom changes.

     Every car used to call map.latLngToLayerPoint every frame — three
     hundred projections a frame, each of them trigonometry, to answer
     a question whose answer had not changed since the last settle. The
     geometry is projected once here and the frame becomes arithmetic. */

  /* Where a car is, given how far along its road it has got. Returns
     the point and the unit direction, both in layer pixels. */

  /* Pick a road with probability proportional to its weight, so a
     motorway is chosen far more often than a side street without any
     per-road bookkeeping. */

  /* Which way a car is pointed.

     Austin commutes, so the morning and the evening are not mirror
     images of each other: at eight in the morning the heavy direction
     is toward the centre and at half past five it is away from it. The
     model only knows one centre and one radius, which is crude, but the
     asymmetry itself is the honest part — an even split at rush hour is
     the thing that would be wrong. Off-peak and at weekends it is a
     coin toss, which is also what the streets look like. */

  /* Car following.

     Cars used to hold independent positions on a road and simply pass
     through one another, which is the single most obviously wrong
     thing about the old layer — a queue of traffic is the one shape
     everybody recognises and it could never form.

     This is the standard rule, kept deliberately small: nobody closes
     to less than one jam spacing, and nobody drives faster than the
     gap ahead divided by the headway they would keep at that speed.
     Everything else falls out of it, including stop-and-go waves,
     which appear on their own on a jammed corridor without anything
     modelling them. */

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


    /* Cars and water need streets under them, so they stop where the
       streets stop being legible. Aircraft do not — they are most of
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

    /* The water, on the same canvas and in the same frame, so it shares
       one clear and one dirty-rect list with the cars. */
    const wantDrops = Math.max(0, Math.min(260,
                      Math.round((C.waterLen || 0) / 900)));
    while (C.drops.length < wantDrops) { const d = spawnDrop(); if (!d) break; C.drops.push(d); }
    if (C.drops.length > wantDrops) C.drops.length = wantDrops;

    ctx.fillStyle = 'rgba(150,214,255,0.7)';
    for (const d of C.drops) {
      const a = d.line[d.i], b2 = d.line[d.i + 1];
      if (!a || !b2) { const n = spawnDrop(); if (n) Object.assign(d, n); continue; }
      const segM = Math.hypot((b2[1] - a[1]) * 96000, (b2[0] - a[0]) * 111320) || 1;
      d.t += (d.v * dt) / segM;
      while (d.t >= 1) {
        d.t -= 1; d.i += 1;
        // Downstream only: OSM draws a waterway the way it flows, so
        // there is no direction to choose and no upstream drift.
        if (d.i >= d.line.length - 1) { const n = spawnDrop(); if (n) Object.assign(d, n); break; }
      }
      const A = d.line[d.i], B = d.line[d.i + 1];
      if (!A || !B) continue;
      const p = map.latLngToLayerPoint([A[0] + (B[0] - A[0]) * d.t,
                                        A[1] + (B[1] - A[1]) * d.t]);
      const x = p.x - origin.x, y = p.y - origin.y;
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) {
        const n = spawnDrop(); if (n) Object.assign(d, n);
        continue;
      }
      const s2 = d.wide * (map.getZoom() >= 17 ? 1.3 : 0.9);
      ctx.fillRect(x - s2 / 2, y - s2 / 2, s2, s2);
      rects.push(x - s2 / 2 - 1, y - s2 / 2 - 1, s2 + 2, s2 + 2);
    }
  }

  global.CITY3D._cars = { harvestRoads, harvestWater, stepCars, loadTraffic, trafficAt,
                          loadAircraft, deadReckon, flowAt, dropSpeed,
                          clockState, austinClock, CLASS, CONGEST_WD, VOLUME_WD };
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
     machine. The traffic is the cheap half: cars, water and emergency
     lights together come to well under a millisecond a frame, because
     they are a few hundred small rectangles on a canvas that clears
     only what it drew last time.

     Tying them together meant you could not have the living city
     without paying for the skyline. Now you can. */
  function live() { return C.carsOn; }

  async function refresh(map) {
    // Drop whatever transform the zoom animation left behind; sizeCanvas
    // is about to position this properly again.
    if (!live()) return;
    if (map.getZoom() < H.MIN_Z) {
      C.roads = []; C.water = [];
      C.onNote && C.onNote(); return;
    }
    const want = H.visibleTiles(map);
    await Promise.all(want.map(([z, x, y]) => H.tile(z, x, y)));
    C.clock = CAR.clockState();
    if (C.carsOn) {
      await CAR.loadTraffic();
      CAR.loadAircraft();   // never awaited: a slow feed must not hold the settle
      CAR.harvestRoads(map);
      CAR.harvestWater(map);
    }
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
    /* Everything on the motion canvas is redrawn each frame from live
       coordinates, so it needs no zoom transform — only to not be left
       behind a stale one. */
    map.on('zoomanim', () => {
      if (C.carCanvas) L.DomUtil.setTransform(C.carCanvas, L.point(0, 0), 1);
    });

    map.on('moveend zoomend resize', () => scheduleRefresh(map));
    if (!C.raf) frame(map);
  };

  /* A no-op, kept so an old saved link naming the buildings layer does
     not throw. There is nothing to switch on any more. */
  C.setOn = function () {};

  // The traffic, the water and the emergency lights.
  C.setCars = function (map, on) {
    C.carsOn = !!on;
    if (!C.carsOn) {
      C.drops.length = 0; C.roads = []; C.water = [];
      C.carWipe = true; CAR.stepCars(map, 0);
    }
    if (live()) refresh(map);
  };

  C.status = function (map) {
    if (!C.carsOn) return 'Off';
    if (map.getZoom() < H.MIN_Z) return 'Zoom past ' + H.MIN_Z + ' to read the streets';
    const bits = [];

    const roads = C.roads || [];
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
    if (st) {
      const hh = (st.hour < 10 ? '0' : '') + st.hour
               + ':' + (st.min < 10 ? '0' : '') + st.min;
      const peak = st.cong > 0.66 ? 'peak' : st.cong > 0.3 ? 'building'
                 : st.cong > 0.12 ? 'light' : 'quiet';
      bits.push(hh + ' in Austin, ' + peak);
    }
    const inc = C.traffic && C.traffic.incidents;
    if (inc) bits.push(inc + ' live incidents on the network');
    if (C.water && C.water.length) bits.push(C.water.length + ' creeks and rivers running');
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
    if (!bits.length) return 'Nothing moving here';
    return bits.join(' \u00b7 ');

  };

})(window);
