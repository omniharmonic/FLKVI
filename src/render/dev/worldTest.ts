// Render + real world integration harness: /?renderdev=world&recipe=boulder
// Free camera (drag to look, WASD/QE, Shift fast). 1-5 time presets, [ ] \ F7 as in game.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from '../../core/game';
import type { Recipe } from '../../core/types';
import { setupRendering } from '../index';

export async function startWorldTest() {
  document.getElementById('ui-root')?.style.setProperty('display', 'none');
  const q = new URLSearchParams(location.search);
  await RAPIER.init();
  const { loadRecipe } = await import('../../compiler');
  const city = q.get('recipe') ?? 'boulder';
  const recipe: Recipe = await loadRecipe({ lat: 0, lon: 0, name: city, baked: city } as any, () => {});
  const container = document.getElementById('app')!;
  container.style.cssText = 'position:fixed;inset:0;';
  const g = new Game(recipe, container);
  (window as any).game = g;
  g.rapier = RAPIER;
  g.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  g.camera.far = 20000;
  g.camera.updateProjectionMatrix();
  await setupRendering(g, { dev: true });
  const { buildWorld } = await import('../../world');
  await buildWorld(g, () => {});

  const cam = g.camera;
  const cp = (q.get('cam') ?? '').split(',').map(Number);
  const sp = recipe.spawn;
  cam.position.set(sp.p[0], (g.world?.groundAt?.(sp.p[0], sp.p[1]) ?? sp.y) + 1.7, sp.p[1]);
  let yaw = -sp.heading, pitch = 0.02;
  if (cp.length >= 5) { cam.position.set(cp[0], cp[1], cp[2]); yaw = cp[3]; pitch = cp[4]; }
  let drag = false;
  container.addEventListener('mousedown', () => (drag = true));
  addEventListener('mouseup', () => (drag = false));
  addEventListener('mousemove', (e) => {
    if (!drag) return;
    yaw -= e.movementX * 0.003;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, -1.5, 1.5);
  });
  const sky = g.sky as any;
  const timeKeys: Record<string, number> = { Digit1: 12.5, Digit2: 17.3, Digit3: 17.85, Digit4: 18.3, Digit5: 22 };
  g.addSystem({
    name: 'dev-camera', order: 100,
    update(dt) {
      const i = g.input;
      for (const k in timeKeys) if (i.wasPressed(k)) sky.time = timeKeys[k];
      const s = (i.isDown('ShiftLeft') ? 80 : 12) * dt;
      const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      if (i.isDown('KeyW')) cam.position.addScaledVector(f, s);
      if (i.isDown('KeyS')) cam.position.addScaledVector(f, -s);
      if (i.isDown('KeyD')) cam.position.addScaledVector(r, s);
      if (i.isDown('KeyA')) cam.position.addScaledVector(r, -s);
      if (i.isDown('KeyE')) cam.position.y += s;
      if (i.isDown('KeyQ')) cam.position.y -= s;
      cam.rotation.set(pitch, yaw, 0, 'YXZ');
    },
  });
  g.start();
}
