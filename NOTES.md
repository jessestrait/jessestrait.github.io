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

## TomTom — the layer "dropping" was not the quota, 2026-09-14

I diagnosed it as the daily allowance. The usage export says otherwise:
**zero 403s across nine days and a peak of 16,624 requests.** The account
was never throttled. That diagnosis was wrong and the evidence had not been
looked at when it was made.

The real fault was in this page. `tileerror` incremented a counter that was
cumulative for the life of the layer and never reset:

```js
if (++TRAFFIC.errors < 6 || !TRAFFIC.on) return;   // then disable
```

Six tile failures from *any* cause, spread across *any* span of time — a
sleep and wake, a lift, one flaky minute of wifi — switched the layer off
for the rest of the session and displayed a message blaming the quota.

Now: errors must cluster (8 within 2 minutes), a successful tile clears the
count, the message says what was observed rather than guessing a cause, and
it retries itself after five minutes instead of staying off.

The tile-spend reduction shipped alongside it (12-minute refresh, nothing
while idle) is still worth having at 16,624 requests in a day — but it was
not the fix, and should not have been presented as one.

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

### 0.3 Allowances — answered from the usage export, 2026-09-14

Nine days of TomTom's own analytics for the page key:

| | requests | 400 | 403 |
|---|---|---|---|
| 2026-09-05 | 3,678 | 4 | 0 |
| 2026-09-06 | 3,434 | 0 | 0 |
| 2026-09-07 | 4,542 | 0 | 0 |
| 2026-09-08 | 10,725 | 0 | 0 |
| 2026-09-09 | 11,122 | 12 | 0 |
| 2026-09-10 | **16,624** | 0 | 0 |
| 2026-09-11 | 4,718 | 0 | 0 |
| 2026-09-12 | 9,829 | 0 | 0 |
| 2026-09-13 | 3,993 | 0 | 0 |

68,665 requests, mean 7,629/day, **peak 16,624 with zero 403s and zero 5xx.**
The 16 errors in the window are all 400s. The account has never once been
throttled.

So the archiver moved to a **5-minute** cadence: 288 calls a day, which is
under 4% of a day the account already absorbed without complaint. Clearance
resolution equals the poll interval, so this is the single change that most
improves the persistence statistic.

Caveat: the export is aggregated as "Traffic API" and does not break out
tiles from Incident Details, and the free allowance is still not stated
anywhere I can read. This is an argument from observed tolerance, not from a
published number.

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

## A real Lakeway outage that this map could not see, 2026-09-14

Reported from the ground: an outage near Lakeway, ~299 customers, traffic
signals dark across the area. Neither feed showed it.

- **Austin Energy** reported `n_out: 0, cust_a: 0` across all 51 ZIPs, from
  a report published 3.8 minutes before it was read. Not staleness.
- **COA traffic signals** had 115 signals in fault citywide and **zero within
  12 km of Lakeway.**

Both blanks have the same cause and it is not a bug. These are
City-of-Austin feeds and Lakeway is at the edge of, or outside, what they
cover:

- ZIP 78734 *is* in AE's list with 9,060 customers served, but a ZIP that
  size is split between utilities. Lakeway proper is largely **Pedernales
  Electric Cooperative**, and PEC outages will never appear in AE's feed no
  matter how many of its customers are dark.
- The signals dataset covers signals **the City operates**. Lakeway's are
  TxDOT's or the city of Lakeway's, so a dark signal there is invisible here
  by construction.

Worth stating in the copy: the outage layer is Austin Energy's customers,
not Austin's lights. The western suburbs — Lakeway, Bee Cave, Spicewood,
Dripping Springs — are a genuine hole.

PEC was probed briefly and its outage map did not resolve to anything
fetchable (`outagemap.pec.coop` and `www.pec.coop/outages/` both failed to
connect; `outages.pec.coop` returns a JS shell). If that is ever worth
filling, start by watching the network tab on their public map the way the
KUBRA chain was found.

## CapMetro publishes broken route shapes (2026-09-16)

579 of the 7,323 shape variants in the static GTFS skip more than 1.2 km
between consecutive points. Five route/directions were picking one as their
most-used shape, which drew the bus flying across open ground — route 392
jumped 1,748 m over Walnut Creek, route 339 2,494 m.

In every one of those five the feed publishes a sound sibling shape, used by
exactly the same number of trips (3452/3453, 854/855, 4025/4026, 3540/3541,
1356/1357). The tie used to be broken arbitrarily. tools/build_capmetro.py now
measures every candidate's largest step first and prefers a sound one, provided
it keeps at least half the trips of the most-used.

Route 491 has no sound variant in either direction — all four candidates are
broken — so it is split at the hole and drawn with a visible break.

Threshold is 1,200 m, taken from the distribution rather than by feel: p90 of
all candidates is 445 m, the genuinely broken ones start at 1,552 m, and the
longest legitimate run is route 550's 900 m down the tollway.

Worth reporting upstream to CapMetro if there is ever a channel for it.

## Audit of the other prebuilt geometry (2026-09-16)

After the route shapes, checked every file in atx/data/ for the same classes
of fault. tools/check_geo.py is that audit, kept so it can be rerun.

Clean: no NaN, no coordinates outside the metro, no unclosed or short rings,
and no truncated queries — blockgroups 644/644, parks 371/371, trails
4096/4096, streets 28006/28006 all match their source counts, and the two
that differ do so deliberately (floodplain drops slivers, zips is filtered to
Austin Energy's).

Found and fixed:
  - floodplain shipped 225 rings of exactly zero area inside 51 features that
    drew nothing. Simplifying at 0.0008 deg flattens a long thin sliver onto a
    single coordinate while its bounding box stays wide, so the sliver filter —
    which measures the box — passed it. The builder now also requires real
    area. Two of those parts still carried a hole with area, i.e. a hole with
    no polygon around it, which was subtracting 0.0027 km2 from the total.
  - districts.json carried 2,844 points identical to their predecessor, 29% of
    the file. It is the one layer no script builds; it was fetched by hand at
    full precision and never simplified. Squashed, 210 KB -> 151 KB.

Deliberately not checked by diffing shipped geometry against a fresh
full-precision fetch: matching a simplified feature back to its source by
centroid and extent is unreliable for small parallel features. It reported
trails as 52 m out; fetching one trail by id showed 1.9 m against a 2.2 m
budget. ArcGIS honours maxAllowableOffset, verified per-feature at three
different offsets.

## Creek gauges got a trend and a scale (2026-09-17)

The gauges layer already read USGS; what it could not say was whether a creek
was coming up, or whether the number was high. Both added:

  - USGS is now asked for an hour (period=PT1H) rather than the latest value,
    +42 KB, and the rate is taken across the whole window rather than between
    the last two readings — consecutive values differ by hundredths and
    dividing that by 15 minutes turns noise into drama.
  - Rising is 0.10 ft/hr. Measured on a dry night: across 37 gauges the
    largest hourly change was 0.075 ft/hr and p95 was 0.03.
  - NWS flood thresholds baked by tools/build_flood_stages.py into
    atx/data/floodstages.json (2 KB). The NWPS bbox listing does not carry
    them or the USGS id, so it is one request per gauge — fine at build time,
    not in a browser. 11 of 36 gauges publish both; they are the named creeks.
    Rebuild if NWS revises a forecast point, which is rare.
  - A closed crossing now names the nearest gauge and what it is doing. Built
    when the popup opens, not when the layer loads, because the two feeds race
    and either can win.

NWPS needs srid=EPSG_4326 on the bbox query or it returns an empty list with
a 200. CORS is open on it.

## Handoff-3 verification results (2026-09-17)

Part C — camera stills are **1920x1080**. By the handoff's own decision tree
that makes it a display problem, so: lightbox, no multi-camera grid. The
images carry no CORS header, which does not matter — an <img> needs
permission to be read back, not to be shown, and nothing reads them back.
Not archived, deliberately; see the About entry.

Part A — the premises were worth checking, and two are different from the
handoff's read:

  - zone_status IS lifecycle (Active / Inactive / Removed), as suspected.
    Active: AISD 95, PRIVATE 17, RRISD 15, plus PISD and LISD.
  - Districts: **eight**, not five, and Del Valle IS among them — I said it
    was not, off a group query my parser had truncated. Austin 104,
    Private 19, Round Rock 15, Pflugerville 6, Leander 5, Eanes 5, Del Valle
    3, Manor 2, plus 9 blank. The register spells several of them more than
    one way ("AISD" / "AISD (Austin)", "PRIVATE" / "Private",
    "AISD / PRIVATE" / "AISD /PRIVATE"), so the builder normalises. One zone
    is flagged year-round, which is exactly the case a reader's instinct
    about the school year would get wrong.
  - a7ua-4hkr carries NO geometry. The zone shapes are on GeoHub as
    `School_Zones`, 361 polylines with SCHOOL_ZONE_ID, SCHOOL_NAME,
    STREET_NAME — a school zone is a stretch of street, which is the right
    shape for it.
  - The big one: **the flash windows are in the data.** mzsm-hucz carries
    am_plan, pm_plan and pm_2_plan per beacon as real clock windows
    ("06:55 - 08:00", "14:30 - 15:35"), and pm_2_plan is the early-release
    window the handoff expected to hand-maintain. Beacons also carry
    coordinates. So A4's "times must come from elsewhere" is wrong: what is
    still missing is only which DAYS are school days per district.

## Phase 1 actually works now, and half of it never can (2026-09-18)

Two findings, four days into the traffic archive.

**The matcher was discarding the day's matches every poll.** One line —
`day_doc["matches"] = matches`, beside two that `.extend()`. Each poll only
matches across what is open at that moment, so the file kept the last poll's
handful. Re-running the two retained days: the 16th 5 -> 33, the 17th 1 -> 37,
and persistence went from zero samples to 33 and 37.

How it was found, because the obvious suspect was wrong: 25% of dispatch
records have a TomTom record within 200 m and 90 min while the matcher was
accepting 0.7%, so the signal existed. Instrumenting the gates to catch the
road-name test — TomTom writes "Lakeline Blvd (S Bell Blvd/US-183)", APD
writes "4900-5424 E Slaughter Ln", an exact set intersection should never
fire — showed it rejecting nothing, and 101 pairs surviving every gate on a
day the file recorded one. That pointed at the write.

**APD dispatch records are dropped on a two-hour cap.** 290 episodes: p50
115.2 min, p95 119.5, nothing past ~120, modal 5-minute bins 115 (96) and
120 (78). A fender bender and a rollover cannot both take 115 minutes — that
is retention, not clearance.

So `ended_at` on a dispatch record is administrative, and **persistence —
"how long does the jam outlive the wreck" — is not obtainable from this
pairing at all.** Half of Phase 1's headline is unanswerable, and no amount
of matcher tuning changes it. The summary now detects the cap from the data
rather than assuming it, flags persistence_min unreliable, and says so in the
caveats.

**Onset offset survives and is the real result.** n=70 over two days: median
+9.7 min, q1 -9.9, q3 +37.9, and the jam appears *after* APD publishes 66% of
the time. That is the opposite of the intuition that probe data is an early
warning, and it is worth knowing before B4 adds HERE as a third witness.

## B4 (HERE): what the terms say, and the decision to build anyway (2026-09-18)

**HERE.** Two clauses, either of which alone rules out the archive:

  - data may be stored or cached for no more than thirty (30) days, and only
    so far as needed to enable or improve an end user's use of the service;
  - caching or storing location data "for the purpose of building a
    repository of location assets" is prohibited outright.

The second names Phase 1's purpose exactly, so designing restrictively — the
escape used for TomTom's Phase 0.2, where the terms were unreadable and the
answer was a 2-day retention with aggregates kept — does not help here. The
thing prohibited is the reason for doing it.

Provenance, stated because it matters: I could not fetch the primary text.
legal.here.com/en-gb/terms/serviceterms returns 181 KB of page containing
15 K of readable text and none of the clauses — rendered client-side, the
same wall as TomTom's Phase 0.2. Both clauses come from search summaries of
HERE's own terms and developer pages, corroborated independently. The
decision is robust to the exact wording; the risk is not symmetric, since
getting it wrong means an automated job breaching a commercial provider's
terms every five minutes. It also needs a key, which is a second reason to
stop rather than a first.

**Then the hunt for a replacement, all negative:**

  - TxDOT hosted ArcGIS: 770 services, all reference and planning — traffic
    counts, networks, signals. No live incident or closure feed.
  - its.txdot.gov/api/incidents answers 200 with 1.8 MB of the site's own SPA
    shell, not JSON, and sends no CORS. A real endpoint would mean front-end
    archaeology, like the KUBRA chain. (CORS itself would not have blocked
    it — the archiver runs in Actions, not a browser.)
  - Waze for Cities: Austin republishes none of it, on Socrata or GeoHub.
  - Austin's own Bluetooth travel-time sensors (v7zg-5jg9, x44q-icha) would
    have been the ideal third witness — a city-operated probe network with
    completely different physics from TomTom's connected vehicles, public and
    archivable. **Dead since 2021-12-22.**

No replacement, then. The recommendation above was to stay at two witnesses.

### Overridden, deliberately, and built (same day)

Jesse's call, having read the above: build it. The reasoning is sound and I
am recording it rather than paraphrasing it — the thirty-day cap is not a
constraint this archive was ever going to strain, since vendor rows are
pruned after **two** days and have been since TomTom went in. The collector
now refuses `--retain-days` above 30 outright, so the cap is enforced by the
code rather than by anyone remembering it. What is kept past two days are
aggregates: counts, medians, the onset distribution. Those are derived
statistics, not stored location data, and they are the entire product.

The "repository of location assets" clause is the part that is genuinely
strained, and it should be said plainly rather than argued away: a rolling
two-day cache that exists to compute statistics is not what that clause
appears to be aimed at, but I could not read the primary text to check, and
that uncertainty does not disappear because the decision went the other way.
What reduces the exposure to something Jesse judged acceptable: the page is
his own, unlisted rather than promoted, HERE's rows are never republished
raw beyond the current five-minute snapshot, and nothing accumulates.

**What was built**

  - `fetch_here()` in `tools/capture_traffic.py` — Traffic API v7 incidents,
    `locationReferencing=shape` (required, and the only way to get geometry).
    HERE documents that a bbox ceiling exists but not what it is, so a 400
    splits Austin into quadrants and retries rather than hard-coding a guess.
  - HERE is **optional**. No key means the job runs on two witnesses and says
    so; a HERE fetch that fails mid-run keeps its open episodes open rather
    than inventing clearances for all of them. The live chain must not be
    takeable down by a third source.
  - `probe_agreement()` — TomTom against HERE, line to line. Coverage, not
    closest approach: two different halves of I-35 touch at the join and
    score zero metres apart, which would have been a false pair every time.
  - `summary.witnesses` — of the day's dispatch records, how many both probe
    networks saw, how many only one saw, how many neither did. This is the
    statistic the third witness was actually wanted for; with one probe feed
    "small incident" and "thin fleet on that road" are indistinguishable.
  - A `Traffic incidents (HERE)` layer on the map, reading `here-now.json`
    off the data branch. **The page holds no HERE key** — the archiver
    already polls every five minutes from Actions, so the page reads its
    output. No vendor key in a public repo, and a thousand visitors cost
    HERE one request rather than a thousand.

**Testing, and what it caught.** No key exists yet, so HERE itself was never
called. The parser was tested against a response built to the documented v7
schema, the bbox fallback against a stubbed 400, and `probe_agreement` against
400 real archived TomTom lines with synthetic HERE twins.

That last test failed first time and was right to. It planted twins 25 m away
and decoys 1.2 km away and counted labels — but a 1.2 km shift of an I-35
segment lands back on I-35, where a *different* TomTom episode genuinely sits
3 m away. The decoys were true pairs and the matcher was correct; the test's
ground truth was wrong. Rewritten to verify decoys are actually far before
using them as decoys, and to assert soundness against measured distance
rather than against a label: 142/142 reported pairs inside their own buffer,
0/68 verified-far decoys reported, 120/120 recall. Twelve of the original
eighty decoys had landed on a real road — which is the whole reason the first
version passed nothing.

`--rematch` on the real 2026-09-17 archive returns 37 matches from 37: days
recorded before HERE existed read exactly as they were written.

**Still needed:** the key. Nothing HERE-shaped will appear until

    gh secret set HERE_ARCHIVE_KEY --repo jessestrait/jessestrait.github.io

is run with a freemium key from platform.here.com. Until then the layer reads
"Waiting on a HERE key" and the archive carries on with two witnesses.

## B5 (TxDOT): found live after HERE died on a payment wall (2026-09-19)

HERE is blocked, not abandoned. Its Traffic API appears to require the
**Base Plan**, which demands a credit card at registration — the no-card
**Limited Plan** does not list Traffic anywhere in its RPS table, which
names 24 services down to Destination Weather. Jesse's card would not go
through. The integration stays built, tested and dormant; it needs
`HERE_ARCHIVE_KEY` and nothing else.

Two apparent substitutes are traps, recorded so nobody tries them twice:
**Azure Maps** traffic is TomTom-sourced, so it is the fleet we already have
wearing a different badge; **Amazon Location** only returns incidents
attached to a route it computed for you, so it cannot answer "what is
happening in this box", which is the only question this archive asks.

### The feed that does work

    services5.arcgis.com/Rvw11bGpzJNE7apK/.../DriveTexas_API/FeatureServer/0

TxDOT DriveTexas, via TDEM's published copy. No key, no card,
`Access-Control-Allow-Origin: *`. 632 rows statewide, 5 in the Austin bbox,
all I-35. Readable fields: condition, route_name, travel_direction,
delay_flag, detour_flag, roadway, from_limit, to_limit, start_time,
end_time, description, create_time.

**Three sibling services publish the same schema and two are dead.**
`HCRS_Edit_AGO` returns zero rows on both layers. `HCRS_CC` is the dangerous
one: 20 points and 481 lines, correct schema, entirely convincing — and
every timestamp is from **August 2020**. It is a frozen snapshot. The only
thing that distinguishes the live service is `create_time`, so check it
before trusting any TxDOT endpoint. This is the same failure as the
Bluetooth travel-time sensors, which also looked perfect and also stopped
publishing years ago.

**What it is and is not.** Not a HERE replacement. HERE would have been a
second probe *network* — congestion measured from vehicle telemetry, an
independent instrument. TxDOT is the road authority *reporting its own
work*. It is a second reporter beside APD dispatch, not a second
measurement, so `probe_agreement` and the `witnesses` breakdown still want
HERE. What it fills is the coverage gap B5 named: the state owns I-35,
Mopac and US-183, and their closures appear in no city dataset.

**Where it changes a number.** `summary.roadworks`. Of the day's congestion
that no dispatch record explains, how much sits on a stretch TxDOT has
coned off. Measured against the real 2026-09-17 archive: **395 of 2,903
unreported jams, 13.6%**, and 352 of 2,644 recurrence buckets. That was the
largest false category in `structural_hotspots` — a jam recurring every
weekday at 7am on a road rebuilt since 2024 is not an unexplained property
of the road. They are marked rather than dropped (the recurrence is real,
it just has a cause on file) and sorted last, so the head of the list is now
genuinely unexplained congestion: S Lamar at Ben White, Westlake Dr, Metric
at Parmer.

**Not upserted as episodes, deliberately.** These are multi-year projects
with end dates in 2029, so "it left the feed" means a work order changed,
not a road reopening at that minute. Current state only, replaced each poll.

**Freshness, stated precisely.** Statewide the newest row was under three
hours old. Within the Austin bbox the newest was about 4.6 days old — the
feed is live, Austin's own rows simply change slowly. The layer says
*scheduled*, not *active now*, for the same reason the school zones do: the
dates span the whole project and the nightly window lives in prose.

**The HERE map layer is gone (2026-09-19).** A checkbox that can only ever
say "Waiting on a HERE key" is clutter, so the layer, its loader and its
About entry came out of `atx/index.html`. Nothing else changed: the archive
side of HERE — `fetch_here`, `probe_agreement`, `summary.witnesses` — is
untouched in `tools/capture_traffic.py` and still runs the moment a key
exists. If one ever does, re-adding the layer is a GROUND entry plus a
loader that reads `here-now.json`; see commit 00b9a87 for the version that
was removed. Old shared links naming `hereinc` restore harmlessly — the URL
restore iterates GROUND and skips ids it does not find (verified).

## CapMetro 7.3–7.5: arrivals, alerts, and the nearest stop (2026-09-19)

**Trip updates are published as JSON, and the relay was pointed at the
wrong file.** `/trips` went to `rmk2-acnw`, the protobuf build, on the
assumption that trip updates only came as bytes — the relay's own comment
said "the caller needs a decoder". They do not: **`mqtr-wwpy` is the same
feed as JSON**, and `9zu9-jwr2` is the service alerts, also JSON. So the
page needs no protobuf decoder. 728 KB raw for trips, but 36 KB gzipped;
alerts are 58 KB raw and 9 KB gzipped.

**The one honest limitation.** The trip-updates feed carries absolute
arrival times and *nothing else*: no `delay` on the trip update, no `delay`
inside any arrival or departure object. Verified by walking every field of
every prediction across all 1,591 entities in a live pull — the only keys
present anywhere are `arrival.time` (1,217) and `departure.time` (81). So
the page can say "next one in six minutes" and cannot say "four minutes
late". Computing lateness needs `stop_times.txt` from the static GTFS to
subtract from, which is megabytes for a number nobody asked for; the
prediction is what someone waiting actually wants. The About text says so.

**Alerts are not GTFS-realtime shaped** despite the name — a bare JSON
array, no header, no entity. 91 in the feed, 83 active, touching 46 routes
and 77 stops, effects NO_SERVICE / DETOUR / REDUCED_SERVICE /
MODIFIED_SERVICE. Filtered on `deletedAt` and on `activePeriods` covering
now, then indexed by route and by stop and deduped across both, because a
detour is usually filed against both and showing it twice reads as two
problems.

**PII.** Each alert carries `userFullname` and `userEmail` — the CapMetro
staffer who filed it, at their work address. That is CapMetro's decision to
publish and the relay passes bytes through unchanged, which is the one
promise it makes. But nothing on the page reads those fields, and there is
a test asserting no rendered alert HTML contains them.

**Buses move.** See the commit; the short version is a stable vehicle id,
markers reconciled rather than rebuilt, and a canvas of their own because
Leaflet repaints an entire canvas when any layer on it moves. `busFrame()`
is deliberately a named function rather than a closure in the rAF callback
so the animation can be driven with a clock in a test.

**Everything degrades to silence.** Until the relay is redeployed, `/alerts`
is a 404 and `/trips` still answers protobuf; both land as caught failures
and the transit layer behaves exactly as it did before. Verified against
the live deployed relay: 0 arrivals, 0 alerts, 14 buses, note unchanged.

**Still needed: the relay deploy.** From `workers/capmetro/`:

    npx wrangler deploy

## TomTom Phases 2, 3 and 4 (2026-09-19)

The tiles were the only TomTom layer here and they are the crudest: you
cannot count a pixel, tap one, or ask it how many minutes of delay it
represents. They are also the expensive one — tile cost scales with map
*motion*, every pan and zoom refetching a grid, which is how nine days came
to 68,665 requests. Everything below scales with *attention* instead, and
bills on a different meter.

**Phase 2 — incidents as objects.** The same Incident Details endpoint the
archiver has been recording, browser-side on the page key. One request per
settled view, `moveend` debounced 600 ms, bounding box snapped to a 0.05°
grid so a small pan reuses the answer, 60 s cache, twelve boxes retained.
Drawn as linestrings on `ttincPane` under the pins, coloured by
`magnitudeOfDelay`, with a countable mark at the upstream end and the
view's total delay in the layer note. Off by default. No confidence
styling — that is Phase 5 and it wants weeks of matcher output first.

The bbox needs both a ceiling and a floor. TomTom rejects anything over
10,000 km² with a 400 (measured when the archiver's box was sized), so the
span clamps to 0.7°; verified that a 4°-wide view clamps to 5,594 km².
And a map that has not been laid out reports a **zero-size viewport** —
seen for real in a hidden tab — which without a floor becomes a one-cell
box holding nothing, cached as a confident answer for the next minute.
Floored at 0.08°.

**Phase 3 — flow segment, tap-only.** `flowSegmentData/relative0/12`, in
mph. Zoom 12 is the granularity that matters: lower averages a whole
corridor into uselessness, higher splits a road into pieces shorter than
the queue being asked about. Reached from a button inside any incident
popup. The segment TomTom measured is highlighted for 20 seconds, because a
speed with no extent invites you to read it as being about wherever your
finger landed. Confidence is shown beside the number since it varies.

**Phase 4 — reachable range, tap-only.** Three nested polygons at 10/15/20
minutes, `traffic=true&departAt=now`, on `rangePane` under the pins. Reached
from a button in the locate readout or by long-press anywhere — Leaflet
fires `contextmenu` for both right-click and touch long-press, so one
handler covers both.

One real bug found and fixed in testing: Leaflet bubbles a path click up to
the map, and the map click is what dismisses the rings — so tapping a ring
to read it removed it before its popup could open. Fixed with a one-tick
`TTR.hold` flag rather than `stopPropagation`, because stopping the event
also robs `bindPopup` of the click it opens on.

**The bbox took three passes, and the first two were wrong.**

Pass one snapped the box to a 0.05° grid and the comment claimed a nudge of
the map cost nothing. Measured, it did not: the box changes whenever
*either edge* crosses a grid line, so panning in small steps re-snaps
constantly — **0.71 / 0.46 / 0.25** of small pans at zoom 12 / 13 / 14.

Pass two made the box **sticky**: keep it until the viewport actually
leaves it, and only then recompute. **0.29 / 0.13 / 0.04** — between 2.4×
and 6× fewer requests.

Pass three fixed the hole that left. A view whose edge lands exactly on a
grid line snaps to itself and gets *no* slack on that side, so a 0.005°
nudge escaped and re-asked immediately, which defeats stickiness entirely.
Half a cell of padding before snapping guarantees margin on every side.
Worst case after padding is a 0.85° span — 7,699 km², still under TomTom's
10,000 km² ceiling.

Verified live on jessestrait.com afterwards: a view edge on a grid line no
longer re-asks on a nudge, travelling across town does, zooming out widens
the box, and zooming back in does not re-ask because the wider box already
covers it.

**Live verification** (jessestrait.com, where the key is valid): Phase 2
returned 51–55 incidents with 15–21 minutes of delay in view, categories
and magnitudes mapping correctly. Phase 3 on I-35 downtown returned
"20 mph of 20 free-flow · 100% of normal, road class 5, confidence 1.00"
with a 37-point segment highlighted. Phase 4 returned three properly nested
rings, 53 / 35 / 19 km tall, spiking out along the highway corridors.

One gotcha worth keeping: `atxAudit` flagged `ttinc` as broken during
testing because the test set `layer.on = true` in JS rather than ticking
the box, leaving the flag and the checkbox disagreeing. That is the check
doing its job, not a bug — toggling through the real control audits clean.

**Off-domain behaviour.** The page key is locked to jessestrait.com, so on a
dev server all three answer 403 InvalidReferer. That is correct, not a bug
to route around, and each says so specifically ("TomTom refused the key for
this domain") rather than failing silently. Verified, along with a clean
audit and zero orphans on toggle off.

## The morning three unrelated things broke at once (2026-09-19)

Reported as "I can't see buses, it says a feed is down, and on my iPhone
there's no 311 or fire — this seems all fucked". None of it was the page,
but the page's presentation of it deserved the reaction.

**What was actually happening, all at the same time:**

  - `data.austintexas.gov` returning **503** on every dataset. That is
    fire, 311, signals, crashes and the dispatch feed.
  - `data.texas.gov` returning **503**, so the relay correctly answered
    `502 No upstream answered` — which is the buses.
  - The **TomTom account out of credits**: 403 with
    `{"detailedError":{"code":"InsufficientFunds"}}`.

**The browser lies about the first one, and this is worth remembering.** A
503 error page carries no CORS header, so a plain upstream outage surfaces
in the console as *"blocked by CORS policy: No 'Access-Control-Allow-Origin'
header is present"*. That sends you hunting a configuration bug that does
not exist. Always check the upstream with curl before believing a CORS
message.

**Three real defects this exposed, all now fixed.**

1. **A failed layer never retried.** `fetchLayer` set `state.data[id] = []`
   and stopped. Only five layers have a refresh timer, so 311, signals,
   crashes, wildfire and headlines stayed "err" until a manual reload —
   a transient outage became a permanent one for the viewer. Now failures
   are recorded with an attempt count and retried on a backoff
   (20s / 45s / 2m / 5m / 15m), one layer at a time, fewest attempts
   first, so a portal coming back is rediscovered gently.

2. **Eight identical "err" badges and "a feed is down".** The interesting
   fact is the *host*, once. The pulse now reads
   "data.austintexas.gov is not answering · 4 layers waiting, retrying in
   20s".

3. **The TomTom 403 was reported as the wrong cause.** The first pass
   assumed 403 meant the referer lock — reasonable, the page key is
   domain-locked — so it said "TomTom refused the key for this domain"
   while standing on exactly the domain the key is locked to. The same
   mistake as the CORS message, made by my own code. It now reads
   `detailedError.code` and distinguishes out-of-credits from the domain
   lock from rate-limiting.

**`atxTest()`** — the routine that should have existed before this.
Probes every upstream directly and prints a table with a verdict, so the
first question ("is it me or is it them?") takes ten seconds instead of a
conversation. `atxRetry()` drops every backoff for when you know an
upstream just came back. Deliberately not automatic: a page that probes
eight services on load to prove it can is worse than one that just loads.

Its own first run cried wolf twice — an invented `&limit=1` on the NWS
alerts URL returned 400, and a guessed bcycle hostname 404'd. Both probes
now use the page's own URLs verbatim. A self-test that invents its own
request tests the invention.

Recovery is tested rather than assumed: `retryDue()` is a named function,
not an anonymous interval body, for the same reason `busFrame()` is —
a recovery path nobody has watched run is not a recovery path.

## `npx wrangler deploy` from the repo root publishes the whole repo (2026-09-19)

Running the relay deploy from the repository root instead of
`workers/capmetro` did not fail, which is the dangerous part. Wrangler
found no config, **guessed** one, wrote a `wrangler.jsonc` at the root
naming the whole repository as a static Cloudflare site with
`"assets": {"directory": "."}`, and published **1,218 files including
`.git/objects`** to `jessestrait-github-io.jessestrait.workers.dev`.
Verified live: `/.git/config` and `/.git/HEAD` both answered 200. It never
touched the actual worker.

Exposure was low and it is worth saying why rather than hand-waving: the
GitHub repo is already public, so the history was already public. A scan of
all 1,866 commits across every ref found no secret-shaped assignments, no
`TOMTOM_ARCHIVE_KEY` value ever committed, and no HERE key — the only key
in the tree is the page's TomTom key, which is deliberately public and
domain-locked. Deleted the deployment regardless.

Prevention: the stray root `wrangler.jsonc` is removed, and the worker's
README now says why the `cd` matters and what a wrong-directory run looks
like ("Framework: Static", an output directory prompt, and a worker named
after the repo rather than `capmetro`). Wrangler's `.gitignore` additions
were kept — `.dev.vars*` and `.env*` are exactly the files that should
never be committed.
