#!/usr/bin/env python3
"""Check the prebuilt geometry in atx/data/ for the ways it can be wrong.

Written after route 392 shipped drawn flying 1.7 km across Walnut Creek,
which nothing caught until it turned up in a screenshot. The point is to
make that class of fault findable without a screenshot.

    python3 tools/check_geo.py            # structure only, no network
    python3 tools/check_geo.py --source   # also ask ArcGIS what it has

What it can tell you, and what it cannot:

  structure     NaN, nulls, coordinates outside the Austin metro, rings that
                do not close or are too short to be rings. These are always
                faults.
  repeats       a point identical to the one before it. Draws nothing, costs
                bytes. Waste rather than wrongness, so it is reported and not
                failed on.
  steps         the distance between consecutive points. On RAW feed geometry
                a huge step means a hole — that is what was wrong with the bus
                routes. On SIMPLIFIED geometry it means nothing at all: any
                honest simplifier collapses a straight three kilometres of
                road to its two ends. Everything here is simplified, so this
                prints for eyeballing and never fails the run.
  counts        shipped features against the source's own count, which is the
                check for a query that quietly truncated at a page boundary.
                Needs --source.

What it deliberately does not do is compare shipped geometry against a
fresh full-precision fetch and call the difference an error. That was tried.
Matching a simplified feature back to its source by centroid and extent is
unreliable where features are small and parallel — it reported trails as 52 m
out when a single feature fetched by id was 1.9 m out against a 2.2 m budget.
The simplification bound belongs to whoever performs the simplification:
build_capmetro.py proves its own, and ArcGIS honours maxAllowableOffset.
"""

import argparse
import glob
import json
import math
import os
import sys
import urllib.parse
import urllib.request

# Generous box round the metro: anything outside is a broken coordinate, not
# a distant suburb.
BOX = (-98.6, 29.6, -97.0, 30.9)
_LAT0 = 30.27
_M_LAT = 111320.0
_M_LON = 111320.0 * math.cos(math.radians(_LAT0))

ARC = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services"

# name -> (service, layer, where). Only layers taken straight from a
# FeatureServer; the ones filtered on the way out record why.
SOURCES = {
    "blockgroups": ("tree_equity_score_austin", 0, "1=1", None),
    "parks": ("BOUNDARIES_city_of_austin_parks", 0, "1=1", None),
    "trails": ("pard_trails_nrpa", 0, "1=1", None),
    "streets": ("TRANSPORTATION_pw_street_condition_scores", 0, "GRADE <> ' '", None),
    "floodplain": ("INLANDWATERS_austin_full_develop_floodplain", 0,
                   "FLOOD_ZONE LIKE '%100-Year%'", "slivers under ~130m dropped"),
    "zips": ("Austin_Travis_County_ZIP_Codes", 6, "1=1",
             "filtered to Austin Energy's ZIPs"),
}


def metres(a, b):
    return math.hypot((a[0] - b[0]) * _M_LON, (a[1] - b[1]) * _M_LAT)


def rings(geom):
    """Every coordinate list in a geometry, whatever its type."""
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return [[c]]
    if t in ("LineString", "MultiPoint"):
        return [c]
    if t in ("MultiLineString", "Polygon"):
        return c
    if t == "MultiPolygon":
        return [r for poly in c for r in poly]
    return []


def source_count(service, layer, where):
    p = {"where": where, "returnCountOnly": "true", "f": "json"}
    url = "%s/%s/FeatureServer/%d/query?%s" % (ARC, service, layer, urllib.parse.urlencode(p))
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r).get("count")


def check(path, with_source):
    name = os.path.basename(path)
    stem = name.rsplit(".", 1)[0]
    try:
        doc = json.load(open(path))
    except Exception as e:
        return ["%s: unreadable (%s)" % (name, e)], []
    feats = doc.get("features")
    if not isinstance(feats, list):
        return [], ["%-16s not a FeatureCollection, skipped" % name]

    faults, notes = [], []
    pts = repeats = oob = bad = short = unclosed = 0
    steps = []
    for f in feats:
        g = f.get("geometry")
        if not g:
            continue
        poly = g.get("type") in ("Polygon", "MultiPolygon")
        for r in rings(g):
            if not r:
                continue
            pts += len(r)
            if poly:
                if len(r) < 4:
                    short += 1
                elif r[0] != r[-1]:
                    unclosed += 1
            for i, p in enumerate(r):
                if (not isinstance(p, list) or len(p) < 2
                        or not all(isinstance(v, (int, float)) and v == v for v in p[:2])):
                    bad += 1
                    continue
                if not (BOX[0] <= p[0] <= BOX[2] and BOX[1] <= p[1] <= BOX[3]):
                    oob += 1
                if i:
                    q = r[i - 1]
                    if isinstance(q, list) and len(q) >= 2:
                        if p == q:
                            repeats += 1
                        steps.append(metres(q, p))

    steps.sort()
    def pct(x):
        return steps[min(len(steps) - 1, int(x * (len(steps) - 1)))] if steps else 0.0

    print("%-16s %6d features %8d points   step p50 %5.0fm p99 %6.0fm max %7.0fm"
          % (name, len(feats), pts, pct(.5), pct(.99), pct(1.0)))

    for label, n in (("bad coordinates", bad), ("outside the metro", oob),
                     ("rings too short", short), ("unclosed rings", unclosed)):
        if n:
            faults.append("%s: %d %s" % (name, n, label))
    if repeats:
        notes.append("%-16s %d repeated points (%.0f%% of the file, drawing nothing)"
                     % (name, repeats, 100.0 * repeats / max(pts, 1)))

    if with_source and stem in SOURCES:
        svc, layer, where, filtered = SOURCES[stem]
        try:
            n = source_count(svc, layer, where)
        except Exception as e:
            notes.append("%-16s could not reach the source (%s)" % (name, e))
            return faults, notes
        if filtered:
            notes.append("%-16s %d of %d at source, %s" % (name, len(feats), n, filtered))
        elif len(feats) != n:
            faults.append("%s: %d shipped but %d at source — a query truncated"
                          % (name, len(feats), n))
        else:
            notes.append("%-16s %d of %d, complete" % (name, len(feats), n))
    return faults, notes


def ring_area_m2(ring):
    """Shoelace area in square metres, on the local flat projection."""
    if len(ring) < 4:
        return 0.0
    s = 0.0
    for i in range(1, len(ring)):
        x1, y1 = ring[i - 1][0] * _M_LON, ring[i - 1][1] * _M_LAT
        x2, y2 = ring[i][0] * _M_LON, ring[i][1] * _M_LAT
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def squash(path):
    """Remove what cannot draw, in place: points identical to the one before
    them, rings with no area, and features left holding nothing.

    The rings matter more than the points. Simplifying a long thin sliver can
    collapse it to a single repeated coordinate while its bounding box stays
    wide enough to pass a size filter measured on the box — which is how the
    floodplain came to ship 223 rings of zero area and 51 features with
    nothing in them at all. They draw nothing and count as something, which is
    the worst combination: invisible on the map, present in every total."""
    doc = json.load(open(path))
    feats = doc.get("features")
    if not isinstance(feats, list):
        return 0, 0, 0

    def clean(r, closed):
        out = [r[0]]
        for p in r[1:]:
            if p != out[-1]:
                out.append(p)
        if closed and len(out) >= 3 and out[0] != out[-1]:
            out.append(out[0])
        return out if (len(out) >= (4 if closed else 2)) else r

    def walk(c, depth, closed):
        if depth == 0:
            return clean(c, closed)
        return [walk(x, depth - 1, closed) for x in c]

    before = after = 0
    dropped_rings = 0
    keep_feats = []
    for f in feats:
        g = f.get("geometry")
        if not g:
            keep_feats.append(f)
            continue
        t = g.get("type")
        depth = {"LineString": 0, "MultiLineString": 1, "Polygon": 1,
                 "MultiPolygon": 2}.get(t)
        if depth is None:
            keep_feats.append(f)
            continue
        closed = t in ("Polygon", "MultiPolygon")
        before += sum(len(r) for r in rings(g))
        g["coordinates"] = walk(g["coordinates"], depth, closed)

        if closed:
            parts = g["coordinates"] if t == "MultiPolygon" else [g["coordinates"]]
            kept_parts = []
            for poly in parts:
                if not poly:
                    continue
                # Order matters: ring zero is the outside and the rest are
                # holes in it. Filtering them all together would promote a
                # surviving hole to be the outline when the outline is the
                # ring that collapsed, which quietly ADDS area — caught by
                # checking that total drawn area came out unchanged.
                if ring_area_m2(poly[0]) <= 0.0:
                    dropped_rings += len(poly)
                    continue
                holes = [r for r in poly[1:] if ring_area_m2(r) > 0.0]
                dropped_rings += len(poly) - 1 - len(holes)
                kept_parts.append([poly[0]] + holes)
            if not kept_parts:
                after += 0
                continue                       # nothing left to draw: drop it
            g["coordinates"] = kept_parts if t == "MultiPolygon" else kept_parts[0]

        after += sum(len(r) for r in rings(g))
        keep_feats.append(f)

    dropped_feats = len(feats) - len(keep_feats)
    if after < before or dropped_feats:
        doc["features"] = keep_feats
        json.dump(doc, open(path, "w"), separators=(",", ":"))
    return before - after, dropped_rings, dropped_feats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", action="store_true",
                    help="also ask each FeatureServer for its own count")
    ap.add_argument("--squash", action="store_true",
                    help="rewrite files with repeated points removed")
    ap.add_argument("--dir", default=os.path.join(os.path.dirname(__file__), "..", "atx", "data"))
    args = ap.parse_args()

    paths = sorted(glob.glob(os.path.join(args.dir, "*.json"))
                   + glob.glob(os.path.join(args.dir, "*.geojson")))
    if args.squash:
        for p in paths:
            pts_gone, rings_gone, feats_gone = squash(p)
            if pts_gone or rings_gone or feats_gone:
                print("cleaned %-16s %d points, %d empty rings, %d empty features removed"
                      % (os.path.basename(p), pts_gone, rings_gone, feats_gone))
        print()
    faults, notes = [], []
    for p in paths:
        f, n = check(p, args.source)
        faults += f
        notes += n

    if notes:
        print()
        for n in notes:
            print("  " + n)
    print()
    if faults:
        for f in faults:
            print("FAULT  " + f)
        sys.exit("%d fault(s)" % len(faults))
    print("no faults in %d files" % len(paths))


if __name__ == "__main__":
    main()
