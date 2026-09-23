// OWNER: compiler agent. Runtime World Compiler: OSM (Overpass) + terrain tiles → Recipe.
// Baked cities load from public/recipes/<id>.json; anything else compiles live in a Web Worker
// (falls back to the main thread if workers are unavailable).
import type { Recipe } from '../core/types';
import type { SpawnLocation, Progress } from '../core/location';
import { compileRecipe, unpackRecipe, type CompileOptions } from './compile.ts';
import { fetchOverpass } from './osm.ts';
import { browserTileLoader } from './terrain.ts';
import { BAKED_CITIES } from './cities.ts';

export { BAKED_CITIES } from './cities.ts';
export type { BakedCity } from './cities.ts';

const COMPILE_TIMEOUT_MS = 240_000;
const memo = new Map<string, Recipe>();

export async function loadRecipe(loc: SpawnLocation, onProgress: Progress): Promise<Recipe> {
  const key = loc.baked ? `baked:${loc.baked}` : `${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;
  const hit = memo.get(key);
  if (hit) { onProgress('World ready', 1); return hit; }
  let recipe: Recipe;
  if (loc.baked) {
    try { recipe = await loadBaked(loc.baked, onProgress); }
    catch (e) {
      console.warn(`[compiler] baked recipe '${loc.baked}' failed, compiling live`, e);
      const city = BAKED_CITIES.find((c) => c.id === loc.baked);
      recipe = await compileLive({ lat: city?.lat ?? loc.lat, lon: city?.lon ?? loc.lon, name: city?.name ?? loc.name }, onProgress);
    }
  } else {
    if (!isInUS(loc.lat, loc.lon)) console.warn('[compiler] location looks outside the US; regional priors may be off');
    recipe = await compileLive({ lat: loc.lat, lon: loc.lon, name: loc.name }, onProgress);
  }
  memo.set(key, recipe);
  return recipe;
}

async function loadBaked(id: string, onProgress: Progress): Promise<Recipe> {
  onProgress('Downloading city', 0.05);
  const url = `${import.meta.env.BASE_URL}recipes/${id}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  let text: string;
  if (res.body && total > 0) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress('Downloading city', 0.05 + 0.8 * Math.min(1, got / total));
    }
    const buf = new Uint8Array(got); let o = 0;
    for (const c of chunks) { buf.set(c, o); o += c.length; }
    text = new TextDecoder().decode(buf);
  } else text = await res.text();
  onProgress('Unpacking city', 0.9);
  const r = unpackRecipe(JSON.parse(text));
  onProgress('World ready', 1);
  return r;
}

/** Live compile of an arbitrary lat/lon. Uses a module Worker; falls back to main thread. */
export function compileLive(opts: CompileOptions, onProgress: Progress): Promise<Recipe> {
  return new Promise<Recipe>((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('[compiler] worker unavailable, compiling on main thread', e);
    }
    if (!worker) {
      compileMain(opts, onProgress).then(resolve, reject);
      return;
    }
    const w = worker;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; w.terminate(); reject(new Error('World compile timed out — OpenStreetMap servers may be busy. Try again or pick a featured city.')); } }, COMPILE_TIMEOUT_MS);
    let lastF = 0;
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'progress') { lastF = m.f; onProgress(m.stage, m.f); }
      else if (m.type === 'status') onProgress(m.text, lastF);
      else if (m.type === 'log') console.info('[compiler]', m.text);
      else if (m.type === 'done') { settled = true; clearTimeout(timer); w.terminate(); resolve(m.recipe as Recipe); }
      else if (m.type === 'error') { settled = true; clearTimeout(timer); w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (ev) => {
      if (settled) return;
      settled = true; clearTimeout(timer); w.terminate();
      console.warn('[compiler] worker failed, retrying on main thread', ev.message);
      compileMain(opts, onProgress).then(resolve, reject);
    };
    w.postMessage({ opts });
  }).then((r) => r);
}

function compileMain(opts: CompileOptions, onProgress: Progress): Promise<Recipe> {
  return compileRecipe(opts, { overpass: (q) => fetchOverpass(q), tiles: browserTileLoader(), log: (m) => console.info('[compiler]', m) }, onProgress);
}

export function isInUS(lat: number, lon: number): boolean {
  if (lat > 24 && lat < 49.5 && lon > -125 && lon < -66.5) return true;
  if (lat > 51 && lat < 72 && lon > -170 && lon < -129) return true; // Alaska
  if (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) return true; // Hawaii
  return false;
}
