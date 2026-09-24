// VehiclesAPI implementation: spawning, parked-car promotion, impacts/damage, lights, effects.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game, System } from '../../core/game';
import type { VehiclesAPI, VehicleHandle } from '../../core/api';
import type { Vec2 } from '../../core/types';
import { hashString } from '../../core/geo';
import { CAR_MODEL_IDS, CIVILIAN_MODELS, getCarModel, type CarModelId } from './carModels';
import { CAR_COLORS, updateSharedLightMaterials, mats } from './materials';
import { Vehicle, DRIFT } from './vehicle';
import { strobe, createVehicleVisual } from './visual';
import { ParkingSystem, type ParkedSlot } from './parked';
import { CarShadows } from './shadows';
import { FarTrafficBatch, WheelBatch } from './farBatch';
import { Smoke } from '../effects';
import { SkidMarks, Sparks } from './fx';
import { Knockables } from './knockables';
import { OverlapChecker } from './overlap';
import { clamp, groundY, nightFactor, playSound, v3 } from '../util';

const PROMOTE_RADIUS = 32;
const DEMOTE_RADIUS = 60;
const MAX_PROMOTED = 18;
const LOD_FAR = 45; // matches the parked-car near/far switch (perf)

export interface SpawnOptions {
  kind: 'civilian' | 'police';
  p: Vec2;
  heading: number;
  model?: string;
  physics?: boolean;
  /** Optional paint color (hex). */
  color?: string;
}

export class VehicleSystem implements VehiclesAPI, System {
  name = 'vehicles';
  order = 20;
  /** Drift-assist tuning (debug / dev harness). */
  readonly drift = DRIFT;
  readonly group = new THREE.Group();
  readonly vehicles = new Map<string, Vehicle>();
  readonly colliderMap = new Map<number, Vehicle>();
  /** Collider handles the wheel rays ignore (player capsule, pedestrians…). */
  readonly rayIgnore = new Set<number>();
  parking: ParkingSystem;
  /** Shared instanced hull shadow casters for every car (perf). */
  readonly shadows: CarShadows;
  /** Far-LOD civilian traffic drawn as per-model instances (perf). */
  readonly farBatch = new FarTrafficBatch();
  /** Near-LOD wheels of live vehicles, instanced per model (perf). */
  readonly wheelBatch = new WheelBatch();
  smoke = new Smoke();
  readonly skids = new SkidMarks();
  readonly sparks = new Sparks();
  readonly knockables: Knockables;
  /** Safe car-box overlap tests (no Rapier world queries; see overlap.ts). */
  readonly overlap: OverlapChecker;
  private scrapeT = 0;
  private nextId = 1;
  private promoteTimer = 0;
  private headlights: THREE.SpotLight[] = [];
  private sirenLights: THREE.PointLight[] = [];
  private impactCooldown = new Map<string, number>();

  constructor(private g: Game) {
    this.group.name = 'vehicles';
    g.scene.add(this.group);
    this.shadows = new CarShadows(g);
    g.scene.add(this.farBatch.group, this.wheelBatch.group);
    this.parking = new ParkingSystem(g, this.shadows);
    g.scene.add(this.parking.group);
    g.scene.add(this.smoke.points, this.skids.mesh, this.sparks.points);
    this.knockables = new Knockables(g, this.rayIgnore);
    this.overlap = new OverlapChecker(g, (c) => this.parking.colliderToSlot.has(c.handle) || this.rayIgnore.has(c.handle),
      () => { const out: RAPIER_NS.Collider[] = []; for (const v of this.vehicles.values()) out.push(...v.colliders); return out; },
      () => g.physics.colliders.len() - this.parking.colliderToSlot.size - this.colliderMap.size);
    // Fixed light pool (constant light count → no shader recompiles).
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff1dc, 0, 70, 0.52, 0.55, 1.4);
      s.name = `player-headlight-${i}`;
      this.group.add(s, s.target);
      this.headlights.push(s);
    }
    // Strobe lights cast on surroundings: one per police car, for the 2 nearest with sirens on
    // (color follows the bar pattern; constant light count → no shader recompiles).
    for (let i = 0; i < 2; i++) {
      const p = new THREE.PointLight(0xff1020, 0, 24, 1.8);
      p.name = 'siren-light';
      this.group.add(p);
      this.sirenLights.push(p);
    }
  }

  /** Load-time shader warm-up (engine.ts): hidden near + far visuals of every car model for
   *  renderer.compile(). Kept parked, never disposed, so their per-car materials keep the programs linked. */
  prewarm(holder: THREE.Object3D) {
    // every model, in a solid and a metallic (flake normal map) paint: the shared body program has both variants
    const list: [CarModelId, string][] = [['police', '#ffffff'], ['police-suv', '#ffffff'], [CIVILIAN_MODELS[0], '#f4f4f4'], ...CIVILIAN_MODELS.map((id) => [id, '#2a3f5f'] as [CarModelId, string])];
    for (const [id, color] of list) {
      const vis = createVehicleVisual(getCarModel(id), color, 1);
      vis.setLights({ head: true, brake: true, reverse: false, siren: id.startsWith('police'), t: 0, beam: true });
      holder.add(vis.root);
    }
  }

  // ------------------------------------------------------------------ API

  all(): VehicleHandle[] { return [...this.vehicles.values()]; }
  get(id: string): VehicleHandle | undefined { return this.vehicles.get(id); }

  spawn(opts: SpawnOptions): Vehicle {
    const id = `veh${this.nextId++}`;
    const h = hashString(id);
    let model = (opts.model && (CAR_MODEL_IDS as string[]).includes(opts.model) ? opts.model : undefined) as CarModelId | undefined;
    if (!model) model = opts.kind === 'police' ? (h % 10 < 3 ? 'police-suv' : 'police') : CIVILIAN_MODELS[h % CIVILIAN_MODELS.length];
    const color = opts.color ?? CAR_COLORS[(h >>> 4) % CAR_COLORS.length];
    const kind = model === 'police' || model === 'police-suv' ? 'police' : opts.kind;
    const v = new Vehicle(this.g, {
      id, kind, model: getCarModel(model), color, seed: h, x: opts.p[0], z: opts.p[1], heading: opts.heading,
      mode: opts.physics ? 'dynamic' : 'kinematic', colliderMap: this.colliderMap,
    });
    v.driver = opts.physics ? 'none' : 'ai';
    this.register(v);
    return v;
  }

  private register(v: Vehicle) {
    v.ignoreRay = (c: RAPIER_NS.Collider) => this.rayIgnore.has(c.handle) || this.colliderMap.get(c.handle) === v;
    this.vehicles.set(v.id, v);
    this.group.add(v.object);
    // Sun shadows come from the shared hull proxies (CarShadows); the detailed parts don't cast.
    if (this.shadows.active) v.object.traverse((o) => { o.castShadow = false; });
  }

  despawn(id: string) {
    const v = this.vehicles.get(id);
    if (!v) return;
    if (this.g.player?.vehicleId === id) return; // never yank the player's car
    v.dispose(this.colliderMap);
    this.vehicles.delete(id);
    this.lastVel.delete(id);
    this.impactCooldown.delete(id);
  }

  nearest(p: Vec2, radius: number): VehicleHandle | undefined {
    let best: Vehicle | undefined, bd = radius * radius;
    for (const v of this.vehicles.values()) {
      if (v.destroyed) continue;
      const d = (v.position.x - p[0]) ** 2 + (v.position.z - p[1]) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    const slot = this.parking.query(p[0], p[1], radius)[0];
    if (slot) {
      const d = (slot.x - p[0]) ** 2 + (slot.z - p[1]) ** 2;
      if (d < bd) return this.promote(slot) ?? best;
    }
    return best;
  }

  /** Nearest vehicle measured to the hull (distance to the car's side, not its center). */
  nearestEnterable(p: THREE.Vector3, reach: number): Vehicle | undefined {
    let best: Vehicle | undefined, bd = reach;
    const cand = [...this.vehicles.values()];
    for (const s of this.parking.query(p.x, p.z, reach + 3)) { const v = this.promote(s); if (v) cand.push(v); }
    for (const v of cand) {
      if (v.destroyed || v.driver === 'player') continue;
      const d = this.hullDistance(v, p);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  hullDistance(v: Vehicle, p: THREE.Vector3) {
    const local = v.object.worldToLocal(p.clone());
    const hx = v.model.W, hz = v.model.L / 2;
    const dx = Math.max(0, Math.abs(local.x) - hx), dz = Math.max(0, Math.abs(local.z) - hz);
    return Math.hypot(dx, dz);
  }

  /**
   * Promote a parked slot to a live (sleeping, dynamic) Vehicle. A slot whose hull overlaps other
   * geometry (landmark / prop colliders added after the parking pass) would explode on wake-up, so
   * it is first nudged to the nearest clear spot, or dropped for good if there is none.
   */
  promote(slot: ParkedSlot): Vehicle | null {
    for (const v of this.vehicles.values()) if (v.parkedSlot && v.parkedSlot.index === slot.index) return v;
    const model = getCarModel(slot.model);
    // Its own parked colliders are skipped (parking colliders are excluded from the checker).
    const clear = this.overlap.clearSpot(model, slot.x, slot.z, slot.heading, undefined, slot.y, 13);
    this.parking.activate(slot);
    if (!clear) { slot.dead = true; return null; } // stays hidden (active) and never comes back
    if (clear[0] !== slot.x || clear[1] !== slot.z) { slot.x = clear[0]; slot.z = clear[1]; slot.y = groundY(this.g, slot.x, slot.z); slot.m = undefined; }
    const v = new Vehicle(this.g, {
      id: `veh${this.nextId++}`, kind: 'civilian', model, color: slot.color, seed: slot.seed,
      x: slot.x, z: slot.z, y: slot.y, heading: slot.heading, mode: 'dynamic', colliderMap: this.colliderMap,
    });
    v.driver = 'none';
    v.parkedSlot = { model: slot.model, index: slot.index };
    this.register(v);
    v.body.sleep();
    v.sync(0);
    return v;
  }

  private demotable(v: Vehicle) {
    const upright = v.object.up.clone().applyQuaternion(v.object.quaternion).y > 0.8;
    // Must be resting on the ground: never freeze a car into parked instancing up a tree / mid-air.
    const grounded = v.position.y - groundY(this.g, v.position.x, v.position.z) < 1;
    return !!v.parkedSlot && v.driver === 'none' && this.g.player?.vehicleId !== v.id && Math.abs(v.speed) < 0.3 && upright && grounded && !v.destroyed && v.health >= 100;
  }

  private demote(v: Vehicle) {
    const slot = v.parkedSlot ? this.parking.slots[v.parkedSlot.index] : null;
    if (!slot) return;
    const p = v.position;
    this.parking.deactivate(slot, p.x, p.y, p.z, v.heading);
    v.dispose(this.colliderMap);
    this.vehicles.delete(v.id);
    this.lastVel.delete(v.id);
    this.impactCooldown.delete(v.id);
  }

  // ------------------------------------------------------------------ loop

  /**
   * perf: a promoted parked car that is still asleep, upright and undamaged keeps being drawn by
   * the parked-car instancing (1 batch per model) instead of its own ~24-draw visual. Any wake-up,
   * driver, damage or tilt hands it straight back to the full Vehicle visual.
   */
  private sleepyParked(v: Vehicle): boolean {
    if (!v.parkedSlot) return false;
    const slot = this.parking.slots[v.parkedSlot.index];
    if (!slot) return false;
    const q = v.object.quaternion;
    const upright = 1 - 2 * (q.x * q.x + q.z * q.z) > 0.995; // local up · world up
    const sleepy = v.driver === 'none' && v.physicsMode === 'dynamic' && v.body.isSleeping() && !v.destroyed && v.health >= 100 && upright
      && this.g.player?.vehicleId !== v.id;
    if (sleepy !== !!slot.sleepy) {
      const p = v.object.position;
      const dh = Math.abs(Math.atan2(Math.sin(v.heading - slot.heading), Math.cos(v.heading - slot.heading)));
      const moved = (p.x - slot.x) ** 2 + (p.z - slot.z) ** 2 > 0.09 || dh > 0.05;
      if (moved) this.parking.setSleepy(slot, sleepy, p.x, p.y, p.z, v.heading);
      else this.parking.setSleepy(slot, sleepy); // untouched since promotion: keep the exact slot pose
    }
    return sleepy;
  }

  fixedUpdate(dt: number) {
    const playerVid = this.g.player?.vehicleId;
    for (const v of this.vehicles.values()) {
      if (v.physicsMode === 'dynamic' && v.body.isSleeping() && v.driver === 'none') continue;
      v.fixedUpdate(dt);
      if (v.physicsMode === 'dynamic' && v.id !== playerVid) this.sanitize(v, dt);
      if (v.physicsMode === 'dynamic') this.detectImpact(v, dt);
      if (v.id === playerVid || (v.physicsMode === 'dynamic' && v.driver !== 'none')) this.knockables.check(v, dt);
      if (v.id === playerVid) { this.scrape(v, dt); if (v.stuckT > 0.5) this.unpin(v); }
    }
  }

  /**
   * Physics-explosion guard for cars nobody is driving (woken parked cars, crashed AI): clamp absurd
   * velocities / spin, and put back on the ground any car stranded > 3 m above it (trees, roofs, air).
   */
  private sanitize(v: Vehicle, dt: number) {
    const lv = v.body.linvel(), av = v.body.angvel();
    const h = Math.hypot(lv.x, lv.z);
    if (Math.abs(lv.y) > 30 || h > 60) {
      const k = Math.min(1, 60 / Math.max(h, 1e-3));
      v.body.setLinvel({ x: lv.x * k, y: clamp(lv.y, -30, 30), z: lv.z * k }, true);
    }
    const w = Math.hypot(av.x, av.y, av.z);
    if (w > 12) { const k = 12 / w; v.body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true); }
    if (v.driver === 'player') return;
    const t = v.body.translation();
    if (t.y - groundY(this.g, t.x, t.z) > 3) v.strandedT += dt; else v.strandedT = 0;
    if (v.strandedT > 1.5) { v.strandedT = 0; v.flipUpright(); }
  }

  /** Solver contact point between a vehicle hull and anything else (world space), or null. */
  private contactPoint(v: Vehicle, filter?: (c: RAPIER_NS.Collider) => boolean): THREE.Vector3 | null {
    const w = this.g.physics;
    let out: THREE.Vector3 | null = null;
    for (const c of v.colliders) {
      w.contactPairsWith(c, (o) => {
        if (out || (filter && !filter(o))) return;
        w.contactPair(c, o, (man) => {
          if (out || man.numSolverContacts() === 0) return;
          const p = man.solverContactPoint(0);
          if (p) out = new THREE.Vector3(p.x, p.y, p.z);
        });
      });
      if (out) break;
    }
    return out;
  }

  /** Player pinned against a kinematic AI car (police box-in, traffic): hand it to physics so it can be shoved. */
  private unpin(v: Vehicle) {
    for (const c of v.colliders) {
      this.g.physics.contactPairsWith(c, (o) => {
        const other = this.colliderMap.get(o.handle);
        if (other && other !== v && other.physicsMode === 'kinematic') { other.makeDynamic(); other.crashed = true; }
      });
    }
  }

  /** Metal-on-wall scraping: continuous sparks + grind while the player's hull slides along static geometry. */
  private scrape(v: Vehicle, dt: number) {
    this.scrapeT -= dt;
    const spd = v.velocity.length();
    if (spd < 4) return;
    const p = this.contactPoint(v, (o) => { const b = o.parent(); return !!b && b.isFixed() && !this.parking.colliderToSlot.has(o.handle); });
    if (!p) return;
    const back = v.velocity.clone().normalize().multiplyScalar(-0.6).setY(0.35);
    this.sparks.emit(p, back, 2 + Math.floor(spd / 8), 3 + spd * 0.25);
    if (this.scrapeT <= 0) {
      this.scrapeT = 0.18;
      playSound(this.g, 'crash', { at: v3(p), volume: clamp(spd / 40, 0.08, 0.3), rate: 1.6 + Math.random() * 0.3 });
    }
  }

  private lastVel = new Map<string, THREE.Vector3>();
  private detectImpact(v: Vehicle, dt: number) {
    const lv = v.body.linvel();
    let prev = this.lastVel.get(v.id);
    if (!prev) { prev = new THREE.Vector3(lv.x, lv.y, lv.z); this.lastVel.set(v.id, prev); return; }
    const dv = new THREE.Vector3(lv.x - prev.x, lv.y - prev.y, lv.z - prev.z);
    prev.set(lv.x, lv.y, lv.z);
    // Ignore mostly-vertical changes (landing on suspension).
    const horiz = Math.hypot(dv.x, dv.z) + Math.max(0, Math.abs(dv.y) - 3) * 0.5;
    const cd = (this.impactCooldown.get(v.id) ?? 0) - dt;
    this.impactCooldown.set(v.id, cd);
    if (horiz < 2.2 || cd > 0) return;
    this.impactCooldown.set(v.id, 0.25);
    this.onImpact(v, dv, horiz);
  }

  private onImpact(v: Vehicle, dv: THREE.Vector3, mag: number) {
    const g = this.g;
    v.lastImpact = mag;
    v.lastImpactDir.copy(dv).normalize();
    const dmg = (mag - 2) * 3.2;
    this.damage(v, dmg, dv, this.contactPoint(v) ?? undefined);
    playSound(g, 'crash', { at: v3(v.position), volume: clamp(mag / 12, 0.2, 1) });
    // Sparks where metal met something hard.
    if (mag > 4) {
      const p = this.contactPoint(v);
      if (p) {
        const dir = dv.clone().normalize().multiplyScalar(0.5).setY(0.4);
        this.sparks.emit(p, dir, Math.min(40, 8 + Math.floor(mag * 2)), 4 + mag * 0.4);
      }
    }
    g.events.emit('noise', { p: [v.position.x, v.position.z], radius: 25 + mag * 6, kind: 'crash' });
    // What did we hit? Knock kinematic AI cars into physics; wake parked ones.
    const main = v.colliders[0];
    const hitOthers = new Set<Vehicle>();
    g.physics.contactPairsWith(main, (c2) => { const o = this.colliderMap.get(c2.handle); if (o && o !== v) hitOthers.add(o); });
    g.physics.contactPairsWith(v.colliders[1], (c2) => { const o = this.colliderMap.get(c2.handle); if (o && o !== v) hitOthers.add(o); });
    for (const o of hitOthers) {
      if (o.physicsMode === 'kinematic') {
        if (mag > 3.5) {
          o.makeDynamic();
          o.crashed = true;
          const push = v.prevVelocity.clone().multiplyScalar(v.tuning.mass / (v.tuning.mass + o.tuning.mass) * 0.8);
          const lv = o.body.linvel();
          o.body.setLinvel({ x: lv.x + push.x, y: lv.y + 0.5, z: lv.z + push.z }, true);
        }
      } else o.body.wakeUp();
      this.damage(o, dmg * 0.8, dv.clone().negate());
      if (v.driver === 'player' && (o.driver === 'ai' || o.kind === 'police')) {
        g.events.emit('crime', { kind: 'vehicle-hit', p: [v.position.x, v.position.z], severity: mag > 8 ? 3 : 2 });
      }
    }
  }

  damage(v: Vehicle, amount: number, dvWorld: THREE.Vector3, contact?: THREE.Vector3) {
    if (amount <= 0) return;
    v.health = Math.max(0, v.health - amount);
    // Dent: impact comes from the side opposite to the velocity change.
    const dir = dvWorld.clone().negate().normalize();
    const local = dir.applyQuaternion(v.object.quaternion.clone().invert());
    const at = contact ? v.object.worldToLocal(contact.clone()) : undefined;
    dent(v, local, clamp(amount / 100, 0.025, 0.32), at);
    if (amount > 10) v.alignment = clamp(v.alignment + local.x * amount / 500, -0.2, 0.2);
    if (v.health < 35) v.hazards = true;
    if (v.health <= 0 && !v.destroyed) {
      v.destroyed = true;
      if (this.g.player?.vehicleId === v.id) this.g.events.emit('toast', { text: 'Engine destroyed. Get out!', kind: 'bad' });
    }
  }

  update(dt: number) {
    const g = this.g;
    this.promoteTimer -= dt;
    const focus = g.player?.position ?? g.camera.position;
    if (this.promoteTimer <= 0) {
      this.promoteTimer = 0.3;
      // Promote nearby parked cars.
      const promotedList: [number, Vehicle][] = [];
      for (const v of this.vehicles.values()) if (v.parkedSlot) promotedList.push([Math.hypot(v.position.x - focus.x, v.position.z - focus.z), v]);
      promotedList.sort((a, b) => b[0] - a[0]); // farthest first
      let promoted = promotedList.length;
      for (const s of this.parking.query(focus.x, focus.z, PROMOTE_RADIUS)) {
        if (promoted >= MAX_PROMOTED) {
          // At the cap: recycle the farthest untouched promoted car if this slot is clearly nearer
          // (static parked colliders next to the player would otherwise pin a stolen car).
          const d = Math.hypot(s.x - focus.x, s.z - focus.z);
          const far = promotedList[0];
          if (!far || far[0] < d + 6 || !this.demotable(far[1])) break;
          promotedList.shift();
          this.demote(far[1]);
          promoted--;
        }
        this.promote(s);
        promoted++;
      }
      // A sleeping undriven car resting > 3 m up (tree canopy, roof ledge): wake it so sanitize() recovers it.
      for (const v of this.vehicles.values()) {
        if (v.physicsMode !== 'dynamic' || v.driver === 'player' || !v.body.isSleeping()) continue;
        const t = v.body.translation();
        if (t.y - groundY(g, t.x, t.z) > 3) v.body.wakeUp();
      }
      // Demote far, untouched ones.
      for (const v of [...this.vehicles.values()]) {
        if (!v.parkedSlot || v.driver !== 'none' || g.player?.vehicleId === v.id) continue;
        const d = Math.hypot(v.position.x - focus.x, v.position.z - focus.z);
        const upright = v.object.up.clone().applyQuaternion(v.object.quaternion).y > 0.8;
        const grounded = v.position.y - groundY(g, v.position.x, v.position.z) < 1;
        if (d > DEMOTE_RADIUS && Math.abs(v.speed) < 0.3 && upright && grounded && !v.destroyed) this.demote(v);
      }
    }
    this.parking.refresh(g.camera.position, false, g.camera);
  }

  private viewFrustum = new THREE.Frustum();
  private viewMatrix = new THREE.Matrix4();
  private carBounds = new THREE.Sphere();

  lateUpdate(dt: number) {
    const g = this.g;
    const night = nightFactor(g);
    updateSharedLightMaterials(night);
    const cam = g.camera.position;
    g.camera.updateMatrixWorld();
    this.viewMatrix.multiplyMatrices(g.camera.projectionMatrix, g.camera.matrixWorldInverse);
    this.viewFrustum.setFromProjectionMatrix(this.viewMatrix);
    const playerVid = g.player?.vehicleId;
    const sirenCars: [number, Vehicle][] = [];
    const detailDistance = LOD_FAR * (g.quality === 'high' ? 1 : g.quality === 'medium' ? 0.8 : 0.6);
    const shadowDistance = g.quality === 'high' ? 140 : g.quality === 'medium' ? 100 : 70;
    this.shadows.begin();
    this.farBatch.begin();
    this.wheelBatch.begin();
    for (const v of this.vehicles.values()) {
      v.sync(dt);
      const sleepy = this.sleepyParked(v);
      const d = v.position.distanceTo(cam);
      v.visual.setFar(d > detailDistance && v.id !== playerVid);
      v.headlights = v.driver !== 'none' && !v.destroyed && (night > 0.15 || v.kind === 'police' && !!v.siren);
      v.beam = v.headlights && night > 0.2 && d < 90;
      // far civilian cars render through the per-model far batch (perf)
      this.carBounds.center.copy(v.position).y += v.model.roofY * 0.5;
      this.carBounds.radius = Math.hypot(v.model.L * 0.5, v.model.colHalf.x, v.model.roofY);
      const inView = v.id === playerVid || this.viewFrustum.intersectsSphere(this.carBounds);
      const batched = !sleepy && v.visual.far && v.kind !== 'police' && !v.destroyed && !!v.object.parent;
      v.object.visible = !sleepy && !batched && (inView || d < 14);
      if (!sleepy && v.object.parent) {
        const ch = v.visual.chassis;
        ch.updateWorldMatrix(true, false);
        if (d < shadowDistance) this.shadows.add(v.model, ch.matrixWorld);
        if (v.object.visible && !v.visual.far) {
          // wheels: pivot > spin > mesh; parents are fresh after the chassis update above
          for (const pv of v.visual.wheels) {
            const w = pv.children[0]?.children[0] as THREE.Mesh | undefined;
            if (!w?.isMesh) continue;
            pv.updateWorldMatrix(false, true);
            if (w.visible) w.visible = false;
            this.wheelBatch.add(v.model, w);
          }
        }
        if (batched && inView) {
          const head = v.headlights ? mats.headOn.emissiveIntensity : 0;
          const tail = v.braking ? mats.tailBrake.emissiveIntensity : v.headlights ? mats.tailRun.emissiveIntensity : 0;
          this.farBatch.add(v.model, v.object.matrixWorld, v.color, head, tail);
        }
      }
      if (v.siren && v.model.lightbar && !v.destroyed && d < 160) sirenCars.push([d, v]);
      this.effects(v, dt, d);
    }
    this.shadows.end();
    this.farBatch.end();
    this.wheelBatch.end();
    const vh = g.renderer?.domElement?.height ?? 800;
    this.smoke.update(dt, 0.35 + 0.65 * (1 - night), vh);
    this.sparks.update(dt, vh);
    this.skids.update();
    this.knockables.sync();
    // Player headlights
    const pv = playerVid ? this.vehicles.get(playerVid) : undefined;
    for (let i = 0; i < 2; i++) {
      const s = this.headlights[i];
      if (pv && pv.headlights && night > 0.05) {
        const hp = pv.model.headlightPos[i];
        s.position.copy(hp).applyMatrix4(pv.object.matrixWorld);
        s.target.position.copy(hp).add(new THREE.Vector3(0, -0.6, -12)).applyMatrix4(pv.object.matrixWorld);
        s.intensity = 60 * night;
      } else s.intensity = 0;
    }
    // Siren strobes cast on nearby surfaces: the 2 nearest police cars with sirens get a real light.
    sirenCars.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < 2; i++) {
      const L = this.sirenLights[i];
      const c = sirenCars[i]?.[1];
      if (c && c.model.lightbar) {
        const lb = c.model.lightbar;
        const st = strobe(g.elapsed + (hashString(c.id) % 7) * 0.13);
        const side = st.red && !st.blue ? lb.redPos : st.blue && !st.red ? lb.bluePos : lb.redPos.clone().lerp(lb.bluePos, 0.5);
        L.position.copy(side).setY(side.y + 0.35).applyMatrix4(c.object.matrixWorld);
        L.color.setHex(st.red && (!st.blue || Math.floor(g.elapsed * 20) % 2) ? 0xff1020 : 0x2448ff);
        L.intensity = st.red || st.blue ? 5 + 28 * night : 0;
      } else L.intensity = 0;
    }
  }

  private effects(v: Vehicle, dt: number, camD: number) {
    if (camD > 120) return;
    const g = this.g;
    const r = Math.random;
    // Engine smoke from damage.
    if (v.health < 45) {
      const rate = v.health <= 0 ? 30 : v.health < 20 ? 14 : 6;
      if (r() < rate * dt) {
        const p = v.model.hoodPos.clone().applyMatrix4(v.object.matrixWorld);
        p.x += (r() - 0.5) * 0.4; p.z += (r() - 0.5) * 0.4;
        const vel = v.velocity.clone().multiplyScalar(0.3).add(new THREE.Vector3((r() - 0.5) * 0.4, 0.8 + r() * 0.6, (r() - 0.5) * 0.4));
        const dark = v.health <= 0 ? 0.08 : v.health < 20 ? 0.25 : 0.6;
        this.smoke.emit(p, vel, { size: 0.5, grow: 1.4, life: 2.5 + r(), shade: dark, alpha: 0.55 });
      }
    }
    if (v.physicsMode !== 'dynamic' || !v.controller) return;
    const vc = v.controller;
    const spd = Math.abs(v.speed);
    const driven = v.driver !== 'none';
    // Wet contact patches throw a low, trailing spray instead of dry tire smoke.
    const wet = g.sky?.wetness ?? 0;
    if (wet > 0.2 && spd > 7) for (let i=2;i<4;i++) {
      if (!vc.wheelIsInContact(i) || r() > wet * Math.min(16, spd) * dt) continue;
      const p=vc.wheelContactPoint(i);if(!p)continue;
      this.smoke.emit(new THREE.Vector3(p.x,p.y+0.08,p.z),v.velocity.clone().multiplyScalar(-0.12).setY(0.6),{size:0.25,grow:1.6,life:0.65,shade:0.85,alpha:0.09*wet});
    }
    // Tire smoke when drifting / burnouts.
    const smoky = v.burnout || (v.slip > 0.3 && spd > 7) || (driven && v.control.handbrake && spd > 8);
    if (smoky && wet < 0.4) {
      const rate = v.burnout ? 22 : 16;
      for (let i = 2; i < 4; i++) {
        if (!vc.wheelIsInContact(i) || r() > rate * dt) continue;
        const wp = v.model.wheelPos[i].clone().setY(0.15).applyMatrix4(v.object.matrixWorld);
        const vel = v.velocity.clone().multiplyScalar(0.2).add(new THREE.Vector3((r() - 0.5) * 0.6, 0.3 + r() * 0.3, (r() - 0.5) * 0.6));
        this.smoke.emit(wp, vel, { size: 0.45, grow: v.burnout ? 1.9 : 1.6, life: v.burnout ? 2.2 : 1.5, shade: 0.8, alpha: v.burnout ? 0.2 : 0.16 });
      }
    }
    // Skid marks: per-wheel trails while sliding sideways, locking up, handbraking or burning out.
    if (camD > 90) return;
    const right = _right.set(1, 0, 0).applyQuaternion(v.object.quaternion);
    const lat = v.slip > 0.2 && spd > 5 ? Math.min(1, (v.slip - 0.15) * 3) : 0;
    const lock = driven && v.control.brake > 0.5 && v.speed > 7 && !v.reversing ? 0.45 : 0;
    for (let i = 0; i < 4; i++) {
      const key = `${v.id}:${i}`;
      const rear = i >= 2;
      let a = Math.max(lat * (rear ? 1 : 0.7), lock);
      if (rear && driven && v.control.handbrake && spd > 3) a = Math.max(a, 0.85);
      if (rear && v.burnout) a = 1;
      if (a < 0.05 || !vc.wheelIsInContact(i)) { this.skids.end(key); continue; }
      const cp = vc.wheelContactPoint(i);
      if (!cp) { this.skids.end(key); continue; }
      _cp.set(cp.x, cp.y + 0.015, cp.z);
      this.skids.add(key, _cp, right, v.model.spec.tireW, a, g.elapsed);
    }
  }
}

const _right = new THREE.Vector3(), _cp = new THREE.Vector3();

// ---------------------------------------------------------------- dents

const dentOrigin = new THREE.Vector3();
function dent(v: Vehicle, localDir: THREE.Vector3, depth: number, contact?: THREE.Vector3) {
  const mesh = v.visual.bodyMesh;
  if (!mesh.userData.dentable) {
    mesh.geometry = mesh.geometry.clone();
    mesh.userData.dentable = true;
    mesh.userData.totalDent = 0;
  }
  if (mesh.userData.totalDent > 1.2) return;
  mesh.userData.totalDent += depth;
  const m = v.model;
  localDir.y = 0;
  if (localDir.lengthSq() < 1e-4) return;
  localDir.normalize();
  // Point on the hull in that direction (box approximation), at mid-body height.
  const sx = Math.abs(localDir.x) > 1e-3 ? m.W / Math.abs(localDir.x) : 1e9;
  const sz = Math.abs(localDir.z) > 1e-3 ? (m.L / 2) / Math.abs(localDir.z) : 1e9;
  const s = Math.min(sx, sz);
  if (contact) dentOrigin.copy(contact);
  else dentOrigin.set(localDir.x * s, m.colCenter.y + 0.1, localDir.z * s);
  v.visual.markDamage(dentOrigin, depth);
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const R = 0.9 + depth * 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = Math.hypot(x - dentOrigin.x, (y - dentOrigin.y) * 0.8, z - dentOrigin.z);
    if (d > R) continue;
    const f = (1 - d / R) ** 2 * depth;
    pos.setXYZ(i, x - localDir.x * f + (Math.sin(i * 12.9898) * 0.5) * f * 0.2, y - f * 0.15, z - localDir.z * f);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}
