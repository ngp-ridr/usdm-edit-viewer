# `vendor/aoi/` — provenance

Areas of interest an author can scope editing to. Three kinds ship (`county`
was a fourth until 2026-09 — retired with the switch to the FSA LFP dataset,
whose county polygons the map reads as PMTiles, display only):

| kind      | label                      | geometry file             | features |
| --------- | -------------------------- | ------------------------- | -------- |
| `state`   | State                      | `vendor/aoi/states.json`  | 52 |
| `aiannh`  | Tribal Areas               | `vendor/aoi/aiannh.json`  | 867 |
| `climdiv` | Climate Division (CONUS)   | `vendor/aoi/climdiv.json` | 344 |

`js/aois.js` (generated) is the boot-loaded index of keys, names and labels —
no geometry, no bounding boxes. `vendor/aoi/neighbors.json` (generated) is the
same-kind adjacency table. Both come out of
[`tools/build-aois.mjs`](../../tools/build-aois.mjs); see that file's header for
the pipeline and the reasoning.

All coordinates are **true WGS84**, and that is the whole reason these files
exist rather than being read from the fleet's usual boundary TopoJSON: that one
is a shifted composite that parks Alaska off the Californian coast, and the USDM
publishes Alaska in Alaska. Nothing here is a composite. 146 of the 867 tribal
areas reach north of 60°N, which is the assertion `tools/build-aois.mjs` makes to
prove it.

---

## `aiannh.json` — American Indian / Alaska Native / Native Hawaiian areas

**Origin.** US Census Bureau TIGER/Line 2025, American Indian / Alaska Native /
Native Hawaiian Areas — <https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html>.

**Immediate source.** Not read from Census directly. Read from the dissolved
GeoParquet that the sibling project publishes, so that an AOI chosen here and a
drought figure quoted from that project refer to the same ground:

    ~/git/native-resilience/usdm-aiannh/census-aiannh-2025.parquet
    sha256  aa43964db4e08e438923c6ddc934c3963c3236c40c3e10e78af81d55b20363d0
    12,275,024 bytes · 867 rows · retrieved 2026-01-29 · read 2026-08-26

    repo   https://github.com/sustainable-fsa/usdm-aiannh  (native-resilience/usdm-aiannh)

That file is EPSG:4326, ZSTD-compressed, and carries **GeoArrow-native**
geometry — a `List<List<List<Struct{x,y}>>>` column, not WKB. `build-aois.mjs`
reads it with the app's own vendored `hyparquet` and the codec table from
`js/archive.js`, the pattern `tools/topology.test.mjs` established.

**Fields used.** `GNIS`, `LSAD`, `NameLSAD`. `Name` and `Area` are read for
checking and not carried into the output.

### Key: `GNIS-LSAD`, not `GNIS`

GNIS is **not unique** in this file. 163 of the 867 rows share a GNIS with one
other row, because a nation's Reservation and its Off-Reservation Trust Land are
the same named entity in two legal statuses — `00023763-86` "Tohono O'odham
Nation Reservation" and `00023763-OT` "Tohono O'odham Nation Off-Reservation
Trust Land" are one GNIS and two areas. The upstream repo groups by
`(GNIS, Name, NameLSAD, LSAD)` for exactly this reason. `GNIS + '-' + LSAD` is
unique across all 867 rows and is the key used here and in the URL.

### LSAD policy: keep everything

`AIANNH_LSAD_KEEP` in `tools/build-aois.mjs` is `null`, meaning **no LSAD
filter — all 867 features ship**. The alternative considered was keeping only
federal reservations (LSAD `86`, 205 features) and dropping the statistical
areas (`OT` trust land, `79` OTSAs, `80`–`85` SDTSAs/rancherias, `92` ANVSAs,
`78` Hawaiian home lands, …). It was rejected: the sibling `usdm-aiannh` product
reports drought for all 867, and a picker offering a subset would silently
disagree with the numbers people already cite. The knob remains, documented, if
that judgement ever changes.

LSAD values present, for reference:

    78 ×74   79 ×221  80 ×7   81 ×6   82 ×8   83 ×3   84 ×16  85 ×46
    86 ×205  87 ×1    88 ×25  89 ×12  90 ×4   91 ×1   92 ×35  93 ×1
    94 ×2    95 ×3    96 ×19  97 ×5   98 ×5   99 ×1   9C ×1   9D ×1
    OT ×163  00 ×2

`00` is not a typo: "Qualla Boundary" and "Ohkay Owingeh" carry no LSAD in
TIGER 2025.

### License

Public domain. US Census Bureau TIGER/Line products are US Government works and
carry no copyright (17 U.S.C. § 105).

---

## `climdiv.json` — NOAA/NCEI climate divisions (CONUS only)

**Origin.** NOAA National Centers for Environmental Information, Divisional data
— `CONUS_CLIMATE_DIVISIONS.shp.zip`,
<https://www.ncei.noaa.gov/pub/data/cirs/climdiv/>. DOI
[10.7289/V5M32STR](https://doi.org/10.7289/V5M32STR) (Vose et al., *NOAA
Monthly U.S. Climate Divisional Database (NClimDiv)*).

**Immediate source.** A local copy carried by a sibling project:

    ~/git/mt-climate-office/mcor.data/data-raw/CONUS_CLIMATE_DIVISIONS/
      GIS.OFFICIAL_CLIM_DIVISIONS.shp  50,742,532 bytes
        sha256  3562c5c346573cdd44222bb5191feb6e6a88337ed6c1a6b3cf0d7e7b9689c6cb
      GIS.OFFICIAL_CLIM_DIVISIONS.dbf  sha256  5748d451a244cdc8d14de359f39eb92493994addf2f6f91d7749c056133354e2
      GIS.OFFICIAL_CLIM_DIVISIONS.shx  sha256  64ea91f749982fe664f3dfa2419c9a69c0b48e3c0d1fefee680faef44134b618
      GIS.OFFICIAL_CLIM_DIVISIONS.prj  sha256  dfac27b82619e9b93301c7c4b3fce5aba57e765ad1cb616c836457d2c2f198c1
      GIS.OFFICIAL_CLIM_DIVISIONS.cpg  sha256  9942747bdb5e6e2bd2cd515323b0d5a56451b317076eec5cfb4472c956209605
    344 features · dated 2026-02-04 · read 2026-08-26

**Projection.** The `.prj` reads `GEOGCS["Longitude / Latitude (NAD 83)"]`.
NAD83 and WGS84 agree to well under a metre at these latitudes, and the output
grid is ~49 m × 27 m, so the coordinates are used as-is with no datum shift.

**Encoding.** The `.cpg` reads `ANSI 1252`, so the DBF is decoded as
`windows-1252`, not UTF-8.

**Fields used.** `FIPS_CD` → key, `NAME` → name, `ST_ABBRV` → state.
`STATE`, `STATE_FIPS`, `CD_2DIG`, `CLIMDIV`, `NCDC_GEO_I` and the shape
measures are not carried.

### `FIPS_CD` is a string

Four characters, `/^\d{4}$/`, state code + division number — `3005` is Montana's
South Central division. It is read from the DBF as text and never passed through
`parseInt`, so a future division numbered `0107` keeps its leading zero. The
build asserts the four-digit shape on every feature.

### Names are title-cased at build time

The source publishes `NAME` in ALL CAPS. `build-aois.mjs` title-cases it, with
`N S E W NE NW SE SW` held uppercase so `NE OLYMPIC SAN JUAN` becomes
`NE Olympic San Juan` and not `Ne Olympic San Juan`. Names are **not unique** —
159 distinct names across 344 divisions, because most states have a "Central"
and a "Northeast" — which is why `aoiLabel('climdiv', …)` always appends the
state: `South Central (MT)`.

One name is truncated **in the source**, not here: `POWDER, LITTLE MISSOURI,
TONGU` (Wyoming, `4808`) is 30 characters of NCEI's own truncation of "Powder,
Little Missouri, Tongue Drainages". It is passed through as published.

### CONUS only

There are **no climate divisions for Alaska, Hawaii, DC or Puerto Rico** in this
product — 344 divisions across 48 states. A picker showing this kind has nothing
to offer someone working in Alaska, which is why the kind is labelled
"Climate Division (CONUS)" rather than "Climate Division".

### License

Public domain. NOAA/NCEI data are US Government works and carry no copyright
(17 U.S.C. § 105). Citation is requested, not required — the DOI above.

---

## `states.json` — FSA LFP state boundaries + nation outline

**Origin.** USDA Farm Service Agency, Livestock Forage Disaster Program
determination boundaries (FOIA 2025-FSA-08431-F) — the geodatabase FSA's LFP
determinations are computed against, whose coastline is NDMC's own, not the
Census waterline. Published by the sustainable-fsa archive.

**Immediate source.** The published counties TopoJSON, read directly (a URL, or
a local copy of the same bytes):

    https://data.sustainable-fsa.com/fsa-lfp-counties/fsa-lfp-counties.topojson
    sha256  5bd8a083d0ebcc23804b8fd93ee9e9975dbf32e60dcbaefa43d75439e4ae23ee
    7,329,511 bytes · objects `counties` (3,221) + `states` (52) · retrieved 2026-09-01

    repo   https://github.com/sustainable-fsa/data-tiles

Only `objects.states` is carried: the county polygons stay upstream, where the
app's map reads them as PMTiles (`fsa-lfp-counties-geo.pmtiles`, same origin) —
display only, no rings needed here.

### UNSIMPLIFIED, by construction

This file is a **verbatim arc copy**, not a re-encode: the 4,926 source arcs the
states reference are copied byte-for-byte (the source's own 1e7 quantization
grid and all) and only re-indexed. Nothing is decoded to floats and re-snapped —
a same-count fresh grid measurably collapsed 578 of 502,093 vertices, and even
re-using the source transform moved single points one cell through float
round-tripping. The build asserts, per state, that the output decodes to exactly
the source's distinct coordinate set: 498,470 distinct vertices, preserved
exactly.

### The `nation` object and the pinholes

`nation` is an arc-space dissolve of the 52 states (so it shares their arcs and
costs almost nothing), minus its holes: the source is the FOIA'd record, not
edge-matched — 491 sub-km² pinholes sit between neighbouring counties, and the
142 that survive state-level dissolution would draw as speckles on the nation
line. Every hole under `NATION_HOLE_MIN_KM2 = 1` km² is dropped; measured, that
is **all 142** — the states have no legitimate holes, so the threshold currently
distinguishes pinholes from nothing. All 2,834 shells (islands) stay.

### True WGS84, asserted

51,485 state vertices lie north of 60°N and 576 beyond ±179° (the Aleutian
antimeridian split). Both are build assertions: the same origin also publishes
the fleet's **shifted composite** (`fsa-counties-dd22.topojson`, Alaska parked
off California), and these assertions are what keep the two apart.

### License

Public domain. The boundaries are US Government works (USDA FSA / NDMC, released
under FOIA 2025-FSA-08431-F; ancestry US Census TIGER), 17 U.S.C. § 105.

---

## Territories

American Samoa, Guam, the Northern Mariana Islands and the US Virgin Islands are
absent from the `state` list, because the USDM publishes no polygons there and
an AOI over them would be an empty box. That is the `SKIP` set in
`tools/build-aois.mjs`, inherited from the bbox-only generator this replaced.
(The FSA LFP source carries no territories anyway — the FOIA'd records have
none — so `SKIP` is currently a belt over an absent risk.) DC and Puerto Rico
are present, because the USDM does cover them.

---

## Sizes

| file                        | bytes   |          |
| --------------------------- | ------- | -------- |
| `vendor/aoi/states.json`    | 4,588,157 | 4,480.6 KB |
| `vendor/aoi/aiannh.json`    | 654,737 | 639.4 KB |
| `vendor/aoi/climdiv.json`   | 392,356 | 383.2 KB |
| `vendor/aoi/neighbors.json` | 67,447  | 65.9 KB |
| `js/aois.js`                | 66,285  | 64.7 KB |
| **total payload**           | **5,768,982** | **5,633.8 KB** |

`states.json` is 40× the retired us-atlas states file (114,554 B at 1:10m) —
the deliberate price of UNSIMPLIFIED working-area boundaries; it is fetched
only when a state AOI or the reference lines need it, through js/aoi.js's
shared kind cache. `neighbors.json` and `js/aois.js` shrank by ~165 KB each
with the county kind's retirement.

The climate divisions do not fit the 250 KB that was hoped for and cannot: 344
polygons tiling CONUS need 8,684 arcs even after coordinates are snapped
together, the `objects` block that indexes them is 92 KB by itself, and an arc
costs about 20 bytes when simplified all the way down to its two endpoints. That
is a floor near 350 KB before a single interior vertex survives. Past a
Visvalingam weight of ~4e-7 the file stops shrinking and only the shapes get
worse, so the weight is pinned there.

### Generalization actually applied

Simplification is Visvalingam by spherical triangle area, then a 1e5 quantization
grid, then a repair pass that guarantees every ring is still a polygon enclosing
non-zero area (see the tool header). Total area is preserved:

| set     | source area   | shipped area  | delta   |
| ------- | ------------- | ------------- | ------- |
| aiannh  | 505,962 km²   | 505,647 km²   | −0.06 % |
| climdiv | 7,784,961 km² | 7,785,162 km² | ±0.00 % |

Per-feature error concentrates where you would expect. The worst climate
division is the Florida Keys (`1207`, −24 % of area, being a chain of islands);
the worst tribal areas are ~1 km² parcels that lose up to half their area
(Poarch Creek Reservation 1.1 → 0.2 km²) and 108 rings smaller than one grid
cell that ship as their one-cell footprint. These are selection targets whose
extents are computed at runtime, not measurement geometry; if that ever changes,
lower `AIANNH_SIMPLIFY_WEIGHT` and pay the bytes.

---

## Regeneration

**Phase A** — sources → `aiannh.json` + `climdiv.json` + `states.json`. Run by
hand, by someone who has the source files (`--states` needs only the network:
its canonical source is the published URL). Not run in CI.

```sh
node --max-old-space-size=12288 tools/build-aois.mjs \
  --aiannh  ~/git/native-resilience/usdm-aiannh/census-aiannh-2025.parquet \
  --climdiv ~/git/mt-climate-office/mcor.data/data-raw/CONUS_CLIMATE_DIVISIONS/GIS.OFFICIAL_CLIM_DIVISIONS.shp
node tools/build-aois.mjs --states     # or --states <local fsa-lfp-counties.topojson>
```

The climate-division shapefile is 50 MB and presimplification holds every vertex
in a heap, so the larger old-space is not optional.

**Phase B** — committed TopoJSON → `js/aois.js` + `neighbors.json`. Reads only
files in this repo, is byte-deterministic, and is gated in CI by
`.github/workflows/audit.yaml`:

```sh
node tools/build-aois.mjs
git diff --exit-code js/aois.js vendor/aoi/neighbors.json
```

Phase A does **not** run Phase B for you. After regenerating either vendor file,
run Phase B or the committed index goes stale against the geometry.

**Build dependencies** (`tools/package.json`, dev only — none of this reaches
the browser): `topojson-server`, `topojson-simplify`, `topojson-client`,
`shapefile`, `@turf/boolean-intersects` (the cross-kind adjacency test).
