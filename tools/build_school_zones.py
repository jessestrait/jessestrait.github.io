#!/usr/bin/env python3
"""Bake Austin's school zones with the hours their beacons actually flash.

Three sources, joined here so the page does not have to:

  a7ua-4hkr  (Socrata)  the zone register — name, school, district, and
                        whether the zone is Active, Inactive or Removed.
                        Carries no geometry at all.
  mzsm-hucz  (Socrata)  the individual beacons, which is where the schedules
                        live: am_plan, pm_plan and pm_2_plan as real clock
                        windows like "06:55 - 08:00". pm_2_plan is the
                        early-release window.
  School_Zones (GeoHub) 361 polylines, the streets a zone covers. A school
                        zone is a stretch of road, so a line is the right
                        shape for it.

The join is numeric and exact: a beacon id reads "7322-529-", and that 7322
is the zone id, which is also GeoHub's ZONE field. Verified at 780/780 for
beacon to zone register.

What this deliberately does NOT do is decide whether school is in session.
Nothing published says which days a given district is teaching, and the five
districts here — AISD, PISD, RRISD, LISD and a set of private schools — do
not share a calendar. A layer that claims a zone is live on a teacher work
day is worse than no layer, so the page says "scheduled now, if school is in
session" and leaves the last step to the reader, who knows whether it is
spring break.

    python3 tools/build_school_zones.py

Writes atx/data/schoolzones.json.
"""

import collections
import json
import math
import pathlib
import re
import sys
import urllib.parse
import urllib.request

SODA = "https://data.austintexas.gov/resource/"
ARC = ("https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/"
       "School_Zones/FeatureServer/0/query")
OUT = pathlib.Path(__file__).resolve().parent.parent / "atx" / "data" / "schoolzones.json"

_LAT0 = 30.27
_M_LAT = 111320.0
_M_LON = 111320.0 * math.cos(math.radians(_LAT0))
SIMPLIFY_M = 6.0

WINDOW = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$")

# The register spells the same district several ways — "AISD" and
# "AISD (Austin)", "PRIVATE" and "Private", "AISD / PRIVATE" and
# "AISD /PRIVATE" — which would show up as different districts in a popup.
# Eight real ones, and Del Valle and Manor are among them.
DISTRICTS = {
    "AISD": "Austin ISD", "PISD": "Pflugerville ISD", "RRISD": "Round Rock ISD",
    "LISD": "Leander ISD", "EISD": "Eanes ISD", "DVISD": "Del Valle ISD",
    "MISD": "Manor ISD", "PRIVATE": "Private",
}


def district(raw):
    """'AISD (Austin)' -> ('Austin ISD', False); 'AISD / YEAR ROUND' carries a
    calendar note worth keeping, since year-round schools are exactly the ones
    a reader's instinct about the school year would get wrong."""
    t = (raw or "").upper()
    year_round = "YEAR ROUND" in t
    t = re.sub(r"\([^)]*\)", " ", t)
    parts = [x.strip() for x in re.split(r"[/,]", t) if x.strip() and "YEAR ROUND" not in x]
    names = []
    for x in parts:
        n = DISTRICTS.get(x)
        if n and n not in names:
            names.append(n)
    return (" / ".join(names) if names else "", year_round)


# str.title() writes "E 2Nd St" and "Fm 1826". Street names want the ordinal
# suffix left alone and a few abbreviations left in capitals.
_KEEP_UPPER = {"FM", "RM", "US", "IH", "SH", "CR", "NE", "NW", "SE", "SW", "MLK"}


def street_case(name):
    out = []
    for w in (name or "").split():
        u = w.upper()
        if u in _KEEP_UPPER:
            out.append(u)
        elif re.match(r"^\d+(ST|ND|RD|TH)$", u):
            out.append(u.lower() if False else re.sub(r"(\d+)(ST|ND|RD|TH)$",
                       lambda m: m.group(1) + m.group(2).lower(), u))
        else:
            out.append(w.capitalize())
    return " ".join(out)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "jessestrait.com/atx"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def soda(dataset, **params):
    params.setdefault("$limit", 5000)
    return get(SODA + dataset + ".json?" + urllib.parse.urlencode(params))


def minutes(text):
    """'06:55 - 08:00' -> (415, 480). Anything else -> None, including the
    '-' the feed uses for a window that does not exist."""
    m = WINDOW.match(text or "")
    if not m:
        return None
    a = int(m.group(1)) * 60 + int(m.group(2))
    b = int(m.group(3)) * 60 + int(m.group(4))
    return (a, b) if 0 <= a < b <= 24 * 60 else None


def simplify(pts, tol=SIMPLIFY_M):
    """Douglas-Peucker measured to the segment, same as the transit build."""
    if len(pts) < 3:
        return pts[:]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][0] * _M_LON, pts[i][1] * _M_LAT
        bx, by = pts[j][0] * _M_LON, pts[j][1] * _M_LAT
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        worst, wi = 0.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] * _M_LON, pts[k][1] * _M_LAT
            if L == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > worst:
                worst, wi = d, k
        if wi >= 0 and worst > tol:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [p for p, k in zip(pts, keep) if k]


def main():
    zones = soda("a7ua-4hkr", **{"$select":
        "school_beacon_zone_id,zone_name,school_name,isd_name,zone_status,zone_note"})
    beacons = soda("mzsm-hucz", **{"$select":
        "school_zone_beacon_id,zone_name,school_name,school_zone_status,"
        "am_plan,pm_plan,pm_2_plan,location"})
    print("zone register: %d rows, beacons: %d" % (len(zones), len(beacons)))

    active = {}
    for z in zones:
        if (z.get("zone_status") or "").strip() != "Active":
            continue
        zid = str(z.get("school_beacon_zone_id") or "").strip()
        if zid:
            active[zid] = z
    print("active zones: %d" % len(active))

    # ── beacons: windows and a fallback position, keyed by the id prefix ──
    wins = collections.defaultdict(set)
    pts = collections.defaultdict(list)
    for b in beacons:
        if (b.get("school_zone_status") or "").strip() != "Active":
            continue
        zid = str(b.get("school_zone_beacon_id") or "").split("-")[0].strip()
        if zid not in active:
            continue
        for key in ("am_plan", "pm_plan", "pm_2_plan"):
            w = minutes(b.get(key))
            if w:
                wins[zid].add(w)
        loc = b.get("location") or {}
        c = loc.get("coordinates")
        if c and len(c) == 2:
            pts[zid].append((round(float(c[0]), 5), round(float(c[1]), 5)))

    # ── geometry ──
    arc = get(ARC + "?" + urllib.parse.urlencode({
        "where": "1=1", "outFields": "ZONE,STREET_NAME", "outSR": "4326",
        "f": "geojson", "geometryPrecision": "5", "resultRecordCount": 2000,
        "maxAllowableOffset": "0.00002",
    }))
    lines = collections.defaultdict(list)
    streets = collections.defaultdict(set)
    for f in arc.get("features", []):
        g = f.get("geometry") or {}
        zid = str((f.get("properties") or {}).get("ZONE") or "").strip()
        if not zid or zid not in active:
            continue
        st = ((f.get("properties") or {}).get("STREET_NAME") or "").strip()
        if st:
            streets[zid].add(street_case(st))
        parts = g.get("coordinates") or []
        if g.get("type") == "LineString":
            parts = [parts]
        for part in parts:
            pl = [(p[0], p[1]) for p in part if len(p) >= 2]
            if len(pl) >= 2:
                lines[zid].append([[round(x, 5), round(y, 5)] for x, y in simplify(pl)])
    print("zones with geometry: %d" % len(lines))

    feats = []
    no_window = fell_back = dropped = 0
    for zid, z in sorted(active.items()):
        w = sorted(wins.get(zid, ()))
        if not w:
            no_window += 1
            continue                       # nothing to say about when it flashes
        isd, year_round = district(z.get("isd_name"))
        props = {
            "id": zid,
            "zone": street_case(z.get("zone_name") or ""),
            "school": (z.get("school_name") or "").strip(),
            "isd": isd,
            "win": [[a, b] for a, b in w],
            "streets": sorted(streets.get(zid, ()))[:6],
        }
        if year_round:
            props["yearRound"] = True
        if lines.get(zid):
            geom = {"type": "MultiLineString", "coordinates": lines[zid]}
        elif pts.get(zid):
            # No published centreline. The beacons themselves are the honest
            # fallback: fewer of them than the street they sit on, but a real
            # position rather than a dropped zone.
            fell_back += 1
            uniq = sorted(set(pts[zid]))
            geom = ({"type": "Point", "coordinates": list(uniq[0])} if len(uniq) == 1
                    else {"type": "MultiPoint", "coordinates": [list(p) for p in uniq]})
            props["beaconsOnly"] = True
        else:
            dropped += 1
            continue
        feats.append({"type": "Feature", "geometry": geom, "properties": props})

    if not feats:
        sys.exit("no zone came out with both a window and a position")

    doc = {
        "type": "FeatureCollection",
        "meta": {
            "source": "City of Austin school zone register, beacons, and GeoHub centrelines",
            "built": __import__("time").strftime("%Y-%m-%d"),
            "activeZones": len(active),
        },
        "features": feats,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")))
    drawn_line = sum(1 for f in feats if f["geometry"]["type"] == "MultiLineString")
    print()
    print("%s  %d zones (%d as streets, %d as beacon points), %.1f KB"
          % (OUT.name, len(feats), drawn_line, len(feats) - drawn_line,
             OUT.stat().st_size / 1024))
    print("  %d active zones fell back to beacon points, no published centreline" % fell_back)
    print("  dropped: %d publish no window, %d have no position at all" % (no_window, dropped))


if __name__ == "__main__":
    main()
