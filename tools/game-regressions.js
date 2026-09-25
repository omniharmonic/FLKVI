// Run in the gameplay dev harness via `npm run test:browser` (shared server on port 5200).
// Exercises the real game loop, Rapier, input events and character assets, with rendering disabled
// during deterministic simulation. Browser sessions are disposable; fixtures never touch recipes.
(async () => {
  const g = window.game;
  const THREE = await import('/node_modules/.vite/deps/three.js');
  const { buildMeshColliders } = await import('/src/world/physics.ts');
  const { RoadNetwork } = await import('/src/world/roads.ts');
  const { Heightfield } = await import('/src/world/terrain.ts');
  const { ChunkBatcher } = await import('/src/world/util.ts');
  const { CharacterFactory } = await import('/src/ai/characters.ts');
  const R = g.rapier, p = g.player;
  g.paused = true;
  const checks = [];
  const check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  const originalRender = g.renderFrame, originalDelta = g.clock.getDelta;
  const originalProfile = g.prof;
  let delta = 1 / 60;
  g.prof = null;
  g.renderFrame = () => {};
  g.clock.getDelta = () => delta;
  p.controlsEnabled = true;
  g.input.enabled = true;
  const key = (code, down = true) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
  const tap = code => { key(code); key(code, false); };
  const advance = (n = 1, dt = 1 / 60) => {
    delta = dt;
    g.paused = false;
    for (let i = 0; i < n; i++) g.frame();
    g.paused = true;
  };
  const reset = (x = 200, z = 200) => {
    g.input.reset();
    if (p.vehicleId) p.exitVehicle(true);
    p.respawn([x, z], 0);
    g.acc = 0;
    advance(60);
  };
  const bodies = [];
  const box = (x, y, z, hx, hy, hz) => {
    const body = g.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y, z));
    g.physics.createCollider(R.ColliderDesc.cuboid(hx, hy, hz), body);
    bodies.push(body);
    return body;
  };
  try {
    reset();
    check('Player settles on ground', p.grounded && Math.abs(p.position.y - 0.02) < 0.03, String(p.position.y));
    key('KeyW'); advance(120); key('KeyW', false);
    check('Jog travels forward at expected speed', p.position.z < 194 && p.position.z > 192 && p.groundSpeed > 3.4, String(p.position.z));
    reset();
    key('KeyW'); key('ShiftLeft'); advance(120);
    check('Sprint travels faster than jogging', p.position.z < 190 && p.position.z > 187, String(p.position.z));

    reset(); tap('KeyC'); advance(1, 1 / 30);
    check('One crouch press survives two physics ticks', p.crouching);
    check('Crouch actually reduces collision height', Math.abs(p.collider.halfHeight() - 0.3) < 0.001);
    check('Crouch keeps feet grounded', Math.abs(p.position.y - 0.02) < 0.04, String(p.position.y));
    tap('KeyC'); advance();
    check('Standing restores capsule', !p.crouching && Math.abs(p.collider.halfHeight() - 0.55) < 0.001);
    g.acc = 0; tap('KeyC'); advance(1, 1 / 240);
    check('No fixed tick does not prematurely consume crouch', !p.crouching);
    advance(); check('Queued crouch survives render-only frame', p.crouching);
    tap('KeyC'); advance();
    g.acc = 0; tap('Space'); advance(1, 1 / 240); advance(8);
    check('Brief jump tap survives render-only frame', p.position.y > 0.45 && !p.grounded, String(p.position.y));
    advance(80); check('Jump lands without sinking', p.grounded && Math.abs(p.position.y - 0.02) < 0.04);

    reset(); key('KeyW'); window.dispatchEvent(new Event('blur')); advance(30);
    check('Window blur clears held movement and edges', Math.abs(p.position.z - 200) < 0.01 && !g.input.isDown('KeyW'));
    key('KeyW'); g.input.enabled = false; g.input.enabled = true; advance(30);
    check('Opening a menu clears held input', Math.abs(p.position.z - 200) < 0.01);

    const ceiling = box(200, 1.6, 196, 2, 0.3, 2);
    reset(); tap('KeyC'); key('KeyW'); advance(150); key('KeyW', false); advance(15);
    check('Crouched player fits under low ceiling', p.position.z < 198 && p.position.z > 194, String(p.position.z));
    tap('KeyC'); advance(); check('Cannot stand through ceiling', p.crouching);
    g.physics.removeRigidBody(ceiling); bodies.splice(bodies.indexOf(ceiling), 1); g.physics.step();
    tap('KeyC'); advance(); check('Can stand after obstruction clears', !p.crouching);

    reset(); const roof = box(200, 2.15, 200, 2, 0.15, 2); g.physics.step();
    tap('Space'); advance(8);
    check('Head impact cancels upward velocity', p.vy <= 0 && p.position.y < 0.32, `vy=${p.vy}, y=${p.position.y}`);
    g.physics.removeRigidBody(roof); bodies.splice(bodies.indexOf(roof), 1); g.physics.step();

    reset(); box(200, 1.5, 195, 3, 1.5, 0.3); g.physics.step();
    key('KeyW'); key('ShiftLeft'); advance(120); g.input.reset();
    check('Sprint cannot pass through solid wall', p.position.z > 195.55, String(p.position.z));
    const cam = g.__gameplay.cam;
    const hit = cam.castCamera(new THREE.Vector3(200, 1, 198), new THREE.Vector3(0, 0, -1), 6, null);
    check('Camera volume stays outside wall', hit > 2.3 && hit < 2.6, String(hit));

    reset(300, 300);
    const v = g.vehicles.spawn({ kind: 'civilian', p: [300, 300], heading: 0, model: 'sedan', physics: true });
    g.__enter(v.id); advance(120);
    check('Suspension rests on four wheels', v.wheelsOnGround() === 4 && Math.abs(v.position.y) < 0.1);
    key('KeyW'); advance(180); key('KeyW', false);
    const forward = v.speed;
    check('Throttle accelerates forward', forward > 12 && v.position.z < 275, String(forward));
    key('KeyS'); advance(90);
    check('Brake slows forward motion', v.speed < forward * 0.5, String(v.speed));
    advance(150); key('KeyS', false);
    check('Brake key reverses after stopping', v.speed < -2, String(v.speed));
    key('KeyW'); key('KeyD'); advance(180); g.input.reset();
    check('Right steering turns right', v.heading > 0.3 && v.position.x > 301, String(v.heading));
    p.exitVehicle(true); advance(30);
    check('Vehicle exit restores player collisions', !p.vehicleId && p.collider.isEnabled() && p.grounded);
    g.vehicles.despawn(v.id);

    // Real road generation: an elevated road and a separate footbridge must support physics bodies.
    const testWorld = new R.World({ x: 0, y: -9.81, z: 0 });
    try {
      const recipe = { ...g.recipe, props: [], roads: [
        { id: 'bridge-road', cls: 'residential', pts: [[0, -20], [0, 20]], ys: [5, 5], width: 8, sidewalk: 1.5, lanes: 2, bridge: true },
        { id: 'bridge-foot', cls: 'footway', pts: [[15, -20], [15, 20]], ys: [7, 7], width: 2, sidewalk: 0, lanes: 0, bridge: true },
      ] };
      const roads = new RoadNetwork(recipe); roads.analyze();
      const hf = new Heightfield(21, 21, -50, -50, 5);
      const batch = new ChunkBatcher(80); roads.build(batch, hf, []);
      const group = new THREE.Group(), material = new THREE.MeshBasicMaterial();
      const mats = Object.fromEntries(['asphalt','sidewalk','curb','footway','bridgeRail','marking'].map(k => [k, material]));
      const meshes = batch.emit(group, mats);
      buildMeshColliders({ rapier: R, physics: testWorld }, meshes.filter(m => /^(asphalt|sidewalk|curb|paving|footway|gravel|bridgeRail)\|/.test(m.name)));
      const ball = testWorld.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 8, 0).setCcdEnabled(true));
      testWorld.createCollider(R.ColliderDesc.ball(0.25), ball);
      for (let i = 0; i < 180; i++) testWorld.step();
      check('Generated bridge carries dynamic bodies', Math.abs(ball.translation().y - 5.25) < 0.05, String(ball.translation().y));
      const ray = testWorld.castRay(new R.Ray({ x: 15, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }), 20, true);
      check('Generated footbridge has a solid deck', ray && Math.abs(10 - ray.timeOfImpact - 7.04) < 0.02);
      check('Footbridge ground sampler matches its deck', Math.abs(roads.surfaceAt(15, 0).y - 7.04) < 0.001);
      // Transformed geometry used to be placed at the origin by the collider builder.
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), material);
      mesh.rotation.x = -Math.PI / 2; mesh.position.set(30, 9, 0);
      buildMeshColliders({ rapier: R, physics: testWorld }, [mesh]); testWorld.step();
      const transformed = testWorld.castRay(new R.Ray({ x: 30, y: 12, z: 0 }, { x: 0, y: -1, z: 0 }), 20, true);
      check('Mesh colliders respect world transforms', transformed && Math.abs(transformed.timeOfImpact - 3) < 0.02);
      meshes.forEach(m => m.geometry.dispose()); mesh.geometry.dispose(); material.dispose();
    } finally { testWorld.free(); }

    // Junction concrete must have two-dimensional UVs, including the curved corner pieces.
    const junctions = new RoadNetwork({ ...g.recipe, roads: [
      { id: 'east-west', cls: 'residential', pts: [[-30, 0], [0, 0], [30, 0]], ys: [0, 0, 0], width: 8, sidewalk: 2, lanes: 2 },
      { id: 'north-south', cls: 'residential', pts: [[0, -30], [0, 0], [0, 30]], ys: [0, 0, 0], width: 8, sidewalk: 2, lanes: 2 },
    ] });
    junctions.analyze();
    const junctionBatch = new ChunkBatcher(80);
    junctions.build(junctionBatch, new Heightfield(21, 21, -50, -50, 5), []);
    const material = new THREE.MeshBasicMaterial();
    const junctionMeshes = junctionBatch.emit(new THREE.Group(), Object.fromEntries(['asphalt', 'sidewalk', 'curb', 'marking'].map(k => [k, material])));
    let checked = 0, collapsed = 0;
    for (const mesh of junctionMeshes.filter(m => m.name.startsWith('sidewalk|'))) {
      const uv = mesh.geometry.attributes.uv, ix = mesh.geometry.index;
      for (let i = 0; i < ix.count; i += 3) {
        const a = ix.getX(i), b = ix.getX(i + 1), c = ix.getX(i + 2);
        const area = (uv.getX(b) - uv.getX(a)) * (uv.getY(c) - uv.getY(a)) - (uv.getX(c) - uv.getX(a)) * (uv.getY(b) - uv.getY(a));
        checked++; if (Math.abs(area) < 1e-6) collapsed++;
      }
    }
    check('Intersection sidewalks have no collapsed texture coordinates', checked > 20 && collapsed === 0, `${collapsed}/${checked}`);
    junctionMeshes.forEach(m => m.geometry.dispose()); material.dispose();

    // Neighboring intersection corners must share pavement before their natural
    // fillets overlap, while normally spaced intersections remain separate.
    const pairedJunctions = distance => {
      const road = (id,pts,width) => ({id,pts,width,cls:'residential',ys:pts.map(()=>0),sidewalk:2,lanes:2});
      const network = new RoadNetwork({...g.recipe,graph:{nodes:[],edges:[]},roads:[
        road('through',[[-100,0],[0,0],[distance,0],[100,0]],12),
        road('cross-a',[[0,-80],[0,0],[0,80]],10),
        road('cross-b',[[distance,-80],[distance,0],[distance,80]],10),
      ]});
      network.analyze();return network;
    };
    check('Overlapping intersection corners combine without a curb across the street',pairedJunctions(18).junctions.size===1);
    check('Separated intersections retain their individual sidewalks',pairedJunctions(40).junctions.size===2);

    const factory = new CharacterFactory(() => 0.5); await factory.loadAssets();
    for (const kind of ['civilian', 'officer']) {
      const character = factory.create(kind, 1);
      character.root.rotation.y = -Math.PI / 2;
      character.root.updateMatrixWorld(true);
      const template = character.root.getObjectByName(kind === 'officer' ? 'model:character-police-f' : 'model:character-ped-2');
      const forward = template && new THREE.Vector3(0, 0, 1).applyQuaternion(template.getWorldQuaternion(new THREE.Quaternion()));
      check(`${kind} model faces direction of travel`, forward && forward.x > 0.99, forward?.toArray().join(','));
    }
  } finally {
    g.input.reset();
    for (const body of bodies) g.physics.removeRigidBody(body);
    g.physics.step();
    g.clock.getDelta = originalDelta;
    g.renderFrame = originalRender;
    g.prof = originalProfile;
    g.paused = true;
  }
  const failed = checks.filter(c => !c.pass);
  const report = { passed: checks.length - failed.length, failed: failed.length, checks };
  if (failed.length) throw new Error(JSON.stringify(report, null, 2));
  return report;
})()
