// Road network assembly: chains, junction polygons with filleted curbs, raised sidewalks, markings, paths, bridges.
import * as THREE from 'three';
import type { Recipe, RecipeRoad, Vec2, RoadClass } from '../core/types';
import { ChunkBatcher, MeshBuilder, Grid, cumLen, sampleAt, slicePolyline, polyNormals, lineIntersect, dist2, triangulate, pointInPoly } from './util';
import type { Heightfield } from './terrain';

export const VEHICULAR = new Set<RoadClass>(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'unclassified']);
export const PATHS = new Set<RoadClass>(['footway', 'cycleway', 'path', 'steps', 'pedestrian']);
const ARTERIAL = new Set<RoadClass>(['motorway', 'trunk', 'primary', 'secondary']);

export const CURB_H = 0.15;
const ROAD_LIFT = 0.0;
const MARK_LIFT = 0.012;
const YELLOW = new THREE.Color('#d9a21b').convertSRGBToLinear();
const WHITE = new THREE.Color('#e9e9e4').convertSRGBToLinear();

export interface Chain {
  idx: number;
  road: RecipeRoad;
  pts: Vec2[]; ys: number[]; L: number[]; len: number;
  w: number; s: number; lanes: number; oneway: boolean; cls: RoadClass; bridge: boolean; tunnel: boolean;
  /** Per-side sidewalk widths (left / right of pts direction) when the recipe gives them; else both = s. */
  sL?: number; sR?: number;
  ends: [string | null, string | null];
  trim: [number, number];
  /** Sidewalk start distance from each end, per chain side [side -p, side +p]. */
  sw: [[number, number], [number, number]];
  /** Crosswalk at end / stop control at end. */
  cross: [boolean, boolean];
  stopCtl: [boolean, boolean];
  /** Short link inside a merged junction cluster: not rendered separately. */
  internal?: boolean;
}

export interface JunctionArm { chain: Chain; atStart: boolean; /** chain end point (arm origin) */ o: Vec2; u: Vec2; w: number; s: number; trim: number; ang: number }
export interface Junction { key: string; p: Vec2; y: number; arms: JunctionArm[]; signal: boolean; stop: boolean; graphNode: number }

export interface SurfaceSeg { ax: number; az: number; bx: number; bz: number; ya: number; yb: number; o0: number; o1: number; kind: 'sidewalk' | 'deck' | 'road' }

export class RoadNetwork {
  chains: Chain[] = [];
  junctions = new Map<string, Junction>();
  /** Segments for surface queries (groundAt, sidewalk sampling). */
  segGrid = new Grid<SurfaceSeg>(24);
  /** Walkable sample points for pedestrians. */
  walkPts: Vec2[] = [];
  walkGrid = new Grid<number>(40);
  /** Vehicular corridor grid (for path clipping / placement). */
  private corr = new Grid<{ c: Chain; i: number }>(30);
  private cornerGrid = new Grid<{ poly: Vec2[]; y: number }>(24);
  private jGrid = new Grid<Junction>(40);
  paths: RecipeRoad[] = [];

  constructor(private recipe: Recipe) {}

  analyze() {
    const R = this.recipe;
    const keyOf = (r: RecipeRoad, i: number) => (r.nodes && r.nodes.length === r.pts.length && r.nodes[i] != null ? 'n' + r.nodes[i] : `p${Math.round(r.pts[i][0] * 2)},${Math.round(r.pts[i][1] * 2)}`);
    const veh = R.roads.filter((r) => VEHICULAR.has(r.cls) && r.pts.length >= 2 && !r.tunnel);
    this.paths = R.roads.filter((r) => PATHS.has(r.cls) && r.pts.length >= 2 && !r.tunnel);
    const deg = new Map<string, number>();
    for (const r of veh) r.pts.forEach((_, i) => { const k = keyOf(r, i); deg.set(k, (deg.get(k) ?? 0) + (i === 0 || i === r.pts.length - 1 ? 1 : 2)); });
    // split at junction nodes
    type Seg = { road: RecipeRoad; pts: Vec2[]; ys: number[]; k0: string; k1: string };
    let segs: Seg[] = [];
    for (const r of veh) {
      let start = 0;
      for (let i = 1; i < r.pts.length; i++) {
        const k = keyOf(r, i);
        if (i === r.pts.length - 1 || (deg.get(k) ?? 0) >= 3) {
          const pts = r.pts.slice(start, i + 1), ys = (r.ys ?? []).slice(start, i + 1);
          while (ys.length < pts.length) ys.push(ys[ys.length - 1] ?? 0);
          segs.push({ road: r, pts, ys, k0: keyOf(r, start), k1: k });
          start = i;
        }
      }
    }
    // dedupe consecutive identical points
    for (const s of segs) {
      const P: Vec2[] = [], Y: number[] = [];
      s.pts.forEach((p, i) => { if (!P.length || dist2(P[P.length - 1], p) > 0.05) { P.push(p); Y.push(s.ys[i]); } });
      s.pts = P; s.ys = Y;
    }
    segs = segs.filter((s) => s.pts.length >= 2);
    // merge through degree-2 nodes with compatible attributes
    const sym = (r: RecipeRoad) => r.sidewalkL === undefined || r.sidewalkL === r.sidewalkR; // one-sided sidewalks: never merged (orientation matters)
    const compatible = (a: RecipeRoad, b: RecipeRoad) => Math.abs(a.width - b.width) < 0.6 && Math.abs(a.sidewalk - b.sidewalk) < 0.3 && a.lanes === b.lanes && a.oneway === b.oneway && !!a.bridge === !!b.bridge && sym(a) && sym(b);
    const ends = new Map<string, Seg[]>();
    const addEnd = (k: string, s: Seg) => { let l = ends.get(k); if (!l) ends.set(k, (l = [])); if (!l.includes(s)) l.push(s); };
    for (const s of segs) { addEnd(s.k0, s); addEnd(s.k1, s); }
    const alive = new Set(segs);
    for (const [k, list] of ends) {
      if (list.length !== 2 || (deg.get(k) ?? 0) !== 2) continue;
      let [a, b] = list;
      if (a === b || !alive.has(a) || !alive.has(b) || !compatible(a.road, b.road)) continue;
      // orient: a ends at k, b starts at k
      if (a.k1 !== k) { if (a.road.oneway) continue; a.pts.reverse(); a.ys.reverse(); [a.k0, a.k1] = [a.k1, a.k0]; }
      if (b.k0 !== k) { if (b.road.oneway) continue; b.pts.reverse(); b.ys.reverse(); [b.k0, b.k1] = [b.k1, b.k0]; }
      if (a.k1 !== k || b.k0 !== k) continue;
      a.pts = a.pts.concat(b.pts.slice(1)); a.ys = a.ys.concat(b.ys.slice(1)); a.k1 = b.k1;
      alive.delete(b);
      // re-point b's other end to a
      const lst = ends.get(b.k1)!; const bi = lst.indexOf(b); if (bi >= 0) lst[bi] = a;
      list.length = 0;
    }
    const final = [...alive];
    // build chains
    const nodeCount = new Map<string, number>();
    for (const s of final) { nodeCount.set(s.k0, (nodeCount.get(s.k0) ?? 0) + 1); nodeCount.set(s.k1, (nodeCount.get(s.k1) ?? 0) + 1); }
    for (const s of final) {
      const r = s.road;
      const L = cumLen(s.pts);
      const w = Math.max(2.5, r.width / 2);
      const c: Chain = {
        idx: this.chains.length, road: r, pts: s.pts, ys: s.ys, L, len: L[L.length - 1], w,
        s: r.bridge && r.sidewalk > 0 ? Math.min(2, r.sidewalk) : r.sidewalk, lanes: Math.max(1, r.lanes | 0), oneway: r.oneway, cls: r.cls,
        bridge: !!r.bridge, tunnel: !!r.tunnel,
        ends: [(nodeCount.get(s.k0) ?? 0) >= 2 ? s.k0 : null, (nodeCount.get(s.k1) ?? 0) >= 2 ? s.k1 : null],
        trim: [0, 0], sw: [[0, 0], [0, 0]], cross: [false, false], stopCtl: [false, false],
      };
      if (c.len < 0.5) continue;
      if (!sym(r)) { const cap = (v: number) => (r.bridge && v > 0 ? Math.min(2, v) : v); c.sL = cap(r.sidewalkL ?? r.sidewalk); c.sR = cap(r.sidewalkR ?? r.sidewalk); }
      this.chains.push(c);
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i], b = c.pts[i + 1], e = c.w + c.s + 2;
        this.corr.addBox(Math.min(a[0], b[0]) - e, Math.min(a[1], b[1]) - e, Math.max(a[0], b[0]) + e, Math.max(a[1], b[1]) + e, { c, i });
      }
    }
    // graph node lookup (by position) for signal/stop flags
    const gGrid = new Grid<number>(10);
    R.graph.nodes.forEach((n, i) => gGrid.add(n.p[0], n.p[1], i));
    const findGraphNode = (p: Vec2) => {
      let best = -1, bd = 3;
      gGrid.query(p[0], p[1], 3, (i) => { const d = dist2(R.graph.nodes[i].p, p); if (d < bd) { bd = d; best = i; } });
      return best;
    };
    // junctions
    for (const c of this.chains) for (const e of [0, 1] as const) {
      const k = c.ends[e]; if (!k) continue;
      let J = this.junctions.get(k);
      const p = e === 0 ? c.pts[0] : c.pts[c.pts.length - 1];
      if (!J) {
        const gi = findGraphNode(p);
        const gn = gi >= 0 ? R.graph.nodes[gi] : undefined;
        J = { key: k, p, y: 0, arms: [], signal: !!gn?.signal, stop: !!gn?.stop, graphNode: gn ? gn.id : -1 };
        this.junctions.set(k, J);
      }
      const d = Math.min(10, c.len * 0.5);
      const q = sampleAt(c.pts, c.L, e === 0 ? d : c.len - d);
      let ux = q.x - p[0], uz = q.z - p[1]; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
      J.arms.push({ chain: c, atStart: e === 0, o: p, u: [ux, uz], w: c.w, s: c.s, trim: 0.3, ang: Math.atan2(uz, ux) });
    }
    this.mergeClusters();
    for (const J of this.junctions.values()) {
      this.jGrid.add(J.p[0], J.p[1], J);
      J.arms.sort((a, b) => a.ang - b.ang);
      J.y = J.arms.reduce((s, a) => s + (a.atStart ? a.chain.ys[0] : a.chain.ys[a.chain.ys.length - 1]), 0) / J.arms.length;
      this.computeTrims(J);
    }
  }

  /** Merge junctions linked by very short chains (OSM double nodes, divided roads) into one polygon. */
  private mergeClusters() {
    const parent = new Map<string, string>();
    const find = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(k, r); return r; };
    for (const k of this.junctions.keys()) parent.set(k, k);
    const maxW = (J: Junction) => Math.max(...J.arms.map((a) => a.w));
    for (const c of this.chains) {
      const [k0, k1] = c.ends;
      if (!k0 || !k1 || k0 === k1) continue;
      const J0 = this.junctions.get(k0)!, J1 = this.junctions.get(k1)!;
      if (J0.arms.length < 3 && J1.arms.length < 3) continue;
      const thr = 2 * Math.max(maxW(J0), maxW(J1)) + 4;
      if (c.len < thr) { c.internal = true; parent.set(find(k0), find(k1)); }
    }
    const groups = new Map<string, Junction[]>();
    for (const [k, J] of this.junctions) { const r = find(k); (groups.get(r) ?? groups.set(r, []).get(r)!).push(J); }
    for (const [root, members] of groups) {
      if (members.length < 2) continue;
      const keys = new Set(members.map((m) => m.key));
      const p: Vec2 = [members.reduce((s, m) => s + m.p[0], 0) / members.length, members.reduce((s, m) => s + m.p[1], 0) / members.length];
      const sig = members.find((m) => m.signal);
      const J: Junction = {
        key: root, p, y: 0, arms: [], signal: !!sig, stop: members.some((m) => m.stop),
        graphNode: sig ? sig.graphNode : members.find((m) => m.graphNode >= 0)?.graphNode ?? -1,
      };
      for (const m of members) for (const a of m.arms) {
        const c = a.chain;
        if (c.internal && c.ends[0] && c.ends[1] && keys.has(c.ends[0]) && keys.has(c.ends[1])) continue;
        const q: Vec2 = [a.o[0] + a.u[0] * 8 - p[0], a.o[1] + a.u[1] * 8 - p[1]];
        a.ang = Math.atan2(q[1], q[0]);
        J.arms.push(a);
      }
      for (const m of members) this.junctions.delete(m.key);
      if (J.arms.length) this.junctions.set(root, J);
    }
  }

  private cornerRadius(A: JunctionArm, B: JunctionArm) {
    return Math.min(7, 2.5 + 0.22 * (A.w + B.w));
  }

  /** Geometry of corner between arm A (its +p side) and next arm B (its -p side). */
  private corner(J: Junction, A: JunctionArm, B: JunctionArm) {
    const P = J.p;
    let gap = B.ang - A.ang; if (gap <= 0) gap += Math.PI * 2;
    if (J.arms.length === 1) gap = Math.PI * 2;
    const pA: Vec2 = [-A.u[1], A.u[0]], pB: Vec2 = [-B.u[1], B.u[0]];
    const sA = A.s || B.s, sB = B.s || A.s;
    const straight = gap > (150 * Math.PI) / 180;
    if (straight) return { straight: true as const, sA, sB, pA, pB };
    const eA: Vec2 = [A.o[0] + pA[0] * A.w, A.o[1] + pA[1] * A.w], eB: Vec2 = [B.o[0] - pB[0] * B.w, B.o[1] - pB[1] * B.w];
    const X = lineIntersect(eA, A.u, eB, B.u);
    const oA: Vec2 = [A.o[0] + pA[0] * (A.w + sA), A.o[1] + pA[1] * (A.w + sA)], oB: Vec2 = [B.o[0] - pB[0] * (B.w + sB), B.o[1] - pB[1] * (B.w + sB)];
    const XO = lineIntersect(oA, A.u, oB, B.u);
    if (!X || !XO || X[0] < -1 || X[1] < -1 || X[0] > 45 || X[1] > 45) return { straight: true as const, sA, sB, pA, pB };
    const r = this.cornerRadius(A, B);
    return { straight: false as const, tA: Math.max(0, X[0]), tB: Math.max(0, X[1]), toA: XO[0], toB: XO[1], r, sA, sB, pA, pB, X: [eA[0] + A.u[0] * X[0], eA[1] + A.u[1] * X[0]] as Vec2, XOp: [oA[0] + A.u[0] * XO[0], oA[1] + A.u[1] * XO[0]] as Vec2 };
  }

  private computeTrims(J: Junction) {
    const n = J.arms.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const A = J.arms[i], B = J.arms[(i + 1) % n];
      const c = this.corner(J, A, B);
      if (!c.straight) {
        A.trim = Math.max(A.trim, c.tA + c.r);
        B.trim = Math.max(B.trim, c.tB + c.r);
      }
    }
    for (const a of J.arms) {
      a.trim = Math.min(a.trim, a.chain.len * 0.48, 40);
      const e = a.atStart ? 0 : 1;
      a.chain.trim[e] = a.trim;
      a.chain.sw[e] = [a.trim, a.trim];
      if (J.signal && n >= 3) a.chain.cross[e] = true;
      if ((J.signal || J.stop) && n >= 3) a.chain.stopCtl[e] = true;
    }
    // sidewalk starts per side (after trims known)
    for (let i = 0; i < n; i++) {
      const A = J.arms[i], B = J.arms[(i + 1) % n];
      const c = this.corner(J, A, B);
      if (c.straight) continue;
      const eA = A.atStart ? 0 : 1, eB = B.atStart ? 0 : 1;
      // A +p side → chain side index: atStart ? 1 : 0 ; B -p side → atStart ? 0 : 1
      const sideA = A.atStart ? 1 : 0, sideB = B.atStart ? 0 : 1;
      A.chain.sw[eA][sideA] = Math.min(A.chain.len * 0.49, Math.max(A.trim, c.toA));
      B.chain.sw[eB][sideB] = Math.min(B.chain.len * 0.49, Math.max(B.trim, c.toB));
    }
  }

  /** Terrain flattening under carriageways + sidewalks + junctions. Returns per-vertex flatten weight and the
   *  owner that set it (chain idx, −2 junction, −1 none) for the retaining-wall pass. */
  flattenTerrain(hf: Heightfield) {
    const best = new Float32Array(hf.cols * hf.rows).fill(0);
    const target = new Float32Array(hf.cols * hf.rows);
    const owner = new Int32Array(hf.cols * hf.rows).fill(-1);
    const BL = 5;
    let cur = -1;
    const apply = (ax: number, az: number, bx: number, bz: number, ya: number, yb: number, hw: number, _prio = false, drop = 0.03) => {
      const x0 = Math.min(ax, bx) - hw - BL, x1 = Math.max(ax, bx) + hw + BL, z0 = Math.min(az, bz) - hw - BL, z1 = Math.max(az, bz) + hw + BL;
      const c0 = Math.max(0, Math.floor((x0 - hf.ox) / hf.cell)), c1 = Math.min(hf.cols - 1, Math.ceil((x1 - hf.ox) / hf.cell));
      const r0 = Math.max(0, Math.floor((z0 - hf.oz) / hf.cell)), r1 = Math.min(hf.rows - 1, Math.ceil((z1 - hf.oz) / hf.cell));
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
        const x = hf.ox + cc * hf.cell, z = hf.oz + r * hf.cell;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        let wgt = d <= hw ? 1 : d >= hw + BL ? 0 : 1 - (d - hw) / BL;
        wgt = wgt * wgt * (3 - 2 * wgt);
        const k = r * hf.cols + cc;
        if (wgt > best[k] || wgt >= 0.999) {
          const y = ya + (yb - ya) * t - drop;
          if (wgt >= 0.999 && best[k] >= 0.999) { if (y < target[k]) { target[k] = y; owner[k] = cur; } } else { target[k] = y; owner[k] = cur; }
          best[k] = Math.max(best[k], wgt);
        }
      }
    };
    for (const c of this.chains) {
      if (c.bridge) continue;
      const hw = c.w + c.s + 0.6;
      cur = c.idx;
      for (let i = 0; i + 1 < c.pts.length; i++) apply(c.pts[i][0], c.pts[i][1], c.pts[i + 1][0], c.pts[i + 1][1], c.ys[i], c.ys[i + 1], hw);
    }
    for (const J of this.junctions.values()) {
      if (J.arms.every((a) => a.chain.bridge)) continue;
      const rad = Math.max(...J.arms.map((a) => dist2(a.o, J.p) + a.trim + a.s)) + 1;
      cur = -2;
      apply(J.p[0], J.p[1], J.p[0] + 0.01, J.p[1], J.y, J.y, rad, true, 0.06);
    }
    for (let k = 0; k < best.length; k++) if (best[k] > 0) hf.h[k] = hf.h[k] + (target[k] - hf.h[k]) * best[k];
    return { best, owner };
  }

  // ---------------------------------------------------------------- geometry
  build(B: ChunkBatcher, hf: Heightfield, crosswalkProps: Vec2[]) {
    for (const c of this.chains) if (!c.internal) this.buildChain(B, c);
    for (const J of this.junctions.values()) this.buildJunction(B, J);
    for (const c of this.chains) if (!c.internal) this.buildMarkings(B, c);
    for (const p of crosswalkProps) this.crosswalkAtPoint(B, p);
    for (const r of this.paths) this.buildPath(B, r, hf);
  }

  private yAt(c: Chain, s: number) { return sampleAt(c.pts, c.L, s, c.ys).y; }

  /** Ribbon between lateral offsets o0..o1 (chain frame, +p side positive) over arc s0..s1. */
  private ribbon(B: ChunkBatcher, mat: string, c: Chain, s0: number, s1: number, o0: number, o1: number, lift: number, uvMode: 'world' | 'along', color?: THREE.Color, uScale = 1) {
    if (s1 - s0 < 0.05) return;
    // split into ≤ 40 m pieces for chunking
    const pieces = Math.max(1, Math.ceil((s1 - s0) / 40));
    for (let pI = 0; pI < pieces; pI++) {
      const a = s0 + ((s1 - s0) * pI) / pieces, b = s0 + ((s1 - s0) * (pI + 1)) / pieces;
      const sl = slicePolyline(c.pts, c.ys, c.L, a, b);
      const nr = polyNormals(sl.pts);
      const mid = sampleAt(c.pts, c.L, (a + b) / 2);
      const mb = B.get(mat, mid.x, mid.z, !!color);
      let acc = a;
      let prev: [number, number] | null = null;
      for (let i = 0; i < sl.pts.length; i++) {
        if (i > 0) acc += dist2(sl.pts[i], sl.pts[i - 1]);
        const [x, z] = sl.pts[i], [nx, nz] = nr[i], y = sl.ys[i] + lift;
        const x0 = x + nx * o0, z0 = z + nz * o0, x1 = x + nx * o1, z1 = z + nz * o1;
        const i0 = mb.v(x0, y, z0, 0, 1, 0, uvMode === 'world' ? x0 : acc * uScale, uvMode === 'world' ? z0 : o0, color);
        const i1 = mb.v(x1, y, z1, 0, 1, 0, uvMode === 'world' ? x1 : acc * uScale, uvMode === 'world' ? z1 : o1, color);
        // winding: ensure up-facing triangles
        if (prev) mb.quadN(prev[0], prev[1], i0, i1, 0, 1, 0);
        prev = [i0, i1];
      }
    }
  }

  /** Vertical face along chain side at lateral offset o, from y+lo to y+hi, facing toward `faceSign` (±1 in p). */
  private wall(B: ChunkBatcher, mat: string, c: Chain, s0: number, s1: number, o: number, lo: number, hi: number, faceSign: number) {
    if (s1 - s0 < 0.05) return;
    const pieces = Math.max(1, Math.ceil((s1 - s0) / 40));
    for (let pI = 0; pI < pieces; pI++) {
      const a = s0 + ((s1 - s0) * pI) / pieces, b = s0 + ((s1 - s0) * (pI + 1)) / pieces;
      const sl = slicePolyline(c.pts, c.ys, c.L, a, b);
      const nr = polyNormals(sl.pts);
      const mid = sampleAt(c.pts, c.L, (a + b) / 2);
      const mb = B.get(mat, mid.x, mid.z);
      let acc = a; let prev: [number, number] | null = null;
      for (let i = 0; i < sl.pts.length; i++) {
        if (i > 0) acc += dist2(sl.pts[i], sl.pts[i - 1]);
        const [x, z] = sl.pts[i], [nx, nz] = nr[i], y = sl.ys[i];
        const X = x + nx * o, Z = z + nz * o;
        const nl = Math.hypot(nx, nz) || 1;
        const fx = (nx / nl) * faceSign, fz = (nz / nl) * faceSign;
        const i0 = mb.v(X, y + lo, Z, fx, 0, fz, acc, lo);
        const i1 = mb.v(X, y + hi, Z, fx, 0, fz, acc, hi);
        if (prev) mb.quadN(prev[0], prev[1], i0, i1, fx, 0, fz);
        prev = [i0, i1];
      }
    }
  }

  private buildChain(B: ChunkBatcher, c: Chain) {
    const s0 = c.trim[0], s1 = c.len - c.trim[1];
    const deck = c.bridge;
    this.ribbon(B, 'asphalt', c, s0, s1, -c.w, c.w, ROAD_LIFT, 'world');
    // surface segs for groundAt + corridor
    for (let i = 0; i + 1 < c.pts.length; i++) {
      const seg: SurfaceSeg = { ax: c.pts[i][0], az: c.pts[i][1], bx: c.pts[i + 1][0], bz: c.pts[i + 1][1], ya: c.ys[i], yb: c.ys[i + 1], o0: -c.w, o1: c.w, kind: deck ? 'deck' : 'road' };
      this.addSeg(seg, c.w + c.s + 1);
      const sR = c.sR ?? c.s, sL = c.sL ?? c.s;
      if (sR > 0) this.addSeg({ ...seg, o0: c.w, o1: c.w + sR, ya: seg.ya + CURB_H, yb: seg.yb + CURB_H, kind: deck ? 'deck' : 'sidewalk' }, c.w + c.s + 1);
      if (sL > 0) this.addSeg({ ...seg, o0: -c.w - sL, o1: -c.w, ya: seg.ya + CURB_H, yb: seg.yb + CURB_H, kind: deck ? 'deck' : 'sidewalk' }, c.w + c.s + 1);
    }
    if (c.s > 0) {
      for (const side of [0, 1] as const) {
        const sg = side === 1 ? 1 : -1;
        const cs = side === 1 ? (c.sR ?? c.s) : (c.sL ?? c.s);
        if (cs <= 0) continue;
        const a = c.sw[0][side], b = c.len - c.sw[1][side];
        const oIn = sg * c.w, oOut = sg * (c.w + cs);
        // sidewalk top (uv: along, across-from-curb)
        this.sidewalkRibbon(B, c, a, b, oIn, oOut);
        this.wall(B, 'curb', c, a, b, oIn, -0.05, CURB_H, -sg);
        this.wall(B, 'curb', c, a, b, oOut, deck ? -0.9 : -0.35, CURB_H, sg);
        // walk sample points
        for (let s = a + 2; s < b - 1; s += 5) {
          const q = sampleAt(c.pts, c.L, s);
          const nx = -q.dz, nz = q.dx, o = sg * (c.w + cs * 0.6);
          this.addWalk([q.x + nx * o, q.z + nz * o]);
        }
      }
    }
    if (deck) {
      const W = c.w + c.s;
      this.ribbonUnder(B, c, s0, s1, W, -0.9);
      for (const sg of [-1, 1]) {
        // concrete parapet
        this.wall(B, 'curb', c, s0, s1, sg * W, 0, 1.05, sg);
        this.wall(B, 'curb', c, s0, s1, sg * (W - 0.25), CURB_H, 1.05, -sg);
        this.ribbon(B, 'curb', c, s0, s1, sg * (W - 0.25), sg * W, 1.05, 'along');
      }
    }
  }

  private ribbonUnder(B: ChunkBatcher, c: Chain, s0: number, s1: number, W: number, depth: number) {
    // underside of bridge deck (downward-facing)
    const pieces = Math.max(1, Math.ceil((s1 - s0) / 40));
    for (let pI = 0; pI < pieces; pI++) {
      const a = s0 + ((s1 - s0) * pI) / pieces, b = s0 + ((s1 - s0) * (pI + 1)) / pieces;
      const sl = slicePolyline(c.pts, c.ys, c.L, a, b);
      const nr = polyNormals(sl.pts);
      const mb = B.get('curb', sl.pts[0][0], sl.pts[0][1]);
      let prev: [number, number] | null = null;
      for (let i = 0; i < sl.pts.length; i++) {
        const [x, z] = sl.pts[i], [nx, nz] = nr[i], y = sl.ys[i] + depth;
        const i0 = mb.v(x - nx * W, y, z - nz * W, 0, -1, 0, x, z), i1 = mb.v(x + nx * W, y, z + nz * W, 0, -1, 0, x + 1, z);
        if (prev) mb.quadN(prev[0], prev[1], i0, i1, 0, -1, 0);
        prev = [i0, i1];
      }
    }
  }

  private sidewalkRibbon(B: ChunkBatcher, c: Chain, a: number, b: number, oIn: number, oOut: number) {
    if (b - a < 0.05) return;
    const pieces = Math.max(1, Math.ceil((b - a) / 40));
    for (let pI = 0; pI < pieces; pI++) {
      const s0 = a + ((b - a) * pI) / pieces, s1 = a + ((b - a) * (pI + 1)) / pieces;
      const sl = slicePolyline(c.pts, c.ys, c.L, s0, s1);
      const nr = polyNormals(sl.pts);
      const mb = B.get('sidewalk', sl.pts[0][0], sl.pts[0][1]);
      let acc = s0; let prev: [number, number] | null = null;
      for (let i = 0; i < sl.pts.length; i++) {
        if (i > 0) acc += dist2(sl.pts[i], sl.pts[i - 1]);
        const [x, z] = sl.pts[i], [nx, nz] = nr[i], y = sl.ys[i] + CURB_H;
        const i0 = mb.v(x + nx * oIn, y, z + nz * oIn, 0, 1, 0, acc, 0);
        const i1 = mb.v(x + nx * oOut, y, z + nz * oOut, 0, 1, 0, acc, Math.abs(oOut - oIn));
        if (prev) mb.quadN(prev[0], prev[1], i0, i1, 0, 1, 0);
        prev = [i0, i1];
      }
    }
  }

  private addSeg(s: SurfaceSeg, pad: number) {
    this.segGrid.addBox(Math.min(s.ax, s.bx) - pad, Math.min(s.az, s.bz) - pad, Math.max(s.ax, s.bx) + pad, Math.max(s.az, s.bz) + pad, s);
  }
  private addWalk(p: Vec2) { const i = this.walkPts.length; this.walkPts.push(p); this.walkGrid.add(p[0], p[1], i); }

  private buildJunction(B: ChunkBatcher, J: Junction) {
    const n = J.arms.length;
    if (n < 2) return;
    const P = J.p, y = J.y;
    const poly: Vec2[] = [];
    const at = (A: JunctionArm, sign: number, off: number, t: number): Vec2 => {
      const p: Vec2 = [-A.u[1], A.u[0]];
      return [A.o[0] + p[0] * off * sign + A.u[0] * t, A.o[1] + p[1] * off * sign + A.u[1] * t];
    };
    const bez = (a: Vec2, c: Vec2, b: Vec2, k: number): Vec2[] => {
      const out: Vec2[] = [];
      for (let i = 1; i < k; i++) { const t = i / k, u = 1 - t; out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]); }
      return out;
    };
    for (let i = 0; i < n; i++) {
      const A = J.arms[i], Bm = J.arms[(i + 1) % n];
      poly.push(at(A, -1, A.w, A.trim), at(A, 1, A.w, A.trim));
      const c = this.corner(J, A, Bm);
      const curb: Vec2[] = [];
      if (!c.straight) {
        const fA = at(A, 1, A.w, c.tA + c.r), fB = at(Bm, -1, Bm.w, c.tB + c.r);
        const arc = [fA, ...bez(fA, c.X, fB, 10), fB];
        if (A.trim > c.tA + c.r + 0.02) poly.push(fA);
        poly.push(...bez(fA, c.X, fB, 10));
        if (Bm.trim > c.tB + c.r + 0.02) poly.push(fB);
        // sidewalk corner
        if (c.sA > 0 || c.sB > 0) {
          const eA = A.atStart ? 0 : 1, eB = Bm.atStart ? 0 : 1;
          const sideA = A.atStart ? 1 : 0, sideB = Bm.atStart ? 0 : 1;
          const sa0 = A.chain.sw[eA][sideA], sb0 = Bm.chain.sw[eB][sideB];
          const IA = at(A, 1, A.w, sa0), IB = at(Bm, -1, Bm.w, sb0);
          const OA = at(A, 1, A.w + c.sA, sa0), OB = at(Bm, -1, Bm.w + c.sB, sb0);
          curb.push(IA);
          if (sa0 > c.tA + c.r + 0.02) curb.push(fA);
          curb.push(...arc.slice(1, -1));
          if (sb0 > c.tB + c.r + 0.02) curb.push(fB);
          curb.push(IB);
          this.cornerPiece(B, J, curb, [OB, c.XOp, OA]);
        }
      } else if (c.sA > 0 || c.sB > 0) {
        const eA = A.atStart ? 0 : 1, eB = Bm.atStart ? 0 : 1;
        const sideA = A.atStart ? 1 : 0, sideB = Bm.atStart ? 0 : 1;
        const sa0 = A.chain.sw[eA][sideA], sb0 = Bm.chain.sw[eB][sideB];
        const IA = at(A, 1, A.w, sa0), IB = at(Bm, -1, Bm.w, sb0);
        const OA = at(A, 1, A.w + c.sA, sa0), OB = at(Bm, -1, Bm.w + c.sB, sb0);
        if (dist2(IA, IB) > 0.05 && dist2(IA, IB) < 60) this.cornerPiece(B, J, [IA, IB], [OB, OA]);
      }
    }
    // asphalt junction polygon
    let tri;
    try { tri = triangulate(poly); } catch { return; }
    const mb = B.get('asphalt', P[0], P[1]);
    const base = mb.count;
    for (const p of tri.pts) mb.v(p[0], y + ROAD_LIFT, p[1], 0, 1, 0, p[0], p[1]);
    for (let t = 0; t < tri.tris.length; t += 3) this.upTri(mb, base + tri.tris[t], base + tri.tris[t + 1], base + tri.tris[t + 2]);
    const jr = Math.max(...J.arms.map((a) => dist2(a.o, P) + Math.min(a.trim, Math.hypot(a.trim, a.w))));
    this.segGrid.addBox(P[0] - jr, P[1] - jr, P[0] + jr, P[1] + jr, { ax: P[0], az: P[1], bx: P[0] + 0.01, bz: P[1], ya: y, yb: y, o0: -jr, o1: jr, kind: J.arms.some((a) => a.chain.bridge) ? 'deck' : 'road' });
  }

  /** Ensure triangle faces up (+Y) given 2D xz positions in builder. */
  private upTri(mb: MeshBuilder, a: number, b: number, c: number) { mb.triN(a, b, c, 0, 1, 0); }

  /** Sidewalk corner: curb path (road side) + outer path; raised by CURB_H at junction y. */
  private cornerPiece(B: ChunkBatcher, J: Junction, curb: Vec2[], outer: Vec2[]) {
    const y = J.y + CURB_H;
    const poly = [...curb, ...outer];
    let tri;
    try { tri = triangulate(poly); } catch { return; }
    const mb = B.get('sidewalk', J.p[0], J.p[1]);
    const base = mb.count;
    for (const p of tri.pts) mb.v(p[0], y, p[1], 0, 1, 0, p[0], 5);
    for (let t = 0; t < tri.tris.length; t += 3) this.upTri(mb, base + tri.tris[t], base + tri.tris[t + 1], base + tri.tris[t + 2]);
    // curb face: faces toward the junction center
    const cb = B.get('curb', J.p[0], J.p[1]);
    for (let i = 0; i + 1 < curb.length; i++) this.vface(cb, curb[i], curb[i + 1], J.y - 0.05, y, J.p);
    for (let i = 0; i + 1 < outer.length; i++) this.vface(cb, outer[i], outer[i + 1], J.y - 0.35, y, null, J.p);
    for (const p of tri.pts) this.addWalk(p);
    const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
    this.cornerGrid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), { poly, y });
  }

  /** Vertical quad a→b facing toward `toward` (or away from `away`). */
  private vface(mb: MeshBuilder, a: Vec2, b: Vec2, lo: number, hi: number, toward: Vec2 | null, away?: Vec2) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 1e-3) return;
    let nx = -dz / l, nz = dx / l;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const ref = toward ?? away!;
    const toRef = (ref[0] - mx) * nx + (ref[1] - mz) * nz;
    if ((toward && toRef < 0) || (!toward && toRef > 0)) { nx = -nx; nz = -nz; }
    const i0 = mb.v(a[0], lo, a[1], nx, 0, nz, 0, lo), i1 = mb.v(b[0], lo, b[1], nx, 0, nz, l, lo);
    const i2 = mb.v(b[0], hi, b[1], nx, 0, nz, l, hi), i3 = mb.v(a[0], hi, a[1], nx, 0, nz, 0, hi);
    mb.triN(i0, i1, i2, nx, 0, nz); mb.triN(i0, i2, i3, nx, 0, nz);
  }

  // ---------------------------------------------------------------- markings
  private stripe(B: ChunkBatcher, c: Chain, s0: number, s1: number, off: number, width: number, color: THREE.Color, dash?: [number, number]) {
    if (s1 - s0 < 0.3) return;
    if (!dash) { this.ribbon(B, 'marking', c, s0, s1, off - width / 2, off + width / 2, MARK_LIFT, 'world', color); return; }
    const [on, offL] = dash;
    for (let s = s0 + ((c.idx * 3.7) % (on + offL)) * 0.2; s < s1; s += on + offL) this.ribbon(B, 'marking', c, s, Math.min(s1, s + on), off - width / 2, off + width / 2, MARK_LIFT, 'world', color);
  }

  private buildMarkings(B: ChunkBatcher, c: Chain) {
    if (c.cls === 'service' || c.cls === 'living_street' || c.bridge && c.w < 3) return;
    const a0 = c.trim[0] + (c.cross[0] ? 5.2 : c.stopCtl[0] ? 1.2 : 0.4);
    const a1 = c.len - c.trim[1] - (c.cross[1] ? 5.2 : c.stopCtl[1] ? 1.2 : 0.4);
    const W = c.w * 2;
    const arterial = ARTERIAL.has(c.cls);
    if (!c.oneway) {
      const perDir = Math.max(1, Math.floor(c.lanes / 2));
      const laneW = Math.min(3.6, c.w / perDir);
      if (c.lanes >= 2 && W >= 8.5 && a1 > a0) {
        this.stripe(B, c, a0, a1, -0.11, 0.1, YELLOW);
        this.stripe(B, c, a0, a1, 0.11, 0.1, YELLOW);
      }
      for (let k = 1; k < perDir; k++) for (const sg of [-1, 1]) this.stripe(B, c, a0, a1, sg * k * laneW, 0.1, WHITE, [3, 9]);
      if (arterial) {
        const edge = perDir * laneW < c.w - 1.8 ? perDir * laneW + 0.1 : c.w - 0.35;
        for (const sg of [-1, 1]) this.stripe(B, c, a0, a1, sg * edge, 0.12, WHITE);
      }
    } else {
      const laneW = Math.min(3.6, W / c.lanes);
      const used = laneW * c.lanes, left = -used / 2;
      for (let k = 1; k < c.lanes; k++) this.stripe(B, c, a0, a1, left + k * laneW, 0.1, WHITE, [3, 9]);
      if (arterial || c.lanes >= 2) { this.stripe(B, c, a0, a1, left + 0.15, 0.1, YELLOW); this.stripe(B, c, a0, a1, -left - 0.15, 0.12, WHITE); }
    }
    // stop bars + crosswalks
    for (const e of [0, 1] as const) {
      if (!c.ends[e]) continue;
      const trim = c.trim[e];
      if (c.len - c.trim[0] - c.trim[1] < 10) continue;
      const sAt = (d: number) => (e === 0 ? d : c.len - d);
      if (c.cross[e]) this.zebra(B, c, sAt(trim + 0.6), sAt(trim + 3.6));
      if (c.stopCtl[e]) {
        const d = trim + (c.cross[e] ? 4.4 : 0.6);
        // approaching traffic at end e: at end (e=1) moving forward → lanes on +p side; at start → -p side
        const sg = e === 1 ? 1 : -1;
        if (c.oneway) { if (e === 1) this.bar(B, c, sAt(d), -c.w + 0.2, c.w - 0.2); }
        else this.bar(B, c, sAt(d), sg > 0 ? 0.25 : -c.w + 0.3, sg > 0 ? c.w - 0.3 : -0.25);
      }
    }
  }

  private bar(B: ChunkBatcher, c: Chain, s: number, o0: number, o1: number) {
    this.ribbon(B, 'marking', c, s - 0.25, s + 0.25, o0, o1, MARK_LIFT, 'world', WHITE);
  }

  /** Continental (ladder) crosswalk between arc s0..s1 across full width. */
  private zebra(B: ChunkBatcher, c: Chain, sA: number, sB: number) {
    const s0 = Math.min(sA, sB), s1 = Math.max(sA, sB);
    const W = c.w - 0.4;
    // transverse edge lines
    this.ribbon(B, 'marking', c, s0, s0 + 0.2, -W, W, MARK_LIFT, 'world', WHITE);
    this.ribbon(B, 'marking', c, s1 - 0.2, s1, -W, W, MARK_LIFT, 'world', WHITE);
    // longitudinal bars (0.6 wide, 0.6 gap)
    for (let o = -W + 0.3; o < W - 0.3; o += 1.2) this.ribbon(B, 'marking', c, s0 + 0.3, s1 - 0.3, o, o + 0.6, MARK_LIFT, 'world', WHITE);
  }

  chainPoint(c: Chain, s: number) { return sampleAt(c.pts, c.L, s, c.ys); }

  /** Nearest chain point to p (within maxD). */
  nearestChain(p: Vec2, maxD = 20): { c: Chain; s: number; d: number; off: number } | null {
    let best: { c: Chain; s: number; d: number; off: number } | null = null;
    this.corr.query(p[0], p[1], maxD, ({ c, i }) => {
      const a = c.pts[i], b = c.pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
      const qx = a[0] + dx * t, qz = a[1] + dz * t;
      const d = Math.hypot(p[0] - qx, p[1] - qz);
      if (d < maxD && (!best || d < best.d)) {
        const l = Math.sqrt(l2);
        const off = ((p[0] - a[0]) * -dz + (p[1] - a[1]) * dx) / l;
        best = { c, s: c.L[i] + t * l, d, off };
      }
    });
    return best;
  }

  private crosswalkAtPoint(B: ChunkBatcher, p: Vec2) {
    const h = this.nearestChain(p, 12);
    if (!h) return;
    const { c, s } = h;
    if (s < c.trim[0] + 2 || s > c.len - c.trim[1] - 2) return;
    this.zebra(B, c, s - 1.5, s + 1.5);
  }

  /** Is point inside a vehicular corridor (carriageway + sidewalks)? */
  inCorridor(x: number, z: number, extra = 0): Chain | null {
    const h = this.nearestChain([x, z], 30);
    if (h && h.d < h.c.w + h.c.s + extra && h.s > 0.01 && h.s < h.c.len - 0.01) return h.c;
    let found: Chain | null = null;
    this.jGrid.query(x, z, 60, (J) => {
      if (found) return;
      const r = Math.max(...J.arms.map((a) => dist2(a.o, J.p) + Math.max(a.trim, a.w + a.s)));
      if (Math.hypot(J.p[0] - x, J.p[1] - z) < r + extra) found = J.arms[0].chain;
    });
    return found;
  }

  // ---------------------------------------------------------------- paths
  private buildPath(B: ChunkBatcher, r: RecipeRoad, hf: Heightfield) {
    const ped = r.cls === 'pedestrian';
    const width = ped ? Math.max(4, r.width + 2 * (r.sidewalk || 0)) : Math.max(1.4, Math.min(r.width || 2, 4));
    const hw = width / 2;
    const mat = ped || r.surface === 'paving' || r.surface === 'brick' ? 'paving' : r.cls === 'path' && r.surface !== 'asphalt' && r.surface !== 'concrete' ? 'gravel' : 'footway';
    const L = cumLen(r.pts);
    const len = L[L.length - 1];
    if (len < 0.5) return;
    const ys = r.ys && r.ys.length === r.pts.length ? r.ys : r.pts.map((p) => hf.sample(p[0], p[1]));
    // sample along path every ~1.5 m; mark samples inside vehicular corridors
    const n = Math.max(2, Math.ceil(len / 1.5) + 1);
    const S: { x: number; z: number; y: number; dx: number; dz: number; s: number; inside: Chain | null }[] = [];
    for (let i = 0; i < n; i++) {
      const s = (len * i) / (n - 1);
      const q = sampleAt(r.pts, L, s, ys);
      const inside = r.bridge ? null : this.inCorridor(q.x, q.z, ped ? 0 : -0.2);
      S.push({ x: q.x, z: q.z, y: r.bridge ? q.y : hf.sample(q.x, q.z), dx: q.dx, dz: q.dz, s, inside });
    }
    // crossing detection → crosswalk
    if (!ped && (r.cls === 'footway' || r.cls === 'cycleway')) {
      let i = 0;
      while (i < S.length) {
        if (!S[i].inside) { i++; continue; }
        let j = i; while (j + 1 < S.length && S[j + 1].inside === S[i].inside) j++;
        const c = S[i].inside!;
        if (i > 0 && j < S.length - 1) {
          const mid = S[Math.floor((i + j) / 2)];
          const h = this.nearestChain([mid.x, mid.z], 30);
          if (h) {
            const t = sampleAt(c.pts, c.L, h.s);
            const dot = Math.abs(t.dx * mid.dx + t.dz * mid.dz);
            if (dot < 0.6 && h.s > c.trim[0] + 3 && h.s < c.len - c.trim[1] - 3) this.zebra(B, c, h.s - 1.5, h.s + 1.5);
          }
        }
        i = j + 1;
      }
    }
    const lift = ped ? 0.06 : 0.04;
    let run: typeof S = [];
    const flush = () => {
      if (run.length >= 2) this.pathRibbon(B, mat, run, hw, lift, !!r.bridge);
      run = [];
    };
    for (const smp of S) { if (smp.inside) { flush(); continue; } run.push(smp); }
    flush();
    for (let i = 0; i < S.length; i += 3) if (!S[i].inside) this.addWalk([S[i].x, S[i].z]);
    if (r.bridge) {
      for (let i = 0; i + 1 < S.length; i++) this.addSeg({ ax: S[i].x, az: S[i].z, bx: S[i + 1].x, bz: S[i + 1].z, ya: S[i].y, yb: S[i + 1].y, o0: -hw, o1: hw, kind: 'deck' }, hw + 1);
    }
  }

  private pathRibbon(B: ChunkBatcher, mat: string, run: { x: number; z: number; y: number; s: number }[], hw: number, lift: number, bridge: boolean) {
    const pts: Vec2[] = run.map((r) => [r.x, r.z]);
    const nr = polyNormals(pts);
    for (let k0 = 0; k0 < run.length - 1; k0 += 26) {
      const k1 = Math.min(run.length - 1, k0 + 26);
      const mb = B.get(mat, run[k0].x, run[k0].z);
      let prev: [number, number] | null = null;
      for (let k = k0; k <= k1; k++) {
        const { x, z, y, s } = run[k], [nx, nz] = nr[k];
        const i0 = mb.v(x - nx * hw, y + lift, z - nz * hw, 0, 1, 0, mat === 'footway' ? s : x - nx * hw, mat === 'footway' ? 0 : z - nz * hw);
        const i1 = mb.v(x + nx * hw, y + lift, z + nz * hw, 0, 1, 0, mat === 'footway' ? s : x + nx * hw, mat === 'footway' ? hw * 2 : z + nz * hw);
        if (prev) mb.quadN(prev[0], prev[1], i0, i1, 0, 1, 0);
        prev = [i0, i1];
      }
      if (bridge) {
        const cb = B.get('bridgeRail', run[k0].x, run[k0].z);
        for (let k = k0; k < k1; k++) for (const sg of [-1, 1]) {
          const a: Vec2 = [run[k].x + nr[k][0] * hw * sg, run[k].z + nr[k][1] * hw * sg];
          const b: Vec2 = [run[k + 1].x + nr[k + 1][0] * hw * sg, run[k + 1].z + nr[k + 1][1] * hw * sg];
          // deck edge + rail
          this.vfaceY(cb, a, b, run[k].y - 0.4, run[k].y + lift, run[k + 1].y - 0.4, run[k + 1].y + lift, sg, nr[k]);
          this.vfaceY(cb, a, b, run[k].y + 1.0, run[k].y + 1.08, run[k + 1].y + 1.0, run[k + 1].y + 1.08, sg, nr[k]);
        }
        for (let k = k0; k <= k1; k += 2) for (const sg of [-1, 1]) {
          const a: Vec2 = [run[k].x + nr[k][0] * hw * sg, run[k].z + nr[k][1] * hw * sg];
          const b: Vec2 = [a[0] + run[Math.min(k + 1, run.length - 1)].x - run[k].x, a[1]];
          void b;
          this.vfaceY(cb, a, [a[0] + 0.05 * -nr[k][1], a[1] + 0.05 * nr[k][0]], run[k].y, run[k].y + 1.05, run[k].y, run[k].y + 1.05, sg, nr[k]);
        }
      }
    }
  }

  private vfaceY(mb: MeshBuilder, a: Vec2, b: Vec2, ya0: number, ya1: number, yb0: number, yb1: number, sg: number, n: Vec2) {
    const nx = n[0] * sg, nz = n[1] * sg;
    const i0 = mb.v(a[0], ya0, a[1], nx, 0, nz, 0, 0), i1 = mb.v(b[0], yb0, b[1], nx, 0, nz, 1, 0);
    const i2 = mb.v(b[0], yb1, b[1], nx, 0, nz, 1, 1), i3 = mb.v(a[0], ya1, a[1], nx, 0, nz, 0, 1);
    mb.triN(i0, i1, i2, nx, 0, nz); mb.triN(i0, i2, i3, nx, 0, nz);
  }

  // ---------------------------------------------------------------- queries
  /** Highest walkable road-network surface at x,z (sidewalk/deck/road), or null. */
  surfaceAt(x: number, z: number): { y: number; kind: SurfaceSeg['kind'] } | null {
    let best: { y: number; kind: SurfaceSeg['kind'] } | null = null;
    this.cornerGrid.query(x, z, 0, (c) => { if ((!best || c.y > best.y) && pointInPoly(x, z, c.poly)) best = { y: c.y, kind: 'sidewalk' }; });
    this.segGrid.query(x, z, 0, (s) => {
      const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz;
      if (l2 < 0.001) {
        // disc (junction / corner)
        const d = Math.hypot(x - s.ax, z - s.az);
        if (d <= s.o1 && (!best || s.ya > best.y)) best = { y: s.ya, kind: s.kind };
        return;
      }
      const t = ((x - s.ax) * dx + (z - s.az) * dz) / l2;
      if (t < -0.01 || t > 1.01) return;
      const l = Math.sqrt(l2);
      const off = ((x - s.ax) * -dz + (z - s.az) * dx) / l;
      if (off < s.o0 || off > s.o1) return;
      const y = s.ya + (s.yb - s.ya) * Math.max(0, Math.min(1, t));
      if (!best || y > best.y) best = { y, kind: s.kind };
    });
    return best;
  }
}
