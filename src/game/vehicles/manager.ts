// VehiclesAPI implementation: spawning, parked-car promotion, impacts/damage, lights, effects.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game, System } from '../../core/game';
import type { VehiclesAPI, VehicleHandle } from '../../core/api';
import type { Vec2 } from '../../core/types';
import { hashString } from '../../core/geo';
import { CAR_MODEL_IDS, CIVILIAN_MODELS, getCarModel, type CarModelId } from './carModels';
import { CAR_COLORS, updateSharedLightMaterials } from './materials';
import { Vehicle } from './vehicle';
import { ParkingSystem, type ParkedSlot } from './parked';
import { Smoke } from '../effects';
import { clamp, nightFactor, playSound, v3 } from '../util';

const PROMOTE_RADIUS = 32;
const DEMOTE_RADIUS = 60;
const MAX_PROMOTED = 18;
const LOD_FAR = 60;

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
  readonly group = new THREE.Group();
  readonly vehicles = new Map<string, Vehicle>();
  readonly colliderMap = new Map<number, Vehicle>();
  /** Collider handles the wheel rays ignore (player capsule, pedestrians…). */
  readonly rayIgnore = new Set<number>();
  parking: ParkingSystem;
  smoke = new Smoke();
  private nextId = 1;
  private promoteTimer = 0;
  private headlights: THREE.SpotLight[] = [];
  private sirenLights: THREE.PointLight[] = [];
  private impactCooldown = new Map<string, number>();

  constructor(private g: Game) {
    this.group.name = 'vehicles';
    g.scene.add(this.group);
    this.parking = new ParkingSystem(g);
    g.scene.add(this.parking.group);
    g.scene.add(this.smoke.points);
    // Fixed light pool (constant light count → no shader recompiles).
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff1dc, 0, 70, 0.52, 0.55, 1.4);
      s.name = `player-headlight-${i}`;
      this.group.add(s, s.target);
      this.headlights.push(s);
    }
    for (const c of [0xff1020, 0x2040ff]) {
      const p = new THREE.PointLight(c, 0, 28, 1.6);
      p.name = 'siren-light';
      this.group.add(p);
      this.sirenLights.push(p);
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
  }

  despawn(id: string) {
    const v = this.vehicles.get(id);
    if (!v) return;
    if (this.g.player?.vehicleId === id) return; // never yank the player's car
    v.dispose(this.colliderMap);
    this.vehicles.delete(id);
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
      if (d < bd) return this.promote(slot);
    }
    return best;
  }

  /** Nearest vehicle measured to the hull (distance to the car's side, not its center). */
  nearestEnterable(p: THREE.Vector3, reach: number): Vehicle | undefined {
    let best: Vehicle | undefined, bd = reach;
    const cand = [...this.vehicles.values()];
    for (const s of this.parking.query(p.x, p.z, reach + 3)) cand.push(this.promote(s));
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

  promote(slot: ParkedSlot): Vehicle {
    for (const v of this.vehicles.values()) if (v.parkedSlot && v.parkedSlot.index === slot.index) return v;
    this.parking.activate(slot);
    const v = new Vehicle(this.g, {
      id: `veh${this.nextId++}`, kind: 'civilian', model: getCarModel(slot.model), color: slot.color, seed: slot.seed,
      x: slot.x, z: slot.z, y: slot.y, heading: slot.heading, mode: 'dynamic', colliderMap: this.colliderMap,
    });
    v.driver = 'none';
    v.parkedSlot = { model: slot.model, index: slot.index };
    this.register(v);
    v.body.sleep();
    v.sync(0);
    return v;
  }

  private demote(v: Vehicle) {
    const slot = v.parkedSlot ? this.parking.slots[v.parkedSlot.index] : null;
    if (!slot) return;
    const p = v.position;
    this.parking.deactivate(slot, p.x, p.y, p.z, v.heading);
    v.dispose(this.colliderMap);
    this.vehicles.delete(v.id);
  }

  // ------------------------------------------------------------------ loop

  fixedUpdate(dt: number) {
    for (const v of this.vehicles.values()) {
      if (v.physicsMode === 'dynamic' && v.body.isSleeping() && v.driver === 'none') continue;
      v.fixedUpdate(dt);
      if (v.physicsMode === 'dynamic') this.detectImpact(v, dt);
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
    this.damage(v, dmg, dv);
    playSound(g, 'crash', { at: v3(v.position), volume: clamp(mag / 12, 0.2, 1) });
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

  damage(v: Vehicle, amount: number, dvWorld: THREE.Vector3) {
    if (amount <= 0) return;
    v.health = Math.max(0, v.health - amount);
    // Dent: impact comes from the side opposite to the velocity change.
    const dir = dvWorld.clone().negate().normalize();
    const local = dir.applyQuaternion(v.object.quaternion.clone().invert());
    dent(v, local, clamp(amount / 60, 0.02, 0.14));
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
      let promoted = 0;
      for (const v of this.vehicles.values()) if (v.parkedSlot) promoted++;
      for (const s of this.parking.query(focus.x, focus.z, PROMOTE_RADIUS)) {
        if (promoted >= MAX_PROMOTED) break;
        this.promote(s);
        promoted++;
      }
      // Demote far, untouched ones.
      for (const v of [...this.vehicles.values()]) {
        if (!v.parkedSlot || v.driver !== 'none' || g.player?.vehicleId === v.id) continue;
        const d = Math.hypot(v.position.x - focus.x, v.position.z - focus.z);
        const upright = v.object.up.clone().applyQuaternion(v.object.quaternion).y > 0.8;
        if (d > DEMOTE_RADIUS && Math.abs(v.speed) < 0.3 && upright && !v.destroyed) this.demote(v);
      }
    }
    this.parking.refresh(g.camera.position);
  }

  lateUpdate(dt: number) {
    const g = this.g;
    const night = nightFactor(g);
    updateSharedLightMaterials(night);
    const cam = g.camera.position;
    const playerVid = g.player?.vehicleId;
    let sirenCar: Vehicle | null = null, sirenD = 1e9;
    for (const v of this.vehicles.values()) {
      v.sync(dt);
      const d = v.position.distanceTo(cam);
      v.visual.setFar(d > LOD_FAR && v.id !== playerVid);
      v.headlights = v.driver !== 'none' && !v.destroyed && (night > 0.15 || v.kind === 'police' && !!v.siren);
      if (v.siren && d < sirenD) { sirenD = d; sirenCar = v; }
      this.effects(v, dt, d);
    }
    this.smoke.update(dt, 0.35 + 0.65 * (1 - night), g.renderer?.domElement?.height ?? 800);
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
    // Siren light pool: nearest siren car gets real flashing lights.
    for (let i = 0; i < 2; i++) {
      const L = this.sirenLights[i];
      if (sirenCar && sirenCar.model.lightbar && sirenD < 150) {
        const lb = sirenCar.model.lightbar;
        L.position.copy(i === 0 ? lb.redPos : lb.bluePos).setY((i === 0 ? lb.redPos.y : lb.bluePos.y) + 0.3).applyMatrix4(sirenCar.object.matrixWorld);
        const t = (g.elapsed + 0.0) % 0.8;
        const on = (i === 0 ? t < 0.4 : t >= 0.4) && (t % 0.2) < 0.09;
        L.intensity = on ? 6 + 40 * night : 0;
      } else L.intensity = 0;
    }
  }

  private effects(v: Vehicle, dt: number, camD: number) {
    if (camD > 120) return;
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
    // Tire smoke when drifting / burnouts.
    if (v.physicsMode === 'dynamic' && v.controller && (v.slip > 0.3 && Math.abs(v.speed) > 7 || (v.control.handbrake && Math.abs(v.speed) > 8))) {
      for (let i = 2; i < 4; i++) {
        if (!v.controller.wheelIsInContact(i) || r() > 20 * dt) continue;
        const wp = v.model.wheelPos[i].clone().setY(0.15).applyMatrix4(v.object.matrixWorld);
        this.smoke.emit(wp, new THREE.Vector3((r() - 0.5) * 0.6, 0.3 + r() * 0.3, (r() - 0.5) * 0.6), { size: 0.6, grow: 2.2, life: 1.6, shade: 0.85, alpha: 0.28 });
      }
    }
  }
}

// ---------------------------------------------------------------- dents

const dentOrigin = new THREE.Vector3();
function dent(v: Vehicle, localDir: THREE.Vector3, depth: number) {
  const mesh = v.visual.bodyMesh;
  if (!mesh.userData.dentable) {
    mesh.geometry = mesh.geometry.clone();
    mesh.userData.dentable = true;
    mesh.userData.totalDent = 0;
  }
  if (mesh.userData.totalDent > 0.5) return;
  mesh.userData.totalDent += depth;
  const m = v.model;
  localDir.y = 0;
  if (localDir.lengthSq() < 1e-4) return;
  localDir.normalize();
  // Point on the hull in that direction (box approximation), at mid-body height.
  const sx = Math.abs(localDir.x) > 1e-3 ? m.W / Math.abs(localDir.x) : 1e9;
  const sz = Math.abs(localDir.z) > 1e-3 ? (m.L / 2) / Math.abs(localDir.z) : 1e9;
  const s = Math.min(sx, sz);
  dentOrigin.set(localDir.x * s, m.colCenter.y + 0.1, localDir.z * s);
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  const R = 0.7;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = Math.hypot(x - dentOrigin.x, (y - dentOrigin.y) * 0.8, z - dentOrigin.z);
    if (d > R) continue;
    const f = (1 - d / R) ** 2 * depth;
    pos.setXYZ(i, x - localDir.x * f + (Math.random() - 0.5) * f * 0.2, y - f * 0.15, z - localDir.z * f);
  }
  pos.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}
