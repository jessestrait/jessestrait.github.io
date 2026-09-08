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
from the ATX page itself. **A live outage layer needs no proxy and no server.** Not
built yet; nothing blocks it.

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
compete with the live layers, it erases them; no colour scheme survives that ratio.
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
