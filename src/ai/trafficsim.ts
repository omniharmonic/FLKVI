// Kinematic lane traffic: IDM car following, signals, stop signs / yield, Bezier junction turns,
// pull-over for sirens, player blocking reactions. Pure logic (no three.js) — tests run it under node.
import { signalState } from '../core/signals.ts';
import { idmAccel, stepSpeed, canStopComfortably, IDM_DEFAULT, IDM_POLICE, type IdmParams } from './idm.ts';
import { RoadNet, samplePoly, type Poly, type Sample, type NetEdge } from './roadnet.ts';
import { SpatialHash } from './spatial.ts';

export type ObstacleKind = 'car' | 'player' | 'playerCar' | 'ped' | 'vehicle';

export interface Obstacle {
  x: number;
  z: number;
  /** heading (0 = -Z, clockwise) */
  h: number;
  v: number;
  /** half length along heading (cars) or radius */
  r: number;
  kind: ObstacleKind;
  car?: Car;
}

export type CarMode = 'lane' | 'free' | 'parked';

export class Car {
  x = 0; z = 0; h = 0; v = 0;
  mode: CarMode = 'lane';
  leg: 'lane' | 'turn' = 'lane';
  e = 0; lane = 0; s = 0;
  next = -1; nextLane = 0;
  turn: Poly | null = null;
  ts = 0;
  turnNode = -1;
  turnV = 99;
  /** police route (graph node ids) followed in lane mode */
  route: number[] | null = null;
  routeIdx = 0;
  v0Mul = 1;
  latOff = 0;
  latTarget = 0;
  stopWait = 0;
  stoppedAtLine = false;
  stuck = 0;
  ghost = 0;
  sirens = false;
  panic = 0;
  panicMode: 'flee' | 'stop' | null = null;
  blockedBy: ObstacleKind | null = null;
  blockedTime = 0;
  honkCd = 0;
  swerve = 0;
  pullOver = 0;
  /** extra desired-speed cap set by AI owners (police search etc.) */
  speedCap = Infinity;
  /** Curbside maneuvers: 'in' = pulling over to park, 'parked' = stopped at the curb, 'out' = waiting to pull out. */
  curb: 'in' | 'parked' | 'out' | null = null;
  curbT = 0;
  curbHold = false;
  /** turn-signal intent for visuals: -1 left, 1 right, 0 none */
  signal = 0;
  /** half length */
  halfLen = 2.3;
  /** marked for removal by the owner (dead end etc.) */
  dead = false;
  /** last distance to the stop line / control state (debug) */
  control = '';
  /** true once the car has reached the end of its route */
  arrived = false;
  /** acceleration used this step (for brake lights) */
  acc = 0;
  params: IdmParams = IDM_DEFAULT;
  obs: Obstacle | null = null;
  /** owner data (vehicle handle etc.) */
  data: any = null;
  id: number;
  kind: 'civilian' | 'police';
  rnd: () => number;
  constructor(id: number, kind: 'civilian' | 'police', rnd: () => number) {
    this.id = id; this.kind = kind; this.rnd = rnd;
    this.v0Mul = 0.85 + rnd() * 0.3;
  }
}

export interface SimHooks {
  /** Car wants to honk. */
  honk?(car: Car): void;
  /** Car reached the end of its route. */
  routeEnd?(car: Car): void;
}

const tmpS: Sample = { x: 0, z: 0, h: 0 };

export class TrafficSim {
  cars: Car[] = [];
  hash = new SpatialHash<Obstacle>(20);
  /** cars currently inside each junction (turn leg) */
  occupants = new Map<number, Set<Car>>();
  time = 0;
  private nextId = 1;
  hooks: SimHooks = {};
  /** counters for tests / debugging */
  stats = { redViolations: 0, transitions: 0 };

  net: RoadNet;
  rnd: () => number;
  constructor(net: RoadNet, rnd: () => number) { this.net = net; this.rnd = rnd; }

  /** Place a new car on edge e / lane at arc length s. */
  addCar(kind: 'civilian' | 'police', e: number, lane: number, s: number): Car {
    const c = new Car(this.nextId++, kind, this.rnd);
    if (kind === 'police') c.params = IDM_POLICE;
    this.placeOnLane(c, e, lane, s);
    this.cars.push(c);
    return c;
  }

  placeOnLane(c: Car, e: number, lane: number, s: number) {
    const E = this.net.edges[e];
    c.mode = 'lane';
    c.leg = 'lane';
    c.e = e;
    c.lane = Math.max(0, Math.min(E.dirLanes - 1, lane));
    c.s = Math.max(this.net.laneStart(E), Math.min(this.net.laneEnd(E) - 0.1, s));
    c.turn = null;
    this.planNext(c);
    this.samplePos(c);
  }

  removeCar(c: Car) {
    this.leaveJunction(c);
    const i = this.cars.indexOf(c);
    if (i >= 0) this.cars.splice(i, 1);
  }

  /** Switch a free-driving car back onto the nearest lane (returns false if no lane nearby). */
  attachToLane(c: Car, maxDist = 8): boolean {
    const r = this.net.nearestLane(c.x, c.z, 30, c.h);
    if (!r || r.d > maxDist) return false;
    const E = this.net.edges[r.e];
    const sm = samplePoly(this.net.lanePoly(E, r.lane), r.s);
    // lateral offset of the car relative to the lane (right normal of heading h is (cos h, sin h))
    const off = (c.x - sm.x) * Math.cos(sm.h) + (c.z - sm.z) * Math.sin(sm.h);
    this.placeOnLane(c, r.e, r.lane, Math.min(Math.max(r.s, this.net.laneStart(E)), this.net.laneEnd(E) - 0.2));
    c.latOff = Math.max(-4, Math.min(4, off));
    c.latTarget = 0;
    return true;
  }

  private planNext(c: Car) {
    const E = this.net.edges[c.e];
    let n = -1;
    if (c.route) {
      // find current position of E.to in the route
      let idx = c.route.indexOf(E.to, Math.max(0, c.routeIdx - 1));
      if (idx < 0) idx = c.route.indexOf(E.to);
      if (idx >= 0 && idx < c.route.length - 1) {
        c.routeIdx = idx;
        const want = c.route[idx + 1];
        const cand = this.net.nodes[E.to].out.find((i) => this.net.edges[i].to === want);
        if (cand !== undefined) n = cand;
      } else if (idx === c.route.length - 1) {
        c.arrived = true;
      }
    }
    if (n < 0) n = this.net.chooseNext(E, c.rnd);
    c.next = n;
    c.nextLane = n >= 0 ? this.net.targetLane(E, c.lane, this.net.edges[n]) : 0;
    if (n >= 0) {
      const tp = this.net.turnPoly(E, c.lane, this.net.edges[n], c.nextLane);
      c.turnV = this.net.turnSpeed(tp, this.net.edges[n].speed);
    }
  }

  leaveJunction(c: Car) {
    if (c.turnNode >= 0) {
      this.occupants.get(c.turnNode)?.delete(c);
      c.turnNode = -1;
    }
  }

  private samplePos(c: Car) {
    const E = this.net.edges[c.e];
    if (c.leg === 'lane') samplePoly(this.net.lanePoly(E, c.lane), c.s, tmpS);
    else samplePoly(c.turn!, c.ts, tmpS);
    c.h = tmpS.h;
    c.x = tmpS.x + Math.cos(tmpS.h) * c.latOff;
    c.z = tmpS.z + Math.sin(tmpS.h) * c.latOff;
  }

  /** Point on the car's planned path d meters ahead (lateral offset applied). */
  pathAhead(c: Car, d: number, out: Sample): Sample {
    const E = this.net.edges[c.e];
    if (c.leg === 'lane') {
      const end = this.net.laneEnd(E);
      const rem = end - c.s;
      if (d <= rem || c.next < 0) samplePoly(this.net.lanePoly(E, c.lane), Math.min(c.s + d, end), out);
      else {
        const N = this.net.edges[c.next];
        const tp = this.net.turnPoly(E, c.lane, N, c.nextLane);
        const d2 = d - rem;
        if (d2 <= tp.len) samplePoly(tp, d2, out);
        else samplePoly(this.net.lanePoly(N, c.nextLane), this.net.laneStart(N) + d2 - tp.len, out);
      }
    } else {
      const rem = c.turn!.len - c.ts;
      if (d <= rem) samplePoly(c.turn!, c.ts + d, out);
      else {
        const N = this.net.edges[c.next];
        samplePoly(this.net.lanePoly(N, c.nextLane), this.net.laneStart(N) + d - rem, out);
      }
    }
    out.x += Math.cos(out.h) * c.latOff;
    out.z += Math.sin(out.h) * c.latOff;
    return out;
  }

  /** Rebuild the obstacle hash: all cars + external obstacles (player, peds, other vehicles). */
  rebuild(external: Obstacle[]) {
    this.hash.clear();
    for (const c of this.cars) {
      const o = c.obs ?? (c.obs = { x: 0, z: 0, h: 0, v: 0, r: c.halfLen, kind: 'car', car: c });
      o.x = c.x; o.z = c.z; o.h = c.h; o.v = c.v;
      this.hash.insert(o);
    }
    for (const o of external) this.hash.insert(o);
  }

  /** Find the closest obstacle on the car's path: returns gap and leader speed along our heading. */
  private leader(c: Car, look: number): { gap: number; vl: number; kind: ObstacleKind | null; curb: boolean } {
    let best = Infinity, vl = 0, kind: ObstacleKind | null = null, curb = false;
    const fx = Math.sin(c.h), fz = -Math.cos(c.h);
    const cx = c.x + fx * look * 0.5, cz = c.z + fz * look * 0.5;
    const ahead: Sample = { x: 0, z: 0, h: 0 };
    const inJunction = c.leg === 'turn';
    this.hash.query(cx, cz, look * 0.5 + 4, (o) => {
      if (o.car === c) return;
      const rx = o.x - c.x, rz = o.z - c.z;
      const d = rx * fx + rz * fz;
      if (d <= 0.3 || d > look) return;
      let dh = Math.abs(o.h - c.h) % (Math.PI * 2);
      if (dh > Math.PI) dh = Math.PI * 2 - dh;
      const isCar = o.kind === 'car' || o.kind === 'vehicle' || o.kind === 'playerCar';
      if (c.ghost > 0 && o.kind === 'car') return;
      this.pathAhead(c, d, ahead);
      const lat = Math.hypot(o.x - ahead.x, o.z - ahead.z);
      // obstacle footprint: cars are long; widen threshold along their heading when crossing
      let rad = o.kind === 'ped' || o.kind === 'player' ? 0.45 : 1.05;
      if (isCar && dh > 0.6 && dh < Math.PI - 0.6) rad = Math.min(o.r, 1.05 + o.r * Math.sin(dh));
      if (lat > rad + (c.sirens ? 0.85 : 1.05)) return;
      if (isCar && dh > 0.9 && dh < Math.PI - 0.9 && o.car) {
        // crossing car: only matters if it is inside/entering the junction and we are not already committed
        if (inJunction && d > 7) return;
        if (o.car.leg !== 'turn' && d > 5) return;
      }
      const gap = d - c.halfLen - (isCar ? (dh < 0.9 || dh > Math.PI - 0.9 ? o.r : 1.0) : o.r);
      if (gap < best) {
        best = gap;
        vl = o.v * Math.cos(dh);
        kind = o.kind;
        curb = !!o.car && (o.car.curb === 'parked' || o.car.curb === 'in' || (o.car.curb === 'out' && o.car.v < 0.5));
      }
    });
    return { gap: best, vl, kind, curb };
  }

  step(dt: number, rateOf?: (c: Car) => number) {
    this.time += dt;
    for (const c of this.cars) {
      if (c.mode !== 'lane' || c.dead) continue;
      this.stepCar(c, dt);
    }
    void rateOf;
  }

  stepCar(c: Car, dt: number) {
    const net = this.net;
    const E = net.edges[c.e];
    c.honkCd = Math.max(0, c.honkCd - dt);
    c.ghost = Math.max(0, c.ghost - dt);
    c.panic = Math.max(0, c.panic - dt);
    if (c.panic <= 0) c.panicMode = null;
    c.swerve = Math.max(0, c.swerve - dt);
    c.pullOver = Math.max(0, c.pullOver - dt);

    // desired speed
    const police = c.kind === 'police';
    const siren = police && c.sirens;
    let v0 = (c.leg === 'lane' ? E.speed : Math.min(c.turnV, net.edges[c.next]?.speed ?? E.speed)) * c.v0Mul;
    if (siren) v0 = Math.min(34, Math.max(v0 * 1.55, 16));
    if (c.panicMode === 'flee') v0 *= 1.45;
    if (c.panicMode === 'stop') v0 = 0.01;
    if (c.pullOver > 0) v0 = Math.min(v0, 2.5);
    v0 = Math.min(v0, c.speedCap);
    c.signal = 0;
    if (c.curb) {
      c.curbT -= dt;
      if (c.curb === 'in') {
        v0 = Math.min(v0, 4);
        c.signal = 1;
        if (Math.abs(c.latOff - this.curbOffset(c)) < 0.25) { v0 = 0.01; if (c.v < 0.3) { c.curb = 'parked'; c.curbT = 6 + c.rnd() * 18; } }
      } else if (c.curb === 'parked') {
        v0 = 0.01;
        if (c.curbT <= 0) { c.curb = 'out'; c.curbHold = true; c.curbT = 1.2 + c.rnd() * 1.8; }
      } else {
        c.signal = -1;
        if (c.curbT > 0 || (c.v < 0.5 && this.approachingFromBehind(c))) { v0 = 0.01; c.curbHold = true; }
        else { c.curbHold = false; if (Math.abs(c.latOff) < 0.3) c.curb = null; }
      }
    }
    let gap = Infinity, vl = 0;
    c.control = '';

    if (c.leg === 'lane') {
      const end = net.laneEnd(E);
      const dEnd = end - c.s;
      // slow for the upcoming turn
      if (c.next >= 0 && dEnd < 60) {
        const vt = c.turnV * (siren ? 1.3 : 1);
        const vmax = Math.sqrt(vt * vt + 2 * c.params.b * 0.8 * Math.max(0, dEnd));
        v0 = Math.min(v0, vmax);
      }
      if (c.next < 0 && dEnd < 40) {
        // dead end with no way out: stop and let the owner recycle
        gap = Math.min(gap, dEnd);
        if (dEnd < 1 && c.v < 0.2) c.dead = true;
      }
      const N = net.nodes[E.to];
      const ignoreControls = siren || c.panicMode === 'flee';
      if (N.degree >= 3 && dEnd < 70) {
        const occ = this.occupants.get(N.id);
        let busy = false, merge = false;
        if (occ) for (const o of occ) {
          if (o === c || o.e === c.e) continue; // cars ahead from our own approach are followed via IDM
          busy = true;
          if (o.next === c.next) merge = true;
        }
        if (merge && dEnd < 8) gap = Math.min(gap, dEnd - 0.4);
        if (N.signal) {
          const st = signalState(N.id, N.axis, E.bearing, this.time);
          c.control = st;
          if (ignoreControls) {
            if (st !== 'green' && dEnd < 30) v0 = Math.min(v0, siren ? 11 : 14);
          } else if (st === 'red' || (st === 'yellow' && canStopComfortably(c.v, dEnd - 0.5, 4.5))) {
            if (!(st === 'yellow' && dEnd < 1.5)) gap = Math.min(gap, dEnd - 0.5);
          }
        } else if (N.stop || E.rank < N.maxRank || N.majorCount >= 3) {
          const mustStop = N.stop;
          c.control = mustStop ? 'stop' : 'yield';
          if (ignoreControls) {
            if (dEnd < 25) v0 = Math.min(v0, 12);
          } else {
            if (mustStop && !c.stoppedAtLine) {
              if (dEnd < 3.5 && c.v < 0.6) {
                c.stopWait += dt;
                if (c.stopWait > 0.9) c.stoppedAtLine = true;
              }
              gap = Math.min(gap, dEnd - 0.4);
            } else if (busy) {
              gap = Math.min(gap, dEnd - 0.4);
            } else if (E.rank < N.maxRank && dEnd < 18) {
              // minor road: creep and check the major road for approaching cars
              if (this.majorTrafficApproaching(c, N.id)) gap = Math.min(gap, dEnd - 0.4);
              else v0 = Math.min(v0, 7);
            } else if (dEnd < 18) {
              v0 = Math.min(v0, 8);
            }
          }
        }
      }
      // pre-claim the junction when about to enter so simultaneous arrivals serialize
      if (N.degree >= 3 && dEnd < 2.5 && gap > dEnd && c.turnNode !== N.id) {
        let set = this.occupants.get(N.id);
        if (!set) this.occupants.set(N.id, (set = new Set()));
        set.add(c);
        c.turnNode = N.id;
      }
    }

    // obstacles on the path
    const look = Math.max(18, Math.min(70, c.v * 3.2 + 14));
    const L = this.leader(c, look);
    c.blockedBy = null;
    if (L.gap < gap) {
      gap = L.gap; vl = L.vl;
      c.blockedBy = L.kind;
    }

    // player / blockage reactions
    if (c.blockedBy && c.v < 1 && gap < 8) {
      c.blockedTime += dt;
      const byPlayer = c.blockedBy === 'player' || c.blockedBy === 'playerCar';
      if (byPlayer && c.blockedTime > 1.2 && c.honkCd <= 0) {
        c.honkCd = 3 + c.rnd() * 4;
        this.hooks.honk?.(c);
      }
      if (L.curb && c.blockedTime > 1.2 && c.swerve <= 0 && c.leg === 'lane') c.swerve = 3.5; // go around a parked / double-parked car
      if (siren) {
        if (c.blockedTime > 0.8 && c.swerve <= 0) c.swerve = 3;
      } else if ((byPlayer && c.blockedTime > 4) || (c.blockedBy === 'vehicle' && c.blockedTime > 5)) {
        c.swerve = 5;
        c.blockedTime = 0;
      }
      if (c.blockedBy === 'car' && !police && c.blockedTime > 5 && c.honkCd <= 0 && (c.control === '' || c.control === 'green')) {
        c.honkCd = 5 + c.rnd() * 8;
        if (c.rnd() < 0.45) this.hooks.honk?.(c);
      }
      if (c.blockedBy === 'car' && (c.blockedTime > 9 && !c.control || (siren && c.blockedTime > 2.5))) {
        c.ghost = 2.5;
        c.blockedTime = 0;
      }
    } else if (!c.blockedBy) {
      c.blockedTime = 0;
    }
    if (c.v < 0.3 && gap < 3) c.stuck += dt; else c.stuck = 0;
    if (c.stuck > 25 && !c.control) c.dead = true; // hopeless jam: owner recycles out of view

    // lateral offset target
    if (c.swerve > 0 && c.leg === 'lane') c.latTarget = -(E.laneW + 0.9);
    else if ((c.pullOver > 0 && !police) || ((c.curb === 'in' || c.curb === 'parked' || (c.curb === 'out' && c.curbHold)) && c.leg === 'lane')) {
      c.latTarget = this.curbOffset(c);
    } else if (siren && c.leg === 'lane' && c.next >= 0 && net.laneEnd(E) - c.s < 24) {
      // racing line: drift to the inside of the coming turn (sirens use the whole road)
      const ta = net.turnAngle(E, net.edges[c.next]);
      c.latTarget = Math.abs(ta) > 0.5 ? Math.sign(ta) * Math.min(E.laneW * 0.85, 2.4) : 0;
    } else c.latTarget = 0;
    if (!c.signal && c.leg === 'lane' && c.next >= 0 && !siren) {
      const dEnd = net.laneEnd(E) - c.s;
      if (dEnd < 32) { const ta = net.turnAngle(E, net.edges[c.next]); if (Math.abs(ta) > 0.55) c.signal = ta > 0 ? 1 : -1; }
    }
    const latRate = 1.6 * Math.min(1, 0.3 + c.v / 4);
    const dl = c.latTarget - c.latOff;
    c.latOff += Math.sign(dl) * Math.min(Math.abs(dl), latRate * dt);

    const acc = idmAccel(c.v, Math.max(0.01, v0), gap, c.v - vl, c.params);
    c.acc = acc;
    c.v = stepSpeed(c.v, acc, dt);
    if (gap < 0.2 && c.v > 0) c.v = Math.max(0, Math.min(c.v, gap / dt));
    this.advance(c, c.v * dt);
  }

  /** Lateral offset that puts the car against the curb (right side). */
  curbOffset(c: Car): number {
    const E = this.net.edges[c.e];
    const laneOff = E.lane0 + c.lane * E.laneW;
    return Math.max(0.6, Math.min(2.4, Math.max(2.5, E.width / 2) - laneOff - 1.0));
  }

  /** Start a curbside stop (parallel park / delivery) if this spot allows it. */
  tryPark(c: Car): boolean {
    if (c.mode !== 'lane' || c.leg !== 'lane' || c.curb || c.kind !== 'civilian' || c.panicMode) return false;
    const E = this.net.edges[c.e];
    if (c.lane !== E.dirLanes - 1 || E.rank > 4) return false;
    const rem = this.net.laneEnd(E) - c.s;
    if (rem < 30 || c.s - this.net.laneStart(E) < 8) return false;
    c.curb = 'in';
    c.curbT = 0;
    return true;
  }

  /** Put a freshly spawned car at the curb, about to pull out. */
  startPullOut(c: Car) {
    c.curb = 'out';
    c.curbHold = true;
    c.curbT = 0.8 + c.rnd() * 2.5;
    c.latOff = this.curbOffset(c);
    c.v = 0;
    this.samplePos(c);
  }

  private approachingFromBehind(c: Car): boolean {
    let found = false;
    const fx = Math.sin(c.h), fz = -Math.cos(c.h);
    this.hash.query(c.x - fx * 14, c.z - fz * 14, 16, (o) => {
      if (found || o.car === c || !(o.kind === 'car' || o.kind === 'vehicle' || o.kind === 'playerCar')) return;
      const rel = (o.x - c.x) * fx + (o.z - c.z) * fz;
      if (rel < -1 && rel > -30 && o.v > 2) {
        let dh = Math.abs(o.h - c.h) % (Math.PI * 2);
        if (dh > Math.PI) dh = Math.PI * 2 - dh;
        if (dh < 0.6) found = true;
      }
    });
    return found;
  }

  private majorTrafficApproaching(c: Car, node: number): boolean {
    const N = this.net.nodes[node];
    let found = false;
    this.hash.query(N.x, N.z, 32, (o) => {
      if (found || !o.car || o.car === c) return;
      const oc = o.car;
      if (oc.mode !== 'lane' || oc.leg !== 'lane' || oc.v < 1.5) return;
      const oe = this.net.edges[oc.e];
      if (oe.to !== node || oe.rank <= this.net.edges[c.e].rank) return;
      const dEnd = this.net.laneEnd(oe) - oc.s;
      if (dEnd / Math.max(1, oc.v) < 4) found = true;
    });
    return found;
  }

  /** Move a lane-mode car forward by ds along its legs. */
  advance(c: Car, ds: number) {
    const net = this.net;
    let guard = 0;
    while (ds > 0 && guard++ < 6) {
      const E = net.edges[c.e];
      if (c.leg === 'lane') {
        const end = net.laneEnd(E);
        if (c.s + ds < end) { c.s += ds; ds = 0; break; }
        ds -= end - c.s;
        c.s = end;
        if (c.next < 0) { ds = 0; break; }
        // entering junction
        const N = net.nodes[E.to];
        if (N.signal && !c.sirens && c.panicMode !== 'flee') {
          const st = signalState(N.id, N.axis, E.bearing, this.time);
          if (st === 'red') this.stats.redViolations++;
        }
        c.turn = net.turnPoly(E, c.lane, net.edges[c.next], c.nextLane);
        c.leg = 'turn';
        c.ts = 0;
        if (c.turnNode !== E.to) {
          this.leaveJunction(c);
          let set = this.occupants.get(E.to);
          if (!set) this.occupants.set(E.to, (set = new Set()));
          set.add(c);
          c.turnNode = E.to;
        }
      } else {
        const rem = c.turn!.len - c.ts;
        if (ds < rem) { c.ts += ds; ds = 0; break; }
        ds -= rem;
        this.leaveJunction(c);
        const nE = net.edges[c.next];
        c.e = c.next;
        c.lane = c.nextLane;
        c.s = net.laneStart(nE);
        c.leg = 'lane';
        c.turn = null;
        c.stopWait = 0;
        c.stoppedAtLine = false;
        this.stats.transitions++;
        this.planNext(c);
        if (c.arrived && c.route) this.hooks.routeEnd?.(c);
      }
    }
    this.samplePos(c);
  }

  /** Give a lane-mode car a route (graph node ids); the car follows it at junctions. */
  setRoute(c: Car, route: number[] | null) {
    c.route = route && route.length > 1 ? route : null;
    c.routeIdx = 0;
    c.arrived = false;
    if (c.mode === 'lane' && c.leg === 'lane') this.planNext(c);
  }

  /** Edge lane at s: public sample for owners. */
  edge(c: Car): NetEdge { return this.net.edges[c.e]; }
}
