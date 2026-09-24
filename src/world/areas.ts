// Area surfaces: plazas / pedestrian paving, parking lots (asphalt + stall lines), water bodies.
import * as THREE from 'three';
import type { Recipe, RecipeArea } from '../core/types';
import { ChunkBatcher, triangulate, subdivide, pointInPoly, polyArea, dist2 } from './util';
import type { Heightfield } from './terrain';
import type { RoadNetwork } from './roads';
import { waterNormalTexture } from './textures';

const WHITE = new THREE.Color('#e6e6e1');

export function buildAreas(recipe: Recipe, B: ChunkBatcher, hf: Heightfield, roads: RoadNetwork, waterGroup: THREE.Group, inBuilding: (x: number, z: number) => boolean) {
  const waterMeshes: THREE.Mesh[] = [];
  for (const a of recipe.areas) {
    if (a.poly.length < 3 || Math.abs(polyArea(a.poly)) < 4) continue;
    switch (a.kind) {
      case 'parking': drape(B, 'lot', a, hf, 0.035); stalls(B, a, hf, roads, inBuilding); break;
      case 'plaza': case 'pedestrian': drape(B, 'paving', a, hf, 0.07); addWalkArea(roads, a); break;
      case 'water': { const m = waterMesh(a, hf); if (m) { waterGroup.add(m); waterMeshes.push(m); } break; }
      default: break; // lawns etc. handled by terrain land-cover mask
    }
  }
  return waterMeshes;
}

function addWalkArea(roads: RoadNetwork, a: RecipeArea) {
  const xs = a.poly.map((p) => p[0]), zs = a.poly.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  for (let x = x0 + 2; x < x1; x += 6) for (let z = z0 + 2; z < z1; z += 6) if (pointInPoly(x, z, a.poly)) {
    const i = roads.walkPts.length; roads.walkPts.push([x, z]); roads.walkGrid.add(x, z, i);
  }
}

/** Triangulated, subdivided polygon draped over the terrain at +lift. */
function drape(B: ChunkBatcher, mat: string, a: RecipeArea, hf: Heightfield, lift: number) {
  let tri;
  try { tri = triangulate(a.poly, a.holes); } catch { return; }
  const sub = subdivide(tri.pts, tri.tris, Math.max(3, hf.cell * 1.5));
  const cx = a.poly.reduce((s, p) => s + p[0], 0) / a.poly.length, cz = a.poly.reduce((s, p) => s + p[1], 0) / a.poly.length;
  const mb = B.get(mat, cx, cz);
  const base = mb.count;
  for (const p of sub.pts) mb.v(p[0], hf.sample(p[0], p[1]) + lift, p[1], 0, 1, 0, p[0], p[1]);
  for (let t = 0; t < sub.tris.length; t += 3) mb.triN(base + sub.tris[t], base + sub.tris[t + 1], base + sub.tris[t + 2], 0, 1, 0);
}

/** Parking stall lines along the lot's dominant axis. */
function stalls(B: ChunkBatcher, a: RecipeArea, hf: Heightfield, roads: RoadNetwork, inBuilding: (x: number, z: number) => boolean) {
  // dominant axis: longest edge
  let best = 0, ang = 0;
  for (let i = 0; i < a.poly.length; i++) {
    const p = a.poly[i], q = a.poly[(i + 1) % a.poly.length];
    const l = dist2(p, q);
    if (l > best) { best = l; ang = Math.atan2(q[1] - p[1], q[0] - p[0]); }
  }
  const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
  // bounds in (u,v)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of a.poly) { const u = p[0] * ux + p[1] * uz, v = p[0] * vx + p[1] * vz; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  if (u1 - u0 < 8 || v1 - v0 < 8) return;
  const SW = 2.75, SD = 5.5, AISLE = 7.2;
  const inside = (u: number, v: number, m = 0.6) => {
    const x = u * ux + v * vx, z = u * uz + v * vz;
    if (!pointInPoly(x, z, a.poly)) return false;
    for (const [dx, dz] of [[m, 0], [-m, 0], [0, m], [0, -m]]) if (!pointInPoly(x + dx, z + dz, a.poly)) return false;
    if (roads.inCorridor(x, z, 0.5)) return false;
    if (inBuilding(x, z)) return false;
    return true;
  };
  const line = (ua: number, va: number, ub: number, vb: number, w: number) => {
    const xa = ua * ux + va * vx, za = ua * uz + va * vz, xb = ub * ux + vb * vx, zb = ub * uz + vb * vz;
    const dx = xb - xa, dz = zb - za, l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * w / 2, nz = (dx / l) * w / 2;
    const mb = B.get('marking', xa, za, true);
    const ya = hf.sample(xa, za) + 0.035 + 0.012, yb = hf.sample(xb, zb) + 0.035 + 0.012;
    const i0 = mb.v(xa - nx, ya, za - nz, 0, 1, 0, xa - nx, za - nz, WHITE), i1 = mb.v(xa + nx, ya, za + nz, 0, 1, 0, xa + nx, za + nz, WHITE);
    const i2 = mb.v(xb - nx, yb, zb - nz, 0, 1, 0, xb - nx, zb - nz, WHITE), i3 = mb.v(xb + nx, yb, zb + nz, 0, 1, 0, xb + nx, zb + nz, WHITE);
    mb.quadN(i0, i1, i2, i3, 0, 1, 0);
  };
  // rows: [stall row][aisle][stall row][stall row][aisle]... double-loaded
  let v = v0 + 1.0;
  let flip = false;
  while (v + SD < v1 - 0.5) {
    const va = v, vb = v + SD;
    for (let u = u0 + 1; u + SW < u1; u += SW) {
      const um = u;
      if (inside(um, flip ? vb : va) && inside(um, (va + vb) / 2)) line(um, va, um, vb, 0.1);
    }
    v += SD;
    if (flip) v += AISLE;
    flip = !flip;
  }
}

/**
 * Water surface height for an area: slightly below the lowest bank. A lake or a river reach is one flat level, but
 * a creek / stream polygon that runs downhill (Boulder Creek falls ~14 m across the map) would otherwise sit at its
 * lowest bank everywhere and carve a canyon upstream — there the level follows the local banks (lowest bank sample
 * within ~30 m), so the surface steps down with the terrain.
 */
const levelCache = new WeakMap<RecipeArea, (x: number, z: number) => number>();
export function waterLevelFn(a: RecipeArea, hf: Heightfield): (x: number, z: number) => number {
  const hit = levelCache.get(a);
  if (hit) return hit; // measured before the bed was carved
  const bank: [number, number, number][] = [];
  const ring = a.poly;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.max(1, Math.ceil(L / 5));
    for (let k = 0; k < n; k++) { const x = p[0] + ((q[0] - p[0]) * k) / n, z = p[1] + ((q[1] - p[1]) * k) / n; bank.push([x, z, hf.sample(x, z)]); }
  }
  let lo = Infinity, hi = -Infinity;
  for (const b of bank) { lo = Math.min(lo, b[2]); hi = Math.max(hi, b[2]); }
  const flat = lo - 0.35;
  if (!(hi - lo > 1.5)) { const f = () => flat; levelCache.set(a, f); return f; }
  const R = 30;
  const f = (x: number, z: number) => {
    let m = Infinity, nd = Infinity, nh = lo;
    for (const b of bank) {
      const d = Math.hypot(b[0] - x, b[1] - z);
      if (d < R && b[2] < m) m = b[2];
      if (d < nd) { nd = d; nh = b[2]; }
    }
    return (m === Infinity ? nh : m) - 0.35;
  };
  levelCache.set(a, f);
  return f;
}

function waterMesh(a: RecipeArea, hf: Heightfield): THREE.Mesh | null {
  let tri;
  try { tri = triangulate(a.poly, a.holes); } catch { return null; }
  const sub = subdivide(tri.pts, tri.tris, 20);
  // water level: slightly below the lowest (local) bank sample
  const levelAt = waterLevelFn(a, hf);
  // carve terrain beneath the water so the bed is visible through it
  const xs = a.poly.map((p) => p[0]), zs = a.poly.map((p) => p[1]);
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - hf.ox) / hf.cell)), c1 = Math.min(hf.cols - 1, Math.ceil((Math.max(...xs) - hf.ox) / hf.cell));
  const r0 = Math.max(0, Math.floor((Math.min(...zs) - hf.oz) / hf.cell)), r1 = Math.min(hf.rows - 1, Math.ceil((Math.max(...zs) - hf.oz) / hf.cell));
  for (let r = r0; r <= r1; r++) {
    const z = hf.oz + r * hf.cell;
    for (let c = c0; c <= c1; c++) {
      const x = hf.ox + c * hf.cell;
      if (!pointInPoly(x, z, a.poly)) continue;
      // depth grows with distance from shore
      let d = Infinity;
      for (let i = 0; i < a.poly.length; i++) {
        const p = a.poly[i], q = a.poly[(i + 1) % a.poly.length];
        const dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / l2));
        d = Math.min(d, Math.hypot(x - p[0] - dx * t, z - p[1] - dz * t));
      }
      hf.h[r * hf.cols + c] = Math.min(hf.h[r * hf.cols + c], levelAt(x, z) - 0.3 - Math.min(2.5, d * 0.25));
    }
  }
  const pos: number[] = [], uv: number[] = [];
  for (const p of sub.pts) { pos.push(p[0], levelAt(p[0], p[1]), p[1]); uv.push(p[0], p[1]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const idx: number[] = [];
  for (let t = 0; t < sub.tris.length; t += 3) {
    const A = sub.pts[sub.tris[t]], Bp = sub.pts[sub.tris[t + 1]], C = sub.pts[sub.tris[t + 2]];
    const ny = (Bp[1] - A[1]) * (C[0] - A[0]) - (Bp[0] - A[0]) * (C[1] - A[1]);
    if (ny >= 0) idx.push(sub.tris[t], sub.tris[t + 1], sub.tris[t + 2]); else idx.push(sub.tris[t], sub.tris[t + 2], sub.tris[t + 1]);
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, waterMaterial());
  m.name = 'water_' + a.id;
  m.receiveShadow = true;
  return m;
}

let waterMat: THREE.MeshPhysicalMaterial | null = null;
export const waterUniforms = { uTime: { value: 0 } };
/** Reflective water: dual scrolling normal maps, fresnel via physical material + env, depth-ish tint. */
export function waterMaterial() {
  if (waterMat) return waterMat;
  const n = waterNormalTexture().clone();
  n.wrapS = n.wrapT = THREE.RepeatWrapping; n.repeat.set(1 / 6, 1 / 6); n.needsUpdate = true;
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#1d3a3a'), roughness: 0.04, metalness: 0.0, normalMap: n, normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: true, opacity: 0.88, envMapIntensity: 1.2, ior: 1.333, specularIntensity: 1,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = waterUniforms.uTime;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <normal_fragment_maps>', `
        vec2 wuv1 = vNormalMapUv + vec2(uTime * 0.012, uTime * 0.007);
        vec2 wuv2 = vNormalMapUv * 1.7 + vec2(-uTime * 0.009, uTime * 0.013);
        vec3 mapN = normalize((texture2D(normalMap, wuv1).xyz * 2.0 - 1.0) + (texture2D(normalMap, wuv2).xyz * 2.0 - 1.0));
        mapN.xy *= normalScale;
        normal = normalize( tbn * mapN );
      `)
;
  };
  m.customProgramCacheKey = () => 'gt-water';
  m.name = 'water';
  waterMat = m;
  return m;
}
