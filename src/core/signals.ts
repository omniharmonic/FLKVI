// Shared deterministic traffic-signal timing so world visuals and AI traffic agree.
import type { RoadGraph } from './types';

export const SIGNAL_CYCLE = 36; // seconds: 15 green + 3 yellow per axis
const GREEN = 15, YELLOW = 3;

/** Primary axis (radians mod PI) of a signalized node = bearing of the first graph edge touching it. */
export function signalAxis(graph: RoadGraph, nodeId: number): number {
  const n = graph.nodes[nodeId];
  for (const e of graph.edges) {
    if (e.from === nodeId || e.to === nodeId) {
      const o = graph.nodes[e.from === nodeId ? e.to : e.from];
      return ((Math.atan2(o.p[1] - n.p[1], o.p[0] - n.p[0]) % Math.PI) + Math.PI) % Math.PI;
    }
  }
  return 0;
}

/** Light shown to traffic approaching nodeId along travel bearing `bearing` (atan2(dz, dx)) at time t. */
export function signalState(nodeId: number, axis: number, bearing: number, t: number): 'green' | 'yellow' | 'red' {
  const b = ((bearing % Math.PI) + Math.PI) % Math.PI;
  let d = Math.abs(b - axis); d = Math.min(d, Math.PI - d);
  const onPrimary = d < Math.PI / 4;
  const phase = (t + (nodeId * 7.31) % SIGNAL_CYCLE) % SIGNAL_CYCLE;
  const local = onPrimary ? phase : (phase + SIGNAL_CYCLE / 2) % SIGNAL_CYCLE;
  if (local < GREEN) return 'green';
  if (local < GREEN + YELLOW) return 'yellow';
  return 'red';
}
