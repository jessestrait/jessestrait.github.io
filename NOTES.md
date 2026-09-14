# Findings

Things established by looking, that would otherwise have to be established again.

## Austin Energy outages — the endpoint, 2026-09-08

The public viewer at `outagemap.austinenergy.com` is **KUBRA StormCenter**, and its
data is on `kubra.io`:

```
GET https://kubra.io/stormcenter/api/v1/stormcenters/{SC}/views/{VIEW}/currentState?preview=false
    SC   = dd9c446f-f6b8-43f9-8f80-83f5245c60a1
    VIEW = 76446308-a901-4fa3-849c-3dd569933a51
 -> data.interval_generation_data  = "data/<deployment-uuid>"
    stormcenterDeploymentId        = the config to read next
    updatedAt                      = epoch ms, when this deployment was published

GET https://kubra.io/stormcenter/api/v1/.../configuration/<stormcenterDeploymentId>?preview=false
 -> names "public/reports/<uuid>_report.json"

GET https://kubra.io/data/<deployment-uuid>/public/reports/<uuid>_report.json
 -> the outage data
```

**The deployment uuid rotates on every publish.** That is how they bust a 24-hour
CloudFront cache (`cache-control: max-age=86400`), so it cannot be hardcoded — read
`currentState` every time. The report uuid comes from the configuration, so the whole
chain self-heals if any id rotates.

**Refresh interval: 10 minutes**, stated by the viewer ("Information updated every 10
minutes") and consistent with observed `updatedAt` values.

**Response shape.** Per **ZIP**, not per outage — 51 ZIPs covering 591,797 customers:

```json
{ "key": "zip", "name": "78703", "n_out": 1, "cust_a": {"val": 1}, "cust_s": 11444,
  "percent_cust_a": {"val": 0.0}, "etr": "2026-09-08T09:24:00Z",
  "gotoMap": {"bbox": [w, s, e, n]}, "areaId": "Boun|78703|zip" }
```

plus an authoritative `file_data.totals`. **There is no stable per-outage id anywhere
in it** — the planning assumption that "each outage carries an ID" does not hold for
this endpoint. Individual outages exist only as quadkey-addressed cluster tiles
(`public/cluster-1/{q}.json`), which would mean walking a quadtree per poll.

### CORS: open

`access-control-allow-origin: *` on all three endpoints — verified by response header
with an explicit `Origin: https://jessestrait.com`, and by a real cross-origin `fetch`
from the ATX page itself. **A live outage layer needs no proxy and no server.** Built — the `outages`
ground layer, shading ZIP polygons by customers out.

The archive is read back the same way. The `data` branch is not what Pages serves, so
the page fetches `raw.githubusercontent.com/.../data/outages/<date>.json`, which sends
`access-control-allow-origin: *` — verified against an explicit Origin. That is the
Power history panel: episode counts, the longest outage, whether AE beat its own
published ETR, and minutes in the dark per customer served — joined to ZIP
demographics built by `tools/build_zip_demographics.py`.

Capture still runs server-side, because CORS was never the reason for capturing:
outage state is not published as history, so it has to be written down as it happens.
See `tools/capture_outages.py` and `.github/workflows/capture-outages.yml`. The archive
lives on the orphan **`data`** branch — one commit per poll would otherwise rebuild the
Pages site 96 times a day, against ~17 real commits a month on `main`.

## Does the map read as one map or two? — 2026-09-08

Asked with two live layers (traffic, fire) plus the archival ones switched on.

**With the live layers alone: one map.** Red traffic, yellow fire, pink crashes at
~180 pins are legible together and read as a single statement about right now. On that
evidence the **"Now / History" mode toggle is dead — don't build it.**

**The real problem is volume, not confusion.** The 2023–2025 fire archive puts **6,956
points** into the same 24-hour view against **177** live ones — 39:1. It does not
compete with the live layers, it erases them; no color scheme survives that ratio.
That is a pre-existing property of the archive layer, unrelated to live-vs-history, and
it is the thing worth fixing if anything here gets fixed.

## Real-Time Fire Incidents (`wpu4-x69d`) — 2026-09-08

Column-for-column **identical** to `dx9v-zd7x`, the traffic layer — same CTECC feed,
same names (`traffic_report_id`, `published_date`, `issue_reported`,
`traffic_report_status`, ...). The handoff's warning that fields would differ was wrong,
usefully so: the code path transferred unchanged.

- ~92 incidents a day, of which ~1 in 7 days arrives at `latitude = "0"` rather than
  null, so a null check alone does not catch it. The existing `Math.abs(lat) > 1` filter
  in `fetchLayer` does.
- `agency` is `FIRE` on all 42,953 rows — not worth showing.
- No medical calls at all; the city withholds them under HIPAA.
- History back to 2025-07-18, so the 7d/30d/90d windows work.


## Removed 2026-09-08, kept here in case they come back

### The fire archive (`v5hh-nyr8`)

Pulled from the UI along with the whole **Archives** section. It was the layer
that put 6,956 points against 177 live ones — see the one-map-or-two note above.
The live `wpu4-x69d` layer covers the same ground for anything recent.

Dataset is still published and still has 2023–2025 (`calendaryear` of `2023`,
`2024`, `2025`; ~6,400–7,100 calls each). Coordinates arrive as a `location`
string of the form `(lat, lng)`, not as a point column, hence the regex. It was
the only layer that set `noHour`, because a whole calendar year of calls has no
meaningful hour-of-day reading against layers windowed to 24 hours.

To restore: put this back in `LAYERS`, re-add a `<div id="archive">` for the
group to render into, and re-add the year `<select id="fireyear">` with a change
handler that drops `state.data.fires` and refetches.

```js
  {
    id: 'fires', group: 'archive', color: '#ff9d2e', on: false,
    name: 'Fire incidents', note: 'Austin Fire Department, 2023–2025',
    async load() {
      const year = document.getElementById('fireyear').value;
      const rows = await soda('v5hh-nyr8', {
        '$select': 'incident_number,incdate,problem,council_district,prioritydescription,location,responsearea',
        '$where': "calendaryear = '" + year + "'",
        '$order': 'incdate DESC', '$limit': 8000
      });
      return rows.map(r => {
        const m = /\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(r.location || '');
        if (!m) return null;
        const t = r.incdate ? new Date(r.incdate) : null;
        const cat = titleCase(String(r.problem || '').replace(/^[A-Z]+\s*-?\s*/, '')) || 'Fire';
        return {
          lat: +m[2], lng: +m[1], t, cat, noHour: true,
          html: pop('#ff9d2e', 'Fire call', cat, t ? t.toLocaleDateString() : '', [
            ['Code', r.problem],
            ['District', r.council_district],
            ['Response area', r.responsearea],
            ['Priority', r.prioritydescription],
            ['Incident', r.incident_number]
          ])
        };
      }).filter(Boolean);
    }
  },
```

### Draw as (clusters and heatmap)

`state.mode` used to switch the point renderer between dots, `L.markerClusterGroup`
and `L.heatLayer`, carried in the hash as `r=`. The control is gone and dots are
the only renderer, which also let `leaflet.markercluster` and `leaflet.heat` come
out of the page and out of the service worker's precache.

Worth knowing if it ever returns: `leaflet.heat` reads back its own canvas, so it
throws on a container with no size (background tab, pane mid-layout) — the old
code guarded with `map.getSize().x > 0` and redrew on `resize`; and `setOptions`
reaches through to the map, so the layer had to be attached *before* it was
configured. Cluster mode had to use `chunkedLoading: false`, because a chunked
load that finished after the layer was removed threw on `getMinZoom` of null.


### The text filter

Removed 2026-09-08 with the panel reorder. A single input that narrowed every
point on the map to those whose category or popup text matched, debounced 220ms,
carried in the hash as `q=`. It had a whole `.sec` and heading to itself for one
field, and the layer checkboxes already do the coarse version of the same job.

To restore: this markup, a `q` key back on `state`, the `input` listener that
sets `state.q` and re-renders, the `q` line in `saveUrl`/`restoreUrl`, and one
line back in `visibleFeatures`:

```js
const q = state.q.trim().toLowerCase();
// ...inside the per-feature loop:
if (q && !(f.cat + ' ' + f.html).toLowerCase().includes(q)) return;
```

```html
<div class="sec">
      <h3>Filter</h3>
      <input type="text" id="q" placeholder="Filter everything on the map…" autocomplete="off" />
    </div>
```

## TomTom — Phase 0 findings, 2026-09-14

Verified by calling the API, not inferred from docs.

### 0.1 Two keys — done, and confirmed

The page key is now domain-restricted to `jessestrait.com`. Confirmed by
watching it change: the same request returned **200 with no referrer at
20:05Z and 403 `InvalidReferer` at 20:24Z**. The page itself is unaffected —
13 tiles, 0 errors, single-tile probe OK from the live origin.

That also means **the archiver must have its own key.** Actions sends no
referrer, so the page key cannot work there by construction. It goes in the
`TOMTOM_ARCHIVE_KEY` repository secret and must have no domain restriction.

### 0.2 Retention — NOT answered; designed around instead

`developer.tomtom.com/terms-and-conditions` 301s to `docs.tomtom.com`, and
both render client-side: 287 characters of extractable text, no clause. A
search summary mentioned 90 days for downloadable map data and 60 for
Traffic Analytics, but that is a summary of a different product and was not
verified against the document.

So the archiver assumes the **restrictive** reading, which the handoff notes
costs nothing: derived minimal fields only, never raw responses, TomTom-
bearing daily files pruned after `--retain-days` (default 2), and aggregates
— which are analysis output rather than Content — kept indefinitely. The
statistics survive either reading. Dispatch rows are Austin open data and are
not pruned.

If the clause is ever read and turns out permissive, loosening is one flag.

### 0.3 Allowances — still blocked, needs the dashboard

Cannot be read without the account. The archiver therefore defaults to the
**15-minute** cadence, not 5: 96 calls a day, about 2,900 a month, which is
under any plausible allowance. `--interval` and the workflow cron are the
only things to change if 0.3 says 5 is affordable.

### Endpoint facts

- **Max bbox is 10,000 km².** Confirmed by a 400: *"Area of 'bbox' parameter
  is larger than 10,000km2."* The Austin box is ~1,750 km², well inside.
- **Every field in the handoff exists** on Incident Details v5 and the
  `fields` selector syntax in `tools/capture_traffic.py` works verbatim.
- **`numberOfReports` and `lastReportTime` are almost always null** — present
  on 4 of 169. Do not build a popup around them.
- **Ids are stable.** 169/169 identical across polls, `startTime` unchanged
  on all of them. But the UUID portion repeats — 74 distinct uuids across 169
  ids — so the **full id string is the key**, not the uuid.

### The one that matters: this feed may not be able to answer the question

Sampled 20:20Z on a Monday:

- The **youngest incident in the whole Austin bbox started 394 minutes ago.**
  Median age 4 days; oldest 1.6 years.
- **Zero churn over 20 minutes** — 169 in, 169 out, nothing appeared or
  disappeared.
- By category: 76 road-closed, 73 jam, 12 roadworks, 8 lane-closed. **No
  accidents at all**, while dispatch published 15 records in the same 2 hours.

So the Austin response is dominated by long-lived planned and structural
records. If nothing short-lived ever enters it, the onset-offset statistic
— the headline of Phase 1 — has nothing to measure, and no matcher tuning
fixes that.

This is one afternoon sample and should not be treated as settled; the
archiver exists precisely to find out over days. But it is the risk to watch,
and the summary reports `n` beside every figure so `n=0` stays visible rather
than being averaged into something that looks like an answer.

### A bug this nearly shipped

The first matcher used only interval overlap, as the handoff specifies. That
is necessary and nowhere near sufficient. An all-afternoon corridor jam
overlaps every dispatch record for the rest of the day, so a hazard reported
at 18:51 matched a jam that began at 11:37 — at one metre, scoring well.
Four such pairs gave a median onset offset of **−336 minutes**, which reads
as "probe data sees jams five and a half hours before APD" and is simply
false. They were never the same event.

Fixed with `--onset-window` (default 90 min): the two *start* times must be
close, not merely the intervals. Wide and symmetric, because a genuine
negative is the finding the archive exists to measure.
