import type { Climate, Recipe } from '../core/types.ts';
export type Biome = 'alpine' | 'desert' | 'plains' | 'temperate' | 'coastal';
/** Terrain elevation separates mountain settlements from nearby arid lowlands. */
export function biomeFor(lat: number, lon: number, elevation: number, climate: Climate): Biome {
  if (lat > 34 && elevation > 2350) return 'alpine';
  if (climate === 'arid' && (lon < -106.7 || lat < 37) && elevation < 2300) return 'desert';
  if (lon > -105 && lon < -96 && lat > 30 && lat < 49 && elevation < 1900) return 'plains';
  if (climate === 'coastal') return 'coastal';
  return 'temperate';
}
export function recipeBiome(recipe: Recipe): Biome {
  return recipe.biome ?? biomeFor(recipe.origin.lat,recipe.origin.lon,(recipe.elevation??0)+(recipe.spawn?.y??0),recipe.climate);
}
export function snowline(lat: number) { return Math.max(1500,3400-(lat-39)*90); }
