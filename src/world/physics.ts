// Static physics colliders (Rapier): terrain heightfield, building shells, pole/trunk cylinders, furniture boxes.
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../core/game';
import type { RecipeBuilding } from '../core/types';
import type { Heightfield } from './terrain';
import type { PropCollider, PropBox } from './props';
import { triangulate } from './util';

/** Collision membership bits. Terrain + buildings = STATIC (used for line of sight); poles/trees/furniture = PROPS. */
export const GROUP_STATIC = 0x0001;
export const GROUP_PROPS = 0x0002;
/** Rapier InteractionGroups: memberships (hi 16) | filter (lo 16). */
export const groups = (member: number, filter = 0xffff) => ((member << 16) | filter) >>> 0;
/** Query groups that only hit terrain + buildings (cheap LOS). */
export const LOS_QUERY_GROUPS = groups(0xffff, GROUP_STATIC);

export function buildTerrainCollider(g: Game, hf: Heightfield) {
  const R = g.rapier, W = g.physics;
  const nrows = hf.rows - 1, ncols = hf.cols - 1;
  const width = ncols * hf.cell, depth = nrows * hf.cell;
  const body = W.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(hf.ox + width / 2, 0, hf.oz + depth / 2));
  const tryLayout = (transpose: boolean) => {
    const h = new Float32Array((nrows + 1) * (ncols + 1));
    if (!transpose) { for (let r = 0; r <= nrows; r++) for (let c = 0; c <= ncols; c++) h[r + c * (nrows + 1)] = hf.h[r * hf.cols + c]; }
    else { for (let r = 0; r <= nrows; r++) for (let c = 0; c <= ncols; c++) h[c + r * (ncols + 1)] = hf.h[r * hf.cols + c]; }
    const desc = transpose
      ? R.ColliderDesc.heightfield(ncols, nrows, h, { x: depth, y: 1, z: width })
      : R.ColliderDesc.heightfield(nrows, ncols, h, { x: width, y: 1, z: depth });
    desc.setCollisionGroups(groups(GROUP_STATIC)).setFriction(1.0);
    return W.createCollider(desc, body);
  };
  const check = () => {
    W.step();
    let err = 0;
    const pts = [[0.21, 0.33], [0.77, 0.12], [0.5, 0.5], [0.13, 0.88], [0.62, 0.71]];
    for (const [fx, fz] of pts) {
      const x = hf.ox + width * fx, z = hf.oz + depth * fz;
      const hit = W.castRay(new R.Ray({ x, y: 10000, z }, { x: 0, y: -1, z: 0 }), 20000, true);
      const y = hit ? 10000 - hit.timeOfImpact : -1e9;
      err = Math.max(err, Math.abs(y - hf.sample(x, z)));
    }
    return err;
  };
  let col = tryLayout(false);
  if (check() > 0.25) {
    W.removeCollider(col, false);
    col = tryLayout(true);
    if (check() > 0.25) {
      // fallback: trimesh
      W.removeCollider(col, false);
      const verts = new Float32Array(hf.cols * hf.rows * 3);
      for (let r = 0; r < hf.rows; r++) for (let c = 0; c < hf.cols; c++) {
        const k = (r * hf.cols + c) * 3;
        verts[k] = hf.ox + c * hf.cell - (hf.ox + width / 2); verts[k + 1] = hf.h[r * hf.cols + c]; verts[k + 2] = hf.oz + r * hf.cell - (hf.oz + depth / 2);
      }
      const idx = new Uint32Array(nrows * ncols * 6);
      let i = 0;
      for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++) {
        const a = r * hf.cols + c, b = a + 1, e = a + hf.cols, f = e + 1;
        idx[i++] = a; idx[i++] = f; idx[i++] = b; idx[i++] = a; idx[i++] = e; idx[i++] = f;
      }
      col = W.createCollider(R.ColliderDesc.trimesh(verts, idx).setCollisionGroups(groups(GROUP_STATIC)), body);
      console.warn('[world] heightfield layout mismatch; using trimesh terrain collider');
    }
  }
  return col;
}

export function buildBuildingColliders(g: Game, buildings: RecipeBuilding[], chunk = 180) {
  const R = g.rapier, W = g.physics;
  const bins = new Map<string, { v: number[]; i: number[] }>();
  for (const b of buildings) {
    const fp = b.footprint;
    if (!fp || fp.length < 3) continue;
    const cx = fp.reduce((s, p) => s + p[0], 0) / fp.length, cz = fp.reduce((s, p) => s + p[1], 0) / fp.length;
    const key = `${Math.floor(cx / chunk)},${Math.floor(cz / chunk)}`;
    let bin = bins.get(key); if (!bin) bins.set(key, (bin = { v: [], i: [] }));
    const y0 = b.baseY + (b.minHeight ?? 0) - (b.minHeight ? 0 : 1.5);
    const y1 = b.baseY + b.height + (b.roofHeight || 0) * 0.55;
    const base = bin.v.length / 3;
    const n = fp.length;
    for (const p of fp) bin.v.push(p[0], y0, p[1]);
    for (const p of fp) bin.v.push(p[0], y1, p[1]);
    for (let k = 0; k < n; k++) { const a = k, c = (k + 1) % n; bin.i.push(base + a, base + c, base + n + c, base + a, base + n + c, base + n + a); }
    try {
      const t = triangulate(fp);
      if (t.pts.length === n) for (let k = 0; k < t.tris.length; k += 3) bin.i.push(base + n + t.tris[k], base + n + t.tris[k + 1], base + n + t.tris[k + 2], base + t.tris[k], base + t.tris[k + 2], base + t.tris[k + 1]);
    } catch { /* walls only */ }
  }
  const body = W.createRigidBody(R.RigidBodyDesc.fixed());
  for (const bin of bins.values()) {
    if (!bin.i.length) continue;
    const desc = R.ColliderDesc.trimesh(new Float32Array(bin.v), new Uint32Array(bin.i), R.TriMeshFlags.FIX_INTERNAL_EDGES);
    desc.setCollisionGroups(groups(GROUP_STATIC));
    W.createCollider(desc, body);
  }
}

export function buildPropColliders(g: Game, cols: (PropCollider | PropBox)[], trunks: { x: number; z: number; y: number; r: number; h: number }[]) {
  const R = g.rapier, W = g.physics;
  const body = W.createRigidBody(R.RigidBodyDesc.fixed());
  const gp = groups(GROUP_PROPS);
  for (const c of cols) {
    if (c.kind === 'cyl') W.createCollider(R.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.x, c.y + c.h / 2, c.z).setCollisionGroups(gp), body);
    else {
      const q = { x: 0, y: Math.sin(c.rot / 2), z: 0, w: Math.cos(c.rot / 2) };
      W.createCollider(R.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.x, c.y + c.hy, c.z).setRotation(q).setCollisionGroups(gp), body);
    }
  }
  for (const t of trunks) W.createCollider(R.ColliderDesc.cylinder(t.h / 2, t.r).setTranslation(t.x, t.y + t.h / 2, t.z).setCollisionGroups(gp), body);
}

export function makeLos(g: Game) {
  const R = g.rapier;
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
  const flags = R.QueryFilterFlags.EXCLUDE_DYNAMIC | R.QueryFilterFlags.EXCLUDE_KINEMATIC | R.QueryFilterFlags.EXCLUDE_SENSORS;
  return (a: [number, number, number], b: [number, number, number]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return false;
    ray.origin = { x: a[0], y: a[1], z: a[2] };
    ray.dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = (g.physics as RAPIER_NS.World).castRay(ray, len - 0.05, true, flags, LOS_QUERY_GROUPS);
    return !!hit;
  };
}
