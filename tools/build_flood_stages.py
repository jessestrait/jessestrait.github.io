#!/usr/bin/env python3
"""Bake the NWS flood thresholds for the gauges around Austin.

The creek gauges layer shows live stage from USGS, which is a number with no
meaning attached: 4.2 ft is alarming on one creek and unremarkable on the
next. The National Weather Service publishes what counts as minor, moderate
and major flooding per gauge, and that is what turns the number into a fact.

Those thresholds are effectively static — they change when NWS revises a
forecast point, which is rare — while the stage changes every fifteen
minutes. So they are fetched here, once, rather than by every visitor: the
bbox listing does not carry them, so it takes one request per gauge, which is
fine as a build step and would not be fine in a browser.

    python3 tools/build_flood_stages.py

Writes atx/data/floodstages.json, keyed by USGS site number so the page can
join it straight onto the gauges it already draws.
"""

import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

NWPS = "https://api.water.noaa.gov/nwps/v1/gauges"
BOX = dict(xmin=-98.15, ymin=30.05, xmax=-97.35, ymax=30.62)
OUT = pathlib.Path(__file__).resolve().parent.parent / "atx" / "data" / "floodstages.json"

# NWPS writes -9999 for a threshold that does not exist for that gauge, which
# is a sentinel and not a stage. Anything at or below this is "not published".
MISSING = -9000.0


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "jessestrait.com/atx"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def main():
    listing = get("%s?srid=EPSG_4326&%s" % (
        NWPS, "&".join("bbox.%s=%s" % (k, v) for k, v in BOX.items())))
    gauges = listing.get("gauges", [])
    print("gauges in the box: %d" % len(gauges))

    sites, skipped = {}, []
    for i, g in enumerate(gauges, 1):
        lid = g.get("lid")
        if not lid:
            continue
        try:
            d = get("%s/%s" % (NWPS, lid))
        except Exception as e:
            skipped.append("%s (%s)" % (lid, e))
            continue
        usgs = (d.get("usgsId") or "").strip()
        cats = ((d.get("flood") or {}).get("categories") or {})
        levels = {}
        for name in ("action", "minor", "moderate", "major"):
            v = (cats.get(name) or {}).get("stage")
            if isinstance(v, (int, float)) and v > MISSING:
                levels[name] = round(float(v), 2)
        # A gauge with no USGS number cannot be joined to anything the page
        # draws, and one with no thresholds adds nothing over the stage itself.
        if not usgs or not levels:
            skipped.append("%s %s" % (lid, "no usgsId" if not usgs else "no thresholds"))
            continue
        # The record of what this creek has actually done is the other half of
        # the context: "minor is 13ft" means more beside "it hit 16.1 in 2015".
        crests = ((d.get("flood") or {}).get("crests") or {}).get("historic") or []
        best = None
        for c in crests:
            s = c.get("stage")
            if isinstance(s, (int, float)) and s > MISSING and (best is None or s > best[0]):
                best = (round(float(s), 2), (c.get("occurredTime") or "")[:10])
        sites[usgs] = {
            "lid": lid,
            "name": d.get("name") or g.get("name") or "",
            "levels": levels,
        }
        if best:
            sites[usgs]["record"] = {"stage": best[0], "on": best[1]}
        print("  %-8s %-10s %-34s %s" % (lid, usgs, sites[usgs]["name"][:34],
                                         " ".join("%s=%s" % kv for kv in levels.items())))

    if not sites:
        sys.exit("no gauge carried both a USGS id and a threshold — refusing to write that")

    OUT.write_text(json.dumps({
        "source": "NOAA National Water Prediction Service",
        "built": time.strftime("%Y-%m-%d"),
        "sites": sites,
    }, separators=(",", ":"), sort_keys=True))
    print()
    print("%s  %d sites with thresholds, %d skipped, %.1f KB"
          % (OUT.name, len(sites), len(skipped), OUT.stat().st_size / 1024))
    for s in skipped:
        print("   skipped %s" % s)


if __name__ == "__main__":
    main()
