# Austin, from above

A 3D companion to the flat map at `/atx/`. Same city, same live feeds,
pitched over and lit like a model.

## What is real and what is not

| | |
|---|---|
| **real** | Every building footprint and every height OpenStreetMap carries — 500,272 buildings in this bounding box, 361,326 with an explicit `building:levels` or `height`. |
| **real** | Every bus. Position, route and heading from CapMetro's feed through this site's relay, the same one `/atx/` reads. |
| **guessed** | The height of a building OSM does not tag. A plausible skyline, not a surveyed one. |
| **guessed** | Every car. Spawned onto real road geometry pulled from the vector tiles and driven along it. Nothing about their number, speed or position is real traffic — a model city with empty streets reads as abandoned rather than calm. |

That division is the point. The flat map never guesses; this one guesses
only about things nobody would mistake for data, and says so on the page.

## The basemap

`austin.pmtiles` — 43 MB, the Austin metro at z0–15, extracted from the
Protomaps planet build:

```
pmtiles extract https://build.protomaps.com/YYYYMMDD.pmtiles austin.pmtiles \
  --bbox=-97.95,30.10,-97.55,30.52 --maxzoom=15
```

Eight seconds, 49 HTTP requests, no planet download. It is one file served
over HTTP range requests, so a phone fetches the handful of tiles in view
rather than the archive. GitHub Pages answers `206` with
`accept-ranges: bytes` — verified.

Rebuild it when OSM has moved on enough to matter; nothing here depends on
it being fresh.

## Running it locally

**Not** with `python3 -m http.server`. It ignores `Range` and returns 200
with the whole 43 MB, so the pmtiles protocol fails with *"content-length
exceeding request"* — a message that sounds like a corrupt archive when the
archive is fine.

```
python3 tools/serve_range.py 8777
```

Then <http://localhost:8777/atx/3d/>.

## Two things that fail silently

- **The fontstack is `Noto Sans Regular`**, with spaces. Every hyphenated
  spelling 404s, and a bad `glyphs` URL does not raise — it drops every
  text layer without a word.
- **Buildings only exist at z15** in the Protomaps basemap; z0–14 carries
  merged blobs. The extrusion layer is `minzoom: 13` and fades height in
  from 13 to 14.2 so the city rises as you come down rather than popping.
