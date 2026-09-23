// Pedestrians: sidewalk-following walkers (road-graph sidewalks, crossings at junctions with signals),
// idling / benches, and reactions: notice ("?"), flee, or call the police (phone icon → 'witness').
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec2 } from '../core/types';
import { rng } from '../core/geo';
import { setShadowCascades } from '../render/shadowProxy';
import { signalState } from '../core/signals';
import { RoadNet, samplePoly, segIntersect, type Sample } from './roadnet';
import { CharacterFactory, Character } from './characters';
import { Icon } from './icons';
import { canSee, headingOf, angleDiff, playerTarget } from './perception';
import { StaticGrid, SpatialHash } from './spatial';
import type { Obstacle, TrafficSim } from './trafficsim';
import { groundY, hourOfDay, playerInfo, visibleToCamera, losClear, dist2, nightFactor, type PlayerInfo } from './util';

export const PED_TUNING = {
  maxPeds: 72,
  minPeds: 10,
  cullRadius: 150,
  spawnMin: 55,
  /** probability that a noticing ped calls the police (vs flee / ignore) */
  callChance: 0.45,
  fleeChance: 0.38,
  callTime: [4, 8] as [number, number],
  /** NPC sight range for crimes (m, daylight) */
  sightRange: 45,
  density: 1,
  /** walking together: chance a spawn is a pair (and that a pair is a trio) */
  groupChance: 0.26,
  trioChance: 0.3,
  /** daytime joggers */
  joggerChance: 0.07,
  /** per ped-second: cross mid-block (gap acceptance) / step into a shop */
  jaywalkRate: 0.005,
  shopEnterRate: 0.035,
  /** share of spawns that walk out of a shop door (fade in) / stand chatting in a cluster */
  shopExitShare: 0.16,
  chatShare: 0.1,
  /** at night (19–02 h) share of spawns placed near bars / restaurants */
  nightVenueShare: 0.45,
  /** idle peds on the phone */
  phoneIdleChance: 0.35,
  /** a takedown / crime / arrest in view: chance each witness raises a phone and films */
  filmChance: 0.38,
  /** filmers who kept the player in frame during a takedown post it (low-confidence witness report) */
  filmReportChance: 0.5,
  /** cars faster than this heading at a ped make them jump aside (m/s) */
  dodgeSpeed: 9,
};

const VENUES = /BAR|PUB|BREW|TAVERN|RESTAURANT|CAFE|COFFEE|PIZZA|TACO|SUSHI|RAMEN|DINER|CURRY|FOOD|ICE CREAM|GRILL|BURGER|THAI|NOODLE|BAKERY|DELI|WINE/;

interface Door { x: number; z: number; nx: number; nz: number; venue: boolean }

export function pedTimeFactor(h: number): number {
  if (h < 5) return 0.18;
  if (h < 7) return 0.18 + (h - 5) * 0.3;
  if (h < 10) return 0.9;
  if (h < 18) return 1.0;
  if (h < 21) return 0.7;
  return 0.35;
}

type PedState = 'walk' | 'wait' | 'cross' | 'idle' | 'toBench' | 'sit' | 'notice' | 'flee' | 'call' | 'watch' | 'fallen' | 'getup' | 'wander'
  | 'follow' | 'chat' | 'enter' | 'exit' | 'film' | 'stagger' | 'dodge';

const tmpS: Sample = { x: 0, z: 0, h: 0 };

// --- render LOD (perf): cull off-screen peds, cast shadows only near the camera, throttle skinning.
/** Peds closer than this stay drawn even off-screen (their shadows can fall into view). */
const PED_KEEP = 14;
/** Beyond this distance from the camera peds don't cast sun shadows. */
const PED_SHADOW = 32;
/** Beyond this distance peds aren't drawn at all (they're a few pixels tall, mostly occluded). */
const PED_DRAW = 120;
const pedMeshes = new WeakMap<Character, { meshes: THREE.Mesh[]; shadow: boolean }>();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sph = new THREE.Sphere();
function pedRenderLod(g: Game, ch: Character, camD2: number, inView: boolean, flagged = false): boolean {
  let st = pedMeshes.get(ch);
  if (!st) {
    const meshes: THREE.Mesh[] = [];
    ch.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.castShadow) meshes.push(o as THREE.Mesh); });
    st = { meshes, shadow: true };
    pedMeshes.set(ch, st);
    setShadowCascades(g, ch.root, 1); // peds only cast within PED_SHADOW: the near cascade covers that
  }
  const vis = camD2 < PED_KEEP * PED_KEEP || (inView && (flagged || camD2 < PED_DRAW * PED_DRAW));
  ch.root.visible = vis;
  const sh = camD2 < PED_SHADOW * PED_SHADOW;
  if (sh !== st.shadow) { st.shadow = sh; for (const m of st.meshes) m.castShadow = sh; }
  return vis;
}

export class Ped {
  x = 0; z = 0; y = 0; h = 0;
  v = 0;
  state: PedState = 'walk';
  seg = 0; side = 1; dir = 1; s = 0;
  lat = 0; // lateral offset within the sidewalk
  avoid = 0;
  // straight-line legs (corners, crossings, benches, fleeing)
  ax = 0; az = 0; bx = 0; bz = 0; legT = 0; legLen = 0;
  crossNode = -1; crossBearing = 0; crossWait = 0;
  timer = 0;
  walkSpeed = 1.35;
  sx = 0; sz = 0; // threat/stimulus source
  callSeenAt = -1e9; callP: Vec2 = [0, 0]; callCrimeP: Vec2 = [0, 0];
  cooldown = 0;
  bench = -1;
  prevState: PedState = 'walk';
  logicAcc = 0;
  animAcc = 0;
  obs: Obstacle;
  ch: Character;
  icon = new Icon();
  alive = true;
  /** walking group: followers mirror the leader at an offset */
  leader: Ped | null = null;
  followers: Ped[] = [];
  fLat = 0; fBack = 0;
  jogger = false;
  /** 0 invisible .. 1 opaque (shop doors); fadeDir -1 fading out, +1 in */
  fade = 1; fadeDir = 0;
  door = -1;
  jay = false; jaySide = 0; jayS = 0;
  /** filming: saw the player do something while recording */
  filmSus = false;
  dodgeCd = 0;
  chatWith: Ped[] = [];
  constructor(public id: number, ch: Character) {
    this.ch = ch;
    this.ch.root.add(this.icon.sprite);
    this.icon.sprite.position.set(0, 2.25, 0);
    this.obs = { x: 0, z: 0, h: 0, v: 0, r: 0.4, kind: 'ped' };
  }
}

interface Bench { x: number; z: number; rot: number; used: boolean }

export class PedSystem {
  peds: Ped[] = [];
  private pool: Ped[] = [];
  group = new THREE.Group();
  factory: CharacterFactory;
  private rnd = rng(9001);
  private nextId = 1;
  private frame = 0;
  private spawnTimer = 0;
  private benches: Bench[] = [];
  private benchGrid = new StaticGrid(32);
  private bldGrid = new StaticGrid(64);
  private commercial: { x: number; z: number }[] = [];
  private doors: Door[] = [];
  private doorGrid = new StaticGrid(24);
  hash = new SpatialHash<Ped>(8);
  targetCount = 0;
  obstacles: Obstacle[] = [];
  private initial = true;
  private suspTimer = 0;
  enabled: boolean;

  constructor(private g: Game, private net: RoadNet, private sim: TrafficSim | null, factory: CharacterFactory) {
    this.factory = factory;
    this.group.name = 'ai-peds';
    g.scene.add(this.group);
    for (const p of g.recipe.props) {
      if (p.type !== 'bench') continue;
      const b: Bench = { x: p.p[0], z: p.p[1], rot: p.rot, used: false };
      this.benchGrid.addBox(this.benches.length, b.x, b.z, b.x, b.z);
      this.benches.push(b);
    }
    for (const b of g.recipe.buildings) {
      if (!['commercial', 'mixed-use', 'office', 'civic'].includes(b.use)) continue;
      let cx = 0, cz = 0;
      for (const q of b.footprint) { cx += q[0]; cz += q[1]; }
      cx /= b.footprint.length; cz /= b.footprint.length;
      this.bldGrid.addBox(this.commercial.length, cx, cz, cx, cz);
      this.commercial.push({ x: cx, z: cz });
    }
    // shop doors: middle of each street-facing storefront edge, nudged outside the wall
    for (const b of g.recipe.buildings) {
      if (!b.storefront || !b.streetEdges?.length) continue;
      const fp = b.footprint;
      let cx = 0, cz = 0;
      for (const q of fp) { cx += q[0]; cz += q[1]; }
      cx /= fp.length; cz /= fp.length;
      const venue = !!b.signage && VENUES.test(b.signage);
      for (const ei of b.streetEdges.slice(0, 2)) {
        const a = fp[ei], c = fp[(ei + 1) % fp.length];
        if (!a || !c) continue;
        const ex = c[0] - a[0], ez = c[1] - a[1];
        const el = Math.hypot(ex, ez);
        if (el < 4) continue;
        let nx = ez / el, nz = -ex / el;
        const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
        if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
        const d: Door = { x: mx + nx * 0.45, z: mz + nz * 0.45, nx, nz, venue };
        this.doorGrid.addBox(this.doors.length, d.x, d.z, d.x, d.z);
        this.doors.push(d);
      }
    }
    this.enabled = net.peds.length > 0 || !!(g as any).world?.randomSidewalkPoint;

    g.events.on('noise', (e) => this.onStimulus(e.p, e.radius, e.kind, false));
    g.events.on('crime', (e) => this.onCrime(e.p, e.severity, e.kind));
    g.events.on('playerMelee', (e) => this.onMelee(e.p, e.dir, e.range));
    g.events.on('takedownStart', () => { const P = playerInfo(g); if (P.ok) this.startFilming([P.x, P.z], 45, 1, true); });
    g.events.on('takedown', (e) => this.startFilming(e.p, 50, 0.8, true));
    g.events.on('arrested', () => { const P = playerInfo(g); if (P.ok) this.startFilming([P.x, P.z], 55, 1.3, false); });
  }

  // ------------------------------------------------------------------ spawning

  private acquire(): Ped {
    let p = this.pool.pop();
    if (!p) {
      const ch = this.factory.create('civilian', Math.floor(this.rnd() * 1e6));
      p = new Ped(this.nextId++, ch);
    }
    p.alive = true;
    p.state = 'walk';
    p.icon.set(null);
    p.cooldown = 0;
    p.bench = -1;
    p.ch.setFallen(false);
    p.ch.fallT = 0; p.ch.pivot.rotation.x = 0; p.ch.pivot.position.y = 0;
    p.walkSpeed = 1.15 + this.rnd() * 0.45;
    p.lat = (this.rnd() - 0.5) * 1.0;
    this.group.add(p.ch.root);
    this.peds.push(p);
    return p;
  }

  private release(p: Ped) {
    if (p.bench >= 0) this.benches[p.bench].used = false;
    p.alive = false;
    this.group.remove(p.ch.root);
    const i = this.peds.indexOf(p);
    if (i >= 0) this.peds.splice(i, 1);
    this.pool.push(p);
  }

  private trySpawn(P: PlayerInfo): boolean {
    const T = PED_TUNING;
    const segs = [...this.net.pedGrid.query(P.x, P.z, T.cullRadius)];
    for (let k = 0; k < 6; k++) {
      let sx: number, sz: number;
      let segI = -1, side = 0, s = 0;
      if (segs.length) {
        segI = segs[Math.floor(this.rnd() * segs.length)];
        const ps = this.net.peds[segI];
        if (!ps.hasSidewalk && this.rnd() < 0.7) continue;
        side = ps.sides[Math.floor(this.rnd() * ps.sides.length)];
        const poly = this.net.pedPoly(ps, side);
        s = ps.trimA + this.rnd() * Math.max(0, poly.len - ps.trimA - ps.trimB);
        samplePoly(poly, s, tmpS);
        sx = tmpS.x; sz = tmpS.z;
      } else {
        const pt = (this.g as any).world?.randomSidewalkPoint?.([P.x, P.z], T.cullRadius, this.rnd) as Vec2 | null;
        if (!pt) return false;
        sx = pt[0]; sz = pt[1];
      }
      const d = Math.hypot(sx - P.x, sz - P.z);
      if (d > T.cullRadius - 5) continue;
      const y = groundY(this.g, sx, sz);
      if (!this.initial) {
        if (d < 30) continue;
        if (d < T.spawnMin + 30 && visibleToCamera(this.g, sx, y, sz, T.spawnMin + 30, true)) continue;
      } else if (d < 6) continue;
      const p = this.acquire();
      p.x = sx; p.z = sz; p.y = y;
      if (segI >= 0) {
        p.seg = segI; p.side = side; p.s = s; p.dir = this.rnd() < 0.5 ? 1 : -1;
        p.state = 'walk';
      } else {
        p.state = 'wander';
        this.pickWander(p);
      }
      p.ch.play('walk', 0);
      p.ch.mixer.setTime(this.rnd() * 2);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ navigation

  private pickWander(p: Ped) {
    const w = (this.g as any).world;
    const pt = w?.randomSidewalkPoint?.([p.x, p.z], 40, this.rnd) as Vec2 | null;
    const y = p.y + 1.2;
    if (pt && losClear(this.g, [p.x, y, p.z], [pt[0], y, pt[1]])) {
      this.setLeg(p, pt[0], pt[1]);
    } else {
      const a = this.rnd() * Math.PI * 2;
      this.setLeg(p, p.x + Math.sin(a) * 8, p.z - Math.cos(a) * 8);
    }
  }

  private setLeg(p: Ped, bx: number, bz: number) {
    p.ax = p.x; p.az = p.z; p.bx = bx; p.bz = bz; p.legT = 0;
    p.legLen = Math.max(0.01, Math.hypot(bx - p.x, bz - p.z));
  }

  /** Snap a ped back onto the nearest sidewalk after fleeing/sitting. */
  private resumeWalking(p: Ped) {
    let best = -1, bs = 0, bside = 1, bd = Infinity;
    for (const si of this.net.pedGrid.query(p.x, p.z, 40)) {
      const ps = this.net.peds[si];
      for (const side of ps.sides) {
        const poly = this.net.pedPoly(ps, side);
        // coarse projection
        for (let i = 0; i < poly.xs.length - 1; i++) {
          const ax = poly.xs[i], az = poly.zs[i], dx = poly.xs[i + 1] - ax, dz = poly.zs[i + 1] - az;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.z - az) * dz) / l2));
          const d = dist2(p.x, p.z, ax + dx * t, az + dz * t);
          if (d < bd) { bd = d; best = si; bside = side; bs = poly.cum[i] + (poly.cum[i + 1] - poly.cum[i]) * t; }
        }
      }
    }
    if (best < 0) { p.state = 'wander'; this.pickWander(p); return; }
    const ps = this.net.peds[best];
    p.seg = best; p.side = bside;
    p.s = Math.max(ps.trimA, Math.min(ps.center.len - ps.trimB, bs));
    p.dir = this.rnd() < 0.5 ? 1 : -1;
    const poly = this.net.pedPoly(ps, bside);
    samplePoly(poly, p.s, tmpS);
    // walk (straight) back to the sidewalk first
    p.state = 'walk';
    if (Math.sqrt(bd) > 1.5) {
      this.setLeg(p, tmpS.x, tmpS.z);
      p.prevState = 'walk';
      p.state = 'toBench'; // reuse straight-leg walking; bench=-1 means "return to sidewalk"
      p.bench = -1;
    }
  }

  /** At the end of a sidewalk segment: choose the next segment (corner or crossing). */
  private chooseNext(p: Ped) {
    const net = this.net;
    const ps = net.peds[p.seg];
    const node = p.dir > 0 ? ps.b : ps.a;
    const nd = net.nodes[node];
    const ax = p.x, az = p.z;
    const opts: { seg: number; side: number; dir: number; s: number; x: number; z: number; w: number; cross: number; bearing: number }[] = [];
    // arms for crossing detection
    const arms: { x0: number; z0: number; x1: number; z1: number; bearing: number }[] = [];
    for (const si of net.nodePeds[node]) {
      const q = net.peds[si];
      if (q.off === 0) continue;
      const poly = q.center;
      const L = Math.min(poly.len, (net.pedRadius[node] || 6) + 8);
      const sp = samplePoly(poly, q.a === node ? L : poly.len - L);
      arms.push({ x0: nd.x, z0: nd.z, x1: sp.x, z1: sp.z, bearing: Math.atan2(sp.z - nd.z, sp.x - nd.x) });
    }
    for (const si of net.nodePeds[node]) {
      const q = net.peds[si];
      for (const side of q.sides) {
        if (si === p.seg && side === p.side) continue;
        const poly = net.pedPoly(q, side);
        const start = q.a === node;
        const s = start ? q.trimA : poly.len - q.trimB;
        samplePoly(poly, s, tmpS);
        let crossings = 0, bearing = 0;
        for (const a of arms) {
          if (segIntersect(ax, az, tmpS.x, tmpS.z, a.x0, a.z0, a.x1, a.z1)) { crossings++; bearing = a.bearing; }
        }
        if (crossings > 1) continue;
        const outH = start ? tmpS.h : tmpS.h + Math.PI;
        const turn = Math.abs(angleDiff(outH, p.h));
        let w = crossings ? (nd.degree >= 3 ? 1.1 : 0.25) : turn < 0.5 ? 3 : 1.4;
        if (!q.hasSidewalk) w *= 0.3;
        if (q.cls === 'footway' || q.cls === 'pedestrian') w *= 1.2;
        opts.push({ seg: si, side, dir: start ? 1 : -1, s, x: tmpS.x, z: tmpS.z, w, cross: crossings, bearing });
      }
    }
    if (!opts.length) {
      // dead end: turn around
      p.dir = -p.dir;
      return;
    }
    let tot = 0;
    for (const o of opts) tot += o.w;
    let r = this.rnd() * tot;
    let pick = opts[0];
    for (const o of opts) { r -= o.w; if (r <= 0) { pick = o; break; } }
    p.seg = pick.seg; p.side = pick.side; p.dir = pick.dir; p.s = pick.s;
    this.setLeg(p, pick.x, pick.z);
    if (pick.cross) {
      p.state = 'wait';
      p.crossNode = nd.signal ? node : -1;
      p.crossBearing = pick.bearing;
      p.crossWait = 0;
    } else {
      p.state = 'cross'; // corner walk (short straight leg, no waiting)
      p.crossNode = -2;
    }
  }

  private safeToCross(p: Ped): boolean {
    if (p.crossNode >= 0) {
      const nd = this.net.nodes[p.crossNode];
      // walk when the traffic on the road we cross is red
      return signalState(nd.id, nd.axis, p.crossBearing, this.g.elapsed) === 'red';
    }
    if (!this.sim) return true;
    const mx = (p.ax + p.bx) / 2, mz = (p.az + p.bz) / 2;
    let clear = true;
    this.sim.hash.query(mx, mz, 26, (o) => {
      if (!clear || o.kind === 'ped' || o.kind === 'player') return;
      if (o.v < 1) { if (dist2(o.x, o.z, mx, mz) < 36) clear = false; return; }
      // approaching?
      const fx = Math.sin(o.h), fz = -Math.cos(o.h);
      if ((mx - o.x) * fx + (mz - o.z) * fz > -3) clear = false;
    });
    return clear;
  }

  // ------------------------------------------------------------------ reactions

  private notice(p: Ped, sx: number, sz: number, crime: boolean) {
    if (p.state === 'fallen' || p.state === 'getup' || p.state === 'call' || p.state === 'flee' || p.cooldown > 0) return;
    if (p.bench >= 0) { this.benches[p.bench].used = false; p.bench = -1; }
    p.sx = sx; p.sz = sz;
    p.callCrimeP = [sx, sz];
    p.state = 'notice';
    p.timer = 0.7 + this.rnd() * 0.9;
    p.prevState = crime ? 'call' : 'watch';
    p.icon.set('notice');
    p.ch.play('idle', 0.2);
  }

  private onStimulus(pt: Vec2, radius: number, kind: string, crime: boolean) {
    if (/siren|horn|engine|footstep|helicopter/.test(kind)) return;
    const r = Math.min(radius, 90);
    let n = 0;
    this.hash.query(pt[0], pt[1], r, (p) => {
      if (n++ > 16) return;
      this.notice(p, pt[0], pt[1], crime);
    });
  }

  private onCrime(pt: Vec2, severity: number, kind: string) {
    const r = PED_TUNING.sightRange * (1 + severity * 0.1);
    const cands: Ped[] = [];
    this.hash.query(pt[0], pt[1], r, (p) => cands.push(p));
    cands.sort((a, b) => dist2(a.x, a.z, pt[0], pt[1]) - dist2(b.x, b.z, pt[0], pt[1]));
    const y = groundY(this.g, pt[0], pt[1]) + 1.2;
    for (const p of cands.slice(0, 12)) {
      const eye: [number, number, number] = [p.x, p.y + 1.6, p.z];
      // witnesses notice crimes in a wide cone (people look around at crashes, shouting)
      if (canSee({ pos: eye, dir: p.h, fovDeg: 240, range: r }, [pt[0], y, pt[1]], this.g)) this.notice(p, pt[0], pt[1], true);
    }
    // assault / vehicle hit directly on a ped
    if (kind === 'assault') {
      let hit: Ped | null = null, bd = 2.5 * 2.5;
      for (const p of cands) { const d = dist2(p.x, p.z, pt[0], pt[1]); if (d < bd) { bd = d; hit = p; } }
      if (hit) this.knockDown(hit, hit.x - pt[0], hit.z - pt[1], 2);
    }
  }

  /** Player punch/shove: knock down peds in range in front of the player, report an assault. */
  private onMelee(pt: Vec2, dir: Vec2, range: number) {
    const dl = Math.hypot(dir[0], dir[1]) || 1;
    const fx = dir[0] / dl, fz = dir[1] / dl;
    let hit: Ped | null = null;
    this.hash.query(pt[0], pt[1], range + 0.5, (p) => {
      if (p.state === 'fallen') return;
      const rx = p.x - pt[0], rz = p.z - pt[1];
      const d = Math.hypot(rx, rz);
      if (d > 0.3 && (rx * fx + rz * fz) / d < 0.3) return;
      this.knockDown(p, fx, fz, 1.5);
      hit = p;
    });
    if (hit) this.g.events.emit('crime', { kind: 'assault', p: [(hit as Ped).x, (hit as Ped).z], severity: 2 });
  }

  /** Ped is hit: falls (ragdoll-lite), lies, gets up and flees. */
  knockDown(p: Ped, dx: number, dz: number, impulse: number) {
    if (p.state === 'fallen') return;
    if (p.bench >= 0) { this.benches[p.bench].used = false; p.bench = -1; }
    const l = Math.hypot(dx, dz) || 1;
    // fall away from the impact
    const away = headingOf(dx / l, dz / l);
    const facingAway = Math.abs(angleDiff(p.h, away)) < Math.PI / 2;
    p.ch.setFallen(true, !facingAway);
    p.state = 'fallen';
    p.timer = 3 + this.rnd() * 2.5;
    p.icon.set(null);
    p.ch.play('idle', 0.1);
    // knockback slide
    this.setLeg(p, p.x + (dx / l) * Math.min(4, impulse), p.z + (dz / l) * Math.min(4, impulse));
    p.sx = p.x - dx; p.sz = p.z - dz;
  }

  private startFlee(p: Ped, sx: number, sz: number) {
    p.state = 'flee';
    p.sx = sx; p.sz = sz;
    p.timer = 7 + this.rnd() * 5;
    p.icon.set('alarm');
    p.ch.play('run', 0.2);
    this.pickFleeLeg(p);
  }

  private pickFleeLeg(p: Ped) {
    const base = headingOf(p.x - p.sx, p.z - p.sz);
    const y = p.y + 1.0;
    for (const off of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6]) {
      const h = base + off;
      const L = 14;
      const tx = p.x + Math.sin(h) * L, tz = p.z - Math.cos(h) * L;
      if (losClear(this.g, [p.x, y, p.z], [tx, y, tz])) { this.setLeg(p, tx, tz); return; }
    }
    this.setLeg(p, p.x + Math.sin(base) * 4, p.z - Math.cos(base) * 4);
  }

  private startCall(p: Ped) {
    p.state = 'call';
    const [a, b] = PED_TUNING.callTime;
    p.timer = a + this.rnd() * (b - a);
    p.icon.set('phone');
    p.ch.play('phone', 0.35);
    p.callSeenAt = -1e9;
  }

  private finishCall(p: Ped, P: PlayerInfo) {
    const g = this.g;
    const recent = g.elapsed - p.callSeenAt < 3.5;
    if (recent) {
      const day = 1 - nightFactor(g);
      const d = Math.hypot(p.callP[0] - p.x, p.callP[1] - p.z);
      const conf = Math.max(0.5, Math.min(0.8, 0.5 + 0.2 * day + (d < 20 ? 0.1 : 0)));
      g.events.emit('witness', { source: 'npc', p: [p.callP[0], p.callP[1]], confidence: conf, delay: 0, sourceId: `ped${p.id}` });
      g.events.emit('playerSpotted', { by: 'npc' });
    } else {
      // lost sight: vague report → investigating unit only
      g.events.emit('witness', { source: 'npc', p: [p.callCrimeP[0], p.callCrimeP[1]], confidence: 0.35, delay: 0, sourceId: `ped${p.id}` });
    }
    void P;
    p.icon.set(null);
    p.state = 'watch';
    p.timer = 3 + this.rnd() * 4;
    p.cooldown = 25;
    p.ch.play('idle', 0.4);
  }

  // ------------------------------------------------------------------ per-ped update

  private updatePed(p: Ped, dt: number, P: PlayerInfo) {
    const g = this.g;
    p.cooldown = Math.max(0, p.cooldown - dt);
    let moveSpeed = 0;
    let targetH = p.h;

    // hit by the player's car
    if (P.inVehicle && P.vehicle && p.state !== 'fallen' && Math.abs(P.vehicle.speed) > 2.5) {
      const vh = P.vehicle.heading;
      const fx = Math.sin(vh), fz = -Math.cos(vh);
      const rx = p.x - P.x, rz = p.z - P.z;
      const lon = rx * fx + rz * fz, lat = rx * -fz + rz * fx;
      if (Math.abs(lon) < 2.6 && Math.abs(lat) < 1.25) {
        const sp = Math.abs(P.vehicle.speed);
        this.knockDown(p, fx * Math.sign(P.vehicle.speed) + lat * 0.3, fz * Math.sign(P.vehicle.speed), sp * 0.35);
        g.events.emit('crime', { kind: 'vehicle-hit', p: [p.x, p.z], severity: sp > 12 ? 4 : 3 });
        (g as any).audio?.play?.('crash', { at: [p.x, p.y + 1, p.z], volume: 0.5 });
      }
    }
    // bumped by the running player
    if (!P.inVehicle && p.state !== 'fallen' && P.speed > 5.5 && dist2(p.x, p.z, P.x, P.z) < 0.55) {
      this.knockDown(p, p.x - P.x, p.z - P.z, 1.2);
    }

    switch (p.state) {
      case 'walk': {
        const ps = this.net.peds[p.seg];
        const poly = this.net.pedPoly(ps, p.side);
        p.s += p.dir * p.walkSpeed * dt;
        moveSpeed = p.walkSpeed;
        const end = p.dir > 0 ? poly.len - ps.trimB : ps.trimA;
        if ((p.dir > 0 && p.s >= end) || (p.dir < 0 && p.s <= end)) {
          p.s = end;
          samplePoly(poly, p.s, tmpS);
          p.x = tmpS.x; p.z = tmpS.z;
          if (this.rnd() < 0.08) { p.state = 'idle'; p.timer = 2 + this.rnd() * 5; p.prevState = 'walk'; break; }
          this.chooseNext(p);
          break;
        }
        samplePoly(poly, p.s, tmpS);
        const h = p.dir > 0 ? tmpS.h : tmpS.h + Math.PI;
        // lateral: keep right when walking + avoidance
        const lat = p.lat + p.avoid;
        const rx = Math.cos(h), rz = Math.sin(h);
        p.x = tmpS.x + rx * lat;
        p.z = tmpS.z + rz * lat;
        targetH = h;
        // occasional stop / bench
        if (this.rnd() < dt * 0.012) { p.state = 'idle'; p.timer = 2 + this.rnd() * 6; p.prevState = 'walk'; }
        else if (this.benches.length && this.rnd() < dt * 0.05) this.tryBench(p);
        break;
      }
      case 'wander': {
        moveSpeed = p.walkSpeed;
        p.legT += moveSpeed * dt;
        const t = Math.min(1, p.legT / p.legLen);
        p.x = p.ax + (p.bx - p.ax) * t; p.z = p.az + (p.bz - p.az) * t;
        targetH = headingOf(p.bx - p.ax, p.bz - p.az);
        if (t >= 1) {
          if (this.rnd() < 0.3) { p.state = 'idle'; p.prevState = 'wander'; p.timer = 2 + this.rnd() * 5; }
          else this.pickWander(p);
        }
        break;
      }
      case 'wait': {
        p.crossWait += dt;
        targetH = headingOf(p.bx - p.x, p.bz - p.z);
        if (this.safeToCross(p) || p.crossWait > (p.crossNode >= 0 ? 40 : 12)) {
          p.state = 'cross';
          p.ax = p.x; p.az = p.z; p.legT = 0; p.legLen = Math.max(0.01, Math.hypot(p.bx - p.x, p.bz - p.z));
        }
        break;
      }
      case 'cross': {
        moveSpeed = p.crossNode === -2 ? p.walkSpeed : p.walkSpeed * 1.2;
        p.legT += moveSpeed * dt;
        const t = Math.min(1, p.legT / p.legLen);
        p.x = p.ax + (p.bx - p.ax) * t; p.z = p.az + (p.bz - p.az) * t;
        targetH = headingOf(p.bx - p.ax, p.bz - p.az);
        if (t >= 1) p.state = 'walk';
        break;
      }
      case 'toBench': {
        moveSpeed = p.walkSpeed;
        p.legT += moveSpeed * dt;
        const t = Math.min(1, p.legT / p.legLen);
        p.x = p.ax + (p.bx - p.ax) * t; p.z = p.az + (p.bz - p.az) * t;
        targetH = headingOf(p.bx - p.ax, p.bz - p.az);
        if (t >= 1) {
          if (p.bench >= 0) {
            p.state = 'sit';
            p.timer = 12 + this.rnd() * 30;
            p.ch.play('sit', 0.5);
          } else p.state = 'walk';
        }
        break;
      }
      case 'sit': {
        const b = this.benches[p.bench];
        if (b) targetH = b.rot;
        p.timer -= dt;
        if (p.timer <= 0) {
          if (b) b.used = false;
          p.bench = -1;
          this.resumeWalking(p);
        }
        break;
      }
      case 'idle':
      case 'watch': {
        p.timer -= dt;
        if (p.state === 'watch') targetH = headingOf(p.sx - p.x, p.sz - p.z);
        if (p.timer <= 0) {
          p.icon.set(null);
          if (p.prevState === 'wander') { p.state = 'wander'; this.pickWander(p); }
          else if (p.state === 'watch') this.resumeWalking(p);
          else p.state = 'walk';
          if (p.state === 'walk') {
            const ps = this.net.peds[p.seg];
            const poly = this.net.pedPoly(ps, p.side);
            const end = p.dir > 0 ? poly.len - ps.trimB : ps.trimA;
            if (Math.abs(p.s - end) < 0.05) this.chooseNext(p);
          }
        }
        break;
      }
      case 'notice': {
        targetH = headingOf(p.sx - p.x, p.sz - p.z);
        p.timer -= dt;
        if (p.timer <= 0) {
          const r = this.rnd();
          const crime = p.prevState === 'call';
          const callP = PED_TUNING.callChance * (crime ? 1 : 0.7) * (0.75 + 0.35 * (1 - nightFactor(g)));
          const nearPlayer = P.ok && dist2(p.x, p.z, P.x, P.z) < 6 * 6;
          if (r < callP && !nearPlayer) this.startCall(p);
          else if (r < callP + PED_TUNING.fleeChance || nearPlayer) this.startFlee(p, p.sx, p.sz);
          else { p.state = 'watch'; p.timer = 3 + this.rnd() * 4; p.icon.set(null); p.cooldown = 10; }
        }
        break;
      }
      case 'call': {
        p.timer -= dt;
        // keep an eye on the player while calling
        if (P.ok) {
          targetH = headingOf(P.x - p.x, P.z - p.z) + 0.6;
          const d2 = dist2(p.x, p.z, P.x, P.z);
          if (d2 < 3.2 * 3.2) {
            // intimidated: drop the call and run
            p.icon.set(null);
            this.startFlee(p, P.x, P.z);
            p.cooldown = 20;
            break;
          }
          if (d2 < 70 * 70 && ((this.frame + p.id) & 7) === 0) {
            const tgt = playerTarget(g);
            if (tgt && canSee({ pos: [p.x, p.y + 1.6, p.z], dir: headingOf(P.x - p.x, P.z - p.z), fovDeg: 180, range: 60 }, tgt, g)) {
              p.callSeenAt = g.elapsed;
              p.callP = [P.x, P.z];
            }
          }
        }
        if (p.timer <= 0) this.finishCall(p, P);
        break;
      }
      case 'flee': {
        moveSpeed = 4.6;
        p.legT += moveSpeed * dt;
        const t = Math.min(1, p.legT / p.legLen);
        p.x = p.ax + (p.bx - p.ax) * t; p.z = p.az + (p.bz - p.az) * t;
        targetH = headingOf(p.bx - p.ax, p.bz - p.az);
        p.timer -= dt;
        if (p.timer < 5) p.icon.set(null);
        if (t >= 1) {
          if (p.timer <= 0) {
            p.cooldown = 15;
            if (this.rnd() < 0.3) { this.startCall(p); p.callCrimeP = [p.sx, p.sz]; }
            else { p.ch.play('walk', 0.4); this.resumeWalking(p); }
          } else this.pickFleeLeg(p);
        }
        break;
      }
      case 'fallen': {
        // knockback slide during the first half-second
        if (p.legT < p.legLen) {
          p.legT += Math.max(0.5, p.legLen * 2.5) * dt;
          const t = Math.min(1, p.legT / p.legLen);
          const e = 1 - (1 - t) * (1 - t);
          p.x = p.ax + (p.bx - p.ax) * e; p.z = p.az + (p.bz - p.az) * e;
        }
        p.timer -= dt;
        if (p.timer <= 0) {
          p.ch.setFallen(false);
          p.state = 'getup';
          p.timer = 1.1;
        }
        break;
      }
      case 'getup': {
        p.timer -= dt;
        if (p.timer <= 0) {
          p.cooldown = 0;
          this.startFlee(p, p.sx, p.sz);
          p.cooldown = 20;
        }
        break;
      }
    }

    // animation role by movement
    if (p.state === 'walk' || p.state === 'cross' || p.state === 'wander' || p.state === 'toBench') {
      p.ch.play('walk', 0.3, p.walkSpeed / 1.35);
    } else if (p.state === 'wait' || p.state === 'idle' || p.state === 'watch' || p.state === 'notice') {
      if (p.ch.role !== 'idle') p.ch.play('idle', 0.3);
    }

    // turn smoothly
    const turnRate = p.state === 'flee' ? 10 : 5;
    const dh = angleDiff(targetH, p.h);
    p.h += Math.sign(dh) * Math.min(Math.abs(dh), turnRate * dt);
    p.v = moveSpeed;
  }

  private tryBench(p: Ped) {
    const ids = this.benchGrid.query(p.x, p.z, 10);
    for (const bi of ids) {
      const b = this.benches[bi];
      if (b.used || dist2(b.x, b.z, p.x, p.z) > 100) continue;
      if (!losClear(this.g, [p.x, p.y + 0.8, p.z], [b.x, p.y + 0.8, b.z])) continue;
      b.used = true;
      p.bench = bi;
      p.prevState = 'walk';
      p.state = 'toBench';
      // stand in front of the bench (seat faces its heading)
      this.setLeg(p, b.x + Math.sin(b.rot) * 0.25, b.z - Math.cos(b.rot) * 0.25);
      return;
    }
  }

  // ------------------------------------------------------------------ main update

  update(dt: number) {
    if (!this.enabled) return;
    this.frame++;
    const g = this.g;
    const P = playerInfo(g);
    const T = PED_TUNING;

    // hash for neighbor queries
    this.hash.clear();
    for (const p of this.peds) this.hash.insert(p);

    // player suspicious → nearby peds may notice (2 Hz)
    this.suspTimer -= dt;
    if (this.suspTimer <= 0 && P.ok) {
      this.suspTimer = 0.5;
      if (P.suspicious) {
        const tgt = playerTarget(g);
        let checks = 0;
        this.hash.query(P.x, P.z, T.sightRange, (p) => {
          if (!tgt || checks > 10 || p.state === 'call' || p.state === 'flee' || p.state === 'notice' || p.cooldown > 0) return;
          checks++;
          if (canSee({ pos: [p.x, p.y + 1.6, p.z], dir: p.h, fovDeg: 150, range: T.sightRange }, tgt, g)) this.notice(p, P.x, P.z, true);
        });
      }
    }

    // update peds with LOD
    const cam = g.camera;
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    const cx = cam.position.x, cz = cam.position.z;
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const d2 = dist2(p.x, p.z, P.x, P.z);
      if (d2 > T.cullRadius * T.cullRadius && p.state !== 'call') { this.release(p); continue; }
      const every = d2 < 45 * 45 ? 1 : d2 < 90 * 90 ? 2 : 4;
      p.logicAcc += dt;
      if ((this.frame + p.id) % every === 0) {
        const step = Math.min(p.logicAcc, 0.2);
        p.logicAcc = 0;
        // simple separation among walkers
        if (p.state === 'walk') {
          let push = 0;
          this.hash.query(p.x, p.z, 1.2, (o) => {
            if (o === p) return;
            const rx = o.x - p.x, rz = o.z - p.z;
            const fx = Math.sin(p.h), fz = -Math.cos(p.h);
            if (rx * fx + rz * fz > 0) push -= Math.sign(rx * Math.cos(p.h) + rz * Math.sin(p.h) || 1) * 0.7;
          });
          if (P.ok && !P.inVehicle && dist2(p.x, p.z, P.x, P.z) < 2.2 * 2.2) push += (P.x - p.x) * Math.cos(p.h) + (P.z - p.z) * Math.sin(p.h) > 0 ? -0.8 : 0.8;
          const tgt = Math.max(-1.2, Math.min(1.2, push));
          p.avoid += (tgt - p.avoid) * Math.min(1, step * 2);
        }
        this.updatePed(p, step, P);
        if (every === 1 || (this.frame + p.id) % (every * 2) === 0) p.y = groundY(g, p.x, p.z, p.y);
      }
      // visuals
      p.ch.root.position.set(p.x, p.y, p.z);
      p.ch.root.rotation.y = -p.h;
      p.animAcc += dt;
      const camD2 = dist2(p.x, p.z, cx, cz);
      _sph.center.set(p.x, p.y + 0.9, p.z); _sph.radius = 1.4;
      const drawn = pedRenderLod(g, p.ch, camD2, _frustum.intersectsSphere(_sph), !!p.icon.kind);
      const animEvery = !drawn ? 12 : d2 < 40 * 40 ? 1 : d2 < 80 * 80 ? 3 : 6;
      if ((this.frame + p.id) % animEvery === 0) { p.ch.update(p.animAcc); p.animAcc = 0; }
      // obstacle for cars
      p.obs.x = p.x; p.obs.z = p.z; p.obs.h = p.h; p.obs.v = p.v;
    }
    this.obstacles.length = 0;
    for (const p of this.peds) this.obstacles.push(p.obs);

    // AI cars knock peds down (police free-driving, fleeing cars)
    if (this.sim) {
      for (const p of this.peds) {
        if (p.state === 'fallen') continue;
        this.sim.hash.query(p.x, p.z, 3, (o) => {
          if (!o.car || o.v < 3 || p.state === 'fallen') return;
          const fx = Math.sin(o.h), fz = -Math.cos(o.h);
          const rx = p.x - o.x, rz = p.z - o.z;
          if (Math.abs(rx * fx + rz * fz) < 2.4 && Math.abs(rx * -fz + rz * fx) < 1.1) this.knockDown(p, fx, fz, o.v * 0.3);
        });
      }
    }

    // density
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && P.ok) {
      this.spawnTimer = 0.4;
      let n = 0;
      for (const _ of this.bldGrid.query(P.x, P.z, 200)) n++;
      const segs = this.net.pedGrid.query(P.x, P.z, 150).size;
      const downtown = Math.max(0.45, Math.min(1.35, 0.45 + n / 45));
      const hasWalk = segs > 0 ? Math.min(1, segs / 12) : 0.3;
      this.targetCount = Math.round(Math.max(T.minPeds * pedTimeFactor(hourOfDay(g)), T.maxPeds * downtown * hasWalk * pedTimeFactor(hourOfDay(g)) / 1.35) * T.density);
      let spawns = this.initial ? this.targetCount : 2;
      while (this.peds.length < this.targetCount && spawns-- > 0) if (!this.trySpawn(P)) break;
      this.initial = false;
    }
  }

  /** Cancel calls / reset reactions (run restart). */
  reset() {
    for (const p of [...this.peds]) this.release(p);
    this.initial = true;
  }

  /** Abort any in-progress police calls (run restart). */
  cancelCalls() {
    for (const p of this.peds) {
      if (p.state === 'call' || p.state === 'notice') { p.icon.set(null); p.state = 'watch'; p.timer = 1; p.cooldown = 5; }
    }
  }

  /** Count of peds currently calling the police (HUD/debug). */
  callers(): number {
    let n = 0;
    for (const p of this.peds) if (p.state === 'call') n++;
    return n;
  }
}
