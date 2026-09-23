// Player on foot (Rapier kinematic character controller) + driving input + enter/exit/carjack.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game, System } from '../core/game';
import type { PlayerAPI } from '../core/api';
import type { Vec2 } from '../core/types';
import { Character, type Pose } from './character';
import type { VehicleSystem } from './vehicles/manager';
import type { Vehicle } from './vehicles/vehicle';
import type { CameraRig } from './camera';
import { clamp, damp, headingToDir, lerpAngle, playSound, groundY, v3, type SoundHandle } from './util';

const RADIUS = 0.3;
const HALF = 0.55; // capsule half-height (segment); total height = 2*(HALF+RADIUS) = 1.7
const CENTER = HALF + RADIUS;
const GRAVITY = 22;
const JUMP_V = 6.4;
const SPEED = { walk: 1.45, jog: 3.6, sprint: 6.2, crouch: 1.25 };

type EnterState = { veh: Vehicle; t: number; phase: 'approach' | 'door'; stolen: boolean; carjack: boolean } | null;

export class Player implements PlayerAPI, System {
  name = 'player';
  order = 10;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  heading = 0;
  vehicleId: string | null = null;
  suspicious = false;
  health = 100;
  controlsEnabled = true;
  busy = false;
  crouching = false;
  sprinting = false;
  groundSpeed = 0;
  character = new Character();
  body!: RAPIER_NS.RigidBody;
  collider!: RAPIER_NS.Collider;
  private kcc!: RAPIER_NS.KinematicCharacterController;
  private vy = 0;
  private grounded = true;
  private coyote = 0;
  private jumpBuf = 0;
  private hvel = new THREE.Vector3();
  private enter: EnterState = null;
  private pose: Pose = 'none';
  private lastStep = 0;
  private engine: SoundHandle = null;
  private squeal: SoundHandle = null;
  private meleeT = 0;
  private meleePending = -1;
  private lastDamage = 0;
  private walkToggle = false;
  camera!: CameraRig;

  constructor(private g: Game, private vehicles: VehicleSystem) {}

  get stepPhase() { return this.character.stepPhase; }

  get plateFlagged() {
    const v = this.vehicleId ? this.vehicles.vehicles.get(this.vehicleId) : undefined;
    return !!v?.flagged;
  }
  set plateFlagged(f: boolean) {
    const v = this.vehicleId ? this.vehicles.vehicles.get(this.vehicleId) : undefined;
    if (v) v.flagged = f;
  }

  async init() {
    const g = this.g, R = g.rapier;
    const sp = g.recipe.spawn;
    const y = this.groundAt(sp.p[0], sp.p[1], sp.y);
    this.position.set(sp.p[0], y, sp.p[1]);
    this.heading = sp.heading ?? 0;
    this.body = g.physics.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(sp.p[0], y + CENTER + 0.05, sp.p[1]));
    this.collider = g.physics.createCollider(R.ColliderDesc.capsule(HALF, RADIUS).setFriction(0), this.body);
    this.vehicles.rayIgnore.add(this.collider.handle);
    const kcc = g.physics.createCharacterController(0.02);
    kcc.setUp({ x: 0, y: 1, z: 0 });
    kcc.enableAutostep(0.42, 0.18, false);
    kcc.enableSnapToGround(0.45);
    kcc.setMaxSlopeClimbAngle((48 * Math.PI) / 180);
    kcc.setMinSlopeSlideAngle((38 * Math.PI) / 180);
    kcc.setApplyImpulsesToDynamicBodies(true);
    kcc.setCharacterMass(80);
    kcc.setSlideEnabled(true);
    this.kcc = kcc;
    await this.character.init();
    this.character.root.position.copy(this.position);
    this.character.root.rotation.y = -this.heading;
    g.scene.add(this.character.root);
    g.events.on('takedownStart', (e) => { this.pose = e.mode === 'cut' ? 'kneel' : 'interact'; });
    g.events.on('takedown', () => { this.pose = 'none'; });
    g.events.on('takedownCancel', () => { this.pose = 'none'; });
    g.events.on('arrested', () => { this.pose = 'none'; this.enter = null; });
  }

  private groundAt(x: number, z: number, fallback = 0) {
    if (this.g.world) return groundY(this.g, x, z);
    const R = this.g.rapier;
    const hit = this.g.physics.castRay(new R.Ray({ x, y: 300, z }, { x: 0, y: -1, z: 0 }), 600, true, undefined, undefined, this.collider);
    return hit ? 300 - hit.timeOfImpact : fallback;
  }

  // ------------------------------------------------------------------ API
  respawn(p: Vec2, heading = 0) {
    if (this.vehicleId) this.exitVehicle(true);
    this.enter = null;
    const y = this.groundAt(p[0], p[1], this.position.y);
    this.body.setTranslation({ x: p[0], y: y + CENTER + 0.05, z: p[1] }, true);
    this.body.setNextKinematicTranslation({ x: p[0], y: y + CENTER + 0.05, z: p[1] });
    this.position.set(p[0], y, p[1]);
    this.heading = heading;
    this.character.root.rotation.y = -heading;
    this.vy = 0; this.hvel.set(0, 0, 0); this.velocity.set(0, 0, 0);
    this.health = 100;
    this.busy = false;
    this.pose = 'none';
    if (this.camera) this.camera.yaw = heading;
  }

  hurt(amount: number) {
    this.health = Math.max(0, this.health - amount);
    this.lastDamage = this.g.elapsed;
  }

  // ------------------------------------------------------------------ loop
  fixedUpdate(dt: number) {
    const inp = this.g.input;
    const can = this.controlsEnabled && !this.busy;
    if (this.vehicleId) return this.driveInput(dt, can);
    if (this.enter) return this.enterStep(dt);
    // Movement intent relative to camera yaw.
    let fx = 0, fz = 0;
    if (can) {
      if (inp.isDown('KeyW') || inp.isDown('ArrowUp')) fz += 1;
      if (inp.isDown('KeyS') || inp.isDown('ArrowDown')) fz -= 1;
      if (inp.isDown('KeyD') || inp.isDown('ArrowRight')) fx += 1;
      if (inp.isDown('KeyA') || inp.isDown('ArrowLeft')) fx -= 1;
    }
    const yaw = this.camera ? this.camera.yaw : this.heading;
    const f = headingToDir(yaw);
    const r = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const want = new THREE.Vector3().addScaledVector(f, fz).addScaledVector(r, fx);
    const has = want.lengthSq() > 0.01;
    if (has) want.normalize();
    this.sprinting = has && can && (inp.isDown('ShiftLeft') || inp.isDown('ShiftRight')) && !this.crouching;
    if (can && inp.wasPressed('KeyC')) this.crouching = !this.crouching;
    if (this.sprinting) this.crouching = false;
    if (can && (inp.wasPressed('CapsLock') || inp.wasPressed('KeyX'))) this.walkToggle = !this.walkToggle;
    const speed = this.crouching ? SPEED.crouch : this.sprinting ? SPEED.sprint : this.walkToggle ? SPEED.walk : SPEED.jog;
    want.multiplyScalar(has ? speed : 0);
    const accel = this.grounded ? (has ? 16 : 22) : 3.5;
    const dv = want.clone().sub(this.hvel);
    const maxDv = accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    this.hvel.add(dv);
    // Jump (buffered + coyote time)
    if (can && inp.wasPressed('Space')) this.jumpBuf = 0.15;
    this.jumpBuf -= dt;
    this.coyote = this.grounded ? 0.12 : this.coyote - dt;
    if (this.jumpBuf > 0 && this.coyote > 0 && !this.crouching) {
      this.vy = JUMP_V; this.jumpBuf = 0; this.coyote = 0; this.grounded = false;
    }
    this.vy -= GRAVITY * dt;
    if (this.grounded && this.vy < -2) this.vy = -2;
    const desired = { x: this.hvel.x * dt, y: this.vy * dt, z: this.hvel.z * dt };
    this.kcc.computeColliderMovement(this.collider, desired, undefined, undefined, (c) => !c.isSensor());
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.kcc.computedGrounded();
    const t = this.body.translation();
    const nx = t.x + mv.x, ny = t.y + mv.y, nz = t.z + mv.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    if (this.grounded && this.vy < 0) {
      if (!wasGrounded && this.vy < -14) this.hurt((-this.vy - 14) * 6);
      this.vy = 0;
    }
    if (mv.y > desired.y + 1e-3 && this.vy > 0 && Math.abs(mv.y) < 1e-4) this.vy = 0; // bonked head
    // Actual horizontal velocity (for anims)
    const act = new THREE.Vector3(mv.x / dt, 0, mv.z / dt);
    if (act.length() < this.hvel.length() * 0.5 && has) this.hvel.lerp(act, 0.5); // pressing into a wall
    this.groundSpeed = damp(this.groundSpeed, Math.hypot(act.x, act.z), 12, dt);
    this.velocity.set(act.x, mv.y / dt, act.z);
    // Facing
    if (has && this.hvel.lengthSq() > 0.05) {
      const h = Math.atan2(this.hvel.x, -this.hvel.z);
      this.heading = lerpAngle(this.heading, h, 1 - Math.exp(-(this.sprinting ? 9 : 13) * dt));
    }
    // Fell out of the world?
    if (ny < -200) this.respawn(this.g.recipe.spawn.p, this.g.recipe.spawn.heading);
  }

  update(dt: number) {
    const g = this.g, inp = g.input;
    const can = this.controlsEnabled && !this.busy;
    // Enter / exit
    if (can && inp.wasPressed('KeyF')) {
      if (this.vehicleId) this.exitVehicle(false);
      else if (!this.enter) this.tryEnter();
    }
    if (this.vehicleId) this.vehicleAudio(dt);
    // Melee
    this.meleeT -= dt;
    if (!this.vehicleId && !this.enter && can && inp.locked && inp.mouseWasPressed(0) && this.meleeT <= 0) {
      this.meleeT = 0.6;
      this.meleePending = 0.18;
      this.character.playOnce(Math.random() < 0.5 ? 'punch' : 'jab');
    }
    if (this.meleePending > 0) {
      this.meleePending -= dt;
      if (this.meleePending <= 0) this.resolveMelee();
    }
    // Honk
    if (this.vehicleId && can && inp.wasPressed('KeyH')) {
      const v = this.vehicles.vehicles.get(this.vehicleId)!;
      playSound(g, 'horn', { at: v3(v.position), volume: 0.9 });
      g.events.emit('noise', { p: [v.position.x, v.position.z], radius: 45, kind: 'horn' });
    }
    // Regen
    if (this.health < 100 && g.elapsed - this.lastDamage > 6) this.health = Math.min(100, this.health + dt * 4);
    // Footsteps (two per cycle)
    if (!this.vehicleId && this.grounded && this.groundSpeed > 0.6) {
      const ph = this.character.stepPhase;
      const half = ph < 0.5 ? 0 : 1;
      if (half !== this.lastStep) {
        this.lastStep = half;
        const vol = this.crouching ? 0.12 : this.sprinting ? 0.6 : 0.35;
        playSound(g, 'footstep', { at: [this.position.x, this.position.y, this.position.z], volume: vol, rate: 0.9 + Math.random() * 0.2 });
        if (this.sprinting) g.events.emit('noise', { p: [this.position.x, this.position.z], radius: 7, kind: 'footsteps' });
      }
    }
  }

  lateUpdate(dt: number) {
    if (this.vehicleId) {
      const v = this.vehicles.vehicles.get(this.vehicleId);
      if (v) {
        this.position.copy(v.position);
        this.velocity.copy(v.velocity);
        this.heading = v.heading;
      }
      this.character.root.visible = false;
      return;
    }
    const t = this.body.translation();
    this.position.set(t.x, t.y - CENTER, t.z);
    const root = this.character.root;
    root.visible = true;
    root.position.copy(this.position);
    root.rotation.y = -this.heading;
    const pose: Pose = this.busy ? (this.pose === 'none' ? 'interact' : this.pose) : 'none';
    this.character.update(dt, { speed: this.groundSpeed, grounded: this.grounded, crouch: this.crouching, vy: this.vy, pose });
  }

  // ------------------------------------------------------------------ vehicles
  private tryEnter() {
    const v = this.vehicles.nearestEnterable(this.position, 2.6);
    if (!v) return;
    if (Math.abs(v.speed) > 4.5 && v.driver === 'ai') {
      this.g.events.emit('toast', { text: 'Too fast to jack', kind: 'warn', ms: 1200 });
      return;
    }
    const carjack = v.driver === 'ai';
    const stolen = !v.stolen;
    this.enter = { veh: v, t: 0, phase: 'approach', stolen, carjack };
    if (carjack) { v.control.brake = 1; v.control.throttle = 0; }
  }

  private enterStep(dt: number) {
    const e = this.enter!;
    const v = e.veh;
    e.t += dt;
    const door = v.model.driverDoor.clone().applyMatrix4(v.object.matrixWorld);
    const t = this.body.translation();
    const cur = new THREE.Vector3(t.x, t.y - CENTER, t.z);
    if (e.phase === 'approach') {
      const to = door.clone().sub(cur).setY(0);
      const d = to.length();
      if (d < 0.35 || e.t > 1.1) { e.phase = 'door'; e.t = 0; playSound(this.g, 'door', { at: v3(door), volume: 0.7 }); }
      else {
        to.setLength(Math.min(d, SPEED.jog * dt));
        this.vy -= GRAVITY * dt;
        if (this.grounded && this.vy < 0) this.vy = -1;
        this.kcc.computeColliderMovement(this.collider, { x: to.x, y: this.vy * dt, z: to.z }, undefined, undefined, (c) => !c.isSensor() && this.vehicles.colliderMap.get(c.handle) !== v);
        const mv = this.kcc.computedMovement();
        this.grounded = this.kcc.computedGrounded();
        this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
        this.groundSpeed = SPEED.jog * 0.8;
        this.heading = lerpAngle(this.heading, Math.atan2(to.x, -to.z), 0.3);
      }
    } else {
      // Face the car and "open the door", then get in.
      this.groundSpeed = damp(this.groundSpeed, 0, 10, dt);
      this.heading = lerpAngle(this.heading, v.heading + Math.PI / 2, 0.2);
      if (e.t > 0.35) this.seat(v, e);
    }
  }

  private seat(v: Vehicle, e: NonNullable<EnterState>) {
    const g = this.g;
    this.enter = null;
    if (v.physicsMode === 'kinematic') v.makeDynamic();
    if (e.carjack) {
      g.events.emit('crime', { kind: 'carjack', p: [v.position.x, v.position.z], severity: 3 });
      g.events.emit('toast', { text: 'Carjacked!', kind: 'bad', ms: 1400 });
    } else if (e.stolen) {
      g.events.emit('crime', { kind: 'carjack', p: [v.position.x, v.position.z], severity: 1 });
    }
    v.driver = 'player';
    v.crashed = false;
    v.stolen = true;
    v.control.throttle = v.control.brake = v.control.steer = 0;
    v.control.handbrake = false;
    v.body.wakeUp();
    this.vehicleId = v.id;
    this.collider.setEnabled(false);
    this.crouching = false;
    playSound(g, 'door', { at: v3(v.position), volume: 0.8, rate: 0.9 });
    g.events.emit('playerEnterVehicle', { vehicleId: v.id, stolen: true });
    this.engine = playSound(g, 'engine', { at: v3(v.position), loop: true, volume: 0.55, rate: 0.7 });
  }

  exitVehicle(force: boolean) {
    const g = this.g;
    const v = this.vehicleId ? this.vehicles.vehicles.get(this.vehicleId) : undefined;
    const id = this.vehicleId;
    this.vehicleId = null;
    this.engine?.stop(); this.engine = null;
    this.squeal?.stop(); this.squeal = null;
    if (!v || !id) { this.collider.setEnabled(true); return; }
    v.driver = 'none';
    v.control.throttle = 0; v.control.brake = 0; v.control.steer = 0; v.control.handbrake = true;
    // Find a free spot: driver side, passenger side, then roof.
    const spots = [v.model.driverDoor.clone(), v.model.driverDoor.clone().setX(-v.model.driverDoor.x), new THREE.Vector3(0, v.model.roofY + 0.2, 0)];
    let out = spots[0].applyMatrix4(v.object.matrixWorld);
    for (const s of spots) {
      const w = s.clone().applyMatrix4(v.object.matrixWorld);
      if (s.y === 0) w.y = Math.max(w.y, this.groundAt(w.x, w.z, v.position.y));
      if (force || this.spotFree(w)) { out = w; break; }
    }
    this.collider.setEnabled(true);
    this.body.setTranslation({ x: out.x, y: out.y + CENTER + 0.05, z: out.z }, true);
    this.body.setNextKinematicTranslation({ x: out.x, y: out.y + CENTER + 0.05, z: out.z });
    this.position.copy(out);
    this.heading = v.heading - Math.PI / 2;
    this.hvel.set(0, 0, 0);
    const vs = v.velocity.clone().setY(0);
    if (vs.length() > 3) this.hvel.copy(vs).multiplyScalar(0.5);
    this.vy = 0;
    if (this.camera) this.camera.yaw = v.heading;
    playSound(g, 'door', { at: v3(v.position), volume: 0.8 });
    g.events.emit('playerExitVehicle', { vehicleId: id });
  }

  private spotFree(p: THREE.Vector3) {
    const R = this.g.rapier;
    const shape = new R.Capsule(HALF, RADIUS);
    let blocked = false;
    this.g.physics.intersectionsWithShape({ x: p.x, y: p.y + CENTER + 0.05, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
      if (c.handle === this.collider.handle || c.isSensor()) return true;
      blocked = true;
      return false;
    });
    return !blocked;
  }

  private driveInput(_dt: number, can: boolean) {
    const v = this.vehicles.vehicles.get(this.vehicleId!);
    if (!v) { this.vehicleId = null; this.collider.setEnabled(true); return; }
    const inp = this.g.input;
    const c = v.control;
    if (!can) { c.throttle = 0; c.brake = 0.3; c.steer = 0; c.handbrake = false; return; }
    c.throttle = inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0;
    c.brake = inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0;
    c.steer = (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0);
    c.handbrake = inp.isDown('Space');
    if (inp.wasPressed('KeyR') && (v.object.up.clone().applyQuaternion(v.object.quaternion).y < 0.6 || Math.abs(v.speed) < 1)) v.flipUpright();
  }

  private vehicleAudio(dt: number) {
    const v = this.vehicles.vehicles.get(this.vehicleId!);
    if (!v) return;
    const p = v3(v.position);
    if (v.destroyed) { this.engine?.stop(); this.engine = null; }
    if (this.engine) {
      this.engine.setRate(0.6 + v.rpm * 1.5);
      this.engine.setVolume(0.35 + v.control.throttle * 0.3);
      this.engine.setPosition(p);
    }
    const sq = v.physicsMode === 'dynamic' && (v.slip > 0.28 && Math.abs(v.speed) > 7 || (v.control.handbrake && Math.abs(v.speed) > 8));
    if (sq && !this.squeal) this.squeal = playSound(this.g, 'tire-squeal', { at: p, loop: true, volume: 0.5 });
    if (!sq && this.squeal) { this.squeal.stop(); this.squeal = null; }
    if (this.squeal) { this.squeal.setPosition(p); this.squeal.setVolume(clamp(v.slip * 1.2, 0.2, 0.8)); }
    void dt;
  }

  private resolveMelee() {
    const g = this.g, R = g.rapier;
    const f = headingToDir(this.heading);
    const c = this.position.clone().addScaledVector(f, 0.75).setY(this.position.y + 1.1);
    g.events.emit('playerMelee', { p: [this.position.x, this.position.z], dir: [f.x, f.z], range: 1.3 });
    let hitSomething = false;
    g.physics.intersectionsWithShape({ x: c.x, y: c.y, z: c.z }, { x: 0, y: 0, z: 0, w: 1 }, new R.Ball(0.55), (col) => {
      if (col.handle === this.collider.handle || col.isSensor()) return true;
      const b = col.parent();
      if (!b || b.isFixed()) return true;
      if (this.vehicles.colliderMap.has(col.handle)) {
        playSound(g, 'crash', { at: v3(c), volume: 0.15, rate: 1.6 });
        return true;
      }
      hitSomething = true;
      if (b.isDynamic()) b.applyImpulse({ x: f.x * 120, y: 40, z: f.z * 120 }, true);
      return true;
    });
    if (hitSomething) {
      g.events.emit('crime', { kind: 'assault', p: [this.position.x, this.position.z], severity: 2 });
      g.events.emit('noise', { p: [this.position.x, this.position.z], radius: 12, kind: 'fight' });
    }
  }
}
