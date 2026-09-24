// Recipe unpacking (delta-coded terrain → heights). Split out of compile.ts so baked-city loads and the
// title backdrop don't pull the whole live compiler into the initial bundle. compile.ts re-exports these.
import type { Recipe, Terrain } from '../core/types.ts';

export function unpackTerrain(t: any): Terrain {
  if (!t || !t.q) return t;
  const { scale, d } = t.q as { scale: number; d: number[] };
  const h: number[] = new Array(d.length);
  let acc = 0;
  for (let i = 0; i < d.length; i++) { acc += d[i]; h[i] = Math.round(acc * scale * 1000) / 1000; }
  const { q, ...rest } = t;
  void q;
  return { ...rest, heights: h };
}
export function unpackRecipe(j: any): Recipe {
  j.terrain = unpackTerrain(j.terrain);
  if (j.farTerrain) j.farTerrain = unpackTerrain(j.farTerrain);
  return j as Recipe;
}
