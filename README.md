# FLK VI

[Hosted world architecture and verification](docs/hosted-world.md) · [Stability, streaming and physics release notes](docs/flk-vi-stability.md).

**Take the city back, one camera at a time.**

FLK VI is an independent browser open-world game set in real US places. Pick a spot on the map and the game
loads a 3D world: mapped coverage uses real streets, building footprints and terrain; other
locations use clearly labeled generated geography. Both include an invented network of surveillance cameras. Your job is to take the cameras down
(spray them, bag them, or cut the poles) and build the longest streak you can before the police
catch up with you.

![Pearl Street Mall, Boulder, Colorado, at golden hour](docs/screenshot.jpg)

**Play:** <https://omniharmonic.github.io/FLKVI/>

> Desktop only: it needs a keyboard, a mouse and WebGL 2, and phones and tablets are turned away at
> the title screen. A discrete GPU is recommended; it is developed and tested mainly in Chromium
> browsers.

## Controls

| On foot | | Takedown | |
|---|---|---|---|
| Move | `W` `A` `S` `D` | Disable camera (hold) | `E` |
| Look | Mouse | Cut down pole (hold) | `R` |
| Sprint / Jump | `Shift` / `Space` | Scan: show vision cones (hold) | `Q` |
| Crouch / Walk (toggle) | `C` / `X` | Binoculars (hold) | `B` |
| Punch / shove | `G` or left click | Camera map | `M` or `Tab` |
| Enter / exit vehicle | `F` | Photo mode | `P` |

| Driving | | System | |
|---|---|---|---|
| Throttle / brake | `W` / `S` | Pause, settings, credits | `Esc` |
| Steer | `A` / `D` | Capture mouse | Click |
| Handbrake / Horn | `Space` / `H` | Cycle weather | `F7` |
| Look back / Reset car | `V` / `R` | | |

## Core loop and scoring

1. **Scout.** Use the camera map, binoculars and scan to find cameras and see what each one covers.
2. **Take down.** Disabling a camera (`E`) is quick and quiet. Cutting it down (`R`) is worth more
   but uses a grinder charge. Pole cameras, PTZ domes, clusters and towers pay progressively more,
   and cameras that cover other cameras pay a bonus.
3. **Stay unseen.** If cameras, bystanders or officers spot you, heat rises and police respond with
   foot patrols, cruisers, a helicopter and drones. The network also fights back by installing new
   cameras over time.
4. **Bank.** A clean, unseen takedown banks its points immediately. Anything done under heat stays
   *hot* until you lose the police. Get arrested and your hot points are gone.

Every takedown adds to your **streak**, and the streak raises your score multiplier (+0.1× per
takedown, up to 3×). Free-roam mode lets you explore without a run.

## Cities

Sixteen featured places have pre-baked starting areas and bundled first-ring expansion maps. The newest are Frisco, CO (alpine), Russell, KS (plains), and Lakewood, CO (suburban):

Boulder (Pearl Street) · San Francisco (Mission) · New York (Greenwich Village) · New Orleans
(French Quarter) · Chicago (The Loop) · Phoenix (Downtown) · Seattle (Capitol Hill) · Austin (South
Congress) · Savannah (Historic District) · Miami Beach (South Beach) · Denver (LoDo) · Santa Fe · Moab

**Or drop anywhere in the US, Puerto Rico or US Virgin Islands.** Pins inside hosted coverage
load real map packages, including a new St Thomas area imported from a regional OSM PBF.
Outside coverage, the game starts a clearly labeled **generated world** with fictional geography.
The current release does not contain nationwide real map coverage.

Initial worlds and new districts use the same hosted 400 m package loader. A background worker
fetches, verifies, decompresses, assembles and caches data. No public Overpass query is needed
for normal gameplay. Districts load ahead of travel, and distant districts unload. Beyond mapped
coverage, connected generated terrain continues the game. A safety boundary holds until the
next section has collision and is ready. This works on static hosting.

## How it works

```
Regional OSM PBF + cached elevation
  → offline compiler → 400 m gzip packages + geographic manifest → static host/CDN
  → browser worker (fetch, checksum, decode, crop, cache) → client assembly → game
```

- **Offline compiler** (`tools/bulk-import-world.ts`) reads regional OSM snapshots through a
  disk-backed spatial index. It infers building styles, vegetation, props and cameras. The
  bake step publishes immutable geographic packages. See [offline imports](docs/offline-world-import.md).
- **World store** (`src/compiler/world-store.worker.ts`) shares startup and travel loading,
  bounded downloads, memory/cache limits, checksums and failure recovery. Custom pins use
  geographic coverage rather than exact featured-city coordinates.
- **Recipe** (`src/core/types.ts`) is the contract between compiler and client: a single JSON
  document in local meters with the origin at the spawn point.
- **Client** assembles the recipe into a world with instanced and merged geometry, PBR materials,
  physics colliders and a road graph for traffic and police.

| Directory | Responsibility |
|---|---|
| `src/core/` | Recipe types, service interfaces, event bus, game loop |
| `src/compiler/` | Offline compiler, worker world store, generated fallback and featured-city list |
| `src/world/` | Terrain, roads, areas, vegetation, props, landmarks; `buildings/` generates facades |
| `src/render/` | Renderer, sky and time of day, weather, post-processing |
| `src/game/` | Player, character controller, camera, vehicles |
| `src/ai/` | Heat, police, traffic, pedestrians, helicopter |
| `src/surveillance/` | Cameras, vision, takedowns, scoring, drones |
| `src/ui/`, `src/audio/` | Picker, loading, HUD, maps, menus, photo mode; audio |
| `src/assets/` | Asset library and loaders |
| `tools/` | Node scripts: city baking, thumbnails, license check |

## Local development

Requires Node 22 or newer.

```sh
npm install
npm run dev            # http://127.0.0.1:5173
```

Useful URL parameters:

- `?autostart&city=<id>` skips the picker and loads a featured city (`boulder`, `sf-mission`,
  `nyc-village`, `nola-quarter`, `chicago-loop`, `phoenix-downtown`, `seattle-caphill`,
  `austin-soco`, `savannah`, `miami-beach`, `denver-lodo`, `santa-fe`, `moab`).
- `&weather=clear|overcast|rain|storm|fog` selects weather; `&nostream` disables automatic district requests for debugging.
- `&nointro` skips the arrival fly-in; `&time=18.5` sets the starting hour; `&rain=1` forces rain.

Type-check with `npm run typecheck` and build with `npm run build`.

Regression checks:

```sh
npm run test:ai                       # traffic, rural police, animation, signals and heat
npm run test:deep                     # compiler, coordinates, render budget and graph checks
npm run test:world-data               # package integrity, seams, custom pins and generated starts
npm run test:world-store              # actual worker loading, corruption, storage and timeout recovery
npm run test:world-import             # local OSM ingestion, references and terrain failures
PORT=5200 npm run dev -- --strictPort  # shared server, in a separate terminal
npm run test:browser                  # movement, collision, junction and asset checks
npm run test:integration              # 48 streaming, combat, damage and weather checks
npm run test:world -- sf-mission       # full city, quality settings, rendering and takedown checks
npm run test:world-loading            # representative biomes, custom coverage and deliberate outages
npm run test:soak                     # seven district transitions with live AI/rendering and metrics
```

The browser checks require `agent-browser` on PATH and use `tools/browser.sh` to serialize Chromium sessions.
See [the polish audit](docs/polish-audit.md) and [world expansion notes](docs/world-expansion.md)
for changes, validation and remaining engineering work.

Deployment to GitHub Pages runs
from `.github/workflows/deploy.yml` on every push to `main`.

## Baking cities

Featured cities live in `src/compiler/cities.ts`. To rebuild their recipes and picker thumbnails:

```sh
node --experimental-strip-types tools/compile-city.ts boulder     # or several ids, or: all
node --experimental-strip-types tools/compile-city.ts --lat 40.01 --lon -105.27 --id custom --name "Somewhere"
node --experimental-strip-types tools/thumbs.ts                   # regenerate public/recipes/thumbs/
```

This legacy developer tool uses live map services; it is not used during gameplay.
Output goes to `public/recipes/<id>.json`. Prefer the [offline regional importer](docs/offline-world-import.md)
for new coverage. Reproduce the checked-in hosted dataset without network access:

```sh
npm run world:bake
npm run world:bake -- --recipe world-sources/st-thomas.json.gz --id st-thomas
npm run test:world-data
```

To host packages elsewhere, set `VITE_WORLD_DATA_URL` to the directory containing `index.json`
at build time. The host must allow browser CORS requests. Each hashed package is immutable;
keep the manifest revalidatable. Hosting uses the same files on Pages or an object-storage CDN.

## Tech stack

- [Three.js](https://threejs.org) (WebGL 2) with [postprocessing](https://github.com/pmndrs/postprocessing)
  and [N8AO](https://github.com/N8python/n8ao) for ambient occlusion
- [Rapier](https://rapier.rs) physics (`@dimforge/rapier3d-compat`)
- [ez-tree](https://github.com/dgreenheck/ez-tree) procedural trees
- [Leaflet](https://leafletjs.com) for the location picker
- TypeScript and Vite, vanilla DOM and CSS for UI, Web Audio with procedural synthesis for sound

## Credits and licenses

**Source code:** MIT, © 2026 Benjamin Life. See [LICENSE](LICENSE). The license covers the code only;
the data and assets below carry their own licenses.

**Map data:** © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). The baked recipes in
`public/recipes/`, `public/world/` and `world-sources/` are derivative databases and are ODbL-licensed; see
[public/recipes/LICENSE.md](public/recipes/LICENSE.md). Hosted data comes from retained recipe sources and regional OSM snapshots; provenance for the new import is in `world-sources/st-thomas.source.json`.

**Terrain:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen / Tilezen).
3DEP (formerly NED) and NED topobathy courtesy of USGS; SRTM courtesy of NASA and USGS; GMTED2010
courtesy of USGS; ETOPO1 courtesy of NOAA.
[Full attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

**Location picker:** base map tiles © Esri (World Dark Gray Canvas; Esri, HERE, Garmin,
© OpenStreetMap contributors, and the GIS user community). Search and reverse geocoding by
[Nominatim](https://nominatim.org/), © OpenStreetMap contributors.

**Assets:** all third-party assets are [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
(public domain): textures, HDRIs and props from [Poly Haven](https://polyhaven.com) and
[ambientCG](https://ambientcg.com); characters and animations by [Quaternius](https://quaternius.com);
vehicles and sound effects by [Kenney](https://kenney.nl). Each file's source and author is listed
in [public/assets/LICENSES.json](public/assets/LICENSES.json); run `npm run check:licenses` to verify
coverage. Everything else (buildings, signage, surveillance hardware, most audio) is generated
procedurally in code.

**Fiction:** FLK VI is a game. It is set in real places but depicts no real brands, agencies or
insignia, and camera placements are invented. Don't do this in real life.
