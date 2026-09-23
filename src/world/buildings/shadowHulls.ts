// Far-cascade shadow hulls (perf). Every building as a plain extruded prism (walls + flat top at
// eave height + half the roof rise), merged per chunk. They are drawn only into the FAR sun cascade
// (≈130 m .. shadowFar), where the shadow map can't resolve facade or roof detail anyway, while the
// detailed building meshes cast only into the NEAR cascade. ~20 tris per building instead of
// thousands for every building within half a kilometre.
import * as THREE from 'three';
import type { RecipeBuilding } from '../../core/types';
import { triangulate } from './earcut';

export function buildShadowHulls(buildings: RecipeBuilding[], chunk: number): THREE.Mesh[] {
  const buckets = new Map<string, { pos: number[] }>();
  for (const b of buildings) {
    const src = b.footprint;
    if (!src || src.length < 3) continue;
    let cx = 0, cz = 0;
    for (const p of src) { cx += p[0]; cz += p[1]; }
    cx /= src.length; cz /= src.length;
    // pull the hull ~0.5 m inside the facade so recessed windows/reveals aren't self-shadowed by it
    const fp = src.map((p) => { const dx = cx - p[0], dz = cz - p[1], l = Math.hypot(dx, dz) || 1, k = Math.min(0.5, l * 0.25) / l; return [p[0] + dx * k, p[1] + dz * k] as [number, number]; });
    const key = `${Math.floor(cx / chunk)},${Math.floor(cz / chunk)}`;
    let bk = buckets.get(key);
    if (!bk) buckets.set(key, (bk = { pos: [] }));
    const P = bk.pos;
    const y0 = b.baseY + (b.minHeight ?? 0) - (b.minHeight ? 0 : 0.3);
    // top stays below the roof surface (parapets / eaves) so roofs are never shadowed by their own hull
    const y1 = b.baseY + b.height - ((b.roofHeight || 0) > 0.3 ? 0.3 : 1.5);
    if (!(y1 > y0 + 0.5)) continue;
    const rings = [fp];
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        // winding doesn't matter for depth-only shadow casters rendered double sided
        P.push(a[0], y0, a[1], c[0], y0, c[1], c[0], y1, c[1]);
        P.push(a[0], y0, a[1], c[0], y1, c[1], a[0], y1, a[1]);
      }
    }
    try {
      const tris = triangulate(fp);
      const all = fp;
      for (const t of tris) for (const k of t) { const p = all[k]; if (p) P.push(p[0], y1, p[1]); }
    } catch { /* walls still cast */ }
  }
  const out: THREE.Mesh[] = [];
  const mat = new THREE.MeshBasicMaterial({ color: 0, side: THREE.DoubleSide });
  mat.name = 'building-shadow-hull';
  for (const [key, bk] of buckets) {
    if (!bk.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = `bhull_${key}`;
    m.castShadow = true;
    m.receiveShadow = false;
    m.matrixAutoUpdate = false;
    out.push(m);
  }
  return out;
}
