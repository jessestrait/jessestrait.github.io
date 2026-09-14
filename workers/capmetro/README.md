# capmetro

A one-hop relay for the Austin feeds a browser cannot read itself. Named for
the first one. ~2,900 requests a day for a single reader on the busiest
route; the free plan allows 100,000.

```
npx wrangler deploy
```

Then point the map at the deployed URL:

```
https://capmetro.<your-subdomain>.workers.dev/vehicles
```

## Why it is needed

Everything else on the ATX map is fetched straight from the page. This is the
one feed that cannot be, and the reason is narrow:

`data.texas.gov/download/<id>/...` answers **302** and points at a blob under
`/api/views/<id>/files/<uuid>`. The blob sends `access-control-allow-origin: *`.
The **redirect does not**, and a CORS request is checked at every hop, so the
browser kills the chain before reaching the file.

`curl` follows it happily, which makes this very easy to believe works when it
does not. From a page you get `TypeError: Failed to fetch`.

Pinning the blob uuid is not a way out — it rotates on every publish:

```
bc61af5f-…    (t)
af2dcee4-…    (t + 25 min)
21f67c11-…    (t + 25 min, ten seconds later — and different bytes)
```

The pointer is the only way to the current file, and the pointer is exactly
what the browser will not follow.

## Routes

| path        | upstream                   | why it needs a relay |
|-------------|----------------------------|----------------------|
| `/vehicles` | data.texas.gov `cuc7-ywmd` | redirect drops the CORS header |
| `/trips`    | data.texas.gov `rmk2-acnw` | same |
| `/aircraft` | opendata.adsb.fi, 40 nm    | no CORS header at all |
| `/faa`      | nasstatus.faa.gov          | no CORS header at all |
| `/lcra`     | hydromet.lcra.org          | CORS header names *someone else's* origin |

The LCRA case is the instructive one. It does send
`access-control-allow-origin` — set to `https://www.lcra.org`. That is worse
than sending nothing: the browser reads the header, sees an origin that is not
yours, and refuses. A Worker is not a browser and the rule does not apply to
it.

`/vehicles` is the JSON feed rather than the protobuf one (`eiei-9rpf`).
Raw, JSON is 75 KB against 21 KB — but gzipped it is **9 KB against 8 KB**,
because protobuf is already compact and compresses poorly while JSON repeats
itself enormously. A kilobyte is a fair price for not shipping a protobuf
decoder.

## What it deliberately does not do

Parse, reshape, filter, or enrich. A proxy that transforms is a proxy you have
to keep in step with the upstream schema. This one should still work untouched
in five years.

## Observed

- 316 vehicles, 116 of them on a route at the time of writing
- Feed republishes roughly every 30 seconds (measured 28s old on a live fetch)
- Edge cache is 15s — **but the Cache API does nothing on a `*.workers.dev`
  subdomain**, which is where `wrangler deploy` puts you by default. Until
  this sits on a custom domain the `cache-control: public, max-age=15` header
  is what limits repeat fetching, and the upstream sees one request per poll.
  Fine at this traffic; worth a route on a real domain if it ever is not.

## `/aircraft` does not currently work, and probably cannot here

Both community ADS-B feeds refuse Cloudflare:

```
api.adsb.lol      -> 429
opendata.adsb.fi  -> 403
```

Neither is a fault and neither is about this Worker. Both answer a laptop
immediately — adsb.fi returned 200 from a home connection seconds before
returning 403 to the relay. Workers share a pool of egress addresses across
every Worker on the platform, so from the feeds' side that address has
already made enormous numbers of requests today, and rate-limiting or
blocking it is exactly how a volunteer-run feed protects itself from
scraping. Retrying, backing off, or adding headers does not change what they
see.

Three things would unblock it, none of them code:

- **Ask.** airplanes.live grants API access to hobby projects that email
  `contact@airplanes.live` describing the use. That is the intended path and
  the cheapest one.
- **Run the relay somewhere with its own address** — any small VPS. The
  feeds have no objection to the traffic, only to where it appears from.
- **OpenSky** allows anonymous use, but the limit is roughly 400 requests a
  day against a shared address, which a live map exhausts almost at once.

The route is kept, with the fallback chain, so that it starts working the
moment any of those is true.
