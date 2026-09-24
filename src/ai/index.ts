// OWNER: AI agent. Traffic, pedestrians, perception, heat, police dispatch/pursuit/arrest.
//
// setupAI(g):
//   • g.heat  — HeatAPI (wanted level 0..5, evasion progress, lastKnown, spotted, arrestMeter)
//   • g.ai    — AIAPI (setPatrolDensity for the Escalation director) + debug handles
// Perception helpers for other modules: import { canSee } from '../ai/perception'.
import type { Game } from '../core/game';
import type { AIAPI } from '../core/api';
import { rng } from '../core/geo';
import { CharacterFactory } from './characters';
import { TrafficSystem, TRAFFIC_TUNING } from './traffic';
import { PedSystem, PED_TUNING } from './peds';
import { PoliceSystem, POLICE_TUNING } from './police';
import { mergeDistrictGraphs } from './stream-network';
import { RoadNet } from './roadnet';
import { losClear } from './util';
import { updateFrustum } from './util';

export { canSee, effectiveRange, playerTarget, headingDir, headingOf } from './perception';
export type { Observer } from './perception';
export { TRAFFIC_TUNING, PED_TUNING, POLICE_TUNING };

export interface AIDebug extends AIAPI {
  traffic: TrafficSystem | null;
  peds: PedSystem;
  police: PoliceSystem;
  factory: CharacterFactory;
  /** smoothed AI cost (ms per frame), worst frame in the last sample window, sample log */
  stats: { ms: number; peak: number; cars: number; peds: number; police: number; officers: number; samples: string[] };
  tuning: { traffic: typeof TRAFFIC_TUNING; peds: typeof PED_TUNING; police: typeof POLICE_TUNING };
}

export async function setupAI(g: Game): Promise<void> {
  const factory = new CharacterFactory(rng(7));
  try {
    await Promise.race([factory.loadAssets(), new Promise((r) => setTimeout(r, 8000))]);
  } catch (e) {
    console.warn('[ai] character assets unavailable, using procedural rigs', e);
  }

  let traffic: TrafficSystem | null = null;
  try {
    traffic = new TrafficSystem(g);
    if (!traffic.enabled) console.warn('[ai] no VehiclesAPI or drivable roads — traffic disabled');
  } catch (e) {
    console.error('[ai] traffic setup failed', e);
    traffic = null;
  }
  const net = traffic?.net ?? new RoadNet(g.recipe);
  const peds = new PedSystem(g, net, traffic?.sim ?? null, factory);
  const police = new PoliceSystem(g, traffic, peds, factory);

  const stats = { ms: 0, peak: 0, cars: 0, peds: 0, police: 0, officers: 0, samples: [] as string[] };
  let winPeak = 0, logT = 0;
  const ai: AIDebug = {
    setPatrolDensity(n: number) { police.patrolDensity = Math.max(0, Math.min(8, Math.round(n))); },
    get patrolDensity() { return police.patrolDensity; },
    traffic, peds, police, factory, stats,
    tuning: { traffic: TRAFFIC_TUNING, peds: PED_TUNING, police: POLICE_TUNING },
  };
  g.ai = ai;

  g.events.on('playerMelee',({p,dir,range})=>{
    let officer: (typeof police.officers)[number]|undefined,nearest=range;
    const y=g.player.position.y;
    for(const o of police.officers){const dx=o.x-p[0],dz=o.z-p[1],d=Math.hypot(dx,dz);
      if(o.stunned>0||d>nearest||Math.abs(o.y-y)>1.2||d>0.25&&(dx*dir[0]+dz*dir[1])/d<0.55)continue;
      if(!losClear(g,[p[0],y+1.1,p[1]],[o.x,o.y+1.1,o.z]))continue;officer=o;nearest=d;
    }
    if(peds.onMelee(p,dir,nearest))return;
    if(officer){officer.stunned=3+officer.ch.duration('getup');officer.recovering=false;officer.ch.setFallen(true);
      g.events.emit('meleeHit',{p:[officer.x,officer.y+1,officer.z]});g.events.emit('crime',{kind:'assault',p:[officer.x,officer.z],severity:3});}
  });
  g.events.on('districtsChanged' , ({recipes}) => {
    const merged=mergeDistrictGraphs(g.recipe,recipes,(x,z)=>g.world.streaming?.isReady(x,z)??true);
    const nextNet = new RoadNet(merged);
    const nodeIds = new Map(merged.graph.nodes.map((n, i) => [n.id, i]));
    const nodeMap = net.recipe.graph.nodes.map(n => nodeIds.get(n.id) ?? -1);
    const edgeKey = (network: RoadNet, i: number) => {
      const e = network.edges[i], graph = network.recipe.graph;
      return `${graph.nodes[e.from].id}:${graph.nodes[e.to].id}:${graph.edges[e.gi].roadId}`;
    };
    const edges = new Map(nextNet.edges.map(e => [edgeKey(nextNet, e.i), e.i]));
    const edgeMap = net.edges.map(e => edges.get(edgeKey(net, e.i)) ?? -1);
    for (const rb of police.roadblocks) rb.node = nodeMap[rb.node] ?? -1;
    // Preserve moving/parked/turning car poses and the shared network identity.
    Object.assign(net, nextNet);
    if (traffic) {
      traffic.enabled = net.edges.length > 0;
      traffic.sim.occupants.clear();
      for (const c of [...traffic.sim.cars]) {
        const handle = traffic.handleOf(c);
        if (handle?.driver === 'player' || handle?.id === g.player.vehicleId) { traffic.removeCar(c, false); continue; }
        c.route = null;
        const e = edgeMap[c.e] ?? -1;
        if (e < 0 && c.kind === 'civilian') { traffic.removeCar(c); continue; }
        c.e = e;
        c.next = edgeMap[c.next] ?? -1;
        c.turnNode = nodeMap[c.turnNode] ?? -1;
        if (e < 0) c.mode = 'free';
        if (c.next < 0) { c.leg = 'lane'; c.turn = null; }
        if (c.turnNode >= 0) {
          let occupants = traffic.sim.occupants.get(c.turnNode);
          if (!occupants) traffic.sim.occupants.set(c.turnNode, occupants = new Set());
          occupants.add(c);
        }
      }
    }
    peds.rebindNetwork();
  });
  let frame = 0;
  g.addSystem({
    name: 'ai',
    order: 15,
    fixedUpdate(dt: number) {
      const t0 = performance.now();
      frame++;
      updateFrustum(g, frame);
      try {
        if (traffic) traffic.extraObstacles = peds.obstacles;
        police.update(dt);
        traffic?.update(dt);
        peds.update(dt);
      } catch (e) {
        console.error('[ai] update failed', e);
      }
      const ms = performance.now() - t0;
      stats.ms += (ms - stats.ms) * 0.05;
      winPeak = Math.max(winPeak, ms);
      // timing sample every 20 s (budget: ≤ 4 ms/frame)
      logT += dt;
      if (logT > 20) {
        logT = 0;
        stats.peak = winPeak;
        const line = `[ai] ${stats.ms.toFixed(2)} ms avg, ${winPeak.toFixed(1)} ms peak · cars ${traffic?.sim.cars.length ?? 0} · peds ${peds.peds.length} · police ${police.units.length} · officers ${police.officers.length} · heat ${police.heat.level}`;
        winPeak = 0;
        stats.samples.push(line);
        if (stats.samples.length > 30) stats.samples.shift();
        if (stats.ms > 4) console.warn(line + ' — over budget'); else console.info(line);
      }
      if ((frame & 31) === 0) {
        stats.cars = traffic?.sim.cars.length ?? 0;
        stats.peds = peds.peds.length;
        stats.police = police.units.length;
        stats.officers = police.officers.length;
      }
    },
  });
  console.info(`[ai] ready: ${net.edges.length} lanes-edges, ${net.peds.length} sidewalk segs, characters=${factory.source}`);
}
