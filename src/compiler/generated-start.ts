// Immediate, offline-safe first district for coordinates without hosted map coverage.
// Location chooses the regional palette and seed; the layout is deliberately fictional.
import type { SpawnLocation } from '../core/location.ts';
import type { Recipe, RecipeRoad, Vec2 } from '../core/types.ts';
import { hashString } from '../core/geo.ts';
import { climateFor, regionFor } from './region.ts';
import { continuationDistrict } from './continuation.ts';
import { terrainSampler } from './terrain.ts';
import { streamNodeId } from '../world/stream-coordinates.ts';

export const GENERATED_ATTRIBUTION = 'Generated world — fictional roads, buildings and terrain; not surveyed map data';
export function isGeneratedWorld(recipe: Recipe) { return recipe.attribution.includes(GENERATED_ATTRIBUTION); }

export function generatedStart(loc: SpawnLocation): Recipe {
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) throw new Error('Invalid world coordinates');
  const seed = hashString(`${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`);
  const phase = seed % 628 / 100;
  const height = (x: number, z: number) => 2.5 * Math.sin(x / 220 + phase) * Math.sin(z / 260);
  const bounds = { minX: -400, minZ: -400, maxX: 400, maxZ: 400 };
  const terrain = { cols: 101, rows: 101, cellSize: 8, originX: -400, originZ: -400,
    heights: Array.from({ length: 101 * 101 }, (_, i) => height(-400 + i % 101 * 8, -400 + Math.floor(i / 101) * 8)) };
  const roads: RecipeRoad[] = [];
  for (const axis of [0, 1]) for (const offset of [0, -160, 160]) {
    const pts: Vec2[] = Array.from({ length: 41 }, (_, i) => axis ? [offset, -400 + i * 20] : [-400 + i * 20, offset]);
    roads.push({ id: `generated:${seed}:street:${axis}:${offset}`, cls: offset ? 'residential' : 'secondary', pts, ys: pts.map(p => height(...p)),
      nodes: pts.map(streamNodeId), width: offset ? 7 : 9, lanes: 2, oneway: false, sidewalk: 2.4, maxSpeed: offset ? 9 : 13,
      surface: 'asphalt', name: axis ? 'Juniper Road' : offset ? 'Meadow Street' : 'Frontier Avenue' });
  }
  const region = regionFor(loc.lat, loc.lon), climate = climateFor(loc.lat, loc.lon, region);
  const root: Recipe = { version: 1, name: loc.name, origin: { lat: loc.lat, lon: loc.lon }, bounds, region, climate, tier: 'B', terrain,
    roads, graph: { nodes: [], edges: [] }, buildings: [], areas: [], trees: [], props: [], cameras: [],
    spawn: { p: [7, -35], y: height(7, -35), heading: 0 }, attribution: [GENERATED_ATTRIBUTION] };
  const h = terrainSampler(terrain);
  const world = continuationDistrict(root, bounds, [{ recipe: root, heightAt: h, groundAt: h }]);
  world.name = `${loc.name} · generated world`;
  world.attribution = [GENERATED_ATTRIBUTION];
  world.cameras.unshift({ id: `generated:${seed}:starter-camera`, type: 'pole', p: [7, -18], y: h(7, -18), heading: -Math.PI / 2,
    poleHeight: 5, cuttable: true, fovDeg: 55, rangeM: 45, plateReader: true, mapped: true });
  world.props.push({ type: 'bench', p: [10, -42], y: h(10, -42), rot: -Math.PI / 2, variant: 0 },
    { type: 'trash-can', p: [10, -46], y: h(10, -46), rot: 0, variant: 0 });
  return world;
}
