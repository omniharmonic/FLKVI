// Game engine entry, loaded via dynamic import() once a location is picked (main.ts). Everything heavy lives
// behind this boundary: three.js, Rapier (base64-inlined WASM), postprocessing/N8AO, ez-tree, world, gameplay,
// AI, surveillance, HUD. The title screen and picker never wait on it.
import RAPIER from '@dimforge/rapier3d-compat';
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
  g.events.emit('worldReady', {});
  loading.done();
  g.start();
  await playArrival(g); // cinematic fly-in (skippable; ?nointro skips)
  g.events.emit('runStart', {});
}
