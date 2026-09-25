#!/usr/bin/env python3
"""Aircraft over Austin, written down often enough to be worth drawing.

WHY THIS IS A SCHEDULED JOB AND NOT A FETCH FROM THE PAGE.

Three separate doors are shut:

  * No ADS-B aggregator sends an access-control-allow-origin a browser
    can use, so the page cannot ask directly. OpenSky sends one for its
    own origin, which is worse than sending none.
  * The Cloudflare relay that solves exactly this problem for CapMetro
    is refused by every one of them: airplanes.live 403, adsb.lol 429,
    adsb.fi 403, OpenSky 522 — measured 2026-09-25, repeatedly, while
    the same URLs answered a laptop on the same second. Those are
    deliberate blocks on datacenter address space, which is what these
    feeds exist to prevent.
  * GitHub's runners are not blocked. Probed the same minute: adsb.lol
    and adsb.fi both 200 with 13 aircraft over Austin.

So this runs here, on a runner, and commits what it saw.

WHY THE PAGE CAN GET AWAY WITH STALE POSITIONS.

Aircraft are the most predictable moving things this map draws. A bus
in traffic is unforecastable thirty seconds out; an airliner at cruise
is a straight line. The file therefore carries heading, ground speed
and vertical rate alongside each position, and the page dead-reckons
forward from the timestamp. Two minutes of extrapolation on something
flying straight and level is close; the same two minutes on a bus is
fiction, which is why the bus layer does not do it.

WHAT IS KEPT. Derived and positional fields only, overwritten every
poll — there is no archive, because a position is worthless the moment
it is superseded and there is no question this data answers later.
That also keeps the repository's growth to one small file's diffs.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

UA = 'jessestrait.com/atx map (contact via jessestrait.com)'

# Tried in order. The first two are the same readsb payload shape (`ac`);
# adsb.fi answers under `aircraft`; OpenSky is a different thing entirely
# and is last because its free tier is 400 credits a day.
SOURCES = [
    ('adsb.lol', 'https://api.adsb.lol/v2/lat/30.27/lon/-97.74/dist/40'),
    ('adsb.fi', 'https://opendata.adsb.fi/api/v2/lat/30.27/lon/-97.74/dist/40'),
    ('airplanes.live', 'https://api.airplanes.live/v2/point/30.27/-97.74/40'),
]

# Roughly Travis County plus the approach corridors either side of AUS.
BBOX = (29.95, -98.20, 30.60, -97.30)


def get(url, timeout=25):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and abs(f) != float('inf') else None


def clean(raw):
    """One aircraft, reduced to what the map draws with."""
    lat, lon = num(raw.get('lat')), num(raw.get('lon'))
    if lat is None or lon is None:
        return None
    if not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
        return None

    # alt_baro is the string "ground" for anything on a taxiway, which is
    # a fact worth keeping rather than a number that failed to parse.
    alt_raw = raw.get('alt_baro')
    on_ground = alt_raw == 'ground'
    alt = None if on_ground else num(alt_raw)

    out = {
        'lat': round(lat, 5),
        'lng': round(lon, 5),
        'hex': (raw.get('hex') or '').strip() or None,
        'flight': (raw.get('flight') or '').strip() or None,
        'type': (raw.get('t') or '').strip() or None,
        'reg': (raw.get('r') or '').strip() or None,
        'ground': on_ground,
    }
    if alt is not None:
        out['alt_ft'] = int(alt)
    gs = num(raw.get('gs'))
    if gs is not None:
        out['gs_kt'] = round(gs, 1)
    trk = num(raw.get('track'))
    if trk is not None:
        out['track'] = round(trk, 1)
    # baro_rate is feet per minute; geom_rate stands in when it is absent.
    rate = num(raw.get('baro_rate'))
    if rate is None:
        rate = num(raw.get('geom_rate'))
    if rate is not None:
        out['vs_fpm'] = int(rate)
    return out


def poll():
    """First source that answers wins; every failure is reported."""
    errs = []
    for name, url in SOURCES:
        try:
            d = get(url)
        except urllib.error.HTTPError as e:
            errs.append('%s -> %s' % (name, e.code))
            continue
        except Exception as e:                       # noqa: BLE001
            errs.append('%s -> %s' % (name, e))
            continue
        raw = d.get('ac') or d.get('aircraft') or []
        seen = [c for c in (clean(a) for a in raw) if c]
        # An empty list from a source that answered is a real answer at
        # four in the morning, so it is not a reason to try the next one.
        return name, seen, errs
    return None, [], errs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='aircraft')
    ap.add_argument('--interval', type=float, default=0,
                    help='seconds to wait before writing; 0 writes at once')
    args = ap.parse_args()

    if args.interval:
        time.sleep(args.interval)

    src, planes, errs = poll()
    if src is None:
        print('no source answered: ' + ' | '.join(errs), file=sys.stderr)
        return 1

    planes.sort(key=lambda p: (p.get('alt_ft') or 0), reverse=True)
    doc = {
        'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'source': src,
        'count': len(planes),
        'airborne': sum(1 for p in planes if not p['ground']),
        'note': ('Positions are as of fetched_at. The page carries them '
                 'forward on heading and ground speed, which is honest for '
                 'something flying straight and guesswork for anything '
                 'manoeuvring.'),
        'aircraft': planes,
    }
    if errs:
        doc['fell_back_past'] = errs

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, 'open.json')
    with open(path, 'w') as f:
        json.dump(doc, f, separators=(',', ':'), sort_keys=True)
    print('%s: %d aircraft (%d airborne) -> %s'
          % (src, len(planes), doc['airborne'], path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
