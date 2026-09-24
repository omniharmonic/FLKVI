// Footprint neighbor index: which facade edges are party walls (another building within ~2 m outside them).
// Used by the facade grammar so that only walls that actually abut a neighbor are left blank.
import type { RecipeBuilding, Vec2 } from '../../core/types';

const CELL = 24;
interface Entry { b: RecipeBuilding; minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number }
let grid: Map<string, Entry[]> | null = null;

/** (Re)build the index for a recipe's buildings. Call once before generating facades. */
export function setBuildingIndex(buildings: RecipeBuilding[] | undefined) {
  grid = new Map();
  for (const b of buildings ?? []) {
    const fp = b.footprint;
    if (!fp || fp.length < 3 || !(b.height > 2)) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of fp) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const e: Entry = { b, minX, maxX, minZ, maxZ, y0: b.baseY + (b.minHeight ?? 0), y1: b.baseY + b.height };
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
      const k = i + ',' + j; let l = grid.get(k); if (!l) grid.set(k, (l = [])); l.push(e);
    }
  }
}

function inside(x: number, z: number, poly: Vec2[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

export interface Abutment { cover: number; top: number; /** per-sample flags along the edge (sample k at s = 0.4 + (L - 0.8)(k + 0.5)/n) */ mask?: Uint8Array }

/** Is facade position s (m along the edge) in front of a neighbor? */
export function abuttedAt(ab: Abutment | undefined, L: number, s: number): boolean {
  const m = ab?.mask;
  if (!m || !m.length) return false;
  const k = Math.floor((s - 0.4) / Math.max(0.1, L - 0.8) * m.length);
  return m[Math.max(0, Math.min(m.length - 1, k))] === 1;
}

/**
 * Fraction (0..1) of edge a→q whose outside (outward normal n) is occupied by another building within ~2 m,
 * and the lowest top among those neighbors (the wall above it is exposed). Neighbors must overlap this
 * building's wall height range [y0, y1] to count.
 */
export function edgeAbutment(self: RecipeBuilding, a: Vec2, q: Vec2, n: Vec2, y0: number, y1: number): Abutment {
  if (!grid) return { cover: 0, top: -Infinity };
  const dx = q[0] - a[0], dz = q[1] - a[1];
  const L = Math.hypot(dx, dz);
  if (L < 0.5) return { cover: 0, top: -Infinity };
  const tx = dx / L, tz = dz / L;
  const ns = Math.max(2, Math.min(24, Math.round(L / 1.5)));
  let hits = 0, top = Infinity;
  const mask = new Uint8Array(ns);
  for (let k = 0; k < ns; k++) {
    const s = 0.4 + (L - 0.8) * (k + 0.5) / ns;
    let hit = false;
    for (const off of [0.6, 1.9]) {
      const x = a[0] + tx * s + n[0] * off, z = a[1] + tz * s + n[1] * off;
      for (const e of grid.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) ?? []) {
        if (e.b === self || x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
        if (e.y1 < y0 + 2 || e.y0 > y1 - 1) continue;
        if (!inside(x, z, e.b.footprint)) continue;
        hit = true; top = Math.min(top, e.y1);
        break;
      }
      if (hit) break;
    }
    if (hit) { hits++; mask[k] = 1; }
  }
  return { cover: hits / ns, top: hits ? top : -Infinity, mask: hits ? mask : undefined };
}
