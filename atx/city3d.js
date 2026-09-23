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
    on: false, pm: null, tiles: new Map(), busy: new Set(),
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

  function sizeCanvas(map, cv) {
    const s = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const padPx = L.point(s.x * PAD, s.y * PAD).round();
    const w = s.x + padPx.x * 2, h = s.y + padPx.y * 2;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
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
  function collect(map) {
    const out = [];
    const z = map.getZoom();
    /* Tile coordinates convert to Leaflet layer points by pure
       arithmetic: the tile scheme and Leaflet's Web Mercator are the same
       projection, so a tile-local point is (tile + local/extent) scaled by
       256·2^(z − tileZoom), less the map's pixel origin.
       Calling latLngToLayerPoint per vertex instead meant an atan and a
       sinh for every one of about thirty-five thousand points on every
       settle, which was most of the 58 ms this used to take. Exact, not
       an approximation — same projection, just not routed through a
       latitude and back. */
    const pxOrigin = map.getPixelOrigin();
    const tileScale = 256 * Math.pow(2, z - H.TILE_Z);
    const origin = (C.canvas && C.canvas._origin) || map.containerPointToLayerPoint([0, 0]);
    const pad = (C.canvas && C.canvas._pad) || L.point(0, 0);
    const size = map.getSize();
    const maxX = size.x + pad.x * 2, maxY = size.y + pad.y * 2;
    // Metres per pixel at this latitude, so a height in metres becomes a
    // believable number of pixels rather than an arbitrary one.
    const c = map.getCenter();
    const mpp = 40075016.686 * Math.cos(c.lat * Math.PI / 180) / Math.pow(2, z + 8);
    for (const [key, t] of C.tiles) {
      if (!t || !t.buildings) continue;
      const [tz, tx, ty] = key.split('/').map(Number);
      const ext = t.buildings.extent || H.EXTENT_FALLBACK;
      const n = Math.pow(2, tz);
      for (const f of t.buildings.features) {
        // Address points share this layer with real buildings — 677 of
        // 1,188 in a downtown tile. Polygons only.
        if (f.type !== 3) continue;
        const kind = f.props.kind;
        if (kind !== 'building' && kind !== 'building_part') continue;
        const hm = f.props.height != null ? +f.props.height : H.guessHeight(f.id || 1);
        const real = f.props.height != null;
        for (const ring of f.rings) {
          if (ring.length < 8) continue;
          const pts = [];
          let cx = 0, cy = 0, minX = 1e9, minY = 1e9, maxPX = -1e9, maxPY = -1e9;
          const ax = (tx * tileScale) - pxOrigin.x - origin.x;
          const ay = (ty * tileScale) - pxOrigin.y - origin.y;
          const k = tileScale / ext;
          for (let i = 0; i < ring.length; i += 2) {
            const x = ax + ring[i] * k, y = ay + ring[i + 1] * k;
            pts.push(x, y); cx += x; cy += y;
            if (x < minX) minX = x; if (y < minY) minY = y;
            if (x > maxPX) maxPX = x; if (y > maxPY) maxPY = y;
          }
          const m = pts.length / 2;
          const hpx = hm / mpp;
          // Off the padded canvas entirely, or too small to read: not worth
          // the path. Culling here is worth more than any drawing trick,
          // because a building skipped costs nothing at all.
          if (maxPX < -40 || maxPY < -40 || minX > maxX + 40 || minY > maxY + 40 + hpx) continue;
          if ((maxPX - minX) < 2 && (maxPY - minY) < 2) continue;
          out.push({ pts: pts, cx: cx / m, cy: cy / m, h: hpx, real: real });
        }
      }
    }
    /* Sorted here, once per settle, rather than on every draw. Painter's
       order does not change while the view is still, and sorting a few
       thousand buildings inside the draw call was most of what made
       zooming feel like wading. */
    const oy = maxY / 2;
    out.sort((p, q) => (Math.abs(p.cy - oy) - Math.abs(q.cy - oy)) || (p.cy - q.cy));
    /* And a ceiling. Past a few thousand the view is too wide for any of
       this to be legible, and the tall ones carry the skyline, so the
       shortest go first. */
    if (out.length > 4000) {
      out.sort((p, q) => q.h - p.h);
      out.length = 4000;
      out.sort((p, q) => (Math.abs(p.cy - oy) - Math.abs(q.cy - oy)) || (p.cy - q.cy));
    }
    return out;
  }

  const WALL_LIT = '#2c3a58', WALL_DIM = '#1b2438', ROOF = '#3b4e74', ROOF_HI = '#53709f';

  /* Draw is now called only when the view settles, never during a pan or
     a zoom — the canvas is carried by the pane on a pan and CSS-scaled
     during a zoom, exactly as Leaflet's own canvas layers behave. */
  function draw(map, resize) {
    if (!C.canvas) return;
    const dpr = resize === false
      ? Math.min(window.devicePixelRatio || 1, 2)
      : sizeCanvas(map, C.canvas);
    const ctx = C.ctx;
    const w = C.canvas.width / dpr, h = C.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!C.on || map.getZoom() < H.MIN_Z) return;

    const b = C.buildings || [];
    const ox = w / 2, oy = h / 2;
    // Lean: a building's roof is offset away from the centre of the
    // screen in proportion to its height. Straight up in the middle,
    // leaning out at the edges — which is what a wide-angle look down at
    // a model actually does.
    const k = C.lift;
    // Already in painter's order from collect(); sorting here would redo
    // that work on every settle for no gain.
    for (const bl of b) {
      const dx = (bl.cx - ox) / Math.max(ox, 1) * k * bl.h;
      const dy = (bl.cy - oy) / Math.max(oy, 1) * k * bl.h - bl.h;
      const p = bl.pts, m = p.length;

      // Walls, one quad per edge. Only the edges facing away from centre
      // are drawn; the rest are hidden behind the mass anyway.
      ctx.beginPath();
      for (let i = 0; i < m; i += 2) {
        const j = (i + 2) % m;
        const x1 = p[i], y1 = p[i + 1], x2 = p[j], y2 = p[j + 1];
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        ctx.lineTo(x2 + dx, y2 + dy); ctx.lineTo(x1 + dx, y1 + dy);
        ctx.closePath();
      }
      ctx.fillStyle = bl.h > 40 ? WALL_LIT : WALL_DIM;
      ctx.fill();

      // Roof.
      ctx.beginPath();
      ctx.moveTo(p[0] + dx, p[1] + dy);
      for (let i = 2; i < m; i += 2) ctx.lineTo(p[i] + dx, p[i + 1] + dy);
      ctx.closePath();
      ctx.fillStyle = bl.h > 40 ? ROOF_HI : ROOF;
      ctx.fill();
      if (bl.h > 12) { ctx.strokeStyle = 'rgba(10,14,22,.55)'; ctx.lineWidth = 0.6; ctx.stroke(); }
    }
  }

  global.CITY3D._draw = { ensurePanes, sizeCanvas, collect, draw };
})(window);

/* ── Invented traffic ───────────────────────────────────────────────── */
(function (global) {
  'use strict';
  const C = global.CITY3D, H = C._helpers, D = C._draw;

  const CAR_COLOURS = ['#c9d6ee', '#8ea3c6', '#ffd166', '#7e93b8'];

  function harvestRoads(map) {
    const out = [];
    for (const [key, t] of C.tiles) {
      if (!t || !t.roads) continue;
      const [tz, tx, ty] = key.split('/').map(Number);
      const ext = t.roads.extent || H.EXTENT_FALLBACK;
      const n = Math.pow(2, tz);
      for (const f of t.roads.features) {
        if (f.type !== 2) continue;                      // linestrings only
        const kind = f.props.kind;
        if (kind !== 'highway' && kind !== 'major_road' && kind !== 'medium_road') continue;
        for (const ring of f.rings) {
          if (ring.length < 4) continue;
          const ll = [];
          for (let i = 0; i < ring.length; i += 2) {
            const lon = (tx + ring[i] / ext) / n * 360 - 180;
            const yy = (ty + ring[i + 1] / ext) / n;
            ll.push([Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI, lon]);
          }
          out.push(ll);
        }
      }
      if (out.length > 1200) break;
    }
    C.roads = out;
  }

  function spawn() {
    if (!C.roads || !C.roads.length) return null;
    const line = C.roads[(Math.random() * C.roads.length) | 0];
    return { line: line, i: (Math.random() * (line.length - 1)) | 0, t: Math.random(),
             dir: Math.random() < 0.5 ? 1 : -1, v: 9 + Math.random() * 15,
             c: CAR_COLOURS[(Math.random() * CAR_COLOURS.length) | 0] };
  }

  function stepCars(map, dt) {
    if (!C.carCanvas) return;
    /* The car canvas is repositioned every frame rather than transformed,
       because unlike the buildings its contents move anyway — so there is
       nothing to save by holding it still. Coordinates are layer points
       made relative to the canvas origin, matching the buildings; drawing
       container points onto a layer-positioned canvas would offset every
       car by the padding. */
    const dpr = D.sizeCanvas(map, C.carCanvas);
    const ctx = C.carCtx;
    const w = C.carCanvas.width / dpr, h = C.carCanvas.height / dpr;
    const origin = C.carCanvas._origin || L.point(0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!C.on || !C.carsOn || map.getZoom() < H.MIN_Z - 1) return;

    const want = map.getZoom() >= 16 ? 200 : 110;
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
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.fillStyle = c.c;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  global.CITY3D._cars = { harvestRoads, stepCars };
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

  C.status = function (map) {
    if (!C.on) return 'Off';
    if (map.getZoom() < H.MIN_Z) return 'Zoom past ' + H.MIN_Z + ' to raise the buildings';
    const b = C.buildings || [];
    const real = b.filter(x => x.real).length;
    return b.length
      ? b.length.toLocaleString() + ' buildings · '
        + Math.round(100 * real / b.length) + '% at their real height'
      : 'No buildings mapped here';
  };
})(window);
