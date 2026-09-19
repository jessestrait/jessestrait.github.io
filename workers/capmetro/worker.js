/**
 * A relay for the handful of Austin feeds a browser cannot read itself.
 *
 * Named capmetro because that was the first one. Everything here has the
 * same shape of problem: the data is public, free, and one header away from
 * being usable from a static page.
 *
 * The CapMetro case, which set the pattern:
 *
 * data.texas.gov serves these files from `/download/<id>/...`, which answers
 * 302 and points at a blob under `/api/views/<id>/files/<uuid>`. The blob has
 * `access-control-allow-origin: *`. The redirect does not — and a CORS request
 * is checked at every hop, not just the last one, so the browser rejects the
 * chain before it ever reaches the file. curl is perfectly happy, which makes
 * this an easy thing to convince yourself works when it does not.
 *
 * Pinning the blob uuid does not help: it rotates on every publish. Three
 * probes ten seconds apart returned three different uuids and three different
 * payloads. The pointer is the only way in, and the pointer is the part the
 * browser will not follow.
 *
 * So: one hop through here, which adds the header the redirect is missing.
 * Nothing else. It does not parse, reshape, filter or enrich — a proxy that
 * transforms is a proxy you have to keep in step with the upstream schema, and
 * this one should still work untouched in five years.
 *
 * Deploy:  npx wrangler deploy      (from this directory)
 */

// The JSON vehicle-positions feed rather than the protobuf one. Both exist;
// raw, JSON is 75 KB against 21 KB, but gzipped it is 9 KB against 8 KB,
// because protobuf is already compact and compresses poorly while JSON is
// hugely repetitive. One kilobyte over the wire is a fair price for deleting
// a protobuf decoder from the page entirely.
const FEEDS = {
  vehicles: {
    url: 'https://data.texas.gov/download/cuc7-ywmd/text%2Fplain',
    type: 'application/json; charset=utf-8',
    // Republishes about every 30 seconds, measured at 28 seconds old on a
    // live fetch, so half a cycle is the most anyone sees.
    ttl: 15,
  },
  /* Trip updates: predicted arrivals, delays and skipped stops, which is
     what turns a moving dot into "the 803 is four minutes down".

     This used to point at rmk2-acnw, the protobuf build, on the assumption
     that trip updates were published only as bytes — they are not.
     mqtr-wwpy is the same feed as JSON, and the page can read it with no
     decoder at all. 745 KB raw against 180 KB of protobuf, but it gzips to
     a fraction of that and deleting a protobuf decoder from a single-file
     page is worth several hundred kilobytes of wire. */
  trips: {
    url: 'https://data.texas.gov/download/mqtr-wwpy/text%2Fplain',
    type: 'application/json; charset=utf-8',
    // Republishes on the same cadence as the positions.
    ttl: 20,
  },
  /* Service alerts: detours, stop closures, elevator outages.

     Not GTFS-realtime shaped despite the name — no header, no entity, just
     a bare JSON array of alert objects with activePeriods and
     informedEntities. Handled as what it is rather than what it is called.

     It also carries the name and work email of the CapMetro employee who
     filed each alert. That is CapMetro's decision to publish and not this
     relay's to censor — it passes bytes through unchanged, which is the one
     promise it makes — but nothing on the page reads those fields. */
  alerts: {
    url: 'https://data.texas.gov/download/9zu9-jwr2/text%2Fplain',
    type: 'application/json; charset=utf-8',
    ttl: 120,
  },
  /* ADS-B positions. No CORS header at all, rather than a redirect that
     drops it. 40 nautical miles covers the approach and departure corridors
     either side of AUS as well as the county.

     Two upstreams, tried in order, because the obvious one does not want
     this traffic: adsb.fi answers a laptop happily and returns 403 to
     Cloudflare, which is a deliberate block on datacenter addresses rather
     than a fault, and rate-limits hard besides (429 on a second call seconds
     later). adsb.lol serves the same readsb payload and does not object. The
     fallback is kept so a bad day at one does not take the layer down —
     note the response shapes differ, `ac` here against `aircraft` there. */
  aircraft: {
    urls: [
      'https://api.adsb.lol/v2/lat/30.27/lon/-97.74/dist/40',
      'https://opendata.adsb.fi/api/v2/lat/30.27/lon/-97.74/dist/40',
    ],
    type: 'application/json; charset=utf-8',
    ttl: 10,
  },
  // FAA national airspace status. XML, no CORS. Almost always says nothing
  // about Austin, which is the point — it is an exception feed.
  faa: {
    url: 'https://nasstatus.faa.gov/api/airport-status-information',
    type: 'application/xml; charset=utf-8',
    ttl: 120,
  },
  // LCRA hydromet. This one does send a CORS header and it is
  // access-control-allow-origin: https://www.lcra.org, which is worse than
  // sending none: a browser reads it, sees someone else's origin, and
  // refuses. A Worker is not a browser and the rule does not apply.
  lcra: {
    url: 'https://hydromet.lcra.org/api/GetDataForAllSites',
    type: 'application/json; charset=utf-8',
    ttl: 300,
  },
};

const DEFAULT_TTL = 30;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
};

const INDEX = `Austin feed relay

  /vehicles   CapMetro vehicle positions, GTFS-realtime JSON
  /trips      CapMetro trip updates, GTFS-realtime JSON
  /alerts     CapMetro service alerts, a bare JSON array
  /aircraft   ADS-B traffic within 40 nm of downtown
  /faa        FAA national airspace status, XML
  /lcra       LCRA hydromet, every gauge in the basin

Each of these is public and free and unreadable from a browser, for a
different reason. This adds the missing header and changes nothing else
about the payload.
`;

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Only GET.', { status: 405, headers: CORS });
    }

    const path = new URL(request.url).pathname.replace(/^\/+|\/+$/g, '');
    if (!path) {
      return new Response(INDEX, {
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const feed = FEEDS[path];
    if (!feed) {
      return new Response(`No feed called "${path}". Try one of: ${Object.keys(FEEDS).join(', ')}.`,
        { status: 404, headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' } });
    }

    // Keyed on this Worker's own URL rather than the upstream one, so the
    // rotating blob uuid never lands in the cache key and every viewer shares
    // one entry. The Cache API insists the key be a URL on the zone serving
    // the Worker, which is why this is not some tidy invented hostname.
    //
    // On a *.workers.dev subdomain the Cache API is a no-op — Cloudflare does
    // not cache there. It still costs nothing, it simply never hits, and the
    // cache-control header below is doing the real work until this sits on a
    // custom domain. Everything here is wrapped because a no-op today and a
    // throw tomorrow should both be survivable.
    const cache = caches.default;
    const key = new Request(new URL('/' + path, request.url).toString(), { method: 'GET' });

    try {
      const hit = await cache.match(key);
      if (hit) {
        const r = new Response(hit.body, hit);
        r.headers.set('x-relay-cache', 'hit');
        return r;
      }
    } catch (e) {
      // Cache unavailable is not a reason to fail the request.
    }

    // redirect:'follow' is the default and is the entire point: the Worker
    // follows the 302 the browser refuses to, because CORS is a browser rule
    // and does not apply here.
    const tries = feed.urls || [feed.url];
    let upstream = null;
    // Every attempt, not just the last: with a fallback chain, "the last one
    // failed" tells you almost nothing about why the route is down.
    const errs = [];
    for (const u of tries) {
      try {
        const r = await fetch(u, {
          redirect: 'follow',
          // Identifying, because some of these ask politely for it and one of
          // them (airplanes.live) refuses outright without it.
          headers: { 'user-agent': 'jessestrait.com/atx map relay (contact via jessestrait.com)' },
        });
        if (r.ok) { upstream = r; break; }
        errs.push(`${u.split('/')[2]} -> ${r.status}`);
      } catch (e) {
        errs.push(`${u.split('/')[2]} -> ${e}`);
      }
    }
    if (!upstream) {
      return new Response(`No upstream answered. ${errs.join(' | ')}`, {
        status: 502,
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (!upstream.ok) {
      // Pass the upstream's own status through rather than flattening it —
      // a 503 from data.texas.gov should not look like a bug in here.
      return new Response(`Upstream said ${upstream.status}.`, {
        status: upstream.status === 404 ? 502 : upstream.status,
        headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const res = new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'content-type': feed.type,
        'cache-control': `public, max-age=${feed.ttl || DEFAULT_TTL}`,
        'x-relay-cache': 'miss',
      },
    });

    // waitUntil so the write never sits between the reader and their data,
    // and caught so a cache that refuses does not take the response with it.
    try {
      ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    } catch (e) { /* no cache here; the response is already good */ }
    return res;
  },
};
