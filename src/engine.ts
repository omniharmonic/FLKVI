// Game engine entry, loaded via dynamic import() once a location is picked (main.ts). Everything heavy lives
// behind this boundary: three.js, Rapier (base64-inlined WASM), postprocessing/N8AO, ez-tree, world, gameplay,
// AI, surveillance, HUD. The title screen and picker never wait on it.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Recipe } from './core/types';
import type { SpawnLocation } from './core/location';
import { Game } from './core/game';
import { setupRendering } from './render';
import { buildWorld } from './world';
import { setupGameplay } from './game';
import { setupAI } from './ai';
import { setupSurveillance } from './surveillance';
import { setupAudio } from './audio';
import { setupHUD, playArrival } from './ui';

type Loading = { update(stage: string, f: number): void; done(): void };

let rapierReady: Promise<void> | null = null;
/** Compile/instantiate Rapier's WASM once (safe to call early, e.g. from an idle prefetch). */
export function initPhysics(): Promise<void> {
  return (rapierReady ??= RAPIER.init());
}

/** Build the world from a recipe and start the game loop. Rapier init completes before any physics use. */
export async function startGame(recipe: Recipe, loc: SpawnLocation, container: HTMLElement, loading: Loading): Promise<void> {
  await initPhysics();
  const g = new Game(recipe, container);
  (window as any).game = g; // debug handle
  g.rapier = RAPIER;
  g.mode = loc.mode ?? 'takedown';
  g.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  loading.update('Lighting the sky', 0.42);
  await setupRendering(g);
  await setupAudio(g);
  await buildWorld(g, (s, f) => loading.update(s, 0.45 + f * 0.4));
  loading.update('Spawning player', 0.88);
  await setupGameplay(g);
  loading.update('Populating the city', 0.92);
  await setupAI(g);
  loading.update('Wiring the surveillance grid', 0.96);
  await setupSurveillance(g);
  setupHUD(g);
  loading.update('Compiling shaders', 0.98);
  await prewarmShaders(g);
  g.events.emit('worldReady', {});
  loading.done();
  g.start();
  await playArrival(g); // cinematic fly-in (skippable; ?nointro skips)
  g.events.emit('runStart', {});
}

/**
 * Link every shader program the first minutes of play need behind the loading screen. The world warm-up
 * (world/index.ts) runs before gameplay / AI / surveillance exist, so their objects (smoke, skid marks, spark
 * and spray VFX, grinder, surveillance hardware) and the things heat escalation spawns (police cars with light
 * bars, officers with flashlights, helicopter + searchlight) would otherwise compile on first use: a 30–70 ms
 * hitch at the worst moment. Modules add hidden stand-ins to a parked, invisible group (never rendered; their
 * materials keep the programs alive), then the whole scene is compiled once more (cache hits for the rest).
 */
async function prewarmShaders(g: Game): Promise<void> {
  if (new URLSearchParams(location.search).has('noprewarm')) return; // A/B the first-use hitches
  const holder = new THREE.Group();
  holder.name = 'shader-prewarm';
  holder.visible = false;
  holder.matrixAutoUpdate = false;
  try { (g.vehicles as { prewarm?(h: THREE.Object3D): void } | undefined)?.prewarm?.(holder); } catch (e) { console.warn('[prewarm] vehicles', e); }
  try { (g.ai as { police?: { prewarm?(h: THREE.Object3D): void } } | undefined)?.police?.prewarm?.(holder); } catch (e) { console.warn('[prewarm] police', e); }
  g.scene.add(holder);
  const t0 = performance.now();
  const before = g.renderer.info.programs?.length ?? 0;
  try {
    // same offscreen target as the world warm-up: program variants depend on the target's colour space
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const prev = g.renderer.getRenderTarget();
    g.renderer.setRenderTarget(rt);
    const warm = g.renderer.compileAsync(g.scene, g.camera);
    g.renderer.setRenderTarget(prev);
    await Promise.race([warm.catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
    rt.dispose();
  } catch (e) { console.warn('[prewarm] compile failed', e); }
  // compile() skips shadow-depth variants (skinned officers, car hulls…): draw one frame (still behind the loading
  // screen) with the stand-ins at the spawn point, inside the sun's shadow frustum, then park them again.
  try {
    const sp = g.recipe.spawn;
    holder.position.set(sp.p[0], (g.world?.groundAt?.(sp.p[0], sp.p[1]) ?? sp.y ?? 0) - 0.5, sp.p[1] + 6);
    holder.updateMatrix();
    holder.visible = true;
    g.scene.updateMatrixWorld();
    g.renderFrame(0);
  } catch (e) { console.warn('[prewarm] frame failed', e); }
  holder.visible = false;
  console.info(`[prewarm] ${(g.renderer.info.programs?.length ?? 0) - before} programs linked in ${(performance.now() - t0).toFixed(0)} ms`);
}
