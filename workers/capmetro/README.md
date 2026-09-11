# capmetro

A one-hop relay that makes CapMetro's GTFS-realtime feed readable from a
browser. ~2,900 requests a day for a single reader; the free plan allows
100,000.

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

| path        | upstream        | format   |
|-------------|-----------------|----------|
| `/vehicles` | `cuc7-ywmd`     | GTFS-RT JSON |
| `/trips`    | `rmk2-acnw`     | GTFS-RT protobuf |

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
