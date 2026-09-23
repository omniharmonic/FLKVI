// Unit-style sim tests for src/ai (run: node --experimental-strip-types src/ai/tests/sim.test.ts)
// Synthetic grid city; exercises IDM, signals, stop/yield junctions, heat escalation/decay.
import { idmAccel, stepSpeed, IDM_DEFAULT } from '../idm.ts';
import { RoadNet } from '../roadnet.ts';
import { TrafficSim } from '../trafficsim.ts';
import { HeatState, HEAT_TUNING } from '../heat.ts';
import { signalState } from '../../core/signals.ts';
import { rng } from '../../core/geo.ts';
import { gridRecipe } from './grid.ts';

let failed = 0, passed = 0;
function check(name: string, cond: boolean, info = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${info}`); }
}

console.log('IDM');
{
  let v = 0;
  for (let t = 0; t < 60; t += 0.05) v = stepSpeed(v, idmAccel(v, 15, Infinity, 0), 0.05);
  check('free road reaches desired speed', Math.abs(v - 15) < 0.6, `v=${v.toFixed(2)}`);
  // approach a stopped leader 150 m ahead
  let x = 0, minGap = Infinity;
  v = 15;
  const leader = 150;
  for (let t = 0; t < 60; t += 0.05) {
    const gap = leader - x - 4.6;
    minGap = Math.min(minGap, gap);
    v = stepSpeed(v, idmAccel(v, 15, gap, v - 0), 0.05);
    x += v * 0.05;
  }
  check('stops behind a stopped leader without collision', minGap > 0.5 && minGap < IDM_DEFAULT.s0 + 1.5, `minGap=${minGap.toFixed(2)}`);
  check('comes to rest', v < 0.2, `v=${v}`);
  // steady following gap
  let xl = 50, xf = 0; v = 12; const vl = 12;
  for (let t = 0; t < 120; t += 0.05) {
    v = stepSpeed(v, idmAccel(v, 20, xl - xf - 4.6, v - vl), 0.05);
    xf += v * 0.05; xl += vl * 0.05;
  }
  const eq = xl - xf - 4.6;
  check('steady following gap ≈ s0 + vT', Math.abs(eq - (IDM_DEFAULT.s0 + 12 * IDM_DEFAULT.T)) < 4, `gap=${eq.toFixed(1)}`);
}

console.log('Road network');
const recipe = gridRecipe();
const net = new RoadNet(recipe);
{
  check('edges built', net.edges.length === recipe.graph.edges.length, `${net.edges.length}`);
  const e = net.edges[0];
  const lp = net.lanePoly(e, 0);
  // edge 0 runs east (+x) along row 0; right-hand lane should be offset to the south (+z)
  check('right-hand lane offset is to the right of travel', lp.zs[0] > 0.5 && lp.zs[0] < 4, `z=${lp.zs[0]}`);
  const mid = net.nodes[3 * 6 + 3];
  check('junction radius set', mid.radius > 5, `${mid.radius}`);
  check('reverse edges paired', net.edges.every((x) => x.reverse >= 0));
  const n2 = net.chooseNext(e, rng(1));
  check('chooseNext avoids U-turn', n2 >= 0 && net.edges[n2].to !== e.from);
  const tp = net.turnPoly(e, 0, net.edges[n2], 0);
  check('turn curve is continuous', tp.len > 1 && tp.len < 40, `len=${tp.len}`);
  check('ped segments built', net.peds.length > 0);
  const r = net.route(0, 35);
  check('A* route corner to corner', r.length === 11 && r[0] === 0 && r[r.length - 1] === 35, JSON.stringify(r));
  check('nearestNode', net.nearestNode(245, 118) === 1 * 6 + 2, `${net.nearestNode(245, 118)}`);
}

console.log('Signals');
{
  const n = net.nodes.find((x) => x.signal)!;
  const states = new Set<string>();
  for (let t = 0; t < 40; t += 0.5) states.add(signalState(n.id, n.axis, 0, t));
  check('signal cycles through green/yellow/red', states.size === 3);
  let conflict = 0;
  for (let t = 0; t < 40; t += 0.25) {
    const a = signalState(n.id, n.axis, n.axis, t), b = signalState(n.id, n.axis, n.axis + Math.PI / 2, t);
    if (a === 'green' && b === 'green') conflict++;
  }
  check('perpendicular approaches never both green', conflict === 0);
}

console.log('Traffic sim');
{
  const rnd = rng(42);
  const sim = new TrafficSim(net, rnd);
  let placed = 0;
  for (let k = 0; placed < 70 && k < 500; k++) {
    const e = Math.floor(rnd() * net.edges.length);
    const E = net.edges[e];
    const lane = Math.floor(rnd() * E.dirLanes);
    const s = net.laneStart(E) + rnd() * (net.laneEnd(E) - net.laneStart(E));
    const clash = sim.cars.some((c) => Math.hypot(c.x - 0, 0) < 0 && c.e === e) ||
      sim.cars.some((c) => c.e === e && c.lane === lane && Math.abs(c.s - s) < 12);
    if (clash) continue;
    const c = sim.addCar('civilian', e, lane, s);
    c.v = rnd() * 8;
    placed++;
  }
  let overlaps = 0, stoppedAtRed = 0, frames = 0, speedSum = 0, speedN = 0;
  const dt = 1 / 30;
  for (let t = 0; t < 300; t += dt) {
    sim.rebuild([]);
    sim.step(dt);
    frames++;
    for (const c of sim.cars) {
      speedSum += c.v; speedN++;
      if (c.control === 'red' && c.v < 0.3) stoppedAtRed++;
    }
    if (frames % 15 === 0) {
      for (let i = 0; i < sim.cars.length; i++)
        for (let j = i + 1; j < sim.cars.length; j++) {
          const a = sim.cars[i], b = sim.cars[j];
          if (a.leg === 'lane' && b.leg === 'lane' && a.e === b.e && a.lane === b.lane && Math.abs(a.s - b.s) < 4.0) { overlaps++; console.log("    overlap", t.toFixed(1), a.id, b.id, a.s.toFixed(1), b.s.toFixed(1), a.v.toFixed(1), b.v.toFixed(1), a.ghost.toFixed(1), b.ghost.toFixed(1), a.blockedBy, b.blockedBy, a.latOff.toFixed(1), b.latOff.toFixed(1)); }
        }
    }
    for (const c of sim.cars) if (c.dead) { sim.removeCar(c); break; }
  }
  const mean = speedSum / speedN;
  console.log(`    cars=${sim.cars.length} transitions=${sim.stats.transitions} meanSpeed=${mean.toFixed(1)} redViolations=${sim.stats.redViolations} overlaps=${overlaps}`);
  check('no red-light violations', sim.stats.redViolations === 0, `${sim.stats.redViolations}`);
  check('cars wait at red lights', stoppedAtRed > 100, `${stoppedAtRed}`);
  check('no same-lane overlaps', overlaps === 0, `${overlaps}`);
  check('traffic flows (mean speed > 3 m/s)', mean > 3, mean.toFixed(2));
  check('cars traverse junctions', sim.stats.transitions > 300, `${sim.stats.transitions}`);
  check('few cars recycled as stuck', sim.cars.length >= 64, `${sim.cars.length}`);

  // police route following
  const pc = sim.addCar('police', 0, 0, net.laneStart(net.edges[0]) + 1);
  pc.sirens = true;
  const route = [net.edges[0].to, net.edges[0].to + 1, net.edges[0].to + 1 + 6, net.edges[0].to + 1 + 12];
  sim.setRoute(pc, route);
  let arrived = false;
  sim.hooks.routeEnd = (c) => { if (c === pc) arrived = true; };
  for (let t = 0; t < 120 && !arrived; t += dt) { sim.rebuild([]); sim.step(dt); }
  check('police follows a route to its end', arrived);

  // player blocking: car stops, honks, then swerves around
  const sim2 = new TrafficSim(net, rng(3));
  const c2 = sim2.addCar('civilian', 0, 0, net.laneStart(net.edges[0]) + 2);
  c2.v = 10;
  const ahead = { x: 0, z: 0, h: 0 };
  sim2.pathAhead(c2, 40, ahead);
  let honks = 0, minD = Infinity;
  sim2.hooks.honk = () => honks++;
  for (let t = 0; t < 20; t += dt) {
    sim2.rebuild([{ x: ahead.x, z: ahead.z, h: 0, v: 0, r: 0.4, kind: 'player' }]);
    sim2.step(dt);
    minD = Math.min(minD, Math.hypot(c2.x - ahead.x, c2.z - ahead.z));
  }
  check('car brakes for the player', minD > 2.2, `minD=${minD.toFixed(2)}`);
  check('car honks at the player', honks > 0);
  check('car swerves around the blocking player', c2.s > net.laneStart(net.edges[0]) + 45 || c2.e !== 0, `s=${c2.s.toFixed(1)}`);
}

console.log('Heat');
{
  const events: string[] = [];
  const h = new HeatState((t, p) => events.push(`${t}:${p.heat ?? ''}`));
  h.witness({ source: 'camera', p: [10, 10], confidence: 0.95, delay: 0 });
  check('camera sighting → heat 2 instantly', h.level === 2 && events[0] === 'heatChanged:2');
  h.clear(); events.length = 0;
  h.witness({ source: 'npc', p: [0, 0], confidence: 0.6, delay: 3 });
  h.update(1, false);
  check('npc call waits for delay', h.level === 0);
  h.update(2.5, false);
  check('npc call → +1 after delay', h.level === 1);
  h.witness({ source: 'npc', p: [0, 0], confidence: 0.3, delay: 0 });
  check('low-confidence npc call does not raise heat', h.level === 1);
  h.clear();
  h.add(1, [0, 0]);
  for (let t = 0; t < 200 && h.level < 5; t += 0.1) h.update(0.1, true, [0, 0]);
  check('sustained pursuit escalates to 5', h.level === 5);
  events.length = 0;
  let sawProgress = false;
  for (let t = 0; t < 400 && h.level > 0; t += 0.1) {
    h.update(0.1, false);
    if (h.progress > 0.5) sawProgress = true;
  }
  check('evasion decays heat to 0 one level at a time', h.level === 0 && events.filter((e) => e.startsWith('heatChanged')).length === 5, events.join(','));
  check('heatZero emitted', events.includes('heatZero:'));
  check('progress reported while evading', sawProgress);
  const total = HEAT_TUNING.decay.reduce((a, b) => a + b, 0);
  check('full decay time is sane (60..240 s)', total > 60 && total < 240, `${total}`);
  // seen resets evasion
  h.add(2, [0, 0]);
  for (let t = 0; t < 10; t += 0.1) h.update(0.1, false);
  const p1 = h.progress;
  h.update(0.1, false, [0, 0], true);
  check('camera sighting resets evasion progress', p1 > 0.2 && h.progress === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) (globalThis as any).process?.exit(1);
