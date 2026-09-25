import { projectPoly, samplePoly, type RoadNet } from './roadnet.ts';

/** Sample usable lane interiors, not just intersection nodes. Country roads can have
 * kilometres between nodes even though a loaded, safe lane passes beside the player. */
export function* spawnLanes(net: RoadNet, x: number, z: number, radius: number, random: () => number) {
  const edges = net.edgesNear(x, z, radius);
  const offset = Math.floor(random() * edges.length);
  for (let k = 0; k < Math.min(edges.length, 96); k++) {
    const edge = net.edges[edges[(k + offset) % edges.length]];
    const lo = net.laneStart(edge) + 4, hi = net.laneEnd(edge) - 4;
    if (edge.rank < 1 || hi <= lo) continue;
    const poly = net.lanePoly(edge, 0);
    const nearest = projectPoly(poly, x, z).s;
    const distance = radius * (0.55 + random() * 0.3);
    for (const at of [nearest + distance, nearest - distance, lo + random() * (hi - lo)]) {
      const s = Math.max(lo, Math.min(hi, at));
      const p = samplePoly(poly, s);
      yield { e: edge.i, s, x: p.x, z: p.z, h: p.h };
    }
  }
}
