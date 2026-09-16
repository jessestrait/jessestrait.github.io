#!/usr/bin/env python3
"""Turn CapMetro's static GTFS into two lean files the map can actually load.

The published feed is 33 MB zipped and 168 MB open, most of it in two files
the browser has no use for: shapes.txt is 121 MB and stop_times.txt is 44 MB.
Neither is ever shipped. They are streamed here, once, to answer two
questions — what does each route look like on the ground, and which routes
serve each stop — and then thrown away.

    python3 tools/build_capmetro.py                 # downloads the feed
    python3 tools/build_capmetro.py --zip local.zip

Writes:
    atx/data/routes.geojson   one feature per route, MultiLineString, one
                              line per direction, with colour and names
    atx/data/stops.geojson    one point per stop, carrying the routes that
                              serve it

Live arrivals and vehicle positions are a different problem and come through
the relay; nothing schedule-shaped is shipped here.
"""

import argparse
import collections
import math
import csv
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

# The Texas open-data portal's copy, which is the one CapMetro points at.
GTFS_URL = "https://data.texas.gov/download/r4v4-vz24/application%2Fzip"

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "atx" / "data"

# How far the drawn line may stray from the real one, in metres. Douglas-
# Peucker guarantees this bound, which is the point of using it: the previous
# version kept every k-th point, which guarantees nothing about shape and on a
# long route was chording 1.4 km across open ground. At 8 m the whole system
# simplifies to about 10,000 points, a quarter of what index-dropping kept, and
# 8 m is under a lane width at any zoom this map offers.
SIMPLIFY_TOLERANCE_M = 8.0

# A step between consecutive shape points longer than this is not a road, it is
# a hole in the feed. Chosen from the data rather than by feel: across all 7,323
# candidate shapes the 90th percentile step is 445 m, the genuinely broken
# shapes jump to 1,552 m and beyond, and the longest legitimate run — route 550
# down the tollway — is 900 m. 1,200 m sits in the empty band between the two.
MAX_STEP_M = 1200.0

# Austin is far enough from the equator that a degree of longitude is well
# short of a degree of latitude; both distance and perpendicular-offset maths
# below work in a local flat projection using these.
_LAT0 = 30.27
_M_PER_DEG_LAT = 111320.0
_M_PER_DEG_LON = 111320.0 * math.cos(math.radians(_LAT0))


def rows(zf, name):
    """Stream one member as dicts without unpacking it to disk. utf-8-sig
    because trips.txt ships with a BOM, which would otherwise make the first
    column 'route_id' unreachable by name."""
    with zf.open(name) as fh:
        for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")):
            yield r


def _metres(a, b):
    """Plane distance in metres. Austin spans a few tenths of a degree, so a
    local flat projection is accurate to well under a metre here and costs a
    fraction of what haversine does across 83,000 points."""
    return math.hypot((a[0] - b[0]) * _M_PER_DEG_LON, (a[1] - b[1]) * _M_PER_DEG_LAT)


def longest_step(pts):
    """The largest jump between consecutive points, in metres. On raw feed
    geometry this is the tell for a shape with a hole in it."""
    return max((_metres(pts[i - 1], pts[i]) for i in range(1, len(pts))), default=0.0)


def simplify(pts, tol=SIMPLIFY_TOLERANCE_M):
    """Douglas-Peucker: drop every point that is within `tol` metres of the
    line its neighbours already describe. Iterative rather than recursive,
    because a 1,400-point shape would otherwise risk the stack.

    Measured against the segment, not the infinite line through its ends.
    Textbook Douglas-Peucker uses the infinite line, and on a route that
    doubles back that is unsound: the points of an out-and-back spur sit
    close to the line while being nowhere near the segment, so the whole
    spur gets pruned. Route 550 turns around at Lakeline and lost 63 m of
    itself that way, against a promised 8 — caught by the check below,
    which measures the distance that actually matters."""
    if len(pts) < 3:
        return pts[:]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][0] * _M_PER_DEG_LON, pts[i][1] * _M_PER_DEG_LAT
        bx, by = pts[j][0] * _M_PER_DEG_LON, pts[j][1] * _M_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        worst, wi = 0.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] * _M_PER_DEG_LON, pts[k][1] * _M_PER_DEG_LAT
            if L == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / L
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d > worst:
                worst, wi = d, k
        if wi >= 0 and worst > tol:
            keep[wi] = True
            stack.append((i, wi))
            stack.append((wi, j))
    return [p for p, k in zip(pts, keep) if k]


def split_on_holes(pts, limit=MAX_STEP_M):
    """Cut the line wherever the feed skips further than a road plausibly
    could, and return the pieces. Drawing straight through such a gap invents
    geometry: route 392 appeared to fly 1.7 km across Walnut Creek because one
    shape is missing its middle. A break says the same thing honestly."""
    out, run = [], [pts[0]] if pts else []
    for i in range(1, len(pts)):
        if _metres(pts[i - 1], pts[i]) > limit:
            if len(run) >= 2:
                out.append(run)
            run = [pts[i]]
        else:
            run.append(pts[i])
    if len(run) >= 2:
        out.append(run)
    return out


def max_deviation(original, simplified):
    """How far the drawn line strays from the shape it came from, in metres.
    Douglas-Peucker promises this stays under the tolerance; this is the
    build checking that promise rather than taking it on faith, because the
    thing being simplified is the only record of where the bus goes."""
    if len(simplified) < 2:
        return 0.0
    segs = [(simplified[i - 1], simplified[i]) for i in range(1, len(simplified))]
    worst = 0.0
    for p in original:
        px, py = p[0] * _M_PER_DEG_LON, p[1] * _M_PER_DEG_LAT
        best = float("inf")
        for a, b in segs:
            ax, ay = a[0] * _M_PER_DEG_LON, a[1] * _M_PER_DEG_LAT
            bx, by = b[0] * _M_PER_DEG_LON, b[1] * _M_PER_DEG_LAT
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            if L == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
                d = math.hypot(px - (ax + t * dx), py - (ay + t * dy))
            if d < best:
                best = d
            if best <= 1.0:
                break
        if best > worst:
            worst = best
    return worst


def as_coords(pts):
    return [[round(x, 5), round(y, 5)] for x, y in pts]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="use a local feed instead of downloading")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()
    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    if args.zip:
        blob = pathlib.Path(args.zip).read_bytes()
    else:
        req = urllib.request.Request(
            GTFS_URL, headers={"User-Agent": "jessestrait.com/atx gtfs build"})
        with urllib.request.urlopen(req, timeout=300) as r:
            blob = r.read()
    print("feed: %.1f MB zipped" % (len(blob) / 1e6))

    zf = zipfile.ZipFile(io.BytesIO(blob))

    version = ""
    try:
        fi = next(rows(zf, "feed_info.txt"))
        version = "%s (%s–%s)" % (fi.get("feed_version", ""),
                                       fi.get("feed_start_date", ""),
                                       fi.get("feed_end_date", ""))
    except (KeyError, StopIteration):
        pass

    # ── routes ──────────────────────────────────────────────────────────
    routes = {}
    for r in rows(zf, "routes.txt"):
        routes[r["route_id"]] = {
            "short": (r.get("route_short_name") or "").strip(),
            "long": (r.get("route_long_name") or "").strip(),
            "type": int(r.get("route_type") or 3),
            # CapMetro gives colours without the hash, and leaves some blank.
            "color": "#" + (r.get("route_color") or "").strip().lstrip("#")
                     if (r.get("route_color") or "").strip() else None,
        }
    print("routes: %d" % len(routes))

    # ── trips: which shape represents a route, and which route a trip is ──
    trip_route = {}
    shape_votes = collections.Counter()
    for t in rows(zf, "trips.txt"):
        rid, sid = t.get("route_id"), t.get("shape_id")
        trip_route[t["trip_id"]] = rid
        if rid and sid:
            # Most-used shape per direction: a route has dozens of shape
            # variants for detours, short-turns and yard pull-ins, and the
            # one that runs most often is the one people mean by "the 20".
            shape_votes[(rid, t.get("direction_id", "0"), sid)] += 1
    print("trips: %d" % len(trip_route))

    # ── how sound is each candidate shape? ───────────────────────────────
    # Most-used is the right default, but it is not the only thing that
    # matters: CapMetro publishes shape variants in pairs, and sometimes the
    # more-used one of a pair is missing its middle. Route 392 shipped with a
    # 1.7 km straight line across Walnut Creek for exactly that reason. So
    # measure every candidate first. Only the largest step is kept per shape —
    # one float each, rather than the 121 MB of geometry they describe.
    gap = {}
    prev = {}
    for s in rows(zf, "shapes.txt"):
        sid = s.get("shape_id")
        try:
            pt = (float(s["shape_pt_lon"]), float(s["shape_pt_lat"]))
        except (KeyError, TypeError, ValueError):
            continue
        # shapes.txt is published in sequence order; verified on this feed.
        if sid in prev:
            d = _metres(prev[sid], pt)
            if d > gap.get(sid, 0.0):
                gap[sid] = d
        prev[sid] = pt
    del prev
    broken = sum(1 for v in gap.values() if v > MAX_STEP_M)
    print("shape quality: %d of %d candidates have a step over %dm"
          % (broken, len(gap), MAX_STEP_M))

    by_dir = collections.defaultdict(list)
    for (rid, direction, sid), n in shape_votes.items():
        by_dir[(rid, direction)].append((n, sid))

    best, swapped, unfixable = {}, [], []
    for k, lst in by_dir.items():
        lst.sort(key=lambda t: (-t[0], t[1]))
        top_n, top_sid = lst[0]
        if gap.get(top_sid, 0.0) <= MAX_STEP_M:
            best[k] = (top_sid, top_n)
            continue
        # Prefer a sound variant, but not at the cost of representativeness —
        # a shape half the route runs is worth more than a tidy detour two
        # trips a week use. In this feed every swap below keeps every trip,
        # because the pairs are tied and the tie used to be broken by luck.
        clean = [(n, sid) for n, sid in lst
                 if gap.get(sid, 0.0) <= MAX_STEP_M and n * 2 >= top_n]
        if clean:
            n, sid = clean[0]
            best[k] = (sid, n)
            swapped.append((k[0], k[1], top_sid, gap[top_sid], sid, gap.get(sid, 0.0), n, top_n))
        else:
            # Nothing sound to fall back on. Keep the most-used one; the hole
            # is drawn as a break rather than a straight line further down.
            best[k] = (top_sid, top_n)
            unfixable.append((k[0], k[1], top_sid, gap[top_sid]))

    for rid, d, bad, badgap, good, goodgap, n, top_n in sorted(swapped, key=lambda r: -r[3]):
        print("  route %-5s dir %s: shape %s had a %.0fm hole -> %s (%.0fm), %d of %d trips"
              % (routes.get(rid, {}).get("short") or rid, d, bad, badgap, good, goodgap, n, top_n))
    for rid, d, sid, g in sorted(unfixable, key=lambda r: -r[3]):
        print("  route %-5s dir %s: every variant is broken (%s, %.0fm) - drawing it as a break"
              % (routes.get(rid, {}).get("short") or rid, d, sid, g))

    wanted = {sid for sid, _ in best.values()}
    print("shapes kept: %d of %d seen" % (
        len(wanted), len({s for _, _, s in shape_votes})))

    # ── stop_times: the only thing wanted from 44 MB is stop -> routes ────
    stop_routes = collections.defaultdict(set)
    n_st = 0
    for st in rows(zf, "stop_times.txt"):
        n_st += 1
        rid = trip_route.get(st.get("trip_id"))
        if rid:
            stop_routes[st["stop_id"]].add(rid)
    print("stop_times streamed: %s rows (not shipped)" % f"{n_st:,}")

    # ── shapes: likewise, 121 MB in and only the chosen ones out ─────────
    pts = collections.defaultdict(list)
    n_sh = 0
    for s in rows(zf, "shapes.txt"):
        n_sh += 1
        sid = s.get("shape_id")
        if sid in wanted:
            try:
                pts[sid].append((float(s["shape_pt_lon"]), float(s["shape_pt_lat"]),
                                 int(s["shape_pt_sequence"])))
            except (KeyError, TypeError, ValueError):
                pass
    print("shapes streamed: %s rows (not shipped)" % f"{n_sh:,}")
    for sid in pts:
        pts[sid].sort(key=lambda p: p[2])

    # ── routes.geojson ──────────────────────────────────────────────────
    by_route = collections.defaultdict(list)
    n_breaks = 0
    worst_dev = (0.0, "-")
    for (rid, direction), (sid, _) in best.items():
        line = [(x, y) for x, y, _ in pts.get(sid, [])]
        if len(line) < 2:
            continue
        # Split before simplifying, so a hole in the feed can never be smoothed
        # into a confident straight line, and so the tolerance is measured
        # against real geometry on either side of it.
        pieces = split_on_holes(line)
        n_breaks += len(pieces) - 1
        for piece in pieces:
            # The invariant split_on_holes exists to establish, checked on the
            # geometry where it means something. Deliberately not checked after
            # simplifying: Douglas-Peucker collapses a genuinely straight three
            # kilometres of road to its two ends, and that long step is the
            # right answer. Distance from the real shape is what bounds quality
            # once simplified, and that is measured below.
            step = longest_step(piece)
            if step > MAX_STEP_M:
                sys.exit("split_on_holes left a %.0fm step in route %s"
                         % (step, routes.get(rid, {}).get("short") or rid))
            thin = simplify(piece)
            dev = max_deviation(piece, thin)
            if dev > worst_dev[0]:
                worst_dev = (dev, routes.get(rid, {}).get("short") or rid)
            by_route[rid].append(as_coords(thin))
    if n_breaks:
        print("drawn with %d break(s) where the feed skips" % n_breaks)
    print("worst deviation from the published shape: %.1f m (route %s), tolerance %.0f m"
          % (worst_dev[0], worst_dev[1], SIMPLIFY_TOLERANCE_M))
    if worst_dev[0] > SIMPLIFY_TOLERANCE_M + 1.0:
        sys.exit("a drawn line strays further from its shape than the tolerance allows")


    rfeat = []
    for rid, lines in by_route.items():
        m = routes.get(rid, {})
        rfeat.append({
            "type": "Feature",
            "geometry": {"type": "MultiLineString", "coordinates": lines},
            "properties": {
                "id": rid,
                "short": m.get("short") or rid,
                "name": m.get("long") or "",
                "color": m.get("color"),
                # 0 tram, 1 subway, 2 rail, 3 bus. CapMetro's Red Line is 2.
                "type": m.get("type", 3),
            },
        })
    rfeat.sort(key=lambda f: (f["properties"]["type"] != 2, f["properties"]["short"]))

    # ── stops.geojson ───────────────────────────────────────────────────
    sfeat = []
    for s in rows(zf, "stops.txt"):
        # location_type 1 is a station envelope rather than somewhere a bus
        # stops; the boardable children are separate rows.
        if (s.get("location_type") or "0") not in ("", "0"):
            continue
        try:
            lat, lon = float(s["stop_lat"]), float(s["stop_lon"])
        except (KeyError, TypeError, ValueError):
            continue
        serving = sorted(stop_routes.get(s["stop_id"], ()),
                         key=lambda r: (routes.get(r, {}).get("short") or r))
        if not serving:
            continue                      # nothing calls here in this feed
        sfeat.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
            "properties": {
                "id": s["stop_id"],
                "name": (s.get("stop_name") or "").strip(),
                "routes": [routes.get(r, {}).get("short") or r for r in serving],
                "route_ids": serving,
            },
        })

    meta = {"source": "CapMetro static GTFS via data.texas.gov", "version": version}
    for name, feats in (("routes.geojson", rfeat), ("stops.geojson", sfeat)):
        p = out / name
        p.write_text(json.dumps(
            {"type": "FeatureCollection", "meta": meta, "features": feats},
            separators=(",", ":")))
        print("%-16s %5d features  %6.1f KB" % (name, len(feats), p.stat().st_size / 1024))

    if not rfeat or not sfeat:
        sys.exit("one of the outputs is empty — refusing to call that a success")


if __name__ == "__main__":
    main()
