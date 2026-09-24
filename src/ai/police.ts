// Police: heat (HeatAPI), dispatch, patrol / respond / pursue / search / investigate, officers on foot,
// roadblocks on the player's predicted route (heat 3+), PIT + ramming (heat 4+), helicopter (heat 5),
// arrest meter, busted moment.
//
// Tactics by heat: 1 tail · 2 box-in / roll-block ahead · 3 roadblocks at junctions ahead · 4 PIT & ram ·
// 5 helicopter with searchlight. Losing them: break line of sight (buildings, alleys, parks cars can't
// enter), switch cars unseen (police lose the description), then outlast the search (search area shown
// on the minimap via g.heat.searchArea; units cruise it with lights on, officers sweep with flashlights).
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
import { Helicopter, prewarmHelicopter } from './helicopter';
import { Icon } from './icons';
import { BEAM_GEO, POOL_GEO, makeBeamMaterial, makePoolMaterial } from './beams';
import { canSee, headingOf, angleDiff, playerTarget } from './perception';
import { groundY, losClear, playerInfo, visibleToCamera, playSound, dist2, nightFactor, type PlayerInfo } from './util';

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
  /** lateral grip (m/s²) for free-driving police: sets cornering speed (racing line braking) */
  grip: 8.5,
  lostSightToSearch: 3,
  arrestFootDist: 1.8,
  arrestFootTime: 2.0,
  arrestCarDist: 6,
  arrestCarTime: 4,
  arrestCarSpeed: 2,
  roadblockLevel: 3,
  ramLevel: 4,
  heliLevel: 5,
  investigateTime: 40,
  investigateWindow: 20,
  /** A sprinting player (6.2 m/s) slowly out-runs officers; jogging (3.6) does not. */
  officerRunSpeed: 5.6,
  /** search: cruise speed cap, officers sent on foot with flashlights (max at once) */
  searchSpeed: 8.5,
  searchOfficers: 2,
  searchStopChance: 0.45,
  /** Switched vehicles (or bailed out) unseen: sight range multiplier and faster evasion. */
  disguiseSight: 0.5,
  disguiseDecay: 1.7,
  /** Beyond this many meters off the road edge police cars stop following (parks, plazas, alleys too narrow). */
  offRoadMax: 6,
};

type UnitMode = 'patrol' | 'respond' | 'pursue' | 'search' | 'investigate' | 'roadblock' | 'leave' | 'busted';

class Officer {
  x = 0; z = 0; y = 0; h = 0; v = 0;
  stunned = 0;
  recovering = false;
  state: 'chase' | 'return' | 'guard' | 'look' | 'surround' | 'hold' = 'chase';
  seenT = -1e9;
  probeT = 0;
  steer = 0;
  gx = 0; gz = 0; // guard / look anchor
  animAcc = 0;
  /** vault over a low obstacle / car hood */
  vaultT = 0; vaultDur = 0; vaultH = 0; vaultDx = 0; vaultDz = 0;
  shoutT = 0; bubbleT = 0;
  sweep = Math.random() * 6;
  icon = new Icon();
  constructor(public ch: Character, public unit: Unit | null) {
    ch.root.add(this.icon.sprite);
    this.icon.sprite.position.set(0, 2.35, 0);
  }
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
  searchStopT = 0;
  invP: Vec2 = [0, 0];
  invT = 0;
  invArrived = false;
  probeT = 0;
  steer = 0;
  stuckT = 0;
  stuckN = 0;
  stuckWin = 0;
  reverseT = 0;
  freeLostT = 0;
  leaveT = 0;
  /** meters beyond the road edge (free driving, updated 4 Hz) */
  offRoad = 0;
  pitT = 0; pitCd = 0; pitSide = 1;
  /** don't leave the lane for free pursuit (after being cut off by a park/footpath) */
  noFreeT = 0;
  squealCd = 0;
  /** lights without siren audio (searching) */
  quiet = false;
  siren: ReturnType<typeof playSound> = null;
  noiseT = 0;
  bornAt = 0;
  constructor(public id: number, public car: Car) {}
}

interface Roadblock { node: number; cars: Car[]; officers: Officer[]; born: number }

// officer flashlights (shared geometry/materials; only visible at night)
const FLASH_BEAM_MAT = makeBeamMaterial('#fff3d6', 0.14, 0.6);
const FLASH_POOL_MAT = makePoolMaterial('#fff0d0', 0.35);
const flashlights = new WeakMap<Character, THREE.Group>();
function flashlightFor(ch: Character): THREE.Group {
  let f = flashlights.get(ch);
  if (f) return f;
  f = new THREE.Group();
  f.name = 'flashlight';
  const beam = new THREE.Mesh(BEAM_GEO, FLASH_BEAM_MAT);
  // from the chest, forward and down ~16°, 9 m long, ~12° half-angle
  beam.position.set(0.18, 1.35, -0.25);
  const len = 9, half = 0.2;
  beam.scale.set(len * Math.tan(half), len, len * Math.tan(half));
  beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, -Math.sin(0.15), -Math.cos(0.15)).normalize());
  beam.renderOrder = 5;
  beam.frustumCulled = false;
  f.add(beam);
  const pool = new THREE.Mesh(POOL_GEO, FLASH_POOL_MAT);
  pool.position.set(0.18, 0.06, -8.5);
  pool.scale.set(1.9, 1, 1.9);
  pool.renderOrder = 4;
  f.add(pool);
  f.visible = false;
  ch.root.add(f);
  flashlights.set(ch, f);
  return f;
}

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
  /** persistent lights (adding lights at runtime would recompile every shader) */
  private heliLight: THREE.SpotLight;
  private flashLight: THREE.SpotLight;
  /** police lost the player's description (switched vehicles / bailed out unseen) */
  disguised = false;
  /** last seen player velocity (search bias) */
  private lastVel: Vec2 = [0, 0];
  /** base idle patrols (g.ai.setPatrolDensity) */
  basePatrols = POLICE_TUNING.patrolDensity;
  /** escalation director level (surveillance 'escalation' event) */
  escalation = 0;
  hotspots: Vec2[] = [];
  get patrolDensity() { return this.basePatrols + (this.escalation >= 2 ? 4 : this.escalation >= 1 ? 2 : 0); }
  set patrolDensity(n: number) { this.basePatrols = n; }
  /** stats for debug */
  stats = { spottedBy: '', pits: 0, vaults: 0, unstuck: 0, rescued: 0 };

  constructor(private g: Game, private traffic: TrafficSystem | null, private peds: PedSystem | null, private factory: CharacterFactory) {
    this.group.name = 'ai-police';
    g.scene.add(this.group);
    this.heliLight = new THREE.SpotLight('#eaf2ff', 0, 230, 0.12, 0.35, 1.1);
    this.heliLight.castShadow = false;
    this.heliLight.name = 'heli-searchlight';
    this.flashLight = new THREE.SpotLight('#fff1d8', 0, 26, 0.36, 0.55, 1.4);
    this.flashLight.castShadow = false;
    this.flashLight.name = 'officer-flashlight';
    this.group.add(this.heliLight, this.heliLight.target, this.flashLight, this.flashLight.target);
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
      get searchArea() { return self.heat.searchArea; },
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
      if (heat > prev && this.disguised) this.disguised = false;
    });
    // Switching vehicles (or bailing out) where no officer / camera sees it: they lose the description.
    const swap = () => {
      if (this.heat.level === 0 || this.busted) return;
      if (g.elapsed - this.lastAnySeen < 2.5 || this.heat.spotted) return;
      if (!this.disguised) g.events.emit('toast', { text: 'Switched unseen — police lost your description', kind: 'good', ms: 2600 });
      this.disguised = true;
    };
    g.events.on('playerEnterVehicle', swap);
    g.events.on('playerExitVehicle', swap);
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

  /** Load-time warm-up (engine.ts): hidden helicopter + two pooled officers (flashlight, icon) so the first heat
   *  escalation neither builds characters nor links shader programs mid-game. */
  prewarm(holder: THREE.Object3D) {
    prewarmHelicopter(holder);
    for (let i = 0; i < 2; i++) {
      const ch = this.factory.create('officer', Math.floor(this.rnd() * 1e6));
      flashlightFor(ch);
      holder.add(ch.root);
      this.officerPool.push(ch);
    }
    holder.add(new Icon().sprite);
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
    o.ch.clearPhysics();
    this.group.remove(o.ch.root);
    o.ch.root.remove(o.icon.sprite);
    const f = flashlights.get(o.ch);
    if (f) f.visible = false;
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
    else if (u.mode === 'search') this.searchArrive(u);
    else if (u.mode === 'investigate') u.invArrived = true;
    else if (u.mode === 'patrol' || u.mode === 'leave') this.traffic?.sim.setRoute(u.car, null);
  }

  private startSearch(u: Unit) {
    u.mode = 'search';
    u.searchC = this.heat.lastKnown ? [...this.heat.lastKnown] as Vec2 : [u.car.x, u.car.z];
    u.searchK = Math.floor(this.rnd() * 3);
    u.searchT = 0;
    u.searchStopT = 0;
    this.nextSearchPoint(u);
  }

  /** At a search waypoint: sometimes park and send an officer to sweep the block on foot. */
  private searchArrive(u: Unit) {
    const T = POLICE_TUNING;
    const busy = this.officers.filter((o) => o.state === 'look' && o.unit && o.unit.mode === 'search').length;
    if (!u.deployed && u.crew > 0 && busy < T.searchOfficers && this.rnd() < T.searchStopChance && this.heat.level > 0) {
      const c = u.car;
      const sa = this.heat.searchArea;
      const cx = sa ? sa.p[0] : u.searchC[0], cz = sa ? sa.p[1] : u.searchC[1];
      const d = Math.hypot(cx - c.x, cz - c.z);
      const k = d > 1 ? Math.min(22, d) / d : 0;
      u.invP = [c.x + (cx - c.x) * k, c.z + (cz - c.z) * k];
      u.searchStopT = 11 + this.rnd() * 7;
      this.deployOfficers(u, 1, 'look');
      return;
    }
    this.nextSearchPoint(u);
  }

  private nextSearchPoint(u: Unit) {
    // expanding golden-angle spiral inside the search area, biased along the last seen direction of travel
    u.searchK++;
    const sa = this.heat.searchArea;
    if (sa) u.searchC = [sa.p[0], sa.p[1]];
    const R = sa ? sa.r : 120;
    const vl = Math.hypot(this.lastVel[0], this.lastVel[1]);
    const bias = vl > 1 ? Math.min(60, R * 0.35) / vl : 0;
    const a = u.searchK * 2.39996 + u.id;
    const r = Math.min(R * 0.9, 25 + 16 * u.searchK);
    this.ensureLane(u);
    this.routeTo(u, u.searchC[0] + this.lastVel[0] * bias + Math.cos(a) * r, u.searchC[1] + this.lastVel[1] * bias + Math.sin(a) * r);
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
      this.disguised = false;
      for (const u of this.units) {
        if (u.mode === 'respond' || u.mode === 'search') {
          if (u.mode === 'search') { u.mode = 'respond'; u.searchStopT = 0; this.recallOfficers(u); }
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
    this.disguised = false;
    for (const u of this.units) {
      if (u.mode === 'busted') continue;
      if (u.mode === 'respond' || u.mode === 'pursue' || u.mode === 'search') {
        u.mode = 'leave';
        u.leaveT = 0;
        u.searchStopT = 0;
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
    if (u.mode === 'search') { u.searchStopT = 0; }
    u.mode = 'pursue';
    u.car.sirens = true;
    u.quiet = false;
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
    this.heat.searchArea = null;
    this.heat.decayMul = 1;
    this.disguised = false;
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
    let range = hot ? POLICE_TUNING.sightPursuit : POLICE_TUNING.sightPatrol;
    if (this.disguised && u.mode !== 'pursue') range *= POLICE_TUNING.disguiseSight;
    if (d2 > range * range) return false;
    const eye: Vec3 = [c.x, groundY(this.g, c.x, c.z) + 1.4, c.z];
    // headlights: things in front are seen farther at night
    const inFront = Math.abs(angleDiff(headingOf(P.x - c.x, P.z - c.z), c.h)) < 0.45;
    return canSee({ pos: eye, dir: c.h, fovDeg: u.mode === 'pursue' ? 360 : hot ? 220 : 150, range }, tgt, this.g, { rangeMul: inFront ? 1.35 : 1 });
  }

  private officerSees(o: Officer, tgt: Vec3): boolean {
    // flashlight at night: the beam direction sees much farther than the naked eye
    const night = nightFactor(this.g);
    const dx = tgt[0] - o.x, dz = tgt[2] - o.z;
    const inBeam = night > 0.35 && (o.state === 'look' || o.state === 'chase') && Math.abs(angleDiff(headingOf(dx, dz), o.h + this.flashYaw(o))) < 0.3;
    const mul = (this.disguised && o.state !== 'chase' ? POLICE_TUNING.disguiseSight : 1) * (inBeam ? 1.9 : 1);
    return canSee({ pos: [o.x, o.y + 1.65, o.z], dir: o.h, fovDeg: o.state === 'chase' ? 300 : 200, range: POLICE_TUNING.sightOfficer }, tgt, this.g, { rangeMul: mul });
  }

  private flashYaw(o: Officer): number {
    return o.state === 'look' ? Math.sin(this.g.elapsed * 0.9 + o.sweep) * 0.55 : 0;
  }

  // ------------------------------------------------------------------ driving

  /**
   * Free-driving (off-lane) police car: kinematic bicycle model with grip-limited yaw rate and corner-speed
   * braking (so they take a racing line: brake before the apex, accelerate out), building probes, police
   * separation, traffic avoidance and a stuck/unstuck ladder (reverse & turn → three-point turn → re-seat
   * on the road when nobody's looking).
   */
  private driveFree(u: Unit, tx: number, tz: number, vDes: number, dt: number, P: PlayerInfo, ram: boolean) {
    const c = u.car;
    const g = this.g;
    const T = POLICE_TUNING;
    u.squealCd -= dt;
    u.stuckWin = Math.max(0, u.stuckWin - dt);
    if (u.stuckWin <= 0) u.stuckN = 0;
    if (u.reverseT > 0) {
      u.reverseT -= dt;
      c.v += Math.max(-8 * dt, Math.min(8 * dt, -4.5 - c.v));
      c.h += -u.steer * 0.9 * dt;
    } else {
      const dT = Math.hypot(tx - c.x, tz - c.z);
      let want = dT > 0.5 ? headingOf(tx - c.x, tz - c.z) : c.h;
      // building avoidance probes (4 Hz) + off-road measure
      u.probeT -= dt;
      if (u.probeT <= 0) {
        u.probeT = 0.25;
        const y = groundY(g, c.x, c.z) + 0.9;
        const L = 7 + Math.abs(c.v) * 0.7;
        u.steer = 0;
        let found = false;
        for (const off of [0, 0.3, -0.3, 0.65, -0.65, 1.1, -1.1, 1.6, -1.6]) {
          const hh = want + off;
          if (losClear(g, [c.x, y, c.z], [c.x + Math.sin(hh) * L, y, c.z - Math.cos(hh) * L])) { u.steer = off; found = true; break; }
        }
        if (!found && Math.abs(c.v) < 6) this.startUnstuck(u, 1);
        const r = this.net.nearestLane(c.x, c.z, 40);
        u.offRoad = r ? Math.max(0, r.d - this.net.edges[r.e].width / 2) : 40;
      }
      want += u.steer;
      // traffic avoidance: nearest obstacle in the forward corridor; separation from other police cars
      const fx = Math.sin(c.h), fz = -Math.cos(c.h);
      const rx = Math.cos(c.h), rz = Math.sin(c.h);
      let block = Infinity, side = 0, sep = 0;
      this.traffic?.sim.hash.query(c.x + fx * 6, c.z + fz * 6, 11, (o) => {
        if (o.car === c) return;
        const ox = o.x - c.x, oz = o.z - c.z;
        const lon = ox * fx + oz * fz, lat = ox * rx + oz * rz;
        if (o.car && o.car.kind === 'police' && Math.abs(lon) < 6 && Math.abs(lat) < 3.2) sep += lat > 0 ? -0.35 : 0.35;
        if (ram && (o.kind === 'playerCar' || o.kind === 'player')) return;
        if (!ram && o.kind === 'playerCar' && lon > 1 && lon < 9 && Math.abs(lat) < 2.4) { if (lon < block) { block = lon; side = lat; } return; }
        if (lon < 1 || lon > 16 || Math.abs(lat) > 2.6) return;
        if (lon < block) { block = lon; side = lat; }
      });
      want += Math.max(-0.5, Math.min(0.5, sep));
      if (block < 16) {
        want += side > 0 ? -0.45 : 0.45;
        if (block < 7) vDes = Math.min(vDes, 4 + block);
      }
      const err = angleDiff(want, c.h);
      const sp = Math.abs(c.v);
      // yaw limited by steering lock at low speed and by tyre grip at high speed
      const maxYaw = Math.min(0.24 * sp + 0.15, T.grip / Math.max(1, sp), 2.1);
      const yaw = Math.max(-maxYaw * dt, Math.min(maxYaw * dt, err * 3 * dt));
      c.h += yaw * (c.v >= 0 ? 1 : -1);
      // corner speed: radius of the arc to the target → v = sqrt(grip · R)
      const R = Math.max(3, dT / (2 * Math.max(0.05, Math.sin(Math.min(Math.PI / 2, Math.abs(err))))));
      vDes = Math.min(vDes, Math.sqrt(T.grip * R) + 1.5);
      if (Math.abs(err) > 1.9 && sp < 5) vDes = Math.min(vDes, 3); // tight turn around: crawl
      const dv = vDes - c.v;
      c.v += Math.max(-11 * dt, Math.min(6.5 * dt, dv));
      // tyre squeal on hard cornering / braking near the player
      if (u.squealCd <= 0 && sp > 12 && (Math.abs(yaw / dt) * sp > T.grip * 0.85 || dv < -8) && dist2(c.x, c.z, P.x, P.z) < 70 * 70) {
        u.squealCd = 2.5;
        playSound(g, 'tire-squeal', { at: [c.x, groundY(g, c.x, c.z) + 0.4, c.z], volume: 0.5 });
      }
      // stuck detection
      if (vDes > 3 && Math.abs(c.v) < 1) {
        u.stuckT += dt;
        if (u.stuckT > 1.4) { u.stuckT = 0; this.startUnstuck(u, err > 0 ? 1 : -1); }
      } else u.stuckT = 0;
    }
    c.x += Math.sin(c.h) * c.v * dt;
    c.z += -Math.cos(c.h) * c.v * dt;
    c.acc = c.v;
  }

  /** Unstuck ladder: reverse & turn; repeated → longer three-point turn; hopeless and unseen → re-seat on a lane. */
  private startUnstuck(u: Unit, side: number) {
    const c = u.car;
    u.stuckN++;
    u.stuckWin = 12;
    this.stats.unstuck++;
    if (u.stuckN >= 3 && this.traffic) {
      const y = groundY(this.g, c.x, c.z);
      if (!visibleToCamera(this.g, c.x, y, c.z, 220, true) && this.rescueToLane(u)) { u.stuckN = 0; return; }
    }
    u.reverseT = u.stuckN >= 2 ? 2.2 : 1.3;
    u.steer = side;
  }

  /** Put a lost/stuck car back on the nearest lane (only when the player can't see it). */
  private rescueToLane(u: Unit): boolean {
    const c = u.car;
    const r = this.net.nearestLane(c.x, c.z, 80);
    if (!r) return false;
    const sim = this.traffic!.sim;
    sim.leaveJunction(c);
    sim.placeOnLane(c, r.e, r.lane, r.s);
    c.latOff = 0; c.v = 4;
    u.reverseT = 0; u.stuckT = 0;
    this.stats.rescued++;
    if (u.goal) this.routeTo(u, u.goal[0], u.goal[1]);
    return true;
  }

  private updateUnit(u: Unit, dt: number, P: PlayerInfo, tgt: Vec3 | null) {
    const T = POLICE_TUNING;
    const g = this.g;
    const c = u.car;
    const sim = this.traffic!.sim;
    const L = this.heat.level;
    const dP = Math.sqrt(dist2(c.x, c.z, P.x, P.z));
    u.pitCd -= dt;
    u.noFreeT -= dt;
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
        u.quiet = false;
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
        // lights on, siren off, slow cruise through the search area
        c.sirens = true;
        u.quiet = true;
        c.speedCap = T.searchSpeed;
        u.searchT += dt;
        if (u.searchStopT > 0 || u.deployed) {
          u.searchStopT -= dt;
          if (c.mode === 'lane') { sim.leaveJunction(c); c.mode = 'free'; }
          this.driveFree(u, c.x, c.z, 0, dt, P, false);
          if (u.searchStopT <= 0 && u.officers.some((o) => o.state === 'look')) this.recallOfficers(u);
          if (!u.officers.length) { u.deployed = false; u.searchStopT = 0; if (this.ensureLane(u)) this.nextSearchPoint(u); }
          break;
        }
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
          const road = u.offRoad < 1.5;
          this.driveFree(u, u.invP[0], u.invP[1], dInv > 14 && road ? 6 : 0, dt, P, false);
          if ((dInv < 16 || !road) && Math.abs(c.v) < 0.5 && !u.deployed) this.deployOfficers(u, 1, 'look');
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
        u.quiet = false;
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
          if (dP < 85 && clear && u.noFreeT <= 0) { sim.leaveJunction(c); c.mode = 'free'; u.freeLostT = 0; u.offRoad = 0; }
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
        // off the road (park, plaza, footpath): cars don't follow far — officers bail out, or they go around
        if (u.offRoad > T.offRoadMax) {
          if (!P.inVehicle) { vDes = 0; if (Math.abs(c.v) < 2) this.deployOfficers(u, 2, 'chase'); }
          else {
            // player drove through a park / off-road cut: go around by road
            u.noFreeT = 4;
            if (!this.ensureLane(u)) this.driveToRoad(u, dt, P, 9);
            if ((c.mode as string) === 'lane') this.routeTo(u, P.x, P.z);
            break;
          }
        } else if (u.offRoad > 2) vDes = Math.min(vDes, 11);
        if (P.inVehicle) {
          const fh = P.heading;
          const pfx = Math.sin(fh), pfz = -Math.cos(fh), prx = Math.cos(fh), prz = Math.sin(fh);
          const relx = c.x - P.x, relz = c.z - P.z;
          const lon = relx * pfx + relz * pfz, lat = relx * prx + relz * prz;
          const aligned = Math.abs(angleDiff(c.h, fh)) < 0.45;
          if (ram && u.role !== 'chase' && P.speed > 4) {
            // PIT: line up on a rear quarter, then steer into it (the kinematic car shoves the rear out)
            if (u.pitT > 0) {
              u.pitT -= dt;
              tx = P.x - pfx * 1.6 - prx * u.pitSide * 0.6 + P.vx * 0.2;
              tz = P.z - pfz * 1.6 - prz * u.pitSide * 0.6 + P.vz * 0.2;
              vDes = P.speed + 3;
            } else if (u.pitCd <= 0 && aligned && lon > -5 && lon < -0.4 && Math.abs(lat) > 0.9 && Math.abs(lat) < 3.6) {
              u.pitT = 0.75; u.pitSide = Math.sign(lat) || 1; u.pitCd = 6;
              this.stats.pits++;
              playSound(g, 'tire-squeal', { at: [c.x, groundY(g, c.x, c.z) + 0.4, c.z], volume: 0.7 });
            } else {
              const s = Math.abs(lat) > 0.6 ? Math.sign(lat) : (u.id % 2 ? 1 : -1);
              tx = P.x - pfx * 2.6 + prx * s * 2.1 + P.vx * 0.35;
              tz = P.z - pfz * 2.6 + prz * s * 2.1 + P.vz * 0.35;
              vDes = Math.min(vDes, P.speed + 7);
            }
          } else if (ram && u.role === 'chase' && P.speed > 3) {
            // ram from behind
            vDes = Math.min(vDes, P.speed + 6);
          } else if (u.role === 'flank' && L >= 2) {
            // get ahead, then roll-block: sit in front and brake
            if (lon > 5 && Math.abs(lat) < 3.5 && aligned) {
              tx = P.x + pfx * 8 + P.vx * 0.5; tz = P.z + pfz * 8 + P.vz * 0.5;
              vDes = Math.max(0, P.speed - 3);
            } else if (dP > 12) { tx = P.x + P.vx * 2.6; tz = P.z + P.vz * 2.6; }
          } else if (u.role === 'box' && L >= 2 && dP > 6) {
            // box: ride alongside to pin the player against the curb
            const s = Math.abs(lat) > 0.6 ? Math.sign(lat) : (u.id % 2 ? 1 : -1);
            tx = P.x + prx * s * 3.4 + P.vx * 0.9; tz = P.z + prz * s * 3.4 + P.vz * 0.9;
            vDes = Math.min(vDes, P.speed + (lon < -1 ? 4 : lon > 1 ? -2 : 0.5));
          } else {
            // tail: hold ~10 m, match speed near the target
            vDes = Math.min(vDes, Math.max(0, (dP - 9) * 1.4 + P.speed));
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
      if (state === 'chase') this.shout(o);
      u.officers.push(o);
    }
    playSound(this.g, 'door', { at: [c.x, groundY(this.g, c.x, c.z) + 1, c.z], volume: 0.8 });
  }

  private shout(o: Officer) {
    if (this.g.elapsed - o.shoutT < 5) return;
    o.shoutT = this.g.elapsed;
    o.bubbleT = 1.8;
    o.icon.set('shout');
    playSound(this.g, 'shout', { at: [o.x, o.y + 1.7, o.z], volume: 0.9, rate: 0.92 + Math.random() * 0.16 });
    this.g.events.emit('noise', { p: [o.x, o.z], radius: 28, kind: 'shout' });
  }

  // ------------------------------------------------------------------ officers

  private updateOfficer(o: Officer, dt: number, P: PlayerInfo, tgt: Vec3 | null) {
    const g = this.g;
    if(o.stunned<=0 && P.inVehicle && P.vehicle && Math.abs(P.vehicle.speed)>3){
      const dx=o.x-P.x,dz=o.z-P.z,fx=Math.sin(P.vehicle.heading),fz=-Math.cos(P.vehicle.heading);
      if(Math.abs(dx*fx+dz*fz)<2.7&&Math.abs(dx*-fz+dz*fx)<1.1&&Math.abs(o.y-P.y)<1.5){
        o.stunned=4+(o.ch.duration('getup')||1.1);o.recovering=false;o.ch.setFallen(true);
        o.ch.impact(g,fx*Math.sign(P.vehicle.speed),fz*Math.sign(P.vehicle.speed),Math.abs(P.vehicle.speed)*.4);
        g.events.emit('crime',{kind:'assault',p:[o.x,o.z],severity:3});
      }
    }
    if(o.stunned>0){
      if(o.ch.ragdoll){o.x=o.ch.ragdoll.position.x;o.z=o.ch.ragdoll.position.z;o.y=groundY(g,o.x,o.z);o.ch.root.position.set(o.x,o.y,o.z);}
      o.stunned=Math.max(0,o.stunned-dt);o.v=0;o.vaultT=0;flashlightFor(o.ch).visible=false;
      if(o.stunned<o.ch.duration('getup') && !o.recovering){o.recovering=true;o.ch.setFallen(false);}
      return;
    }
    let tx = o.x, tz = o.z, speed = 0;
    const T = POLICE_TUNING;
    const L = this.heat.level;
    switch (o.state) {
      case 'chase': {
        if (!P.ok) break;
        const recent = g.elapsed - o.seenT < 4 || g.elapsed - this.lastAnySeen < 2;
        const lk = recent ? [P.x, P.z] : this.heat.lastKnown ?? [P.x, P.z];
        tx = lk[0]; tz = lk[1];
        let d = Math.hypot(tx - o.x, tz - o.z);
        if (recent && d < 4) {
          // close in to an arm's-length slot around the suspect (don't pile onto one spot)
          const k = this.officers.indexOf(o);
          const a = headingOf(o.x - P.x, o.z - P.z) + ((k % 3) - 1) * 0.25;
          tx = P.x + Math.sin(a) * 1.15; tz = P.z - Math.cos(a) * 1.15;
          d = Math.hypot(tx - o.x, tz - o.z);
        }
        speed = d > 0.35 ? (d > 3 ? T.officerRunSpeed : 2.4) : 0;
        if (recent && g.elapsed - o.seenT < 0.3 && d < 30) this.shout(o);
        if (!recent && d < 3) { o.state = o.unit?.mode === 'search' ? 'look' : 'return'; o.gx = o.x; o.gz = o.z; }
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
        speed = d > 12 ? T.officerRunSpeed * 0.8 : 2.2;
        if (d < 2.6 || (d > 60 && !visibleToCamera(g, o.x, o.y, o.z, 200, true))) {
          u.officers.splice(u.officers.indexOf(o), 1);
          this.removeOfficer(o);
          if (!u.officers.length) u.deployed = false;
          if (d < 2.6) playSound(g, 'door', { at: [c.x, groundY(g, c.x, c.z) + 1, c.z], volume: 0.6 });
          return;
        }
        break;
      }
      case 'look': {
        // sweep the block around the anchor with a flashlight; spot → chase
        o.probeT -= dt;
        if (o.probeT <= 0) {
          o.probeT = 3 + Math.random() * 3;
          o.steer = Math.random() * Math.PI * 2;
        }
        tx = o.gx + Math.cos(o.steer) * 7; tz = o.gz + Math.sin(o.steer) * 7;
        speed = Math.hypot(tx - o.x, tz - o.z) > 1 ? 1.4 : 0;
        if (L > 0 && g.elapsed - o.seenT < 0.3 && P.ok && !P.inVehicle) { o.state = 'chase'; this.shout(o); }
        break;
      }
      case 'guard': {
        // stand at the roadblock, chase a player on foot who comes close
        tx = o.gx; tz = o.gz;
        speed = Math.hypot(tx - o.x, tz - o.z) > 0.8 ? 2.5 : 0;
        if (P.ok && !P.inVehicle && g.elapsed - o.seenT < 1 && dist2(o.x, o.z, P.x, P.z) < 30 * 30) { o.state = 'chase'; this.shout(o); }
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
    // bubble timeout
    if (o.bubbleT > 0) { o.bubbleT -= dt; if (o.bubbleT <= 0) o.icon.set(null); }
    let want = headingOf(tx - o.x, tz - o.z);
    let vaultOff = 0;
    if (o.vaultT > 0) {
      // mid-vault: carry on over the obstacle
      o.vaultT -= dt;
      const t = 1 - Math.max(0, o.vaultT) / o.vaultDur;
      vaultOff = Math.sin(Math.PI * t) * o.vaultH;
      o.x += o.vaultDx * dt; o.z += o.vaultDz * dt;
      want = headingOf(o.vaultDx, o.vaultDz);
      speed = Math.hypot(o.vaultDx, o.vaultDz);
    } else if (speed > 0) {
      // path probes around buildings
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
      this.moveOfficer(o, want, speed, dt);
    } else if (P.ok && (o.state === 'chase' || o.state === 'surround' || o.state === 'guard')) {
      want = headingOf(P.x - o.x, P.z - o.z);
    }
    // personal space between officers
    for (const q of this.officers) {
      if (q === o) continue;
      const dx = o.x - q.x, dz = o.z - q.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.64 && d2 > 1e-6) { const d = Math.sqrt(d2), push = (0.8 - d) * 0.5; o.x += (dx / d) * push; o.z += (dz / d) * push; }
    }
    const dh = angleDiff(want, o.h);
    o.h += Math.sign(dh) * Math.min(Math.abs(dh), 8 * dt);
    o.v = speed;
    o.y = groundY(g, o.x, o.z, o.y);
    o.ch.root.position.set(o.x, o.y + vaultOff, o.z);
    o.ch.root.rotation.y = -o.h;
    const role = o.vaultT > 0 ? 'jump' : speed > 4.8 ? 'sprint' : speed > 3 ? 'run' : speed > 0.3 ? 'walk' : 'idle';
    o.ch.play(role, 0.15, role === 'run' ? speed / 5.5 : role === 'sprint' ? speed / 6.5 : 1);
    // flashlight (night): beam from the chest; sweeps while searching
    const night = nightFactor(g);
    const f = flashlightFor(o.ch);
    f.visible = night > 0.35 && (o.state === 'look' || o.state === 'chase' || o.state === 'guard' || o.state === 'return');
    if (f.visible) f.rotation.y = -this.flashYaw(o);
    void tgt;
  }

  /**
   * Move an officer one step with collision: buildings block (slide along them, or vault if the obstacle is
   * low); stationary cars in the way are vaulted (hood slide); moving cars are waited for.
   */
  private moveOfficer(o: Officer, want: number, speed: number, dt: number) {
    const g = this.g;
    const fx = Math.sin(want), fz = -Math.cos(want);
    const step = speed * dt;
    // cars (kinematic traffic, police, the player's car): OBB test just ahead
    let carBlock: { v: number } | null = null;
    this.traffic?.sim.hash.query(o.x + fx * 1.2, o.z + fz * 1.2, 4, (ob) => {
      if (carBlock || !(ob.kind === 'car' || ob.kind === 'vehicle' || ob.kind === 'playerCar')) return;
      const cfx = Math.sin(ob.h), cfz = -Math.cos(ob.h);
      const px = o.x + fx * 0.9 - ob.x, pz = o.z + fz * 0.9 - ob.z;
      const lon = px * cfx + pz * cfz, lat = px * cfz * -1 + pz * cfx;
      if (Math.abs(lon) < (ob.r || 2.3) && Math.abs(lat) < 1.05) carBlock = { v: Math.abs(ob.v) };
    });
    if (carBlock) {
      if ((carBlock as { v: number }).v < 1.5 && speed > 2) { this.startVault(o, fx, fz, speed, 1.15, 0.7); return; }
      return; // moving car: wait
    }
    const nx = o.x + fx * step, nz = o.z + fz * step;
    const knee = o.y + 0.5;
    if (losClear(g, [o.x, knee, o.z], [nx + fx * 0.4, knee, nz + fz * 0.4])) {
      // low step up (curb, planter edge, low wall top): hop if the ground ahead rises sharply
      const gy = groundY(g, nx + fx * 0.4, nz + fz * 0.4, o.y);
      if (gy - o.y > 0.45 && gy - o.y < 1.3 && speed > 2) { this.startVault(o, fx, fz, speed, gy - o.y + 0.35, 0.5); return; }
      o.x = nx; o.z = nz;
      return;
    }
    // blocked at knee height: vault if it's low (chest height clear), else slide along the wall
    const chest = o.y + 1.45;
    if (speed > 2 && losClear(g, [o.x, chest, o.z], [o.x + fx * 1.6, chest, o.z + fz * 1.6])) {
      this.startVault(o, fx, fz, speed, 1.0, 0.6);
      return;
    }
    for (const off of [Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
      const h = want + off;
      const sx = o.x + Math.sin(h) * step * 0.8, sz = o.z - Math.cos(h) * step * 0.8;
      if (losClear(g, [o.x, knee, o.z], [sx + Math.sin(h) * 0.4, knee, sz - Math.cos(h) * 0.4])) { o.x = sx; o.z = sz; return; }
    }
  }

  private startVault(o: Officer, fx: number, fz: number, speed: number, h: number, dur: number) {
    o.vaultDur = dur; o.vaultT = dur; o.vaultH = h;
    const v = Math.max(3.2, speed * 0.85);
    o.vaultDx = fx * v; o.vaultDz = fz * v;
    this.stats.vaults++;
  }

  // ------------------------------------------------------------------ roadblocks

  /** Walk the road graph ahead of the player (following the straightest continuation) to a junction 110–240 m out. */
  private predictJunction(P: PlayerInfo): { node: number; edge: number } | null {
    const net = this.net;
    const vl = Math.hypot(P.vx, P.vz);
    const h = vl > 2 ? headingOf(P.vx, P.vz) : P.heading;
    const r = net.nearestLane(P.x, P.z, 30, h);
    if (!r) return null;
    let e = net.edges[r.e];
    let dist = e.len - r.s;
    for (let step = 0; step < 14; step++) {
      const nd = net.nodes[e.to];
      if (dist >= 110 && nd.degree >= 3 && !this.roadblocks.some((b) => b.node === nd.id)) {
        if (!visibleToCamera(this.g, nd.x, groundY(this.g, nd.x, nd.z), nd.z, 300, true)) return { node: nd.id, edge: e.i };
      }
      if (dist > 250) break;
      let best = -1, bd = -2;
      for (const oi of nd.out) {
        const o = net.edges[oi];
        if (o.to === e.from) continue;
        const dot = Math.cos(net.turnAngle(e, o)) + o.rank * 0.05;
        if (dot > bd) { bd = dot; best = oi; }
      }
      if (best < 0) break;
      e = net.edges[best];
      dist += e.len;
    }
    return null;
  }

  private placeRoadblock(P: PlayerInfo): boolean {
    if (!this.traffic?.enabled) return false;
    const net = this.net;
    let best = -1, edge = -1;
    const pred = this.predictJunction(P);
    if (pred) { best = pred.node; edge = pred.edge; }
    else {
      // fallback: best-scoring junction ahead in the direction of travel
      const vlen = Math.hypot(P.vx, P.vz);
      const cand = new Set<number>();
      for (const ei of net.edgesNear(P.x, P.z, 250)) cand.add(net.edges[ei].to);
      let bs = -Infinity;
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
        if (visibleToCamera(this.g, nd.x, groundY(this.g, nd.x, nd.z), nd.z, 300, true)) continue;
        if (score > bs) { bs = score; best = n; }
      }
      if (best < 0) return false;
      let ed = Infinity;
      for (const ei of net.nodes[best].in) {
        const f = net.nodes[net.edges[ei].from];
        const d = dist2(f.x, f.z, P.x, P.z);
        if (d < ed) { ed = d; edge = ei; }
      }
    }
    if (edge < 0) return false;
    const E = net.edges[edge];
    const s = Math.max(net.laneStart(E), net.laneEnd(E) - 5);
    const cp = samplePoly(E.center, s);
    const rb: Roadblock = { node: best, cars: [], officers: [], born: this.g.elapsed };
    const rx = Math.cos(cp.h), rz = Math.sin(cp.h);
    // span the whole carriageway (both directions): 2 cars, 3 on wide roads, angled nose-to-nose
    const half = Math.max(2.4, E.width / 2 - 1.2);
    const slots = E.width > 13 ? [-1, 0, 1] : [-1, 1];
    for (const side of slots) {
      const x = cp.x + rx * side * half * (slots.length === 3 ? 1 : 0.62), z = cp.z + rz * side * half * (slots.length === 3 ? 1 : 0.62);
      const ang = side === 0 ? Math.PI / 2 : (Math.PI / 2) * side + (this.rnd() - 0.5) * 0.35 + side * 0.25;
      const car = this.traffic.addFreeCar('police', x, z, cp.h + ang);
      if (!car) continue;
      car.sirens = true;
      const u = new Unit(this.nextId++, car);
      u.mode = 'roadblock';
      u.crew = 0;
      this.units.push(u);
      rb.cars.push(car);
      // officer crouched behind the car (away from the player)
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
      for (let i = 0; i < this.officers.length; i++) {
        const o = this.officers[i];
        if (((this.frame + i) % 8) === 0 && this.officerSees(o, tgt)) o.seenT = g.elapsed;
        if (g.elapsed - o.seenT < 0.2) {
          if (L > 0) { spotted = true; by = 'officer'; }
          else if (P.suspicious) g.events.emit('witness', { source: 'police', p: [P.x, P.z], confidence: 1, delay: 0, sourceId: 'officer' });
        }
      }
      if (this.heli && this.heli.sees && L > 0) { spotted = true; by = 'heli'; }
    }
    if (spotted) {
      this.lastAnySeen = g.elapsed;
      this.disguised = false;
      if (P.speed > 1) this.lastVel = [P.vx, P.vz];
    }
    this.stats.spottedBy = by;
    this.heat.decayMul = this.disguised ? T.disguiseDecay : 1;
    this.heat.now = g.elapsed - dt;
    if (!this.busted) this.heat.update(dt, spotted, P.ok ? [P.x, P.z] : undefined, this.camSeen);
    this.camSeen = false;
    // search area: centered on the last sighting, growing while they're blind
    if (this.heat.level > 0 && !spotted && this.heat.lastKnown && this.heat.unseen > 1) {
      const r = Math.min(240, 45 + this.heat.unseen * 4.5 + (this.disguised ? 40 : 0));
      const sa = this.heat.searchArea;
      if (sa && sa.p[0] === this.heat.lastKnown[0] && sa.p[1] === this.heat.lastKnown[1]) sa.r = r;
      else this.heat.searchArea = { p: this.heat.lastKnown, r };
    } else this.heat.searchArea = null;
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
          const pat = this.nearestUnit(lk, (x) => x.mode === 'patrol' || x.mode === 'leave' || (x.mode === 'investigate' && (!x.invArrived || L >= 2) && !x.deployed));
          if (pat) { pat.mode = 'respond'; this.ensureLane(pat); this.routeTo(pat, lk[0], lk[1]); }
          else if (this.spawnCd <= 0) {
            const u = this.spawnUnit('respond', P);
            if (u) { this.routeTo(u, lk[0], lk[1]); this.spawnCd = 1.2; }
          }
        }
        // assign pursuit roles (closest unit tails / rams; others flank & box)
        const pursuers = this.units.filter((u) => u.mode === 'pursue').sort((a, b) => dist2(a.car.x, a.car.z, P.x, P.z) - dist2(b.car.x, b.car.z, P.x, P.z));
        pursuers.forEach((u, k) => { u.role = (['chase', 'box', 'flank'] as const)[k % 3]; });
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
      this.roadblockT = 7;
      if (L >= T.roadblockLevel) {
        for (const rb of [...this.roadblocks]) {
          const nd = this.net.nodes[rb.node];
          if (!nd || (dist2(nd.x, nd.z, P.x, P.z) > 330 * 330 && !visibleToCamera(g, nd.x, groundY(g, nd.x, nd.z), nd.z, 400, true))) {
            for (const c of rb.cars) { const u = this.units.find((x) => x.car === c); if (u) this.removeUnit(u); }
            for (const o of rb.officers) if (this.officers.includes(o)) this.removeOfficer(o);
            this.roadblocks.splice(this.roadblocks.indexOf(rb), 1);
          }
        }
        if (this.roadblocks.length < (L >= 4 ? 3 : 2) && P.inVehicle) this.placeRoadblock(P);
      } else if (this.roadblocks.length) this.clearRoadblocks(false);
    }

    // ---- helicopter
    if (L >= T.heliLevel && !this.heli && P.ok && !this.busted) {
      const a = this.rnd() * Math.PI * 2;
      this.heli = new Helicopter(g, P.x + Math.cos(a) * 380, P.z + Math.sin(a) * 380, this.heliLight, () => this.heat.searchArea);
      this.heliLeaveT = 0;
    }
    if (this.heli) {
      if (L < T.heliLevel) this.heliLeaveT += dt; else this.heliLeaveT = 0;
      this.heli.update(dt, P.ok ? tgt : null, this.heat.lastKnown, this.heliLeaveT > 10, g.elapsed, P.ok ? [P.vx, P.vz] : undefined, g.elapsed - this.lastAnySeen < 1.5);
      if (this.heli.gone || (this.heliLeaveT > 10 && this.heli.state === 'leaving' && Math.hypot(this.heli.x - P.x, this.heli.z - P.z) > 550)) {
        this.heli.dispose();
        this.heli = null;
      }
    }

    // ---- units
    for (const u of this.units) this.updateUnit(u, dt, P, tgt);

    // ---- officers
    for (const o of [...this.officers]) this.updateOfficer(o, dt, P, tgt);
    const cam = g.camera.position;
    let flashBest: Officer | null = null, fbd = 45 * 45;
    for (let i = 0; i < this.officers.length; i++) {
      const o = this.officers[i];
      const d2 = dist2(o.x, o.z, P.x, P.z);
      o.animAcc += dt;
      const every = d2 < 50 * 50 ? 1 : 3;
      if ((this.frame + i) % every === 0) { o.ch.update(o.animAcc); o.animAcc = 0; }
      const f = flashlights.get(o.ch);
      if (f?.visible) { const dc = dist2(o.x, o.z, cam.x, cam.z); if (dc < fbd) { fbd = dc; flashBest = o; } }
    }
    // one real flashlight SpotLight follows the officer nearest the camera (the rest are beam + pool fakes)
    if (flashBest) {
      const o = flashBest as Officer;
      const h = o.h + this.flashYaw(o);
      const fx = Math.sin(h), fz = -Math.cos(h);
      this.flashLight.position.set(o.x + fx * 0.3, o.y + 1.4, o.z + fz * 0.3);
      this.flashLight.target.position.set(o.x + fx * 9, o.y, o.z + fz * 9);
      this.flashLight.target.updateMatrixWorld();
      this.flashLight.intensity = 60 * nightFactor(g);
    } else this.flashLight.intensity = 0;

    // ---- sirens: audio, noise, civilians pull over (searching units run lights only)
    const sirenUnits = this.units.filter((u) => u.car.sirens && u.mode !== 'roadblock' && u.mode !== 'busted');
    sirenUnits.sort((a, b) => dist2(a.car.x, a.car.z, P.x, P.z) - dist2(b.car.x, b.car.z, P.x, P.z));
    let audible = 0;
    for (const u of sirenUnits) {
      const c = u.car;
      const y = groundY(g, c.x, c.z) + 1.4;
      if (!u.quiet && audible < 3 && dist2(c.x, c.z, P.x, P.z) < 300 * 300) {
        audible++;
        if (!u.siren) u.siren = playSound(g, 'siren', { at: [c.x, y, c.z], loop: true, volume: 0.85, rate: 0.95 + (u.id % 5) * 0.03 });
        u.siren?.setPosition([c.x, y, c.z]);
      } else if (u.siren) { u.siren.stop(); u.siren = null; }
      if (u.quiet) continue;
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
    }
    for (const u of this.units) if (u.siren && (!u.car.sirens || u.quiet)) { u.siren.stop(); u.siren = null; }

    // ---- arrest
    this.updateArrest(dt, P);
  }

  private updateArrest(dt: number, P: PlayerInfo) {
    const T = POLICE_TUNING;
    const g = this.g;
    if (this.busted || !P.ok || this.heat.level === 0) {
      this.arrestMeter = Math.max(0, this.arrestMeter - dt);
      this.heat.arrestMeter = this.busted ? 1 : this.arrestMeter;
      return;
    }
    let rate = 0;
    if (!P.inVehicle) {
      // an officer within reach who can actually touch you (no through-wall arrests, not mid-vault)
      for (const o of this.officers) {
        if (o.stunned<=0 && (o.state === 'chase' || o.state === 'guard' || o.state === 'look') && o.vaultT <= 0 && dist2(o.x, o.z, P.x, P.z) < T.arrestFootDist * T.arrestFootDist &&
          losClear(g, [o.x, o.y + 1.2, o.z], [P.x, P.y + 1.2, P.z])) { rate = 1 / T.arrestFootTime; break; }
      }
      // sprinting away breaks the grab
      if (rate && P.speed > 5.9) rate *= 0.35;
    } else if (P.speed < T.arrestCarSpeed) {
      for (const u of this.units) {
        if (dist2(u.car.x, u.car.z, P.x, P.z) < T.arrestCarDist * T.arrestCarDist) { rate = 1 / T.arrestCarTime; break; }
      }
      if (!rate) for (const o of this.officers) if (o.stunned<=0 && dist2(o.x, o.z, P.x, P.z) < 9) { rate = 1 / T.arrestCarTime; break; }
    }
    // low heat (a single patrol, early in a run) gives a little more time to react
    if (this.heat.level <= 1) rate *= 0.75;
    if (rate > 0) this.arrestMeter += rate * dt;
    else this.arrestMeter = Math.max(0, this.arrestMeter - dt * 0.9);
    this.heat.arrestMeter = Math.min(1, this.arrestMeter);
    if (this.arrestMeter >= 1) this.arrest(P);
  }

  private arrest(P: PlayerInfo) {
    const g = this.g;
    this.busted = true;
    this.heat.arrestMeter = 1;
    this.heat.searchArea = null;
    g.events.emit('arrested', {});
    const pl = (g as any).player;
    if (pl && pl.controlsEnabled !== false) { pl.controlsEnabled = false; this.disabledControls = true; }
    // freeze police; officers already on foot close in, nearby crews get out of their cars (no teleports)
    const near = [...this.units].sort((a, b) => dist2(a.car.x, a.car.z, P.x, P.z) - dist2(b.car.x, b.car.z, P.x, P.z));
    for (const u of this.units) { u.mode = 'busted'; u.car.sirens = true; u.quiet = true; }
    for (const o of this.officers) if (dist2(o.x, o.z, P.x, P.z) < 60 * 60) o.state = 'surround';
    let need = 3 - this.officers.filter((o) => o.state === 'surround').length;
    for (const u of near) {
      if (need <= 0) break;
      if (u.deployed || u.crew === 0 || dist2(u.car.x, u.car.z, P.x, P.z) > 40 * 40) continue;
      u.deployed = false;
      this.deployOfficers(u, 2, 'surround');
      need -= 2;
    }
    if (this.traffic) this.traffic.panicNear(P.x, P.z, 40);
  }
}
