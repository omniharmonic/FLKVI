// OWNER: landmarks. Tiny modelling kit for hand-built hero landmarks: primitives are transformed into
// the landmark's local frame (meters, +Y up, front facade faces +Z), given world-scale meter UVs and
// merged into ONE mesh per material (plus a separate "detail" set that is dropped at distance), so a
// whole landmark costs a handful of draw calls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec2 } from '../../core/types';
import { triangulate } from '../util';

export interface PartOpts {
  /** Small ornament: only in the near LOD. */
  detail?: boolean;
  /** Include in the landmark's physics collider (static trimesh). */
  collide?: boolean;
  /** Keep the primitive's own UVs scaled by `uvScale` instead of planar meter UVs. */
  keepUv?: [number, number];
  /** Doesn't cast shadows (glass, lamps). */
  noShadow?: boolean;
  /** Physics only: not rendered. */
  colliderOnly?: boolean;
}

interface Bucket { mat: THREE.Material; main: THREE.BufferGeometry[]; detail: THREE.BufferGeometry[]; shadow: boolean }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Planar meter UVs by dominant normal axis (walls: u along the wall, v up). */
function planarUv(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    if (ay >= ax && ay >= az) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
    else if (ax >= az) { uv[i * 2] = z * Math.sign(nrm.getX(i) || 1); uv[i * 2 + 1] = y; }
    else { uv[i * 2] = -x * Math.sign(nrm.getZ(i) || 1); uv[i * 2 + 1] = y; }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class Kit {
  private buckets = new Map<string, Bucket>();
  /** Collider triangles in landmark-local space. */
  colV: number[] = [];
  colI: number[] = [];
  constructor(private mats: Record<string, THREE.Material>) {}

  mat(key: string): THREE.Material {
    const m = this.mats[key];
    if (!m) throw new Error('landmark kit: unknown material ' + key);
    return m;
  }

  /** Add a geometry already in local space (consumed). */
  add(key: string, g: THREE.BufferGeometry, o: PartOpts = {}) {
    if (g.index) g = g.toNonIndexed();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (o.keepUv && g.getAttribute('uv')) {
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * o.keepUv[0], uv.getY(i) * o.keepUv[1]);
    } else planarUv(g);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!o.colliderOnly) {
      let b = this.buckets.get(key);
      if (!b) this.buckets.set(key, (b = { mat: this.mat(key), main: [], detail: [], shadow: !o.noShadow }));
      (o.detail ? b.detail : b.main).push(g);
    }
    if (o.collide || o.colliderOnly) {
      const pos = g.getAttribute('position');
      const base = this.colV.length / 3;
      for (let i = 0; i < pos.count; i++) this.colV.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      for (let i = 0; i < pos.count; i++) this.colI.push(base + i);
    }
  }

  /** Transform + add. rot = [rx, ry, rz] (radians). */
  put(key: string, g: THREE.BufferGeometry, x: number, y: number, z: number, rot: [number, number, number] = [0, 0, 0], o: PartOpts = {}, scale: [number, number, number] = [1, 1, 1]) {
    _q.setFromEuler(_e.set(rot[0], rot[1], rot[2], 'YXZ'));
    _m.compose(_p.set(x, y, z), _q, _s.set(scale[0], scale[1], scale[2]));
    g.applyMatrix4(_m);
    this.add(key, g, o);
  }

  /** Axis-aligned (optionally Y-rotated) box by min-corner-free center/size. y is the BOTTOM of the box. */
  box(key: string, cx: number, y: number, cz: number, sx: number, sy: number, sz: number, o: PartOpts = {}, ry = 0) {
    this.put(key, new THREE.BoxGeometry(sx, sy, sz), cx, y + sy / 2, cz, [0, ry, 0], o);
  }

  /** Vertical cylinder/cone, y = bottom. */
  cyl(key: string, x: number, y: number, z: number, rTop: number, rBot: number, h: number, seg = 16, o: PartOpts = {}, open = false) {
    this.put(key, new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open), x, y + h / 2, z, [0, 0, 0], o);
  }

  /** Surface of revolution around the local Y axis at (x, y, z); profile points are [radius, height]. */
  lathe(key: string, x: number, y: number, z: number, prof: [number, number][], seg = 24, o: PartOpts = {}) {
    this.put(key, new THREE.LatheGeometry(prof.map(([r, h]) => new THREE.Vector2(r, h)), seg), x, y, z, [0, 0, 0], o);
  }

  /** Prism extruded along local Z from a 2D profile in the XY plane (e.g. pediments, arches). */
  prismZ(key: string, shape: THREE.Shape, depth: number, x: number, y: number, z: number, o: PartOpts = {}, ry = 0) {
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
    g.translate(0, 0, -depth / 2);
    this.put(key, g, x, y, z, [0, ry, 0], o);
  }

  /** Vertical extrusion of a polygon (x,z local) from y0 to y1, with optional cap. */
  extrude(key: string, poly: Vec2[], y0: number, y1: number, o: PartOpts & { cap?: boolean; bottom?: boolean } = {}) {
    const n = poly.length;
    const pos: number[] = [];
    // wall quads (flat-shaded, outward for CCW-in-x/-z footprints; fixed by checking signed area)
    let area = 0;
    for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const flip = area > 0; // x/z with +z south: positive shoelace = clockwise seen from above (+y)
    for (let i = 0; i < n; i++) {
      let a = poly[i], b = poly[(i + 1) % n];
      if (flip) [a, b] = [b, a];
      pos.push(a[0], y0, a[1], b[0], y0, b[1], b[0], y1, b[1], a[0], y0, a[1], b[0], y1, b[1], a[0], y1, a[1]);
    }
    if (o.cap !== false || o.bottom) {
      const t = triangulate(poly);
      for (let k = 0; k < t.tris.length; k += 3) {
        const p0 = t.pts[t.tris[k]], p1 = t.pts[t.tris[k + 1]], p2 = t.pts[t.tris[k + 2]];
        // orientation of the triangle seen from above
        const cr = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
        const up = cr < 0 ? [p0, p1, p2] : [p0, p2, p1];
        if (o.cap !== false) for (const p of up) pos.push(p[0], y1, p[1]);
        if (o.bottom) for (const p of [...up].reverse()) pos.push(p[0], y0, p[1]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.add(key, g, o);
  }

  /** Build merged meshes. Returns the near group (main + detail) and the far group (main only). */
  build(name: string): { near: THREE.Group; far: THREE.Group; tris: number; meshes: number } {
    const near = new THREE.Group(), far = new THREE.Group();
    near.name = name + ':lod0'; far.name = name + ':lod1';
    let tris = 0, meshes = 0;
    for (const [key, b] of this.buckets) {
      const main = b.main.length ? mergeGeometries(b.main, false) : null;
      const det = b.detail.length ? mergeGeometries([...(main ? [main] : []), ...b.detail], false) : null;
      const mk = (g: THREE.BufferGeometry, parent: THREE.Group) => {
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, b.mat);
        m.name = `${name}:${key}`;
        m.castShadow = b.shadow; m.receiveShadow = true;
        m.matrixAutoUpdate = false; m.updateMatrix();
        parent.add(m);
        tris += g.getAttribute('position').count / 3; meshes++;
      };
      if (det) mk(det, near); else if (main) mk(main, near);
      if (main) {
        if (det) mk(main, far);
        else { const m = new THREE.Mesh(main, b.mat); m.name = `${name}:${key}`; m.castShadow = b.shadow; m.receiveShadow = true; m.matrixAutoUpdate = false; far.add(m); }
      }
    }
    return { near, far, tris, meshes };
  }
}

// ---------------------------------------------------------------- shape helpers

/** Rectangle with a round-arched top, opening cut out as a hole when used via `archFrame`. */
export function archShape(w: number, h: number, springH: number, segs = 16): THREE.Shape {
  const s = new THREE.Shape();
  const r = w / 2;
  s.moveTo(-r, 0); s.lineTo(r, 0); s.lineTo(r, springH);
  s.absarc(0, springH, r, 0, Math.PI, false);
  s.lineTo(-r, 0);
  void h; void segs;
  return s;
}

/** A solid rectangle w×h (bottom at 0) with a round-arch opening (width ow, spring height os) cut out. */
export function archWall(w: number, h: number, ow: number, os: number, ox = 0): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, h); s.lineTo(-w / 2, h); s.lineTo(-w / 2, 0);
  const hole = new THREE.Path();
  const r = ow / 2;
  hole.moveTo(ox - r, 0.0001); hole.lineTo(ox - r, os);
  hole.absarc(ox, os, r, Math.PI, 0, true);
  hole.lineTo(ox + r, 0.0001); hole.lineTo(ox - r, 0.0001);
  s.holes.push(hole);
  return s;
}

/** Triangular pediment w wide, h tall (bottom at 0). */
export function pediment(w: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  return s;
}

/** Curved (baroque/mission) gable outline: w wide, shoulders at hs, crown at h. */
export function curvedGable(w: number, hs: number, h: number): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(w / 2, hs);
  s.bezierCurveTo(w * 0.32, hs + (h - hs) * 0.15, w * 0.3, h * 0.97, w * 0.1, h);
  s.lineTo(-w * 0.1, h);
  s.bezierCurveTo(-w * 0.3, h * 0.97, -w * 0.32, hs + (h - hs) * 0.15, -w / 2, hs);
  s.lineTo(-w / 2, 0);
  return s;
}

// ---------------------------------------------------------------- facade helpers

export interface Edge { a: Vec2; b: Vec2; len: number; dir: Vec2; n: Vec2; ry: number }

/** Footprint edges with outward normals; `ry` rotates a box's local +X onto the edge direction. */
export function polyEdges(poly: Vec2[], minLen = 0): Edge[] {
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a[0] * b[1] - b[0] * a[1]; }
  const sg = area > 0 ? -1 : 1;
  const out: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < minLen || len < 1e-4) continue;
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
    out.push({ a, b, len, dir: [dx, dz], n: [-dz * sg, dx * sg], ry: Math.atan2(-dz, dx) });
  }
  return out;
}

/**
 * Evenly spaced bays along every edge ≥ minLen: calls fn(x, z, ry, edge, i) for each bay center on the
 * wall line (x/z local), leaving `margin` at both ends.
 */
export function eachBay(poly: Vec2[], bay: number, margin: number, minLen: number, fn: (x: number, z: number, ry: number, e: Edge, i: number, n: number) => void) {
  for (const e of polyEdges(poly, minLen)) {
    const usable = e.len - margin * 2;
    if (usable < bay * 0.8) continue;
    const n = Math.max(1, Math.floor(usable / bay));
    const step = usable / n;
    for (let i = 0; i < n; i++) {
      const t = margin + step * (i + 0.5);
      fn(e.a[0] + e.dir[0] * t, e.a[1] + e.dir[1] * t, e.ry, e, i, n);
    }
  }
}

/** Rectangle polygon (CCW in x/−z, like recipe footprints) centered at (cx, cz). */
export function rect(cx: number, cz: number, w: number, d: number): Vec2[] {
  return [[cx - w / 2, cz + d / 2], [cx + w / 2, cz + d / 2], [cx + w / 2, cz - d / 2], [cx - w / 2, cz - d / 2]];
}
