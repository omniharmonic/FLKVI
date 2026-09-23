// Synthetic grid city recipe for AI tests and the dev harness.
import type { Recipe, RecipeRoad, RoadGraph } from '../../core/types.ts';

/** N x N grid, spacing m. Middle row/col are secondary with signals; others residential with stops on some. */
export function gridRecipe(N = 6, spacing = 120): Recipe {
  const nodes: RoadGraph['nodes'] = [];
  const id = (i: number, j: number) => i * N + j;
  const mid = Math.floor(N / 2);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const major = i === mid || j === mid;
      const both = i === mid && j === mid;
      nodes.push({ id: id(i, j), p: [j * spacing, i * spacing], y: 0, signal: (major && (i % 2 === 1 || j % 2 === 1)) || both, stop: !major && (i + j) % 3 === 0 });
    }
  const roads: RecipeRoad[] = [];
  const edges: RoadGraph['edges'] = [];
  const addRoad = (rid: string, ids: number[], cls: 'secondary' | 'residential') => {
    const lanes = cls === 'secondary' ? 4 : 2;
    const speed = cls === 'secondary' ? 15 : 11;
    roads.push({
      id: rid, cls, pts: ids.map((k) => nodes[k].p), ys: ids.map(() => 0), width: lanes * 3.3, lanes, oneway: false,
      sidewalk: 2.5, maxSpeed: speed, surface: 'asphalt', nodes: ids,
    });
    for (let k = 0; k < ids.length - 1; k++) {
      const a = ids[k], b = ids[k + 1];
      edges.push({ from: a, to: b, roadId: rid, length: spacing, lanes, speed, cls });
      edges.push({ from: b, to: a, roadId: rid, length: spacing, lanes, speed, cls });
    }
  };
  for (let i = 0; i < N; i++) addRoad(`row${i}`, [...Array(N)].map((_, j) => id(i, j)), i === mid ? 'secondary' : 'residential');
  for (let j = 0; j < N; j++) addRoad(`col${j}`, [...Array(N)].map((_, i) => id(i, j)), j === mid ? 'secondary' : 'residential');
  return {
    version: 1, name: 'grid', origin: { lat: 0, lon: 0 }, bounds: { minX: 0, minZ: 0, maxX: N * spacing, maxZ: N * spacing },
    region: 'mountain-west', climate: 'arid', tier: 'A',
    terrain: { cols: 2, rows: 2, originX: 0, originZ: 0, cellSize: 1000, heights: [0, 0, 0, 0] },
    roads, graph: { nodes, edges }, buildings: [], areas: [], trees: [], props: [], cameras: [],
    spawn: { p: [0, 0], y: 0, heading: 0 }, attribution: [],
  };
}

