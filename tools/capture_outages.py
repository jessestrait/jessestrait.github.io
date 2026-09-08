#!/usr/bin/env python3
"""Capture Austin Energy outage state into an append-only archive.

Everything else on the map is a *record*: crashes, 311 calls, permits, fire
dispatches. Published after the fact, timestamped, fetchable forever. Nothing
is lost by not capturing them.

Outages are *state*. Austin Energy publishes a map of what is true right now
and never writes it down afterwards. There is no outage archive to query later,
so every poll we skip is history that will not exist. That asymmetry is the
whole reason this script runs on a schedule instead of on demand.

Discovery notes, established 2026-09-08 by watching outagemap.austinenergy.com:

  The viewer is KUBRA StormCenter. Its data lives on kubra.io behind a
  deployment id that changes on every publish, which is how they bust
  CloudFront's 24h cache — so the id must be read from currentState each run
  rather than hardcoded. currentState also names the stormcenter deployment,
  whose configuration names the report file. Three small requests, entirely
  self-healing if any id rotates.

  Access-Control-Allow-Origin is "*" on all of them, so a browser could read
  this directly; the archive still has to be built server-side because CORS was
  never the reason for capturing.

  The report is per-ZIP, not per-outage: 51 ZIPs with an outage count, customers
  affected, customers served and an ETR. There is no stable per-outage id in it,
  so an "outage" here is a ZIP-level episode — the stretch during which a ZIP
  has at least one outage. Start, end, duration, peak extent and peak customers
  all survive that framing; a single incident's identity does not.

Usage:
    python3 tools/capture_outages.py --out atx/data/outages
    python3 tools/capture_outages.py --out /tmp/x --dry-run
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def parse_iso(s):
    """fromisoformat only learned to read a trailing Z in 3.11, and this has to
    run on whatever the runner and this laptop happen to have."""
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00'))


BASE = 'https://kubra.io'
STORMCENTER = 'dd9c446f-f6b8-43f9-8f80-83f5245c60a1'
VIEW = '76446308-a901-4fa3-849c-3dd569933a51'
UA = 'jessestrait.github.io outage archive (+https://jessestrait.com/atx/)'

try:
    from zoneinfo import ZoneInfo
    AUSTIN = ZoneInfo('America/Chicago')
except Exception:                                   # no tzdata: fall back to UTC
    AUSTIN = dt.timezone.utc


def get_json(url, tries=3):
    """One GET with retries. Anything still failing after this should fail the
    run loudly — a silent empty poll would look identical to 'no outages'."""
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8'))
        except Exception as e:                      # noqa: BLE001 - retried below
            last = e
            if i < tries - 1:
                time.sleep(2 ** i)
    raise RuntimeError('GET failed after %d tries: %s (%s)' % (tries, url, last))


def discover():
    """currentState -> deployment path + configuration -> report path."""
    cs = get_json('%s/stormcenter/api/v1/stormcenters/%s/views/%s/currentState?preview=false'
                  % (BASE, STORMCENTER, VIEW))
    deployment = cs['data']['interval_generation_data']          # "data/<uuid>"
    cfg = get_json('%s/stormcenter/api/v1/stormcenters/%s/views/%s/configuration/%s?preview=false'
                   % (BASE, STORMCENTER, VIEW, cs['stormcenterDeploymentId']))
    blob = json.dumps(cfg)
    i = blob.find('public/reports/')
    if i < 0:
        raise RuntimeError('no report path in configuration; the viewer changed shape')
    report = blob[i:blob.find('"', i)]
    # updatedAt is when this deployment was published — the source's own clock,
    # which is the thing to compare our capture time against. The report itself
    # carries no timestamp; only the summary file does, and it is not worth a
    # fourth request for a value we already have.
    published = None
    if isinstance(cs.get('updatedAt'), (int, float)):
        published = (dt.datetime.fromtimestamp(cs['updatedAt'] / 1000, dt.timezone.utc)
                     .replace(microsecond=0).isoformat().replace('+00:00', 'Z'))
    return deployment, report, published


def poll():
    deployment, report, published = discover()
    doc = get_json('%s/%s/%s' % (BASE, deployment, report))
    data = doc.get('file_data', {})
    return {
        # Ours, not the schedule's: GitHub cron drifts badly under load, so the
        # only trustworthy timestamp is the one taken at the moment of fetch.
        'captured_at': utcnow(),
        'source_published': published,
        'deployment': deployment,
        'areas': data.get('areas', []) or [],
        'totals': data.get('totals') or {},
    }


def affected(area):
    n = area.get('n_out') or 0
    c = (area.get('cust_a') or {}).get('val') or 0
    return n > 0 or c > 0


def load(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:                               # a truncated write beats a crash loop
        return default


def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=1, sort_keys=True)
        f.write('\n')
    os.replace(tmp, path)


def minutes_between(a, b):
    try:
        return round((parse_iso(b) - parse_iso(a)).total_seconds() / 60)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='atx/data/outages')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    snap = poll()
    now = snap['captured_at']
    day = parse_iso(now).astimezone(AUSTIN).date().isoformat()

    open_path = os.path.join(args.out, 'open.json')
    day_path = os.path.join(args.out, day + '.json')

    open_doc = load(open_path, {'episodes': []})
    open_by_zip = {e['scope']['id']: e for e in open_doc.get('episodes', [])}

    live_zips = set()
    for a in snap['areas']:
        if not affected(a):
            continue
        zip_id = str(a.get('name') or '')
        live_zips.add(zip_id)
        n = a.get('n_out') or 0
        cust = (a.get('cust_a') or {}).get('val') or 0
        ep = open_by_zip.get(zip_id)
        if ep is None:
            # The shape here is deliberately generic — low-water crossings and
            # ADS-B orbits are the same object with a different kind/scope.
            ep = {
                'id': 'zip-%s-%s' % (zip_id, now.replace('-', '').replace(':', '')),
                'kind': 'power_outage',
                'source': 'austin-energy/kubra',
                'scope': {'type': 'zip', 'id': zip_id, 'bbox': (a.get('gotoMap') or {}).get('bbox')},
                'first_seen': now, 'last_seen': now, 'polls': 0,
                'peak_outages': 0, 'peak_customers_affected': 0,
                'customers_served': a.get('cust_s'), 'etr_last': None, 'ended': False,
            }
            open_by_zip[zip_id] = ep
        ep['last_seen'] = now
        ep['polls'] += 1
        ep['peak_outages'] = max(ep['peak_outages'], n)
        ep['peak_customers_affected'] = max(ep['peak_customers_affected'], cust)
        ep['etr_last'] = a.get('etr') or ep.get('etr_last')

    closed = []
    for zip_id in list(open_by_zip):
        if zip_id in live_zips:
            continue
        ep = open_by_zip.pop(zip_id)
        ep['ended'] = True
        ep['ended_at'] = now
        # Measured first_seen -> last_seen, not -> now. The true end is somewhere
        # in between, but "now" is only a good proxy when the previous poll
        # actually happened on time; after a cron gap or an outage in the
        # workflow itself it would inflate every duration by the length of the
        # gap. Both timestamps are kept so the uncertainty stays visible.
        ep['duration_min'] = minutes_between(ep['first_seen'], ep['last_seen'])
        closed.append(ep)

    t = snap['totals']
    totals_out = t.get('n_out')
    totals_cust = (t.get('cust_a') or {}).get('val')
    if totals_out is None:                          # fall back to our own sum
        totals_out = sum((a.get('n_out') or 0) for a in snap['areas'])
    if totals_cust is None:
        totals_cust = sum(((a.get('cust_a') or {}).get('val') or 0) for a in snap['areas'])
    totals_served = t.get('cust_s')

    # Closed episodes are filed under the day they *started*, so an episode that
    # runs past midnight stays in one piece instead of being split across files.
    by_day = {}
    for ep in closed:
        d = parse_iso(ep['first_seen']).astimezone(AUSTIN).date().isoformat()
        by_day.setdefault(d, []).append(ep)
    by_day.setdefault(day, [])

    for d, eps in by_day.items():
        p = os.path.join(args.out, d + '.json')
        doc = load(p, {'date': d, 'timezone': str(AUSTIN), 'polls': [], 'episodes': []})
        if d == day:
            doc['polls'].append({'at': now, 'source_at': snap['source_published'],
                                 'outages': totals_out, 'customers_affected': totals_cust,
                                 'customers_served': totals_served})
        doc['episodes'].extend(eps)
        if not args.dry_run:
            write(p, doc)

    open_doc = {'captured_at': now, 'source_published': snap['source_published'],
                'episodes': sorted(open_by_zip.values(), key=lambda e: e['first_seen'])}
    if not args.dry_run:
        write(open_path, open_doc)

    print('%s  outages=%d customers=%d  open=%d closed=%d  -> %s'
          % (now, totals_out, totals_cust, len(open_by_zip), len(closed),
             'DRY RUN' if args.dry_run else day_path))
    return 0


if __name__ == '__main__':
    sys.exit(main())
