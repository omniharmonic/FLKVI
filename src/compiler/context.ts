// OWNER: compiler agent. Shared compile context passed between stages.
import type { Region, Climate, Vec2 } from '../core/types.ts';
import type { Projection } from '../core/geo.ts';
import type { TreePalette } from './region.ts';

export interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }

export interface Ctx {
  lat: number; lon: number; name: string;
  proj: Projection;
  bounds: Bounds;
  region: Region; climate: Climate; palette: TreePalette;
  heightAt(x: number, z: number): number;
  /** 0..1 building coverage around p (≈60 m disc). */
  density(x: number, z: number): number;
  /** 0..1 building coverage over a ≈300 m window: 'is this a town at all' (parking-heavy downtowns score low on density). */
  urban(x: number, z: number): number;
  seed: number;
}

/** Coverage raster: building footprint area accumulated into 20 m cells, read as 3x3 (60 m) window fraction. */
export function makeDensity(items: { c: Vec2; area: number }[], b: Bounds, win = 1) {
  const cell = 20;
  const cols = Math.ceil((b.maxX - b.minX) / cell) + 4, rows = Math.ceil((b.maxZ - b.minZ) / cell) + 4; // 2-cell pad each side
  const g = new Float32Array(cols * rows);
  const ix = (x: number) => Math.floor((x - b.minX) / cell) + 2, iz = (z: number) => Math.floor((z - b.minZ) / cell) + 2;
  for (const it of items) {
    const c = ix(it.c[0]), r = iz(it.c[1]);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    g[r * cols + c] += it.area;
  }
  return (x: number, z: number) => {
    const c = ix(x), r = iz(z);
    let s = 0;
    for (let dr = -win; dr <= win; dr++) for (let dc = -win; dc <= win; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows) s += g[rr * cols + cc];
    }
    return Math.min(1, s / ((2 * win + 1) ** 2 * cell * cell));
  };
}
