// Disposable loaded session. Drone lifecycle must never change scene light/shader counts.
(async () => {
  const g = game, s = g.surveillance;
  g.paused = true;
  s.resetRun();
  const checks = [], check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  const lights = () => { const ids = []; g.scene.traverseVisible(o => { if (o.isLight) ids.push(o.uuid); }); return ids.sort().join(','); };
  const initial = lights();
  const slots = [...s.droneLights];
  const drones = slots.map(() => s.spawnDrone());
  check('Drone spawn uses a bounded pool without adding visible scene lights', drones.every(Boolean) && s.spawnDrone() === null && lights() === initial, { slots: slots.length });
  for (const drone of drones) drone.update(1/60, 1, 1, g.player.position, (x,z) => g.world.groundAt(x,z));
  const fallen = drones[0], previousLight = fallen.light;
  fallen.knockDown();
  const replacement = s.spawnDrone();
  replacement.update(1/60, 2, 1, g.player.position, (x,z) => g.world.groundAt(x,z));
  fallen.mode = 'crashed'; fallen.crashedAt = -100;
  let disposed = 0;
  fallen.obj.traverse(o => { if (o.isMesh) o.geometry.addEventListener('dispose', () => disposed++); });
  s.updateDrones(1/60, 2, 1);
  check('A downed drone returns its light without switching off its replacement', replacement.light === previousLight && previousLight.intensity > 0 && lights() === initial);
  check('Wreck retirement releases owned geometry and retains the light pool', !s.droneList.includes(fallen) && disposed > 0 && slots.every(l => l.parent === s.root), { disposed });
  s.resetRun();
  check('Run reset preserves the exact scene lights with zero unused intensity', lights() === initial && slots.every(l => l.intensity === 0 && l.visible) && s.droneList.length === 0);
  const failed = checks.filter(c => !c.pass);
  window.__droneLightResults = { passed: checks.length-failed.length, failed: failed.length, checks };
  if (failed.length) throw new Error(JSON.stringify(window.__droneLightResults));
  return window.__droneLightResults;
})();
