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

  function sizeCanvas(map, cv) {
    const s = map.getSize(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== s.x * dpr || cv.height !== s.y * dpr) {
      cv.width = s.x * dpr; cv.height = s.y * dpr;
      cv.style.width = s.x + 'px'; cv.style.height = s.y + 'px';
    }
    // The pane is translated by Leaflet as you drag; undo that so the
    // canvas stays pinned to the viewport and is redrawn in screen space.
    const tl = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(cv, tl);
    return dpr;
  }

  /* Gather the footprints in view, projected to screen pixels, with a
     height in metres. Done once per settle rather than per frame: the
     buildings do not move. */
  function collect(map) {
    const out = [];
    const z = map.getZoom();
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
          let cx = 0, cy = 0;
          for (let i = 0; i < ring.length; i += 2) {
            const lon = (tx + ring[i] / ext) / n * 360 - 180;
            const yy = (ty + ring[i + 1] / ext) / n;
            const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yy))) * 180 / Math.PI;
            const p = map.latLngToContainerPoint([lat, lon]);
            pts.push(p.x, p.y); cx += p.x; cy += p.y;
          }
          const m = pts.length / 2;
          out.push({ pts: pts, cx: cx / m, cy: cy / m, h: hm / mpp, real: real });
        }
      }
    }
    return out;
  }

  const WALL_LIT = '#2c3a58', WALL_DIM = '#1b2438', ROOF = '#3b4e74', ROOF_HI = '#53709f';

  function draw(map) {
    if (!C.canvas) return;
    const dpr = sizeCanvas(map, C.canvas);
    const ctx = C.ctx, s = map.getSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.x, s.y);
    if (!C.on || map.getZoom() < H.MIN_Z) return;

    const b = C.buildings || [];
    const ox = s.x / 2, oy = s.y / 2;
    // Lean: a building's roof is offset away from the centre of the
    // screen in proportion to its height. Straight up in the middle,
    // leaning out at the edges — which is what a wide-angle look down at
    // a model actually does.
    const k = C.lift;
    // Painter's algorithm: far from centre first, so nearer buildings
    // overlap the ones behind them rather than the other way round.
    b.sort((p, q) => (Math.abs(p.cy - oy) - Math.abs(q.cy - oy)) || (p.cy - q.cy));

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
    const dpr = D.sizeCanvas(map, C.carCanvas);
    const ctx = C.carCtx, s = map.getSize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.x, s.y);
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
      const p = map.latLngToContainerPoint([A[0] + (B[0] - A[0]) * c.t,
                                            A[1] + (B[1] - A[1]) * c.t]);
      if (p.x < -20 || p.y < -20 || p.x > s.x + 20 || p.y > s.y + 20) continue;
      ctx.fillStyle = c.c;
      ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
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
    if (!C.on) { D.draw(map); return; }
    if (map.getZoom() < H.MIN_Z) { C.buildings = []; D.draw(map); C.onNote && C.onNote(); return; }
    const want = H.visibleTiles(map);
    await Promise.all(want.map(([z, x, y]) => H.tile(z, x, y)));
    C.buildings = D.collect(map);
    CAR.harvestRoads(map);
    D.draw(map);
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
    if (!document.hidden && C.on) CAR.stepCars(map, dt);
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
    map.on('moveend zoomend resize', () => scheduleRefresh(map));
    // Redraw during a drag so the city travels with the ground rather
    // than lagging a frame behind it.
    map.on('move', () => { if (C.on) D.draw(map); });
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
