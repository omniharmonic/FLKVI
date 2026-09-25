import type { CompileOptions } from './compile';
import type { Recipe } from '../core/types';
import { compileLive } from './index';
const CACHE = 'gt-districts-v2', LIMIT = 12;
/** Bounded, persistent cache; CacheStorage failure only disables caching. No server required. */
export async function loadDistrict(opts: CompileOptions, progress: (s: string, f: number) => void): Promise<Recipe> {
  const key = new URL(`${import.meta.env.BASE_URL}__district/${opts.lat.toFixed(6)},${opts.lon.toFixed(6)},${opts.half}.json`, location.origin).href;
  let cache: Cache | undefined;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) { progress('District loaded from cache', 1); return await hit.json(); }
  } catch { /* private browsing / quota */ }
  const recipe = await compileLive(opts, progress, {timeoutMs:6500,allowMainThreadFallback:false});
  if (cache) try {
    await cache.put(key, new Response(JSON.stringify(recipe), { headers: { 'Content-Type': 'application/json' } }));
    const keys = await cache.keys();
    for (const old of keys.slice(0, Math.max(0, keys.length - LIMIT))) await cache.delete(old);
  } catch { /* quota */ }
  return recipe;
}
