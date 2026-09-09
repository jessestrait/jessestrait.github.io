#!/usr/bin/env python3
"""Build atx/data/gazetteer.json — the place names a local headline might use,
each with a coordinate, so the news ticker can tell which headlines are about
what you are currently looking at.

The coordinates are not geocoded from anywhere: they come out of the map's own
prebuilt files. Street centroids from streets.json, districts from
districts.json, ZIP centroids from zips.json. Only a handful of highways and
landmarks that the street layer does not name are pinned by hand.

Precision beats recall here. There are 8,507 distinct street names in Austin and
5,066 of them are single common words — matching "Village" or "Mesa" or "Quail"
against a headline would light up the ticker constantly and mean nothing. So the
street half of this is a curated list of names that actually appear in local
news, and everything else has to arrive with a street-type suffix attached.

    python3 tools/build_atx_gazetteer.py
"""
import json, os, re, collections

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(HERE, 'atx', 'data')

# Roads and corridors that turn up in Austin headlines. The value is the
# substring to look for in the street layer's own names.
ROADS = {
    'Rundberg': 'RUNDBERG', 'Slaughter': 'SLAUGHTER LN', 'William Cannon': 'WILLIAM CANNON',
    'Lamar': 'LAMAR', 'Congress': 'CONGRESS AVE', 'Riverside': 'RIVERSIDE DR',
    'Burnet Road': 'BURNET RD', 'Guadalupe': 'GUADALUPE ST', 'Airport Boulevard': 'AIRPORT BLVD',
    'Manor Road': 'MANOR RD', 'Braker': 'BRAKER LN', 'Parmer': 'PARMER LN',
    'Cesar Chavez': 'CESAR CHAVEZ ST', 'Barton Springs': 'BARTON SPRINGS RD',
    'Oltorf': 'OLTORF ST', 'Martin Luther King': 'MARTIN LUTHER KING BLVD',
    'Anderson Lane': 'ANDERSON LN', 'Duval': 'DUVAL ST', 'Cameron Road': 'CAMERON RD',
    'Pleasant Valley': 'PLEASANT VALLEY RD', 'Stassney': 'STASSNEY LN',
    'Metric': 'METRIC BLVD', 'Howard Lane': 'HOWARD LN', 'Tech Ridge': 'TECH RIDGE',
    'Koenig': 'KOENIG LN', 'Dessau': 'DESSAU RD', 'Springdale': 'SPRINGDALE RD',
    'Berkman': 'BERKMAN DR', 'Cameron': 'CAMERON RD', 'Wells Branch': 'WELLS BRANCH',
    'Jollyville': 'JOLLYVILLE RD', 'Spicewood Springs': 'SPICEWOOD SPRINGS',
    'Bee Caves': 'BEE CAVE', 'Menchaca': 'MANCHACA RD', 'Manchaca': 'MANCHACA RD',
    'Ed Bluestein': 'ED BLUESTEIN', 'Decker': 'DECKER LAKE RD', 'Cesar Chavez Street': 'CESAR CHAVEZ ST',
}

# Things the street layer does not carry under a usable name.
PINNED = {
    'I-35': (30.2672, -97.7278), 'IH-35': (30.2672, -97.7278), 'Interstate 35': (30.2672, -97.7278),
    'MoPac': (30.3100, -97.7620), 'Loop 1': (30.3100, -97.7620),
    'US 183': (30.3500, -97.7050), 'Highway 183': (30.3500, -97.7050), 'Research Boulevard': (30.3830, -97.7300),
    'Ben White': (30.2270, -97.7690), 'Highway 71': (30.2270, -97.7690), 'SH 71': (30.2270, -97.7690),
    'Loop 360': (30.3300, -97.8130), 'Capital of Texas Highway': (30.3300, -97.8130),
    'South First': (30.2450, -97.7550), 'South Congress': (30.2480, -97.7500), 'SoCo': (30.2480, -97.7500),
    'Sixth Street': (30.2670, -97.7400), '6th Street': (30.2670, -97.7400),
    'Rainey Street': (30.2590, -97.7390), 'East Austin': (30.2640, -97.7130),
    'South Austin': (30.2200, -97.7700), 'North Austin': (30.3800, -97.7100),
    'Downtown': (30.2670, -97.7430), 'Zilker': (30.2670, -97.7720), 'Barton Creek': (30.2440, -97.8000),
    'Hyde Park': (30.3050, -97.7290), 'Mueller': (30.2990, -97.7050), 'The Domain': (30.4010, -97.7250),
    'Domain': (30.4010, -97.7250), 'Crestview': (30.3400, -97.7250), 'Clarksville': (30.2790, -97.7580),
    'Travis Heights': (30.2470, -97.7420), 'Bouldin': (30.2510, -97.7570), 'Rosewood': (30.2700, -97.7150),
    'Montopolis': (30.2350, -97.7000), 'Del Valle': (30.1830, -97.6100), 'Onion Creek': (30.1600, -97.7600),
    'Circle C': (30.2000, -97.8800), 'Oak Hill': (30.2350, -97.8600), 'Dove Springs': (30.1900, -97.7400),
    'Windsor Park': (30.3100, -97.6950), 'Allandale': (30.3450, -97.7420), 'Tarrytown': (30.2960, -97.7690),
    'Lady Bird Lake': (30.2560, -97.7420), 'Lake Travis': (30.4000, -97.9300), 'Lake Austin': (30.3200, -97.8000),
    'Barton Springs Pool': (30.2640, -97.7710), 'Zilker Park': (30.2670, -97.7720),
    'Q2 Stadium': (30.3880, -97.7190), 'Moody Center': (30.2830, -97.7320),
    'Darrell K Royal': (30.2837, -97.7325), 'UT Austin': (30.2849, -97.7341),
    'University of Texas': (30.2849, -97.7341), 'the Capitol': (30.2747, -97.7404),
    'Texas Capitol': (30.2747, -97.7404), 'ABIA': (30.1975, -97.6664),
    'Austin-Bergstrom': (30.1975, -97.6664), 'Bergstrom': (30.1975, -97.6664),
    'Pflugerville': (30.4390, -97.6200), 'Round Rock': (30.5080, -97.6790),
    'Cedar Park': (30.5050, -97.8200), 'Leander': (30.5790, -97.8530), 'Buda': (30.0850, -97.8400),
    'Kyle': (29.9890, -97.8770), 'Manor': (30.3400, -97.5570), 'Lakeway': (30.3630, -97.9800),
    'Elgin': (30.3500, -97.3700), 'Bastrop': (30.1100, -97.3150), 'San Marcos': (29.8830, -97.9410),
    'Georgetown': (30.6330, -97.6770), 'Hutto': (30.5430, -97.5470), 'Sunset Valley': (30.2380, -97.8150),
    'West Lake Hills': (30.2940, -97.8020), 'Rollingwood': (30.2740, -97.7880),
}


# ── Curated additions, 2026-09-09 ──────────────────────────────────
# Chosen by reading the headlines the gazetteer was missing, then checked
# against the same corpus for false positives before being kept. The rule is
# unchanged: a term earns its place only if a headline containing it is
# genuinely about that spot. Ambiguous single words are deliberately absent —
# Austin has streets called September, Trophy, Bender and Dallas, and matching
# them would pin a Dallas convention to a residential street here.
PINNED.update({
    # Water and dams — a whole class the street layer cannot name.
    'Longhorn Dam': (30.2470, -97.7130), 'Lady Bird Lake Dam': (30.2470, -97.7130),
    'Lake Buchanan': (30.7500, -98.4200), 'Mansfield Dam': (30.3930, -97.9080),
    'Lake Walter E. Long': (30.2830, -97.5900), 'Decker Lake': (30.2830, -97.5900),
    'Shoal Creek': (30.2900, -97.7500), 'Waller Creek': (30.2690, -97.7350),
    'Bull Creek': (30.3720, -97.7860), 'Walnut Creek': (30.3620, -97.6800),
    'Boggy Creek': (30.2600, -97.6900), 'Williamson Creek': (30.2200, -97.8000),
    'Colorado River': (30.2450, -97.6900), 'McKinney Falls': (30.1830, -97.7220),

    # Downtown, named the way headlines name it.
    'Red River Cultural District': (30.2680, -97.7360), 'Red River Street': (30.2680, -97.7360),
    'Waterloo Greenway': (30.2720, -97.7340), 'Waterloo Park': (30.2760, -97.7330),
    'Republic Square': (30.2680, -97.7470), 'Auditorium Shores': (30.2600, -97.7500),
    'Palmer Events Center': (30.2570, -97.7550),
    'Austin Convention Center': (30.2630, -97.7400),
    'Dirty Sixth': (30.2670, -97.7400), 'West Sixth': (30.2700, -97.7500),

    # Quadrants. Only ever matched with "Austin" attached, so they cannot
    # collide with a compass direction in an unrelated headline.
    'Northwest Austin': (30.4200, -97.7700), 'Northeast Austin': (30.3600, -97.6600),
    'Southeast Austin': (30.2100, -97.7000), 'Southwest Austin': (30.2200, -97.8600),
    'Central Austin': (30.2950, -97.7420), 'West Austin': (30.2900, -97.7800),

    # Neighbourhoods and subdivisions that turn up by name.
    'Presidential Meadows': (30.3320, -97.5760), 'Govalle': (30.2570, -97.6980),
    'Holly Neighborhood': (30.2530, -97.7230), 'Cherrywood': (30.2920, -97.7150),
    'North Loop': (30.3200, -97.7220), 'Brentwood': (30.3400, -97.7350),
    'Rosedale': (30.3170, -97.7420), 'Barton Hills': (30.2560, -97.7830),
    'Steiner Ranch': (30.3660, -97.9130), 'Anderson Mill': (30.4500, -97.8100),
    'Georgian Acres': (30.3600, -97.7000), 'Highland Mall': (30.3270, -97.7080),
    'Riverside Drive': (30.2420, -97.7200), 

    # Institutions and venues.
    'Circuit of the Americas': (30.1330, -97.6410), 'COTA': (30.1330, -97.6410),
    'Dell Diamond': (30.5230, -97.6320), 'Austin airport': (30.1975, -97.6664),
    'Dell Seton': (30.2760, -97.7370), 'Dell Children': (30.3010, -97.7060),
    'Austin Community College': (30.3270, -97.7080), 'St. Edward': (30.2280, -97.7560),
    'Huston-Tillotson': (30.2650, -97.7220), 

    # Places outside the map that local outlets still cover. Pinning them is
    # honest: the chip says San Saba, and pressing it shows you it is nowhere
    # near Austin, which is the useful fact.
    'Travis County': (30.3200, -97.7700), 'Williamson County': (30.6500, -97.6000),
    'Hays County': (30.0500, -98.0300), 'Bastrop County': (30.1030, -97.3120),
    'San Saba': (31.1930, -98.7200), 'Llano': (30.7590, -98.6750),
    'Marble Falls': (30.5780, -98.2730), 'Dripping Springs': (30.1900, -98.0870),
    'Wimberley': (29.9970, -98.0980), 'Liberty Hill': (30.6650, -97.9220),
 'Lago Vista': (30.4520, -97.9890),
    'Jonestown': (30.4930, -97.9200), 'Webberville': (30.2820, -97.5030),
    'Taylor, TX': (30.5710, -97.4090),
    'Creedmoor': (30.0900, -97.7100), 'Mustang Ridge': (30.0770, -97.6540),
})


def centroids_from_streets():
    with open(os.path.join(DATA, 'streets.json')) as f:
        gj = json.load(f)
    pts = collections.defaultdict(list)
    for feat in gj['features']:
        n = (feat['properties'].get('n') or '').strip().upper()
        if not n:
            continue
        for x, y in feat['geometry']['coordinates']:
            pts[n].append((x, y))
    out = {}
    for label, needle in ROADS.items():
        xs, ys = [], []
        for n, coords in pts.items():
            if needle in n:
                for x, y in coords:
                    xs.append(x); ys.append(y)
        if xs:
            out[label] = (round(sum(ys) / len(ys), 5), round(sum(xs) / len(xs), 5))
        else:
            print('  ! no street match for', label, '(' + needle + ')')
    return out


def centroid_of(gj, prop, fmt=str):
    out = {}
    for feat in gj['features']:
        key = feat['properties'].get(prop)
        if key is None:
            continue
        xs, ys = [], []
        def walk(c):
            if isinstance(c[0], (int, float)):
                xs.append(c[0]); ys.append(c[1])
            else:
                for k in c: walk(k)
        walk(feat['geometry']['coordinates'])
        if xs:
            out[fmt(key)] = (round(sum(ys) / len(ys), 5), round(sum(xs) / len(xs), 5))
    return out


if __name__ == '__main__':
    places = {}
    places.update({k: list(v) for k, v in centroids_from_streets().items()})
    places.update({k: list(v) for k, v in PINNED.items()})

    with open(os.path.join(DATA, 'zips.json')) as f:
        for z, c in centroid_of(json.load(f), 'zip').items():
            places[z] = list(c)

    with open(os.path.join(DATA, 'districts.json')) as f:
        dj = json.load(f)
    key = next((k for k in dj['features'][0]['properties']
                if 'district' in k.lower() or k in ('d', 'id')), None)
    if key:
        for d, c in centroid_of(dj, key).items():
            d = str(d).strip()
            if d.isdigit():
                places['District ' + d] = list(c)

    path = os.path.join(DATA, 'gazetteer.json')
    with open(path, 'w') as f:
        json.dump(places, f, separators=(',', ':'), sort_keys=True)
    print('gazetteer.json  %d places  %.0f KB' % (len(places), os.path.getsize(path) / 1024))
