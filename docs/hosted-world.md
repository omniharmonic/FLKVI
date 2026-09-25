# Hosted world packages

FLK VI loads initial areas and streamed districts from the same static geographic
package store. Normal gameplay does not query Overpass or compile raw OSM.

## Data flow

1. Import a regional OSM snapshot and elevation cache offline. The importer uses
   streaming XML plus a disk-backed SQLite index, preserving complete feature
   references and source provenance. See [offline imports](offline-world-import.md).
2. Bake the compiled recipe into 400 m compressed packages. Whole intersecting
   features retain stable IDs; assembly deduplicates them before final cropping.
   Each filename and manifest entry includes a content hash.
3. Publish `public/world/` on Pages or a static object-storage CDN. Set
   `VITE_WORLD_DATA_URL` at build time to use another host; CORS must allow the game.
4. A shared browser worker finds coverage by coordinates, downloads, verifies,
   decompresses, assembles and rebases only the required packages. Startup and
   travel use this same path. Custom pins can use mapped coverage without an exact
   featured-city ID.
5. The main thread builds render geometry and collision in serialized stages.
   Boundary clipping reuses interior vertex/index buffers and interpolates only
   crossing triangles; construction yields between paving and mesh stages.
   Travel prefetch follows velocity; far districts release geometry and physics.

A static site can do this. Expanding the real dataset requires offline processing
and storage, but not a per-player map compilation server.

## Bounds and recovery

- Two concurrent network transfers; 12-second transfer deadline; 30-second worker
  watchdog. A failed worker is terminated before replacement.
- 24 decoded chunks in worker memory; persistent cache limited to 96 files/64 MiB.
  Chunk identity survives unrelated manifest updates.
- Downloads have size checks and SHA-256 validation. Corrupt cached bytes are
  deleted and downloaded once again. Cache-storage operations have a one-second
  deadline and a circuit breaker, so unavailable/private storage cannot hang play.
- Only one district assembly runs at a time. The normal target is three resident
  districts (two at low quality); collision under the player/occupied car is
  protected from eviction. Boundaries remain until adjacent collision is ready.
- Generated crossing streets receive shared same-grade junction nodes. Road construction
  combines overlapping corner footprints so curbs do not block the carriageway;
  bridges, tunnels and explicitly separated layers retain separate connections.
- A known featured city can use its legacy bundled recipe during a hosted-data
  outage. A custom pin outside coverage, or with unavailable packages, starts a
  visibly labeled generated world. Generated geography is never saved as mapped
  coverage. Generated outskirts continue beyond available map data.

Fallback worlds are playable fictional landscapes, not reconstructions of the
selected place. The HUD labels this distinction. No nationwide map coverage is
claimed.

## Shipped coverage and reproducibility

The release contains the existing sixteen featured regions plus a new St Thomas
window imported from the official US Virgin Islands PBF. There are 612 geographic
chunks and sixteen distant-terrain files, about 25.2 MB compressed in total. The
largest individual file is 108 KB. The geographic index is approximately 104 KB.
These figures describe map data, not models, textures, audio or JavaScript.

The real St Thomas import contains 462 roads and 2,601 building footprints in a
2.24 km square. Its source PBF was compiled with all network access forbidden
using cached Terrarium elevation, with no missing feature references. The retained
packed recipe and source checksum are in `world-sources/`; raw PBF and temporary
SQLite files are not shipped.

Reproduce packages without querying map servers:

```sh
npm run world:bake
npm run world:bake -- --recipe world-sources/st-thomas.json.gz --id st-thomas
npm run test:world-data
npm run test:world-store
npm run test:world-import
```

The importer supports many windows from one regional index. A country-wide data
pipeline, scheduled source refreshes and a scalable coverage index are future
work; this release establishes and verifies the offline ingestion and hosted
runtime path with a concrete regional import.

## Verification

The source checks cover every shipped package, checksums, road graphs, terrain
seams, arbitrary pins, clipping, generated starts and continuity. Worker tests run
the real message handler against hosted gzip files, including corruption repair,
prefetch reuse, storage hangs, bounded concurrency and decoded-cache eviction.
The import suite includes a network-forbidden compile and complete multipolygon
references. These suites run in deployment CI alongside gameplay logic and
render-budget tests.

Browser checks exercise full world assembly, movement/sidewalks, collision,
character facing, punching, ragdolls, localized vehicle damage, camera takedowns,
weather, throttle-driven main-road and service-alley travel across a generated seam, district eviction and
reloading. Representative alpine, desert, urban, coastal, custom-pin and generated
starts are checked separately, including deliberate hosted-data outages.

The first hosted deployment passed the public-site smoke and seven-transition
travel soak, with zero errors or shader failures. A real picker pin also started
with reverse geocoding blocked. Initial hosted loading used 18 map requests; the
warm reload used one manifest request and reused all 17 data files from cache.

Profiling then identified boundary geometry clipping as the main scene-construction
hitch. Reusing interior vertices reduced the same district mesh stage from 111 ms
to 18 ms locally. The follow-up retains clipped coverage, normals, texture
coordinates and shared indices, with regression checks for each.

Final production performance measurements accompany the release verification. The test machine uses Chromium with Apple M4
ANGLE/Metal at 1440 × 900; this is not a guarantee for every browser or GPU.
