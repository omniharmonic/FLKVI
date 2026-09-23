// Road graph helpers: nearest node (grid), A* routing, sidewalk point sampling.
import type { RoadGraph, Vec2 } from '../core/types';
import { Grid } from './util';
import type { RoadNetwork } from './roads';

export class Nav {
  private grid = new Grid<number>(60);
  private adj: { to: number; cost: number }[][] = [];
  private idToIdx = new Map<number, number>();
  private maxSpeed = 1;
  constructor(private graph: RoadGraph, private roads: RoadNetwork) {
    graph.nodes.forEach((n, i) => { this.grid.add(n.p[0], n.p[1], i); this.idToIdx.set(n.id, i); });
    this.adj = graph.nodes.map(() => []);
    for (const e of graph.edges) {
      const a = this.idToIdx.get(e.from), b = this.idToIdx.get(e.to);
      if (a === undefined || b === undefined) continue;
      const sp = Math.max(2, e.speed || 10);
      this.maxSpeed = Math.max(this.maxSpeed, sp);
      this.adj[a].push({ to: b, cost: (e.length || 1) / sp });
    }
  }
  private hasEdges(i: number) { return this.adj[i].length > 0; }
  nearestNode(p: Vec2): number {
    const nodes = this.graph.nodes;
    for (let r = 60; r <= 7680; r *= 2) {
      let best = -1, bd = Infinity;
      this.grid.query(p[0], p[1], r, (i) => {
        if (!this.hasEdges(i)) return;
        const d = (nodes[i].p[0] - p[0]) ** 2 + (nodes[i].p[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      if (best >= 0 && Math.sqrt(bd) <= r) return nodes[best].id;
    }
    return nodes.length ? nodes[0].id : -1;
  }
  route(fromId: number, toId: number): number[] {
    const s = this.idToIdx.get(fromId), t = this.idToIdx.get(toId);
    if (s === undefined || t === undefined) return [];
    if (s === t) return [fromId];
    const nodes = this.graph.nodes;
    const tp = nodes[t].p;
    const h = (i: number) => Math.hypot(nodes[i].p[0] - tp[0], nodes[i].p[1] - tp[1]) / this.maxSpeed;
    const g = new Map<number, number>([[s, 0]]);
    const came = new Map<number, number>();
    // binary heap of [f, idx]
    const heap: [number, number][] = [[h(s), s]];
    const push = (x: [number, number]) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const closed = new Set<number>();
    let iter = 0;
    while (heap.length && iter++ < 200000) {
      const [, u] = pop();
      if (u === t) {
        const path = [u]; let c = u;
        while (came.has(c)) { c = came.get(c)!; path.push(c); }
        return path.reverse().map((i) => nodes[i].id);
      }
      if (closed.has(u)) continue;
      closed.add(u);
      const gu = g.get(u)!;
      for (const e of this.adj[u]) {
        const ng = gu + e.cost;
        if (ng < (g.get(e.to) ?? Infinity)) { g.set(e.to, ng); came.set(e.to, u); push([ng + h(e.to), e.to]); }
      }
    }
    return [];
  }
  randomSidewalkPoint(near: Vec2, radius: number, rnd: () => number = Math.random): Vec2 | null {
    const pts = this.roads.walkPts, cand: number[] = [];
    const r2 = radius * radius;
    this.roads.walkGrid.query(near[0], near[1], radius, (i) => { const p = pts[i]; if ((p[0] - near[0]) ** 2 + (p[1] - near[1]) ** 2 <= r2) cand.push(i); });
    if (!cand.length) return null;
    const p = pts[cand[Math.floor(rnd() * cand.length) % cand.length]];
    // jitter ±0.6 m
    return [p[0] + (rnd() - 0.5) * 1.2, p[1] + (rnd() - 0.5) * 1.2];
  }
}
