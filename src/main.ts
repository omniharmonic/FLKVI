// Boot sequence. Owned by the lead (integration). Modules plug in via their setup functions.
// Only the title screen / picker / loading screen are in the initial bundle; the game engine (./engine) is a
// separate chunk graph fetched via import() when a location is picked, in parallel with the recipe download
// (and prefetched while the player idles on the title screen).
import './ui/styles.css';
import { loadRecipe } from './compiler';
import { showSpawnPicker, showLoading } from './ui/boot';
import { unsupportedReason } from './ui/guard';

type EngineModule = typeof import('./engine');
let engineP: Promise<EngineModule> | null = null;
function loadEngine(): Promise<EngineModule> {
  if (!engineP) {
    engineP = import('./engine');
    engineP.then((m) => m.initPhysics()).catch(() => { /* surfaced by boot() */ });
    engineP.catch(() => { engineP = null; }); // allow a retry after a network blip
  }
  return engineP;
}

async function boot() {
  const container = document.getElementById('app')!;
  // Warm the engine chunks once the title has painted and the browser is idle, so picking a city is quick.
  const idle = (cb: () => void) => ('requestIdleCallback' in window ? (window as any).requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500));
  const prefetch = unsupportedReason() ? 0 : setTimeout(() => idle(() => { void loadEngine(); }), 3500);
  const loc = await showSpawnPicker();
  clearTimeout(prefetch);
  const engine = loadEngine();
  const loading = showLoading();
  try {
    const recipe = await loadRecipe(loc, (s, f) => loading.update(s, f * 0.4));
    // engine chunks usually finish first; if not, say what we're waiting on
    const ready = await Promise.race([engine, Promise.resolve(null)]);
    if (!ready) loading.update('Loading game engine', 0.4);
    const { startGame } = ready ?? await engine;
    await startGame(recipe, loc, container, loading);
  } catch (e) {
    console.error(e);
    loading.update(`Failed: ${(e as Error).message}`, 1);
  }
}

boot();
