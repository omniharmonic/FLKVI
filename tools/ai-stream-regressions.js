// Disposable real-city session: streamed dispatch and the actual loaded animation mixer.
(async () => {
  const g = game, p = g.player;
  const checks = [], check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  g.paused = true;
  const character = p.character;
  const pelvis = character.root.getObjectByName('pelvis');
  const state = { speed: 0, grounded: true, crouch: false, vy: 0, pose: 'kneel' };
  let low = Infinity, high = -Infinity, restarts = 0, previous = 0;
  character.oneShot = null;
  for (let frame = 0; frame < 60 * 22; frame++) {
    character.update(1 / 60, state);
    const time = character.actions.get('kneel')?.time;
    if (frame > 120) {
      low = Math.min(low, pelvis.position.z); high = Math.max(high, pelvis.position.z);
      if (time < 1.19 || time > 3.81) restarts++;
    }
    previous = time;
  }
  check('Actual 22-second grinder pose never repeats its entrance/standing exit', restarts === 0, { previous, low, high });
  check('Actual rig pelvis remains kneeling throughout a full cut', high - low < 0.035 && high < 0.5, { low, high });
  for (let i = 0; i < 100; i++) character.update(1 / 60, { ...state, pose: 'none' });
  check('Releasing the grinder finishes standing once', character.workExit === 0 && character.w.get('kneel') < 0.02, { weight: character.w.get('kneel'), exit: character.workExit });

  const stream = g.world.streaming;
  if (!stream.districts.has('1,0')) await stream.request(1,0);
  const { samplePoly } = await import('/src/ai/roadnet.ts');
  const { updateFrustum } = await import('/src/ai/util.ts');
  const police = g.ai.police, traffic = g.ai.traffic;
  const { streamNodeId } = await import('/src/world/stream-coordinates.ts');
  const graph = traffic.net.recipe.graph;
  const actualEdges = new Set(graph.edges.map(e => `${streamNodeId(graph.nodes[e.from].p)}:${streamNodeId(graph.nodes[e.to].p)}:${e.roadId}`));
  let expected = 0, correct = 0;
  for (const district of stream.districts.values()) for (const edge of district.recipe.graph.edges) {
    const a = district.recipe.graph.nodes[edge.from], b = district.recipe.graph.nodes[edge.to];
    if (!a || !b) continue;
    expected++;
    if (actualEdges.has(`${streamNodeId(a.p)}:${streamNodeId(b.p)}:${edge.roadId}`)) correct++;
  }
  check('Real streamed graph edges retain their world-coordinate endpoints', expected > 0 && expected === correct, { expected, correct });
  police.reset();
  traffic.clear();
  const edge = traffic.net.edges.find(e => {
    const v = samplePoly(traffic.net.lanePoly(e, 0), e.len * 0.5);
    return v.x > stream.core.maxX + 150 && v.x < stream.core.maxX + 300 && stream.isReady(v.x, v.z);
  });
  check('Streamed district contributes usable traffic lanes', !!edge, { edges: traffic.net.edges.length });
  if (edge) {
    const at = samplePoly(traffic.net.lanePoly(edge, 0), edge.len * 0.5);
    p.respawn([at.x, at.z], at.h);
    // Look across the street; dispatch should use naturally hidden lane points to either side.
    g.camera.position.set(at.x, p.position.y + 3, at.z);
    g.camera.lookAt(at.x, p.position.y + 3, at.z + 20);
    updateFrustum(g, 998877);
    police.patrolDensity = 2;
    for (let i = 0; i < 8; i++) { g.elapsed += 0.5; police.update(0.5); }
    check('Police patrols populate a real district beyond the starting map', police.units.some(u => u.car.x > stream.core.maxX), police.units.map(u => ({ x: u.car.x, z: u.car.z, mode: u.mode })));
    g.heat.add(2, [at.x, at.z]);
    for (let i = 0; i < 8; i++) { g.elapsed += 0.5; police.update(0.5); }
    check('Heat dispatches responding units outside the starting map', police.units.some(u => ['respond', 'pursue', 'search'].includes(u.mode)), police.units.map(u => u.mode));
    check('Responding vehicles spawn only on loaded districts', police.units.every(u => stream.isReady(u.car.x, u.car.z)));
  }
  // Retirement while someone pauses, phones police or finishes a sidewalk approach.
  // These delayed states used to retain invalid segment indices and throw every AI tick.
  const pedestrians = g.ai.peds;
  const outerSegment = traffic.net.peds.findIndex(segment => segment.center.xs.some(x => x > stream.core.maxX + 20));
  const states = ['idle', 'toBench', 'call', 'fallen', 'getup', 'film'];
  const actors = states.map((state, i) => {
    const actor = pedestrians.acquire();
    actor.x = g.recipe.spawn.p[0] + i * 0.1; actor.z = g.recipe.spawn.p[1];
    actor.y = g.world.groundAt(actor.x, actor.z);
    actor.state = state; actor.prevState = 'walk'; actor.timer = state === 'idle' ? 0 : 30;
    actor.seg = outerSegment; actor.bench = -1;
    actor.ax = actor.bx = actor.x; actor.az = actor.bz = actor.z; actor.legT = 1; actor.legLen = 1;
    return actor;
  });
  g.events.emit('districtsChanged', { recipes: [] });
  check('Retiring sidewalks invalidates delayed navigation references', actors.every(a => a.seg === -1 || a.state === 'walk' || a.state === 'toBench'));
  check('Retiring sidewalks preserves phone, film and impact reactions', actors.slice(2).every((a, i) => a.state === states[i + 2] && a.timer === 30));
  const { playerInfo } = await import('/src/ai/util.ts');
  let retirementError = '';
  try {
    for (let i = 0; i < 90; i++) for (const a of actors.slice(0, 2)) pedestrians.updatePed(a, 1 / 60, playerInfo(g));
  } catch (error) { retirementError = String(error); }
  check('Idle and approaching pedestrians resume after district retirement without throwing', !retirementError, retirementError || actors.slice(0, 2).map(a => ({ state: a.state, segment: a.seg })));
  actors.forEach(a => pedestrians.release(a));
  g.events.emit('districtsChanged', { recipes: [...stream.districts.values()].map(d => d.recipe) });
  const failed = checks.filter(c => !c.pass);
  window.__aiStreamResults = { passed: checks.length - failed.length, failed: failed.length, checks };
  console.log(JSON.stringify(window.__aiStreamResults));
  if (failed.length) throw new Error(`AI/grinder regressions failed: ${failed.map(c => c.name).join(', ')}`);
  return window.__aiStreamResults;
})();
