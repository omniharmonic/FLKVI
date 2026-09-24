// Building foundations. The compiler's baseY is the minimum of the raw DEM under a footprint; on real grades
// (Savannah's bluff, SF / Seattle hills) that buries the street side of a building by metres, and it ignores the
// road flattening the world applies afterwards. Here every building is re-seated on the ground as rendered:
//   · base = the level of its street frontage (the highest frontage when it faces streets on two levels, as the
//     Bay Street buildings do over Factors Walk), else a high percentile of the ground around it;
//   · where the ground falls away below that base a textured plinth (rubble stone for old buildings, board-formed
//     concrete otherwise) runs down to the lowest ground point, so nothing floats;
//   · small mismatches (< ~1 m) are graded out of the terrain around the footprint instead.
// Landmarks matched to OSM footprints (default 'min' base) get the same treatment.
import type { Recipe, RecipeBuilding, Vec2 } from '../core/types';
import type { Heightfield } from './terrain';
import type { RoadNetwork } from './roads';
import type { ResolvedLandmarks } from './landmarks';
import { Grid, pointInPoly, polyArea, type ChunkBatcher } from './util';
import { waterLevelFn } from './areas';

/** Plinth bottom (lowest ground − margin) for buildings lifted above part of their footprint; physics extends
 *  building colliders down to it. */
export const foundationBottom = new WeakMap<RecipeBuilding, number>();

export interface Prism { ring: Vec2[]; y0: number; y1: number }

const OLD_ERAS = new Set(['pre-1900', '1900-1939']);
/** Tallest plinth allowed under a building (m). */
const MAX_PLINTH = 6;

export function settleFoundations(recipe: Recipe, hf: Heightfield, roads: RoadNetwork, lm: ResolvedLandmarks, B: ChunkBatcher) {
  // water surfaces (same level rule as areas.ts): moored boats / piers mapped as buildings float on them, and a
  // plinth only needs to reach the water line (not the carved bed below it)
  const waters = recipe.areas.filter((a) => a.kind === 'water' && a.poly.length >= 3).map((a) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of a.poly) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    return { a, lvl: waterLevelFn(a, hf), x0, z0, x1, z1 };
  });
  const waterAt = (x: number, z: number) => {
    for (const w of waters) {
      if (x < w.x0 || x > w.x1 || z < w.z0 || z > w.z1) continue;
      if (pointInPoly(x, z, w.a.poly) && !(w.a.holes ?? []).some((h) => pointInPoly(x, z, h))) return w.lvl(x, z);
    }
    return null;
  };
  /** Water level of a water area within 40 m of the footprint (moored hulls just outside the clipped outline). */
  const nearWater = (ring: Vec2[]) => {
    for (const p of ring) for (const [dx, dz] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20], [40, 0], [-40, 0], [0, 40], [0, -40]]) {
      const wl = waterAt(p[0] + dx, p[1] + dz);
      if (wl !== null) return wl;
    }
    return null;
  };
  const ground = (x: number, z: number) => {
    let t = hf.sample(x, z);
    const wl = waterAt(x, z);
    if (wl !== null) t = Math.max(t, wl);
    const s = roads.surfaceAt(x, z);
    if (!s || s.kind === 'deck') return t;
    return Math.max(t, s.y);
  };
  const wBest = new Float32Array(hf.cols * hf.rows);
  const wTarget = new Float32Array(hf.cols * hf.rows);
  const prisms: Prism[] = [];
  let moved = 0, plinths = 0, maxLift = 0, worst = '', dropped = 0, clamped = 0;

  /** Ground samples just outside each edge (+ which ones front a street). */
  const survey = (ring: Vec2[]) => {
    const ccw = polyArea(ring) > 0;
    const all: number[] = [];
    const edges: { mean: number; len: number; front: boolean }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 0.2) continue;
      const nx = (ccw ? dz : -dz) / L, nz = (ccw ? -dx : dx) / L;
      const k = Math.max(1, Math.ceil(L / 1.5));
      let sum = 0, nFront = 0;
      for (let j = 0; j < k; j++) {
        const t = (j + 0.5) / k, x = a[0] + dx * t, z = a[1] + dz * t;
        const g = ground(x + nx * 0.35, z + nz * 0.35);
        all.push(g); sum += g;
        // frontage: a sidewalk / street within a few metres (forecourts, steps and planting strips in between)
        for (const d of [1.2, 3.5, 6]) { const s = roads.surfaceAt(x + nx * d, z + nz * d); if (s && s.kind !== 'deck') { nFront++; break; } }
      }
      edges.push({ mean: sum / k, len: L, front: nFront * 2 >= k });
    }
    return { all, edges, ccw };
  };
  const chooseBase = (ring: Vec2[]) => {
    const { all, edges } = survey(ring);
    if (!all.length) return null;
    let gMin = Infinity, gMax = -Infinity;
    for (const g of all) { gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); }
    let base: number;
    if (gMax - gMin < 0.4) base = gMin;
    else {
      const fronts = edges.filter((e) => e.front && e.len >= 3);
      if (fronts.length) base = Math.max(...fronts.map((e) => e.mean));
      else { const s = all.slice().sort((p, q) => p - q); base = s[Math.min(s.length - 1, Math.floor(s.length * 0.6))]; }
      base = Math.max(gMin, Math.min(gMax, base));
    }
    return { base, gMin, gMax };
  };

  /** Grade small mismatches out of the terrain within `R` m of the footprint (never under streets). */
  const grade = (ring: Vec2[], base: number) => {
    const R = 2.5;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of ring) { x0 = Math.min(x0, p[0]); z0 = Math.min(z0, p[1]); x1 = Math.max(x1, p[0]); z1 = Math.max(z1, p[1]); }
    const c0 = Math.max(0, Math.floor((x0 - R - hf.ox) / hf.cell)), c1 = Math.min(hf.cols - 1, Math.ceil((x1 + R - hf.ox) / hf.cell));
    const r0 = Math.max(0, Math.floor((z0 - R - hf.oz) / hf.cell)), r1 = Math.min(hf.rows - 1, Math.ceil((z1 + R - hf.oz) / hf.cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * hf.cols + c;
      const x = hf.ox + c * hf.cell, z = hf.oz + r * hf.cell;
      const h = hf.h[k];
      if (Math.abs(h - base) > 1.1) continue;
      let w = 1;
      if (!pointInPoly(x, z, ring)) {
        let d = Infinity;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
          d = Math.min(d, Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t));
        }
        if (d >= R) continue;
        w = 1 - d / R; w = w * w * (3 - 2 * w);
        if (roads.surfaceAt(x, z)) continue;
      }
      // fade the grading out as the mismatch approaches the plinth / burial regime
      w *= 1 - Math.max(0, (Math.abs(h - base) - 0.7) / 0.4);
      if (w > wBest[k]) { wBest[k] = w; wTarget[k] = base - 0.03; }
    }
  };

  /** Plinth wall along `ring` from `top` down to the ground (+ a 6 cm ledge), only where the ground drops away. */
  const plinth = (ring: Vec2[], top: number, mat: string) => {
    const ccw = polyArea(ring) > 0;
    const n = ring.length;
    const nrm: Vec2[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
      nrm.push([(ccw ? dz : -dz) / L, (ccw ? -dx : dx) / L]);
    }
    const OUT = 0.06;
    const offs: Vec2[] = ring.map((p, i) => {
      const n1 = nrm[(i + n - 1) % n], n2 = nrm[i];
      let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const k = Math.min(3, 1 / Math.max(0.3, mx * n2[0] + mz * n2[1]));
      return [p[0] + mx * OUT * k, p[1] + mz * OUT * k];
    });
    let u = 0, any = false;
    const mb = B.get(mat, ring[0][0], ring[0][1]);
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n], A = offs[i], Bo = offs[(i + 1) % n];
      const [nx, nz] = nrm[i];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 0.05) continue;
      const k = Math.max(1, Math.ceil(L / 2));
      const bottom: number[] = [];
      for (let j = 0; j <= k; j++) {
        const t = j / k, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        bottom.push(Math.min(ground(x + nx * 0.4, z + nz * 0.4), Math.max(hf.sample(x, z), waterAt(x, z) ?? -Infinity)) - 0.35);
      }
      for (let j = 0; j < k; j++) {
        const t0 = j / k, t1 = (j + 1) / k;
        if (Math.min(bottom[j], bottom[j + 1]) > top - 0.45) continue;
        any = true;
        const p0: Vec2 = [A[0] + (Bo[0] - A[0]) * t0, A[1] + (Bo[1] - A[1]) * t0], p1: Vec2 = [A[0] + (Bo[0] - A[0]) * t1, A[1] + (Bo[1] - A[1]) * t1];
        const y0 = Math.min(bottom[j], top - 0.1), y1 = Math.min(bottom[j + 1], top - 0.1);
        const ua = u + L * t0, ub = u + L * t1;
        const i0 = mb.v(p0[0], y0, p0[1], nx, 0, nz, ua, y0), i1 = mb.v(p1[0], y1, p1[1], nx, 0, nz, ub, y1);
        const i2 = mb.v(p1[0], top, p1[1], nx, 0, nz, ub, top), i3 = mb.v(p0[0], top, p0[1], nx, 0, nz, ua, top);
        mb.triN(i0, i1, i2, nx, 0, nz); mb.triN(i0, i2, i3, nx, 0, nz);
        // ledge (water table) between the wall face and the plinth face
        const q0: Vec2 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], q1: Vec2 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
        const j0 = mb.v(q0[0], top, q0[1], 0, 1, 0, ua, 0), j1 = mb.v(q1[0], top, q1[1], 0, 1, 0, ub, 0);
        const j2 = mb.v(p1[0], top, p1[1], 0, 1, 0, ub, OUT), j3 = mb.v(p0[0], top, p0[1], 0, 1, 0, ua, OUT);
        mb.triN(j0, j1, j2, 0, 1, 0); mb.triN(j0, j2, j3, 0, 1, 0);
      }
      u += L;
    }
    return any;
  };

  // ---- ground-level buildings (parts that start above ground follow their host below)
  const hostGrid = new Grid<RecipeBuilding>(40);
  const upper: RecipeBuilding[] = [];
  for (const b of recipe.buildings) {
    if (!b.footprint || b.footprint.length < 3 || lm.skip.has(b.id)) continue;
    if ((b.minHeight ?? 0) > 0.5) { upper.push(b); continue; }
    const cx = b.footprint.reduce((s, p) => s + p[0], 0) / b.footprint.length, cz = b.footprint.reduce((s, p) => s + p[1], 0) / b.footprint.length;
    const wl = waterAt(cx, cz) ?? (b.boat ? nearWater(b.footprint) : null);
    if (wl !== null) { b.baseY = Math.round((wl + 0.25) * 100) / 100; moved++; continue; }
    const r = chooseBase(b.footprint);
    if (!r) continue;
    let { base } = r;
    const { gMin } = r;
    // vessels mapped as buildings never stand on a plinth: sit them on the lowest ground under the hull
    if (b.boat) { b.baseY = Math.round(gMin * 100) / 100; moved++; continue; }
    // cap: past MAX_PLINTH the "foundation" would be a tower (a hull or pier outside the clipped water outline, a
    // DEM artefact). Sink the building into the slope if at least half of it stays above its frontage, else drop it.
    if (base - gMin > MAX_PLINTH) {
      const sink = base - gMin - MAX_PLINTH;
      if (sink > b.height * 0.5) {
        lm.skip.add(b.id); dropped++;
        const xs = b.footprint.map((p) => p[0]), zs = b.footprint.map((p) => p[1]);
        hostGrid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), b);
        continue;
      }
      base -= sink; clamped++;
    }
    if (Math.abs(base - b.baseY) > 0.05) moved++;
    b.baseY = Math.round(base * 100) / 100;
    grade(b.footprint, b.baseY);
    if (gMin < b.baseY - 0.3 && plinth(b.footprint, b.baseY, b.material === 'stone' || b.material === 'sandstone' || (OLD_ERAS.has(b.era) && b.material.startsWith('brick')) ? 'plinthStone' : 'plinthConc')) {
      plinths++; if (b.baseY - gMin > maxLift) { maxLift = b.baseY - gMin; worst = b.id; }
      foundationBottom.set(b, gMin - 0.4);
    }
    const xs = b.footprint.map((p) => p[0]), zs = b.footprint.map((p) => p[1]);
    hostGrid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), b);
  }
  for (const b of upper) {
    const cx = b.footprint.reduce((s, p) => s + p[0], 0) / b.footprint.length, cz = b.footprint.reduce((s, p) => s + p[1], 0) / b.footprint.length;
    let host: RecipeBuilding | null = null;
    hostGrid.query(cx, cz, 0, (h) => { if (!host && pointInPoly(cx, cz, h.footprint)) host = h; });
    if (host && lm.skip.has((host as RecipeBuilding).id)) { lm.skip.add(b.id); continue; }
    if (host) b.baseY = (host as RecipeBuilding).baseY;
    else { const r = chooseBase(b.footprint); if (r) b.baseY = Math.round(r.base * 100) / 100; }
  }

  // ---- landmarks replacing OSM footprints: seat on the frontage level, plinth under the model's box
  for (const p of lm.placements) {
    if (!p.def.match.osmIds || p.def.base || p.y !== undefined || p.def.backdrop || !(p.W > 1 && p.D > 1)) continue;
    const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
    const toWorld = (lx: number, lz: number): Vec2 => [p.x + lx * c + lz * s, p.z - lx * s + lz * c];
    const W = p.W / 2, D = p.D / 2;
    const rect: Vec2[] = [toWorld(-W, -D), toWorld(W, -D), toWorld(W, D), toWorld(-W, D)];
    const r = chooseBase(rect);
    if (!r) continue;
    p.y = Math.round(r.base * 100) / 100;
    grade(rect, p.y);
    if (r.gMin < p.y - 0.3 && plinth(rect, p.y - 1.4, 'plinthStone')) {
      prisms.push({ ring: rect, y0: r.gMin - 0.4, y1: p.y });
      plinths++; maxLift = Math.max(maxLift, p.y - r.gMin);
    }
  }

  for (let k = 0; k < wBest.length; k++) if (wBest[k] > 0) hf.h[k] += (wTarget[k] - hf.h[k]) * wBest[k];
  return { moved, plinths, maxLift, worst, prisms, dropped, clamped };
}
