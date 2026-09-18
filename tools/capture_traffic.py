#!/usr/bin/env python3
"""Record what TomTom and APD/ATD each saw, and how often they agree.

Nobody publishes, for Austin, how long a reported incident takes to become
congestion, how long the congestion outlives the wreck, or which corridors
jam with no reported cause. Both halves exist live and neither is archived,
so this writes them down as they happen and matches them offline.

Two witnesses to the same street:

  TomTom Incident Details  probe-derived, linestrings, sees the jam
  APD/ATD dispatch         reported, points, sees the cause

They are kept as separate records and never merged. An association is its
own row with its own score, so a later change to the matcher's tolerances
cannot corrupt what either source actually said. Provenance is the point.

RETENTION. TomTom's terms define traffic data as Content and constrain
storing it; the exact clause could not be read at build time (the terms page
renders client-side). So this assumes the restrictive reading, which costs
nothing: derived fields only, never raw responses, and TomTom-bearing daily
files are pruned after --retain-days. Aggregates are analysis output rather
than Content and are kept indefinitely — and the aggregates are the product.
Dispatch records are Austin open data and carry no such constraint.

    TOMTOM_ARCHIVE_KEY=... python3 tools/capture_traffic.py --out traffic

Writes, under --out:
    open.json                 currently-open episodes, both feeds (state)
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
SODA = "https://data.austintexas.gov/resource/dx9v-zd7x.json"

# TomTom's iconCategory, collapsed to the shared vocabulary. Checked against a
# live Austin response: 6 jam, 8 road closed, 9 roadworks and 7 lane closed are
# what actually turn up; 1 accident appears in daylight.
ICON_CAT = {
    0: "unknown", 1: "crash", 2: "hazard", 3: "hazard", 4: "hazard",
    5: "hazard", 6: "jam", 7: "closure", 8: "closure", 9: "roadwork",
    10: "hazard", 11: "hazard", 14: "stall",
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


def match(tt_eps, dp_eps, buffer_m, hw_buffer_m, tol_min, onset_window_min):
    """Point-to-line, not point-to-point: TomTom gives a linestring and
    dispatch gives a geocoded point, usually snapped to a block or an
    intersection. Every candidate pair is scored and the best per dispatch
    record is kept; both source rows survive untouched either way."""
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
                "tomtom_id": t["id"], "dispatch_id": d["id"],
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


def merge_matches(prior, found):
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
        k = (m.get("tomtom_id"), m.get("dispatch_id"))
        if k[0] is None or k[1] is None:
            continue
        cur = out.get(k)
        if cur is None or (m.get("score") or 0) > (cur.get("score") or 0):
            out[k] = m
    return [out[k] for k in sorted(out, key=lambda k: (k[1], k[0]))]


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
              matcher_params):
    tt_all = tt_closed + tt_open
    dp_all = dp_closed + dp_open
    m_tt = {m["tomtom_id"] for m in matches}
    m_dp = {m["dispatch_id"] for m in matches}

    def rate(items, matched_ids, hw):
        sel = [x for x in items if bool(x.get("roads")) == hw]
        if not sel:
            return {"n": 0}
        hit = sum(1 for x in sel if x["id"] in matched_ids)
        return {"n": len(sel), "matched": hit, "pct": round(100 * hit / len(sel), 1)}

    # Congestion nobody reported. The ones that recur at the same place and
    # the same hour of the week are a fact about the road, not an event.
    hot = {}
    for t in tt_all:
        if t["id"] in m_tt or t.get("cat") not in ("jam", "closure"):
            continue
        st = parse(t.get("start_time")) or parse(t.get("first_seen"))
        if not st:
            continue
        k = "%s|%d" % (seg_key(t.get("geom")), st.weekday() * 24 + st.hour)
        h = hot.setdefault(k, {"seg": seg_key(t.get("geom")),
                               "hour_of_week": st.weekday() * 24 + st.hour,
                               "n": 0, "from": t.get("from")})
        h["n"] += 1

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
        "dispatch_record_life_min": life,
        "dispatch_life_capped": capped,
        "matcher": matcher_params,
        "counts": {
            "tomtom": len(tt_all), "dispatch": len(dp_all), "matched": len(matches),
            "dispatch_only": len([d for d in dp_all if d["id"] not in m_dp]),
            "tomtom_only": len([t for t in tt_all if t["id"] not in m_tt]),
        },
        # Signed on purpose. Probe data often sees the jam before APD
        # publishes, so negatives are expected and are themselves the finding.
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
        "structural_hotspots": sorted(hot.values(), key=lambda x: -x["n"])[:15],
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
            "Statistics from matched pairs are subject to the matcher's own tolerances; "
            "the unmatched rate is reported beside them for that reason.",
            "A pair is only believed to be one event if the two start times fall within "
            "onset_window_min. Without that, all-day corridor jams swallow every nearby "
            "dispatch record and the onset offset becomes meaningless.",
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
    before = len(doc.get("matches", []))
    doc["matches"] = match(tt, dp, args.buffer, args.highway_buffer,
                           args.tolerance, args.onset_window)
    doc["rematched_at"] = iso(now())
    day_path.write_text(json.dumps(doc, separators=(",", ":"), sort_keys=True))
    summ = summarise(day, tt, dp, doc["matches"], [], [], args.interval,
                     {"buffer_m": args.buffer, "highway_buffer_m": args.highway_buffer,
                      "tolerance_min": args.tolerance,
                      "onset_window_min": args.onset_window})
    summ["rematched"] = True
    (out / "summary" / (day + ".json")).write_text(
        json.dumps(summ, separators=(",", ":"), sort_keys=True))
    print("%s: %d matches -> %d  (%d tomtom, %d dispatch episodes on file)"
          % (day, before, len(doc["matches"]), len(tt), len(dp)))
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
                    help="days of TomTom-bearing daily files to keep; aggregates are forever")
    ap.add_argument("--rematch", metavar="YYYY-MM-DD", default=None,
                    help="recompute matches and the summary for a day already on "
                         "disk, from its own archived episodes. Needs no key and "
                         "fetches nothing — it is how the days recorded under the "
                         "overwriting bug get their real numbers back.")
    args = ap.parse_args()

    if args.rematch:
        return rematch(pathlib.Path(args.out), args)

    key = os.environ.get("TOMTOM_ARCHIVE_KEY", "").strip()
    if not key:
        sys.exit("TOMTOM_ARCHIVE_KEY is not set. This must be a separate, "
                 "non-domain-restricted key: a key locked to jessestrait.com "
                 "cannot work from Actions, which sends no referrer.")

    out = pathlib.Path(args.out)
    (out / "summary").mkdir(parents=True, exist_ok=True)

    stamp = iso(now())
    state_path = out / "open.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    tt_open = state.get("tomtom", {})
    dp_open = state.get("dispatch", {})

    tt_seen = fetch_tomtom(key)
    dp_seen = fetch_dispatch()

    tt_closed = upsert(tt_open, tt_seen, stamp)
    dp_closed = upsert(dp_open, dp_seen, stamp)

    # Matched across everything currently known, so a dispatch record can
    # still find its jam a poll or two later.
    matches = match(list(tt_open.values()) + tt_closed,
                    list(dp_open.values()) + dp_closed,
                    args.buffer, args.highway_buffer, args.tolerance,
                    args.onset_window)

    day = stamp[:10]
    day_path = out / (day + ".json")
    day_doc = json.loads(day_path.read_text()) if day_path.exists() else {
        "date": day, "tomtom_closed": [], "dispatch_closed": [], "matches": []}
    day_doc["tomtom_closed"].extend(tt_closed)
    day_doc["dispatch_closed"].extend(dp_closed)
    day_doc["matches"] = merge_matches(day_doc.get("matches"), matches)
    day_doc["fetched_at"] = stamp
    day_path.write_text(json.dumps(day_doc, separators=(",", ":"), sort_keys=True))

    state_path.write_text(json.dumps(
        {"fetched_at": stamp, "tomtom": tt_open, "dispatch": dp_open},
        separators=(",", ":"), sort_keys=True))

    summ = summarise(day, day_doc["tomtom_closed"], day_doc["dispatch_closed"],
                     matches, list(tt_open.values()), list(dp_open.values()),
                     args.interval,
                     {"buffer_m": args.buffer, "highway_buffer_m": args.highway_buffer,
                      "tolerance_min": args.tolerance,
                      "onset_window_min": args.onset_window})
    (out / "summary" / (day + ".json")).write_text(
        json.dumps(summ, indent=1, sort_keys=True))

    # Prune TomTom-bearing daily files. The summaries beside them are
    # aggregates and stay.
    cutoff = (now() - dt.timedelta(days=args.retain_days)).date().isoformat()
    pruned = 0
    for f in out.glob("20??-??-??.json"):
        if f.stem < cutoff:
            f.unlink()
            pruned += 1

    c = summ["counts"]
    print("%s  tomtom %d (+%d closed)  dispatch %d (+%d closed)  matched %d  "
          "unmatched dispatch %s%%  pruned %d"
          % (stamp, len(tt_open), len(tt_closed), len(dp_open), len(dp_closed),
             c["matched"], summ["unmatched_pct"]["dispatch"], pruned))


if __name__ == "__main__":
    main()
