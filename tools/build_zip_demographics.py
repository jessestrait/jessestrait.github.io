#!/usr/bin/env python3
"""Population-weighted demographics per ZIP, joined from census block groups.

The outage archive is keyed by ZIP, because that is the only geography
Austin Energy reports. Every demographic the map already carries is keyed by
census block group, because that is the geography the Census publishes. To ask
whether the parts of Austin that lose power longest are also the poorest, the
two have to meet, and this is where.

Block groups are assigned to the ZIP their centroid falls in — not split
across ZIPs by area. A block group is small (roughly 600-3,000 people) and ZIP
boundaries were drawn for mail, not for people, so some misallocation at the
seams is unavoidable either way; centroid assignment is the honest simple
choice and it keeps every person counted exactly once.

Rates are weighted by population, not averaged across block groups. A plain
mean would let a block group of 400 people count as much as one of 3,000,
which would quietly overweight the emptiest corners of a ZIP.

    python3 tools/build_zip_demographics.py

Writes atx/data/zipdemo.json.
"""

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BG = ROOT / "atx" / "data" / "blockgroups.json"
ZIPS = ROOT / "atx" / "data" / "zips.json"
OUT = ROOT / "atx" / "data" / "zipdemo.json"

# Rates carried through as population-weighted means. Keys are the block-group
# property names already in blockgroups.json.
RATES = {
    "pov": "poverty rate",
    "poc": "people of colour share",
    "unemp": "unemployment rate",
    "canopy": "tree canopy share",
    "tes": "tree equity score",
}


def rings(geom):
    """Every outer ring in a Polygon or MultiPolygon, as a list of [x, y]."""
    if not geom:
        return []
    t, c = geom.get("type"), geom.get("coordinates") or []
    if t == "Polygon":
        return [c[0]] if c else []
    if t == "MultiPolygon":
        return [p[0] for p in c if p]
    return []


def centroid(geom):
    """Area-weighted centroid over the outer rings (the shoelace formula).

    Falls back to the mean vertex when a ring is degenerate, which happens
    with slivers the simplifier has flattened.
    """
    best, best_area = None, 0.0
    for ring in rings(geom):
        if len(ring) < 3:
            continue
        a = cx = cy = 0.0
        for i in range(len(ring) - 1):
            x0, y0 = ring[i][0], ring[i][1]
            x1, y1 = ring[i + 1][0], ring[i + 1][1]
            cross = x0 * y1 - x1 * y0
            a += cross
            cx += (x0 + x1) * cross
            cy += (y0 + y1) * cross
        if abs(a) < 1e-12:
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            area, c = 0.0, (sum(xs) / len(xs), sum(ys) / len(ys))
        else:
            area, c = abs(a / 2.0), (cx / (3 * a), cy / (3 * a))
        if area >= best_area:
            best, best_area = c, area
    return best


def in_ring(x, y, ring):
    """Ray casting, counting crossings of the ring to the left of the point."""
    inside = False
    n = len(ring)
    for i in range(n - 1):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[i + 1][0], ring[i + 1][1]
        if (y0 > y) != (y1 > y):
            xi = x0 + (y - y0) / (y1 - y0) * (x1 - x0)
            if xi > x:
                inside = not inside
    return inside


def in_geom(x, y, geom):
    return any(in_ring(x, y, r) for r in rings(geom) if len(r) >= 3)


def bbox(geom):
    xs, ys = [], []
    for r in rings(geom):
        for p in r:
            xs.append(p[0])
            ys.append(p[1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def main():
    for p in (BG, ZIPS):
        if not p.exists():
            sys.exit(f"missing {p} — run tools/build_atx_geo.py first")

    bgs = json.loads(BG.read_text())["features"]
    zips = json.loads(ZIPS.read_text())["features"]

    # Bounding boxes first: a box test rejects almost every pair for a few
    # arithmetic ops, which turns 644 x 51 point-in-polygon tests into a few
    # hundred real ones.
    zboxes = [(f["properties"]["zip"], f["geometry"], bbox(f["geometry"])) for f in zips]

    acc, unplaced = {}, 0
    for f in bgs:
        props = f.get("properties") or {}
        pop = props.get("pop") or 0
        c = centroid(f.get("geometry"))
        if not c:
            continue
        x, y = c
        hit = None
        for z, geom, bb in zboxes:
            if not bb or x < bb[0] or x > bb[2] or y < bb[1] or y > bb[3]:
                continue
            if in_geom(x, y, geom):
                hit = z
                break
        if hit is None:
            unplaced += 1
            continue
        a = acc.setdefault(hit, {"pop": 0, "bgs": 0, "w": {k: 0.0 for k in RATES}})
        a["pop"] += pop
        a["bgs"] += 1
        for k in RATES:
            v = props.get(k)
            if v is not None:
                a["w"][k] += float(v) * pop

    out = {}
    for z, a in acc.items():
        if not a["pop"]:
            continue
        row = {"pop": a["pop"], "bgs": a["bgs"]}
        for k in RATES:
            row[k] = round(a["w"][k] / a["pop"], 2)
        out[z] = row

    OUT.write_text(json.dumps({"zips": out}, separators=(",", ":"), sort_keys=True))

    placed = sum(v["bgs"] for v in out.values())
    print(f"{len(out)} ZIPs from {placed} block groups "
          f"({unplaced} fell outside every ZIP polygon)")
    print(f"{sum(v['pop'] for v in out.values()):,} people covered")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.1f} KB)")
    ranked = sorted(out.items(), key=lambda kv: -kv[1]["pov"])[:5]
    print("highest poverty rate:",
          ", ".join(f"{z} {v['pov']}%" for z, v in ranked))


if __name__ == "__main__":
    main()
