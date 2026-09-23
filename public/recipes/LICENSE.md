# License for baked city recipes

The files in this directory (`*.json` recipes and the `thumbs/` previews rendered from them) are
**derivative databases** of OpenStreetMap data, produced by the Groundtruth World Compiler
(`tools/compile-city.ts`).

## Map data: Open Database License (ODbL) 1.0

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

These recipes are made available under the
[Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1-0/). Any rights in
individual contents of the database are licensed under the
[Database Contents License](https://opendatacommons.org/licenses/dbcl/1-0/).

If you use, adapt or redistribute these recipes, you must attribute OpenStreetMap contributors and
keep any adapted database under the ODbL (share-alike). OSM data was retrieved through the public
Overpass API. Building styles, heights where untagged, vegetation, props and camera placements are
inferred procedurally from the OSM tags and are part of this derivative database.

## Terrain: AWS Terrain Tiles (Mapzen / Tilezen)

Elevation grids in these recipes were sampled from
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium encoding). For the
continental US, the underlying sources and their required attributions are:

- 3DEP (formerly NED) and NED topobathy courtesy of the U.S. Geological Survey
- SRTM courtesy of NASA and the U.S. Geological Survey
- GMTED2010 courtesy of the U.S. Geological Survey
- ETOPO1 courtesy of the NOAA National Centers for Environmental Information

These US government sources are in the public domain. Full source list and attribution
requirements: <https://github.com/tilezen/joerd/blob/master/docs/attribution.md>.

The Groundtruth source code is MIT-licensed separately (see `/LICENSE`). This file governs only
the data in this directory.
