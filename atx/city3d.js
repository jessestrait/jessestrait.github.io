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
    quality: 1, drawMs: 0, blackouts: [], boZoom: null, here: null,
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
      let parsed = { buildings: null, roads: null };
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
          roads: global.MVT.decodeLayer(buf, 'roads')
        };
      }
      CITY.tiles.set(key, parsed);
      // A few hundred tiles is plenty; central Austin is a handful.
      if (CITY.tiles.size > 220) CITY.tiles.delete(CITY.tiles.keys().next().value);
      return parsed;
    } catch (e) {
      CITY.tiles.set(key, { buildings: null, roads: null });
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
    C.canvas = mk('cityPane'); C.ctx = C.canvas.getContext('2d');
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
    if (!C.on || !C.carsOn || map.getZoom() < H.MIN_Z - 1) return;

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
  }

  global.CITY3D._cars = { harvestRoads, stepCars, spawn, loadTraffic, trafficAt,
                          clockState, austinClock, CLASS, CONGEST_WD, VOLUME_WD };
})(window);

/* ── Wiring it to the map ───────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers, D = C._draw, CAR = C._cars;
  let settle = null;

  async function refresh(map) {
    // Drop whatever transform the zoom animation left behind; sizeCanvas
    // is about to position this properly again.
    if (C.canvas) L.DomUtil.setTransform(C.canvas, L.point(0, 0), 1);
    if (!C.on) { D.draw(map); return; }
    if (map.getZoom() < H.MIN_Z) { C.buildings = []; D.draw(map); C.onNote && C.onNote(); return; }
    const want = H.visibleTiles(map);
    await Promise.all(want.map(([z, x, y]) => H.tile(z, x, y)));
    /* Position the canvas first. collect() projects against its origin,
       and draw() used to be what set that origin — so after a zoom every
       building was projected against the *previous* view's origin and
       came out shifted until the next settle corrected it. Order matters
       here and it did not look like it did. */
    D.sizeCanvas(map, C.canvas);
    C.buildings = D.collect(map);
    C.clock = CAR.clockState();
    C.sky = D.skyState(map);
    await CAR.loadTraffic();
    CAR.harvestRoads(map);
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
    if (!document.hidden && C.on && !C.zooming) CAR.stepCars(map, dt);
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
      if (!cv || !C.on) return;
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

  C.setOn = function (map, on) {
    C.on = on;
    if (on) { C.carsOn = C.carsOn !== false; refresh(map); }
    else { C.buildings = []; C.cars.length = 0; D.draw(map); CAR.stepCars(map, 0); }
  };

  /* The page owns the outage poll; this just receives the result.
     `pct` is the share of that ZIP's customers who are out, 0-1. */
  /* Where the reader is standing, when they have asked the page to
     say. Used only to weight detail toward them; never sent anywhere. */
  C.setHere = function (map, lat, lng) {
    C.here = (lat == null) ? null : { lat: lat, lng: lng };
    if (C.on && map) scheduleRefresh(map);
  };

  C.setBlackouts = function (map, list) {
    C.blackouts = (list || []).filter(b => b && b.pct > 0 && b.rings && b.rings.length);
    C.boZoom = null;
    if (C.on && map) scheduleRefresh(map);
  };

  C.status = function (map) {
    if (!C.on) return 'Off';
    if (map.getZoom() < H.MIN_Z) return 'Zoom past ' + H.MIN_Z + ' to raise the buildings';
    const b = C.buildings || [];
    if (!b.length) return 'No buildings mapped here';
    const real = b.filter(x => x.real).length;
    const bits = [b.length.toLocaleString() + ' buildings',
                  Math.round(100 * real / b.length) + '% at their real height'];

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
    if (C.blackouts.length) {
      const worst = Math.round(100 * Math.max.apply(null, C.blackouts.map(b => b.pct)));
      bits.push('lights out in ' + C.blackouts.length + ' ZIP'
        + (C.blackouts.length === 1 ? '' : 's') + ', worst ' + worst + '% of customers');
    }
    return bits.join(' · ');
  };

})(window);
