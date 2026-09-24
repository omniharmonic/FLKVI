// Pure coordinate/ownership rules shared by streaming and its regression tests.
import type { Recipe, Vec2 } from '../core/types.ts';
import { makeProjection } from '../core/geo.ts';
import { terrainSampler } from '../compiler/terrain.ts';
export type Bounds = Recipe['bounds'];
export const DISTRICT_SIZE = 400;
export function contains(b: Bounds, x: number, z: number, inset = 0) {
  return x >= b.minX + inset && x <= b.maxX - inset && z >= b.minZ + inset && z <= b.maxZ - inset;
}
export function distanceTo(b: Bounds, x: number, z: number) {
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
}
export function districtIndex(v: number, min: number, max: number) {
  return v < min ? Math.floor((v - min) / DISTRICT_SIZE) : v > max ? Math.ceil((v - max) / DISTRICT_SIZE) : 0;
}
export function districtBounds(core: Bounds, i: number, j: number): Bounds {
  const axis = (n: number, a: number, b: number): [number, number] => n < 0 ? [a + n * DISTRICT_SIZE, a + (n + 1) * DISTRICT_SIZE] : n > 0 ? [b + (n - 1) * DISTRICT_SIZE, b + n * DISTRICT_SIZE] : [a, b];
  const [minX, maxX] = axis(i, core.minX, core.maxX), [minZ, maxZ] = axis(j, core.minZ, core.maxZ);
  return { minX, minZ, maxX, maxZ };
}
/** Reproject every spatial field into the initial world's ENU frame and elevation datum. */
export function rebaseRecipe(source: Recipe, root: Recipe, bounds: Bounds): Recipe {
  const a = makeProjection(source.origin.lat, source.origin.lon), b = makeProjection(root.origin.lat, root.origin.lon);
  const move = (p: Vec2): Vec2 => { const ll = a.toLatLon(...p); return b.toLocal(ll.lat, ll.lon); };
  const dy = (source.elevation ?? 0) - (root.elevation ?? 0);
  const inside = (p: Vec2) => contains(bounds, ...p);
  const srcH = terrainSampler(source.terrain);
  const cellSize = 4, cols = Math.ceil((bounds.maxX - bounds.minX) / cellSize) + 1, rows = Math.ceil((bounds.maxZ - bounds.minZ) / cellSize) + 1;
  const heights: number[] = [];
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const ll = b.toLatLon(bounds.minX + x * cellSize, bounds.minZ + z * cellSize);
    heights.push(srcH(...a.toLocal(ll.lat, ll.lon)) + dy);
  }
  return {
    ...source, origin: root.origin, elevation: root.elevation, bounds, farTerrain: undefined,
    terrain: { cols, rows, cellSize, originX: bounds.minX, originZ: bounds.minZ, heights },
    roads: source.roads.map(r => ({ ...r, pts: r.pts.map(move), ys: r.ys.map(y => y + dy) })),
    graph: { nodes: source.graph.nodes.map(n => ({ ...n, p: move(n.p), y: n.y + dy })), edges: source.graph.edges.map(e => ({ ...e })) },
    buildings: source.buildings.map(v => ({ ...v, baseY: v.baseY + dy, footprint: v.footprint.map(move), holes: v.holes?.map(r => r.map(move)) }))
      .filter(v => inside([v.footprint.reduce((s,p)=>s+p[0],0)/v.footprint.length, v.footprint.reduce((s,p)=>s+p[1],0)/v.footprint.length])),
    areas: source.areas.map(v => ({ ...v, poly: v.poly.map(move), holes: v.holes?.map(r => r.map(move)) })),
    trees: source.trees.map(v => ({ ...v, p: move(v.p), y: v.y + dy })).filter(v => inside(v.p)),
    props: source.props.map(v => ({ ...v, p: move(v.p), y: v.y + dy, line: v.line?.map(move) })).filter(v => inside(v.p)),
    cameras: source.cameras.map(v => ({ ...v, p: move(v.p), y: v.y + dy })).filter(v => inside(v.p)),
    spawn: { ...source.spawn, p: move(source.spawn.p), y: source.spawn.y + dy },
  };
}
