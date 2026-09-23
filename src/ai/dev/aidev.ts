// DEV ONLY harness for src/ai: open /src/ai/dev/aidev.html?world=boulder
// Params: ?world=<recipe>  ?t=hours  ?heat=n  ?cam=top|chase  ?at=x,z
// Keys (stub player): WASD move (Shift = fast), C crime, N grinder noise, H +1 heat, J suspicious toggle, K clear heat
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Game } from '../../core/game';
import type { Recipe } from '../../core/types';

const q = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;

async function main() {
  await RAPIER.init();
  const { loadRecipe } = await import('../../compiler');
  const recipe: Recipe = await loadRecipe({ lat: 0, lon: 0, name: 'dev', baked: q.get('world') ?? 'boulder' }, (s, f) => { hud.textContent = `${s} ${(f * 100).toFixed(0)}%`; });
  const container = document.getElementById('app')!;
  const g = new Game(recipe, container);
  (window as any).game = g;
  g.rapier = RAPIER;
  g.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);
  g.renderer = renderer;
  g.camera.far = 5000; g.camera.updateProjectionMatrix();
  const hours = Number(q.get('t') ?? 14);
  const night = hours < 6 || hours > 20 ? 1 : 0;
  g.scene.background = new THREE.Color(night ? '#05070d' : '#9fb8d0');
  const sun = new THREE.DirectionalLight(0xffffff, night ? 0.05 : 2.5);
  sun.position.set(100, 200, 50);
  g.scene.add(sun, new THREE.HemisphereLight(0xbcd4ff, 0x6b5a45, night ? 0.05 : 0.8));
  (g as any).sky = { time: hours, timeScale: 0, sunDirection: new THREE.Vector3(0, 1, 0), nightFactor: night, sun };

  const { buildWorld } = await import('../../world');
  await buildWorld(g, (s, f) => { hud.textContent = `${s} ${(f * 100).toFixed(0)}%`; });
  const { setupAudio } = await import('../../audio');
  try { await setupAudio(g); } catch { /* ignore */ }
  const { setupGameplay } = await import('../../game');
  await setupGameplay(g);
  if (!(g as any).vehicles) {
    const { VehicleSystem } = await import('../../game/vehicles/manager');
    const vs = new VehicleSystem(g);
    g.vehicles = vs;
    g.addSystem(vs);
  }
  let stub = false;
  if (!(g as any).player) {
    stub = true;
    const at = (q.get('at') ?? '').split(',').map(Number);
    const p = new THREE.Vector3(at.length === 2 ? at[0] : recipe.spawn.p[0], 0, at.length === 2 ? at[1] : recipe.spawn.p[1]);
    const pl: any = {
      position: p, velocity: new THREE.Vector3(), heading: 0, vehicleId: null, suspicious: false, plateFlagged: false,
      health: 100, controlsEnabled: true, busy: false, respawn() {},
    };
    g.player = pl;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 4, 8), new THREE.MeshStandardMaterial({ color: '#ff4020' }));
    g.scene.add(body);
    g.addSystem({
      name: 'stubplayer', order: -10, update(dt) {
        const i = g.input;
        const sp = i.isDown('ShiftLeft') ? 12 : 4.5;
        let mx = 0, mz = 0;
        if (i.isDown('KeyW')) mz -= 1; if (i.isDown('KeyS')) mz += 1; if (i.isDown('KeyA')) mx -= 1; if (i.isDown('KeyD')) mx += 1;
        const l = Math.hypot(mx, mz) || 1;
        pl.velocity.set((mx / l) * sp * (mx || mz ? 1 : 0), 0, (mz / l) * sp * (mx || mz ? 1 : 0));
        if (pl.controlsEnabled) p.addScaledVector(pl.velocity, dt);
        if (mx || mz) pl.heading = Math.atan2(mx, -mz);
        p.y = g.world.groundAt(p.x, p.z);
        body.position.set(p.x, p.y + 0.85, p.z);
        if (i.wasPressed('KeyC')) g.events.emit('crime', { kind: 'takedown-cut', p: [p.x, p.z], severity: 3 });
        if (i.wasPressed('KeyN')) g.events.emit('noise', { p: [p.x, p.z], radius: 45, kind: 'grinder' });
        if (i.wasPressed('KeyH')) g.heat.add(1, [p.x, p.z]);
        if (i.wasPressed('KeyK')) g.heat.clear();
        if (i.wasPressed('KeyJ')) pl.suspicious = !pl.suspicious;
      },
    });
  }
  const { setupAI } = await import('../index');
  await setupAI(g);
  if (q.get('heat')) g.heat.add(Number(q.get('heat')), [g.player.position.x, g.player.position.z]);
  const camMode = q.get('cam') ?? 'chase';
  const camH = Number(q.get('camh') ?? (camMode === 'top' ? 160 : 14));
  if (stub) g.addSystem({
    name: 'devcam', order: 100, lateUpdate() {
      const p = g.player.position;
      if (camMode === 'top') { g.camera.position.set(p.x, p.y + camH, p.z + 1); g.camera.lookAt(p.x, p.y, p.z); }
      else { g.camera.position.set(p.x, p.y + camH, p.z + camH * 1.4); g.camera.lookAt(p.x, p.y + 1, p.z); }
    },
  });
  let frames = 0, acc = 0;
  g.addSystem({
    name: 'devhud', order: 200, update(dt) {
      frames++; acc += dt;
      if (acc > 0.5) {
        const ai = (g as any).ai;
        const h = g.heat;
        hud.textContent = `fps ${(frames / acc).toFixed(0)} ai ${ai.stats.ms.toFixed(2)}ms cars ${ai.stats.cars} peds ${ai.stats.peds} police ${ai.stats.police} officers ${ai.stats.officers}\n` +
          `heat ${h.level} prog ${h.progress.toFixed(2)} spotted ${h.spotted} arrest ${h.arrestMeter.toFixed(2)} susp ${g.player.suspicious}\n` +
          `units ${ai.police.units.map((u: any) => u.mode[0] + (u.sees ? '*' : '')).join('')} calls ${ai.peds.callers()}`;
        frames = 0; acc = 0;
      }
    },
  });
  for (const k of ['arrested', 'heatChanged', 'heatZero', 'witness', 'playerSpotted'] as const) g.events.on(k, (e: any) => console.log('[event]', k, JSON.stringify(e)));
  g.start();
}
main().catch((e) => { console.error(e); hud.textContent = String(e.stack ?? e); });
