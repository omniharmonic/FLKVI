// Lane-level road network derived from recipe.roads + recipe.graph. Pure (no three.js) so it can be
// unit tested under node. Coordinates: x east, z south. Headings: 0 = -Z, clockwise.
import type { Recipe, RoadClass, RecipeRoad, Vec2 } from '../core/types.ts';
import { signalAxis } from '../core/signals.ts';
import { StaticGrid } from './spatial.ts';

export interface Poly {
  xs: Float64Array;
  zs: Float64Array;
  /** cumulative arc length at each vertex */
  cum: Float64Array;
  len: number;
}

export interface Sample { x: number; z: number; h: number }

export const DRIVABLE: ReadonlySet<RoadClass> = new Set<RoadClass>([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'unclassified',
]);
export const WALKONLY: ReadonlySet<RoadClass> = new Set<RoadClass>(['pedestrian', 'footway', 'path', 'steps', 'cycleway']);

export const CLASS_RANK: Record<RoadClass, number> = {
  motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2,
  living_street: 1, service: 1, pedestrian: 0, footway: 0, cycleway: 0, path: 0, steps: 0,
};
/** Traffic density weight per meter by class. */
export const CLASS_DENSITY: Record<RoadClass, number> = {
  motorway: 3, trunk: 2.5, primary: 2, secondary: 1.6, tertiary: 1.2, unclassified: 0.5, residential: 0.55,
  living_street: 0.2, service: 0.12, pedestrian: 0, footway: 0, cycleway: 0, path: 0, steps: 0,
};

export const LANE_W = 3.3;

export function makePoly(xs: number[], zs: number[]): Poly {
  const n = xs.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  return { xs: Float64Array.from(xs), zs: Float64Array.from(zs), cum, len: n ? cum[n - 1] : 0 };
}

/** Sample position + heading at arc length s (clamped). */
export function samplePoly(p: Poly, s: number, out: Sample = { x: 0, z: 0, h: 0 }): Sample {
  const n = p.xs.length;
  if (n === 1) { out.x = p.xs[0]; out.z = p.zs[0]; return out; }
  if (s <= 0) s = 0;
  if (s >= p.len) s = p.len;
  // binary search segment
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = p.cum[hi] - p.cum[lo];
  const t = seg > 1e-9 ? (s - p.cum[lo]) / seg : 0;
  const dx = p.xs[hi] - p.xs[lo], dz = p.zs[hi] - p.zs[lo];
  out.x = p.xs[lo] + dx * t;
  out.z = p.zs[lo] + dz * t;
  out.h = Math.atan2(dx, -dz);
  return out;
}

/** Offset a polyline to the right (+) / left (-) of its travel direction by d meters (mitered, clamped). */
export function offsetPoly(xs: ArrayLike<number>, zs: ArrayLike<number>, d: number): { xs: number[]; zs: number[] } {
  const n = xs.length;
  const ox: number[] = [], oz: number[] = [];
  for (let i = 0; i < n; i++) {
    let nx = 0, nz = 0;
    // right normal of direction (dx,dz) is (-dz, dx)
    if (i > 0) {
      const dx = xs[i] - xs[i - 1], dz = zs[i] - zs[i - 1];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l; nz += dx / l;
    }
    if (i < n - 1) {
      const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i];
      const l = Math.hypot(dx, dz) || 1;
      nx += -dz / l; nz += dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    // miter scale
    let scale = 1;
    if (i > 0 && i < n - 1) {
      const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i];
      const ll = Math.hypot(dx, dz) || 1;
      const cos = (-dz / ll) * nx + (dx / ll) * nz;
      scale = 1 / Math.max(0.5, cos);
    }
    ox.push(xs[i] + nx * d * scale);
    oz.push(zs[i] + nz * d * scale);
  }
  return { xs: ox, zs: oz };
}

/** Sub-polyline between arc lengths s0..s1. */
export function subPoly(p: Poly, s0: number, s1: number): Poly {
  const xs: number[] = [], zs: number[] = [];
  const a = samplePoly(p, s0);
  xs.push(a.x); zs.push(a.z);
  for (let i = 0; i < p.xs.length; i++) {
    if (p.cum[i] > s0 + 0.01 && p.cum[i] < s1 - 0.01) { xs.push(p.xs[i]); zs.push(p.zs[i]); }
  }
  const b = samplePoly(p, s1);
  xs.push(b.x); zs.push(b.z);
  return makePoly(xs, zs);
}

/** Cubic Bezier sampled into a polyline. */
export function bezierPoly(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, steps = 12): Poly {
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    xs.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0]);
    zs.push(a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
  }
  return makePoly(xs, zs);
}

export function segIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1x = bx - ax, d1z = bz - az, d2x = dx - cx, d2z = dz - cz;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((cx - ax) * d2z - (cz - az) * d2x) / den;
  const u = ((cx - ax) * d1z - (cz - az) * d1x) / den;
  return t > 0 && t < 1 && u > 0 && u < 1;
}

export interface NetEdge {
  /** index into net.edges */
  i: number;
  /** graph edge index */
  gi: number;
  from: number;
  to: number;
  cls: RoadClass;
  rank: number;
  speed: number;
  dirLanes: number;
  laneW: number;
  /** lateral offset of lane 0 center (right of travel), lanes step by +laneW toward the curb */
  lane0: number;
  center: Poly;
  len: number;
  trimStart: number;
  trimEnd: number;
  /** node-to-node bearing atan2(dz,dx) (for signalState) */
  bearing: number;
  /** heading at start/end of the centerline */
  hStart: number;
  hEnd: number;
  reverse: number; // index of the opposite-direction edge or -1
  width: number;
  sidewalk: number;
  lanePolys: (Poly | null)[];
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export interface NetNode {
  id: number;
  x: number;
  z: number;
  y: number;
  signal: boolean;
  stop: boolean;
  /** number of distinct neighbour nodes (undirected) over drivable edges */
  degree: number;
  maxRank: number;
  /** distinct neighbours reached via edges of rank == maxRank (>= 3 means equal-priority crossing) */
  majorCount: number;
  /** junction radius: lanes are trimmed by this much at the node */
  radius: number;
  axis: number;
  out: number[];
  in: number[];
}

/** Undirected pedestrian segment (sidewalks both sides of a road, or a footway). */
export interface PedSeg {
  i: number;
  a: number;
  b: number;
  center: Poly;
  /** sidewalk centerline offset from road centerline (0 for footways) */
  off: number;
  sides: number[]; // [1,-1] or [0]
  cls: RoadClass;
  width: number;
  hasSidewalk: boolean;
  trimA: number;
  trimB: number;
  polys: Map<number, Poly>;
  minX: number; minZ: number; maxX: number; maxZ: number;
}

export class RoadNet {
  edges: NetEdge[] = [];
  nodes: NetNode[] = [];
  peds: PedSeg[] = [];
  edgeGrid = new StaticGrid(64);
  pedGrid = new StaticGrid(64);
  /** per node: ped seg indices */
  nodePeds: number[][] = [];
  /** per node: max pedestrian corner radius */
  pedRadius: number[] = [];
  private turnCache = new Map<string, Poly>();
  totalDensity = 0;

  recipe: Recipe;
  constructor(recipe: Recipe) {
    this.recipe = recipe;
    const g = recipe.graph;
    const roads = new Map<string, RecipeRoad>();
    for (const r of recipe.roads) roads.set(r.id, r);
    this.nodes = g.nodes.map((n, id) => ({
      id, x: n.p[0], z: n.p[1], y: n.y, signal: !!n.signal, stop: !!n.stop, degree: 0, maxRank: 0, majorCount: 0, radius: 0, axis: 0, out: [], in: [],
    }));
    const neigh: Set<number>[] = this.nodes.map(() => new Set());
    const pairKey = new Map<string, number>();
    const pedKey = new Set<string>();
    const nodeMaxHalfW: number[] = this.nodes.map(() => 0);
    const nodePedR: number[] = this.nodes.map(() => 0);
    this.nodePeds = this.nodes.map(() => []);

    g.edges.forEach((ge, gi) => {
      const road = roads.get(ge.roadId);
      const a = g.nodes[ge.from], b = g.nodes[ge.to];
      if (!a || !b || ge.from === ge.to) return;
      const cls = (road?.cls ?? ge.cls) as RoadClass;
      const center = extractCenter(road, a.p, b.p);
      if (center.len < 0.5) return;
      const width = road?.width ?? Math.max(6, ge.lanes * LANE_W);
      const sidewalk = road?.sidewalk ?? 0;
      nodeMaxHalfW[ge.from] = Math.max(nodeMaxHalfW[ge.from], width / 2);
      nodeMaxHalfW[ge.to] = Math.max(nodeMaxHalfW[ge.to], width / 2);

      // pedestrian segments (undirected)
      const pk = ge.from < ge.to ? `${ge.from}_${ge.to}_${ge.roadId}` : `${ge.to}_${ge.from}_${ge.roadId}`;
      if (!pedKey.has(pk) && cls !== 'motorway' && cls !== 'trunk') {
        pedKey.add(pk);
        const walkOnly = WALKONLY.has(cls);
        const sw = walkOnly ? 0 : sidewalk;
        const off = walkOnly ? 0 : Math.max(2.5, width / 2) + Math.max(sw, 1.4) / 2;
        const ps: PedSeg = {
          i: this.peds.length, a: ge.from, b: ge.to, center, off, sides: walkOnly ? [0] : [1, -1], cls, width,
          hasSidewalk: walkOnly || sw > 0.5, trimA: 0, trimB: 0, polys: new Map(), ...bbox(center),
        };
        this.peds.push(ps);
        this.nodePeds[ge.from].push(ps.i);
        this.nodePeds[ge.to].push(ps.i);
        if (!walkOnly) {
          nodePedR[ge.from] = Math.max(nodePedR[ge.from], width / 2 + Math.max(sw, 1.4));
          nodePedR[ge.to] = Math.max(nodePedR[ge.to], width / 2 + Math.max(sw, 1.4));
        }
      }

      if (!DRIVABLE.has(cls)) return;
      neigh[ge.from].add(ge.to);
      neigh[ge.to].add(ge.from);
      const oneway = road ? road.oneway : false;
      const totalLanes = Math.max(1, road?.lanes ?? ge.lanes ?? 2);
      const dirLanes = oneway ? totalLanes : Math.max(1, Math.floor(totalLanes / 2));
      const lanesAcross = oneway ? dirLanes : dirLanes * 2;
      const laneW = Math.max(2.5, Math.min(LANE_W, width / lanesAcross));
      const lane0 = oneway ? (0.5 - dirLanes / 2) * laneW : 0.5 * laneW;
      const n = center.xs.length;
      const e: NetEdge = {
        i: this.edges.length, gi, from: ge.from, to: ge.to, cls, rank: CLASS_RANK[cls] ?? 1,
        speed: Math.max(4, ge.speed || road?.maxSpeed || 11), dirLanes, laneW, lane0, center, len: center.len,
        trimStart: 0, trimEnd: 0,
        bearing: Math.atan2(b.p[1] - a.p[1], b.p[0] - a.p[0]),
        hStart: Math.atan2(center.xs[1] - center.xs[0], -(center.zs[1] - center.zs[0])),
        hEnd: Math.atan2(center.xs[n - 1] - center.xs[n - 2], -(center.zs[n - 1] - center.zs[n - 2])),
        reverse: -1, width, sidewalk, lanePolys: new Array(dirLanes).fill(null), ...bbox(center),
      };
      this.edges.push(e);
      this.nodes[ge.from].out.push(e.i);
      this.nodes[ge.to].in.push(e.i);
      const k = `${ge.from}_${ge.to}`;
      const rk = `${ge.to}_${ge.from}`;
      if (pairKey.has(rk)) {
        const r = pairKey.get(rk)!;
        this.edges[r].reverse = e.i;
        e.reverse = r;
      }
      pairKey.set(k, e.i);
    });

    for (const nd of this.nodes) {
      nd.degree = neigh[nd.id].size;
      for (const ei of [...nd.out, ...nd.in]) nd.maxRank = Math.max(nd.maxRank, this.edges[ei].rank);
      const majors = new Set<number>();
      for (const ei of [...nd.out, ...nd.in]) {
        const e = this.edges[ei];
        if (e.rank === nd.maxRank) majors.add(e.from === nd.id ? e.to : e.from);
      }
      nd.majorCount = majors.size;
      nd.radius = nd.degree >= 3 ? nodeMaxHalfW[nd.id] + 2.0 : nd.degree === 2 ? 1.5 : 0;
      if (nd.signal) {
        try { nd.axis = signalAxis(g, nd.id); } catch { nd.axis = 0; }
      }
      this.pedRadius[nd.id] = nd.degree >= 3 || this.nodePeds[nd.id].length >= 3 ? nodePedR[nd.id] : 0;
    }
    for (const e of this.edges) {
      e.trimStart = Math.min(this.nodes[e.from].radius, e.len * 0.4);
      e.trimEnd = Math.min(this.nodes[e.to].radius, e.len * 0.4);
      this.edgeGrid.addBox(e.i, e.minX, e.minZ, e.maxX, e.maxZ);
      this.totalDensity += e.len * (CLASS_DENSITY[e.cls] ?? 0.3) * e.dirLanes;
    }
    for (const p of this.peds) {
      p.trimA = Math.min(this.pedRadius[p.a], p.center.len * 0.45);
      p.trimB = Math.min(this.pedRadius[p.b], p.center.len * 0.45);
      this.pedGrid.addBox(p.i, p.minX, p.minZ, p.maxX, p.maxZ);
    }
  }

  /** Offset polyline for lane `lane` of edge e (full length; usable range is [trimStart, len-trimEnd]). */
  lanePoly(e: NetEdge, lane: number): Poly {
    lane = Math.max(0, Math.min(e.dirLanes - 1, lane));
    let p = e.lanePolys[lane];
    if (!p) {
      const off = e.lane0 + lane * e.laneW;
      const o = offsetPoly(e.center.xs, e.center.zs, off);
      p = makePoly(o.xs, o.zs);
      // rescale cum so arc lengths match the centerline (keeps s consistent across lanes)
      const k = p.len > 0 ? e.len / p.len : 1;
      for (let i = 0; i < p.cum.length; i++) p.cum[i] *= k;
      p.len = e.len;
      e.lanePolys[lane] = p;
    }
    return p;
  }

  laneStart(e: NetEdge) { return e.trimStart; }
  laneEnd(e: NetEdge) { return Math.max(e.trimStart + 0.1, e.len - e.trimEnd); }

  /** Signed turn angle from edge a into edge b (radians, + = right turn, since headings are clockwise). */
  turnAngle(a: NetEdge, b: NetEdge): number {
    let d = (b.hStart - a.hEnd) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Candidate next edges out of a's end node (U-turn only when nothing else). */
  nextEdges(a: NetEdge): number[] {
    const nd = this.nodes[a.to];
    const res = nd.out.filter((i) => this.edges[i].to !== a.from);
    if (res.length) return res;
    return nd.out.slice();
  }

  /** Random next edge with a preference for going straight and staying on bigger roads. */
  chooseNext(a: NetEdge, rnd: () => number): number {
    const c = this.nextEdges(a);
    if (!c.length) return -1;
    if (c.length === 1) return c[0];
    let tot = 0;
    const w = c.map((i) => {
      const b = this.edges[i];
      const ang = Math.abs(this.turnAngle(a, b));
      let x = ang < 0.5 ? 2.2 : ang < 2.4 ? 1.0 : 0.15;
      x *= 0.4 + 0.2 * b.rank;
      tot += x;
      return x;
    });
    let r = rnd() * tot;
    for (let k = 0; k < c.length; k++) { r -= w[k]; if (r <= 0) return c[k]; }
    return c[c.length - 1];
  }

  /** Lane to use on b when coming from lane `lane` of a. */
  targetLane(a: NetEdge, lane: number, b: NetEdge): number {
    const ang = this.turnAngle(a, b);
    if (ang > 0.6) return b.dirLanes - 1; // right turn → curb lane
    if (ang < -0.6) return 0; // left turn → inner lane
    return Math.min(lane, b.dirLanes - 1);
  }

  /** Smooth Bezier through the junction from lane end of a to lane start of b. */
  turnPoly(a: NetEdge, laneA: number, b: NetEdge, laneB: number): Poly {
    const key = `${a.i}:${laneA}:${b.i}:${laneB}`;
    let p = this.turnCache.get(key);
    if (p) return p;
    const pa = samplePoly(this.lanePoly(a, laneA), this.laneEnd(a));
    const pb = samplePoly(this.lanePoly(b, laneB), this.laneStart(b));
    const chord = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const uturn = b.i === a.reverse || Math.abs(this.turnAngle(a, b)) > 2.6;
    const k = uturn ? Math.max(5, chord) : Math.max(0.5, chord * 0.42);
    const da: Vec2 = [Math.sin(a.hEnd), -Math.cos(a.hEnd)];
    const db: Vec2 = [Math.sin(b.hStart), -Math.cos(b.hStart)];
    p = bezierPoly([pa.x, pa.z], [pa.x + da[0] * k, pa.z + da[1] * k], [pb.x - db[0] * k, pb.z - db[1] * k], [pb.x, pb.z], uturn ? 16 : 10);
    if (this.turnCache.size > 4000) this.turnCache.clear();
    this.turnCache.set(key, p);
    return p;
  }

  /** Max comfortable speed through a turn polyline. */
  turnSpeed(p: Poly, cap: number): number {
    const n = p.xs.length;
    const h0 = Math.atan2(p.xs[1] - p.xs[0], -(p.zs[1] - p.zs[0]));
    const h1 = Math.atan2(p.xs[n - 1] - p.xs[n - 2], -(p.zs[n - 1] - p.zs[n - 2]));
    let d = Math.abs(h1 - h0) % (Math.PI * 2);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < 0.25) return cap;
    const R = p.len / d;
    return Math.max(3.5, Math.min(cap, Math.sqrt(3.2 * R)));
  }

  /** Edges near a point (bbox based). */
  edgesNear(x: number, z: number, r: number): number[] {
    return [...this.edgeGrid.query(x, z, r)];
  }

  /** Nearest lane position on any edge near (x,z). */
  nearestLane(x: number, z: number, r = 40, heading?: number): { e: number; lane: number; s: number; d: number } | null {
    let best: { e: number; lane: number; s: number; d: number } | null = null;
    for (const ei of this.edgeGrid.query(x, z, r)) {
      const e = this.edges[ei];
      if (heading !== undefined) {
        // reject edges pointing the other way
        const pr = projectPoly(e.center, x, z);
        const sm = samplePoly(e.center, pr.s);
        let dh = Math.abs(sm.h - heading) % (Math.PI * 2);
        if (dh > Math.PI) dh = Math.PI * 2 - dh;
        if (dh > Math.PI * 0.55) continue;
      }
      for (let l = 0; l < e.dirLanes; l++) {
        const pr = projectPoly(this.lanePoly(e, l), x, z);
        if (!best || pr.d < best.d) best = { e: ei, lane: l, s: pr.s, d: pr.d };
      }
    }
    return best;
  }

  /** Nearest node (with drivable out-edges) to (x,z). */
  nearestNode(x: number, z: number, r = 150): number {
    let best = -1, bd = Infinity;
    for (let rr = r; best < 0 && rr <= 2000; rr *= 2) {
      for (const ei of this.edgeGrid.query(x, z, rr)) {
        const e = this.edges[ei];
        for (const n of [e.from, e.to]) {
          const nd = this.nodes[n];
          if (!nd.out.length) continue;
          const d = (nd.x - x) ** 2 + (nd.z - z) ** 2;
          if (d < bd) { bd = d; best = n; }
        }
      }
    }
    return best;
  }

  /** A* shortest travel-time path over drivable edges. Returns node ids (from..to) or []. */
  route(from: number, to: number, maxExpand = 20000): number[] {
    if (from < 0 || to < 0) return [];
    if (from === to) return [from];
    const N = this.nodes;
    const g = new Map<number, number>([[from, 0]]);
    const prev = new Map<number, number>();
    const tx = N[to].x, tz = N[to].z;
    const vmax = 30;
    const h = (n: number) => Math.hypot(N[n].x - tx, N[n].z - tz) / vmax;
    const heap: [number, number][] = [[h(from), from]];
    const closed = new Set<number>();
    let expanded = 0;
    while (heap.length && expanded++ < maxExpand) {
      // pop min
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m], heap[i]];
          i = m;
        }
      }
      const n = top[1];
      if (closed.has(n)) continue;
      if (n === to) break;
      closed.add(n);
      const gn = g.get(n)!;
      for (const ei of N[n].out) {
        const e = this.edges[ei];
        const cost = gn + e.len / e.speed + (N[e.to].signal ? 4 : 0);
        if (cost < (g.get(e.to) ?? Infinity)) {
          g.set(e.to, cost);
          prev.set(e.to, n);
          // push
          heap.push([cost + h(e.to), e.to]);
          let i = heap.length - 1;
          while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            [heap[p], heap[i]] = [heap[i], heap[p]];
            i = p;
          }
        }
      }
    }
    if (!prev.has(to)) return [];
    const path = [to];
    let c = to;
    while (c !== from) { c = prev.get(c)!; path.push(c); }
    return path.reverse();
  }

  /** Sidewalk polyline for ped segment side (+1 right of a→b, -1 left, 0 center). Oriented a→b. */
  pedPoly(ps: PedSeg, side: number): Poly {
    let p = ps.polys.get(side);
    if (!p) {
      if (side === 0) p = ps.center;
      else {
        const o = offsetPoly(ps.center.xs, ps.center.zs, side * ps.off);
        p = makePoly(o.xs, o.zs);
        const k = p.len > 0 ? ps.center.len / p.len : 1;
        for (let i = 0; i < p.cum.length; i++) p.cum[i] *= k;
        p.len = ps.center.len;
      }
      ps.polys.set(side, p);
    }
    return p;
  }
}

function bbox(p: Poly) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.xs.length; i++) {
    minX = Math.min(minX, p.xs[i]); maxX = Math.max(maxX, p.xs[i]);
    minZ = Math.min(minZ, p.zs[i]); maxZ = Math.max(maxZ, p.zs[i]);
  }
  return { minX, minZ, maxX, maxZ };
}

/** Road polyline between graph node positions a→b (falls back to a straight segment). */
function extractCenter(road: RecipeRoad | undefined, a: Vec2, b: Vec2): Poly {
  if (road && road.pts.length >= 2) {
    let ia = -1, ib = -1, da = Infinity, db = Infinity;
    for (let k = 0; k < road.pts.length; k++) {
      const p = road.pts[k];
      const d1 = (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
      const d2 = (p[0] - b[0]) ** 2 + (p[1] - b[1]) ** 2;
      if (d1 < da) { da = d1; ia = k; }
      if (d2 < db) { db = d2; ib = k; }
    }
    if (ia >= 0 && ib >= 0 && ia !== ib && da < 25 && db < 25) {
      const xs: number[] = [], zs: number[] = [];
      const step = ia < ib ? 1 : -1;
      for (let k = ia; k !== ib + step; k += step) {
        const p = road.pts[k];
        if (xs.length && Math.abs(p[0] - xs[xs.length - 1]) + Math.abs(p[1] - zs[zs.length - 1]) < 0.05) continue;
        xs.push(p[0]); zs.push(p[1]);
      }
      if (xs.length >= 2) return makePoly(xs, zs);
    }
  }
  return makePoly([a[0], b[0]], [a[1], b[1]]);
}

/** Closest point projection onto a polyline: arc length s and distance d. */
export function projectPoly(p: Poly, x: number, z: number): { s: number; d: number } {
  let best = Infinity, bs = 0;
  for (let i = 0; i < p.xs.length - 1; i++) {
    const ax = p.xs[i], az = p.zs[i];
    const dx = p.xs[i + 1] - ax, dz = p.zs[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) { best = d2; bs = p.cum[i] + (p.cum[i + 1] - p.cum[i]) * t; }
  }
  return { s: bs, d: Math.sqrt(best) };
}
