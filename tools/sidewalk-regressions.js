// Actual built road geometry, both curb directions, plus a displaced retaining-wall fixture.
(async () => {
  const g = game, R = g.rapier, p = g.player, checks = [], traces = [];
  g.paused = true; g.input.reset();
  if (p.vehicleId) p.exitVehicle(true);
  const check = (name, passed, detail) => { checks.push({ name, passed, detail }); };
  // Isolate paving from parked cars: probing inside a parked vehicle is not a curb failure.
  // The player still uses the full KCC against real terrain, road and building colliders.
  const disabled = [];
  g.physics.colliders.forEach(c => {
    if (c !== p.collider && c.isEnabled() && (c.collisionGroups() >>> 16) !== 1) {
      disabled.push(c); c.setEnabled(false);
    }
  });
  const step = () => {
    p.fixedUpdate(1 / 60); g.physics.timestep = 1 / 60; g.physics.step();
    p.lateUpdate(1 / 60); g.input.endFixedStep();
  };
  const candidates = g.recipe.roads.filter(r => r.sidewalk >= 1.3 && !r.bridge && !r.tunnel && ['residential', 'tertiary', 'secondary'].includes(r.cls));
  try {
    for (const r of candidates) {
      if (traces.length >= 20) break;
      for (let j = 1; j < r.pts.length; j++) {
        const a = r.pts[j - 1], b = r.pts[j], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 30) continue;
        const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
        if (Math.abs(cx) > 450 || Math.abs(cz) > 450) continue;
        const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
        const measurements = [];
        for (const direction of [1, -1]) {
          const offset = r.width / 2 + (direction === 1 ? -1.2 : 1.2);
          const x = cx + nx * offset, z = cz + nz * offset;
          p.respawn([x, z]); p.camera.yaw = Math.atan2(nx * direction, -nz * direction);
          p.controlsEnabled = true; g.input.enabled = true;
          for (let i = 0; i < 20; i++) step();
          const y0 = p.position.y;
          g.input.down.add('KeyW');
          let peak = 0;
          for (let i = 0; i < 52; i++) { step(); peak = Math.max(peak, Math.abs(p.position.y - y0)); }
          g.input.reset();
          measurements.push({ direction, travel: ((p.position.x - x) * nx + (p.position.z - z) * nz) * direction, peak });
        }
        traces.push({ road: r.name || r.id, x: cx, z: cz, measurements });
        break;
      }
    }
  } finally { g.input.reset(); for (const c of disabled) c.setEnabled(true); }
  const crossings = traces.flatMap(t => t.measurements);
  check('At least 30 actual road/sidewalk crossings exercised', crossings.length >= 30, crossings.length);
  check('Street curbs do not trap the walking controller', crossings.every(t => t.travel > 1.5), traces.filter(t => t.measurements.some(m => m.travel <= 1.5)));
  check('Street curbs do not launch the player', crossings.every(t => t.peak < 0.65), traces.filter(t => t.measurements.some(m => m.peak >= 0.65)));

  const { buildTerrainCollider } = await import('/src/world/physics.ts');
  const { Heightfield } = await import('/src/world/terrain.ts');
  const W = new R.World({ x: 0, y: -9.81, z: 0 });
  try {
    // Visible cut: flat road to x=3, vertical retaining face, flat raised site.
    // The old collider instead made an invisible slope from x=2 to x=4.
    const hf = { rows: 3, cols: 4, ox: 0, oz: 0, cell: 2,
      h: new Float32Array([0,0,3,3, 0,0,3,3, 0,0,3,3]),
      off: new Float32Array([0,0,1,0,-1,0,0,0, 0,0,1,0,-1,0,0,0, 0,0,1,0,-1,0,0,0]) };
    const sampler = new Heightfield(hf.cols, hf.rows, hf.ox, hf.oz, hf.cell, hf.h);
    sampler.off = hf.off; sampler.cliff = new Uint8Array(hf.h.length).fill(1);
    const collider = buildTerrainCollider({ rapier: R, physics: W }, hf);
    W.step();
    const height = x => { const hit = W.castRay(new R.Ray({ x, y: 8, z: 1 }, { x: 0, y: -1, z: 0 }), 10, true); return hit ? 8 - hit.timeOfImpact : null; };
    check('Retaining cut leaves the visible sidewalk clear of invisible ramps', Math.abs(height(2.8)) < 0.001, height(2.8));
    check('Retaining cut raised terrain matches the visible surface', Math.abs(height(3.2) - 3) < 0.001, height(3.2));
    check('Ground sampling and collision agree on both sides of a retaining cut', Math.abs(sampler.sample(2.8, 1) - height(2.8)) < 0.001 && Math.abs(sampler.sample(3.2, 1) - height(3.2)) < 0.001);
    sampler.off = null;
    check('Ordinary heightfields retain their original interpolation', Math.abs(sampler.sample(2.8, 1) - 1.2) < 0.001);
    W.removeRigidBody(collider.parent());
    check('All displaced terrain patches unload with their owning body', W.colliders.len() === 0, W.colliders.len());
  } finally { W.free(); }
  const failed = checks.filter(c => !c.passed);
  if (failed.length) throw Error(JSON.stringify({ failed, traces }));
  return { passed: checks.length, checks, traces };
})()
