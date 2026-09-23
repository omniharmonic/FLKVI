// Geometry helpers: part collection merged per material, meter-scaled box-projected UVs, jagged stumps.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../core/geo';

export interface Part { geo: THREE.BufferGeometry; mat: THREE.Material }

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Matrix from translation + XYZ euler (radians) + optional uniform/nonuniform scale. */
export function T(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q, _s.set(sx, sy, sz).clone());
}

/** Planar box projection UVs in meters (1 UV unit = `tile` meters) after transforms are applied. */
export function boxUV(g: THREE.BufferGeometry, tile = 1) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
    let u: number, v: number;
    if (ax >= ay && ax >= az) { u = z; v = y; }
    else if (ay >= az) { u = x; v = z; }
    else { u = x; v = y; }
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export class Parts {
  private map = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private frames: THREE.Matrix4[] = [];

  push(m: THREE.Matrix4) { const top = this.frames[this.frames.length - 1]; this.frames.push(top ? top.clone().multiply(m) : m.clone()); return this; }
  pop() { this.frames.pop(); return this; }

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4, uv: 'box' | 'keep' = 'box', tile = 1) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    const top = this.frames[this.frames.length - 1];
    _m.identity();
    if (top) _m.copy(top);
    if (m) _m.multiply(m);
    g.applyMatrix4(_m);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (uv === 'box') boxUV(g, tile);
    else if (!g.getAttribute('uv')) boxUV(g, tile);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    g.morphAttributes = {};
    let arr = this.map.get(mat);
    if (!arr) this.map.set(mat, (arr = []));
    arr.push(g);
    return this;
  }

  merged(): Part[] {
    const out: Part[] = [];
    for (const [mat, geos] of this.map) {
      const g = mergeGeometries(geos, false);
      if (!g) continue;
      g.computeBoundingSphere();
      out.push({ geo: g, mat });
    }
    return out;
  }
}

export const box = (w: number, h: number, d: number, sx = 1, sy = 1, sz = 1) => new THREE.BoxGeometry(w, h, d, sx, sy, sz);
export const cyl = (rt: number, rb: number, h: number, seg = 16, open = false, t0 = 0, tl = Math.PI * 2) =>
  new THREE.CylinderGeometry(rt, rb, h, seg, 1, open, t0, tl);

/** Square tube stump with torn, jagged top edge. Origin at bottom. */
export function jaggedBox(w: number, h: number, seed: number, jag = 0.05): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, w, 6, 1, 6);
  g.translate(0, h / 2, 0);
  const r = rng(seed);
  const table = new Map<string, number>();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > h - 1e-4) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let d = table.get(key);
      if (d === undefined) table.set(key, (d = (r() - 0.6) * jag));
      pos.setY(i, h + d);
      // torn metal curls slightly inward
      pos.setX(i, pos.getX(i) * (0.9 + r() * 0.08));
      pos.setZ(i, pos.getZ(i) * (0.9 + r() * 0.08));
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Round pipe stump with jagged top. Origin at bottom. */
export function jaggedCyl(rad: number, h: number, seed: number, jag = 0.05): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rad, rad, h, 18, 2, false);
  g.translate(0, h / 2, 0);
  const r = rng(seed);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const table = new Map<string, number>();
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > h - 1e-4) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let d = table.get(key);
      if (d === undefined) table.set(key, (d = (r() - 0.6) * jag));
      pos.setY(i, h + d);
      pos.setX(i, pos.getX(i) * 0.9);
      pos.setZ(i, pos.getZ(i) * 0.9);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** A cable (tube) along points. */
export function cableGeo(pts: THREE.Vector3[], radius = 0.007): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts);
  return new THREE.TubeGeometry(curve, Math.max(8, pts.length * 8), radius, 6, false);
}
