/**
 * CapMetro GTFS-realtime, made readable from a browser.
 *
 * Why this exists at all, since every other feed on the map is fetched
 * straight from the page:
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
  },
  // Trip updates are published only as protobuf, so this one is bytes and the
  // caller needs a decoder. Here because it costs nothing to route.
  trips: {
    url: 'https://data.texas.gov/download/rmk2-acnw/application%2Foctet-stream',
    type: 'application/octet-stream',
  },
};

// The feed republishes about every 30 seconds — measured at 28 seconds old on
// a live fetch. Fifteen seconds at the edge means a busy moment costs the
// upstream one request rather than one per viewer, and no reader ever sees
// anything more than half a cycle stale.
const EDGE_TTL = 15;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
};

const INDEX = `CapMetro GTFS-realtime relay

  /vehicles   live vehicle positions, GTFS-realtime JSON
  /trips      trip updates, GTFS-realtime protobuf

Upstream is data.texas.gov. This adds the CORS header its redirect omits and
caches ${EDGE_TTL}s at the edge. It changes nothing else about the payload.
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
      return new Response(`No feed called "${path}". Try /vehicles or /trips.`,
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

    let upstream;
    try {
      // redirect:'follow' is the default and is the entire point: the Worker
      // follows the 302 the browser refuses to, because CORS is a browser
      // rule and does not apply here.
      upstream = await fetch(feed.url, {
        redirect: 'follow',
        headers: { 'user-agent': 'jessestrait.com/atx map relay' },
      });
    } catch (e) {
      return new Response(`Upstream unreachable: ${e}`, {
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
        'cache-control': `public, max-age=${EDGE_TTL}`,
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
