// Boot sequence. Owned by the lead (integration). Modules plug in via their setup functions.
import RAPIER from '@dimforge/rapier3d-compat';
import './ui/styles.css';
import { Game } from './core/game';
import { loadRecipe } from './compiler';
import { setupRendering } from './render';
import { buildWorld } from './world';
import { setupGameplay } from './game';
import { setupAI } from './ai';
import { setupSurveillance } from './surveillance';
import { setupAudio } from './audio';
import { showSpawnPicker, showLoading, setupHUD, playArrival } from './ui';

async function boot() {
  const container = document.getElementById('app')!;
  const rapierReady = RAPIER.init();
  const loc = await showSpawnPicker();
  const loading = showLoading();
  try {
    const recipe = await loadRecipe(loc, (s, f) => loading.update(s, f * 0.4));
    await rapierReady;
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
  } catch (e) {
    console.error(e);
    loading.update(`Failed: ${(e as Error).message}`, 1);
  }
}

boot();
