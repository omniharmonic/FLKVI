// OWNER: compiler agent. Runtime World Compiler: OSM (Overpass) + terrain tiles → Recipe.
import type { Recipe } from '../core/types';
import type { SpawnLocation, Progress } from '../core/location';

export async function loadRecipe(loc: SpawnLocation, onProgress: Progress): Promise<Recipe> {
  onProgress('stub', 1);
  throw new Error('compiler not implemented');
}
