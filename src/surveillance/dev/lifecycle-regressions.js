// Run in a disposable, fully loaded browser session. Leaves the game paused.
(async () => {
  const g = game, s = g.surveillance, streaming = g.world.streaming;
  const checks = [], check = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });
  g.paused = true;
  if (!streaming.districts.has('1,0')) await streaming.request(1,0);
  const traffic = g.ai.traffic;
  const originalRecipe = traffic.net.recipe;
  const originalPosition = g.player.position.clone();
  const originalReady = streaming.isReady;
  let installed;
  try {
    // One eligible junction, with an OSM identity deliberately unrelated to array index.
    let candidate;
    for (const z of [-400, -240, -80, 80, 240]) {
      const p = [streaming.core.maxX + 200, z];
      if (streaming.isReady(...p) && s.net.cams.every(c => Math.hypot(c.work.x-p[0],c.work.z-p[1]) > 75)) { candidate = p; break; }
    }
    if (!candidate) throw new Error('No isolated loaded test junction');
    const [x,z] = candidate;
    g.player.respawn([x,z+180],0);
    traffic.net.recipe = { ...originalRecipe, graph: {
      nodes: [{ id: 937123456, p: [x,z], y: g.world.groundAt(x,z), signal: true }, { id: 937987654, p: [x+60,z], y: g.world.groundAt(x+60,z) }],
      edges: [{ from: 0, to: 1, roadId: 'regression-road', length: 60, lanes: 2, speed: 12, cls: 'residential' }],
    }, roads: [{ id: 'regression-road', pts: [[x,z],[x+60,z]], ys: [0,0], nodes: [937123456,937987654], lanes: 2, width: 7, sidewalk: 2, oneway: false, cls: 'residential', surface: 'asphalt', maxSpeed: 12 }] };
    installed = s.installCamera();
    check('Escalation uses resident district graph with OSM node IDs', !!installed && installed.work.x > streaming.core.maxX, installed?.rc);
    traffic.net.recipe = originalRecipe;
    if (installed) {
      installed.status = 'repairing';
      s.crews.dispatch(installed);
      const crew = s.crews.crews.find(c => c.cam === installed);
      let disposed = 0;
      crew.crew.traverse(o => { if (o.isMesh) o.geometry.addEventListener('dispose', () => disposed++); });
      // Exact lifecycle trigger used after terrain eviction, without rebuilding geometry.
      streaming.isReady = (px,pz) => Math.hypot(px-installed.work.x,pz-installed.work.z) < 30 ? false : originalReady.call(streaming,px,pz);
      g.events.emit('districtsChanged', { recipes: [...streaming.districts.values()].map(d => d.recipe) });
      check('Retired district releases escalation camera and repair task', !s.net.byId.has(installed.rc.id) && !s.crews.crews.some(c => c.cam === installed));
      check('Retired repair meshes detach and release owned geometry', !crew.van.parent && !crew.crew.parent && disposed > 0, { disposed });
    }
  } finally {
    streaming.isReady = originalReady;
    traffic.net.recipe = originalRecipe;
    g.player.respawn([originalPosition.x, originalPosition.z],0);
    if (installed && s.net.byId.has(installed.rc.id)) { s.crews.retire(installed); s.net.remove(installed); }
  }
  const failed = checks.filter(c => !c.pass);
  window.__surveillanceLifecycleResults = { passed: checks.length-failed.length, failed: failed.length, checks };
  if (failed.length) throw new Error(JSON.stringify(window.__surveillanceLifecycleResults));
  return window.__surveillanceLifecycleResults;
})();
