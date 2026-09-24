import { biomeFor } from './biome.ts';
// OWNER: compiler agent. World Compiler orchestrator — pure (no DOM / Node APIs); IO is injected so it runs in browser, worker and Node.
import type { Recipe, Vec2, RecipeCamera, Terrain } from '../core/types.ts';
import { makeProjection, hashString } from '../core/geo.ts';
import { buildQuery, indexOsm } from './osm.ts';
import { buildHeightfield, terrainSampler, zoomForCell, type TileLoader } from './terrain.ts';
import { regionFor, climateFor, paletteFor } from './region.ts';
import { makeDensity, type Ctx, type Bounds } from './context.ts';
import { buildRoads, buildGraph, RoadIndex, PUBLIC_STREET, fillSidewalksToFacades, dropMedianSidewalks, swOf } from './roads.ts';
import { collectRawBuildings, collectPois, collectZones, buildBuildings, insideBuilding } from './buildings.ts';
import { buildAreas } from './areas.ts';
import { buildTrees, walk } from './vegetation.ts';
import { buildProps } from './props.ts';
import { placeCameras } from './cameras.ts';
import { headingOf, r2 } from './geom.ts';

export interface CompileOptions {
  lat: number; lon: number; name: string;
  /** Half side of the playable square (m). Default 600 (1.2 km). */
  half?: number;
  /** Far backdrop terrain half size (m). Default 6000. */
  farHalf?: number;
  /** Heightfield spacing (m). Default 2. */
  cell?: number;
  /** Lean Overpass query (only tag values the compiler reads) + tighter server limits. Live compiles use this. */
  lean?: boolean;
  /** Low-pass the near DEM (m): opening radius + Gaussian σ, for cities whose z15 source is a noisy surface model. */
  terrainDenoise?: { sigma: number; open?: number };
}
export interface CompileIO {
  /** Run an Overpass QL query, returning parsed JSON. */
  overpass(query: string, onBytes?: (bytes: number) => void): Promise<any>;
  tiles: TileLoader;
  log?(msg: string): void;
}
export type ProgressFn = (stage: string, fraction: number) => void;

export const ATTRIBUTION = [
  'Map data © OpenStreetMap contributors (ODbL 1.0) — openstreetmap.org/copyright',
  'Terrain: AWS Terrain Tiles (Mapzen/Tilezen) — USGS 3DEP & SRTM (public domain)',
  'Compiled world data is an ODbL derivative database',
  'Buildings, vegetation and props inferred procedurally by the Groundtruth World Compiler',
];

export async function compileRecipe(opt: CompileOptions, io: CompileIO, progressRaw: ProgressFn = () => {}): Promise<Recipe> {
  // progress never runs backwards (OSM and terrain report concurrently)
  let hiF = 0;
  const progress: ProgressFn = (s, f) => { hiF = Math.max(hiF, f); progressRaw(s, hiF); };
  const t0 = Date.now();
  const half = opt.half ?? 600, farHalf = opt.farHalf ?? 6000, cell = opt.cell ?? 2;
  const proj = makeProjection(opt.lat, opt.lon);
  const bounds: Bounds = { minX: -half, minZ: -half, maxX: half, maxZ: half };
  const region = regionFor(opt.lat, opt.lon);
  const climate = climateFor(opt.lat, opt.lon, region);
  const seed = hashString(`${opt.lat.toFixed(5)},${opt.lon.toFixed(5)}`);
  const log = io.log ?? (() => {});

  // ---- Ingest (parallel): OSM + terrain
  progress('Querying OpenStreetMap', 0.02);
  const qm = opt.lean ? 90 : 120; // query margin (m)
  const sw = proj.toLatLon(-half - qm, half + qm), ne = proj.toLatLon(half + qm, -half - qm);
  const query = buildQuery(sw.lat, sw.lon, ne.lat, ne.lon, opt.lean ? { lean: true, timeoutS: 90 } : {});
  // heartbeat while the map server thinks (no bytes yet), then a byte counter while it streams
  const tQ = Date.now();
  let gotBytes = 0, osmDone = false;
  const beat = setInterval(() => {
    if (osmDone || gotBytes > 0) return;
    const sec = Math.round((Date.now() - tQ) / 1000);
    // creep forward so the bar never looks frozen while a busy server thinks (capped below 'Reading map data')
    progress(sec < 4 ? 'Querying OpenStreetMap' : `Waiting for OpenStreetMap (${sec} s)`, Math.min(0.27, Math.max(0.02 + 0.06 * (1 - Math.exp(-sec / 20)), hiF + 0.0025)));
  }, 1000);
  const osmP = io.overpass(query, (b) => {
    gotBytes = b;
    if (!osmDone) progress(`Downloading map data (${(b / 1e6).toFixed(1)} MB)`, 0.08 + 0.2 * (1 - Math.exp(-b / 5e6)));
  }).then((j) => { osmDone = true; progress('Reading map data', 0.3); return j; }).finally(() => { osmDone = true; clearInterval(beat); });
  const tm = 60;
  const terrainP = (async () => {
    const z = 15;
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await buildHeightfield(proj, -half - tm, -half - tm, half + tm, half + tm, cell, z, io.tiles, 2, opt.terrainDenoise);
        progress('Fetching terrain', 0.2);
        return t;
      } catch (e) {
        log(`terrain attempt ${attempt + 1} failed: ${(e as Error)?.message ?? e}`);
        if (attempt < 1) continue;
        if (!opt.lean) throw e; // bakes must have real terrain
        break;
      }
    }
    {
      // live: terrain is nice-to-have — fall back to a flat world rather than failing the whole compile
      const n = Math.ceil((2 * (half + tm)) / cell) + 1;
      return { cols: n, rows: n, originX: -half - tm, originZ: -half - tm, cellSize: cell, heights: new Array(n * n).fill(0) } as Terrain;
    }
  })();
  const farP = (async () => {
    if (farHalf <= 0) return null; // neighboring streamed tiles reuse the initial backdrop
    const fcell = 50;
    const z = zoomForCell(opt.lat, 30, 12);
    return buildHeightfield(proj, -farHalf, -farHalf, farHalf, farHalf, fcell, z, io.tiles, 1);
  })().catch((e) => { log(`far terrain failed: ${e}`); return null; });
  progress('Fetching terrain', 0.05);
  const [osmJson, terrain, farTerrain] = await Promise.all([osmP, terrainP, farP]);
  log(`ingest done in ${Date.now() - t0} ms; ${osmJson.elements.length} OSM elements`);

  // datum: y = 0 at the origin's ground
  const hs0 = terrainSampler(terrain);
  const datum = Math.round(hs0(0, 0) * 10) / 10;
  for (let i = 0; i < terrain.heights.length; i++) terrain.heights[i] = Math.round((terrain.heights[i] - datum) * 100) / 100;
  if (farTerrain) for (let i = 0; i < farTerrain.heights.length; i++) farTerrain.heights[i] = Math.round((farTerrain.heights[i] - datum) * 10) / 10;
  const heightAt = terrainSampler(terrain);

  const data = indexOsm(osmJson);
  progress('Inferring buildings', 0.35);
  // density from raw buildings first (roads use it for sidewalks/parking)
  const ctx0: Ctx = { lat: opt.lat, lon: opt.lon, name: opt.name, proj, bounds, region, climate, palette: paletteFor(opt.lat, opt.lon, region, datum), heightAt, density: () => 0, urban: () => 0, seed };
  const raw = collectRawBuildings(data, ctx0);
  const cover = raw.filter((r) => !r.part).map((r) => ({ c: r.c, area: r.area }));
  const dBounds = { minX: -half - qm, minZ: -half - qm, maxX: half + qm, maxZ: half + qm };
  const density = makeDensity(cover, dBounds);
  const urban = makeDensity(cover, dBounds, 7);
  const ctx: Ctx = { ...ctx0, density, urban };

  progress('Laying out streets', 0.42);
  const infos = buildRoads(data, ctx);
  // Rural paths, parks and unmapped wilderness are valid exploration locations too.
  // Empty road graphs are supported by the world and AI services.
  dropMedianSidewalks(infos);
  fillSidewalksToFacades(infos, raw, ctx);
  const gr = buildGraph(infos, data, ctx);
  const roadIdx = new RoadIndex(infos);
  await tick();

  progress('Inferring buildings', 0.5);
  const pois = collectPois(data, ctx);
  const zones = collectZones(data, ctx);
  const bld = buildBuildings(raw, pois, zones, roadIdx, ctx);
  await tick();

  progress('Mapping parks and water', 0.6);
  const areas = buildAreas(data, ctx);

  progress('Planting trees', 0.68);
  const trees = buildTrees(data, areas, infos, roadIdx, bld, ctx);
  await tick();

  progress('Placing street furniture', 0.78);
  const pr = buildProps(data, infos, gr, roadIdx, bld, areas, ctx, trees);
  await tick();

  progress('Placing cameras', 0.88);
  const cameras = placeCameras(infos, gr, roadIdx, bld, areas, pr.signalPoles, ctx);

  progress('Choosing a spawn point', 0.95);
  const spawn = chooseSpawn(infos, roadIdx, bld, cameras, heightAt, areas);

  const roads = infos.map((i) => {
    const r = i.road;
    r.pts = r.pts.map((p) => [r2(p[0]), r2(p[1])] as Vec2);
    r.ys = r.ys.map((y) => r2(y));
    return r;
  });
  for (const n of gr.graph.nodes) { n.p = [r2(n.p[0]), r2(n.p[1])]; }

  const recipe: Recipe = {
    version: 1,
    name: opt.name,
    origin: { lat: opt.lat, lon: opt.lon },
    bounds,
    region, climate, biome: biomeFor(opt.lat,opt.lon,datum,climate), tier: 'A',
    terrain,
    roads,
    graph: gr.graph,
    buildings: bld.buildings,
    areas,
    trees,
    props: pr.props,
    cameras,
    spawn,
    attribution: ATTRIBUTION.slice(),
  };
  if (farTerrain) recipe.farTerrain = farTerrain;
  recipe.elevation = datum;
  progress('World compiled', 1);
  log(`compiled in ${Date.now() - t0} ms`);
  return recipe;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function chooseSpawn(infos: ReturnType<typeof buildRoads>, roads: RoadIndex, bld: ReturnType<typeof buildBuildings>, cams: RecipeCamera[], heightAt: (x: number, z: number) => number, areas: Recipe['areas']): Recipe['spawn'] {
  let best: { p: Vec2; h: number; score: number } | null = null;
  for (const inf of infos) {
    const r = inf.road;
    const ped = r.cls === 'pedestrian';
    if (!(PUBLIC_STREET.has(r.cls) || ped) || r.cls === 'motorway' || r.cls === 'trunk') continue;
    if (!ped && r.sidewalk <= 0) continue;
    for (const side of [1, -1]) {
      const sw = swOf(r, side);
      if (!ped && sw < 1.2) continue;
      const off = ped ? r.width * 0.3 : r.width / 2 + Math.min(sw * 0.5, 1.6);
      walk(r.pts, 7, (p, i, dir) => {
        const q: Vec2 = [p[0] - dir[1] * off * side, p[1] + dir[0] * off * side];
        const d0 = Math.hypot(q[0], q[1]);
        if (d0 > 260) return;
        const camD = Math.min(...cams.map((c) => Math.hypot(c.p[0] - q[0], c.p[1] - q[1])), 1e9);
        if (camD < 40) return;
        if (insideBuilding(q[0], q[1], bld, 0.8)) return;
        if (roads.onCarriageway(q[0], q[1], 0.4, (x) => x.road.cls !== 'pedestrian')) return;
        const score = d0 - Math.min(camD, 90) * 0.3 + (ped ? -15 : 0);
        if (!best || score < best.score) best = { p: q, h: headingOf(dir[0], dir[1]) * (1) + (side === -1 ? Math.PI : 0), score };
      }, 10);
    }
  }
  const b = best as { p: Vec2; h: number } | null;
  if (!b) {
    // Prefer a real trail or road shoulder when there are no urban sidewalks.
    const candidates: { p: Vec2; h: number }[] = [];
    for (const { road: r } of infos) {
      if (r.tunnel || r.bridge || r.cls === 'motorway' || r.cls === 'trunk') continue;
      walk(r.pts, 12, (p, _i, d) => {
        const off = r.lanes > 0 ? r.width / 2 + 1.2 : 0;
        candidates.push({ p: [p[0] - d[1] * off, p[1] + d[0] * off], h: headingOf(d[0], d[1]) });
      }, 1);
    }
    // No mapped paths: sample outward for dry, reasonably level ground.
    for (let radius = 0; radius <= 240; radius += 20) for (let a = 0; a < (radius ? 16 : 1); a++) {
      candidates.push({ p: [Math.cos(a * Math.PI / 8) * radius, Math.sin(a * Math.PI / 8) * radius], h: 0 });
    }
    const water = areas.filter(a => a.kind === 'water');
    const inside = (p: Vec2, ring: Vec2[]) => {
      let yes = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
      }
      return yes;
    };
    const safe = candidates.find(({p}) => !insideBuilding(p[0], p[1], bld, 1)
      && !water.some(a => inside(p, a.poly) && !a.holes?.some(h => inside(p, h)))
      && Math.abs(heightAt(p[0] + 2, p[1]) - heightAt(p[0] - 2, p[1])) < 2
      && Math.abs(heightAt(p[0], p[1] + 2) - heightAt(p[0], p[1] - 2)) < 2);
    if (!safe) throw new Error('No safe dry ground near this pin. Choose a nearby shore, trail or road.');
    return { p: safe.p.map(r2) as Vec2, y: r2(heightAt(...safe.p)), heading: safe.h };
  }
  const h = ((b.h % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return { p: [r2(b.p[0]), r2(b.p[1])], y: r2(heightAt(b.p[0], b.p[1])), heading: +h.toFixed(3) };
}

// ---------- compact baked encoding ----------
/** Encode heights as integer deltas (scale m per unit) to keep baked JSON small. */
export function packTerrain(t: Terrain, scale: number): any {
  const d: number[] = new Array(t.heights.length);
  let prev = 0;
  for (let i = 0; i < t.heights.length; i++) { const q = Math.round(t.heights[i] / scale); d[i] = q - prev; prev = q; }
  const { heights, ...rest } = t;
  void heights;
  return { ...rest, heights: [], q: { scale, d } };
}
export { unpackTerrain, unpackRecipe } from './unpack.ts';
export function packRecipe(r: Recipe): any {
  const out: any = { ...r, terrain: packTerrain(r.terrain, 0.01) };
  if (r.farTerrain) out.farTerrain = packTerrain(r.farTerrain, 0.1);
  return out;
}
