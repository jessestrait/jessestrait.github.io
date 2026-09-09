#!/usr/bin/env python3
"""Fetch Austin news feeds into atx/data/news.json for the ticker.

RSS endpoints almost never send Access-Control-Allow-Origin, so the page cannot
read them directly. This runs server-side in Actions and commits the result, so
the page fetches its own file, same origin, no proxy and nobody else's server in
the path. Same shape of answer as the outage archive next door.

Each headline is tagged with any Austin place it names, using the coordinates in
gazetteer.json — which are themselves derived from the map's own street, ZIP and
district files. That is what lets the ticker mark the headlines that are about
whatever you are currently looking at, rather than scrolling the same generic
crawl every other site has.

    python3 tools/fetch_news.py --out atx/data/news.json
"""
import argparse, datetime as dt, html, json, os, re, sys, urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

UA = {'User-Agent': 'Mozilla/5.0 (compatible; jessestrait.com/atx news ticker)'}
ATOM = '{http://www.w3.org/2005/Atom}'
LIMIT = 60

# Verified reachable and parseable 2026-09-08, re-checked 2026-09-09.
#
# Not here, and why:
#   Austin Monitor  — dead. Its feed still serves, but the newest item is 307
#                     days old and titled "Our last update: Everything you need
#                     to know". It was costing a request a run and returning a
#                     corpse.
#   Statesman       — Gannett, 404 on every documented feed path.
#   Austin Chronicle— serves non-XML on every documented feed path.
#
# KUT publishes per-section feeds, not one wire. /news.rss looked right and is
# actually music obituaries; /austin.rss is the local desk and runs hours fresh.
FEEDS = [
    ('KXAN',             'https://www.kxan.com/feed/',                  True),
    ('KUT',              'https://www.kut.org/austin.rss',              True),
    ('KUT Transport',    'https://www.kut.org/transportation.rss',      True),
    ('FOX 7',            'https://www.fox7austin.com/rss/category/local-news', True),
    ('KVUE',             'https://www.kvue.com/feeds/syndication/rss/news/local/', True),
    ('CBS Austin',       'https://cbsaustin.com/news/local.rss',        True),
    # Statewide feeds: everything from these has to prove it is about Austin.
    ('Community Impact', 'https://communityimpact.com/rss/',            False),
    ('Google News',      'https://news.google.com/rss/search?q=Austin%20Texas&hl=en-US&gl=US&ceid=US:en', False),
]

# For the two statewide feeds. A headline has to carry one of these to count.
AUSTIN_WORDS = re.compile(
    r'\b(austin|travis county|atx|pflugerville|round rock|cedar park|leander|'
    r'georgetown|hutto|manor|del valle|buda|kyle|san marcos|bastrop|elgin|'
    r'lakeway|west lake hills|sunset valley|dripping springs|bee cave)\b', re.I)


def get(url, tries=2):
    last = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=25) as r:
                return r.read()
        except Exception as e:                       # noqa: BLE001
            last = e
    raise RuntimeError('%s: %s' % (url, last))


def text(el, *names):
    for n in names:
        v = el.findtext(n)
        if v:
            return v.strip()
    return ''


def when(el):
    raw = text(el, 'pubDate', 'published', ATOM + 'published', ATOM + 'updated', 'updated')
    if not raw:
        return None
    try:
        d = parsedate_to_datetime(raw)
    except Exception:                                 # noqa: BLE001 - ISO fallback
        try:
            d = dt.datetime.fromisoformat(raw.replace('Z', '+00:00'))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


def link_of(el):
    l = text(el, 'link')
    if l:
        return l
    for a in el.findall(ATOM + 'link'):
        if a.get('rel') in (None, 'alternate') and a.get('href'):
            return a.get('href')
    return ''


def clean(s):
    s = html.unescape(s or '')
    s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'\s+', ' ', s).strip()


def parse(raw):
    root = ET.fromstring(raw)
    return root.findall('.//item') or root.findall('.//' + ATOM + 'entry')


def build_matcher(gaz):
    """One regex per place. Word-bounded, longest first, so "South Congress"
    wins over "Congress" and a bare ZIP still matches."""
    pats = []
    for name in sorted(gaz, key=len, reverse=True):
        pats.append((name, re.compile(r'(?<![A-Za-z0-9])' + re.escape(name) + r'(?![A-Za-z0-9])', re.I)))
    return pats


def places_in(title, pats, gaz):
    found, taken = [], []
    for name, rx in pats:
        m = rx.search(title)
        if not m:
            continue
        # A longer name already covering this span wins; "Congress" inside
        # "South Congress" should not add a second, wronger pin.
        if any(s <= m.start() < e or s < m.end() <= e for s, e in taken):
            continue
        taken.append((m.start(), m.end()))
        lat, lng = gaz[name]
        found.append({'name': name, 'lat': lat, 'lng': lng})
        if len(found) == 3:
            break
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='atx/data/news.json')
    ap.add_argument('--gazetteer', default='atx/data/gazetteer.json')
    args = ap.parse_args()

    gaz = json.load(open(args.gazetteer))
    pats = build_matcher(gaz)

    items, seen, sources_ok, sources_bad = [], set(), [], []
    for source, url, is_local in FEEDS:
        try:
            entries = parse(get(url))
        except Exception as e:                        # noqa: BLE001
            sources_bad.append('%s (%s)' % (source, type(e).__name__))
            continue
        sources_ok.append(source)
        for el in entries[:40]:
            title = clean(text(el, 'title', ATOM + 'title'))
            if not title or len(title) < 12:
                continue
            if not is_local and not AUSTIN_WORDS.search(title):
                continue
            key = re.sub(r'[^a-z0-9]', '', title.lower())[:70]
            if key in seen:
                continue
            seen.add(key)
            items.append({
                'title': title, 'link': link_of(el).strip(), 'source': source,
                'published': when(el), 'places': places_in(title, pats, gaz),
            })

    # Newest first; anything undated sinks rather than claiming the top.
    items.sort(key=lambda x: x['published'] or '', reverse=True)
    items = items[:LIMIT]

    out = {
        'fetched_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
                        .isoformat().replace('+00:00', 'Z'),
        'sources': sources_ok,
        'items': items,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    os.replace(tmp, args.out)

    tagged = sum(1 for i in items if i['places'])
    print('%d headlines from %d feeds, %d place-tagged -> %s (%.0f KB)'
          % (len(items), len(sources_ok), tagged, args.out, os.path.getsize(args.out) / 1024))
    if sources_bad:
        print('  did not answer:', ', '.join(sources_bad))
    return 0 if items else 1


if __name__ == '__main__':
    sys.exit(main())
