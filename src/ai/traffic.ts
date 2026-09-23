// Traffic system: binds TrafficSim cars to gameplay VehicleHandles, spawns/despawns a ring of cars
// around the player, feeds obstacles (player, peds, other vehicles), handles rams/panic.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { VehicleHandle } from '../core/api';
import { rng } from '../core/geo';
import { RoadNet, samplePoly, CLASS_DENSITY } from './roadnet';
import { TrafficSim, Car, type Obstacle } from './trafficsim';
import { groundY, hourOfDay, playerInfo, visibleToCamera, playSound, dist2, type PlayerInfo } from './util';

export const TRAFFIC_TUNING = {
  /** max civilian cars around the player */
  maxCars: 46,
  minCars: 10,
  /** ring radius (m) */
  radius: 350,
  despawnRadius: 430,
  /** weighted road meters per car (lower = denser) */
  metersPerCar: 70,
  /** global density multiplier */
  density: 1,
};

/** Traffic density multiplier by hour. */
export function trafficTimeFactor(h: number): number {
  if (h < 5) return 0.28;
  if (h < 7) return 0.28 + (h - 5) * 0.36;
  if (h < 9.5) return 1.15;
  if (h < 16) return 0.95;
  if (h < 19) return 1.15;
  if (h < 22) return 0.7;
  return 0.42;
}

const UP = new THREE.Vector3();

interface CarData {
  handle: VehicleHandle;
  acc: number;
  y: number;
  hazard: number;
  /** knocked into dynamic physics by a crash: physics owns the pose until it settles */
  crashed: boolean;
  settle: number;
  prevMode: 'lane' | 'free' | 'parked';
}

export class TrafficSystem {
  net: RoadNet;
  sim: TrafficSim;
  rnd = rng(1337);
  /** obstacles contributed by other systems (peds) — rebuilt each frame by owners */
  extraObstacles: Obstacle[] = [];
  private external: Obstacle[] = [];
  private playerObs: Obstacle = { x: 0, z: 0, h: 0, v: 0, r: 0.45, kind: 'player' };
  private handleIds = new Set<string>();
  private frame = 0;
  private spawnTimer = 0;
  targetCount = 0;
  enabled: boolean;
  private initialFill = true;
  lastRam = 0;

  constructor(private g: Game) {
    this.net = new RoadNet(g.recipe);
    this.sim = new TrafficSim(this.net, rng(hashSeed(g.recipe.name)));
    this.enabled = !!(g as any).vehicles?.spawn && this.net.edges.length > 0;
    this.sim.hooks.honk = (c) => {
      const d = (c.data as CarData | null);
      if (!d) return;
      playSound(this.g, 'horn', { at: [c.x, d.y + 1, c.z], volume: 0.8, rate: 0.9 + this.rnd() * 0.25 });
    };
  }

  handleOf(c: Car): VehicleHandle | null { return (c.data as CarData | null)?.handle ?? null; }
  isAiHandle(id: string) { return this.handleIds.has(id); }

  /** Spawn a sim car + vehicle handle on a lane. */
  addCar(kind: 'civilian' | 'police', e: number, lane: number, s: number, look?: { model?: string; color?: string }): Car | null {
    const vehicles = (this.g as any).vehicles;
    if (!vehicles?.spawn) return null;
    const c = this.sim.addCar(kind, e, lane, s);
    let handle: VehicleHandle;
    try {
      handle = vehicles.spawn({ kind, p: [c.x, c.z], heading: c.h, physics: false, ...(look ?? {}) });
    } catch (err) {
      console.warn('[ai] vehicle spawn failed', err);
      this.sim.removeCar(c);
      return null;
    }
    handle.driver = 'ai';
    const y = groundY(this.g, c.x, c.z);
    c.data = { handle, acc: 0, y, hazard: 0, crashed: false, settle: 0, prevMode: 'lane' } as CarData;
    if (kind === 'police') c.halfLen = 2.45;
    this.handleIds.add(handle.id);
    this.sync(c);
    return c;
  }

  /** Spawn a car at an arbitrary pose in free mode (roadblocks). */
  addFreeCar(kind: 'civilian' | 'police', x: number, z: number, h: number): Car | null {
    const e = this.net.nearestLane(x, z, 80)?.e ?? 0;
    if (!this.net.edges.length) return null;
    const c = this.addCar(kind, e, 0, this.net.laneStart(this.net.edges[e]));
    if (!c) return null;
    this.sim.leaveJunction(c);
    c.mode = 'free';
    c.x = x; c.z = z; c.h = h; c.v = 0;
    this.sync(c);
    return c;
  }

  removeCar(c: Car, despawnHandle = true) {
    const d = c.data as CarData | null;
    this.sim.removeCar(c);
    if (d) {
      this.handleIds.delete(d.handle.id);
      if (despawnHandle) {
        try { (this.g as any).vehicles?.despawn?.(d.handle.id); } catch { /* ignore */ }
      }
    }
    c.data = null;
  }

  sync(c: Car) {
    const d = c.data as CarData | null;
    if (!d) return;
    const h = d.handle;
    if (d.crashed) return;
    h.position.set(c.x, d.y, c.z);
    h.heading = c.h;
    h.speed = c.v;
    if (h.control) {
      h.control.brake = c.acc < -0.8 || c.v < 0.1 ? 1 : 0;
      h.control.throttle = c.acc > 0.2 ? Math.min(1, c.acc / 2) : 0;
      h.control.steer = 0;
    }
    if (c.kind === 'police') h.siren = c.sirens;
  }

  civilianCount() {
    let n = 0;
    for (const c of this.sim.cars) if (c.kind === 'civilian') n++;
    return n;
  }

  /** Weighted drivable meters near p (for density). */
  private localWeight(x: number, z: number, r: number): number {
    let w = 0;
    for (const ei of this.net.edgesNear(x, z, r)) {
      const e = this.net.edges[ei];
      const mx = (e.minX + e.maxX) / 2, mz = (e.minZ + e.maxZ) / 2;
      if (dist2(mx, mz, x, z) > r * r) continue;
      w += e.len * (CLASS_DENSITY[e.cls] ?? 0.3) * e.dirLanes;
    }
    return w;
  }

  /** Try to spawn one civilian car in the ring around the player. */
  private trySpawn(P: PlayerInfo): boolean {
    const T = TRAFFIC_TUNING;
    const cand = this.net.edgesNear(P.x, P.z, T.radius);
    if (!cand.length) return false;
    for (let attempt = 0; attempt < 6; attempt++) {
      // weighted pick
      let tot = 0;
      const ws = cand.map((ei) => {
        const e = this.net.edges[ei];
        const w = e.len * (CLASS_DENSITY[e.cls] ?? 0.3) * e.dirLanes;
        tot += w;
        return w;
      });
      let r = this.rnd() * tot, pick = cand[0];
      for (let k = 0; k < cand.length; k++) { r -= ws[k]; if (r <= 0) { pick = cand[k]; break; } }
      const E = this.net.edges[pick];
      const lane = Math.floor(this.rnd() * E.dirLanes);
      const s0 = this.net.laneStart(E), s1 = this.net.laneEnd(E);
      if (s1 - s0 < 6) continue;
      const s = s0 + this.rnd() * (s1 - s0 - 4);
      const sp = samplePoly(this.net.lanePoly(E, lane), s);
      const d = Math.hypot(sp.x - P.x, sp.z - P.z);
      if (d > T.radius) continue;
      const y = groundY(this.g, sp.x, sp.z);
      if (!this.initialFill) {
        if (d < 70) continue;
        if (d < 220 && visibleToCamera(this.g, sp.x, y, sp.z, 220, false)) continue;
      } else if (d < 18) continue;
      // clearance
      let clear = true;
      this.sim.hash.query(sp.x, sp.z, 11, () => { clear = false; });
      if (!clear) continue;
      for (const c of this.sim.cars) if (dist2(c.x, c.z, sp.x, sp.z) < 121) { clear = false; break; }
      if (!clear) continue;
      const c = this.addCar('civilian', pick, lane, s);
      if (!c) return false;
      c.v = Math.min(E.speed, 4 + this.rnd() * E.speed * 0.8);
      return true;
    }
    return false;
  }

  /** React to a ram / gunshot / crash: stop with hazards or flee. */
  panicCar(c: Car, mode?: 'flee' | 'stop') {
    if (c.kind !== 'civilian') return;
    c.panicMode = mode ?? (this.rnd() < 0.55 ? 'flee' : 'stop');
    c.panic = c.panicMode === 'flee' ? 14 + this.rnd() * 8 : 6 + this.rnd() * 5;
    const d = c.data as CarData | null;
    if (d) d.hazard = c.panic;
    if (c.honkCd <= 0) { c.honkCd = 2; this.sim.hooks.honk?.(c); }
  }

  /** Panic all civilian cars near p. */
  panicNear(x: number, z: number, r: number) {
    for (const c of this.sim.cars) if (c.kind === 'civilian' && dist2(c.x, c.z, x, z) < r * r) this.panicCar(c);
  }

  update(dt: number) {
    if (!this.enabled) return;
    this.frame++;
    const g = this.g;
    const P = playerInfo(g);
    this.sim.time = g.elapsed; // match the world's rendered signal lights

    // release cars the player took over / destroyed handles
    for (let i = this.sim.cars.length - 1; i >= 0; i--) {
      const c = this.sim.cars[i];
      const d = c.data as CarData | null;
      if (!d) continue;
      if (d.handle.driver === 'player' || d.handle.kind === 'player' || (P.vehicle && P.vehicle.id === d.handle.id)) {
        this.removeCar(c, false);
      } else if (d.handle.destroyed) {
        this.removeCar(c, true);
      }
    }

    // cars knocked into dynamic physics by a crash (gameplay sets handle.crashed / physicsMode)
    for (const c of this.sim.cars) {
      const d = c.data as CarData | null;
      if (!d) continue;
      const hv = d.handle as any;
      const dyn = hv.physicsMode === 'dynamic' || hv.crashed;
      if (dyn && !d.crashed) {
        d.crashed = true;
        d.settle = 0;
        d.prevMode = c.mode;
        this.sim.leaveJunction(c);
        c.mode = 'parked';
        if (c.kind === 'civilian') this.panicCar(c);
      }
      if (d.crashed) {
        c.x = d.handle.position.x; c.z = d.handle.position.z; c.h = d.handle.heading; c.v = d.handle.speed;
        d.y = d.handle.position.y;
        if (Math.abs(d.handle.speed) < 0.4) d.settle += dt; else d.settle = 0;
        const upright = !hv.object || UP.set(0, 1, 0).applyQuaternion(hv.object.quaternion).y > 0.8;
        if (d.settle > 2.5 && upright && typeof hv.makeKinematic === 'function' && !d.handle.destroyed) {
          hv.makeKinematic();
          d.crashed = false;
          c.v = 0;
          c.mode = 'free';
          if (c.kind === 'civilian' && !this.sim.attachToLane(c, 6)) c.dead = true;
        }
      }
    }

    // external obstacles
    const ext = this.external;
    ext.length = 0;
    if (P.ok) {
      if (P.inVehicle && P.vehicle) {
        const o = this.playerObs;
        o.kind = 'playerCar'; o.r = 2.3; o.x = P.x; o.z = P.z; o.h = P.vehicle.heading; o.v = Math.abs(P.vehicle.speed);
        ext.push(o);
      } else {
        const o = this.playerObs;
        o.kind = 'player'; o.r = 0.45; o.x = P.x; o.z = P.z; o.h = P.heading; o.v = P.speed;
        ext.push(o);
      }
    }
    const vehicles = (g as any).vehicles;
    if (vehicles?.all) {
      for (const h of vehicles.all() as VehicleHandle[]) {
        if (this.handleIds.has(h.id) || (P.vehicle && h.id === P.vehicle.id)) continue;
        if (dist2(h.position.x, h.position.z, P.x, P.z) > 400 * 400) continue;
        const o = ((h as any).__aiObs ??= { x: 0, z: 0, h: 0, v: 0, r: 2.3, kind: 'vehicle' }) as Obstacle;
        o.x = h.position.x; o.z = h.position.z; o.h = h.heading; o.v = Math.abs(h.speed ?? 0);
        ext.push(o);
      }
    }
    for (const o of this.extraObstacles) ext.push(o);
    this.sim.rebuild(ext);

    // step cars with distance LOD
    for (const c of this.sim.cars) {
      const d = c.data as CarData | null;
      if (!d || c.mode !== 'lane' || c.dead) continue;
      const dd = dist2(c.x, c.z, P.x, P.z);
      const every = dd < 200 * 200 ? 1 : dd < 320 * 320 ? 2 : 4;
      d.acc += dt;
      if ((this.frame + c.id) % every !== 0) continue;
      this.sim.stepCar(c, Math.min(d.acc, 0.25));
      d.acc = 0;
    }

    // ram detection (player's vehicle hits an AI car)
    if (P.inVehicle && P.vehicle && P.speed > 3) {
      for (const c of this.sim.cars) {
        if (dist2(c.x, c.z, P.x, P.z) > 5.2 * 5.2) continue;
        // oriented overlap test (approx.): project onto the AI car's axes
        const fx = Math.sin(c.h), fz = -Math.cos(c.h);
        const rx = P.x - c.x, rz = P.z - c.z;
        const lon = Math.abs(rx * fx + rz * fz), lat = Math.abs(rx * -fz + rz * fx);
        if (lon < 4.6 && lat < 2.4) {
          if (c.kind === 'civilian' && !c.panicMode) {
            this.panicCar(c);
            this.lastRam = g.elapsed;
          }
          if (c.kind === 'civilian') c.v = Math.max(0, c.v - 4);
        }
      }
    }

    // heights + sync
    for (const c of this.sim.cars) {
      const d = c.data as CarData | null;
      if (!d) continue;
      const dd = dist2(c.x, c.z, P.x, P.z);
      if (dd < 150 * 150 || (this.frame + c.id) % 3 === 0) d.y = groundY(g, c.x, c.z, d.y);
      if (d.hazard > 0) d.hazard -= dt;
      this.sync(c);
    }

    // density management
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && P.ok) {
      this.spawnTimer = 0.5;
      const T = TRAFFIC_TUNING;
      const w = this.localWeight(P.x, P.z, T.radius);
      const tod = trafficTimeFactor(hourOfDay(g));
      this.targetCount = Math.round(Math.max(T.minCars * tod, Math.min(T.maxCars, (w / T.metersPerCar) * tod)) * T.density);
      // despawn
      for (let i = this.sim.cars.length - 1; i >= 0; i--) {
        const c = this.sim.cars[i];
        if (c.kind !== 'civilian') continue;
        const dd = Math.sqrt(dist2(c.x, c.z, P.x, P.z));
        const y = (c.data as CarData | null)?.y ?? 0;
        if (dd > T.despawnRadius || (c.dead && (dd > 120 || !visibleToCamera(g, c.x, y, c.z, 200, false)))) this.removeCar(c);
      }
      const n = this.civilianCount();
      if (n > this.targetCount + 4) {
        // thin out far, invisible cars
        for (const c of this.sim.cars) {
          if (c.kind !== 'civilian') continue;
          const y = (c.data as CarData | null)?.y ?? 0;
          if (dist2(c.x, c.z, P.x, P.z) > 200 * 200 && !visibleToCamera(g, c.x, y, c.z, 400, false)) { this.removeCar(c); break; }
        }
      }
      let spawns = this.initialFill ? 60 : 2;
      while (this.civilianCount() < this.targetCount && spawns-- > 0) {
        if (!this.trySpawn(P)) break;
      }
      this.initialFill = false;
    }
  }

  /** Remove everything (reset). */
  clear(kind?: 'civilian' | 'police') {
    for (const c of [...this.sim.cars]) if (!kind || c.kind === kind) this.removeCar(c);
  }
}

function hashSeed(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
