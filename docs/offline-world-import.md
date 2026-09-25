# Import regional OpenStreetMap data without Overpass

`tools/bulk-import-world.ts` turns a local OSM snapshot into the same packed recipe
consumed by the game and the world chunk baker. This is an actual local ingestion
path: Python streams XML into a disk-backed SQLite index, selects complete nearby
features, and injects the resulting OSM objects into `compileRecipe`. It never
calls Overpass. Source identity and ODbL attribution accompany the output.

## Requirements

- Node 22 with TypeScript stripping, Python 3 with its standard library.
- For `.osm.pbf` input only, [osmium-tool](https://osmcode.org/osmium-tool/manual):
  `brew install osmium-tool` or `apt install osmium-tool`. The importer reports an
  actionable error if it is absent. No npm packages are required.
- Disk space for decoded XML and the SQLite index. PBF is highly compressed;
  decoded regional data can be much larger. Start with a small regional extract.

## Download and compile a region

[Geofabrik provides regional OSM extracts](https://download.geofabrik.de/).
Choose a small region or clip a larger file before ingestion. Example tested with
[United States Virgin Islands](https://download.geofabrik.de/north-america/us/us-virgin-islands.html)
(about 3 MB PBF at verification time):

```sh
curl -fL https://download.geofabrik.de/north-america/us/us-virgin-islands-latest.osm.pbf \
  -o /tmp/us-virgin-islands.osm.pbf

node --experimental-strip-types tools/bulk-import-world.ts \
  --input /tmp/us-virgin-islands.osm.pbf \
  --lat 18.341 --lon -64.932 --half 1120 --cell 4 \
  --name 'St Thomas' \
  --source-url https://download.geofabrik.de/north-america/us/us-virgin-islands-latest.osm.pbf \
  --output /tmp/st-thomas.json

node --experimental-strip-types tools/bake-world.ts \
  --recipe /tmp/st-thomas.json --id st-thomas
```

The first command needs internet for download. The importer reads map features
locally; by default elevation uses the existing Terrarium PNG cache and downloads
missing tiles. Use `--offline-terrain` to require existing local tiles, with
`--terrain-dir DIR` to select a cache directory. Cache filenames are
`{z}-{x}-{y}.png`. Missing or invalid near-terrain tiles fail compilation instead
of substituting flat terrain. `--far-half` defaults to zero; the compiler treats
optional far backdrop terrain as best effort.

The output is a packed recipe, plus `<output>.source.json` containing the source
SHA-256, source URL, requested window, selected OSM counts, missing references,
and attribution. Keep this sidecar with derived datasets. The bake tool converts
the recipe to independently loadable world chunks; it does not fetch OSM.

## Clip a large PBF before importing

Use a bounding box **larger than the playable square**, including at least 120 m
of margin beyond every playable edge. [Osmium's smart extraction strategy](https://docs.osmcode.org/osmium/latest/osmium-extract.html)
completes ways and multipolygon relation members. For example:

```sh
osmium extract --bbox -64.96,18.31,-64.90,18.37 --strategy smart \
  us-virgin-islands-latest.osm.pbf --output st-thomas.osm.pbf

node --experimental-strip-types tools/bulk-import-world.ts \
  --input st-thomas.osm.pbf --lat 18.341 --lon -64.932 --half 1120 \
  --output /tmp/st-thomas.json
```

Osmium extraction selects features using member nodes. A huge enclosing polygon
with all its nodes outside the clip may be omitted. Import the full regional
extract when those features matter. The importer's own SQLite selection includes
crossing ways and enclosing polygon extents, retaining complete nodes and rings.
It rejects missing references in selected compiler features by default. A source
snapshot can itself contain incomplete border relations; widen the source region
first. `--allow-incomplete` is an explicit escape hatch and records missing counts
in provenance; it should not be used for production bakes without review.

## Reuse one index for multiple playable windows

The importer streams PBF to temporary XML using
[`osmium cat`](https://docs.osmcode.org/osmium/latest/osmium-cat.html), then uses
SQLite for selection. For repeated window imports, decode once to a stable XML
path and reuse `--index`:

```sh
osmium cat region.osm.pbf --output region.osm

node --experimental-strip-types tools/bulk-import-world.ts \
  --input region.osm --index /tmp/region.sqlite \
  --bounds '-64.942,18.331,-64.922,18.351' \
  --output /tmp/window.json
```

**CLI syntax:** pass a bounds value as a separate argument in the TypeScript CLI:
`--bounds '-64.942,18.331,-64.922,18.351'`. The Python extractor also accepts the
`--bounds=…` form. `--bounds` is west,south,east,north and selects a square covering
the rectangle; alternatively use `--lat`, `--lon`, `--half` (meters). The importer
adds the compiler's 120 m map margin. Antimeridian windows must be split.

The SQLite cache identity includes source path, size, modification time, and
schema version. Changing the source rebuilds it. Reusing `--index` directly with
PBF input rebuilds because its decoded XML is temporary; use stable XML for index
reuse. Gzip and bzip2 XML snapshots (`.osm.gz`, `.osm.bz2`) are also supported.

Only selected objects enter the Node compiler, with a 128 MiB JSON guard. Near
terrain is limited to two million samples per recipe; subdivide large regions or
increase `--cell`. The regional XML parser and SQLite cache use bounded memory,
but compilation still scales with selected feature density. This tool builds
playable windows from a region, not an entire country in one recipe.

The compiler consumes building and land-cover multipolygons. Unrendered global
collections, routes, administrative boundaries and place-only archipelagos are
not imported as feature relations. Their presence in a regional extract must not
pull thousands of missing worldwide member ways into a local game window.

## Verification and licensing

```sh
node --experimental-strip-types tools/bulk-import-regressions.ts
```

The tiny fixture is **synthetic**, encoded in normal OSM XML. Checks cover node
identity, crossed bounds, joined outer rings and courtyard holes, enclosing
multipolygons, XML entities, cache reuse, incomplete references, a complete recipe
compile with network access forbidden, packed recipe round trip, and allocation
limits. The real Virgin Islands PBF is a separate end-to-end verification input;
it is not checked into the repository.

Map data remains © OpenStreetMap contributors under
[ODbL 1.0](https://www.openstreetmap.org/copyright). Compiled world databases are
OSM-derived data and retain attribution. Terrain tiles retain the compiler's
existing source attribution. Neither dataset becomes CC0 through this importer.
