/* Buildings, standing up, on the flat map.
 *
 * Leaflet has no camera — the map is a plan, always straight down, and no
 * amount of styling changes that. So "3D" here is the oldest trick there
 * is: draw each footprint, then draw its walls leaning away from the
 * centre of the screen and its roof offset by the same amount. Things
 * near the middle stand straight, things at the edges lean out, and the
 * eye reads the whole thing as a model seen from above. It is what SimCity
 * did, and what OSM Buildings does on Leaflet to this day.
 *
 * Everything else on this map is untouched. This adds two panes below the
 * marks and takes nothing away: every layer, popup, control and readout
 * behaves exactly as it did.
 *
 * The geometry comes from the same PMTiles archive the tilted view at
 * /atx/3d/ uses — one 43 MB file of the whole metro, read over HTTP range
 * requests, so only the handful of tiles under the viewport are fetched.
 *
 * WHAT IS REAL. The footprints are OpenStreetMap's. A height is OSM's
 * where OSM has one, which in central Austin is about 43% of buildings —
 * counted, not estimated. The rest are given a plausible height derived
 * from their own id so the skyline has texture instead of being a plateau
 * of identical boxes. That is an approximation and the layer says so.
 * The cars are invented entirely; they are driven along real street
 * geometry out of the same tiles.
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
  const MIN_Z = 15;
  const TILE_Z = 15;
  const EXTENT_FALLBACK = 4096;

  const CITY = {
    on: false, pm: null, tiles: new Map(), busy: new Set(), proj: new Map(), roadCache: new Map(), roadTotal: 0, roadPx: 0, jamLift: 1, traffic: null,
    carsOn: true, tileErr: null,
    quality: 1, drawMs: 0, blackouts: [], boZoom: null, here: null,
    water: [], waterCache: new Map(), drops: [], gauges: null, waterLen: 0,
    alarms: [], t0: performance.now(),
    buildings: null, roads: null, cars: [], raf: null, last: 0,
    canvas: null, ctx: null, carCanvas: null, carCtx: null,
    lift: 0.55,          // how hard the city leans. 0 is a plan, 1 is a lot.
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
      // A few hundred tiles is plenty; central Austin is a handful.
      if (CITY.tiles.size > 220) CITY.tiles.delete(CITY.tiles.keys().next().value);
      return parsed;
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
  global.CITY3D._helpers = { lon2x, lat2y, tile, visibleTiles, guessHeight, TILE_Z, MIN_Z,
                             EXTENT_FALLBACK };
})(window);

/* ── Drawing ────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers;

  function ensurePanes(map) {
    if (C.canvas) return;
    // Below every mark, above the basemap. The city is scenery; the data
    // it sits under is the point of the page and must never be occluded.
    if (!map.getPane('cityPane')) { map.createPane('cityPane').style.zIndex = 265; }
    if (!map.getPane('carPane')) { map.createPane('carPane').style.zIndex = 268; }
    const mk = pane => {
      const cv = document.createElement('canvas');
      cv.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
      map.getPane(pane).appendChild(cv);
      return cv;
    };
    C.canvas = mk('cityPane');
    /* WebGL if the machine has it, the 2D renderer if not.

       This is the whole point of the GL module: the 2D path rebuilds
       every wall on the CPU each settle, and no amount of tuning
       changes that shape. It is kept because it is correct everywhere
       and because a lost or refused context should degrade rather than
       leave an empty pane — but on anything made this decade the GPU
       path is the one that runs. */
    const gl = global.CITY3D._gl && global.CITY3D._gl.init(C.canvas);
    if (gl) {
      C.useGL = true;
    } else {
      /* A canvas can only ever have one kind of context. Asking a
         canvas that was offered to WebGL for a 2D one returns null, and
         the 2D renderer then throws on its first setTransform — so a
         refused GL context took the fallback down with it, which is
         exactly the thing a fallback exists to prevent. Start over with
         a clean element. */
      C.useGL = false;
      C.canvas.remove();
      C.canvas = mk('cityPane');
      C.ctx = C.canvas.getContext('2d');
    }
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
    L.DomUtil.setPosition(cv, origin);
    cv._origin = origin;
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
  function projectTile(map, key, t) {
    const z = map.getZoom();
    const ck = key + '@' + z;
    const hit = C.proj.get(ck);
    if (hit) return hit;

    const [tz, tx, ty] = key.split('/').map(Number);
    const ext = (t.buildings && t.buildings.extent) || H.EXTENT_FALLBACK;
    const tileScale = 256 * Math.pow(2, z - tz);
    const k = tileScale / ext;
    const ax = tx * tileScale, ay = ty * tileScale;
    const c = map.getCenter();
    const mpp = 40075016.686 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, z + 8);

    const out = [];
    for (const f of (t.buildings ? t.buildings.features : [])) {
      // Address points share this layer with real buildings — 677 of 1,188
      // in a downtown tile. Polygons only.
      if (f.type !== 3) continue;
      const kind = f.props.kind;
      if (kind !== 'building' && kind !== 'building_part') continue;
      const real = f.props.height != null;
      const hpx = (real ? +f.props.height : H.guessHeight(f.id || 1)) / mpp;
      for (const ring of f.rings) {
        if (ring.length < 8) continue;
        const pts = new Float32Array(ring.length);
        let cx = 0, cy = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let i = 0; i < ring.length; i += 2) {
          const x = ax + ring[i] * k, y = ay + ring[i + 1] * k;
          pts[i] = x; pts[i + 1] = y; cx += x; cy += y;
          if (x < x0) x0 = x; if (y < y0) y0 = y;
          if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
        if ((x1 - x0) < 2 && (y1 - y0) < 2) continue;   // too small to read
        const m = ring.length / 2;
        out.push({ pts: pts, cx: cx / m, cy: cy / m, h: hpx, real: real,
                   x0: x0, y0: y0, x1: x1, y1: y1 });
      }
    }
    C.proj.set(ck, out);
    // Two zoom levels' worth of the area anyone actually looks at.
    if (C.proj.size > 120) C.proj.delete(C.proj.keys().next().value);
    return out;
  }

  /* ── The lights that are actually off ───────────────────────────────

     Austin Energy publishes outages by ZIP, not by building, and a ZIP
     is rarely all out: the two open right now are 250 customers of
     11,445 and 1 of 8,511. Blacking out the whole ZIP would be a much
     bigger claim than the data makes. So the share out is applied to
     the share of windows lit — two per cent out is two per cent fewer
     lit windows, and a storm that takes out half a ZIP is unmistakable.

     Nothing is fetched here. The page already holds these polygons and
     already polls Austin Energy for the layer it draws on the ground;
     this reads that same state through setBlackouts. */
  function projectBlackouts(map) {
    const z = map.getZoom();
    if (C.boZoom === z) return;
    C.boZoom = z;
    for (const b of C.blackouts) {
      b.pts = b.rings.map(r => {
        const out = new Float64Array(r.length * 2);
        for (let i = 0; i < r.length; i++) {
          const pt = map.project(L.latLng(r[i][1], r[i][0]), z);
          out[i * 2] = pt.x; out[i * 2 + 1] = pt.y;
        }
        return out;
      });
      const pt0 = map.project(L.latLng(b.bbox[1], b.bbox[0]), z);
      const pt1 = map.project(L.latLng(b.bbox[3], b.bbox[2]), z);
      b.x0 = Math.min(pt0.x, pt1.x); b.x1 = Math.max(pt0.x, pt1.x);
      b.y0 = Math.min(pt0.y, pt1.y); b.y1 = Math.max(pt0.y, pt1.y);
    }
  }

  function inRing(pts, x, y) {
    let inside = false;
    for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
      const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* How much of this building's block has no power. */
  function darkAt(x, y) {
    for (const b of C.blackouts) {
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
      for (const r of b.pts) if (inRing(r, x, y)) return b.pct;
    }
    return 0;
  }

  /* Only the tiles under the viewport. The first version walked the whole
     tile cache, so a settle got steadily slower the longer the map was
     used — 12.7 ms at six tiles cached, 33.7 ms at forty-five, and the
     cache holds two hundred. That is the lag that got worse all day. */
  function collect(map) {
    const origin = (C.canvas && C.canvas._origin) || map.containerPointToLayerPoint([0, 0]);
    const pxO = map.getPixelOrigin();
    const size = map.getSize();
    const pad = (C.canvas && C.canvas._pad) || L.point(0, 0);
    // Cull bounds in absolute layer space, which is what the cache holds.
    const bx0 = origin.x + pxO.x - 40, by0 = origin.y + pxO.y - 40;
    const bx1 = bx0 + size.x + pad.x * 2 + 80, by1 = by0 + size.y + pad.y * 2 + 200;

    const dark = C.blackouts.length > 0;
    if (dark) projectBlackouts(map);

    const out = [];
    for (const [tz, tx, ty] of H.visibleTiles(map)) {
      const key = tz + '/' + tx + '/' + ty;
      const t = C.tiles.get(key);
      if (!t || !t.buildings) continue;
      for (const b of projectTile(map, key, t)) {
        if (b.x1 < bx0 || b.y1 < by0 || b.x0 > bx1 || b.y0 > by1) continue;
        b.dark = dark ? darkAt(b.cx, b.cy) : 0;
        out.push(b);
      }
    }
    /* How many is worth drawing.

       Zoom 15 is the widest 3D view and by far the heaviest — four
       thousand buildings, each two or three pixels tall. Zoom 18 shows
       a couple of hundred, each the size of a thumbnail. A flat cap
       spends the whole budget at exactly the zoom where the detail is
       least visible, so the cap follows the zoom, and CAP is lowered
       further by the adaptive guard when a machine cannot keep up. */
    const z = map.getZoom();
    const lim = Math.round((z <= 15 ? 2200 : z === 16 ? 3200 : 4000) * C.quality);
    if (out.length > lim) {
      out.sort((p, q) => q.h - p.h);      // keep the ones you can see
      out.length = lim;
    }

    /* Batch order is spatial, not front-to-back.

       Every ctx.fill() rasterises its path's bounding box, and a batch
       of forty-eight buildings scattered across the view has a bounding
       box the size of the whole canvas — 2700 x 1800 device pixels of
       it, three hundred times per draw. Sorting into horizontal bands
       first makes each batch a small neighbourhood, so each fill covers
       a small box: 30.3 ms to 15.9 ms for the walls at zoom 15, on a
       fast machine, and the gap is wider the slower the rasteriser.

       Depth order is given up to get it, which is affordable here
       because the short buildings are batched into flat passes anyway
       and at three pixels tall almost none of them overlap. The towers
       still draw individually, in depth order, afterwards. */
    out.sort((p, q) => (Math.floor(p.cy / 96) - Math.floor(q.cy / 96)) || (p.cx - q.cx));
    return out;
  }

  /* ── Where the sun is ───────────────────────────────────────────────

     Buildings already lean away from the centre of the screen, which is
     what perspective does to a photograph taken from above. Shadows do
     not do that — they all run the same way, set by the sun. A real
     aerial photograph of a city shows both at once, so the two live
     together here without fighting.

     This is the standard low-precision solar position (the one SunCalc
     uses): good to a fraction of a degree, which is far beyond what a
     shadow a few pixels long can show. No data source, no network, no
     API — the sun's position over Austin is arithmetic. */
  const RAD = Math.PI / 180;

  function sunPosition(date, lat, lng) {
    const d = date.valueOf() / 86400000 - 0.5 + 2440588 - 2451545;
    const M = RAD * (357.5291 + 0.98560028 * d);
    const Ctr = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M)
                     + 0.0003 * Math.sin(3 * M));
    const L = M + Ctr + RAD * 102.9372 + Math.PI;
    const e = RAD * 23.4397;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
    const th = RAD * (280.16 + 360.9856235 * d) - RAD * -lng;
    const H = th - ra, phi = RAD * lat;
    const alt = Math.asin(Math.sin(phi) * Math.sin(dec)
                        + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    // Measured from due south, turning west; shifted to a compass bearing.
    const az = Math.atan2(Math.sin(H),
                          Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi))
             + Math.PI;
    return { alt: alt, az: az };
  }

  /* The palette follows the light.

     Austin at seven in the morning is not Austin at noon and is not
     Austin at ten at night, and a city that is the same colour at all
     three reads as a diagram. Everything below is keyed off the sun's
     altitude, so the change arrives at the right time on the right day
     without a table of sunrise times. */
  function skyState(map) {
    const c = map ? map.getCenter() : { lat: 30.2672, lng: -97.7431 };
    const s = sunPosition(new Date(), c.lat, c.lng);
    const altDeg = s.alt / RAD;
    /* -6° is civil twilight, the point where you would want headlights;
       full daylight colour is not reached until the sun is properly up,
       or the city snaps from night to noon within minutes of sunrise. */
    const day = Math.max(0, Math.min(1, (altDeg + 6) / 20));
    // Golden hour: low but up.
    const gold = altDeg > -2 && altDeg < 14
               ? 1 - Math.abs(altDeg - 6) / 8 : 0;
    return {
      alt: altDeg, az: s.az, day: day, gold: Math.max(0, gold),
      up: altDeg > -0.5,
      // Shadows stretch as the sun drops and are not drawn once it is
      // near the horizon, where the length runs away to infinity and
      // the whole screen turns into one smear.
      shadow: altDeg > 3 ? Math.min(6, 1 / Math.tan(Math.max(s.alt, 3 * RAD))) : 0
    };
  }

  /* Mix two hex colours. Cheap, and the inputs are constants. */
  function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const r = Math.round((pa >> 16) * (1 - t) + (pb >> 16) * t);
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  // Night, day and the half hour at either end of the day.
  const NIGHT = { wallLit: '#2c3a58', wallDim: '#1b2438', roof: '#3b4e74', roofHi: '#53709f' };
  const DAY   = { wallLit: '#8fa3c4', wallDim: '#5d6e8d', roof: '#aebdd6', roofHi: '#c8d5e8' };
  const GOLD  = { wallLit: '#c99a6b', wallDim: '#6b5645', roof: '#e0b483', roofHi: '#f2d3a7' };

  /* What fraction of a tower's windows are lit, by local hour. Offices
     empty through the evening and a few floors never go dark. */
  function lightsOn(t) {
    const CURVE = [0.10, 0.07, 0.05, 0.05, 0.06, 0.12, 0.28, 0.45,
                   0.55, 0.58, 0.58, 0.58, 0.58, 0.58, 0.58, 0.58,
                   0.56, 0.52, 0.50, 0.46, 0.40, 0.32, 0.24, 0.16];
    const i = Math.floor(t) % 24, f = t - Math.floor(t);
    return CURVE[i] * (1 - f) + CURVE[(i + 1) % 24] * f;
  }

  function palette(sky) {
    const p = {};
    for (const k of ['wallLit', 'wallDim', 'roof', 'roofHi']) {
      let c = mix(NIGHT[k], DAY[k], sky.day);
      if (sky.gold > 0) c = mixRGB(c, GOLD[k], sky.gold * 0.55);
      p[k] = c;
    }
    return p;
  }

  /* mix() takes hex; once a colour has been through it, it is rgb(). */
  function mixRGB(a, b, t) {
    const m = a.match(/\d+/g).map(Number);
    const pb = parseInt(b.slice(1), 16);
    const r = Math.round(m[0] * (1 - t) + (pb >> 16) * t);
    const g = Math.round(m[1] * (1 - t) + ((pb >> 8) & 255) * t);
    const bl = Math.round(m[2] * (1 - t) + (pb & 255) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  const WALL_LIT = '#2c3a58', WALL_DIM = '#1b2438', ROOF = '#3b4e74', ROOF_HI = '#53709f';

  /* Why the path is flushed every few dozen shapes.

     Building one canvas path out of every wall quad in view and filling
     it once looked like the obvious batching win. It was the opposite:
     a canvas path's cost is quadratic in the number of CLOSED SUBPATHS
     it holds, while the vertices inside them are nearly free. Measured
     on a blank canvas, same trivial quad repeated:

         500 →    2.7 ms      8 000 →   594.8 ms
       1 000 →    9.5 ms     16 000 → 2 622.3 ms
       2 000 →   41.6 ms     24 000 → 5 539.2 ms
       ...but 96 000 vertices in ONE subpath → 10.6 ms

     Twenty-four thousand wall quads in one path is five and a half
     seconds of path building — before a single pixel is filled (the
     fill itself measured 0.6 ms). That is the zoom lag, and it was my
     own optimization that introduced it.

     Flushing keeps every path short, so the quadratic never gets going:
     the same 24 000 quads cost 21.8 ms at a batch of 32 and 40.6 ms at
     128. Small batches mean more fill calls, so there is a floor; 48 is
     the flat part of the curve. */
  const BATCH = 48;

  /* Only the walls facing the way the building leans are visible; the
     rest are behind the roof. Culling them halves the quads and also
     fixes a real artefact — a back wall drawn after the roof of the
     building in front of it showed through as a dark smear. */
  /* The machine gets a vote.

     This runs on an iPhone 16 and on an Intel MacBook whose fans come
     on, and those are an order of magnitude apart. Rather than pick a
     budget for the slowest one, measure the draw and adjust: a draw
     over 60 ms lowers the detail, a run of draws under 20 ms raises it
     back, and it settles within a few settles either way. Nothing here
     is per-frame, so the measurement is cheap and the adjustment is
     never visible as a jump. */
  function adapt(ms) {
    C.drawMs = C.drawMs ? C.drawMs * 0.7 + ms * 0.3 : ms;
    if (C.drawMs > 60 && C.quality > 0.3) C.quality = Math.max(0.3, C.quality - 0.15);
    else if (C.drawMs < 20 && C.quality < 1) C.quality = Math.min(1, C.quality + 0.1);
  }

  function draw(map, resize) {
    if (!C.canvas) return;
    const t0 = performance.now();
    const dpr = resize === false
      ? Math.min(window.devicePixelRatio || 1, 2)
      : sizeCanvas(map, C.canvas);

    if (C.useGL) {
      const sky = C.sky || (C.sky = skyState(map));
      C.glStats = global.CITY3D._gl.render(map, C.canvas, sky, palette(sky));
      adapt(performance.now() - t0);
      return;
    }

    const ctx = C.ctx;
    const w = C.canvas.width / dpr, h = C.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!C.on || map.getZoom() < H.MIN_Z) return;

    const b = C.buildings || [];
    if (!b.length) return;

    /* The cache holds absolute layer coordinates so panning never
       invalidates it; the canvas is placed by translating the context
       once rather than by rewriting every vertex. */
    const origin = C.canvas._origin, pxO = map.getPixelOrigin();
    const sx = origin.x + pxO.x, sy = origin.y + pxO.y;
    ctx.save();
    ctx.translate(-sx, -sy);

    const ox = sx + w / 2, oy = sy + h / 2;
    const k = C.lift, hx = Math.max(w / 2, 1), hy = Math.max(h / 2, 1);
    const TALL = 26;

    const sky = C.sky || (C.sky = skyState(map));
    const P = palette(sky);
    /* The sun sits at a compass bearing, so on screen it lies toward
       (sin az, -cos az) — north being up. A shadow runs the other way. */
    const shx = -Math.sin(sky.az) * sky.shadow;
    const shy =  Math.cos(sky.az) * sky.shadow;

    /* Shadows first, under everything.

       One flat pass over the footprints, offset by the sun. They are
       drawn as the footprint rather than as a proper swept silhouette
       because at these lengths the difference is a pixel and the
       silhouette costs a subpath per edge — the thing that made this
       layer slow in the first place. */
    if (sky.shadow > 0) {
      ctx.fillStyle = 'rgba(8,12,20,' + (0.10 + 0.22 * sky.day).toFixed(3) + ')';
      let sn = 0;
      ctx.beginPath();
      for (const bl of b) {
        const dx = bl.h * shx, dy = bl.h * shy;
        const p = bl.pts, m = p.length;
        ctx.moveTo(p[0] + dx, p[1] + dy);
        for (let i = 2; i < m; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
        ctx.closePath();
        if (++sn >= BATCH) { ctx.fill(); ctx.beginPath(); sn = 0; }
      }
      if (sn) ctx.fill();
    }

    /* Pass one: the short buildings, which are most of them. Walls in
       one flushed run, then roofs in another, so the roofs all land on
       top of the walls without needing per-building ordering. At a
       median height of eight metres almost nothing overlaps anyway. */
    let n = 0;
    ctx.fillStyle = P.wallDim;
    ctx.beginPath();
    for (const bl of b) {
      if (bl.h >= TALL) continue;
      const dx = (bl.cx - ox) / hx * k * bl.h;
      const dy = (bl.cy - oy) / hy * k * bl.h - bl.h;
      const p = bl.pts, m = p.length;
      for (let i = 0; i < m; i += 2) {
        const j = (i + 2) % m;
        const ax = p[i], ay = p[i + 1], bx = p[j], by = p[j + 1];
        // Facing test: the edge is visible when its outward normal
        // points the same way the building leans.
        if ((bx - ax) * dy - (by - ay) * dx <= 0) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.lineTo(bx + dx, by + dy); ctx.lineTo(ax + dx, ay + dy);
        ctx.closePath();
        if (++n >= BATCH) { ctx.fill(); ctx.beginPath(); n = 0; }
      }
    }
    if (n) ctx.fill();

    n = 0;
    ctx.fillStyle = P.roof;
    ctx.beginPath();
    for (const bl of b) {
      if (bl.h >= TALL) continue;
      const dx = (bl.cx - ox) / hx * k * bl.h;
      const dy = (bl.cy - oy) / hy * k * bl.h - bl.h;
      const p = bl.pts, m = p.length;
      ctx.moveTo(p[0] + dx, p[1] + dy);
      for (let i = 2; i < m; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
      ctx.closePath();
      if (++n >= BATCH) { ctx.fill(); ctx.beginPath(); n = 0; }
    }
    if (n) ctx.fill();

    /* Pass two: the towers, drawn one at a time in depth order. There
       are about a hundred of them in a downtown view, so the per-shape
       cost is affordable and they are the ones that genuinely stand in
       front of each other. */
    for (const bl of b) {
      if (bl.h < TALL) continue;
      const dx = (bl.cx - ox) / hx * k * bl.h;
      const dy = (bl.cy - oy) / hy * k * bl.h - bl.h;
      const p = bl.pts, m = p.length;
      ctx.beginPath();
      for (let i = 0; i < m; i += 2) {
        const j = (i + 2) % m;
        const ax = p[i], ay = p[i + 1], bx = p[j], by = p[j + 1];
        if ((bx - ax) * dy - (by - ay) * dx <= 0) continue;
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
        ctx.lineTo(bx + dx, by + dy); ctx.lineTo(ax + dx, ay + dy);
        ctx.closePath();
      }
      ctx.fillStyle = P.wallLit; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(p[0] + dx, p[1] + dy);
      for (let i = 2; i < m; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
      ctx.closePath();
      ctx.fillStyle = P.roofHi; ctx.fill();
      ctx.strokeStyle = 'rgba(10,14,22,' + (0.55 - 0.3 * sky.day).toFixed(2) + ')';
      ctx.lineWidth = 0.6; ctx.stroke();
    }

    /* Lit windows, after dark, on the towers only.

       Downtown holds about a hundred buildings tall enough to count as
       towers in a given view, and they are the ones whose walls are
       big enough on screen to put windows on. Doing it for all 2,500
       would cost thousands of subpaths for marks a pixel across.

       Which windows are lit is decided by a hash of the building's
       position, not by Math.random, so they stay lit between frames
       instead of flickering. How many are lit follows the hour: most
       of a tower is on at eight in the evening and little of it is at
       four in the morning. */
    if (sky.day < 0.5) {
      const st = C.clock || (C._cars && C._cars.clockState()) || { t: 20 };
      const occ = lightsOn(st.t) * (1 - sky.day * 2);
      if (occ > 0.02) {
        ctx.fillStyle = 'rgba(255,214,140,' + (0.75 * (1 - sky.day * 2)).toFixed(2) + ')';
        let wn = 0;
        ctx.beginPath();
        for (const bl of b) {
          if (bl.h < TALL) continue;
          const dx = (bl.cx - ox) / hx * k * bl.h;
          const dy = (bl.cy - oy) / hy * k * bl.h - bl.h;
          const p = bl.pts, m = p.length;
          let seed = (bl.cx * 73856093 ^ bl.cy * 19349663) >>> 0;
          const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
          for (let i = 0; i < m; i += 2) {
            const j = (i + 2) % m;
            const ax = p[i], ay = p[i + 1], bx = p[j], by = p[j + 1];
            if ((bx - ax) * dy - (by - ay) * dx <= 0) continue;
            const wide = Math.hypot(bx - ax, by - ay);
            const cols = Math.min(6, Math.floor(wide / 5));
            const rows = Math.min(9, Math.floor(bl.h / 7));
            const lim = bl.dark ? occ * (1 - bl.dark) : occ;
            for (let cI = 0; cI < cols; cI++) for (let rI = 0; rI < rows; rI++) {
              if (rnd() > lim) continue;
              const u = (cI + 0.5) / cols, v = (rI + 0.5) / rows;
              const px = ax + (bx - ax) * u + dx * v;
              const py = ay + (by - ay) * u + dy * v;
              ctx.rect(px - 0.7, py - 0.9, 1.4, 1.8);
              if (++wn >= BATCH) { ctx.fill(); ctx.beginPath(); wn = 0; }
            }
          }
        }
        if (wn) ctx.fill();
      }
    }
    ctx.restore();
    adapt(performance.now() - t0);
  }

  global.CITY3D._draw = { ensurePanes, sizeCanvas, collect, draw,
                          skyState, sunPosition, palette, lightsOn };
})(window);

/* ── The buildings, on the GPU ───────────────────────────────────────

   Why this exists, when there is a perfectly good 2D renderer below it.

   The 2D one rebuilds every path on the CPU each time the view settles
   and rasterises them into a canvas the size of the window. That work
   is proportional to what is on screen, every single time, and no
   amount of tuning changes the shape of it — it went from 5,267 ms to
   21 ms across several rounds and still made zooming feel wrong on an
   older machine.

   Google Maps does not do that, which is the fair question to ask. It
   uploads geometry to the GPU once and then a zoom is a matrix: the CPU
   sends four numbers and the GPU redraws. That is what this does.

   The geometry is stored per tile in TILE-LOCAL coordinates, so it never
   changes — not when you pan, not when you zoom, not ever. It is
   uploaded to a vertex buffer the first time a tile is seen and then
   reused for the life of the page. A settle costs one uniform update
   and one draw call per visible tile.

   Two details that matter and are easy to get wrong:

   - PRECISION. Web Mercator world pixels at zoom 16 run to about 3.8
     million, and a float32 has ~24 bits of mantissa, so storing world
     coordinates directly loses about a quarter-pixel. Everything here
     is tile-local (0..4096) and the tile's own offset is computed in
     JavaScript doubles and handed over as a small number.

   - DEPTH. A 2.5D extrusion has no camera, so there is no free
     occlusion. Each building gets a depth from where its centroid
     lands on screen — lower on screen is nearer — which is the
     painter's ordering the 2D version had to do by sorting, done by
     the depth buffer instead, correctly and for nothing. */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers;

  const VERT = `
    attribute vec2 aPos;      // tile-local, 0..extent
    attribute vec2 aCen;      // building centroid, tile-local
    attribute float aTop;     // 0 at the footprint, 1 at the roof
    attribute float aH;       // height in metres
    attribute float aShade;   // 0 wall, 1 roof
    attribute vec2 aEdge;     // wall direction; (0,0) on roof vertices
    uniform vec2 uOff;        // where this tile's origin sits, in screen px
    uniform float uTileScale; // tile units -> screen px
    uniform vec2 uViewport;   // css px
    uniform vec2 uCentre;     // screen centre, px
    uniform vec2 uHalf;       // half the canvas, px
    uniform float uLift;
    uniform float uMpp;       // metres per pixel
    uniform float uMode;      // 0 buildings, 1 shadows
    uniform vec2 uSun;        // shadow direction, px per px of height
    varying float vShade;
    varying float vH;
    void main() {
      vec2 base = uOff + aPos * uTileScale;
      vec2 cen  = uOff + aCen * uTileScale;
      float hpx = aH / uMpp;
      // The same lean the 2D renderer uses: away from the middle of the
      // screen, proportional to height, plus straight up by the height.
      vec2 lean = (cen - uCentre) / uHalf * uLift * hpx + vec2(0.0, -hpx);
      vShade = aShade;
      vH = hpx;

      /* The shadow pass reuses this very buffer. Only the roof
         triangles are wanted — they are the building's outline — so the
         wall vertices are pushed outside the clip volume rather than
         kept in a second buffer. A degenerate triangle costs nothing;
         a duplicate copy of every building in Austin costs 7 MB. */
      if (uMode > 0.5) {
        if (aShade < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
        vec2 sp = base + uSun * hpx;
        gl_Position = vec4((sp / uViewport) * 2.0 - 1.0, 0.999, 1.0);
        gl_Position.y = -gl_Position.y;
        return;
      }

      /* Only the walls facing the way the building leans are visible.
         The 2D renderer culled these on the CPU; the test has to live
         here because which way a wall faces depends on where the tile
         has landed on screen, which is not known when the buffer is
         built. Half the triangles, and it stops a back wall showing
         through a neighbour that shares its depth. */
      if (aShade < 0.5 && (aEdge.x * lean.y - aEdge.y * lean.x) <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;
      }

      vec2 p = base + aTop * lean;
      // Lower on screen is nearer. Roofs sit a hair in front of their
      // own walls so the two never fight over the same pixel.
      float depth = 1.0 - clamp(cen.y / uViewport.y, 0.0, 1.0)
                  - aShade * 0.0008;
      gl_Position = vec4((p / uViewport) * 2.0 - 1.0, depth, 1.0);
      gl_Position.y = -gl_Position.y;
    }`;

  const FRAG = `
    precision mediump float;
    varying float vShade;
    varying float vH;
    uniform vec3 uWallDim, uWallLit, uRoof, uRoofHi;
    /* highp, explicitly. A uniform shared between the two shaders must
       agree on precision, and a float in the vertex shader is highp by
       default while this file declares mediump down here — so leaving
       it unqualified fails at link time with "Precisions of uniform
       'uMode' differ", which is a link error and not a compile one, so
       both shaders compile perfectly on their own first. */
    uniform highp float uMode;
    uniform float uShadowA;
    void main() {
      if (uMode > 0.5) { gl_FragColor = vec4(0.03, 0.05, 0.08, uShadowA); return; }
      // Tall buildings get the lit treatment, short ones the flat one,
      // which is the same distinction the 2D renderer draws at 26 px.
      // Narrower than the old smoothstep: a wide blend left every
      // mid-height building a muddy average of two palettes, where the
      // 2D renderer had a clean cut at 26 px.
      float tall = smoothstep(24.0, 28.0, vH);
      vec3 wall = mix(uWallDim, uWallLit, tall);
      vec3 roof = mix(uRoof, uRoofHi, tall);
      gl_FragColor = vec4(mix(wall, roof, vShade), 1.0);
    }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  /* Ear clipping, because a roof is not always convex.

     The 2D renderer got concave footprints right for free — canvas fill
     uses the nonzero winding rule. A GPU wants triangles, and a fan from
     the centroid quietly fills in the notch of every L-shaped building.
     This is the small price of moving to the GPU, paid once per tile. */
  function earcut(pts) {
    const n = pts.length / 2;
    if (n < 3) return [];
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(i);
    // Work in a consistent winding so the "is this ear convex" test has
    // one answer rather than two.
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += (pts[j * 2] - pts[i * 2]) * (pts[j * 2 + 1] + pts[i * 2 + 1]);
    }
    if (area < 0) idx.reverse();

    const tri = [];
    const cross = (a, b, c) =>
      (pts[b * 2] - pts[a * 2]) * (pts[c * 2 + 1] - pts[a * 2 + 1])
    - (pts[b * 2 + 1] - pts[a * 2 + 1]) * (pts[c * 2] - pts[a * 2]);
    const inside = (a, b, c, p) =>
      cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;

    let guard = idx.length * idx.length;
    while (idx.length > 3 && guard-- > 0) {
      let clipped = false;
      for (let i = 0; i < idx.length; i++) {
        const a = idx[(i + idx.length - 1) % idx.length];
        const b = idx[i];
        const c = idx[(i + 1) % idx.length];
        if (cross(a, b, c) <= 0) continue;          // reflex, not an ear
        let ok = true;
        for (const p of idx) {
          if (p === a || p === b || p === c) continue;
          if (inside(a, b, c, p)) { ok = false; break; }
        }
        if (!ok) continue;
        tri.push(a, b, c);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped) break;      // degenerate ring; take what we have
    }
    if (idx.length === 3) tri.push(idx[0], idx[1], idx[2]);
    return tri;
  }

  /* One interleaved buffer per tile: [x, y, cx, cy, top, h, shade].
     Built once, on the CPU, the first time the tile is drawn. */
  const STRIDE = 9;   // x, y, cx, cy, top, h, shade, ex, ey
  const WSTRIDE = 9;     // x, y, cx, cy, ex, ey, h, v, r

  /* Height cut-offs, metres, tallest first — and the zoom at which
     each becomes the floor. Zoom 15 shows only what would be a landmark
     from a mile up; by 17 everything is drawn. */
  const CUTS = [30, 14, 0];
  const CUT_ZOOM = { 15: 0, 16: 1 };      // anything else: 2, meaning all

  function buildTile(gl, t) {
    const lay = t.buildings;
    const tiers = [];
    const ext = (lay && lay.extent) || H.EXTENT_FALLBACK;
    const data = [], win = [];
    let nBuild = 0, nReal = 0;
    /* Tallest first.

       At zoom 15 a tile's worth of buildings is eleven thousand shapes
       two or three pixels tall, which is not a skyline, it is noise —
       and it was noise the old renderer never showed because it capped
       at 2,200 and sorted by height. Emitting in descending height
       means a PREFIX of this buffer is always "the buildings big
       enough to be worth drawing", so the zoom can pick a cut-off with
       a single draw-count and no per-frame sorting. */
    const feats = [];
    if (lay) {
      for (const f of lay.features) {
        if (f.type !== 3) continue;
        const kind = f.props.kind;
        if (kind !== 'building' && kind !== 'building_part') continue;
        const real = f.props.height != null;
        const hM = real ? +f.props.height : H.guessHeight(f.id || 1);
        feats.push({ f: f, real: real, hM: hM });
      }
      feats.sort((a, b) => b.hM - a.hM);
      const marks = [];
      for (const { f, real, hM } of feats) {
        for (const ring of f.rings) {
          if (ring.length < 8) continue;
          nBuild++; if (real) nReal++;
          let cx = 0, cy = 0;
          const n = ring.length / 2;
          for (let i = 0; i < ring.length; i += 2) { cx += ring[i]; cy += ring[i + 1]; }
          cx /= n; cy /= n;

          const push = (x, y, top, shade, ex, ey) =>
            data.push(x, y, cx, cy, top, hM, shade, ex || 0, ey || 0);

          // Walls: a quad per edge, as two triangles. Every edge, not
          // only the ones facing out — the depth buffer sorts it, and a
          // facing test would have to move to the shader anyway since
          // the lean direction depends on where the tile is on screen.
          for (let i = 0; i < ring.length; i += 2) {
            const j = (i + 2) % ring.length;
            const ax = ring[i], ay = ring[i + 1], bx = ring[j], by = ring[j + 1];
            const ex = bx - ax, ey = by - ay;
            push(ax, ay, 0, 0, ex, ey); push(bx, by, 0, 0, ex, ey); push(bx, by, 1, 0, ex, ey);
            push(ax, ay, 0, 0, ex, ey); push(bx, by, 1, 0, ex, ey); push(ax, ay, 1, 0, ex, ey);
          }
          /* Windows, for anything that could plausibly show them.
             15 m is about five storeys; below that the shader would
             hide them at every zoom this layer draws at anyway. */
          if (hM >= 15) {
            let seed = ((cx * 73856093) ^ (cy * 19349663) ^ (ring.length * 83492791)) >>> 0;
            const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            const rows = Math.max(2, Math.min(10, Math.round(hM / 4)));
            for (let i = 0; i < ring.length; i += 2) {
              const j = (i + 2) % ring.length;
              const ax = ring[i], ay = ring[i + 1], bx = ring[j], by = ring[j + 1];
              const ex = bx - ax, ey = by - ay;
              // Tile units, so this is a length in tile space; the
              // column count follows the wall's real proportions.
              const cols = Math.max(1, Math.min(7,
                Math.round(Math.hypot(ex, ey) / (ext / 420))));
              for (let cI = 0; cI < cols; cI++) {
                for (let rI = 0; rI < rows; rI++) {
                  const u = (cI + 0.5) / cols, v = (rI + 0.5) / rows;
                  win.push(ax + ex * u, ay + ey * u, cx, cy, ex, ey, hM, v, rnd());
                }
              }
            }
          }

          // Roof
          const flat = [];
          for (let i = 0; i < ring.length; i += 2) flat.push(ring[i], ring[i + 1]);
          for (const k of earcut(flat)) push(flat[k * 2], flat[k * 2 + 1], 1, 1, 0, 0);
          marks.push({ h: hM, at: data.length / STRIDE });
        }
      }
      // Where the buffer crosses each height, so a zoom can stop there.
      for (const cut of CUTS) {
        let at = 0;
        for (const m of marks) { if (m.h >= cut) at = m.at; else break; }
        tiers.push(at);
      }
    }
    const arr = new Float32Array(data);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);

    const warr = new Float32Array(win);
    let wbuf = null;
    if (warr.length) {
      wbuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, wbuf);
      gl.bufferData(gl.ARRAY_BUFFER, warr, gl.STATIC_DRAW);
    }
    const count = arr.length / STRIDE;
    return {
      buf: buf, count: count, extent: ext,
      wbuf: wbuf, wcount: warr.length / WSTRIDE,
      bytes: arr.byteLength + warr.byteLength,
      buildings: nBuild, real: nReal, tiers: tiers,
      drawCount: function (z) {
        const i = CUT_ZOOM[z];
        return i == null ? count : (this.tiers[i] || 0);
      }
    };
  }

  /* Lit windows, as GL points.

     A separate buffer from the walls, because a window is one vertex
     and a wall is six, and because only the buildings tall enough to
     show them are worth generating at all. "Tall enough" has to be
     decided in metres rather than pixels here — the geometry is built
     once and never rebuilt, so it cannot know the zoom — and the
     shader hides windows on anything that turns out to be small on
     screen.

     Which windows are lit is a per-window random number baked into the
     buffer and compared against an occupancy uniform, so the pattern is
     fixed for the life of the page (no flicker between frames) while
     the number lit still follows the hour. */
  const WVERT = `
    attribute vec2 aPos;
    attribute vec2 aCen;
    attribute vec2 aEdge;
    attribute float aH;
    attribute float aV;
    attribute float aR;
    uniform vec2 uOff;
    uniform float uTileScale, uLift, uMpp, uOcc, uDpr;
    uniform vec2 uViewport, uCentre, uHalf;
    void main() {
      float hpx = aH / uMpp;
      vec2 base = uOff + aPos * uTileScale;
      vec2 cen  = uOff + aCen * uTileScale;
      vec2 lean = (cen - uCentre) / uHalf * uLift * hpx + vec2(0.0, -hpx);
      // Not lit, too short on screen to read, or on a wall facing away.
      float side = (aEdge.x * lean.y) - (aEdge.y * lean.x);
      if (aR > uOcc || hpx < 16.0 || side <= 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return;
      }
      vec2 p = base + lean * aV;
      float depth = 1.0 - clamp(cen.y / uViewport.y, 0.0, 1.0) - 0.0016;
      gl_Position = vec4((p / uViewport) * 2.0 - 1.0, depth, 1.0);
      gl_Position.y = -gl_Position.y;
      gl_PointSize = max(1.0, 1.6 * uDpr);
    }`;

  const WFRAG = `
    precision mediump float;
    uniform vec3 uGlow;
    uniform float uAlpha;
    void main() { gl_FragColor = vec4(uGlow, uAlpha); }`;

  const G = { gl: null, prog: null, wprog: null, wloc: {}, loc: {},
              tiles: new Map(), bytes: 0, dead: false, err: null };

  function hex(c) {
    const v = parseInt(c.slice(1), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  function rgbOf(s) {
    if (s[0] === '#') return hex(s);
    const m = s.match(/\d+/g).map(Number);
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }

  function init(canvas) {
    if (G.dead) return null;
    if (G.gl) return G.gl;
    let gl = null;
    try {
      /* No MSAA.

         A 2700x1800 drawing buffer at 4x samples is a lot of memory to
         resolve, and the browser resolves it whenever the layer is
         composited — including every frame of a zoom, while the canvas
         is being CSS-scaled and nothing has even been redrawn. At
         device-pixel-ratio 2 the edges are already sampled twice per
         CSS pixel and the difference is hard to see; the cost is not. */
      const opts = { alpha: true, antialias: false, depth: true,
                     premultipliedAlpha: true, powerPreference: 'low-power',
                     desynchronized: true };
      gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    } catch (e) { gl = null; }
    if (!gl) {
      G.dead = true;
      G.err = 'no webgl context (the browser refused one — often too many '
            + 'live contexts on the page)';
      return null;
    }
    try {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('link: ' + gl.getProgramInfoLog(p));
      }
      G.prog = p;
      for (const a of ['aPos', 'aCen', 'aTop', 'aH', 'aShade', 'aEdge']) {
        G.loc[a] = gl.getAttribLocation(p, a);
      }
      const wp = gl.createProgram();
      gl.attachShader(wp, compile(gl, gl.VERTEX_SHADER, WVERT));
      gl.attachShader(wp, compile(gl, gl.FRAGMENT_SHADER, WFRAG));
      gl.linkProgram(wp);
      if (!gl.getProgramParameter(wp, gl.LINK_STATUS)) {
        throw new Error('window link: ' + gl.getProgramInfoLog(wp));
      }
      G.wprog = wp;
      for (const a of ['aPos', 'aCen', 'aEdge', 'aH', 'aV', 'aR']) {
        G.wloc[a] = gl.getAttribLocation(wp, a);
      }
      for (const u of ['uOff', 'uTileScale', 'uLift', 'uMpp', 'uOcc', 'uDpr',
                       'uViewport', 'uCentre', 'uHalf', 'uGlow', 'uAlpha']) {
        G.wloc[u] = gl.getUniformLocation(wp, u);
      }
      for (const u of ['uOff', 'uTileScale', 'uViewport', 'uCentre', 'uHalf',
                       'uLift', 'uMpp', 'uWallDim', 'uWallLit', 'uRoof', 'uRoofHi',
                       'uMode', 'uSun', 'uShadowA']) {
        G.loc[u] = gl.getUniformLocation(p, u);
      }
    } catch (e) {
      G.dead = true; G.gl = null;
      G.err = String((e && e.message) || e);
      try { gl.getExtension('WEBGL_lose_context') &&
            gl.getExtension('WEBGL_lose_context').loseContext(); } catch (e2) {}
      return null;
    }
    /* A lost context is a normal thing on a laptop that sleeps, and the
       renderer has to come back from it rather than leaving a blank
       pane. Every buffer is gone when it happens, so the cache goes too
       and the tiles re-upload on the next draw. */
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); G.tiles.clear(); G.bytes = 0; G.gl = null; G.prog = null;
    });
    canvas.addEventListener('webglcontextrestored', () => { init(canvas); });
    G.gl = gl;
    return gl;
  }

  /* One draw call per visible tile. No CPU geometry work at all: the
     buffers were built when the tile arrived and the only thing that
     changes between frames is the handful of uniforms below. */
  function render(map, canvas, sky, palette) {
    const gl = init(canvas);
    if (!gl) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.width / dpr, h = canvas.height / dpr;

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1.0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const z = map.getZoom();
    if (!C.on || z < H.MIN_Z) return { tiles: 0, verts: 0 };

    gl.useProgram(G.prog);
    gl.uniform2f(G.loc.uViewport, w, h);
    gl.uniform2f(G.loc.uHalf, Math.max(w / 2, 1), Math.max(h / 2, 1));
    gl.uniform1f(G.loc.uLift, C.lift);
    gl.uniform3fv(G.loc.uWallDim, rgbOf(palette.wallDim));
    gl.uniform3fv(G.loc.uWallLit, rgbOf(palette.wallLit));
    gl.uniform3fv(G.loc.uRoof, rgbOf(palette.roof));
    gl.uniform3fv(G.loc.uRoofHi, rgbOf(palette.roofHi));

    const mpp = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180)
              / Math.pow(2, z + 8);
    gl.uniform1f(G.loc.uMpp, mpp);

    // Everything below is in canvas pixels, with the canvas origin as 0,0.
    const origin = canvas._origin, pxO = map.getPixelOrigin();
    const sx = origin.x + pxO.x, sy = origin.y + pxO.y;
    gl.uniform2f(G.loc.uCentre, w / 2, h / 2);

    let drawn = 0, verts = 0, nb = 0, nr = 0;
    const bound = [];
    for (const a of ['aPos', 'aCen', 'aTop', 'aH', 'aShade', 'aEdge']) {
      if (G.loc[a] >= 0) gl.enableVertexAttribArray(G.loc[a]);
    }
    for (const [tz, tx, ty] of H.visibleTiles(map)) {
      const key = tz + '/' + tx + '/' + ty;
      const t = C.tiles.get(key);
      if (!t) continue;
      let g = G.tiles.get(key);
      if (!g) {
        g = buildTile(gl, t);
        /* An empty buffer is not worth keeping. A tile can be empty
           because the archive has nothing there, or because the fetch
           failed and left a hollow entry behind — and caching the
           second kind is how a blank skyline becomes permanent. Empty
           ones are cheap to rebuild, so they are simply not cached. */
        if (!g.count) {
          gl.deleteBuffer(g.buf);
          if (g.wbuf) gl.deleteBuffer(g.wbuf);
          continue;
        }
        G.tiles.set(key, g);
        G.bytes += g.bytes;
        /* Geometry is zoom-independent, so a tile is uploaded once and
           then kept. The budget is bytes rather than tiles because a
           downtown tile is worth thirty of a rural one. */
        while (G.bytes > 48 * 1024 * 1024 && G.tiles.size > 8) {
          const k0 = G.tiles.keys().next().value, g0 = G.tiles.get(k0);
          gl.deleteBuffer(g0.buf);
          if (g0.wbuf) gl.deleteBuffer(g0.wbuf);
          G.bytes -= g0.bytes; G.tiles.delete(k0);
        }
      }
      const tileScale = 256 * Math.pow(2, z - tz);
      // Doubles here, a small number out: the tile's corner relative to
      // the canvas, never a raw world coordinate.
      g._ox = tx * tileScale - sx;
      g._oy = ty * tileScale - sy;
      g._ts = tileScale / g.extent;
      g._dc = g.drawCount(z);
      if (!g._dc) continue;

      bound.push(g);
      drawn++; verts += g._dc;
      // Report what is drawn, not what is stored: the readout saying
      // eleven thousand buildings while showing two was its own small lie.
      nb += Math.round(g.buildings * (g._dc / Math.max(1, g.count)));
      nr += Math.round(g.real * (g._dc / Math.max(1, g.count)));
    }

    /* Two passes over the same buffers.

       Shadows first, flat and translucent, with the depth buffer read
       but not written — otherwise a shadow would occlude the building
       standing in it. Then the buildings, opaque, writing depth. */
    const sun = sky.shadow > 0
      ? [-Math.sin(sky.az) * sky.shadow, Math.cos(sky.az) * sky.shadow] : null;
    for (const pass of (sun ? [1, 0] : [0])) {
      gl.uniform1f(G.loc.uMode, pass);
      if (pass === 1) {
        gl.uniform2f(G.loc.uSun, sun[0], sun[1]);
        gl.uniform1f(G.loc.uShadowA, 0.10 + 0.22 * sky.day);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      } else {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
      for (const g of bound) {
        gl.uniform2f(G.loc.uOff, g._ox, g._oy);
        gl.uniform1f(G.loc.uTileScale, g._ts);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
        const S = STRIDE * 4;
        gl.vertexAttribPointer(G.loc.aPos, 2, gl.FLOAT, false, S, 0);
        gl.vertexAttribPointer(G.loc.aCen, 2, gl.FLOAT, false, S, 8);
        gl.vertexAttribPointer(G.loc.aTop, 1, gl.FLOAT, false, S, 16);
        gl.vertexAttribPointer(G.loc.aH, 1, gl.FLOAT, false, S, 20);
        gl.vertexAttribPointer(G.loc.aShade, 1, gl.FLOAT, false, S, 24);
        gl.vertexAttribPointer(G.loc.aEdge, 2, gl.FLOAT, false, S, 28);
        gl.drawArrays(gl.TRIANGLES, 0, g._dc);
      }
    }
    gl.depthMask(true);

    /* Windows last, over the walls they belong to, and only after dark.
       They are additive rather than alpha-blended: a lit window is a
       light source, and adding it to the wall behind reads far more
       like one than painting over it does. */
    let winDrawn = 0;
    const occ = occFor(sky);
    if (occ > 0.02) {
      gl.useProgram(G.wprog);
      gl.uniform2f(G.wloc.uViewport, w, h);
      gl.uniform2f(G.wloc.uCentre, w / 2, h / 2);
      gl.uniform2f(G.wloc.uHalf, Math.max(w / 2, 1), Math.max(h / 2, 1));
      gl.uniform1f(G.wloc.uLift, C.lift);
      gl.uniform1f(G.wloc.uMpp, mpp);
      gl.uniform1f(G.wloc.uOcc, occ);
      gl.uniform1f(G.wloc.uDpr, dpr);
      gl.uniform3f(G.wloc.uGlow, 1.0, 0.84, 0.55);
      gl.uniform1f(G.wloc.uAlpha, 0.85 * (1 - sky.day * 2 < 0 ? 0 : 1 - sky.day * 2));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      for (const a of ['aPos', 'aCen', 'aEdge', 'aH', 'aV', 'aR']) {
        if (G.wloc[a] >= 0) gl.enableVertexAttribArray(G.wloc[a]);
      }
      for (const g of bound) {
        if (!g.wbuf || !g.wcount) continue;
        gl.uniform2f(G.wloc.uOff, g._ox, g._oy);
        gl.uniform1f(G.wloc.uTileScale, g._ts);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.wbuf);
        const W = WSTRIDE * 4;
        gl.vertexAttribPointer(G.wloc.aPos, 2, gl.FLOAT, false, W, 0);
        gl.vertexAttribPointer(G.wloc.aCen, 2, gl.FLOAT, false, W, 8);
        gl.vertexAttribPointer(G.wloc.aEdge, 2, gl.FLOAT, false, W, 16);
        gl.vertexAttribPointer(G.wloc.aH, 1, gl.FLOAT, false, W, 24);
        gl.vertexAttribPointer(G.wloc.aV, 1, gl.FLOAT, false, W, 28);
        gl.vertexAttribPointer(G.wloc.aR, 1, gl.FLOAT, false, W, 32);
        gl.drawArrays(gl.POINTS, 0, g.wcount);
        winDrawn += g.wcount;
      }
      for (const a of ['aPos', 'aCen', 'aEdge', 'aH', 'aV', 'aR']) {
        if (G.wloc[a] >= 0) gl.disableVertexAttribArray(G.wloc[a]);
      }
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }

    return { tiles: drawn, verts: verts, buildings: nb, real: nr,
             shadows: !!sun, windows: winDrawn,
             mb: +(G.bytes / 1048576).toFixed(1) };
  }

  /* How many windows are lit: the hour curve the 2D renderer uses,
     faded off as the sky brightens so they do not linger into daylight. */
  function occFor(sky) {
    if (sky.day >= 0.5) return 0;
    const st = C.clock || (C._cars && C._cars.clockState()) || { t: 20 };
    const D2 = global.CITY3D._draw;
    return D2.lightsOn(st.t) * (1 - sky.day * 2);
  }

  function drop(key) {
    const g = G.tiles.get(key);
    if (g && G.gl) {
      G.gl.deleteBuffer(g.buf);
      if (g.wbuf) G.gl.deleteBuffer(g.wbuf);
      G.bytes -= g.bytes; G.tiles.delete(key);
    }
  }

  global.CITY3D._gl = { init, render, drop, earcut, state: G };
})(window);

/* ── Invented traffic ───────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers, D = C._draw;

  const CAR_COLOURS = ['#c9d6ee', '#8ea3c6', '#ffd166', '#7e93b8'];

  /* How busy a road is, before any live data.

     Road class is the only volume proxy in the tiles, and it is a good
     one: a motorway carries orders of magnitude more traffic than a
     residential street, and OSM's classification is exactly that
     judgement. Free-flow speeds are the posted-ish speeds for each class
     in metres per second. */
  const CLASS = {
    highway:      { weight: 26, free: 31 },   // ~70 mph
    major_road:   { weight: 10, free: 18 },   // ~40 mph
    medium_road:  { weight: 4,  free: 13 },   // ~30 mph
    minor_road:   { weight: 1,  free: 9 }
  };

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
            lines.push({ ll: ll, cls: cls, len: len, kind: f.props.kind,
                         lat: mid[0], lng: mid[1], pct: 100 });
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
        const jam = 100 / Math.max(15, l.pct);
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
        l.w = l.len * l.cls.weight * jam * hitLoad * near;
        total += l.w;
        jamT += l.len * l.cls.weight * jam * hitLoad;
        // Not `near`: that one redistributes cars, it does not add any.
        // Folding it in here would raise the whole city's density
        // instead of concentrating it, which is the opposite.
        plain += l.len * l.cls.weight * hitLoad;
        out.push(l);
      }
    }
    C.roads = out;
    C.roadTotal = total;

    /* How much road is on the screen, measured in pixels rather than in
       metres.

       Getting this wrong is what emptied the streets. Density used to be
       roadTotal/9000, and roadTotal is a length in metres — which halves
       at every zoom step while the window stays exactly the same size.
       Downtown at zoom 15 got 261 cars; the same downtown at zoom 17 got
       57, of which 23 were on screen. Zoomed in far enough to see the
       buildings, the city looked abandoned.

       Weighted road-pixels is the measure that holds still: one car per
       ~2,600 of them gives downtown 265 at zoom 15 and 230 at zoom 17,
       which is the same street seen from two heights. */
    const mpp = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180)
              / Math.pow(2, map.getZoom() + 8);
    C.roadPx = plain / mpp;
    // Congestion adds cars, but on a square root: a corridor at 15% of
    // free-flow is not six and a half times as full as an empty one.
    C.jamLift = Math.sqrt(jamT / Math.max(plain, 1));
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

  /* Pick a road with probability proportional to its weight, so a
     motorway is chosen far more often than a side street without any
     per-road bookkeeping. */
  function pickRoad() {
    const rs = C.roads;
    if (!rs || !rs.length) return null;
    let r = Math.random() * C.roadTotal;
    for (let i = 0; i < rs.length; i++) { r -= rs[i].w; if (r <= 0) return rs[i]; }
    return rs[rs.length - 1];
  }

  /* Which way a car is pointed.

     Austin commutes, so the morning and the evening are not mirror
     images of each other: at eight in the morning the heavy direction
     is toward the centre and at half past five it is away from it. The
     model only knows one centre and one radius, which is crude, but the
     asymmetry itself is the honest part — an even split at rush hour is
     the thing that would be wrong. Off-peak and at weekends it is a
     coin toss, which is also what the streets look like. */
  function chooseDir(line, i) {
    const st = C.clock || (C.clock = clockState());
    if (!st.flow) return Math.random() < 0.5 ? 1 : -1;
    const a = line[i], b = line[Math.min(i + 1, line.length - 1)];
    if (!a || !b) return Math.random() < 0.5 ? 1 : -1;
    // Does travelling forward along this line get you closer to downtown?
    const da = Math.hypot(a[0] - DOWNTOWN[0], (a[1] - DOWNTOWN[1]) * 0.86);
    const db = Math.hypot(b[0] - DOWNTOWN[0], (b[1] - DOWNTOWN[1]) * 0.86);
    const inbound = db < da ? 1 : -1;
    // st.flow is +1 fully inbound, -1 fully outbound, 0 no preference;
    // at its strongest this is a 75/25 split, not 100/0.
    const p = 0.5 + 0.5 * st.flow * inbound * 0.5;
    return Math.random() < p ? 1 : -1;
  }

  function spawn() {
    const road = pickRoad();
    if (!road) return null;
    const line = road.ll;
    const i = 1 + ((Math.random() * Math.max(1, line.length - 2)) | 0);
    return { line: line, road: road, i: i,
             t: Math.random(), dir: chooseDir(line, i),
             v: road.cls.free * (road.pct / 100) * (0.75 + Math.random() * 0.5),
             c: CAR_COLOURS[(Math.random() * CAR_COLOURS.length) | 0] };
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
    if (!C.carsOn || map.getZoom() < H.MIN_Z - 1) return;

    // Density follows the road network on screen rather than a flat
    // number, so a motorway junction is busy and a quiet grid is quiet —
    // and a given street looks the same at every zoom. See harvestRoads
    // for why this counts pixels and not metres.
    const st = C.clock || (C.clock = clockState());
    const want = Math.max(4, Math.min(520,
                 Math.round((C.roadPx || 0) / 1500 * st.vol * (C.jamLift || 1))));
    while (C.cars.length < want) { const c = spawn(); if (!c) break; C.cars.push(c); }
    if (C.cars.length > want) C.cars.length = want;

    const r = map.getZoom() >= 17 ? 2.2 : 1.5;
    for (const c of C.cars) {
      const a = c.line[c.i], b2 = c.line[c.i + c.dir];
      if (!a || !b2) { const n = spawn(); if (n) Object.assign(c, n); continue; }
      const segM = Math.hypot((b2[1] - a[1]) * 96000, (b2[0] - a[0]) * 111320) || 1;
      c.t += (c.v * dt) / segM;
      while (c.t >= 1) {
        c.t -= 1; c.i += c.dir;
        if (c.i <= 0 || c.i >= c.line.length - 1) { const n = spawn(); if (n) Object.assign(c, n); break; }
      }
      const A = c.line[c.i], B = c.line[c.i + c.dir];
      if (!A || !B) continue;
      const p = map.latLngToLayerPoint([A[0] + (B[0] - A[0]) * c.t,
                                        A[1] + (B[1] - A[1]) * c.t]);
      const x = p.x - origin.x, y = p.y - origin.y;
      // A car that has driven off the screen is recycled rather than left
      // to motor away forever. Without this every car eventually ends up
      // wherever you have already been, and the road in front of you is
      // empty.
      if (x < -60 || y < -60 || x > w + 60 || y > h + 60) {
        const n = spawn(); if (n) Object.assign(c, n);
        continue;
      }
      ctx.fillStyle = c.c;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      // A pixel of slack each way so antialiasing leaves nothing behind.
      rects.push(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
    }

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
                      Math.round((C.waterLen || 0) / 900 * C.quality)));
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

  global.CITY3D._cars = { harvestRoads, harvestWater, stepCars, spawn, loadTraffic, trafficAt,
                          flowAt, dropSpeed,
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
  function live() { return C.on || C.carsOn; }

  async function refresh(map) {
    // Drop whatever transform the zoom animation left behind; sizeCanvas
    // is about to position this properly again.
    if (C.canvas) L.DomUtil.setTransform(C.canvas, L.point(0, 0), 1);
    if (!live()) { C.buildings = []; D.draw(map); return; }
    if (map.getZoom() < H.MIN_Z) {
      C.buildings = []; C.roads = []; C.water = [];
      D.draw(map); C.onNote && C.onNote(); return;
    }
    const want = H.visibleTiles(map);
    await Promise.all(want.map(([z, x, y]) => H.tile(z, x, y)));
    /* Position the canvas first. collect() projects against its origin,
       and draw() used to be what set that origin — so after a zoom every
       building was projected against the *previous* view's origin and
       came out shifted until the next settle corrected it. Order matters
       here and it did not look like it did. */
    D.sizeCanvas(map, C.canvas);
    C.clock = CAR.clockState();
    C.sky = D.skyState(map);
    // Only collect what is going to be drawn. With the buildings off
    // this skips the whole expensive half — projection, culling, sort.
    /* The GPU keeps its geometry in vertex buffers that were built when
       each tile arrived, so there is nothing to collect: a settle is a
       handful of uniforms and one draw call per tile. This line was the
       larger half of a 33 ms settle at zoom 15. */
    C.buildings = (C.on && !C.useGL) ? D.collect(map) : [];
    if (C.carsOn) {
      await CAR.loadTraffic();
      CAR.harvestRoads(map);
      CAR.harvestWater(map);
    }
    D.draw(map, false);
    C.onNote && C.onNote();
  }

  function scheduleRefresh(map) {
    clearTimeout(settle);
    settle = setTimeout(() => refresh(map), 180);
  }

  function frame(map) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - (C.last || now)) / 1000);
    C.last = now;
    // Not while the map is animating: the frames are wanted by the zoom,
    // and two hundred squares drawn behind it help nobody.
    if (!document.hidden && C.carsOn && !C.zooming) CAR.stepCars(map, dt);
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
    map.on('zoomanim', e => {
      const cv = C.canvas;
      if (!cv || !C.on) return;   // only the building canvas is scaled
      const scale = map.getZoomScale(e.zoom, map.getZoom());
      const offset = map._latLngToNewLayerPoint(
        map.layerPointToLatLng(cv._origin || L.point(0, 0)), e.zoom, e.center);
      L.DomUtil.setTransform(cv, offset, scale);
      // The cars are redrawn every frame from live coordinates, so they
      // need no transform — but they must not be left behind a stale one.
      if (C.carCanvas) L.DomUtil.setTransform(C.carCanvas, L.point(0, 0), 1);
    });

    map.on('moveend zoomend resize', () => scheduleRefresh(map));
    if (!C.raf) frame(map);
  };

  // The skyline.
  C.setOn = function (map, on) {
    C.on = !!on;
    if (!C.on) C.buildings = [];
    if (live()) refresh(map);
    else { C.cars.length = 0; C.drops.length = 0; C.carWipe = true;
           D.draw(map); CAR.stepCars(map, 0); }
  };

  // The traffic, the water and the emergency lights.
  C.setCars = function (map, on) {
    C.carsOn = !!on;
    if (!C.carsOn) {
      C.cars.length = 0; C.drops.length = 0; C.roads = []; C.water = [];
      C.carWipe = true; CAR.stepCars(map, 0);
    }
    if (live()) refresh(map);
    else D.draw(map);
  };

  /* The page owns the outage poll; this just receives the result.
     `pct` is the share of that ZIP's customers who are out, 0-1. */
  /* Where the reader is standing, when they have asked the page to
     say. Used only to weight detail toward them; never sent anywhere. */
  /* USGS discharge, handed over by the creek-gauge layer so the page
     does not ask twice. `cfs` is cubic feet per second. */
  /* Calls AFD is on right now, from the dispatch layer the page
     already polls. `off` spreads the flashes so a row of them does not
     strobe in unison. */
  C.setAlarms = function (map, list) {
    C.alarms = (list || []).filter(a => a && isFinite(a.lat) && isFinite(a.lng))
      .slice(0, 40)
      .map((a, i) => ({ lat: a.lat, lng: a.lng, off: (i * 0.37) % 1 }));
  };

  C.setFlow = function (map, gauges) {
    C.gauges = (gauges || []).filter(g => g && isFinite(g.cfs) && isFinite(g.lat));
    for (const [, lines] of C.waterCache) for (const l of lines) l.cfs = undefined;
    if (C.on && map) scheduleRefresh(map);
  };

  C.setHere = function (map, lat, lng) {
    C.here = (lat == null) ? null : { lat: lat, lng: lng };
    if (C.on && map) scheduleRefresh(map);
  };

  C.setBlackouts = function (map, list) {
    C.blackouts = (list || []).filter(b => b && b.pct > 0 && b.rings && b.rings.length);
    C.boZoom = null;
    if (C.on && map) scheduleRefresh(map);
  };

  /* One readout per switch, so each row describes its own half. */
  C.status = function (map, which) {
    const buildings = which !== 'cars';
    if (buildings && !C.on) return 'Off';
    if (!buildings && !C.carsOn) return 'Off';
    if (map.getZoom() < H.MIN_Z) {
      return buildings ? 'Zoom past ' + H.MIN_Z + ' to raise the buildings'
                       : 'Zoom past ' + H.MIN_Z + ' to put traffic on the streets';
    }
    const bits = [];

    /* The skyline row says what it is and stops there. Blackouts belong
       to it rather than to the traffic: what an outage changes on this
       map is which windows are lit, and windows are buildings. */
    if (buildings) {
      let n, real;
      if (C.useGL) {
        const g = C.glStats || {};
        n = g.buildings || 0; real = g.real || 0;
      } else {
        const b = C.buildings || [];
        n = b.length; real = b.filter(x => x.real).length;
      }
      if (!n) {
        return C.tileErr ? 'The building archive did not answer \u2014 pan to retry'
                         : 'No buildings mapped here';
      }
      bits.push(n.toLocaleString() + ' buildings',
                Math.round(100 * real / n) + '% at their real height');
      if (C.useGL && C.glStats) {
        bits.push('drawn on the GPU, ' + (C.glStats.verts / 1000).toFixed(0)
          + 'k triangles' + (C.glStats.mb ? ' \u00b7 ' + C.glStats.mb + ' MB cached' : ''));
      }
      if (C.blackouts.length) {
        const worst = Math.round(100 * Math.max.apply(null, C.blackouts.map(x => x.pct)));
        bits.push('lights out in ' + C.blackouts.length + ' ZIP'
          + (C.blackouts.length === 1 ? '' : 's') + ', worst ' + worst + '% of customers');
      }
      return bits.join(' \u00b7 ');
    }

    const roads = C.roads || [];
    if (roads.length) {
      const pct = Math.round(roads.reduce((a, r) => a + r.pct, 0) / roads.length);
      bits.push((C.cars || []).length + ' vehicles moving at ' + pct + '% of free-flow');
    }

    /* Say where the numbers come from. The hour is measured, the
       weekend is not, and the reader should be able to tell which is
       which without reading the source. */
    const st = C.clock;
    if (st) {
      const hh = (st.hour < 10 ? '0' : '') + st.hour
               + ':' + (st.min < 10 ? '0' : '') + st.min;
      const peak = st.cong > 0.66 ? 'peak' : st.cong > 0.3 ? 'building'
                 : st.cong > 0.12 ? 'light' : 'quiet';
      bits.push(hh + ' in Austin, ' + peak
        + (st.weekend ? ' (weekend curve is estimated — the archive has no weekend in it yet)'
                      : ' (modelled on this archive\u2019s own jam records)'));
      if (st.flow > 0.25) bits.push('morning flow runs inbound');
      else if (st.flow < -0.25) bits.push('evening flow runs outbound');
    }
    const inc = C.traffic && C.traffic.incidents;
    if (inc) bits.push(inc + ' live incidents on the network');
    if (C.alarms.length) bits.push(C.alarms.length + ' call'
      + (C.alarms.length === 1 ? '' : 's') + ' AFD is on right now');
    if (!bits.length) return 'Nothing to drive on here';
    return bits.join(' · ');
  };

})(window);
