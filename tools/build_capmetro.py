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

# A drawn route does not need survey precision. Shapes run to thousands of
# points; a few hundred is past the point where anyone could see the
# difference at any zoom this map offers.
MAX_SHAPE_PTS = 360


def rows(zf, name):
    """Stream one member as dicts without unpacking it to disk. utf-8-sig
    because trips.txt ships with a BOM, which would otherwise make the first
    column 'route_id' unreachable by name."""
    with zf.open(name) as fh:
        for r in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")):
            yield r


def decimate(pts, keep=MAX_SHAPE_PTS):
    if len(pts) <= keep:
        return [[round(x, 5), round(y, 5)] for x, y in pts]
    step = (len(pts) - 1) / (keep - 1)
    out = [pts[min(len(pts) - 1, round(i * step))] for i in range(keep)]
    return [[round(x, 5), round(y, 5)] for x, y in out]


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

    best = {}
    for (rid, direction, sid), n in shape_votes.items():
        k = (rid, direction)
        if k not in best or n > best[k][1]:
            best[k] = (sid, n)
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
    for (rid, direction), (sid, _) in best.items():
        line = [(x, y) for x, y, _ in pts.get(sid, [])]
        if len(line) >= 2:
            by_route[rid].append(decimate(line))

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
