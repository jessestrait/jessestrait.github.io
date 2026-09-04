"""Prebuild the GeoHub-derived geography files for atx/data/.

Everything here is fetched once at build time, simplified server-side by
ArcGIS (maxAllowableOffset) and rounded, so the page ships small static
files instead of hammering the FeatureServer on every load.
"""
import json, urllib.request, urllib.parse, os

ARC = "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services"
OUT = "/Users/jessestrait/dev/jessestrait.github.io/atx/data"

def query(service, layer=0, **kw):
    params = {
        "where": "1=1", "outSR": "4326", "f": "geojson",
        "geometryPrecision": "5", "returnGeometry": "true",
    }
    params.update(kw)
    url = f"{ARC}/{service}/FeatureServer/{layer}/query?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=180) as r:
        return json.load(r)

def paged(service, layer=0, page=1000, **kw):
    feats, off = [], 0
    while True:
        d = query(service, layer, resultOffset=off, resultRecordCount=page, **kw)
        f = d.get("features", [])
        feats += f
        if len(f) < page or d.get("exceededTransferLimit") is False and len(f) < page:
            break
        off += page
        if off > 20000:
            break
    return feats

def size(path):
    return f"{os.path.getsize(path)/1024:.0f} KB"

# ── 1. Block groups: geometry + population + canopy + heat ────────────
FIELDS = "GEOID,cbg_pop,acs_pop,treecanopy,tc_gap,pctpov,temp_diff,tes,land_area,pctpoc,unemplrate"
bg = query("tree_equity_score_austin", outFields=FIELDS,
           maxAllowableOffset="0.00025", resultRecordCount=2000)
feats = []
for f in bg["features"]:
    a = f["properties"]
    geoid = a.get("GEOID") or ""
    pop = a.get("cbg_pop")
    if not f.get("geometry") or not geoid:
        continue
    pct = lambda v: None if v is None else round(v * 100, 1)
    area = a.get("land_area")
    props = {
        # APD publishes the block group without the state prefix; store the
        # short key so the crime join is a plain lookup.
        "k": geoid[2:],
        "pop": None if pop is None else int(round(pop)),
        "canopy": pct(a.get("treecanopy")),
        "gap": pct(a.get("tc_gap")),
        "pov": pct(a.get("pctpov")),
        "poc": pct(a.get("pctpoc")),
        "unemp": pct(a.get("unemplrate")),
        "temp": None if a.get("temp_diff") is None else round(a["temp_diff"], 1),
        "tes": None if a.get("tes") is None else round(a["tes"]),
        "area": None if area is None else round(area, 3),
    }
    if props["pop"] and area:
        props["density"] = round(props["pop"] / area)
    feats.append({"type": "Feature", "properties": props, "geometry": f["geometry"]})

json.dump({"type": "FeatureCollection",
           "source": "American Forests Tree Equity Score via Austin GeoHub (tree_equity_score_austin)",
           "features": feats},
          open(f"{OUT}/blockgroups.json", "w"), separators=(",", ":"))
print("block groups:", len(feats), size(f"{OUT}/blockgroups.json"))

# ── 2. Parks ──────────────────────────────────────────────────────────
pk = query("BOUNDARIES_city_of_austin_parks",
           outFields="LOCATION_NAME,PARK_TYPE,ASSET_SIZE,ADDRESS,COUNCIL_DISTRICT",
           maxAllowableOffset="0.00015", resultRecordCount=2000)
pfeats = []
for f in pk["features"]:
    a = f["properties"]
    if not f.get("geometry"):
        continue
    pfeats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
        "n": a.get("LOCATION_NAME"), "t": a.get("PARK_TYPE"),
        "ac": None if a.get("ASSET_SIZE") is None else round(a["ASSET_SIZE"], 1),
        "ad": a.get("ADDRESS"), "d": a.get("COUNCIL_DISTRICT"),
    }})
json.dump({"type": "FeatureCollection", "features": pfeats},
          open(f"{OUT}/parks.json", "w"), separators=(",", ":"))
print("parks:", len(pfeats), size(f"{OUT}/parks.json"))

# ── 3. Trails ─────────────────────────────────────────────────────────
tr = paged("pard_trails_nrpa", outFields="TRAIL_SYSTEM_NAME,ASSET_NAME,PARK_NAME,ASSET_SURFACE,ASSET_SIZE,HIKE,ROAD_BIKE,MOUNTAIN_BIKE",
           maxAllowableOffset="0.00002")
tfeats = []
for f in tr:
    a = f["properties"]
    if not f.get("geometry"):
        continue
    tfeats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
        "n": a.get("TRAIL_SYSTEM_NAME") or a.get("ASSET_NAME"),
        "p": a.get("PARK_NAME"), "s": a.get("ASSET_SURFACE"),
        "mi": None if a.get("ASSET_SIZE") is None else round(a["ASSET_SIZE"], 2),
        "bike": a.get("ROAD_BIKE") or a.get("MOUNTAIN_BIKE"),
    }})
json.dump({"type": "FeatureCollection", "features": tfeats},
          open(f"{OUT}/trails.json", "w"), separators=(",", ":"))
print("trails:", len(tfeats), size(f"{OUT}/trails.json"))


# ── 4. Floodplain: 100-year zone only, slivers dropped ────────────────
fp, off = [], 0
while True:
    d = query("INLANDWATERS_austin_full_develop_floodplain",
              where="FLOOD_ZONE LIKE '%100-Year%'", outFields="FLOOD_ZONE",
              geometryPrecision="4", maxAllowableOffset="0.0008",
              resultOffset=off, resultRecordCount=2000)
    f = d.get("features", [])
    fp += f
    if len(f) < 2000:
        break
    off += 2000

def span(g):
    xs, ys = [], []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for x in c:
                walk(x)
    walk(g["coordinates"])
    return max(max(xs) - min(xs), max(ys) - min(ys)) if xs else 0

# Anything smaller than ~130m adds nothing at city zoom and costs a lot of bytes.
kept = [{"type": "Feature", "geometry": f["geometry"], "properties": {}}
        for f in fp if f.get("geometry") and span(f["geometry"]) > 0.0012]
json.dump({"type": "FeatureCollection", "features": kept},
          open(f"{OUT}/floodplain.json", "w"), separators=(",", ":"))
print("floodplain:", len(fp), "fetched,", len(kept), "kept", size(f"{OUT}/floodplain.json"))


# ── 5. Street condition ───────────────────────────────────────────────
# 28k graded segments. The drawable layer is heavy and loads on demand, but
# the interesting question — are the worst streets in the poorest places? —
# is a join, so it is computed here and baked onto the geography files.
GRADE_PTS = {"A": 4, "B": 3, "C": 2, "D": 1, "F": 0}

st, off = [], 0
while True:
    d = query("TRANSPORTATION_pw_street_condition_scores", where="GRADE <> ' '",
              outFields="FULL_STREET_NAME,GRADE,INTL_ROUGHNESS_INDEX_AVG",
              geometryPrecision="4", maxAllowableOffset="0.0002",
              resultOffset=off, resultRecordCount=2000)
    f = d.get("features", [])
    st += f
    if len(f) < 2000:
        break
    off += 2000

streets = []
for f in st:
    a, g = f["properties"], f.get("geometry")
    if not g:
        continue
    iri = a.get("INTL_ROUGHNESS_INDEX_AVG")
    streets.append({"type": "Feature", "geometry": g, "properties": {
        "n": a.get("FULL_STREET_NAME"), "g": a.get("GRADE"),
        "i": None if iri is None else int(iri)}})

json.dump({"type": "FeatureCollection", "features": streets},
          open(f"{OUT}/streets.json", "w"), separators=(",", ":"))
print("streets:", len(streets), size(f"{OUT}/streets.json"))

# ── join segment midpoints onto each geography ────────────────────────
def midpoint(geom):
    c = geom["coordinates"]
    line = c[len(c) // 2] if geom["type"] == "MultiLineString" else c
    if not line:
        return None
    return line[len(line) // 2]

def ring_contains(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

def feature_contains(feat, pt):
    g = feat["geometry"]
    polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
    for poly in polys:
        if ring_contains(pt, poly[0]) and not any(ring_contains(pt, h) for h in poly[1:]):
            return True
    return False

def bbox(feat):
    xs, ys = [], []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for x in c:
                walk(x)
    walk(feat["geometry"]["coordinates"])
    return min(xs), max(xs), min(ys), max(ys)

def join_streets(path, keyfield):
    fc = json.load(open(path))
    boxes = [bbox(f) for f in fc["features"]]
    acc = {i: {"n": 0, "iri": 0, "bad": 0} for i in range(len(fc["features"]))}
    for s in streets:
        pt = midpoint(s["geometry"])
        if not pt:
            continue
        for i, f in enumerate(fc["features"]):
            b = boxes[i]
            if not (b[0] <= pt[0] <= b[1] and b[2] <= pt[1] <= b[3]):
                continue
            if feature_contains(f, pt):
                a = acc[i]
                a["n"] += 1
                if s["properties"]["i"]:
                    a["iri"] += s["properties"]["i"]
                if s["properties"]["g"] in ("D", "F"):
                    a["bad"] += 1
                break
    hit = 0
    for i, f in enumerate(fc["features"]):
        a = acc[i]
        if a["n"]:
            hit += 1
            f["properties"]["street_n"] = a["n"]
            f["properties"]["street_iri"] = round(a["iri"] / a["n"])
            f["properties"]["street_bad"] = round(a["bad"] / a["n"] * 100, 1)
    json.dump(fc, open(path, "w"), separators=(",", ":"))
    print(f"  joined into {os.path.basename(path)}: {hit}/{len(fc['features'])} units, {size(path)}")

join_streets(f"{OUT}/blockgroups.json", "k")
join_streets(f"{OUT}/districts.json", "d")
