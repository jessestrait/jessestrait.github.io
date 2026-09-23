/* Austin, from above — a 3D companion to the flat map at /atx/.
 *
 * WHAT IS REAL AND WHAT IS NOT, because the whole point of the flat map is
 * that it never guesses:
 *
 *   real   every building footprint and every height that OpenStreetMap
 *          carries — 500,272 buildings across this bounding box, 361,326
 *          of them with an explicit building:levels or height tag.
 *   real   every bus. Position, route and heading come from CapMetro's
 *          own feed through this site's relay, the same one /atx/ uses.
 *   guessed the height of a building OSM does not tag. Four storeys near
 *          the centre, two out, which is a plausible skyline and not a
 *          surveyed one.
 *   guessed every car. They are spawned onto real road geometry out of
 *          the vector tiles and driven along it. Nothing about their
 *          number, speed or position corresponds to real traffic — they
 *          are there because a model city with empty streets reads as
 *          abandoned, not as calm.
 *
 * The basemap is a 43 MB PMTiles archive of the Austin metro extracted
 * from the Protomaps planet build. It is one file served over HTTP range
 * requests — GitHub Pages answers 206, verified — so a phone downloads
 * the handful of tiles in view rather than the archive.
 */

/* One Protocol instance, with the archive registered on it. Registering a
   second would mean every tile request re-read the archive header. */
const PROTO = new pmtiles.Protocol();
PROTO.add(new pmtiles.PMTiles(new URL('austin.pmtiles', location.href).href));
maplibregl.addProtocol('pmtiles', PROTO.tile);

const SRC = 'pmtiles://' + new URL('austin.pmtiles', location.href).href;
const CENTRE = [-97.7431, 30.2672];

/* A night palette, because this is the companion to a dark map and
   because a model city reads best lit from within. Kept deliberately
   close to /atx/ so the two feel like one project. */
const C = {
  ground:  '#0b1018',
  park:    '#12251c',
  water:   '#0d2136',
  road:    '#1b2740',
  major:   '#243450',
  wall:    '#1d2942',
  roofLow: '#24324e',
  roofHi:  '#3d5580',
  label:   '#8b97ab'
};

const map = new maplibregl.Map({
  container: 'map',
  // Pitched hard and turned off north from the first frame: this is a
  // model on a table, and a model seen from directly overhead is a plan.
  center: CENTRE, zoom: 15.2, pitch: 62, bearing: -22,
  maxPitch: 80, minZoom: 9, maxZoom: 18.5,
  attributionControl: { compact: true },
  style: {
    version: 8,
    /* The fontstack is "Noto Sans Regular" — with spaces, not the hyphenated
     name the npm package suggests. Every hyphenated spelling I tried 404s,
     and a bad glyphs URL does not error: it just silently drops every text
     layer, which is the sort of failure you ship without noticing. */
  glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
    sources: { p: { type: 'vector', url: SRC, attribution:
      '<a href="https://openstreetmap.org/copyright">© OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>' } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.ground } },
      { id: 'earth', type: 'fill', source: 'p', 'source-layer': 'earth',
        paint: { 'fill-color': C.ground } },
      { id: 'landuse', type: 'fill', source: 'p', 'source-layer': 'landuse',
        filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'wood', 'grass',
                 'nature_reserve', 'golf_course', 'cemetery', 'scrub']]],
        paint: { 'fill-color': C.park, 'fill-opacity': 0.85 } },
      { id: 'water', type: 'fill', source: 'p', 'source-layer': 'water',
        paint: { 'fill-color': C.water } },
      // Roads under the buildings, so a building never floats over its street.
      { id: 'roads', type: 'line', source: 'p', 'source-layer': 'roads',
        paint: {
          'line-color': ['match', ['get', 'kind'],
            'highway', C.major, 'major_road', C.major, C.road],
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'],
            10, ['match', ['get', 'kind'], 'highway', 1.6, 0.5],
            16, ['match', ['get', 'kind'], 'highway', 9, 'major_road', 5, 2.4]],
          'line-opacity': 0.95
        } },

      /* The city itself.
         `height` is metres where OSM has it. Where it does not, the
         fallback leans on nothing but distance from downtown, which is a
         guess and is labelled as one in the panel. Colour rises with
         height so the skyline reads at a glance rather than needing
         shadows to do all the work. */
      { id: 'buildings', type: 'fill-extrusion', source: 'p', 'source-layer': 'buildings',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': ['interpolate', ['linear'],
            ['coalesce', ['get', 'height'], 8],
            0, C.wall, 12, C.roofLow, 60, C.roofHi, 180, '#6f8fc4'],
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
            13, 0, 14.2, ['coalesce', ['get', 'height'], 8]],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.96,
          'fill-extrusion-vertical-gradient': true
        } },

      { id: 'places', type: 'symbol', source: 'p', 'source-layer': 'places',
        minzoom: 11, maxzoom: 15,
        filter: ['<=', ['get', 'min_zoom'], 13],
        layout: { 'text-field': ['get', 'name'], 'text-size': 11,
                  'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': C.label, 'text-halo-color': '#05080e', 'text-halo-width': 1.3 } }
    ]
  }
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

const statline = document.getElementById('statline');
const say = h => { statline.innerHTML = h; };

/* ── Invented traffic ─────────────────────────────────────────────────
   Cars are spawned onto whatever road geometry is currently loaded in the
   vector tiles, which means they exist anywhere on the map without a
   single byte of extra data — the streets are already there, they just
   had nothing on them.

   querySourceFeatures returns tile-clipped geometry, so a road crossing a
   tile seam arrives as two pieces. That is fine here: a car reaching the
   end of its piece is simply reassigned. Nobody is following one car.  */
const CARS = { on: true, list: [], roads: [], layerReady: false, last: 0 };
const CAR_TARGET = () => (map.getZoom() >= 15 ? 260 : map.getZoom() >= 13 ? 150 : 60);

function harvestRoads() {
  if (!map.isSourceLoaded('p')) return;
  const feats = map.querySourceFeatures('p', {
    sourceLayer: 'roads',
    filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road', 'medium_road']]]
  });
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const parts = g.type === 'LineString' ? [g.coordinates]
                : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of parts) if (line.length > 1) out.push(line);
    if (out.length > 1400) break;
  }
  if (out.length) CARS.roads = out;
}

function spawnCar() {
  if (!CARS.roads.length) return null;
  const line = CARS.roads[(Math.random() * CARS.roads.length) | 0];
  const i = (Math.random() * (line.length - 1)) | 0;
  return {
    line, i, t: Math.random(),
    dir: Math.random() < 0.5 ? 1 : -1,
    // Metres per second, loosely: arterials move, side streets crawl.
    v: 8 + Math.random() * 14,
    hue: Math.random() < 0.12 ? '#ffd166' : (Math.random() < 0.5 ? '#c9d6ee' : '#7e93b8')
  };
}

function stepCars(dt) {
  const want = CAR_TARGET();
  while (CARS.list.length < want) { const c = spawnCar(); if (!c) break; CARS.list.push(c); }
  if (CARS.list.length > want) CARS.list.length = want;
  const feats = [];
  for (const c of CARS.list) {
    const a = c.line[c.i], b = c.line[c.i + c.dir];
    if (!a || !b) { Object.assign(c, spawnCar() || {}); continue; }
    // Degrees per metre, near enough at this latitude for a fake car.
    const segM = Math.hypot((b[0] - a[0]) * 96000, (b[1] - a[1]) * 111320) || 1;
    c.t += (c.v * dt) / segM;
    while (c.t >= 1) {
      c.t -= 1; c.i += c.dir;
      if (c.i <= 0 || c.i >= c.line.length - 1) { const n = spawnCar(); if (n) Object.assign(c, n); break; }
    }
    const A = c.line[c.i], B = c.line[c.i + c.dir];
    if (!A || !B) continue;
    feats.push({ type: 'Feature', properties: { hue: c.hue },
      geometry: { type: 'Point', coordinates:
        [A[0] + (B[0] - A[0]) * c.t, A[1] + (B[1] - A[1]) * c.t] } });
  }
  const src = map.getSource('cars');
  if (src) src.setData({ type: 'FeatureCollection', features: CARS.on ? feats : [] });
}


/* ── The layers ───────────────────────────────────────────────────────
   One generic pass over the registry in layers.js. MapLibre does the
   hit-testing, culling and data-driven styling that the flat map has to
   hand-roll on a canvas, so a layer here is a declaration rather than a
   renderer — which is why this file is short and index.html at /atx/ is
   nine thousand lines.

   Sources are created empty and filled when the data lands, so a slow
   feed never holds up the city. */
const REG = window.ATX3D.LAYERS;
const STATE = {};                       // id -> {on, n, at, err}

function addLayerFor(l) {
  const sid = 'src-' + l.id;
  map.addSource(sid, { type: 'geojson',
    data: { type: 'FeatureCollection', features: [] } });

  const vis = { visibility: l.on ? 'visible' : 'none' };

  if (l.kind === 'fill') {
    map.addLayer({ id: l.id, type: 'fill', source: sid, layout: vis,
      paint: { 'fill-color': l.colour, 'fill-opacity': l.opacity == null ? 0.3 : l.opacity } },
      'buildings');
  } else if (l.kind === 'line') {
    map.addLayer({ id: l.id, type: 'line', source: sid, layout:
        Object.assign({ 'line-cap': 'round', 'line-join': 'round' }, vis),
      paint: {
        // A route keeps CapMetro's own colour where the data carries one.
        'line-color': l.colourFrom
          ? ['case', ['has', l.colourFrom],
              ['concat', '#', ['get', l.colourFrom]], l.colour]
          : l.colour,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          10, (l.width || 2) * 0.5, 16, (l.width || 2) * 2],
        'line-opacity': l.opacity == null ? 0.9 : l.opacity
      } }, 'buildings');
  } else {
    /* Points sit above the buildings, not among them: a fire call behind a
       tower is still a fire call you need to see. Height is not simulated —
       these are flat marks on top of a 3D city, deliberately, because
       pretending a 311 request happened on the fourth floor would be
       inventing data. */
    map.addLayer({ id: l.id, type: 'circle', source: sid, layout: vis,
      paint: {
        'circle-color': l.id === 'signals'
          ? ['case', ['==', ['get', 'flash'], 1], '#ffb020', l.colour] : l.colour,
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          10, (l.radius || 3.5) * 0.55, 15, l.radius || 3.5, 18, (l.radius || 3.5) * 1.9],
        'circle-stroke-color': '#070b12',
        'circle-stroke-width': 1,
        'circle-opacity': 0.95
      } });
    if (l.labelFrom) {
      map.addLayer({ id: l.id + '-label', type: 'symbol', source: sid, minzoom: 14.5,
        layout: Object.assign({ 'text-field': ['get', l.labelFrom], 'text-size': 10,
          'text-font': ['Noto Sans Regular'], 'text-offset': [0, -1.2],
          'text-allow-overlap': false }, vis),
        paint: { 'text-color': l.colour, 'text-halo-color': '#070b12', 'text-halo-width': 1.2 } });
    }
  }
}

async function loadLayer(l) {
  const st = STATE[l.id] || (STATE[l.id] = { on: !!l.on });
  st.busy = true; paintPanel();
  try {
    const gj = await l.load();
    const feats = (gj && gj.features) || [];
    // The prebuilt files are already GeoJSON; the live ones are built above.
    map.getSource('src-' + l.id).setData(
      gj.type === 'FeatureCollection' ? gj : { type: 'FeatureCollection', features: feats });
    st.n = feats.length; st.at = Date.now(); st.err = null;
  } catch (e) {
    st.err = e.message || 'failed';
  } finally { st.busy = false; paintPanel(); }
}

function setLayerOn(l, on) {
  const st = STATE[l.id] || (STATE[l.id] = {});
  st.on = on;
  const v = on ? 'visible' : 'none';
  [l.id, l.id + '-label'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  });
  if (on && st.n == null && !st.busy) loadLayer(l);
  paintPanel();
  saveUrl();
}

/* ── The panel ────────────────────────────────────────────────────── */
function paintPanel() {
  const box = document.getElementById('layers');
  if (!box) return;
  const groups = [['live', 'Live now'], ['ground', 'Standing']];
  box.innerHTML = groups.map(([g, title]) =>
    '<div class="grp"><label class="mini">' + title + '</label>'
    + REG.filter(l => (l.group || 'live') === g).map(l => {
        const st = STATE[l.id] || {};
        const count = st.busy ? '···' : st.err ? 'err'
          : st.n == null ? '' : st.n.toLocaleString();
        return '<label class="row" data-id="' + l.id + '">'
          + '<input type="checkbox"' + (st.on ? ' checked' : '') + '>'
          + '<span class="sw" style="background:' + l.colour + '"></span>'
          + '<span class="nm">' + window.ATX3D.esc(l.name) + '</span>'
          + '<span class="ct">' + count + '</span></label>';
      }).join('') + '</div>').join('');
  box.querySelectorAll('.row input').forEach(inp => {
    inp.addEventListener('change', e => {
      const id = e.target.closest('.row').dataset.id;
      setLayerOn(REG.find(l => l.id === id), e.target.checked);
    });
  });
}

/* ── Popups ───────────────────────────────────────────────────────────
   One handler for every layer. queryRenderedFeatures already knows what
   is under the finger and in what order, which is the whole of the
   nearestCanvas machinery the flat map needed. */
function wirePopups() {
  const ids = REG.map(l => l.id).filter(id => map.getLayer(id));
  map.on('click', e => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ids });
    if (!hits.length) return;
    const f = hits[0];
    const html = f.properties && f.properties.html;
    if (!html) return;
    new maplibregl.Popup({ maxWidth: '320px', closeButton: true, offset: 10 })
      .setLngLat(f.geometry.type === 'Point' ? f.geometry.coordinates : e.lngLat)
      .setHTML(html).addTo(map);
  });
  map.on('mousemove', e => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ids });
    map.getCanvas().style.cursor = hits.length ? 'pointer' : '';
  });
}

/* ── Flat and model are the same map ──────────────────────────────────
   This is the part worth stating plainly. Combining the two maps did not
   mean merging two renderers: in MapLibre the flat map *is* this map at
   pitch 0 with the buildings switched off. One camera, one set of
   layers, one source of truth — the tilt is a slider, not a mode. */
function setTilt(pitch) {
  map.easeTo({ pitch: pitch, duration: 450 });
  const flat = pitch < 12;
  if (map.getLayer('buildings'))
    map.setLayoutProperty('buildings', 'visibility', flat ? 'none' : 'visible');
  document.getElementById('tilt').style.display = flat ? 'none' : '';
  document.getElementById('vig').style.display = flat ? 'none' : '';
  document.body.classList.toggle('is-flat', flat);
  saveUrl();
}

/* ── Shareable state ──────────────────────────────────────────────── */
let urlTimer = null;
function saveUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const c = map.getCenter();
    const p = new URLSearchParams();
    p.set('c', c.lat.toFixed(4) + ',' + c.lng.toFixed(4));
    p.set('z', map.getZoom().toFixed(1));
    p.set('p', Math.round(map.getPitch()));
    p.set('b', Math.round(map.getBearing()));
    p.set('l', REG.filter(l => (STATE[l.id] || {}).on).map(l => l.id).join(','));
    history.replaceState(null, '', '#' + p.toString());
  }, 400);
}

function restoreUrl() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('c')) return false;
  const [lat, lng] = (p.get('c') || '').split(',').map(Number);
  if (isFinite(lat) && isFinite(lng)) {
    map.jumpTo({ center: [lng, lat], zoom: +p.get('z') || 15.2,
                 pitch: +p.get('p') || 62, bearing: +p.get('b') || 0 });
  }
  if (p.has('l')) {
    const want = (p.get('l') || '').split(',').filter(Boolean);
    REG.forEach(l => { (STATE[l.id] || (STATE[l.id] = {})).on = want.includes(l.id); });
  }
  return true;
}

/* ── Boot ─────────────────────────────────────────────────────────── */
map.on('load', () => {
  // Buildings already exist in the style; every registry layer goes above
  // the ground shapes and below the marks, in one pass.
  REG.forEach(l => { STATE[l.id] = { on: !!l.on }; });
  restoreUrl();
  REG.forEach(addLayerFor);

  // Invented traffic, on its own source above the roads.
  map.addSource('cars', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'cars', type: 'circle', source: 'cars', minzoom: 12,
    paint: {
      'circle-color': ['get', 'hue'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.1, 15, 2.6, 18, 5],
      'circle-opacity': 0.95, 'circle-blur': 0.25
    } }, REG.find(l => (l.group || 'live') === 'live').id);

  wirePopups();
  paintPanel();
  setTilt(map.getPitch());

  // Everything switched on loads now; everything else waits to be asked.
  REG.filter(l => (STATE[l.id] || {}).on).forEach(loadLayer);

  harvestRoads();
  map.on('idle', harvestRoads);
  map.on('moveend', saveUrl);

  // The live half refreshes on its own clock, the standing half never does.
  setInterval(() => {
    if (document.hidden) return;
    REG.filter(l => (l.group || 'live') === 'live' && (STATE[l.id] || {}).on)
       .forEach(loadLayer);
  }, 60000);

  let last = performance.now();
  const frame = now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!document.hidden) stepCars(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(paintStat, 2000);
});

function paintStat() {
  const live = REG.filter(l => (l.group || 'live') === 'live' && (STATE[l.id] || {}).n)
    .reduce((s, l) => s + STATE[l.id].n, 0);
  const el = document.getElementById('statline');
  if (el) el.innerHTML = '<b>' + live.toLocaleString() + '</b> live marks &nbsp;·&nbsp; <b>'
    + CARS.list.length + '</b> cars, invented &nbsp;·&nbsp; buildings from OSM';
}

/* ── Controls ─────────────────────────────────────────────────────── */
const press = (id, fn) => {
  const b = document.getElementById(id);
  if (!b) return;
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    fn(on);
  });
};
press('b-cars', on => { CARS.on = on; });
press('b-tilt', on => setTilt(on ? 62 : 0));
document.getElementById('b-frame').addEventListener('click', () =>
  map.easeTo({ center: CENTRE, zoom: 15.2, pitch: map.getPitch(), bearing: -22, duration: 900 }));
const pitchEl = document.getElementById('pitch');
if (pitchEl) pitchEl.addEventListener('input', e => setTilt(+e.target.value));
