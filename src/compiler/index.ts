// Startup reads hosted world chunks. Offline/out-of-coverage starts use labeled procedural geography.
// Live compilation remains an explicit development API, never a startup dependency.
import type { Recipe } from '../core/types';
import type { SpawnLocation, Progress } from '../core/location';
import type { CompileOptions } from './compile.ts';
import { unpackRecipe } from './unpack.ts';
import { BAKED_CITIES } from './cities.ts';
import { loadHostedWorld } from './world-store.ts';
import { generatedStart } from './generated-start.ts';

export { BAKED_CITIES } from './cities.ts';
export type { BakedCity } from './cities.ts';

const COMPILE_TIMEOUT_MS = 180_000;
/** Live compiles cover a smaller square than baked cities (800 m vs 1.2 km) so they finish in well under a minute. */
export const LIVE_HALF_M = 400;
const memo = new Map<string, Recipe>();

export async function loadRecipe(loc: SpawnLocation, onProgress: Progress): Promise<Recipe> {
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon) || Math.abs(loc.lat) > 90 || Math.abs(loc.lon) > 180) throw new Error('Invalid world coordinates');
  const key = `${loc.baked ?? 'pin'}:${loc.lat.toFixed(5)},${loc.lon.toFixed(5)}`;
  const hit = memo.get(key);
  if (hit) { onProgress('World ready', 1); return hit; }
  try {
    const hosted = await loadHostedWorld(loc, onProgress);
    if (hosted) { memo.set(key, hosted); onProgress('World ready', 1); return hosted; }
  } catch (error) {
    console.warn('[compiler] hosted map unavailable', error);
    // Legacy packs are an outage fallback for known cities, never a substitute for a custom pin.
    if (loc.baked && BAKED_CITIES.some(city => city.id === loc.baked)) {
      try {
        const legacy = await loadBaked(loc.baked, onProgress);
        memo.set(key, legacy);
        return legacy;
      } catch (legacyError) { console.warn('[compiler] legacy map unavailable', legacyError); }
    }
  }
  onProgress('Creating generated world · fictional geography', 0.92);
  const generated = generatedStart(loc);
  // Do not memoize/persist fallback as mapped data: the next start may have hosted coverage.
  onProgress('Generated world ready · fictional geography', 1);
  return generated;
}

async function loadBaked(id: string, onProgress: Progress): Promise<Recipe> {
  onProgress('Downloading city', 0.05);
  const url = `${import.meta.env.BASE_URL}recipes/${id}.json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

export function isInUS(lat: number, lon: number): boolean {
  if (lat > 24 && lat < 49.5 && lon > -125 && lon < -66.5) return true;
  if (lat > 51 && lat < 72 && lon > -170 && lon < -129) return true; // Alaska
  if (lat > 18.5 && lat < 22.5 && lon > -161 && lon < -154) return true; // Hawaii
  return false;
}
