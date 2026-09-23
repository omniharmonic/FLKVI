// OWNER: landmarks. Landmark Registry resolution + placement (Tech Arch §5.4 "Landmark overrides",
// Asset Spec §10). Hand-built procedural hero models replace specific OSM buildings (by way id) or are
// placed at named areas / lat-lon points (distant backdrops). Each landmark: a THREE.LOD with a detailed
// and a simplified level (a few merged draw calls each), a static trimesh collider, and floodlit night
// materials driven by the sky's night factor.
import * as THREE from 'three';
import type { Game } from '../../core/game';
import type { Recipe, RecipeBuilding, Vec2 } from '../../core/types';
import { makeProjection } from '../../core/geo';
import { Heightfield } from '../terrain';
import { groups, GROUP_STATIC } from '../physics';
import { LANDMARKS, type LandmarkDef, type LandmarkCtx, type Front } from './registry';
import { landmarkNight, type NightLamp } from './materials';

export interface Placement {
  def: LandmarkDef;
  /** World position of the local origin (x, z); y resolved at build time unless `y` is set. */
  x: number; z: number; y?: number;
  /** Rotation about +Y: local +Z (front) maps to world direction (sin rotY, cos rotY). */
  rotY: number;
  W: number; D: number;
  /** Matched footprints / area polygon, in WORLD coords. */
  polys: Vec2[][];
  buildings: RecipeBuilding[];
}

export interface ResolvedLandmarks {
  skip: Set<string>;
  placements: Placement[];
  /** True inside a landmark's clear zone (plaza): no trees there. */
  clearAt(x: number, z: number): boolean;
}

/** Match the registry against a recipe. Cheap; call before buildings so they can skip covered ids. */
export function resolveLandmarks(recipe: Recipe): ResolvedLandmarks {
  const skip = new Set<string>();
  const placements: Placement[] = [];
  const proj = makeProjection(recipe.origin.lat, recipe.origin.lon);
  const byId = new Map<string, RecipeBuilding>();
  for (const b of recipe.buildings ?? []) byId.set(b.id, b);
  for (const def of LANDMARKS) {
    try {
      const m = def.match;
      if (m.osmIds) {
        const bs = m.osmIds.map((id) => byId.get(id)).filter((b): b is RecipeBuilding => !!b && b.footprint?.length >= 3);
        if (!bs.length) continue;
        const pts = bs.flatMap((b) => b.footprint);
        const obb = fitObb(pts);
        const f = frontDir(def.front, obb, recipe, proj);
        const p: Placement = { def, x: obb.cx, z: obb.cz, rotY: Math.atan2(f.dir[0], f.dir[1]), W: f.w, D: f.d, polys: bs.map((b) => b.footprint), buildings: bs };
        placements.push(p);
        if (def.replace !== false) for (const b of bs) skip.add(b.id);
      } else if (m.areaId) {
        const a = recipe.areas.find((a) => a.id === m.areaId);
        if (!a) continue;
        const obb = fitObb(a.poly);
        const f = frontDir(def.front, obb, recipe, proj);
        placements.push({ def, x: obb.cx, z: obb.cz, rotY: Math.atan2(f.dir[0], f.dir[1]), W: f.w, D: f.d, polys: [a.poly], buildings: [] });
      } else if (m.latlon) {
        const [x, z] = proj.toLocal(m.latlon[0], m.latlon[1]);
        if (Math.hypot(x, z) > (m.radius ?? 5000)) continue;
        const f = m.facing ?? 0;
        placements.push({ def, x, z, rotY: f, W: 0, D: 0, polys: [], buildings: [] });
      }
    } catch (e) { console.warn('[landmarks] resolve failed', def.id, e); }
  }
  if (placements.length) console.info(`[landmarks] ${placements.map((p) => p.def.id).join(', ')} (replacing ${skip.size} OSM buildings)`);
  const clears = placements.filter((p) => p.def.clear).map((p) => ({ x: p.x, z: p.z, r: p.def.clear! }));
  return { skip, placements, clearAt: (x, z) => clears.some((c) => Math.hypot(x - c.x, z - c.z) < c.r) };
}

export interface LandmarksResult { group: THREE.Group; update(g: Game): void }

export function buildLandmarks(g: Game, res: ResolvedLandmarks): LandmarksResult {
  const group = new THREE.Group();
  group.name = 'landmarks';
  const recipe = g.recipe;
  const lamps: NightLamp[] = [];
  const updaters: ((g: Game) => void)[] = [];
  let farHf: Heightfield | null = null;
  const nearB = recipe.bounds;
  const groundAt = (x: number, z: number) => {
    if (x > nearB.minX && x < nearB.maxX && z > nearB.minZ && z < nearB.maxZ) return g.world.groundAt(x, z);
    if (recipe.farTerrain) { farHf ??= Heightfield.fromTerrain(recipe.farTerrain); return farHf.sample(x, z); }
    return 0;
  };
  const body = g.physics && g.rapier ? g.physics.createRigidBody(g.rapier.RigidBodyDesc.fixed()) : null;
  let tris = 0, meshes = 0;
  for (const p of res.placements) {
    try {
      const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
      // world → local: rotate by -rotY around Y after translating
      const toLocal = (wx: number, wz: number): Vec2 => { const dx = wx - p.x, dz = wz - p.z; return [dx * c - dz * s, dx * s + dz * c]; };
      const toWorld = (lx: number, lz: number): Vec2 => [p.x + lx * c + lz * s, p.z - lx * s + lz * c];
      let y = p.y;
      if (y === undefined) {
        const samples: number[] = [groundAt(p.x, p.z)];
        for (const poly of p.polys) for (const q of poly) samples.push(groundAt(q[0], q[1]));
        y = p.def.base === 'max' ? Math.max(...samples) : p.def.base === 'center' ? samples[0] : Math.min(...samples);
      }
      const baseY = y;
      const ctx: LandmarkCtx = {
        W: p.W, D: p.D,
        polys: p.polys.map((poly) => poly.map((q) => toLocal(q[0], q[1]))),
        heights: p.buildings.map((b) => b.height),
        baseY,
        recipe, lamps,
        toLocal, toWorld,
        /** Ground height relative to the landmark base at a local point. */
        ground: (lx: number, lz: number) => { const w = toWorld(lx, lz); return groundAt(w[0], w[1]) - baseY; },
        onUpdate: (fn) => updaters.push(fn),
        game: g,
      };
      const out = p.def.build(ctx);
      const built = out.kit.build(p.def.id);
      tris += built.tris; meshes += built.meshes;
      const root = new THREE.Group();
      root.name = `landmark:${p.def.id}`;
      root.position.set(p.x, baseY, p.z);
      root.rotation.y = p.rotY;
      const lod = new THREE.LOD();
      lod.addLevel(built.near, 0, 0.1);
      lod.addLevel(built.far, p.def.lodDist ?? 220, 0.1);
      root.add(lod);
      if (out.extra) root.add(out.extra);
      if (p.def.backdrop) root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
      root.updateMatrixWorld(true);
      group.add(root);
      root.userData.landmark = { id: p.def.id, name: p.def.name, sensitive: !!p.def.sensitive };
      // collider (static trimesh in world space)
      if (body && out.kit.colI.length) {
        const v = new Float32Array(out.kit.colV.length);
        for (let i = 0; i < out.kit.colV.length; i += 3) {
          const lx = out.kit.colV[i], ly = out.kit.colV[i + 1], lz = out.kit.colV[i + 2];
          const w = toWorld(lx, lz);
          v[i] = w[0]; v[i + 1] = ly + baseY; v[i + 2] = w[1];
        }
        const desc = g.rapier.ColliderDesc.trimesh(v, new Uint32Array(out.kit.colI));
        desc.setCollisionGroups(groups(GROUP_STATIC));
        g.physics.createCollider(desc, body);
      }
    } catch (e) { console.error('[landmarks] build failed', p.def.id, e); }
  }
  if (res.placements.length) console.info(`[landmarks] built ${res.placements.length}: ${meshes} meshes, ${Math.round(tris)} tris`);
  let lastNight = -1;
  return {
    group,
    update(game: Game) {
      const n = game.sky?.nightFactor ?? 0;
      landmarkNight.value = n;
      if (Math.abs(n - lastNight) > 0.002) {
        lastNight = n;
        for (const l of lamps) l.mat.emissiveIntensity = l.day + (l.night - l.day) * n;
      }
      for (const u of updaters) u(game);
    },
  };
}

// ---------------------------------------------------------------- geometry helpers

interface Obb { cx: number; cz: number; ux: number; uz: number; lu: number; lv: number }

/** Minimum-area oriented rectangle of a point set (rotating calipers over hull edges). */
export function fitObb(pts: Vec2[]): Obb {
  const hull = convexHull(pts);
  let best: Obb | null = null, bestA = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const A = (maxU - minU) * (maxV - minV);
    if (A < bestA) {
      bestA = A;
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, lu: maxU - minU, lv: maxV - minV };
    }
  }
  return best!;
}

function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Vec2[] = [], up: Vec2[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Pick the OBB axis the front faces; returns world front direction + fitted width (across) / depth (along front). */
function frontDir(front: Front | undefined, o: Obb, recipe: Recipe, proj: ReturnType<typeof makeProjection>): { dir: Vec2; w: number; d: number } {
  // candidate outward axes: ±u (depth = lu), ±v (depth = lv)
  const cands: { dir: Vec2; w: number; d: number }[] = [
    { dir: [o.ux, o.uz], w: o.lv, d: o.lu }, { dir: [-o.ux, -o.uz], w: o.lv, d: o.lu },
    { dir: [-o.uz, o.ux], w: o.lu, d: o.lv }, { dir: [o.uz, -o.ux], w: o.lu, d: o.lv },
  ];
  let target: Vec2 | null = null;
  if (!front || front === 'long') {
    // front on a long side (depth = short extent); prefer facing south (+z) for determinism
    const c = cands.filter((k) => k.d <= k.w + 1e-6);
    return c.sort((a, b) => b.dir[1] - a.dir[1])[0] ?? cands[0];
  }
  if ('dir' in front) target = [o.cx + front.dir[0] * 1000, o.cz + front.dir[1] * 1000];
  else if ('latlon' in front) target = proj.toLocal(front.latlon[0], front.latlon[1]);
  else if ('area' in front) {
    const a = recipe.areas.find((a) => a.id === front.area);
    if (a) target = a.poly.reduce<Vec2>((s, q) => [s[0] + q[0] / a.poly.length, s[1] + q[1] / a.poly.length], [0, 0]);
  } else if ('road' in front) {
    let best = Infinity;
    for (const r of recipe.roads) {
      if (r.name !== front.road) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const q = closestOnSeg([o.cx, o.cz], r.pts[i], r.pts[i + 1]);
        const d = Math.hypot(q[0] - o.cx, q[1] - o.cz);
        if (d < best) { best = d; target = q; }
      }
    }
  }
  if (!target) return cands[0];
  const tx = target[0] - o.cx, tz = target[1] - o.cz;
  return cands.sort((a, b) => (b.dir[0] * tx + b.dir[1] * tz) - (a.dir[0] * tx + a.dir[1] * tz))[0];
}

function closestOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2));
  return [a[0] + dx * t, a[1] + dz * t];
}
