// Geometry helpers shared by the world assembler.
import * as THREE from 'three';
import type { Vec2 } from '../core/types';

/** Accumulates triangles; position/normal/uv (+ optional color). */
export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] | null = null;
  idx: number[] = [];
  constructor(withColor = false) { if (withColor) this.col = []; }
  get count() { return this.pos.length / 3; }
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, w: number, c?: THREE.Color): number {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.uv.push(u, w);
    if (this.col) { this.col.push(c ? c.r : 1, c ? c.g : 1, c ? c.b : 1); }
    return this.pos.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.idx.push(a, b, c, a, c, d); }
  /** Triangle oriented so its geometric normal points along (nx,ny,nz). */
  triN(a: number, b: number, c: number, nx: number, ny: number, nz: number) {
    const P = this.pos;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
  }
  /** Quad (strip order p0,p1 then q0,q1) oriented along n. */
  quadN(p0: number, p1: number, q0: number, q1: number, nx: number, ny: number, nz: number) {
    this.triN(p0, q0, p1, nx, ny, nz); this.triN(p1, q0, q1, nx, ny, nz);
  }
  append(o: MeshBuilder) {
    const base = this.count;
    this.pos.push(...o.pos); this.nrm.push(...o.nrm); this.uv.push(...o.uv);
    if (this.col) { if (o.col) this.col.push(...o.col); else for (let i = 0; i < o.count; i++) this.col.push(1, 1, 1); }
    for (const i of o.idx) this.idx.push(i + base);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

/** Spatially-chunked builders keyed by material name. */
export class ChunkBatcher {
  private map = new Map<string, MeshBuilder>();
  constructor(public chunkSize = 180) {}
  get(mat: string, x: number, z: number, withColor = false): MeshBuilder {
    const cx = Math.floor(x / this.chunkSize), cz = Math.floor(z / this.chunkSize);
    const key = `${mat}|${cx}|${cz}`;
    let b = this.map.get(key);
    if (!b) { b = new MeshBuilder(withColor); this.map.set(key, b); }
    return b;
  }
  /** Emit meshes into group, one per (material, chunk). */
  emit(group: THREE.Group, mats: Record<string, THREE.Material>, opts: { receiveShadow?: boolean; castShadow?: Record<string, boolean>; renderOrder?: Record<string, number> } = {}) {
    const out: THREE.Mesh[] = [];
    for (const [key, b] of this.map) {
      if (b.idx.length === 0) continue;
      const mat = key.split('|')[0];
      const m = mats[mat];
      if (!m) { console.warn('[world] no material', mat); continue; }
      const mesh = new THREE.Mesh(b.build(), m);
      mesh.name = key;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      mesh.castShadow = opts.castShadow?.[mat] ?? false;
      if (opts.renderOrder?.[mat] !== undefined) mesh.renderOrder = opts.renderOrder[mat];
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      out.push(mesh);
    }
    this.map.clear();
    return out;
  }
}

export const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polyArea(p: Vec2[]) {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] * p[i][1] - p[i][0] * p[j][1]);
  return a / 2;
}

export function pointInPoly(x: number, z: number, p: Vec2[]) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
    if (((zi > z) !== (zj > z)) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Triangulate polygon (with holes) → flat list of [x,z] triangles vertices. */
export function triangulate(outer: Vec2[], holes: Vec2[][] = []): { pts: Vec2[]; tris: number[] } {
  const clean = (r: Vec2[]) => {
    const o = r.filter((p, i) => i === 0 || dist2(p, r[i - 1]) > 1e-3);
    if (o.length > 2 && dist2(o[0], o[o.length - 1]) < 1e-3) o.pop();
    return o;
  };
  const O = clean(outer);
  const H = holes.map(clean).filter((h) => h.length >= 3);
  const v2 = (r: Vec2[]) => r.map((p) => new THREE.Vector2(p[0], p[1]));
  const faces = THREE.ShapeUtils.triangulateShape(v2(O), H.map(v2));
  const pts = [...O, ...H.flat()];
  const tris: number[] = [];
  for (const f of faces) tris.push(f[0], f[1], f[2]);
  return { pts, tris };
}

/** Subdivide triangles (2D) until every edge < maxEdge. Returns new pts/tris. */
export function subdivide(pts: Vec2[], tris: number[], maxEdge: number): { pts: Vec2[]; tris: number[] } {
  const P = pts.slice();
  const cache = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    let i = cache.get(k);
    if (i === undefined) { i = P.length; P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2]); cache.set(k, i); }
    return i;
  };
  let T = tris.slice();
  for (let iter = 0; iter < 8; iter++) {
    const out: number[] = [];
    let changed = false;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t], b = T[t + 1], c = T[t + 2];
      const lab = dist2(P[a], P[b]), lbc = dist2(P[b], P[c]), lca = dist2(P[c], P[a]);
      const m = Math.max(lab, lbc, lca);
      if (m <= maxEdge) { out.push(a, b, c); continue; }
      changed = true;
      // split longest edge only (keeps conformity via shared cache)
      if (m === lab) { const d = mid(a, b); out.push(a, d, c, d, b, c); }
      else if (m === lbc) { const d = mid(b, c); out.push(a, b, d, a, d, c); }
      else { const d = mid(c, a); out.push(a, b, d, d, b, c); }
    }
    T = out;
    if (!changed) break;
  }
  // Longest-edge bisection can leave T-junctions; acceptable for flat draped surfaces with small offset.
  return { pts: P, tris: T };
}

/** Polyline cumulative lengths. */
export function cumLen(pts: Vec2[]) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + dist2(pts[i], pts[i - 1]));
  return L;
}

/** Sample polyline at arc length s → point, tangent, index. */
export function sampleAt(pts: Vec2[], L: number[], s: number, ys?: number[]) {
  s = Math.max(0, Math.min(L[L.length - 1], s));
  let i = 0;
  while (i < L.length - 2 && L[i + 1] < s) i++;
  const seg = L[i + 1] - L[i] || 1;
  const t = (s - L[i]) / seg;
  const a = pts[i], b = pts[i + 1];
  const dx = (b[0] - a[0]) / seg, dz = (b[1] - a[1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx, dz, y: ys ? ys[i] + (ys[i + 1] - ys[i]) * t : 0, i };
}

/** Sub-polyline between arc lengths s0..s1, including interior vertices. */
export function slicePolyline(pts: Vec2[], ys: number[], L: number[], s0: number, s1: number) {
  const out: Vec2[] = [], oy: number[] = [];
  const a = sampleAt(pts, L, s0, ys);
  out.push([a.x, a.z]); oy.push(a.y);
  for (let i = 1; i < pts.length - 1; i++) if (L[i] > s0 + 0.05 && L[i] < s1 - 0.05) { out.push(pts[i]); oy.push(ys[i]); }
  const b = sampleAt(pts, L, s1, ys);
  out.push([b.x, b.z]); oy.push(b.y);
  return { pts: out, ys: oy };
}

/** Per-vertex offset normals with miter (left normal = (-dz, dx)). */
export function polyNormals(pts: Vec2[]): Vec2[] {
  const n = pts.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let d0x: number, d0z: number, d1x: number, d1z: number;
    if (i > 0) { const l = dist2(pts[i], pts[i - 1]) || 1; d0x = (pts[i][0] - pts[i - 1][0]) / l; d0z = (pts[i][1] - pts[i - 1][1]) / l; }
    else { const l = dist2(b, pts[i]) || 1; d0x = (b[0] - pts[i][0]) / l; d0z = (b[1] - pts[i][1]) / l; }
    if (i < n - 1) { const l = dist2(pts[i + 1], pts[i]) || 1; d1x = (pts[i + 1][0] - pts[i][0]) / l; d1z = (pts[i + 1][1] - pts[i][1]) / l; }
    else { d1x = d0x; d1z = d0z; }
    void a;
    let nx = -(d0z + d1z), nz = d0x + d1x;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    // miter scale
    const dot = nx * -d1z + nz * d1x;
    const sc = 1 / Math.max(0.35, dot);
    out.push([nx * sc, nz * sc]);
  }
  return out;
}

export function lineIntersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): [number, number] | null {
  const den = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(den) < 1e-6) return null;
  const wx = q[0] - p[0], wz = q[1] - p[1];
  const t = (wx * e[1] - wz * e[0]) / den;
  const u = (wx * d[1] - wz * d[0]) / den;
  return [t, u];
}

/** Simple uniform grid spatial index over items with (x,z). */
export class Grid<T> {
  cells = new Map<number, T[]>();
  constructor(public size: number) {}
  key(cx: number, cz: number) { return (cx + 32768) * 65536 + (cz + 32768); }
  add(x: number, z: number, item: T) {
    const k = this.key(Math.floor(x / this.size), Math.floor(z / this.size));
    let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(item);
  }
  addBox(x0: number, z0: number, x1: number, z1: number, item: T) {
    for (let cx = Math.floor(x0 / this.size); cx <= Math.floor(x1 / this.size); cx++)
      for (let cz = Math.floor(z0 / this.size); cz <= Math.floor(z1 / this.size); cz++) {
        const k = this.key(cx, cz);
        let c = this.cells.get(k); if (!c) this.cells.set(k, (c = [])); c.push(item);
      }
  }
  query(x: number, z: number, r: number, fn: (item: T) => void) {
    for (let cx = Math.floor((x - r) / this.size); cx <= Math.floor((x + r) / this.size); cx++)
      for (let cz = Math.floor((z - r) / this.size); cz <= Math.floor((z + r) / this.size); cz++) {
        const c = this.cells.get(this.key(cx, cz));
        if (c) for (const it of c) fn(it);
      }
  }
}

/**
 * Yield to the event loop during loading. setTimeout(0) is clamped/deprioritised while the page is busy
 * (measured ~40 ms per yield under load, which doubled some load stages), so most yields go through a
 * MessageChannel task (~0.05 ms). Every ~120 ms one timer yield is used instead so the loading screen can paint.
 */
let lastPaintYield = 0;
const mcQueue: (() => void)[] = [];
let mc: MessageChannel | null = null;
export const yieldFrame = (): Promise<void> => {
  const now = performance.now();
  if (typeof MessageChannel === 'undefined' || now - lastPaintYield > 120) {
    lastPaintYield = now;
    return new Promise<void>((r) => setTimeout(r, 0));
  }
  if (!mc) {
    mc = new MessageChannel();
    mc.port1.onmessage = () => { mcQueue.shift()?.(); };
  }
  return new Promise<void>((r) => { mcQueue.push(r); mc!.port2.postMessage(0); });
};
