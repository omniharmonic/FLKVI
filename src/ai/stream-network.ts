import type { Recipe, RecipeRoad } from '../core/types.ts';
import { clipRoadGraph, streamNodeId } from '../world/stream-coordinates.ts';

const coreGraphs = new WeakMap<Recipe, Recipe['graph']>();
/** Initial recipes include an acquisition margin beyond their physical world. Clip the
 * AI graph to the actual core so its boundary nodes meet streamed districts exactly. */
function coreGraph(core: Recipe): Recipe['graph'] {
  const cached = coreGraphs.get(core);
  if (cached) return cached;
  const graph = clipRoadGraph(core.graph, core.bounds, true, core.roads);
  coreGraphs.set(core, graph);
  return graph;
}

/** Merge resident OSM identities. A road may have several clipped pieces: keep them all,
 * because replacing pieces by road ID alone silently loses lanes in other districts. */
export function mergeDistrictGraphs(core: Recipe, districts: readonly Recipe[], ready: (x: number, z: number) => boolean): Recipe {
  const roads: RecipeRoad[] = [];
  const roadPieces = new Set<string>();
  for (const recipe of [core, ...districts]) for (const road of recipe.roads) {
    const a = road.pts[0], b = road.pts.at(-1);
    if (!a || !b) continue;
    const key = `${road.id}:${a[0].toFixed(3)},${a[1].toFixed(3)}:${b[0].toFixed(3)},${b[1].toFixed(3)}:${road.pts.length}`;
    if (!roadPieces.has(key)) { roadPieces.add(key); roads.push(road); }
  }
  const initial = coreGraph(core);
  const nodes = initial.nodes.map(n => ({ ...n })), edges = initial.edges.map(e => ({ ...e }));
  // Older baked recipes number nodes locally (0, 1, …); those IDs collide across
  // districts. World coordinates identify the actual shared junction instead.
  const nodeIds = new Map(nodes.map((n, i) => [streamNodeId(n.p), i]));
  const edgeIds = new Set(edges.map(e => `${e.from}:${e.to}:${e.roadId}`));
  for (const r of districts) {
    for (const e of r.graph.edges) {
      const a = r.graph.nodes[e.from], b = r.graph.nodes[e.to];
      if (!a || !b) continue;
      // Exact boundary coordinates may round just outside readiness by a few nanometres.
      // Validate an interior point; graph segments are already clipped to their tile.
      if (!ready((a.p[0] + b.p[0]) * 0.5, (a.p[1] + b.p[1]) * 0.5)) continue;
      const remap = (n: typeof a) => {
        const key = streamNodeId(n.p);
        let id = nodeIds.get(key);
        if (id === undefined) { id = nodes.length; nodes.push({ ...n, id: key }); nodeIds.set(key, id); }
        return id;
      };
      const from = remap(a), to = remap(b), key = `${from}:${to}:${e.roadId}`;
      if (!edgeIds.has(key)) { edgeIds.add(key); edges.push({ ...e, from, to }); }
    }
  }
  return { ...core, roads, graph: { nodes, edges } };
}
