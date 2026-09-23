// Police: heat (HeatAPI), dispatch, patrol / respond / pursue / search / investigate, officers on foot,
// roadblocks (heat 3+), ramming (heat 4+), helicopter (heat 5), arrest meter, busted moment.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { HeatAPI } from '../core/api';
import type { Vec2, Vec3 } from '../core/types';
import { rng } from '../core/geo';
import { HeatState } from './heat';
import type { TrafficSystem } from './traffic';
import type { Car } from './trafficsim';
import { samplePoly } from './roadnet';
import type { PedSystem } from './peds';
import { CharacterFactory, Character } from './characters';
import { Helicopter } from './helicopter';
import { canSee, headingOf, angleDiff, playerTarget } from './perception';
import { groundY, losClear, playerInfo, visibleToCamera, playSound, dist2, type PlayerInfo } from './util';

export const POLICE_TUNING = {
  /** responding units wanted per heat level */
  unitsByLevel: [0, 1, 3, 4, 6, 7],
  /** idle patrol cars at heat 0 (Escalation director may change via g.ai.setPatrolDensity) */
  patrolDensity: 2,
  maxCars: 11,
  spawnMin: 130,
  spawnMax: 270,
  sightPatrol: 60,
  sightPursuit: 100,
  sightOfficer: 45,
  /** free-driving pursuit top speed by heat */
  pursuitSpeed: [16, 24, 30, 34, 38, 40],
  lostSightToSearch: 3,
  arrestFootDist: 1.8,
  arrestFootTime: 1.5,
  arrestCarDist: 6,
  arrestCarTime: 3,
  arrestCarSpeed: 2,
  roadblockLevel: 3,
  ramLevel: 4,
  heliLevel: 5,
  investigateTime: 40,
  investigateWindow: 20,
  officerRunSpeed: 6.1,
};

type UnitMode = 'patrol' | 'respond' | 'pursue' | 'search' | 'investigate' | 'roadblock' | 'leave' | 'busted';

class Officer {
  x = 0; z = 0; y = 0; h = 0; v = 0;
  state: 'chase' | 'return' | 'guard' | 'look' | 'surround' | 'hold' = 'chase';
  seenT = -1e9;
  probeT = 0;
  steer = 0;
  gx = 0; gz = 0; // guard / look anchor
  animAcc = 0;
  constructor(public ch: Character, public unit: Unit | null) {}
}

class Unit {
  mode: UnitMode = 'patrol';
  role: 'chase' | 'flank' | 'box' = 'chase';
  officers: Officer[] = [];
  crew = 2;
  deployed = false;
  sees = false;
  seenT = -1e9;
  lookT = 0;
  goal: Vec2 | null = null;
  goalNode = -1;
  routeT = 0;
  searchC: Vec2 = [0, 0];
  searchK = 0;
  searchT = 0;
  invP: Vec2 = [0, 0];
  invT = 0;
  invArrived = false;
  probeT = 0;
  steer = 0;
  stuckT = 0;
  reverseT = 0;
  freeLostT = 0;
  leaveT = 0;
  siren: ReturnType<typeof playSound> = null;
  noiseT = 0;
  bornAt = 0;
  constructor(public id: number, public car: Car) {}
}

interface Roadblock { node: number; cars: Car[]; officers: Officer[]; born: number }

export class PoliceSystem {
  heat: HeatState;
  units: Unit[] = [];
  officers: Officer[] = [];
  roadblocks: Roadblock[] = [];
  heli: Helicopter | null = null;
  private officerPool: Character[] = [];
  group = new THREE.Group();
  private rnd = rng(4242);
  private nextId = 1;
  private dispatchT = 0;
  private spawnCd = 0;
  private roadblockT = 0;
  private spottedEmitT = 0;
  private wasSpotted = false;
  private camSeen = false;
  busted = false;
  private disabledControls = false;
  private arrestMeter = 0;
  private heliLeaveT = 0;
  private frame = 0;
  /** base idle patrols (g.ai.setPatrolDensity) */
  basePatrols = POLICE_TUNING.patrolDensity;
  /** escalation director level (surveillance 'escalation' event) */
  escalation = 0;
  hotspots: Vec2[] = [];
  get patrolDensity() { return this.basePatrols + (this.escalation >= 2 ? 4 : this.escalation >= 1 ? 2 : 0); }
  set patrolDensity(n: number) { this.basePatrols = n; }
  /** stats for debug */
  stats = { spottedBy: '' };

  constructor(private g: Game, private traffic: TrafficSystem | null, private peds: PedSystem | null, private factory: CharacterFactory) {
    this.group.name = 'ai-police';
    g.scene.add(this.group);
    this.heat = new HeatState((type, payload) => g.events.emit(type as any, payload));
    this.heat.onWitness = (res) => {
      if (res.investigate) this.dispatchInvestigate(res.p);
    };
    // published HeatAPI
    const self = this;
    const api: HeatAPI = {
      get level() { return self.heat.level; },
      get progress() { return self.heat.progress; },
      get lastKnown() { return self.heat.lastKnown; },
      get spotted() { return self.heat.spotted; },
      get arrestMeter() { return self.heat.arrestMeter; },
      add: (amount: number, p: Vec2) => this.heat.add(amount, p),
      clear: () => this.heat.clear(),
    };
    g.heat = api;

    g.events.on('witness', (w) => {
      if (this.busted) return;
      this.heat.now = g.elapsed;
      this.heat.witness(w);
    });
    g.events.on('playerSpotted', (e) => { if (e.by === 'camera') this.camSeen = true; });
    g.events.on('crime', (c) => this.onCrime(c.p));
    g.events.on('tamperAlert', (e) => this.dispatchInvestigate(e.p));
    g.events.on('plateHit', (e) => this.onPlateHit(e.p));
    g.events.on('runStart', () => { this.escalation = 0; this.hotspots = []; this.reset(); });
    g.events.on('escalation', (e) => {
      this.escalation = Math.max(this.escalation, e.level);
      if (e.hotspots?.length) this.hotspots = e.hotspots.map((h) => [h[0], h[1]] as Vec2);
      this.dispatchT = 0;
    });
    g.events.on('heatZero', () => this.onHeatZero());
    g.events.on('heatChanged', ({ heat, prev }) => {
      if (heat > prev) this.dispatchT = 0; // dispatch immediately
    });
    // cars that finish their routes
    if (traffic) {
      const prevHook = traffic.sim.hooks.routeEnd;
      traffic.sim.hooks.routeEnd = (c) => {
        prevHook?.(c);
        const u = this.units.find((x) => x.car === c);
        if (u) this.onArrive(u);
      };
    }
  }

  // ------------------------------------------------------------------ spawning helpers

  private get net() { return this.traffic!.net; }

  /** Pick a spawn point on the road network out of the player's view. */
  private hiddenSpawn(P: PlayerInfo, near?: Vec2): { e: number; s: number } | null {
    if (!this.traffic) return null;
    const T = POLICE_TUNING;
    const cx = near ? near[0] : P.x, cz = near ? near[1] : P.z;
    const cand = this.net.edgesNear(cx, cz, T.spawnMax);
    for (let k = 0; k < 30 && cand.length; k++) {
      const e = this.net.edges[cand[Math.floor(this.rnd() * cand.length)]];
      if (e.rank < 1) continue;
      const s = this.net.laneStart(e) + 1;
      const n = this.net.nodes[e.from];
      const d = Math.hypot(n.x - P.x, n.z - P.z);
      if (d < T.spawnMin || d > T.spawnMax + 60) continue;
      const y = groundY(this.g, n.x, n.z);
      if (visibleToCamera(this.g, n.x, y, n.z, 420, true)) continue;
      return { e: e.i, s };
    }
    return null;
  }

  private spawnUnit(mode: UnitMode, P: PlayerInfo, near?: Vec2, unmarked = false): Unit | null {
    if (!this.traffic?.enabled) return null;
    if (this.units.filter((u) => u.mode !== 'roadblock').length >= POLICE_TUNING.maxCars) return null;
    const sp = this.hiddenSpawn(P, near);
    if (!sp) return null;
    const look = unmarked ? { model: this.rnd() < 0.5 ? 'sedan' : 'suv', color: ['#1d2126', '#2b2f36', '#3a3d42', '#23282f'][Math.floor(this.rnd() * 4)] } : undefined;
    const car = this.traffic.addCar('police', sp.e, 0, sp.s, look);
    if (!car) return null;
    car.v = 8;
    const u = new Unit(this.nextId++, car);
    u.mode = mode;
    u.bornAt = this.g.elapsed;
    this.units.push(u);
    return u;
  }

  private removeUnit(u: Unit) {
    u.siren?.stop();
    for (const o of u.officers) this.removeOfficer(o);
    u.officers.length = 0;
    this.traffic?.removeCar(u.car);
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
  }

  private makeOfficer(unit: Unit | null, x: number, z: number, h: number): Officer {
    const ch = this.officerPool.pop() ?? this.factory.create('officer', Math.floor(this.rnd() * 1e6));
    ch.setFallen(false); ch.fallT = 0; ch.pivot.rotation.x = 0; ch.pivot.position.y = 0;
    const o = new Officer(ch, unit);
    o.x = x; o.z = z; o.h = h; o.y = groundY(this.g, x, z);
    ch.root.position.set(x, o.y, z);
    this.group.add(ch.root);
    ch.play('idle', 0);
    this.officers.push(o);
    return o;
  }

  private removeOfficer(o: Officer) {
    this.group.remove(o.ch.root);
    this.officerPool.push(o.ch);
    const i = this.officers.indexOf(o);
    if (i >= 0) this.officers.splice(i, 1);
  }

  // ------------------------------------------------------------------ routing

  private routeTo(u: Unit, x: number, z: number) {
    if (!this.traffic) return;
    const sim = this.traffic.sim;
    const c = u.car;
    if (c.mode !== 'lane') return;
    const E = this.net.edges[c.e];
    const from = c.leg === 'lane' ? E.to : c.next >= 0 ? this.net.edges[c.next].to : E.to;
    const goal = this.net.nearestNode(x, z);
    u.goal = [x, z];
    u.goalNode = goal;
    u.routeT = 0;
    if (goal < 0 || from === goal) { sim.setRoute(c, null); this.onArrive(u); return; }
    const r = this.net.route(from, goal);
    sim.setRoute(c, r.length > 1 ? r : null);
  }

  private onArrive(u: Unit) {
    if (u.mode === 'respond') this.startSearch(u);
    else if (u.mode === 'search') this.nextSearchPoint(u);
    else if (u.mode === 'investigate') u.invArrived = true;
    else if (u.mode === 'patrol' || u.mode === 'leave') this.traffic?.sim.setRoute(u.car, null);
  }

  private startSearch(u: Unit) {
    u.mode = 'search';
    u.searchC = this.heat.lastKnown ? [...this.heat.lastKnown] as Vec2 : [u.car.x, u.car.z];
    u.searchK = Math.floor(this.rnd() * 3);
    u.searchT = 0;
    this.nextSearchPoint(u);
  }

  private nextSearchPoint(u: Unit) {
    // expanding golden-angle spiral around the search center
    u.searchK++;
    const a = u.searchK * 2.39996 + u.id;
    const r = Math.min(260, 25 + 16 * u.searchK);
    this.ensureLane(u);
    this.routeTo(u, u.searchC[0] + Math.cos(a) * r, u.searchC[1] + Math.sin(a) * r);
  }

  private ensureLane(u: Unit): boolean {
    if (!this.traffic) return false;
    if (u.car.mode === 'lane') return true;
    if (u.car.mode === 'parked') return false; // crashed: physics owns it
    if (this.traffic.sim.attachToLane(u.car, 10)) return true;
    return false;
  }

  // ------------------------------------------------------------------ events

  private onCrime(p: Vec2) {
    if (this.busted) return;
    const y = groundY(this.g, p[0], p[1]) + 1.2;
    for (const u of this.units) {
      if (dist2(u.car.x, u.car.z, p[0], p[1]) > 75 * 75) continue;
      const eye: Vec3 = [u.car.x, groundY(this.g, u.car.x, u.car.z) + 1.4, u.car.z];
      if (canSee({ pos: eye, dir: u.car.h, fovDeg: 220, range: 75 }, [p[0], y, p[1]], this.g)) {
        this.g.events.emit('witness', { source: 'police', p, confidence: 1, delay: 0, sourceId: `unit${u.id}` });
        this.setPursue(u);
        return;
      }
    }
    for (const o of this.officers) {
      if (dist2(o.x, o.z, p[0], p[1]) > 50 * 50) continue;
      if (canSee({ pos: [o.x, o.y + 1.65, o.z], dir: o.h, fovDeg: 200, range: 50 }, [p[0], y, p[1]], this.g)) {
        this.g.events.emit('witness', { source: 'police', p, confidence: 1, delay: 0, sourceId: 'officer' });
        return;
      }
    }
  }

  private onPlateHit(p: Vec2) {
    if (this.busted) return;
    if (this.heat.level > 0) {
      this.heat.seen(p);
      for (const u of this.units) {
        if (u.mode === 'respond' || u.mode === 'search') {
          if (u.mode === 'search') { u.mode = 'respond'; }
          this.ensureLane(u);
          this.routeTo(u, p[0], p[1]);
        }
      }
    } else {
      this.dispatchInvestigate(p);
    }
  }

  private dispatchInvestigate(p: Vec2) {
    if (this.busted || !this.traffic?.enabled) return;
    if (this.units.some((u) => u.mode === 'investigate' && dist2(u.invP[0], u.invP[1], p[0], p[1]) < 150 * 150)) return;
    const P = playerInfo(this.g);
    let u = this.nearestUnit(p, (x) => x.mode === 'patrol');
    if (!u) u = this.spawnUnit('investigate', P, p);
    if (!u) return;
    u.mode = 'investigate';
    u.invP = [p[0], p[1]];
    u.invT = 0;
    u.invArrived = false;
    u.car.sirens = false;
    this.ensureLane(u);
    this.routeTo(u, p[0], p[1]);
  }

  private onHeatZero() {
    for (const u of this.units) {
      if (u.mode === 'busted') continue;
      if (u.mode === 'respond' || u.mode === 'pursue' || u.mode === 'search') {
        u.mode = 'leave';
        u.leaveT = 0;
        u.car.sirens = false;
        u.car.speedCap = Infinity;
        this.recallOfficers(u);
        if (this.ensureLane(u)) this.traffic?.sim.setRoute(u.car, null);
      }
    }
    this.clearRoadblocks(false);
  }

  private nearestUnit(p: Vec2, filter: (u: Unit) => boolean): Unit | null {
    let best: Unit | null = null, bd = Infinity;
    for (const u of this.units) {
      if (!filter(u)) continue;
      const d = dist2(u.car.x, u.car.z, p[0], p[1]);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }

  private setPursue(u: Unit) {
    if (u.mode === 'roadblock' || u.mode === 'busted') return;
    u.mode = 'pursue';
    u.car.sirens = true;
    u.seenT = this.g.elapsed;
  }

  private recallOfficers(u: Unit) {
    for (const o of u.officers) o.state = 'return';
  }

  reset() {
    for (const u of [...this.units]) this.removeUnit(u);
    for (const o of [...this.officers]) this.removeOfficer(o);
    this.clearRoadblocks(true);
    this.heli?.dispose();
    this.heli = null;
    this.heat.clear();
    this.heat.arrestMeter = 0;
    this.arrestMeter = 0;
    this.busted = false;
    if (this.disabledControls) {
      const p = (this.g as any).player;
      if (p) p.controlsEnabled = true;
      this.disabledControls = false;
    }
    this.peds?.cancelCalls();
  }

  // ------------------------------------------------------------------ perception

  private unitSees(u: Unit, tgt: Vec3, P: PlayerInfo): boolean {
    const c = u.car;
    const d2 = dist2(c.x, c.z, P.x, P.z);
    const hot = u.mode === 'pursue' || u.mode === 'search' || u.mode === 'respond';
    const range = hot ? POLICE_TUNING.sightPursuit : POLICE_TUNING.sightPatrol;
    if (d2 > range * range) return false;
    const eye: Vec3 = [c.x, groundY(this.g, c.x, c.z) + 1.4, c.z];
    // headlights: things in front are seen farther at night
    const inFront = Math.abs(angleDiff(headingOf(P.x - c.x, P.z - c.z), c.h)) < 0.45;
    return canSee({ pos: eye, dir: c.h, fovDeg: u.mode === 'pursue' ? 360 : hot ? 220 : 150, range }, tgt, this.g, { rangeMul: inFront ? 1.35 : 1 });
  }

  private officerSees(o: Officer, tgt: Vec3): boolean {
    return canSee({ pos: [o.x, o.y + 1.65, o.z], dir: o.h, fovDeg: o.state === 'chase' ? 300 : 200, range: POLICE_TUNING.sightOfficer }, tgt, this.g);
  }

  // ------------------------------------------------------------------ driving

  /** Kinematic bicycle-model steering toward (tx,tz). */
  private driveFree(u: Unit, tx: number, tz: number, vDes: number, dt: number, P: PlayerInfo, ram: boolean) {
    const c = u.car;
    const g = this.g;
    if (u.reverseT > 0) {
      u.reverseT -= dt;
      c.v += Math.max(-8 * dt, Math.min(8 * dt, -4.5 - c.v));
      c.h += -u.steer * 0.9 * dt;
    } else {
      let want = headingOf(tx - c.x, tz - c.z);
      // building avoidance probes (4 Hz)
      u.probeT -= dt;
      if (u.probeT <= 0) {
        u.probeT = 0.25;
        const y = groundY(g, c.x, c.z) + 0.9;
        const L = 7 + Math.abs(c.v) * 0.7;
        u.steer = 0;
        let found = false;
        for (const off of [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2]) {
          const hh = want + off;
          if (losClear(g, [c.x, y, c.z], [c.x + Math.sin(hh) * L, y, c.z - Math.cos(hh) * L])) { u.steer = off; found = true; break; }
        }
        if (!found) { u.reverseT = 1.4; u.steer = 1; }
      }
      want += u.steer;
      // traffic avoidance: nearest obstacle in the forward corridor
      const fx = Math.sin(c.h), fz = -Math.cos(c.h);
      let block = Infinity, side = 0;
      this.traffic?.sim.hash.query(c.x + fx * 8, c.z + fz * 8, 10, (o) => {
        if (o.car === c) return;
        if (ram && (o.kind === 'playerCar' || o.kind === 'player')) return;
        const rx = o.x - c.x, rz = o.z - c.z;
        const lon = rx * fx + rz * fz, lat = rx * Math.cos(c.h) + rz * Math.sin(c.h);
        if (lon < 1 || lon > 16 || Math.abs(lat) > 2.6) return;
        if (lon < block) { block = lon; side = lat; }
      });
      if (block < 16) {
        want += side > 0 ? -0.45 : 0.45;
        if (block < 7) vDes = Math.min(vDes, 4 + block);
      }
      const err = angleDiff(want, c.h);
      const sp = Math.abs(c.v);
      const maxYaw = Math.min(1.9, 0.35 + sp * 0.14);
      c.h += Math.max(-maxYaw * dt, Math.min(maxYaw * dt, err * 2.6 * dt)) * (c.v >= 0 ? 1 : -1);
      // slow for sharp turns
      vDes *= Math.max(0.3, 1 - Math.max(0, Math.abs(err) - 0.25) / 2.2);
      const dv = vDes - c.v;
      c.v += Math.max(-10 * dt, Math.min(6.5 * dt, dv));
      // stuck detection
      if (vDes > 3 && Math.abs(c.v) < 1) {
        u.stuckT += dt;
        if (u.stuckT > 1.8) { u.stuckT = 0; u.reverseT = 1.3; u.steer = err > 0 ? 1 : -1; }
      } else u.stuckT = 0;
    }
    c.x += Math.sin(c.h) * c.v * dt;
    c.z += -Math.cos(c.h) * c.v * dt;
    c.acc = c.v;
    void P;
  }

  private updateUnit(u: Unit, dt: number, P: PlayerInfo, tgt: Vec3 | null) {
    const T = POLICE_TUNING;
    const g = this.g;
    const c = u.car;
    const sim = this.traffic!.sim;
    const L = this.heat.level;
    const dP = Math.sqrt(dist2(c.x, c.z, P.x, P.z));
    if (c.mode === 'parked' && u.mode !== 'roadblock') {
      // crashed car (dynamic physics): crew bails out and chases on foot
      if (u.mode === 'pursue' && !P.inVehicle && dP < 60) this.deployOfficers(u, 2, 'chase');
      return;
    }

    switch (u.mode) {
      case 'patrol': {
        c.sirens = false;
        c.speedCap = Infinity;
        if (c.mode !== 'lane' && !this.ensureLane(u)) { this.driveToRoad(u, dt, P, 8); break; }
        // escalation: patrols cruise between the remaining cameras (hotspots)
        u.routeT += dt;
        if (this.hotspots.length && !c.route && u.routeT > 6) {
          u.routeT = 0;
          if (this.rnd() < 0.7) { const h = this.hotspots[Math.floor(this.rnd() * this.hotspots.length)]; this.routeTo(u, h[0], h[1]); }
        }
        break;
      }
      case 'leave': {
        u.leaveT += dt;
        c.sirens = false;
        if (c.mode !== 'lane' && !this.ensureLane(u)) this.driveToRoad(u, dt, P, 10);
        break;
      }
      case 'respond': {
        c.sirens = true;
        c.speedCap = Infinity;
        if (c.mode !== 'lane') {
          if (!this.ensureLane(u)) { this.driveToRoad(u, dt, P, 14); break; }
        }
        u.routeT += dt;
        const lk = this.heat.lastKnown;
        if (lk && (u.routeT > 4 && (!u.goal || dist2(u.goal[0], u.goal[1], lk[0], lk[1]) > 35 * 35) || !c.route)) this.routeTo(u, lk[0], lk[1]);
        if (lk && dist2(c.x, c.z, lk[0], lk[1]) < 35 * 35) this.startSearch(u);
        break;
      }
      case 'search': {
        c.sirens = true;
        c.speedCap = 10;
        u.searchT += dt;
        if (c.mode !== 'lane' && !this.ensureLane(u)) this.driveToRoad(u, dt, P, 9);
        else if (!c.route) this.nextSearchPoint(u);
        break;
      }
      case 'investigate': {
        c.sirens = false;
        u.invT += dt;
        const dInv = Math.sqrt(dist2(c.x, c.z, u.invP[0], u.invP[1]));
        if (!u.invArrived && dInv < 40) u.invArrived = true;
        if (u.invArrived) {
          // park near the camera, one officer looks around
          if (c.mode === 'lane') { sim.leaveJunction(c); c.mode = 'free'; }
          this.driveFree(u, u.invP[0], u.invP[1], dInv > 14 ? 6 : 0, dt, P, false);
          if (dInv < 16 && Math.abs(c.v) < 0.5 && !u.deployed) this.deployOfficers(u, 1, 'look');
          u.searchT += dt;
          // suspicious player nearby → heat 1
          if (u.searchT < T.investigateWindow && tgt && P.ok) {
            const nearCam = dist2(P.x, P.z, u.invP[0], u.invP[1]) < 20 * 20;
            if ((P.suspicious || nearCam) && (u.sees || u.officers.some((o) => o.seenT > g.elapsed - 0.5))) {
              g.events.emit('witness', { source: 'police', p: [P.x, P.z], confidence: 0.9, delay: 0, sourceId: `unit${u.id}` });
              this.setPursue(u);
              break;
            }
          }
          if (u.searchT > T.investigateTime) {
            this.recallOfficers(u);
            if (!u.officers.length) {
              u.mode = this.patrolCount() < this.patrolDensity ? 'patrol' : 'leave';
              u.deployed = false;
              u.searchT = 0;
              this.ensureLane(u);
            }
          }
        } else if (c.mode !== 'lane' && !this.ensureLane(u)) {
          this.driveToRoad(u, dt, P, 10);
        }
        break;
      }
      case 'pursue': {
        c.sirens = true;
        c.speedCap = Infinity;
        const seenAgo = g.elapsed - Math.max(u.seenT, this.lastAnySeen);
        if (seenAgo > T.lostSightToSearch && !u.deployed) { this.startSearch(u); break; }
        if (u.deployed) {
          // car waits while officers chase on foot; resumes when they are back
          if (c.mode === 'lane') { sim.leaveJunction(c); c.mode = 'free'; }
          this.driveFree(u, c.x, c.z, 0, dt, P, false);
          if (P.inVehicle) this.recallOfficers(u);
          if (!u.officers.length) u.deployed = false;
          break;
        }
        const clear = tgt ? losClear(g, [c.x, groundY(g, c.x, c.z) + 1.1, c.z], tgt) : false;
        if (c.mode === 'lane') {
          if (dP < 85 && clear) { sim.leaveJunction(c); c.mode = 'free'; u.freeLostT = 0; }
          else {
            u.routeT += dt;
            if (u.routeT > 1.5 || !c.route) this.routeTo(u, P.x, P.z);
            break;
          }
        }
        // free pursuit
        if (!clear) u.freeLostT += dt; else u.freeLostT = 0;
        if ((u.freeLostT > 1.2 || dP > 130) && this.ensureLane(u)) { this.routeTo(u, P.x, P.z); break; }
        const lead = Math.min(1.3, dP / 22);
        let tx = P.x + P.vx * lead, tz = P.z + P.vz * lead;
        let vDes = T.pursuitSpeed[L];
        const ram = L >= T.ramLevel && P.inVehicle;
        if (P.inVehicle) {
          if (u.role === 'flank' && dP > 12) { tx = P.x + P.vx * 2.6; tz = P.z + P.vz * 2.6; }
          else if (u.role === 'box' && dP > 8) {
            const rh = P.heading + Math.PI / 2;
            tx = P.x + Math.sin(rh) * 4 + P.vx * 0.9; tz = P.z - Math.cos(rh) * 4 + P.vz * 0.9;
          }
          if (ram) {
            // ram / PIT: aim at the rear quarter, faster than the target
            const fh = P.heading, s = u.id % 2 ? 1 : -1;
            tx = P.x - Math.sin(fh) * 1.6 + Math.cos(fh) * 1.1 * s + P.vx * 0.3;
            tz = P.z + Math.cos(fh) * 1.6 + Math.sin(fh) * 1.1 * s + P.vz * 0.3;
            vDes = Math.min(vDes, P.speed + 7);
          } else {
            // tail closely: match speed near the target
            vDes = Math.min(vDes, Math.max(0, (dP - 7) * 1.4 + P.speed));
            if (P.speed < T.arrestCarSpeed && dP < 10) vDes = Math.max(0, (dP - 4.5) * 1.5);
          }
        } else {
          // player on foot: drive up, stop, officers bail out
          vDes = Math.min(vDes, Math.max(0, (dP - 7) * 1.2));
          if (dP < 22 && Math.abs(c.v) < 3.5) { this.deployOfficers(u, 2, 'chase'); }
        }
        this.driveFree(u, tx, tz, vDes, dt, P, ram);
        break;
      }
      case 'roadblock':
      case 'busted': {
        if (c.mode === 'lane') { sim.leaveJunction(c); c.mode = 'free'; }
        c.v = Math.max(0, c.v - 12 * dt);
        if (u.mode === 'busted') this.driveFree(u, c.x, c.z, 0, dt, P, false);
        break;
      }
    }
    // clamp heights for free cars handled by traffic sync
  }

  private lastAnySeen = -1e9;

  /** Off-road car (after a free pursuit): drive back to the nearest lane, then re-attach. */
  private driveToRoad(u: Unit, dt: number, P: PlayerInfo, v: number) {
    const c = u.car;
    const r = this.net.nearestLane(c.x, c.z, 120);
    if (!r) { this.driveFree(u, c.x + Math.sin(c.h) * 20, c.z - Math.cos(c.h) * 20, v, dt, P, false); return; }
    const E = this.net.edges[r.e];
    // aim a bit ahead along the lane so we merge in the travel direction
    const sp = samplePoly(this.net.lanePoly(E, r.lane), Math.min(this.net.laneEnd(E), r.s + 8));
    this.driveFree(u, sp.x, sp.z, v, dt, P, false);
    if (r.d < 7 && Math.abs(angleDiff(sp.h, c.h)) < 0.7) this.traffic!.sim.attachToLane(c, 8);
  }

  private deployOfficers(u: Unit, n: number, state: Officer['state']) {
    if (u.deployed) return;
    u.deployed = true;
    const c = u.car;
    const fx = Math.sin(c.h), fz = -Math.cos(c.h);
    const rx = Math.cos(c.h), rz = Math.sin(c.h);
    for (let i = 0; i < Math.min(n, u.crew); i++) {
      const s = i === 0 ? -1 : 1;
      const o = this.makeOfficer(u, c.x + rx * s * 1.3 + fx * 0.3, c.z + rz * s * 1.3 + fz * 0.3, c.h + s * 0.6);
      o.state = state;
      o.gx = u.invP[0]; o.gz = u.invP[1];
      u.officers.push(o);
    }
    playSound(this.g, 'door', { at: [c.x, groundY(this.g, c.x, c.z) + 1, c.z], volume: 0.8 });
  }

  // ------------------------------------------------------------------ officers

  private updateOfficer(o: Officer, dt: number, P: PlayerInfo, tgt: Vec3 | null) {
    const g = this.g;
    let tx = o.x, tz = o.z, speed = 0;
    const T = POLICE_TUNING;
    switch (o.state) {
      case 'chase': {
        if (!P.ok) break;
        const recent = g.elapsed - o.seenT < 4 || g.elapsed - this.lastAnySeen < 2;
        const lk = recent ? [P.x, P.z] : this.heat.lastKnown ?? [P.x, P.z];
        tx = lk[0]; tz = lk[1];
        const d = Math.hypot(tx - o.x, tz - o.z);
        speed = d > 1.2 ? T.officerRunSpeed : 0;
        if (!recent && d < 3) { o.state = 'return'; }
        if (P.inVehicle && o.unit) o.state = 'return';
        if (o.unit && dist2(o.x, o.z, o.unit.car.x, o.unit.car.z) > 140 * 140) o.state = 'return';
        break;
      }
      case 'return': {
        const u = o.unit;
        if (!u) { speed = 0; break; }
        const c = u.car;
        const rx = Math.cos(c.h), rz = Math.sin(c.h);
        tx = c.x - rx * 1.4; tz = c.z - rz * 1.4;
        const d = Math.hypot(tx - o.x, tz - o.z);
        speed = T.officerRunSpeed * 0.85;
        if (d < 1.6 || (d > 60 && !visibleToCamera(g, o.x, o.y, o.z, 200, true))) {
          u.officers.splice(u.officers.indexOf(o), 1);
          this.removeOfficer(o);
          if (!u.officers.length) u.deployed = false;
          return;
        }
        break;
      }
      case 'look': {
        // wander around the anchor (tamper investigation)
        o.probeT -= dt;
        if (o.probeT <= 0) {
          o.probeT = 3 + Math.random() * 3;
          const a = Math.random() * Math.PI * 2;
          o.steer = a;
        }
        tx = o.gx + Math.cos(o.steer) * 6; tz = o.gz + Math.sin(o.steer) * 6;
        speed = Math.hypot(tx - o.x, tz - o.z) > 1 ? 1.4 : 0;
        break;
      }
      case 'guard': {
        // stand at the roadblock, chase a player on foot who comes close
        tx = o.gx; tz = o.gz;
        speed = Math.hypot(tx - o.x, tz - o.z) > 0.8 ? 2.5 : 0;
        if (P.ok && !P.inVehicle && g.elapsed - o.seenT < 1 && dist2(o.x, o.z, P.x, P.z) < 30 * 30) o.state = 'chase';
        break;
      }
      case 'surround': {
        const k = this.officers.indexOf(o);
        const a = k * 2.1;
        tx = P.x + Math.cos(a) * 1.6; tz = P.z + Math.sin(a) * 1.6;
        speed = Math.hypot(tx - o.x, tz - o.z) > 0.5 ? 2.2 : 0;
        break;
      }
      case 'hold':
        break;
    }
    // move with simple building avoidance
    let want = headingOf(tx - o.x, tz - o.z);
    if (speed > 0) {
      o.probeT -= dt;
      if (o.state !== 'look' && o.probeT <= 0) {
        o.probeT = 0.25;
        const y = o.y + 1.0;
        o.steer = 0;
        for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
          const hh = want + off;
          if (losClear(g, [o.x, y, o.z], [o.x + Math.sin(hh) * 2.5, y, o.z - Math.cos(hh) * 2.5])) { o.steer = off; break; }
        }
      }
      if (o.state !== 'look') want += o.steer;
      o.x += Math.sin(want) * speed * dt;
      o.z += -Math.cos(want) * speed * dt;
    } else if (P.ok && (o.state === 'chase' || o.state === 'surround' || o.state === 'guard')) {
      want = headingOf(P.x - o.x, P.z - o.z);
    }
    const dh = angleDiff(want, o.h);
    o.h += Math.sign(dh) * Math.min(Math.abs(dh), 8 * dt);
    o.v = speed;
    o.y = groundY(g, o.x, o.z, o.y);
    o.ch.root.position.set(o.x, o.y, o.z);
    o.ch.root.rotation.y = -o.h;
    o.ch.play(speed > 3 ? 'run' : speed > 0.3 ? 'walk' : this.busted ? 'idle' : 'idle', 0.2, speed > 3 ? speed / 5.5 : 1);
    void tgt;
  }

  // ------------------------------------------------------------------ roadblocks

  private placeRoadblock(P: PlayerInfo): boolean {
    if (!this.traffic?.enabled) return false;
    const net = this.net;
    const vlen = Math.hypot(P.vx, P.vz);
    const cand = new Set<number>();
    for (const ei of net.edgesNear(P.x, P.z, 250)) { cand.add(net.edges[ei].to); }
    let best = -1, bs = -Infinity;
    for (const n of cand) {
      const nd = net.nodes[n];
      if (nd.degree < 3 || this.roadblocks.some((r) => r.node === n)) continue;
      const dx = nd.x - P.x, dz = nd.z - P.z;
      const d = Math.hypot(dx, dz);
      if (d < 100 || d > 240) continue;
      let score = nd.maxRank * 2 - Math.abs(d - 160) / 30 + this.rnd();
      if (vlen > 3) {
        const dot = (dx * P.vx + dz * P.vz) / (d * vlen);
        if (dot < 0.45) continue;
        score += dot * 4;
      }
      const y = groundY(this.g, nd.x, nd.z);
      if (visibleToCamera(this.g, nd.x, y, nd.z, 300, true)) continue;
      if (score > bs) { bs = score; best = n; }
    }
    if (best < 0) return false;
    const nd = net.nodes[best];
    // approach edge from the player's side
    let edge = -1, ed = Infinity;
    for (const ei of nd.in) {
      const e = net.edges[ei];
      const f = net.nodes[e.from];
      const d = dist2(f.x, f.z, P.x, P.z);
      if (d < ed) { ed = d; edge = ei; }
    }
    if (edge < 0) return false;
    const E = net.edges[edge];
    const s = Math.max(net.laneStart(E), net.laneEnd(E) - 5);
    const cp = samplePoly(E.center, s);
    const rb: Roadblock = { node: best, cars: [], officers: [], born: this.g.elapsed };
    const rx = Math.cos(cp.h), rz = Math.sin(cp.h);
    const half = Math.max(2.2, E.width / 4);
    for (const side of [-1, 1]) {
      const x = cp.x + rx * side * half, z = cp.z + rz * side * half;
      const car = this.traffic.addFreeCar('police', x, z, cp.h + (Math.PI / 2) * side + (this.rnd() - 0.5) * 0.3);
      if (!car) continue;
      car.sirens = true;
      const u = new Unit(this.nextId++, car);
      u.mode = 'roadblock';
      u.crew = 0;
      this.units.push(u);
      rb.cars.push(car);
      // officer standing behind the car (away from the player)
      const bx = x + Math.sin(cp.h) * 3.2, bz = z - Math.cos(cp.h) * 3.2;
      const o = this.makeOfficer(null, bx, bz, cp.h + Math.PI);
      o.state = 'guard'; o.gx = bx; o.gz = bz;
      rb.officers.push(o);
    }
    if (!rb.cars.length) return false;
    this.roadblocks.push(rb);
    return true;
  }

  private clearRoadblocks(force: boolean) {
    for (const rb of [...this.roadblocks]) {
      const nd = this.traffic ? this.net.nodes[rb.node] : null;
      if (!force && nd && visibleToCamera(this.g, nd.x, groundY(this.g, nd.x, nd.z), nd.z, 300, true)) continue;
      for (const c of rb.cars) {
        const u = this.units.find((x) => x.car === c);
        if (u) this.removeUnit(u);
      }
      for (const o of rb.officers) if (this.officers.includes(o)) this.removeOfficer(o);
      this.roadblocks.splice(this.roadblocks.indexOf(rb), 1);
    }
  }

  // ------------------------------------------------------------------ main update

  patrolCount() { return this.units.filter((u) => u.mode === 'patrol').length; }

  private responders() { return this.units.filter((u) => u.mode === 'respond' || u.mode === 'pursue' || u.mode === 'search'); }

  update(dt: number) {
    const g = this.g;
    this.frame++;
    const P = playerInfo(g);
    const T = POLICE_TUNING;
    const tgt = playerTarget(g);
    const L = this.heat.level;

    // units whose vehicles were taken or destroyed
    for (const u of [...this.units]) {
      if (!this.traffic || !u.car.data) {
        u.siren?.stop();
        for (const o of u.officers) { o.unit = null; o.state = 'hold'; }
        this.units.splice(this.units.indexOf(u), 1);
      }
    }

    // ---- perception (staggered ~6 Hz per observer)
    let spotted = false;
    let by = '';
    if (P.ok && tgt && !this.busted) {
      for (const u of this.units) {
        if (((this.frame + u.id) % 10) === 0) u.sees = this.unitSees(u, tgt, P);
        if (u.sees) {
          if (L > 0) { spotted = true; by = 'car'; u.seenT = g.elapsed; if (u.mode !== 'pursue' && u.mode !== 'roadblock' && u.mode !== 'investigate') this.setPursue(u); }
          else if ((P.suspicious || (P.inVehicle && P.flagged)) && u.mode !== 'investigate') {
            g.events.emit('witness', { source: 'police', p: [P.x, P.z], confidence: 1, delay: 0, sourceId: `unit${u.id}` });
            this.setPursue(u);
          }
        }
      }
      for (const o of this.officers) {
        if (((this.frame + this.officers.indexOf(o)) % 8) === 0 && this.officerSees(o, tgt)) o.seenT = g.elapsed;
        if (g.elapsed - o.seenT < 0.2) {
          if (L > 0) { spotted = true; by = 'officer'; }
          else if (P.suspicious) g.events.emit('witness', { source: 'police', p: [P.x, P.z], confidence: 1, delay: 0, sourceId: 'officer' });
        }
      }
      if (this.heli && this.heli.sees && L > 0) { spotted = true; by = 'heli'; }
    }
    if (spotted) this.lastAnySeen = g.elapsed;
    this.stats.spottedBy = by;
    this.heat.now = g.elapsed - dt;
    if (!this.busted) this.heat.update(dt, spotted, P.ok ? [P.x, P.z] : undefined, this.camSeen);
    this.camSeen = false;
    if (spotted) {
      this.spottedEmitT -= dt;
      if (!this.wasSpotted || this.spottedEmitT <= 0) {
        g.events.emit('playerSpotted', { by: 'police' });
        this.spottedEmitT = 2;
      }
    }
    this.wasSpotted = spotted;

    // ---- dispatch (1 Hz)
    this.dispatchT -= dt;
    this.spawnCd -= dt;
    if (this.dispatchT <= 0 && P.ok && !this.busted && this.traffic?.enabled) {
      this.dispatchT = 1;
      if (L > 0) {
        const want = T.unitsByLevel[L];
        const have = this.responders();
        if (have.length < want) {
          const lk = this.heat.lastKnown ?? [P.x, P.z];
          const pat = this.nearestUnit(lk, (x) => x.mode === 'patrol' || x.mode === 'leave' || (x.mode === 'investigate' && !x.invArrived));
          if (pat) { pat.mode = 'respond'; this.ensureLane(pat); this.routeTo(pat, lk[0], lk[1]); }
          else if (this.spawnCd <= 0) {
            const u = this.spawnUnit('respond', P);
            if (u) { this.routeTo(u, lk[0], lk[1]); this.spawnCd = 1.2; }
          }
        }
        // assign pursuit roles
        let k = 0;
        for (const u of this.units) if (u.mode === 'pursue') u.role = (['chase', 'flank', 'box'] as const)[k++ % 3];
      } else {
        const pc = this.patrolCount();
        if (pc < this.patrolDensity && this.spawnCd <= 0) {
          const u = this.spawnUnit('patrol', P, undefined, this.escalation >= 2 && pc >= this.basePatrols && this.rnd() < 0.6);
          if (u) { u.car.v = 6; this.spawnCd = 3; }
        } else if (pc > this.patrolDensity + 1) {
          const u = this.units.find((x) => x.mode === 'patrol');
          if (u) { u.mode = 'leave'; u.leaveT = 0; }
        }
      }
      // cull far / leaving units
      for (const u of [...this.units]) {
        if (u.mode === 'roadblock' || u.mode === 'busted') continue;
        const d = Math.sqrt(dist2(u.car.x, u.car.z, P.x, P.z));
        const y = groundY(g, u.car.x, u.car.z);
        const hidden = !visibleToCamera(g, u.car.x, y, u.car.z, 300, true);
        if ((u.mode === 'leave' && ((d > 200 && hidden) || u.leaveT > 90)) || (d > 520 && hidden) || (u.car.dead && hidden)) {
          if (u.officers.length && u.mode !== 'leave') continue;
          this.removeUnit(u);
        }
      }
    }

    // ---- roadblocks
    this.roadblockT -= dt;
    if (this.roadblockT <= 0 && P.ok && !this.busted) {
      this.roadblockT = 8;
      if (L >= T.roadblockLevel) {
        for (const rb of [...this.roadblocks]) {
          const nd = this.net.nodes[rb.node];
          if (dist2(nd.x, nd.z, P.x, P.z) > 330 * 330 && !visibleToCamera(g, nd.x, groundY(g, nd.x, nd.z), nd.z, 400, true)) {
            for (const c of rb.cars) { const u = this.units.find((x) => x.car === c); if (u) this.removeUnit(u); }
            for (const o of rb.officers) if (this.officers.includes(o)) this.removeOfficer(o);
            this.roadblocks.splice(this.roadblocks.indexOf(rb), 1);
          }
        }
        if (this.roadblocks.length < (L >= 4 ? 3 : 2)) this.placeRoadblock(P);
      } else if (this.roadblocks.length) this.clearRoadblocks(false);
    }

    // ---- helicopter
    if (L >= T.heliLevel && !this.heli && P.ok && !this.busted) {
      const a = this.rnd() * Math.PI * 2;
      this.heli = new Helicopter(g, P.x + Math.cos(a) * 380, P.z + Math.sin(a) * 380);
      this.heliLeaveT = 0;
    }
    if (this.heli) {
      if (L < T.heliLevel) this.heliLeaveT += dt; else this.heliLeaveT = 0;
      this.heli.update(dt, P.ok ? tgt : null, this.heat.lastKnown, this.heliLeaveT > 10, g.elapsed);
      if (this.heli.gone || (this.heliLeaveT > 10 && this.heli.state === 'leaving' && Math.hypot(this.heli.x - P.x, this.heli.z - P.z) > 550)) {
        this.heli.dispose();
        this.heli = null;
      }
    }

    // ---- units
    for (const u of this.units) this.updateUnit(u, dt, P, tgt);

    // ---- officers
    for (const o of [...this.officers]) this.updateOfficer(o, dt, P, tgt);
    for (const o of this.officers) {
      const d2 = dist2(o.x, o.z, P.x, P.z);
      o.animAcc += dt;
      const every = d2 < 50 * 50 ? 1 : 3;
      if ((this.frame + this.officers.indexOf(o)) % every === 0) { o.ch.update(o.animAcc); o.animAcc = 0; }
    }

    // ---- sirens: audio, noise, civilians pull over
    const sirenUnits = this.units.filter((u) => u.car.sirens && u.mode !== 'roadblock' && u.mode !== 'busted');
    sirenUnits.sort((a, b) => dist2(a.car.x, a.car.z, P.x, P.z) - dist2(b.car.x, b.car.z, P.x, P.z));
    sirenUnits.forEach((u, i) => {
      const c = u.car;
      const y = groundY(g, c.x, c.z) + 1.4;
      if (i < 3 && dist2(c.x, c.z, P.x, P.z) < 300 * 300) {
        if (!u.siren) u.siren = playSound(g, 'siren', { at: [c.x, y, c.z], loop: true, volume: 0.85, rate: 0.95 + (u.id % 5) * 0.03 });
        u.siren?.setPosition([c.x, y, c.z]);
      } else if (u.siren) { u.siren.stop(); u.siren = null; }
      u.noiseT -= dt;
      if (u.noiseT <= 0) { u.noiseT = 3; g.events.emit('noise', { p: [c.x, c.z], radius: 100, kind: 'siren' }); }
      if (this.traffic) {
        const fx = Math.sin(c.h), fz = -Math.cos(c.h);
        this.traffic.sim.hash.query(c.x + fx * 20, c.z + fz * 20, 28, (o) => {
          const oc = o.car;
          if (!oc || oc.kind !== 'civilian' || oc.mode !== 'lane') return;
          const rel = (o.x - c.x) * fx + (o.z - c.z) * fz;
          if (rel > -6 && Math.abs(angleDiff(oc.h, c.h)) < 1.1) oc.pullOver = Math.max(oc.pullOver, 1.5);
        });
      }
    });
    for (const u of this.units) if (u.siren && !u.car.sirens) { u.siren.stop(); u.siren = null; }

    // ---- arrest
    this.updateArrest(dt, P);
  }

  private updateArrest(dt: number, P: PlayerInfo) {
    const T = POLICE_TUNING;
    if (this.busted || !P.ok || this.heat.level === 0) {
      this.arrestMeter = Math.max(0, this.arrestMeter - dt);
      this.heat.arrestMeter = this.busted ? 1 : this.arrestMeter;
      return;
    }
    let rate = 0;
    if (!P.inVehicle) {
      for (const o of this.officers) {
        if ((o.state === 'chase' || o.state === 'guard') && dist2(o.x, o.z, P.x, P.z) < T.arrestFootDist * T.arrestFootDist) { rate = 1 / T.arrestFootTime; break; }
      }
    } else if (P.speed < T.arrestCarSpeed) {
      for (const u of this.units) {
        if (dist2(u.car.x, u.car.z, P.x, P.z) < T.arrestCarDist * T.arrestCarDist) { rate = 1 / T.arrestCarTime; break; }
      }
      if (!rate) for (const o of this.officers) if (dist2(o.x, o.z, P.x, P.z) < 9) { rate = 1 / T.arrestCarTime; break; }
    }
    if (rate > 0) this.arrestMeter += rate * dt;
    else this.arrestMeter = Math.max(0, this.arrestMeter - dt * 0.6);
    this.heat.arrestMeter = Math.min(1, this.arrestMeter);
    if (this.arrestMeter >= 1) this.arrest(P);
  }

  private arrest(P: PlayerInfo) {
    const g = this.g;
    this.busted = true;
    this.heat.arrestMeter = 1;
    g.events.emit('arrested', {});
    const pl = (g as any).player;
    if (pl && pl.controlsEnabled !== false) { pl.controlsEnabled = false; this.disabledControls = true; }
    // freeze police; nearest units surround the player
    const near = [...this.units].sort((a, b) => dist2(a.car.x, a.car.z, P.x, P.z) - dist2(b.car.x, b.car.z, P.x, P.z));
    for (const u of this.units) { u.mode = 'busted'; u.car.sirens = true; }
    for (const o of this.officers) o.state = 'surround';
    let need = 3 - this.officers.length;
    for (const u of near) {
      if (need <= 0) break;
      if (u.deployed || dist2(u.car.x, u.car.z, P.x, P.z) > 40 * 40) continue;
      u.deployed = false;
      this.deployOfficers(u, 2, 'surround');
      need -= 2;
    }
    if (this.traffic) this.traffic.panicNear(P.x, P.z, 40);
  }
}
