// Geometry accumulator: one per (chunk, lod, material). Much faster than building many BufferGeometries
// and merging them. UVs are world-space meters (1 UV = 1 m) unless stated. Vertex color = tint × AO.
import * as THREE from 'three';
import * as ShapeUtils from './earcut';
import type { Vec2 } from '../../core/types';

export type V3 = [number, number, number];

class Grow {
  a: Float32Array;
  n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) this.grow();
    const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z;
  }
  push1(x: number) {
    if (this.n + 1 > this.a.length) this.grow();
    this.a[this.n++] = x;
  }
  push2(x: number, y: number) {
    if (this.n + 2 > this.a.length) this.grow();
    const a = this.a; a[this.n++] = x; a[this.n++] = y;
  }
  push4(x: number, y: number, z: number, w: number) {
    if (this.n + 4 > this.a.length) this.grow();
    const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; a[this.n++] = w;
  }
  grow() { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
  view() { return this.a.slice(0, this.n); }
}
class GrowU32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint32Array(cap); }
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z;
  }
}

/** Window-shader attributes attached to glass vertices. */
export interface WinAttr {
  /** window-local meters of this vertex (x along facade from window-left, y from window-bottom). */
  lx: number; ly: number;
  /** (winW, winH, sillAboveFloor, floorH) */
  a: [number, number, number, number];
  /** (seed, kind, muntin, roomW) */
  b: [number, number, number, number];
}

export class MB {
  pos = new Grow(); nrm = new Grow(); uv = new Grow(); col = new Grow(); idx = new GrowU32();
  w0?: Grow; wa?: Grow; wb?: Grow; lay?: Grow;
  vc = 0;
  /** current texture-array layer (surface buckets) */
  layer = 0;
  /** current tint (linear-ish RGB multiplier) */
  tr = 1; tg = 1; tb = 1;
  constructor(public kind: 'surface' | 'glass' | 'plain' = 'surface') {
    if (kind === 'glass') { this.w0 = new Grow(); this.wa = new Grow(); this.wb = new Grow(); }
    if (kind === 'surface') this.lay = new Grow();
  }
  setTint(c: THREE.Color | [number, number, number]) {
    if (Array.isArray(c)) { this.tr = c[0]; this.tg = c[1]; this.tb = c[2]; }
    else { this.tr = c.r; this.tg = c.g; this.tb = c.b; }
  }
  get tris() { return this.idx.n / 3; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, ao = 1, w?: WinAttr, wl?: Vec2) {
    this.pos.push3(x, y, z);
    this.nrm.push3(nx, ny, nz);
    this.uv.push2(u, v);
    this.col.push3(this.tr * ao, this.tg * ao, this.tb * ao);
    if (this.lay) this.lay.push1(this.layer);
    if (this.w0) {
      if (w) {
        this.w0.push2(wl ? wl[0] : w.lx, wl ? wl[1] : w.ly);
        this.wa!.push4(w.a[0], w.a[1], w.a[2], w.a[3]);
        this.wb!.push4(w.b[0], w.b[1], w.b[2], w.b[3]);
      } else { this.w0.push2(0, 0); this.wa!.push4(1, 1, 1, 3); this.wb!.push4(0, 0, 0, 3); }
    }
    return this.vc++;
  }

  /** Quad p0..p3 (CCW seen from the front). Normal from geometry; uvs per corner; ao per corner. */
  quad(p0: V3, p1: V3, p2: V3, p3: V3, uv: [number, number, number, number, number, number, number, number], ao: number | [number, number, number, number] = 1, w?: WinAttr, wl?: [Vec2, Vec2, Vec2, Vec2]) {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-10) return;
    nx /= l; ny /= l; nz /= l;
    const a = typeof ao === 'number' ? [ao, ao, ao, ao] : ao;
    const i0 = this.vert(p0[0], p0[1], p0[2], nx, ny, nz, uv[0], uv[1], a[0], w, wl?.[0]);
    this.vert(p1[0], p1[1], p1[2], nx, ny, nz, uv[2], uv[3], a[1], w, wl?.[1]);
    this.vert(p2[0], p2[1], p2[2], nx, ny, nz, uv[4], uv[5], a[2], w, wl?.[2]);
    this.vert(p3[0], p3[1], p3[2], nx, ny, nz, uv[6], uv[7], a[3], w, wl?.[3]);
    this.idx.push3(i0, i0 + 1, i0 + 2);
    this.idx.push3(i0, i0 + 2, i0 + 3);
  }

  /** Planar polygon (3D points) with optional holes; normal given; uv function. */
  polygon(pts: V3[], normal: V3, uvf: (p: V3) => [number, number], ao: (p: V3) => number = () => 1, holes?: V3[][]) {
    if (pts.length < 3) return;
    // project to 2D basis
    const n = normal;
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const proj = (p: V3): [number, number] => (ay >= ax && ay >= az ? [p[0], p[2]] : ax >= az ? [p[2], p[1]] : [p[0], p[1]]);
    const contour = pts.map(proj);
    const holes2 = holes?.map((h) => h.map(proj)) ?? [];
    let tris: number[][];
    try {
      tris = ShapeUtils.triangulate(contour, holes2);
    } catch { return; }
    const all = holes ? pts.concat(...holes) : pts;
    const base = this.vc;
    for (const p of all) {
      const [u, v] = uvf(p);
      this.vert(p[0], p[1], p[2], n[0], n[1], n[2], u, v, ao(p));
    }
    for (const t of tris) {
      // check winding against normal
      const a = all[t[0]], b = all[t[1]], c = all[t[2]];
      const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
      const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
      const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) this.idx.push3(base + t[0], base + t[1], base + t[2]);
      else this.idx.push3(base + t[0], base + t[2], base + t[1]);
    }
  }

  /** Axis-aligned-in-frame box. faces bitmask: 1=+N 2=-N 4=+T 8=-T 16=+U 32=-U. */
  box(f: Frame, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number, faces = 63, ao: [number, number] = [1, 1]) {
    const P = (s: number, y: number, d: number) => f.pt(s, y, d);
    const u0 = f.u0;
    const aB = ao[0], aT = ao[1];
    if (faces & 1) this.quad(P(s0, y0, d1), P(s1, y0, d1), P(s1, y1, d1), P(s0, y1, d1), [u0 + s0, y0, u0 + s1, y0, u0 + s1, y1, u0 + s0, y1], [aB, aB, aT, aT]);
    if (faces & 2) this.quad(P(s1, y0, d0), P(s0, y0, d0), P(s0, y1, d0), P(s1, y1, d0), [u0 + s1, y0, u0 + s0, y0, u0 + s0, y1, u0 + s1, y1], [aB, aB, aT, aT]);
    if (faces & 4) this.quad(P(s1, y0, d1), P(s1, y0, d0), P(s1, y1, d0), P(s1, y1, d1), [d1, y0, d0, y0, d0, y1, d1, y1], [aB, aB, aT, aT]);
    if (faces & 8) this.quad(P(s0, y0, d0), P(s0, y0, d1), P(s0, y1, d1), P(s0, y1, d0), [d0, y0, d1, y0, d1, y1, d0, y1], [aB, aB, aT, aT]);
    if (faces & 16) this.quad(P(s0, y1, d1), P(s1, y1, d1), P(s1, y1, d0), P(s0, y1, d0), [u0 + s0, d1, u0 + s1, d1, u0 + s1, d0, u0 + s0, d0], aT);
    if (faces & 32) this.quad(P(s0, y0, d0), P(s1, y0, d0), P(s1, y0, d1), P(s0, y0, d1), [u0 + s0, d0, u0 + s1, d0, u0 + s1, d1, u0 + s0, d1], aB);
  }

  /** Free-oriented box: center c, half extents along orthonormal axes ax (x), up (y), az. */
  obox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, ao: [number, number] = [0.8, 1], faces = 31) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const fb = new Frame(cx - cs * hx, cz - sn * hx, cs, sn, 0);
    this.box(fb, 0, 2 * hx, cy - hy, cy + hy, -hz, hz, faces, ao);
  }

  build(): THREE.BufferGeometry | null {
    if (this.idx.n === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nrm.view(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.view(), 2));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.view(), 3));
    if (this.lay) g.setAttribute('aLayer', new THREE.BufferAttribute(this.lay.view(), 1));
    if (this.w0) {
      g.setAttribute('aWin0', new THREE.BufferAttribute(this.w0.view(), 2));
      g.setAttribute('aWinA', new THREE.BufferAttribute(this.wa!.view(), 4));
      g.setAttribute('aWinB', new THREE.BufferAttribute(this.wb!.view(), 4));
    }
    const idx = this.idx.a.slice(0, this.idx.n);
    g.setIndex(new THREE.BufferAttribute(this.vc > 65535 ? idx : new Uint16Array(idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Edge-local frame: origin (ox,oz) at the edge start, T along the edge, N outward, U = +Y. T×U = N. */
export class Frame {
  nx: number; nz: number;
  constructor(public ox: number, public oz: number, public tx: number, public tz: number, public u0 = 0) {
    this.nx = -tz; this.nz = tx;
  }
  pt(s: number, y: number, d: number): V3 {
    return [this.ox + this.tx * s + this.nx * d, y, this.oz + this.tz * s + this.nz * d];
  }
  static fromEdge(a: Vec2, b: Vec2, u0 = 0) {
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return new Frame(a[0], a[1], dx / l, dz / l, u0);
  }
}
