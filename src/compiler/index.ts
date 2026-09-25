// OWNER: compiler agent. Runtime World Compiler: OSM (Overpass) + terrain tiles → Recipe.
// Baked cities load from public/recipes/<id>.json; anything else compiles live in a Web Worker
// (falls back to the main thread if workers are unavailable).
import type { Recipe } from '../core/types';
import type { SpawnLocation, Progress } from '../core/location';
import type { CompileOptions } from './compile.ts';
import { unpackRecipe } from './unpack.ts';
import { BAKED_CITIES } from './cities.ts';

export { BAKED_CITIES } from './cities.ts';
export type { BakedCity } from './cities.ts';

const COMPILE_TIMEOUT_MS = 180_000;
/** Live compiles cover a smaller square than baked cities (800 m vs 1.2 km) so they finish in well under a minute. */
export const LIVE_HALF_M = 400;
/** Bump when compiler output changes so cached live recipes are rebuilt. */
const COMPILER_VERSION = 3;
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
    const cached = await cacheGet(loc.lat, loc.lon);
    if (cached) { onProgress('Loaded from cache', 1); recipe = cached; }
    else {
      const t0 = performance.now();
      recipe = await compileLive({ lat: loc.lat, lon: loc.lon, name: loc.name, half: LIVE_HALF_M, lean: true }, onProgress);
      console.info(`[compiler] live compile of ${loc.name} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      void cachePut(recipe);
    }
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
export function compileLive(opts: CompileOptions, onProgress: Progress, control: { timeoutMs?: number; allowMainThreadFallback?: boolean } = {}): Promise<Recipe> {
  return new Promise<Recipe>((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      console.warn('[compiler] worker unavailable, compiling on main thread', e);
    }
    if (!worker) {
      if(control.allowMainThreadFallback===false){reject(new Error('Background compiler unavailable'));return;}
      compileMain(opts, onProgress).then(resolve, reject);
      return;
    }
    const w = worker;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; w.terminate(); reject(new Error('World compile timed out — OpenStreetMap servers may be busy. Try again or pick a featured city.')); } }, control.timeoutMs ?? COMPILE_TIMEOUT_MS);
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
      if(control.allowMainThreadFallback===false){reject(new Error(ev.message||'Background compiler failed'));return;}
      console.warn('[compiler] worker failed, retrying on main thread', ev.message);
      compileMain(opts, onProgress).then(resolve, reject);
    };
    w.postMessage({ opts });
  }).then((r) => r);
}

// The compiler itself is only loaded for main-thread live compiles (the worker bundles its own copy).
async function compileMain(opts: CompileOptions, onProgress: Progress): Promise<Recipe> {
  const [{ compileRecipe }, { fetchOverpass }, { browserTileLoader }] = await Promise.all([import('./compile.ts'), import('./osm.ts'), import('./terrain.ts')]);
  let lastF = 0;
  return compileRecipe(opts, {
    overpass: (q, onBytes) => fetchOverpass(q, { onBytes, onStatus: (s) => onProgress(s, lastF), timeoutMs: 90_000, hedgeMs: 15_000 }),
    tiles: browserTileLoader(), log: (m) => console.info('[compiler]', m),
  }, (s, f) => { lastF = f; onProgress(s, f); });
}

// ---------- IndexedDB cache of recent live recipes (best effort: every failure just means "not cached") ----------
const DB_NAME = 'groundtruth-recipes', STORE = 'live', MAX_CACHED = 6, NEAR_M = 60;
interface CacheRow { key: string; v: number; lat: number; lon: number; t: number; recipe: Recipe }

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE, { keyPath: 'key' }); } catch { /* exists */ } };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
function allRows(db: IDBDatabase): Promise<CacheRow[]> {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as CacheRow[]) ?? []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}
async function cacheGet(lat: number, lon: number): Promise<Recipe | null> {
  try {
    const db = await openDb(); if (!db) return null;
    const rows = await allRows(db);
    db.close();
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    let best: CacheRow | null = null, bd = NEAR_M;
    for (const r of rows) {
      if (r.v !== COMPILER_VERSION) continue;
      const d = Math.hypot((r.lat - lat) * 110540, (r.lon - lon) * kx);
      if (d <= bd) { bd = d; best = r; }
    }
    return best ? best.recipe : null;
  } catch { return null; }
}
async function cachePut(recipe: Recipe): Promise<void> {
  try {
    const db = await openDb(); if (!db) return;
    const rows = await allRows(db);
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        const stale = rows.filter((r) => r.v !== COMPILER_VERSION).concat(rows.filter((r) => r.v === COMPILER_VERSION).sort((a, b) => b.t - a.t).slice(MAX_CACHED - 1));
        for (const r of stale) st.delete(r.key);
        const { lat, lon } = recipe.origin;
        st.put({ key: `${lat.toFixed(5)},${lon.toFixed(5)}`, v: COMPILER_VERSION, lat, lon, t: Date.now(), recipe } satisfies CacheRow);
        tx.oncomplete = () => resolve(); tx.onerror = () => resolve(); tx.onabort = () => resolve();
      } catch { resolve(); }
    });
    db.close();
  } catch { /* quota / private mode: ignore */ }
}

export function isInUS(lat: number, lon: number): boolean {
  if (lat > 24 && lat < 49.5 && lon > -125 && lon < -66.5) return true;
  if (lat > 51 && lat < 72 && lon > -170 && lon < -129) return true; // Alaska
  if (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) return true; // Hawaii
  return false;
}
