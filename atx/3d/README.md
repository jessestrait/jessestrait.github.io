# Austin, from above

The same live Austin as `/atx/`, over a city built from OpenStreetMap
building heights.

## Flat and 3D are one map

This is the whole design, and it is why there was nothing to "combine".
In MapLibre the flat map **is** this map at pitch 0 with the buildings
hidden — same camera, same layers, same data, same URL state. The tilt is
a slider, not a mode. Drag it to zero and you have the plan view; drag it
up and the city stands.

The layer list is a registry in `layers.js`: each layer declares where its
data comes from, what shape it is and what colour, and `app.js` turns the
whole list into a map in one generic pass. MapLibre does hit-testing,
culling and data-driven styling itself, which is why this is a few hundred
lines where `/atx/index.html` needs nine thousand to do the same job on a
canvas it drives by hand.

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
