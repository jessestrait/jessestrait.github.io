/* The layers, as data rather than as drawing code.
 *
 * The flat map at /atx/ carries its own renderer for each layer because
 * Leaflet needs one. MapLibre does not: give it GeoJSON and a paint
 * expression and it handles hit-testing, culling and data-driven styling
 * itself. So a layer here is a declaration — where the data comes from,
 * what shape it is, what colour — and app.js turns the whole list into a
 * map with one generic pass.
 *
 * Every endpoint is the same one the flat map reads. Nothing is duplicated
 * that could be shared; the prebuilt geometry under /atx/data/ is fetched
 * straight from where it already lives.
 */

const API = 'https://data.austintexas.gov/resource/';
const RELAY = 'https://capmetro.jessestrait.workers.dev';
const DATA = 'https://raw.githubusercontent.com/jessestrait/jessestrait.github.io/data/';

async function soda(id, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const r = await fetch(API + id + '.json?' + qs);
  if (!r.ok) throw new Error(id + ' ' + r.status);
  return r.json();
}

/* Most of these datasets publish on a lag — 311 about a day, crashes about
   a fortnight — so a window measured from now silently returns nothing.
   Anchored to the dataset's own newest row instead, exactly as the flat
   map does, and the layer says how far behind it is. */
async function anchoredSince(id, field, days, extra) {
  let anchor = null;
  try {
    const r = await soda(id, Object.assign({ '$select': 'max(' + field + ') as mx' }, extra || {}));
    anchor = r && r[0] && r[0].mx;
  } catch (e) { /* fall through to wall-clock */ }
  const base = anchor ? new Date(anchor) : new Date();
  return new Date(base.getTime() - days * 864e5).toISOString().slice(0, 19);
}

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const titleCase = s => String(s || '').toLowerCase()
  .replace(/\b([a-z])/g, (m, c) => c.toUpperCase()).trim();

function ago(d) {
  if (!d) return '';
  const m = Math.round((Date.now() - (d instanceof Date ? d : new Date(d))) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 36) return h + ' hr ago';
  return Math.round(h / 24) + ' days ago';
}

function card(colour, tag, title, when, rows, extra) {
  const dl = (rows || []).filter(r => r[1] != null && r[1] !== '' )
    .map(r => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('');
  return '<div class="pop"><span class="tag" style="background:' + colour + '22;color:'
    + colour + '">' + esc(tag) + '</span><h4>' + esc(title) + '</h4>'
    + (when ? '<div class="when">' + esc(when) + '</div>' : '')
    + (dl ? '<dl>' + dl + '</dl>' : '') + (extra || '') + '</div>';
}

const pt = (lng, lat, props) => ({ type: 'Feature', properties: props,
  geometry: { type: 'Point', coordinates: [+lng, +lat] } });
const fc = features => ({ type: 'FeatureCollection', features });

/* ── the registry ──────────────────────────────────────────────────── */
const LAYERS = [
  /* Static geometry first: it is already built, already served, and gives
     the model a floor to stand on before anything live arrives. */
  { id: 'parks', name: 'Parks', colour: '#3fbf7f', kind: 'fill', group: 'ground', on: true,
    opacity: 0.30,
    load: () => fetch('/atx/data/parks.json').then(r => r.json()),
    title: p => titleCase(p.name) || 'Park' },

  { id: 'flood', name: '100-year floodplain', colour: '#2f8fd6', kind: 'fill', group: 'ground',
    opacity: 0.22,
    load: () => fetch('/atx/data/floodplain.json').then(r => r.json()),
    title: () => 'Floodplain' },

  { id: 'trails', name: 'Trails', colour: '#c9a227', kind: 'line', group: 'ground', width: 1.6,
    load: () => fetch('/atx/data/trails.json').then(r => r.json()),
    title: p => titleCase(p.name) || 'Trail' },

  { id: 'busroutes', name: 'Bus and rail routes', colour: '#94a3b8', kind: 'line',
    group: 'ground', on: true, width: 1.4, opacity: 0.55,
    load: () => fetch('/atx/data/routes.geojson').then(r => r.json()),
    colourFrom: 'route_color',
    title: p => 'Route ' + (p.route_short_name || p.route_id || '') },

  { id: 'schoolzones', name: 'School zones', colour: '#f5b642', kind: 'line', group: 'ground',
    on: true, width: 3,
    load: () => fetch('/atx/data/schoolzones.json').then(r => r.json()),
    title: p => titleCase(p.zone || p.school) || 'School zone' },

  /* Live. Same queries the flat map runs. */
  { id: 'firelive', name: 'Fire incidents', colour: '#ffe14d', kind: 'point', group: 'live',
    on: true, radius: 4.5,
    async load() {
      const since = new Date(Date.now() - 864e5).toISOString().slice(0, 19);
      const rows = await soda('wpu4-x69d', {
        '$select': 'published_date,issue_reported,latitude,longitude,address,traffic_report_status',
        '$where': "published_date > '" + since + "' AND latitude IS NOT NULL",
        '$order': 'published_date DESC', '$limit': 2000 });
      return fc(rows.map(r => pt(r.longitude, r.latitude, {
        t: r.published_date,
        html: card('#ffe14d', 'Fire · AFD', titleCase(r.issue_reported) || 'Incident',
          ago(r.published_date), [['Address', titleCase(r.address)],
                                  ['Status', titleCase(r.traffic_report_status)]])
      })));
    } },

  { id: 'traffic', name: 'Traffic incidents', colour: '#ff4d4d', kind: 'point', group: 'live',
    on: true, radius: 4.5,
    async load() {
      const since = new Date(Date.now() - 864e5).toISOString().slice(0, 19);
      const rows = await soda('dx9v-zd7x', {
        '$select': 'published_date,issue_reported,latitude,longitude,address,traffic_report_status',
        '$where': "published_date > '" + since + "' AND latitude IS NOT NULL",
        '$order': 'published_date DESC', '$limit': 2000 });
      return fc(rows.map(r => pt(r.longitude, r.latitude, {
        t: r.published_date,
        html: card('#ff4d4d', 'APD / ATD', titleCase(r.issue_reported) || 'Incident',
          ago(r.published_date), [['Address', titleCase(r.address)],
                                  ['Status', titleCase(r.traffic_report_status)]])
      })));
    } },

  { id: 'c311', name: '311 service requests', colour: '#4dd2ff', kind: 'point', group: 'live',
    radius: 3.2,
    async load() {
      /* The coordinate columns here are sr_location_lat / _long, not
         latitude / longitude — guessing the obvious names got a 400 with
         `no-such-column`. Taken from the flat map, which has them right. */
      const since = await anchoredSince('xwdj-i9he', 'sr_created_date', 1);
      const rows = await soda('xwdj-i9he', {
        '$select': 'sr_created_date,sr_type_desc,sr_status_desc,sr_location,'
                 + 'sr_location_lat,sr_location_long',
        '$where': "sr_created_date > '" + since + "' AND sr_location_lat IS NOT NULL",
        '$order': 'sr_created_date DESC', '$limit': 3000 });
      return fc(rows.map(r => pt(r.sr_location_long, r.sr_location_lat, {
        t: r.sr_created_date,
        // The type arrives prefixed with a department code; the flat map
        // strips it and so does this.
        html: card('#4dd2ff', '311',
          titleCase(String(r.sr_type_desc || 'Request').replace(/^[A-Z0-9 ]{2,9} - /, '')),
          ago(r.sr_created_date), [['Where', titleCase(r.sr_location)],
                                   ['Status', titleCase(r.sr_status_desc)]])
      })));
    } },

  { id: 'signals', name: 'Signals not reporting', colour: '#818cf8', kind: 'point',
    group: 'live', radius: 3.2,
    async load() {
      const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19);
      const rows = await soda('5zpr-dehc', {
        '$select': 'location,location_name,cross_st,signal_id,operation_text,operation_state_datetime',
        '$where': "location IS NOT NULL AND operation_state_datetime > '" + since + "'",
        '$limit': 2000 });
      return fc(rows.filter(r => r.location && r.location.coordinates).map(r => {
        const c = r.location.coordinates;
        const flash = /flash/i.test(r.operation_text || '');
        return pt(c[0], c[1], {
          t: r.operation_state_datetime, flash: flash ? 1 : 0,
          html: card(flash ? '#ffb020' : '#818cf8',
            flash ? 'Signal on flash' : 'Signal · unreachable',
            titleCase(r.location_name) || 'Signal ' + r.signal_id,
            ago(r.operation_state_datetime),
            [['State', r.operation_text], ['Cross street', titleCase(r.cross_st)]],
            '<p class="note">' + (flash
              ? 'On flash: treat it as a four-way stop.'
              : 'The city cannot reach this cabinet. The signal is most likely cycling '
                + 'normally — telemetry, not a dark intersection.') + '</p>')
        });
      }));
    } },

  { id: 'crashes', name: 'Crashes', colour: '#ff5cc8', kind: 'point', group: 'live', radius: 3.2,
    async load() {
      /* address_display, not address_primary. Vision Zero publishes about
         a fortnight behind, so the window is anchored to the dataset's own
         newest row — measured from now it returns nothing at all. */
      const since = await anchoredSince('y2wy-tgr5', 'crash_timestamp', 7,
        { '$where': 'is_deleted = false' });
      const rows = await soda('y2wy-tgr5', {
        '$select': 'crash_timestamp,latitude,longitude,address_display,collsn_desc,'
                 + 'crash_speed_limit,death_cnt,tot_injry_cnt,sus_serious_injry_cnt',
        '$where': "is_deleted = false AND crash_timestamp > '" + since
                + "' AND latitude IS NOT NULL",
        '$order': 'crash_timestamp DESC', '$limit': 3000 });
      return fc(rows.map(r => {
        const deaths = +r.death_cnt || 0, serious = +r.sus_serious_injry_cnt || 0;
        const inj = +r.tot_injry_cnt || 0;
        const kind = deaths ? 'Fatal' : serious ? 'Serious injury'
                   : inj ? 'Injury' : 'No injury';
        return pt(r.longitude, r.latitude, {
          t: r.crash_timestamp, fatal: deaths ? 1 : 0,
          html: card('#ff5cc8', 'Vision Zero · ' + kind,
            titleCase(r.address_display) || 'Crash', ago(r.crash_timestamp),
            [['What', titleCase(r.collsn_desc)],
             ['Speed limit', r.crash_speed_limit],
             ['Injuries', inj || null], ['Deaths', deaths || null]])
        });
      }));
    } },

  /* From this site's own archive on the data branch. */
  { id: 'storms', name: 'Storm cells', colour: '#ff6ad5', kind: 'point', group: 'live',
    on: true, radius: 6,
    async load() {
      const d = await fetch(DATA + 'weather/storms.json', { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('storms ' + r.status); return r.json(); });
      return fc((d.cells || []).map(c => pt(c.lng, c.lat, {
        html: card('#ff6ad5', c.tvs ? 'Tornado signature' : c.meso ? 'Rotating cell' : 'Storm cell',
          (c.dbz != null ? c.dbz + ' dBZ' : 'Cell') + ' · ' + (c.radar || ''), '',
          [['Moving', c.kt != null ? Math.round(c.kt * 1.151) + ' mph' : null],
           ['Hail', c.hail_pct ? c.hail_pct + '%' : null],
           ['Rotation', c.meso], ['Tornado signature', c.tvs]])
      })));
    } },

  /* Real buses, same relay the flat map reads. */
  { id: 'transit', name: 'Buses and trains', colour: '#a3e635', kind: 'point', group: 'live',
    on: true, radius: 5, labelFrom: 'route',
    async load() {
      const j = await fetch(RELAY + '/vehicles', { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('relay ' + r.status); return r.json(); });
      const out = [];
      (j.entity || []).forEach(e => {
        const v = e.vehicle || {}, p = v.position, trip = v.trip || {};
        if (!p || p.latitude == null || !trip.routeId) return;
        const mph = p.speed != null ? p.speed * 2.23694 : null;
        out.push(pt(p.longitude, p.latitude, {
          route: String(trip.routeId),
          vid: String((v.vehicle || {}).id || (v.vehicle || {}).label || e.id || ''),
          bearing: p.bearing == null ? 0 : p.bearing,
          html: card('#a3e635', 'Route ' + trip.routeId,
            'Vehicle ' + ((v.vehicle || {}).label || (v.vehicle || {}).id || '?'), '',
            [['Speed', mph != null ? mph.toFixed(0) + ' mph' : null],
             ['Heading', p.bearing != null ? Math.round(p.bearing) + '°' : null]])
        }));
      });
      return fc(out);
    } }
];

window.ATX3D = { LAYERS, card, esc, titleCase, ago, fc, pt };
