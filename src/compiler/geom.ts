// OWNER: compiler agent. 2D geometry helpers in local [x, z] meters.
import type { Vec2 } from '../core/types.ts';

export const r2 = (v: number) => Math.round(v * 100) / 100;

/** 0.5 * Σ(x_i z_{i+1} − x_{i+1} z_i). Negative ⇔ counter-clockwise seen from above (north up). */
export function areaXZ(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Make ring CCW seen from above (areaXZ < 0). */
export function makeCCW(ring: Vec2[]): Vec2[] {
  return areaXZ(ring) > 0 ? ring.slice().reverse() : ring;
}
export function makeCW(ring: Vec2[]): Vec2[] {
  return areaXZ(ring) < 0 ? ring.slice().reverse() : ring;
}

export function polyArea(ring: Vec2[]): number { return Math.abs(areaXZ(ring)); }

export function centroid(ring: Vec2[]): Vec2 {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x: number, z: number, outer: Vec2[], holes?: Vec2[][]): boolean {
  if (!pointInRing(x, z, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, z, h)) return false;
  return true;
}

export function distToSeg(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = a[0] + t * dx - px, qz = a[1] + t * dz - pz;
  return Math.sqrt(qx * qx + qz * qz);
}

export function distToRing(px: number, pz: number, ring: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSeg(px, pz, ring[i], ring[(i + 1) % ring.length]));
  return d;
}

export function polylineLength(pts: Vec2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Heading convention shared with cameras: 0 = facing −Z (north), clockwise seen from above. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

export function bbox(pts: Vec2[]) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minZ) minZ = p[1]; if (p[1] > maxZ) maxZ = p[1];
  }
  return { minX, minZ, maxX, maxZ };
}

/** Remove duplicate/collinear points from a closed ring. */
export function cleanRing(ring: Vec2[], eps = 0.05): Vec2[] {
  let pts = ring.slice();
  if (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    const out: Vec2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < eps) { changed = true; continue; }
      // collinear: distance of b to ac small
      if (distToSeg(b[0], b[1], a, c) < eps * 0.5) { changed = true; continue; }
      out.push(b);
    }
    if (out.length < 3) break;
    pts = out;
  }
  return pts;
}

/** Sutherland–Hodgman clip of a ring against an axis-aligned rectangle. */
export function clipRingRect(ring: Vec2[], minX: number, minZ: number, maxX: number, maxZ: number): Vec2[] {
  let out = ring;
  const edges: [(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2][] = [
    [(p) => p[0] >= minX, (a, b) => { const t = (minX - a[0]) / (b[0] - a[0]); return [minX, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= maxX, (a, b) => { const t = (maxX - a[0]) / (b[0] - a[0]); return [maxX, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= minZ, (a, b) => { const t = (minZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), minZ]; }],
    [(p) => p[1] <= maxZ, (a, b) => { const t = (maxZ - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), maxZ]; }],
  ];
  for (const [inside, inter] of edges) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i - 1 + inp.length) % inp.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(inter(prev, cur)); out.push(cur); }
      else if (pi) out.push(inter(prev, cur));
    }
  }
  return out;
}

/** Clip a polyline to a rectangle → list of pieces with the index mapping (-1 = synthetic point). */
export function clipPolylineRect(pts: Vec2[], minX: number, minZ: number, maxX: number, maxZ: number): { pts: Vec2[]; src: number[] }[] {
  const pieces: { pts: Vec2[]; src: number[] }[] = [];
  let cur: { pts: Vec2[]; src: number[] } | null = null;
  const inside = (p: Vec2) => p[0] >= minX && p[0] <= maxX && p[1] >= minZ && p[1] <= maxZ;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) { if (inside(p)) cur = { pts: [p], src: [0] }; continue; }
    const a = pts[i - 1];
    // Liang–Barsky on segment a→p
    let t0 = 0, t1 = 1;
    const dx = p[0] - a[0], dz = p[1] - a[1];
    const clip = (pp: number, qq: number) => {
      if (pp === 0) return qq >= 0;
      const r = qq / pp;
      if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (clip(-dx, a[0] - minX) && clip(dx, maxX - a[0]) && clip(-dz, a[1] - minZ) && clip(dz, maxZ - a[1])) {
      if (t0 > 0) { // entering
        if (cur && cur.pts.length > 1) pieces.push(cur);
        cur = { pts: [[a[0] + t0 * dx, a[1] + t0 * dz]], src: [-1] };
      } else if (!cur) cur = { pts: [a], src: [i - 1] };
      if (t1 < 1) {
        cur.pts.push([a[0] + t1 * dx, a[1] + t1 * dz]); cur.src.push(-1);
        if (cur.pts.length > 1) pieces.push(cur);
        cur = null;
      } else { cur.pts.push(p); cur.src.push(i); }
    } else {
      if (cur && cur.pts.length > 1) pieces.push(cur);
      cur = null;
    }
  }
  if (cur && cur.pts.length > 1) pieces.push(cur);
  return pieces;
}

/** Buffer an open polyline into a polygon (mitered, clamped). */
export function bufferPolyline(pts: Vec2[], half: number): Vec2[] {
  const n = pts.length;
  if (n < 2) return [];
  const left: Vec2[] = [], right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = 0, dz = 0;
    if (i > 0) { const l = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) || 1; dx += (pts[i][0] - a[0]) / l; dz += (pts[i][1] - a[1]) / l; }
    if (i < n - 1) { const l = Math.hypot(b[0] - pts[i][0], b[1] - pts[i][1]) || 1; dx += (b[0] - pts[i][0]) / l; dz += (b[1] - pts[i][1]) / l; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    // miter factor
    let m = 1;
    if (i > 0 && i < n - 1) {
      const l1 = Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) || 1;
      const cos = ((pts[i][0] - a[0]) / l1) * dx + ((pts[i][1] - a[1]) / l1) * dz;
      m = Math.min(2, 1 / Math.max(0.3, cos));
    }
    const nx = -dz * half * m, nz = dx * half * m;
    left.push([pts[i][0] + nx, pts[i][1] + nz]);
    right.push([pts[i][0] - nx, pts[i][1] - nz]);
  }
  return left.concat(right.reverse());
}

/** Oriented bounding box via rotating edges: returns angle (atan2(dz,dx) of long axis), length, width, center. */
export function orientedBox(ring: Vec2[]) {
  let best = { area: Infinity, angle: 0, len: 0, wid: 0, cx: 0, cz: 0 };
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(ang), s = Math.sin(ang);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of ring) {
      const u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c;
      if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area - 1e-6) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      let angle = ang, len = maxU - minU, wid = maxV - minV;
      if (wid > len) { angle = ang + Math.PI / 2; [len, wid] = [wid, len]; }
      best = { area, angle, len, wid, cx: cu * c - cv * s, cz: cu * s + cv * c };
    }
  }
  return best;
}

/** Uniform grid spatial index over item bboxes. */
export class GridIndex<T> {
  private cells = new Map<number, T[]>();
  cell: number;
  constructor(cell = 32) { this.cell = cell; }
  private key(ix: number, iz: number) { return (ix + 32768) * 65536 + (iz + 32768); }
  insert(item: T, minX: number, minZ: number, maxX: number, maxZ: number) {
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++)
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const k = this.key(ix, iz);
        let a = this.cells.get(k);
        if (!a) this.cells.set(k, (a = []));
        a.push(item);
      }
  }
  query(minX: number, minZ: number, maxX: number, maxZ: number): Set<T> {
    const out = new Set<T>();
    const c = this.cell;
    for (let ix = Math.floor(minX / c); ix <= Math.floor(maxX / c); ix++)
      for (let iz = Math.floor(minZ / c); iz <= Math.floor(maxZ / c); iz++) {
        const a = this.cells.get(this.key(ix, iz));
        if (a) for (const t of a) out.add(t);
      }
    return out;
  }
  near(x: number, z: number, r: number) { return this.query(x - r, z - r, x + r, z + r); }
}
