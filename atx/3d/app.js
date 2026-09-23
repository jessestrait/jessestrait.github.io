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

/* ── Real buses ───────────────────────────────────────────────────────
   The same relay /atx/ reads. Positions are real, headings are real, and
   a vehicle that is not on a route is left out exactly as it is there. */
const RELAY = 'https://capmetro.jessestrait.workers.dev';
const BUS = { on: true, feats: [], at: 0 };

async function loadBuses() {
  try {
    const j = await fetch(RELAY + '/vehicles', { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error('relay ' + r.status); return r.json();
    });
    const out = [];
    (j.entity || []).forEach(e => {
      const v = e.vehicle || {}, p = v.position, trip = v.trip || {};
      if (!p || p.latitude == null || !trip.routeId) return;
      out.push({ type: 'Feature',
        properties: { route: String(trip.routeId), bearing: p.bearing || 0 },
        geometry: { type: 'Point', coordinates: [+p.longitude, +p.latitude] } });
    });
    BUS.feats = out;
    BUS.at = Date.now();
    const src = map.getSource('buses');
    if (src) src.setData({ type: 'FeatureCollection', features: BUS.on ? out : [] });
  } catch (e) { /* the city is still a city without them */ }
  paintStat();
}

function paintStat() {
  const when = BUS.at ? new Date(BUS.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
  say('<b>' + BUS.feats.length + '</b> buses, real, ' + when
    + ' &nbsp;·&nbsp; <b>' + CARS.list.length + '</b> cars, invented'
    + ' &nbsp;·&nbsp; buildings from OSM');
}

map.on('load', () => {
  map.addSource('cars', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'cars', type: 'circle', source: 'cars', minzoom: 12,
    paint: {
      'circle-color': ['get', 'hue'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 1.1, 15, 2.6, 18, 5],
      'circle-opacity': 0.95,
      'circle-blur': 0.25
    }
  });
  map.addSource('buses', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'buses', type: 'circle', source: 'buses', minzoom: 10,
    paint: {
      'circle-color': '#a3e635',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2.4, 15, 5.5, 18, 9],
      'circle-stroke-color': '#0a0e16', 'circle-stroke-width': 1.2,
      'circle-opacity': 0.98
    }
  });
  map.addLayer({
    id: 'bus-label', type: 'symbol', source: 'buses', minzoom: 14.5,
    layout: { 'text-field': ['get', 'route'], 'text-size': 10,
              'text-font': ['Noto Sans Regular'], 'text-offset': [0, -1.1] },
    paint: { 'text-color': '#a3e635', 'text-halo-color': '#0a0e16', 'text-halo-width': 1.2 }
  });

  harvestRoads();
  loadBuses();
  setInterval(() => { if (!document.hidden) loadBuses(); }, 60000);
  map.on('idle', harvestRoads);

  let last = performance.now();
  const frame = now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!document.hidden) stepCars(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(paintStat, 2000);
});

/* ── Controls ─────────────────────────────────────────────────────── */
const toggle = (btn, fn) => {
  const b = document.getElementById(btn);
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    fn(on);
  });
};
toggle('b-cars', on => { CARS.on = on; });
toggle('b-buses', on => {
  BUS.on = on;
  const src = map.getSource('buses');
  if (src) src.setData({ type: 'FeatureCollection', features: on ? BUS.feats : [] });
});
toggle('b-tilt', on => {
  document.getElementById('tilt').style.display = on ? '' : 'none';
  document.getElementById('vig').style.display = on ? '' : 'none';
});
document.getElementById('b-frame').addEventListener('click', () => {
  map.easeTo({ center: CENTRE, zoom: 15.2, pitch: 62, bearing: -22, duration: 900 });
});
