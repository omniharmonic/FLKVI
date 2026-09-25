// Vehicle ownership, damaged rendering, local overlap cost, and real street contact behavior.
(async () => {
  const g = game, R = g.rapier, checks = [];
  g.paused = true; g.input.reset();
  const check = (name, passed, detail) => checks.push({ name, passed, detail });
  if (g.player.vehicleId) g.player.exitVehicle(true);
  const { getCarModel } = await import('/src/game/vehicles/carModels.ts');
  const model = getCarModel('sedan'), vehicles = g.vehicles;
  const p = g.recipe.spawn.p;
  const t0 = performance.now();
  let clear = null;
  for (let i = 0; i < 25; i++) clear = vehicles.overlap.clearSpot(model, p[0] + i, p[1], 0);
  const queryMs = performance.now() - t0;
  check('Repeated parked-car clearance queries remain bounded', queryMs < 300, queryMs);
  let known = 0, meshCount = 0;
  const indexed = new Set([...vehicles.overlap.grid.values()].flat());
  g.physics.colliders.forEach(c => { if (c.shapeType() === R.ShapeType.TriMesh) { meshCount++; if (indexed.has(c.handle)) known++; } });
  check('Most static collision meshes participate in spatial overlap filtering', known > meshCount * 0.8, { known, meshCount });

  const spot = clear || [p[0], p[1]];
  const a = vehicles.spawn({ kind: 'civilian', model: 'sedan', p: spot, heading: 0, physics: true });
  const b = vehicles.spawn({ kind: 'civilian', model: 'sedan', p: [spot[0] + 9, spot[1]], heading: 0, physics: true });
  const original = b.visual.bodyMesh.geometry;
  const trimOriginal = b.visual.chassis.children[1].geometry;
  const lampOriginal = b.visual.chassis.children[2].geometry;
  const local = model.headlightPos[0].clone();
  const contact = local.clone().add(a.position);
  const direction = local.clone().setY(0).normalize().negate().multiplyScalar(15);
  vehicles.damage(a, 65, direction, contact);
  check('A struck car owns its deformed body and leaves the neighboring car intact', a.visual.bodyMesh.geometry !== original && b.visual.bodyMesh.geometry === original);
  check('Bumpers and lamps deform with the struck body', a.visual.chassis.children[1].geometry !== trimOriginal && a.visual.chassis.children[2].geometry !== lampOriginal);
  check('The struck headlamp loses light while the other remains functional', a.visual.headlightIntegrity(0) < 0.2 && a.visual.headlightIntegrity(1) > 0.8, [a.visual.headlightIntegrity(0), a.visual.headlightIntegrity(1)]);
  let maxRecoil = 0;
  for (let i = 0; i < 150; i++) { a.sync(1 / 60); maxRecoil = Math.max(maxRecoil, a.visual.chassis.position.length()); }
  check('Collision bodywork recoil is visible, bounded and settles', maxRecoil > 0.005 && maxRecoil <= 0.071 && a.visual.chassis.position.length() < 0.001, { maxRecoil, end: a.visual.chassis.position.length() });
  // Render the damaged car, including cracked glass, so shader errors are exercised.
  a.visual.setFar(false); a.object.visible = true; a.object.updateMatrixWorld(true);
  g.camera.position.copy(a.position).add({ x: 5, y: 2.6, z: -6 });
  g.camera.lookAt(a.position.x, a.position.y + 0.8, a.position.z); g.camera.updateMatrixWorld();
  g.renderFrame(1 / 60);
  const before = { bodies: g.physics.bodies.len(), colliders: g.physics.colliders.len(), controllers: g.physics.vehicleControllers.size };
  for (let i = 0; i < 16; i++) {
    const car = vehicles.spawn({ kind: 'civilian', model: 'sedan', p: [spot[0] + 30, spot[1] + 20], heading: 0, physics: true });
    g.__enter(car.id); g.player.exitVehicle(true); vehicles.despawn(car.id);
    g.physics.step();
  }
  const after = { bodies: g.physics.bodies.len(), colliders: g.physics.colliders.len(), controllers: g.physics.vehicleControllers.size };
  check('Repeated enter/exit/despawn releases vehicle physics', JSON.stringify(before) === JSON.stringify(after), { before, after });
  vehicles.despawn(a.id); vehicles.despawn(b.id);
  const failed = checks.filter(c => !c.passed);
  if (failed.length) throw Error(JSON.stringify({ failed, checks }));
  return { passed: checks.length, checks };
})()
