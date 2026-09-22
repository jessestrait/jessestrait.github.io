#!/usr/bin/env python3
"""Record what TomTom, HERE and APD/ATD each saw, and how often they agree.

Nobody publishes, for Austin, how long a reported incident takes to become
congestion, how long the congestion outlives the wreck, or which corridors
jam with no reported cause. The halves exist live and none of them are
archived, so this writes them down as they happen and matches them offline.

Three witnesses to the same street:

  TomTom Incident Details  probe-derived, linestrings, sees the jam
  HERE Traffic v7          probe-derived, linestrings, a different fleet
  APD/ATD dispatch         reported, points, sees the cause

The two probe networks are worth having together because they are not the
same instrument. TomTom leans on phones and PNDs; HERE leans on the
factory-connected fleets of its automaker owners. Where they disagree about
a road, usually one of the two fleets is thin on it — which is a fact about
the measurement, and only visible with both.

They are kept as separate records and never merged. An association is its
own row with its own score, so a later change to the matcher's tolerances
cannot corrupt what any source actually said. Provenance is the point.

RETENTION. Both vendors constrain storing their traffic data, and neither
clause could be read at build time (both terms pages render client-side).
HERE's, on two independent readings, caps caching at thirty days. So this
assumes the restrictive reading for both, which costs nothing: derived
fields only, never raw responses, and vendor-bearing daily files are pruned
after --retain-days — two by default, and the argument refuses a value above
thirty so the cap is structural rather than a habit. Aggregates are analysis
output rather than Content and are kept indefinitely; the aggregates are the
product. Dispatch records are Austin open data and carry no such constraint.

    TOMTOM_ARCHIVE_KEY=... HERE_ARCHIVE_KEY=... python3 tools/capture_traffic.py

HERE is optional: without a key the archive runs on two witnesses exactly as
it did before, and says so rather than failing.

Writes, under --out:
    open.json                 currently-open episodes, all feeds (state)
    here-now.json             HERE's current incidents, for the map to draw
    YYYY-MM-DD.json           episodes that closed that day, plus matches
    summary/YYYY-MM-DD.json   the numbers
"""

import argparse
import datetime as dt
import json
import math
import os
import pathlib
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request

# Austin-wide and fixed, so the request is identical every poll and the row
# set is comparable across days. 0.18 deg^2 is about 1,750 km2; the endpoint
# rejects anything over 10,000 km2, verified against a live 400.
BBOX = "-97.95,30.10,-97.55,30.52"

FIELDS = ("{incidents{type,geometry{type,coordinates},properties{id,iconCategory,"
          "magnitudeOfDelay,startTime,endTime,from,to,length,delay,roadNumbers,"
          "timeValidity,numberOfReports,lastReportTime,events{code,description}}}}")

TOMTOM = "https://api.tomtom.com/traffic/services/5/incidentDetails"
FLOW = "https://api.tomtom.com/traffic/services/4/flowSegmentData/relative0/12/json"

# Nine corridors, sampled for speed rather than drawn.
#
# Each coordinate survived three checks, and each check caught something
# the one before it missed.
#
#   1. Picked by eye from intersections — landed on Deen Avenue,
#      Willowrun Cove and Juniper Road. Residential side streets.
#   2. Snapped to OSM `highway=motorway` nodes and reverse-geocoded to
#      confirm the road name. Fixed eight of nine.
#   3. Asked TomTom for each one's functional road class once credits
#      were live. US-290 still came back FRC5 — a local road with 21
#      shape points — because an OSM motorway node can still sit on a
#      frontage road as far as TomTom's map is concerned.
#
# All nine now return FRC0-FRC3 with highway free-flow speeds. TomTom's
# flow endpoint snaps to whatever road is nearest and answers without
# complaint, so a wrong coordinate produces a confident number about a
# cul-de-sac and nothing looks broken. Verify a coordinate before
# trusting a number attached to it, and verify it against the service
# that will be answering.
CORRIDORS = [
    ("I-35 north",   "at Rundberg",     30.35226, -97.69181),
    ("I-35 central", "downtown",        30.26788, -97.73376),
    ("I-35 south",   "at Ben White",    30.21866, -97.75019),
    ("Mopac north",  "at Far West",     30.35630, -97.74613),
    ("Mopac south",  "at Barton Skyway", 30.26610, -97.78151),
    ("US-183 north", "at Burnet",       30.37415, -97.72866),
    # Re-picked once credits were live and the road class could be read
    # back. The OSM-snapped point at 30.23506,-97.82407 answered FRC5 — a
    # local road, 21 shape points — because it had landed on a frontage
    # road running beside the highway. Being on the right *line* in OSM is
    # not the same as being on the right *carriageway* in TomTom's map.
    # This one answers FRC2 with 259 shape points and a 69 mph free-flow.
    ("US-290 west",  "west of Ben White", 30.22773, -97.78117),
    ("SH-71 east",   "at the airport",  30.21936, -97.67035),
    ("Loop 360",     "at Bee Caves",    30.29603, -97.82797),
]
HERE = "https://data.traffic.hereapi.com/v7/incidents"
SODA = "https://data.austintexas.gov/resource/dx9v-zd7x.json"
# TxDOT DriveTexas, via TDEM's published copy. Keyless and CORS-open.
# Two near-identical sibling services exist and both are dead: HCRS_Edit_AGO
# returns nothing, HCRS_CC is a frozen August-2020 snapshot with the same
# schema and 481 convincing rows. Check create_time before trusting any of
# them — that is the only thing that distinguishes this one.
TXDOT = ("https://services5.arcgis.com/Rvw11bGpzJNE7apK/arcgis/rest/services/"
         "DriveTexas_API/FeatureServer/0/query")

# TomTom's iconCategory, collapsed to the shared vocabulary. Checked against a
# live Austin response: 6 jam, 8 road closed, 9 roadworks and 7 lane closed are
# what actually turn up; 1 accident appears in daylight.
ICON_CAT = {
    0: "unknown", 1: "crash", 2: "hazard", 3: "hazard", 4: "hazard",
    5: "hazard", 6: "jam", 7: "closure", 8: "closure", 9: "roadwork",
    10: "hazard", 11: "hazard", 14: "stall",
}

# HERE v7's own incident vocabulary, collapsed to the same shared one the
# other two feeds are read into. The enum is closed and documented, so this
# is a complete mapping rather than a keyword guess — anything HERE adds
# later falls through to "unknown" and shows up as such in the summary
# rather than being silently filed as something it is not.
HERE_TYPE = {
    "accident": "crash",
    "congestion": "jam",
    "construction": "roadwork",
    "disabledVehicle": "stall",
    "laneRestriction": "closure",
    "roadClosure": "closure",
    "roadHazard": "hazard",
    "weather": "hazard",
    "massTransit": "unknown",
    "plannedEvent": "unknown",
    "other": "unknown",
}


# Austin publishes 24 distinct issue_reported values; every one of them is
# covered below. Keyword rules rather than a fixed list, so a 25th does not
# silently become "unknown" if it says COLLISION in it.
def dispatch_cat(issue):
    s = (issue or "").upper()
    if any(k in s for k in ("COLLIS", "CRASH", "ACC/", "AUTO/ PED", "FATALITY", "FTSRA")):
        return "crash"
    if "STALL" in s:
        return "stall"
    if any(k in s for k in ("HAZD", "HAZARD", "DEBRIS", "LIVESTOCK", "ICY",
                            "HIGH WATER", "FIRE")):
        return "hazard"
    if any(k in s for k in ("BLOCKED", "OBSTRUCT", "IMPEDIMENT")):
        return "closure"
    return "unknown"


# Named so a dispatch address and a TomTom from/to can be compared on the one
# thing they express the same way. I-35 is the reason the matcher needs this
# at all: it has incidents essentially always, so proximity alone is not
# evidence there.
HIGHWAYS = [
    ("I-35", ("I-35", "IH 35", "IH-35", "INTERSTATE 35", "I35")),
    ("US-183", ("US-183", "US 183", "HIGHWAY 183", "HWY 183", "183 ")),
    ("MOPAC", ("MOPAC", "LOOP 1", "TX-1 LOOP")),
    ("US-290", ("US-290", "US 290", "HIGHWAY 290", "HWY 290", "290 ")),
    ("SH-71", ("SH-71", "TX-71", "HIGHWAY 71", "HWY 71", "STATE HIGHWAY 71", "71 ")),
    ("LOOP-360", ("LOOP 360", "CAPITAL OF TEXAS")),
    ("SH-45", ("SH-45", "TX-45", "HIGHWAY 45")),
    ("SH-130", ("SH-130", "TX-130", "HIGHWAY 130")),
    ("US-79", ("US-79", "US 79", "HIGHWAY 79")),
]


def roads_in(text):
    s = (text or "").upper()
    return {name for name, pats in HIGHWAYS if any(p in s for p in pats)}


def get(url, params, timeout=45):
    q = urllib.parse.urlencode(params)
    req = urllib.request.Request(url + "?" + q,
                                 headers={"User-Agent": "jessestrait.com/atx archiver"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def now():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0)


def iso(t):
    return t.isoformat().replace("+00:00", "Z")


def parse(ts):
    if not ts:
        return None
    s = str(ts).replace("Z", "+00:00")
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


# ── geometry ────────────────────────────────────────────────────────────
R_EARTH = 6371008.8


def to_xy(lat, lon, lat0):
    """Local flat projection. Over a 40 km city this is accurate to well
    under the 200 m buffer, and it makes point-to-segment ordinary algebra."""
    return (math.radians(lon) * R_EARTH * math.cos(math.radians(lat0)),
            math.radians(lat) * R_EARTH)


def point_to_line_m(lat, lon, coords):
    """Metres from a point to the nearest place on a linestring."""
    if not coords:
        return float("inf")
    lat0 = lat
    px, py = to_xy(lat, lon, lat0)
    best = float("inf")
    prev = to_xy(coords[0][1], coords[0][0], lat0)
    for c in coords[1:]:
        cur = to_xy(c[1], c[0], lat0)
        ax, ay = prev
        bx, by = cur
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        if seg == 0:
            d = math.hypot(px - ax, py - ay)
        else:
            t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg))
            d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
        best = min(best, d)
        prev = cur
    return best


def simplify(coords, keep=24):
    """Evenly decimate and round to 5 dp (about a metre). The geometry is
    stored to match against and to cluster on, not to draw, so a 295-point
    linestring is 290 points of storage nobody reads."""
    if not coords:
        return []
    if len(coords) > keep:
        step = (len(coords) - 1) / (keep - 1)
        coords = [coords[min(len(coords) - 1, round(i * step))] for i in range(keep)]
    return [[round(c[0], 5), round(c[1], 5)] for c in coords]


def line_cover(a, b, lim):
    """Fraction of a's vertices lying within lim metres of linestring b.

    Closest approach is the wrong measure for "did these two see the same
    stretch of road": two different halves of I-35 touch at the join and
    score zero metres apart. Coverage asks how much of one line the other
    actually accounts for, which is the question."""
    if not a or not b:
        return 0.0
    return sum(1 for c in a if point_to_line_m(c[1], c[0], b) <= lim) / len(a)


def seg_key(coords):
    """A stable-ish name for 'this bit of road', for counting recurrence.
    Midpoint rounded to ~300 m, which is coarse enough that the same jam on
    consecutive days lands in the same bucket."""
    if not coords:
        return "?"
    m = coords[len(coords) // 2]
    return "%.3f,%.3f" % (round(m[1], 3), round(m[0], 3))


# ── fetch ───────────────────────────────────────────────────────────────
def fetch_tomtom(key):
    d = get(TOMTOM, {"key": key, "bbox": BBOX, "fields": FIELDS, "language": "en-GB"})
    out = {}
    for f in d.get("incidents", []):
        p = f.get("properties") or {}
        i = p.get("id")
        if not i:
            continue
        g = (f.get("geometry") or {}).get("coordinates") or []
        if (f.get("geometry") or {}).get("type") != "LineString":
            continue
        roads = set(p.get("roadNumbers") or [])
        roads |= roads_in(p.get("from")) | roads_in(p.get("to"))
        out[i] = {
            "id": i,
            "cat": ICON_CAT.get(p.get("iconCategory"), "unknown"),
            "icon": p.get("iconCategory"),
            "magnitude": p.get("magnitudeOfDelay"),
            "delay_s": p.get("delay"),
            "length_m": round(p["length"], 1) if p.get("length") is not None else None,
            "roads": sorted(roads),
            "from": p.get("from"),
            "to": p.get("to"),
            "geom": simplify(g),
            "start_time": p.get("startTime"),
            "end_time": p.get("endTime"),
        }
    return out


def bbox_quads(bbox):
    """The four quadrants of a bbox string, west,south,east,north."""
    w, s, e, n = (float(x) for x in bbox.split(","))
    mw, mn = (w + e) / 2, (s + n) / 2
    return ["%.4f,%.4f,%.4f,%.4f" % q for q in
            ((w, s, mw, mn), (mw, s, e, mn), (w, mn, mw, n), (mw, mn, e, n))]


def fetch_here(key, bbox=BBOX, depth=0):
    """HERE Traffic v7 incidents over the same bbox TomTom gets.

    locationReferencing=shape is required and is what supplies the geometry;
    without it the rows come back as OpenLR or TMC references and there is
    nothing to match against.

    HERE documents that a bbox ceiling exists but does not say what it is, so
    rather than guess a number that would be wrong the first time they change
    it, a 400 splits the box into quadrants and retries. Austin needs one
    request if the ceiling is above ~1,750 km2 and four if it is not; either
    way the caller gets the same dict and never has to know."""
    try:
        d = get(HERE, {"apiKey": key, "in": "bbox:" + bbox,
                       "locationReferencing": "shape", "lang": "en-US"})
    except urllib.error.HTTPError as err:
        if err.code == 400 and depth < 2:
            out = {}
            for q in bbox_quads(bbox):
                out.update(fetch_here(key, q, depth + 1))
            return out
        raise
    out = {}
    for r in d.get("results", []):
        det = r.get("incidentDetails") or {}
        i = det.get("id")
        if not i:
            continue
        loc = r.get("location") or {}
        # shape.links is an ordered chain of road links; their points run
        # end to end, so concatenating them gives the affected stretch.
        # Consecutive links share their junction point, so a naive
        # concatenation repeats every join. Repeated points cost storage and
        # quietly double the weight of a junction in line_cover, which reads
        # coverage off the vertex list — the same defect check_geo.py
        # --squash exists to strip out of the prebuilt geometry.
        pts = []
        for link in (loc.get("shape") or {}).get("links") or []:
            for pt in link.get("points") or []:
                if pt.get("lat") is None or pt.get("lng") is None:
                    continue
                # lon,lat, to match TomTom's GeoJSON order — the matcher
                # reads both through the same geometry helpers.
                c = [pt["lng"], pt["lat"]]
                if not pts or pts[-1] != c:
                    pts.append(c)
        if not pts:
            continue
        desc = (det.get("description") or {}).get("value")
        brief = (det.get("summary") or {}).get("value")
        roads = roads_in(loc.get("description")) | roads_in(desc) | roads_in(brief)
        out[i] = {
            "id": i,
            "cat": HERE_TYPE.get(det.get("type"), "unknown"),
            "here_type": det.get("type"),
            "criticality": det.get("criticality"),
            "road_closed": bool(det.get("roadClosed")),
            "length_m": round(loc["length"], 1) if loc.get("length") is not None else None,
            "roads": sorted(roads),
            "from": loc.get("description"),
            "summary": brief,
            "geom": simplify(pts),
            "start_time": det.get("startTime"),
            "end_time": det.get("endTime"),
        }
    return out


def fetch_txdot(bbox=BBOX):
    """TxDOT's own account of what it has closed.

    A fourth feed, and a different kind of witness from the other three: the
    road authority reporting its own work, not a fleet measuring congestion
    and not a dispatcher logging a call. It earns its place because the state
    owns the roads that matter most here — I-35, Mopac, US-183 — and their
    closures appear in no city dataset.

    Its value to the archive is narrow and specific: a recurring jam on a
    stretch TxDOT has had coned off for two years is not an unexplained
    structural hotspot, and counting it as one was the largest false
    category in the summary. See summarise()."""
    w, s_, e, n = (float(x) for x in bbox.split(","))
    d = get(TXDOT, {
        "where": "1=1",
        "geometry": "%s,%s,%s,%s" % (w, s_, e, n),
        "geometryType": "esriGeometryEnvelope", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": ("condition,route_name,travel_direction,delay_flag,detour_flag,"
                      "roadway,from_limit,to_limit,start_time,end_time,description,"
                      "create_time,GLOBALID"),
        "outSR": "4326", "f": "geojson",
    })
    out = {}
    for f in d.get("features", []):
        p = f.get("properties") or {}
        i = p.get("GLOBALID")
        g = f.get("geometry") or {}
        if not i or not g:
            continue
        # The service returns LineString and occasionally MultiLineString;
        # flatten, because everything downstream reads one vertex list.
        if g.get("type") == "LineString":
            pts = g.get("coordinates") or []
        elif g.get("type") == "MultiLineString":
            pts = [c for part in (g.get("coordinates") or []) for c in part]
        else:
            continue
        if len(pts) < 2:
            continue
        roads = roads_in(p.get("route_name")) | roads_in(p.get("roadway")) \
            | roads_in(p.get("from_limit"))
        out[i] = {
            "id": i,
            # Its vocabulary is already close to the shared one.
            "cat": {"Closure": "closure", "Construction": "roadwork",
                    "Damage": "hazard"}.get(p.get("condition"), "unknown"),
            "condition": p.get("condition"),
            "route": p.get("route_name"),
            "roads": sorted(roads),
            "direction": p.get("travel_direction"),
            "delay": p.get("delay_flag") in (1, "1", "Y", True),
            "detour": p.get("detour_flag") in (1, "1", "Y", True),
            "from": p.get("from_limit"),
            "to": p.get("to_limit"),
            "geom": simplify(pts),
            "start_time": p.get("start_time"),
            "end_time": p.get("end_time"),
            "created": p.get("create_time"),
        }
    return out


# ── the corridor board ──────────────────────────────────────────────────
#
# Sampled here rather than in the page, and that is the whole design.
# The page is public: anything it fetches costs one request per visitor
# per refresh, so a board that polled nine corridors from the browser
# would scale with traffic and there is no ceiling on traffic. Sampled
# from the job it costs the same whether one person is looking or a
# thousand, and the page reads a file.
#
# Flow Segment Data allows 20,000 a month — eight times the Incident
# Details allowance, and until now entirely unused. The schedule below
# spends about 14,000 of it.

def flow_due(state_at, now_utc):
    """Twenty minutes through the day, an hour overnight.

    Corridor speed does not move much at 3am and moves fastest at the
    start of a rush hour, so the sampling is weighted to match: 06:00 to
    20:00 local gets a reading every 20 minutes, the rest of the night
    every hour. That is ~468 requests a day, about 14,200 a month against
    the 20,000 allowance, with headroom left deliberately."""
    if not state_at:
        return True
    last = parse(state_at)
    if not last:
        return True
    # Austin is UTC-5 in daylight time and UTC-6 otherwise; an hour either
    # way does not matter to a day/night split, so the offset is fixed
    # rather than pulling in a timezone database for one comparison.
    local_hour = (now_utc - dt.timedelta(hours=5)).hour
    gap = 20 if 6 <= local_hour < 20 else 60
    return (now_utc - last).total_seconds() >= gap * 60 - 30


def fetch_corridors(key):
    """Current speed against free-flow for each named corridor.

    One request per corridor; failures are per-corridor and a corridor
    that does not answer is simply absent rather than taking the sample
    down with it."""
    out = []
    for name, where, lat, lng in CORRIDORS:
        try:
            d = get(FLOW, {"key": key, "point": "%.5f,%.5f" % (lat, lng),
                           "unit": "mph", "openLr": "false"})
        except (urllib.error.URLError, ValueError) as err:
            print("corridor %s: %s" % (name, err), file=sys.stderr)
            continue
        f = d.get("flowSegmentData") or {}
        cur, free = f.get("currentSpeed"), f.get("freeFlowSpeed")
        if cur is None or not free:
            continue
        out.append({
            "name": name, "where": where, "lat": lat, "lng": lng,
            "mph": cur, "free_mph": free,
            "pct": round(100.0 * cur / free),
            "closed": bool(f.get("roadClosure")),
            "confidence": f.get("confidence"),
            "frc": f.get("frc"),
            # Seconds this segment is costing right now over its free-flow
            # time — the number that answers "is it worth avoiding".
            "lost_s": (round(f["currentTravelTime"] - f["freeFlowTravelTime"])
                       if f.get("currentTravelTime") is not None
                       and f.get("freeFlowTravelTime") is not None else None),
            # The shape of the segment the reading is about.
            #
            # This comes back in the same response at no extra cost, and
            # it is what lets the map draw these roads itself. TomTom's
            # own flow tiles thin out as you zoom out — by zoom 9 they
            # draw highways only, faintly — and nothing in the tile API
            # can be asked to do otherwise: thickness is rejected on this
            # style, and scaling a deeper tile down loses more than it
            # gains (measured). Drawing the corridors from their own
            # geometry sidesteps all of it, because then the width is
            # ours to choose.
            #
            # Note the length is itself informative: a segment runs until
            # conditions change, so a jammed stretch comes back short
            # (I-35 central, 0.8 km) and a clear one long (I-35 north,
            # 15.9 km).
            "geom": simplify([[c["longitude"], c["latitude"]]
                              for c in ((f.get("coordinates") or {}).get("coordinate") or [])
                              if c.get("latitude") is not None], keep=48),
        })
    return out


# ── storm cells ─────────────────────────────────────────────────────────
#
# A hitchhiker, and the comment is here so nobody wonders why weather is
# in the traffic collector. It is here for the cadence: NEXRAD rebuilds
# its storm attribute table on every volume scan, roughly every five
# minutes, and this is the only job in the repo that runs that often.
#
# It is sliced here rather than in the page because the national file is
# 540 KB and the endpoint ignores every filter parameter offered to it —
# nexrad=EWX returns all 1,393 cells, verified. A central-Texas slice is
# under 20 KB.
STORMS = "https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson"
# Wide enough to see weather coming, not so wide it becomes a map of
# Texas: roughly Llano to Bastrop, Waco to San Marcos, plus the approach.
STORM_BOX = (-99.5, 29.5, -96.5, 31.5)


def fetch_storms():
    """Radar-derived storm cells near Austin, with where each is going.

    DIRECTION. `drct` is the direction the cell is coming **from**, the
    meteorological wind convention — not the direction of travel. This
    was not guessed: two samples eleven minutes apart were matched on
    (radar, storm_id) and the actual displacement bearing compared
    against `drct` for the 148 cells that moved more than 1.5 km. The
    median error against `drct` was 157 degrees and against `drct + 180`
    it was 23. Drawing the arrow from `drct` would have pointed every
    storm in the state backwards.

    So `moving_to` is stored already corrected, and the raw value is kept
    beside it so the correction stays visible rather than becoming folk
    knowledge."""
    d = get(STORMS, {})
    w, s_, e, n = STORM_BOX
    out = []
    for f in d.get("features", []) or []:
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = (g.get("coordinates") or [None, None])[:2]
        if lon is None or not (w <= lon <= e and s_ <= lat <= n):
            continue
        p = f.get("properties") or {}
        kt = p.get("sknt")
        out.append({
            "id": "%s-%s" % (p.get("nexrad"), p.get("storm_id")),
            "radar": p.get("nexrad"), "cell": p.get("storm_id"),
            "lat": round(lat, 4), "lng": round(lon, 4),
            "dbz": p.get("max_dbz"),
            "top_kft": p.get("max_dbz_height"),
            "size_in": p.get("max_size"),
            "kt": kt,
            "from_deg": p.get("drct"),
            "moving_to": (p["drct"] + 180) % 360 if p.get("drct") is not None else None,
            # Probability of hail, and of *severe* hail. The second is the
            # one worth colouring for.
            "hail_pct": p.get("poh"), "severe_hail_pct": p.get("posh"),
            # Rotation, and a tornado vortex signature. Rare, and the whole
            # reason a layer like this earns its place on the page.
            "meso": None if p.get("meso") in (None, "NONE") else p.get("meso"),
            "tvs": None if p.get("tvs") in (None, "NONE") else p.get("tvs"),
        })
    out.sort(key=lambda x: -(x["dbz"] or 0))
    return out


def fetch_dispatch(hours=2):
    since = iso(now() - dt.timedelta(hours=hours))
    rows = get(SODA, {
        "$select": ("traffic_report_id,published_date,issue_reported,latitude,longitude,"
                    "address,traffic_report_status,traffic_report_status_date_time"),
        "$where": "published_date > '%s' AND latitude IS NOT NULL" % since,
        "$order": "published_date DESC", "$limit": 2000,
    })
    out = {}
    for r in rows:
        i = r.get("traffic_report_id")
        if not i:
            continue
        try:
            lat, lng = float(r["latitude"]), float(r["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        out[i] = {
            "id": i,
            "issue": r.get("issue_reported"),
            "cat": dispatch_cat(r.get("issue_reported")),
            "lat": round(lat, 5), "lng": round(lng, 5),
            "address": r.get("address"),
            "roads": sorted(roads_in(r.get("address"))),
            "status": r.get("traffic_report_status"),
            "published": r.get("published_date"),
            "status_time": r.get("traffic_report_status_date_time"),
        }
    return out


# ── staying inside the allowance ────────────────────────────────────────
#
# TomTom's free tiers are per product per month, and the two this job
# touches are wildly different sizes:
#
#     Traffic Incident Details    2,500 / month
#     Traffic Flow Segment Data  20,000 / month
#
# Incident Details is the tight one, and it is the one this job lives on.
# At a poll every five minutes around the clock it wants ~8,300 a month,
# three times the allowance, which is how the account came to be blocked.
#
# WHY NOT JUST POLL SLOWER. Because the measurement dies. Clearance
# resolution equals the poll interval, and the headline statistic — how
# long after a reported incident the congestion appears — has a median of
# +9.7 minutes. A 17-minute interval, which is what 2,500 a month buys
# evenly spread, cannot resolve a 9.7-minute offset at all. Spreading the
# budget evenly is the one option that spends it all and buys nothing.
#
# So the budget is spent where the pairs are. Weekday rush hours get the
# full five-minute cadence; everything else is sampled at thirty minutes,
# which is still enough to see an episode open and close. That lands at
# roughly 2,400 a month, inside the allowance, with the resolution
# concentrated on the hours that produce nearly all the matched pairs.
#
# The cost is a real sampling bias and it is recorded rather than hidden:
# every summary carries `sampling`, and the caveats say plainly that the
# onset figure is weighted toward rush hour.
RUSH_HOURS = {7, 8, 16, 17, 18}          # local, weekdays
RUSH_INTERVAL_MIN = 5
# 45, not 30. At 30 the simulated month spent exactly 2,500 — the hard
# ceiling was doing the work rather than backing it up, which would mean
# the archive going silent for the last days of every month. At 45 the
# schedule wants ~2,130, about 85% of the allowance, and the ceiling is
# what it should be: a backstop that never normally fires.
OFF_INTERVAL_MIN = 45
# A hard ceiling underneath the schedule, so a bug in the schedule cannot
# empty the allowance: the job counts what it spends and stops asking.
INCIDENT_BUDGET = 2500


def local_now(now_utc):
    """Austin local, near enough. A fixed -5 is wrong for half the year by
    one hour, which cannot move an hour-of-day bucket enough to matter and
    avoids a timezone dependency for one comparison."""
    return now_utc - dt.timedelta(hours=5)


def in_rush(now_utc):
    t = local_now(now_utc)
    return t.weekday() < 5 and t.hour in RUSH_HOURS


def month_key(now_utc):
    return now_utc.strftime("%Y-%m")


def budget_state(state, now_utc):
    """Requests spent this calendar month, reset when the month turns."""
    b = state.get("budget") or {}
    if b.get("month") != month_key(now_utc):
        b = {"month": month_key(now_utc), "incidents": 0, "flow": 0, "skipped": 0}
    return b


def incidents_due(state, now_utc):
    """Is this poll one we should spend an Incident Details request on?"""
    last = parse((state.get("budget") or {}).get("incidents_at"))
    want = RUSH_INTERVAL_MIN if in_rush(now_utc) else OFF_INTERVAL_MIN
    if last is None:
        return True, want
    gap = (now_utc - last).total_seconds() / 60
    # 30 seconds of slack, because the poll loop drifts by a second or two
    # each cycle and an exact comparison would skip every other sample.
    return gap >= want - 0.5, want


# ── upsert ──────────────────────────────────────────────────────────────
def upsert(open_now, seen, stamp):
    """Fold this poll into the running state. Returns the episodes that just
    closed — an id that was here last time and is not here now."""
    closed = []
    for i, row in seen.items():
        ep = open_now.get(i)
        if ep is None:
            row = dict(row)
            row["first_seen"] = stamp
            row["last_seen"] = stamp
            row["polls"] = 1
            open_now[i] = row
        else:
            ep.update({k: v for k, v in row.items() if k not in ("first_seen", "polls")})
            ep["last_seen"] = stamp
            ep["polls"] = ep.get("polls", 1) + 1
    for i in list(open_now):
        if i in seen:
            continue
        ep = open_now.pop(i)
        ep["ended"] = True
        # The clearance we can actually claim is "the last poll it appeared
        # in", not the moment it cleared. Resolution is the poll interval and
        # the summary says so.
        ep["ended_at"] = ep.get("last_seen")
        first, last = parse(ep.get("first_seen")), parse(ep.get("last_seen"))
        ep["observed_min"] = round((last - first).total_seconds() / 60, 1) if first and last else None
        closed.append(ep)
    return closed


# ── matcher ─────────────────────────────────────────────────────────────
def overlap_min(a0, a1, b0, b1):
    """Minutes the two active intervals share. Negative is the gap between
    them, which the tolerance is allowed to forgive."""
    if not (a0 and b0):
        return None
    a1 = a1 or a0
    b1 = b1 or b0
    lo, hi = max(a0, b0), min(a1, b1)
    return (hi - lo).total_seconds() / 60


def match(tt_eps, dp_eps, buffer_m, hw_buffer_m, tol_min, onset_window_min,
          probe_key="tomtom_id"):
    """Point-to-line, not point-to-point: the probe feeds give a linestring
    and dispatch gives a geocoded point, usually snapped to a block or an
    intersection. Every candidate pair is scored and the best per dispatch
    record is kept; both source rows survive untouched either way.

    probe_key names the id column so the same code runs against HERE. The
    default is the one the archive already has on disk, so days recorded
    before HERE existed keep reading exactly as they were written."""
    out = []
    for d in dp_eps:
        dpub = parse(d.get("published")) or parse(d.get("first_seen"))
        dend = parse(d.get("ended_at")) or parse(d.get("last_seen"))
        best = None
        for t in tt_eps:
            geom = t.get("geom") or []
            if not geom:
                continue
            highway = bool(t.get("roads")) or bool(d.get("roads"))
            lim = hw_buffer_m if highway else buffer_m
            dist = point_to_line_m(d["lat"], d["lng"], geom)
            if dist > lim:
                continue
            tstart = parse(t.get("start_time")) or parse(t.get("first_seen"))
            tend = parse(t.get("ended_at")) or parse(t.get("last_seen"))
            ov = overlap_min(dpub, dend, tstart, tend)
            if ov is None or ov < -tol_min:
                continue
            # Interval overlap alone is nowhere near enough, and assuming it
            # was produced a headline number that was simply false.
            #
            # Most TomTom rows here are closures, roadworks and all-afternoon
            # corridor jams. A jam that began at 11:37 overlaps every dispatch
            # record for the rest of the day, so a hazard reported at 18:51
            # matched it at one metre and scored well. Four such pairs gave a
            # median onset offset of minus 336 minutes — read naively, "probe
            # data sees jams five and a half hours before APD". It does not.
            # They were never the same event.
            #
            # So the starts have to be close, not merely the intervals. The
            # window stays symmetric and wide because a genuine negative is
            # the finding the archive exists to measure; it only has to
            # exclude the absurd ones.
            onset = None
            if parse(t.get("start_time")) and dpub:
                onset = (parse(t.get("start_time")) - dpub).total_seconds() / 60
                if abs(onset) > onset_window_min:
                    continue
            # Unknown matches anything; otherwise the two vocabularies have to
            # agree, except that a jam is a consequence rather than a cause and
            # is allowed to sit under any of them.
            tc, dc = t.get("cat"), d.get("cat")
            type_agree = (tc == dc) or "unknown" in (tc, dc) or tc == "jam"
            if not type_agree and tc != "jam":
                continue
            # On a highway, proximity is not evidence: I-35 has something on it
            # essentially always. Make the road name carry the claim.
            road_agree = None
            if t.get("roads") and d.get("roads"):
                road_agree = bool(set(t["roads"]) & set(d["roads"]))
                if not road_agree:
                    continue
            elif highway and t.get("roads") and not d.get("roads"):
                # TomTom says highway, dispatch address does not name one.
                # Allowed, but it cannot score as well as an agreement.
                road_agree = False
            score = (1.0 - dist / lim) * 0.5 \
                + (0.3 if type_agree and tc == dc else 0.1) \
                + (0.2 if road_agree else 0.0)
            cand = {
                probe_key: t["id"], "dispatch_id": d["id"],
                "distance_m": round(dist, 1),
                "overlap_min": round(ov, 1),
                "type_agree": bool(type_agree and tc == dc),
                "road_agree": road_agree,
                "highway": highway,
                "score": round(score, 3),
                "onset_offset_min": round(onset, 1) if onset is not None else None,
            }
            if best is None or cand["score"] > best["score"]:
                best = cand
        if best:
            out.append(best)
    return out


def merge_matches(prior, found, keys=("tomtom_id", "dispatch_id")):
    """Accumulate the day's matches instead of replacing them.

    This line used to read `day_doc["matches"] = matches`, beside two lines
    that correctly extend. Each poll only matches across what is open right
    now plus the few episodes that just closed, so assigning meant the file
    ended the day holding the last poll's handful and nothing else. Re-running
    the matcher over a whole archived day finds 101 pairs where the file
    recorded 1, and persistence — how long a jam outlives the wreck — had
    zero samples across four days because the pairs it needed were thrown
    away minutes after being found.

    Keyed on the pair, best score kept, so a match that improves as more of
    the episode is observed replaces the earlier weaker read of it.
    """
    out = {}
    for m in (prior or []) + (found or []):
        k = tuple(m.get(x) for x in keys)
        if any(x is None for x in k):
            continue
        cur = out.get(k)
        if cur is None or (m.get("score") or 0) > (cur.get("score") or 0):
            out[k] = m
    return [out[k] for k in sorted(out, key=lambda k: tuple(reversed(k)))]


def probe_agreement(tt_eps, hr_eps, buffer_m, hw_buffer_m, tol_min):
    """Where the two probe networks saw the same stretch of road.

    This is the pairing the third witness was actually wanted for. Both
    feeds answer the same question from different fleets, so a road one of
    them reports and the other does not is either a real difference in
    coverage or a difference in what each vendor calls an incident — and
    neither is visible from one feed alone.

    Line to line rather than point to line, so the test is coverage: how
    much of one linestring the other accounts for. A pair that overlaps in
    time and shares most of its length is the same jam seen twice."""
    out = []
    for t in tt_eps:
        tg = t.get("geom") or []
        if not tg:
            continue
        tstart = parse(t.get("start_time")) or parse(t.get("first_seen"))
        tend = parse(t.get("ended_at")) or parse(t.get("last_seen"))
        best = None
        for h in hr_eps:
            hg = h.get("geom") or []
            if not hg:
                continue
            highway = bool(t.get("roads")) or bool(h.get("roads"))
            lim = hw_buffer_m if highway else buffer_m
            # Whichever direction covers better: a short HERE row sitting
            # inside a long TomTom corridor is still the same jam.
            cover = max(line_cover(tg, hg, lim), line_cover(hg, tg, lim))
            if cover < 0.5:
                continue
            hstart = parse(h.get("start_time")) or parse(h.get("first_seen"))
            hend = parse(h.get("ended_at")) or parse(h.get("last_seen"))
            ov = overlap_min(tstart, tend, hstart, hend)
            if ov is None or ov < -tol_min:
                continue
            # Same rule as the dispatch matcher: on a highway, being near it
            # is not evidence, so the names have to agree when both have one.
            if t.get("roads") and h.get("roads") and not (set(t["roads"]) & set(h["roads"])):
                continue
            onset = None
            if parse(t.get("start_time")) and parse(h.get("start_time")):
                onset = (parse(t["start_time"]) - parse(h["start_time"])).total_seconds() / 60
            cand = {
                "tomtom_id": t["id"], "here_id": h["id"],
                "cover": round(cover, 2),
                "overlap_min": round(ov, 1),
                "type_agree": t.get("cat") == h.get("cat"),
                "tomtom_cat": t.get("cat"), "here_cat": h.get("cat"),
                "highway": highway,
                # Positive means TomTom saw it later than HERE did.
                "onset_offset_min": round(onset, 1) if onset is not None else None,
                "score": round(cover, 3),
            }
            if best is None or cand["score"] > best["score"]:
                best = cand
        if best:
            out.append(best)
    return out


# ── the numbers ─────────────────────────────────────────────────────────
def dist_stats(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return {"n": 0}
    vals.sort()
    q = statistics.quantiles(vals, n=4) if len(vals) >= 4 else [vals[0], statistics.median(vals), vals[-1]]
    return {"n": len(vals), "median": round(statistics.median(vals), 1),
            "q1": round(q[0], 1), "q3": round(q[2], 1),
            "min": round(vals[0], 1), "max": round(vals[-1], 1)}


def summarise(day, tt_closed, dp_closed, matches, tt_open, dp_open, interval_min,
              matcher_params, hr_closed=(), hr_open=(), hr_matches=(),
              agreements=(), tx=(), sampling=None):
    tt_all = tt_closed + tt_open
    dp_all = dp_closed + dp_open
    hr_all = list(hr_closed) + list(hr_open)
    hr_matches = list(hr_matches)
    agreements = list(agreements)
    m_tt = {m["tomtom_id"] for m in matches}
    m_dp = {m["dispatch_id"] for m in matches}
    m_hr = {m["here_id"] for m in hr_matches}
    hr_dp = {m["dispatch_id"] for m in hr_matches}
    tx = list(tx)

    def on_roadworks(geom, roads):
        """Does a TxDOT closure cover this stretch? Same coverage test the
        probe feeds use against each other."""
        if not geom:
            return False
        for w in tx:
            wg = w.get("geom") or []
            if not wg:
                continue
            lim = 130.0 if (roads or w.get("roads")) else 200.0
            if roads and w.get("roads") and not (set(roads) & set(w["roads"])):
                continue
            if max(line_cover(geom, wg, lim), line_cover(wg, geom, lim)) >= 0.5:
                return True
        return False

    def rate(items, matched_ids, hw):
        sel = [x for x in items if bool(x.get("roads")) == hw]
        if not sel:
            return {"n": 0}
        hit = sum(1 for x in sel if x["id"] in matched_ids)
        return {"n": len(sel), "matched": hit, "pct": round(100 * hit / len(sel), 1)}

    # Congestion nobody reported. The ones that recur at the same place and
    # the same hour of the week are a fact about the road, not an event.
    #
    # TxDOT is what stops this being wrong. A jam that recurs every weekday
    # at 7am on a stretch the state has had coned off since 2024 is not an
    # unexplained property of the road — it is roadworks, and calling it a
    # structural hotspot was the largest false category in this list. Marked
    # rather than dropped: the recurrence is still real, it just has a cause
    # on file, and dropping it would hide the I-35 rebuild entirely.
    hot = {}
    explained = 0
    for t in tt_all:
        if t["id"] in m_tt or t.get("cat") not in ("jam", "closure"):
            continue
        st = parse(t.get("start_time")) or parse(t.get("first_seen"))
        if not st:
            continue
        works = on_roadworks(t.get("geom"), t.get("roads"))
        if works:
            explained += 1
        k = "%s|%d" % (seg_key(t.get("geom")), st.weekday() * 24 + st.hour)
        h = hot.setdefault(k, {"seg": seg_key(t.get("geom")),
                               "hour_of_week": st.weekday() * 24 + st.hour,
                               "n": 0, "from": t.get("from"), "roadworks": False})
        h["n"] += 1
        h["roadworks"] = h["roadworks"] or works

    # How long APD's own records stay open, which turns out to decide what
    # this archive can and cannot measure.
    #
    # Across 290 episodes the p95 is 119.5 minutes, the p50 is 115, and the
    # two commonest five-minute bins are 115 and 120. Nothing survives much
    # past two hours. That is a retention rule, not a distribution of
    # clearance times — a fender bender and a rollover cannot both take 115
    # minutes. So a dispatch record's end is when the feed dropped it, not
    # when the road reopened, and any statistic subtracting it is measuring
    # APD's housekeeping.
    #
    # Detected rather than hard-coded, so if the feed's behaviour changes the
    # summary stops carrying the warning by itself.
    life = dist_stats([
        (parse(d.get("ended_at")) - (parse(d.get("published")) or parse(d.get("first_seen"))))
        .total_seconds() / 60
        for d in dp_closed
        if parse(d.get("ended_at")) and (parse(d.get("published")) or parse(d.get("first_seen")))
    ])
    capped = bool(life.get("n", 0) >= 20 and life.get("q3") is not None
                  and 100 <= life["q3"] <= 130 and (life["q3"] - life["q1"]) < 30)

    return {
        "date": day,
        "poll_interval_min": interval_min,
        # Not a constant any more, and the statistics below depend on it,
        # so it travels with them. See RUSH_HOURS.
        "sampling": sampling or {},
        "dispatch_record_life_min": life,
        "dispatch_life_capped": capped,
        "matcher": matcher_params,
        "counts": {
            "tomtom": len(tt_all), "dispatch": len(dp_all), "matched": len(matches),
            "here": len(hr_all), "here_matched": len(hr_matches),
            "dispatch_only": len([d for d in dp_all if d["id"] not in m_dp]),
            "tomtom_only": len([t for t in tt_all if t["id"] not in m_tt]),
        },
        # What the third witness is for. A reported incident that both probe
        # networks saw is corroborated twice over; one that neither saw is
        # either small, brief, or on a road where both fleets are thin. With
        # one probe feed those two cases are indistinguishable.
        #
        # Absent a HERE key this is all zeros against n dispatch episodes,
        # which is the honest reading of "two witnesses" rather than a gap.
        "witnesses": {
            "n": len(dp_all),
            "both": len([d for d in dp_all if d["id"] in m_dp and d["id"] in hr_dp]),
            "tomtom_only": len([d for d in dp_all
                                if d["id"] in m_dp and d["id"] not in hr_dp]),
            "here_only": len([d for d in dp_all
                              if d["id"] in hr_dp and d["id"] not in m_dp]),
            "neither": len([d for d in dp_all
                            if d["id"] not in m_dp and d["id"] not in hr_dp]),
        },
        # And the other half: the two probe feeds against each other, with
        # no reported incident involved at all.
        "probe_agreement": {
            "n": len(agreements),
            "pct_of_tomtom": round(100 * len(agreements) / max(1, len(tt_all)), 1),
            "pct_of_here": round(100 * len(agreements) / max(1, len(hr_all)), 1),
            "type_agree": len([a for a in agreements if a.get("type_agree")]),
            "cover": dist_stats([a.get("cover") for a in agreements]),
            # Positive means TomTom's clock started after HERE's on the same
            # jam — which fleet noticed first, measured rather than assumed.
            "onset_offset_min": dist_stats([a.get("onset_offset_min") for a in agreements]),
        },
        "here_onset_offset_min": dist_stats([m.get("onset_offset_min") for m in hr_matches]),
        # The fourth feed, and the one number it is here to change.
        "roadworks": {
            "txdot_rows": len(tx),
            "unreported_congestion": len([t for t in tt_all if t["id"] not in m_tt
                                          and t.get("cat") in ("jam", "closure")]),
            "explained_by_roadworks": explained,
            # Across every recurrence bucket, not just the fifteen listed
            # below — the list is a sample and this is the population.
            "hotspot_buckets": len(hot),
            "hotspot_buckets_on_roadworks": len([h for h in hot.values() if h["roadworks"]]),
        },
        # Signed on purpose, and the sign turned out to be the finding — just
        # not the one this comment used to assert. It said probe data often
        # sees the jam before APD publishes. Over the first 70 matched pairs
        # the median is +9.7 minutes and the jam appears after the dispatch
        # 66% of the time, so on this evidence it usually does not.
        "onset_offset_min": dist_stats([m.get("onset_offset_min") for m in matches]),
        # Kept, but flagged: while dispatch records are capped this is the
        # difference between a jam's real end and an administrative one, and
        # it is not the "how long does the jam outlive the wreck" number the
        # archive was built to produce. Reported so the flag travels with it.
        "persistence_min": dict(dist_stats([
            (parse(t.get("ended_at")) - parse(d.get("ended_at"))).total_seconds() / 60
            for m in matches
            for t in [next((x for x in tt_closed if x["id"] == m["tomtom_id"]), None)]
            for d in [next((x for x in dp_closed if x["id"] == m["dispatch_id"]), None)]
            if t and d and parse(t.get("ended_at")) and parse(d.get("ended_at"))
        ]), **({"unreliable": "dispatch records are capped, so their end is "
                              "administrative rather than a clearance"} if capped else {})),
        "match_rate": {
            "dispatch_highway": rate(dp_all, m_dp, True),
            "dispatch_surface": rate(dp_all, m_dp, False),
            "tomtom_highway": rate(tt_all, m_tt, True),
            "tomtom_surface": rate(tt_all, m_tt, False),
        },
        "unmatched_pct": {
            "dispatch": round(100 * len([d for d in dp_all if d["id"] not in m_dp])
                              / max(1, len(dp_all)), 1),
            "tomtom": round(100 * len([t for t in tt_all if t["id"] not in m_tt])
                            / max(1, len(tt_all)), 1),
        },
        # Roadworks-explained ones sort last: they are still recurrences, but
        # the interesting end of this list is the congestion nothing explains.
        "structural_hotspots": sorted(hot.values(),
                                      key=lambda x: (x["roadworks"], -x["n"]))[:15],
        "caveats": [
            "Dispatch published_date is when APD published, not when it happened.",
            ("Dispatch records appear to be dropped on a fixed life of about two "
             "hours (q1 %.0f, q3 %.0f min over %d episodes), so their end time is "
             "the feed's retention rather than a clearance. persistence_min is "
             "not a measure of how long the jam outlived the wreck."
             % (life.get("q1", 0), life.get("q3", 0), life.get("n", 0)))
            if capped else
            "Dispatch record lifetimes look like real clearances this day, not a cap.",
            "Clearance resolution equals the poll interval; shorter incidents are invisible.",
            ("Incident Details is sampled every %d minutes during weekday rush hours and "
             "every %d minutes otherwise, to stay inside TomTom's 2,500/month allowance. "
             "The onset figure is therefore weighted toward rush hour: it is closer to "
             "'how long a rush-hour incident takes to become a jam' than to a figure for "
             "all hours equally. Off-peak episodes shorter than %d minutes can be missed "
             "entirely."
             % (RUSH_INTERVAL_MIN, OFF_INTERVAL_MIN, OFF_INTERVAL_MIN)),
            "Statistics from matched pairs are subject to the matcher's own tolerances; "
            "the unmatched rate is reported beside them for that reason.",
            "A pair is only believed to be one event if the two start times fall within "
            "onset_window_min. Without that, all-day corridor jams swallow every nearby "
            "dispatch record and the onset offset becomes meaningless.",
            ("HERE was not polled this day, so witnesses.here_only and .both are "
             "zero by absence rather than by measurement."
             if not hr_all else
             "TomTom and HERE are both probe-derived and are not independent of the "
             "road: they can agree because the jam was real or because both fleets "
             "are dense there. Agreement raises confidence in the event, not in the "
             "coverage."),
        ],
    }


def rematch(out, args):
    """Rebuild one day's matches from the episodes already archived for it.

    Only works while the day's detail is still on disk — retention is two
    days, so anything older keeps the understated numbers it was written
    with, and the summary says which pass produced it."""
    day = args.rematch
    day_path = out / (day + ".json")
    if not day_path.exists():
        sys.exit("no archive for %s (retention is %d days)" % (day, args.retain_days))
    doc = json.loads(day_path.read_text())
    tt, dp = doc.get("tomtom_closed", []), doc.get("dispatch_closed", [])
    hr = doc.get("here_closed", [])
    before = len(doc.get("matches", []))
    doc["matches"] = match(tt, dp, args.buffer, args.highway_buffer,
                           args.tolerance, args.onset_window)
    # Days recorded before HERE existed have no here_closed and get an empty
    # list back, which is what they should have.
    doc["here_matches"] = match(hr, dp, args.buffer, args.highway_buffer,
                                args.tolerance, args.onset_window,
                                probe_key="here_id")
    doc["agreements"] = probe_agreement(tt, hr, args.buffer, args.highway_buffer,
                                        args.tolerance)
    doc["rematched_at"] = iso(now())
    day_path.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True))
    summ = summarise(day, tt, dp, doc["matches"], [], [], args.interval,
                     {"buffer_m": args.buffer, "highway_buffer_m": args.highway_buffer,
                      "tolerance_min": args.tolerance,
                      "onset_window_min": args.onset_window},
                     hr_closed=hr, hr_matches=doc["here_matches"],
                     agreements=doc["agreements"], tx=doc.get("txdot", []))
    summ["rematched"] = True
    (out / "summary" / (day + ".json")).write_text(
        json.dumps(summ, separators=(",", ":"), sort_keys=True))
    print("%s: %d matches -> %d  (%d tomtom, %d here, %d dispatch episodes on "
          "file; %d here matches, %d probe agreements)"
          % (day, before, len(doc["matches"]), len(tt), len(hr), len(dp),
             len(doc["here_matches"]), len(doc["agreements"])))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="traffic")
    ap.add_argument("--buffer", type=float, default=200.0,
                    help="metres, surface streets")
    ap.add_argument("--highway-buffer", type=float, default=130.0,
                    help="metres, tighter because highways always have something on them")
    ap.add_argument("--tolerance", type=float, default=20.0, help="minutes either end")
    ap.add_argument("--onset-window", type=float, default=90.0,
                    help="minutes; how far apart the two start times may be and "
                         "still be believed to describe one event")
    ap.add_argument("--interval", type=float, default=5.0,
                    help="poll cadence, recorded so clearance resolution is known")
    ap.add_argument("--retain-days", type=int, default=2,
                    help="days of vendor-bearing daily files to keep, 30 at the "
                         "very most; aggregates are forever")
    ap.add_argument("--no-here", action="store_true",
                    help="skip HERE even if a key is set, for a two-witness run")
    ap.add_argument("--rematch", metavar="YYYY-MM-DD", default=None,
                    help="recompute matches and the summary for a day already on "
                         "disk, from its own archived episodes. Needs no key and "
                         "fetches nothing — it is how the days recorded under the "
                         "overwriting bug get their real numbers back.")
    args = ap.parse_args()

    # Structural, not a habit. HERE caps caching of their data at thirty
    # days; a flag that could quietly be raised past it is not a retention
    # policy, it is a default. Aggregates are unaffected — they are derived
    # statistics rather than stored location data, and they are the product.
    if args.retain_days > 30:
        sys.exit("--retain-days is capped at 30: vendor traffic rows may not be "
                 "kept longer than that. Aggregates already survive forever.")

    if args.rematch:
        return rematch(pathlib.Path(args.out), args)

    key = os.environ.get("TOMTOM_ARCHIVE_KEY", "").strip()
    if not key:
        sys.exit("TOMTOM_ARCHIVE_KEY is not set. This must be a separate, "
                 "non-domain-restricted key: a key locked to jessestrait.com "
                 "cannot work from Actions, which sends no referrer.")

    # Optional on purpose: the chain that runs this is live, and a missing
    # third witness must degrade to the two-witness archive rather than take
    # the whole job down with it.
    here_key = "" if args.no_here else os.environ.get("HERE_ARCHIVE_KEY", "").strip()
    if not here_key and not args.no_here:
        print("HERE_ARCHIVE_KEY is not set — running on two witnesses.",
              file=sys.stderr)

    out = pathlib.Path(args.out)
    (out / "summary").mkdir(parents=True, exist_ok=True)

    now_utc = now()
    stamp = iso(now_utc)
    state_path = out / "open.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    tt_open = state.get("tomtom", {})
    dp_open = state.get("dispatch", {})
    hr_open = state.get("here", {})
    budget = budget_state(state, now_utc)

    # Two gates on the expensive feed: the schedule, and a hard ceiling
    # under it. The ceiling exists because a schedule is a belief about
    # how often something runs and the counter is a fact about how often
    # it did.
    due, want_gap = incidents_due(state, now_utc)
    room = budget["incidents"] < INCIDENT_BUDGET
    poll_tt = due and room
    if due and not room:
        print("Incident Details budget for %s is spent (%d/%d) — holding off."
              % (budget["month"], budget["incidents"], INCIDENT_BUDGET),
              file=sys.stderr)

    # Dispatch is Austin open data and free, so it is polled every time
    # regardless; only the metered feed is rationed.
    tt_seen = fetch_tomtom(key) if poll_tt else None
    if poll_tt:
        budget["incidents"] += 1
        budget["incidents_at"] = stamp
    else:
        budget["skipped"] = budget.get("skipped", 0) + 1
    dp_seen = fetch_dispatch()
    # No key, so it never blocks the run; a failure is one feed's worth of
    # loss, same rule as HERE.
    try:
        tx_seen = fetch_txdot()
    except (urllib.error.URLError, ValueError) as err:
        print("TxDOT fetch failed (%s) — carrying on without it." % err, file=sys.stderr)
        tx_seen = {}

    hr_seen = {}
    if here_key:
        try:
            hr_seen = fetch_here(here_key)
        except (urllib.error.URLError, ValueError) as err:
            # One feed failing is not a reason to lose the poll for the other
            # two. The episodes already open stay open and pick up again next
            # time; a run that dropped them would invent a clearance.
            print("HERE fetch failed (%s) — keeping the open episodes as they "
                  "are and carrying on." % err, file=sys.stderr)
            hr_seen = None

    # A skipped poll must not look like "every incident cleared at once".
    # upsert closes anything absent from `seen`, so passing None means
    # leave the open episodes exactly as they are.
    tt_closed = upsert(tt_open, tt_seen, stamp) if tt_seen is not None else []
    dp_closed = upsert(dp_open, dp_seen, stamp)
    hr_closed = upsert(hr_open, hr_seen, stamp) if hr_seen is not None else []

    # Matched across everything currently known, so a dispatch record can
    # still find its jam a poll or two later.
    matches = match(list(tt_open.values()) + tt_closed,
                    list(dp_open.values()) + dp_closed,
                    args.buffer, args.highway_buffer, args.tolerance,
                    args.onset_window)
    hr_matches = match(list(hr_open.values()) + hr_closed,
                       list(dp_open.values()) + dp_closed,
                       args.buffer, args.highway_buffer, args.tolerance,
                       args.onset_window, probe_key="here_id")
    agreements = probe_agreement(list(tt_open.values()) + tt_closed,
                                 list(hr_open.values()) + hr_closed,
                                 args.buffer, args.highway_buffer, args.tolerance)
    tx_rows = sorted(tx_seen.values(), key=lambda x: x["id"])

    # Storm cells. Free, keyless, and refreshed on the radar's own clock,
    # so it runs every poll rather than on a budget.
    try:
        storms = fetch_storms()
        wx = out.parent / "weather"
        wx.mkdir(parents=True, exist_ok=True)
        (wx / "storms.json").write_text(json.dumps({
            "fetched_at": stamp,
            "source": "NWS NEXRAD storm attributes, via Iowa State Mesonet",
            "note": "moving_to is drct+180: the feed gives the direction a cell "
                    "comes FROM, verified against observed displacement.",
            "cells": storms,
        }, separators=(",", ":"), sort_keys=True))
    except (urllib.error.URLError, ValueError) as err:
        print("storm cells failed (%s) — carrying on." % err, file=sys.stderr)
        storms = None

    # Corridor speeds, on their own much larger allowance and their own
    # much slower clock.
    corridors = None
    if flow_due((state.get("budget") or {}).get("flow_at"), now_utc):
        corridors = fetch_corridors(key)
        if corridors:
            budget["flow"] = budget.get("flow", 0) + len(corridors)
            budget["flow_at"] = stamp
            (out / "corridors.json").write_text(json.dumps({
                "fetched_at": stamp,
                "source": "TomTom Traffic Flow Segment Data",
                "note": "Sampled by a scheduled job, not by your browser, so a "
                        "thousand readers cost one reading.",
                "corridors": corridors,
            }, separators=(",", ":"), sort_keys=True))

    day = stamp[:10]
    day_path = out / (day + ".json")
    day_doc = json.loads(day_path.read_text()) if day_path.exists() else {
        "date": day, "tomtom_closed": [], "dispatch_closed": [], "matches": []}
    day_doc.setdefault("here_closed", [])
    day_doc["tomtom_closed"].extend(tt_closed)
    day_doc["dispatch_closed"].extend(dp_closed)
    day_doc["here_closed"].extend(hr_closed)
    day_doc["matches"] = merge_matches(day_doc.get("matches"), matches)
    day_doc["here_matches"] = merge_matches(day_doc.get("here_matches"), hr_matches,
                                            keys=("here_id", "dispatch_id"))
    day_doc["agreements"] = merge_matches(day_doc.get("agreements"), agreements,
                                          keys=("tomtom_id", "here_id"))
    day_doc["fetched_at"] = stamp
    day_doc["txdot"] = tx_rows
    day_path.write_text(json.dumps(day_doc, separators=(",", ":"), sort_keys=True))

    # TxDOT rows are not episodes and are deliberately not upserted: these
    # are multi-year projects, so "it disappeared from the feed" is a change
    # to a work order rather than a road reopening at that minute. Current
    # state only, replaced each poll.
    state_path.write_text(json.dumps(
        {"fetched_at": stamp, "tomtom": tt_open, "dispatch": dp_open,
         "here": hr_open, "txdot": tx_rows, "budget": budget},
        separators=(",", ":"), sort_keys=True))

    # What HERE currently sees, for the map to draw. Live state only: this
    # file is rewritten every poll and never accumulated, so it is a cache of
    # the current picture rather than a repository of anything.
    if here_key:
        (out / "here-now.json").write_text(json.dumps({
            "fetched_at": stamp,
            "source": "HERE Traffic API v7 incidents",
            "attribution": "\u00a9 HERE",
            "note": "Current state, rewritten every poll and never accumulated.",
            "incidents": [{
                "id": e["id"], "cat": e.get("cat"), "type": e.get("here_type"),
                "criticality": e.get("criticality"),
                "closed": e.get("road_closed"),
                "where": e.get("from"), "what": e.get("summary"),
                "roads": e.get("roads") or [],
                "length_m": e.get("length_m"),
                "start_time": e.get("start_time"),
                "first_seen": e.get("first_seen"),
                # Coarser than the archive's copy: this one is drawn at city
                # zoom, not matched against.
                "geom": simplify(e.get("geom") or [], keep=12),
            } for e in sorted(hr_open.values(), key=lambda x: x["id"])],
        }, separators=(",", ":"), sort_keys=True))

    # day_doc["matches"], not `matches`. `matches` is only what this poll
    # found across what is open right now plus the few episodes that just
    # closed — a handful. The day's real total is the accumulated set.
    #
    # This is the same bug as the one merge_matches was written to fix,
    # surviving one line further down: that fix made the *day file*
    # accumulate correctly while the *summary* went on reporting the last
    # poll. And the summary is the half that is kept forever — day files
    # are pruned after two days, summaries never are. So the permanent
    # record of the archive's headline number was a sample of the last
    # five minutes. Measured on 2026-09-21: the day file held 29 matches
    # and the summary said 3.
    #
    # hr_matches and agreements below already passed the accumulated set;
    # only the primary one was wrong, which is why it went unnoticed.
    summ = summarise(day, day_doc["tomtom_closed"], day_doc["dispatch_closed"],
                     day_doc["matches"], list(tt_open.values()), list(dp_open.values()),
                     args.interval,
                     {"buffer_m": args.buffer, "highway_buffer_m": args.highway_buffer,
                      "tolerance_min": args.tolerance,
                      "onset_window_min": args.onset_window},
                     hr_closed=day_doc["here_closed"], hr_open=list(hr_open.values()),
                     hr_matches=day_doc["here_matches"],
                     agreements=day_doc["agreements"], tx=tx_rows,
                     sampling={"rush_min": RUSH_INTERVAL_MIN,
                               "off_peak_min": OFF_INTERVAL_MIN,
                               "rush_hours_local": sorted(RUSH_HOURS),
                               "this_poll": "rush" if in_rush(now_utc) else "off-peak",
                               "incident_budget": INCIDENT_BUDGET,
                               "incidents_spent_this_month": budget["incidents"],
                               "flow_spent_this_month": budget.get("flow", 0)})
    (out / "summary" / (day + ".json")).write_text(
        json.dumps(summ, indent=1, sort_keys=True))

    # Prune vendor-bearing daily files. The summaries beside them are
    # aggregates and stay.
    cutoff = (now() - dt.timedelta(days=args.retain_days)).date().isoformat()
    pruned = 0
    for f in out.glob("20??-??-??.json"):
        if f.stem < cutoff:
            f.unlink()
            pruned += 1

    c = summ["counts"]
    w = summ["witnesses"]
    rw = summ["roadworks"]
    if storms is not None:
        sev = [c for c in storms if c.get("tvs") or c.get("meso")]
        print("storm cells near Austin: %d%s"
              % (len(storms), "  (%d with rotation)" % len(sev) if sev else ""))
    print("budget %s: incidents %d/%d spent, %d polls skipped, flow %d/20000%s"
          % (budget["month"], budget["incidents"], INCIDENT_BUDGET,
             budget.get("skipped", 0), budget.get("flow", 0),
             "  (corridors sampled this poll)" if corridors else ""))
    print("%s  tomtom %d (+%d closed)  here %d (+%d closed)  dispatch %d (+%d "
          "closed)  txdot %d  matched %d/%d  agreed %d  both-saw %d  neither %d  "
          "unreported %d (%d roadworks)  pruned %d"
          % (stamp, len(tt_open), len(tt_closed), len(hr_open), len(hr_closed),
             len(dp_open), len(dp_closed), rw["txdot_rows"], c["matched"],
             c["here_matched"], summ["probe_agreement"]["n"], w["both"],
             w["neither"], rw["unreported_congestion"],
             rw["explained_by_roadworks"], pruned))


if __name__ == "__main__":
    main()
