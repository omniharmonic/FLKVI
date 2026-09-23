// A single vehicle: visual + physics (dynamic raycast vehicle, or kinematic for AI traffic).
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../../core/game';
import type { VehicleHandle } from '../../core/api';
import type { CarModel } from './carModels';
import { createVehicleVisual, type VehicleVisual } from './visual';
import { clamp, damp, groundY, wrapAngle } from '../util';

export type PhysicsMode = 'dynamic' | 'kinematic';

export interface Tuning {
  mass: number;
  engine: number; // N at low speed
  maxSpeed: number; // m/s
  brake: number;
  steerMax: number;
  grip: number; // friction slip
  stiffness: number;
  rest: number;
  downforce: number;
}

export function tuningFor(model: CarModel): Tuning {
  const base = model.spec;
  const t: Tuning = { mass: 1450, engine: 9500, maxSpeed: 42, brake: 55, steerMax: 0.6, grip: 1.55, stiffness: 28, rest: 0.26, downforce: 2.2 };
  switch (model.id) {
    case 'sports': Object.assign(t, { mass: 1350, engine: 15000, maxSpeed: 52, grip: 1.85, stiffness: 36, rest: 0.2, downforce: 3.2 }); break;
    case 'suv': case 'police-suv': Object.assign(t, { mass: 2000, engine: 12000, maxSpeed: 40, grip: 1.4, stiffness: 24, rest: 0.3 }); break;
    case 'pickup': Object.assign(t, { mass: 2200, engine: 12500, maxSpeed: 40, grip: 1.35, stiffness: 22, rest: 0.32 }); break;
    case 'van': Object.assign(t, { mass: 2300, engine: 11000, maxSpeed: 36, grip: 1.3, stiffness: 24, rest: 0.28 }); break;
    case 'hatchback': Object.assign(t, { mass: 1250, engine: 8500, maxSpeed: 40, grip: 1.55 }); break;
    case 'police': Object.assign(t, { mass: 1700, engine: 13500, maxSpeed: 48, grip: 1.75 }); break;
  }
  void base;
  return t;
}

/** Top speed of each forward gear as a fraction of the model's max speed (6-speed auto). */
const GEAR_TOPS = [0.26, 0.44, 0.62, 0.78, 0.92, 1.08];

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(), _right = new THREE.Vector3(), _w = new THREE.Vector3();

export class Vehicle implements VehicleHandle {
  id: string;
  kind: 'civilian' | 'police' | 'player';
  object: THREE.Object3D;
  position = new THREE.Vector3();
  heading = 0;
  speed = 0;
  control = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  driver: 'player' | 'ai' | 'none' = 'none';
  siren = false;
  flagged = false;
  destroyed = false;
  /** Extra (not in the core contract): */
  model: CarModel;
  modelId: string;
  color: string;
  visual: VehicleVisual;
  physicsMode: PhysicsMode;
  /** Set when a kinematic AI car got knocked into dynamic physics by a crash. AI should stop steering it. */
  crashed = false;
  /** 0..100; smoke under 45, disabled at 0. */
  health = 100;
  /** Parking slot this vehicle was promoted from (for demotion back to instancing). */
  parkedSlot: { model: string; index: number } | null = null;
  /** Player has driven this car (so it counts as stolen / plate-trackable). */
  stolen = false;
  body!: RAPIER_NS.RigidBody;
  colliders: RAPIER_NS.Collider[] = [];
  controller: RAPIER_NS.DynamicRayCastVehicleController | null = null;
  tuning: Tuning;
  velocity = new THREE.Vector3();
  prevVelocity = new THREE.Vector3();
  /** World-space linear acceleration magnitude of the last step (impact detection). */
  lastImpact = 0;
  lastImpactDir = new THREE.Vector3();
  steerAngle = 0;
  private spin = [0, 0, 0, 0];
  private connY: number;
  private lastHeading = 0;
  private visRoll = 0;
  private visPitch = 0;
  private lastSpeed = 0;
  braking = false;
  reversing = false;
  headlights = false;
  flipTimer = 0;
  /** Normalized engine speed 0..1 (idle ≈ 0.18, redline 1) from the simulated gearbox. */
  rpm = 0;
  /** Current gear (−1 reverse, 1..N). */
  gear = 1;
  /** > 0 while a gear change is in progress (drive force cut). */
  shiftT = 0;
  slip = 0;
  /** Throttle + brake held at a standstill: rear wheels spin in place. */
  burnout = false;
  /** Seconds the driver has been pushing against something without moving. */
  stuckT = 0;
  /** Seconds since spawn/last touched (for parked demotion). */
  idleTime = 0;
  /** Turn signal: −1 left, 1 right, 2 hazards, 0 off. */
  signal = 0;
  private signalHold = 0;
  /** Night headlight ground pool on (set by the manager for nearby cars). */
  beam = false;
  /** Lateral / longitudinal acceleration (m/s², car frame; + = right / forward), smoothed. */
  latG = 0;
  lonG = 0;

  constructor(private g: Game, opts: { id: string; kind: 'civilian' | 'police'; model: CarModel; color: string; seed: number; x: number; z: number; heading: number; y?: number; mode: PhysicsMode; colliderMap: Map<number, Vehicle> }) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.model = opts.model;
    this.modelId = opts.model.id;
    this.color = opts.color;
    this.tuning = tuningFor(opts.model);
    this.visual = createVehicleVisual(opts.model, opts.color, opts.seed);
    this.object = this.visual.root;
    this.object.userData.vehicleId = this.id;
    this.physicsMode = opts.mode;
    const eq = 9.81 / (4 * this.tuning.stiffness);
    this.connY = opts.model.wheelR + this.tuning.rest - eq;
    const y = opts.y ?? groundY(g, opts.x, opts.z);
    this.position.set(opts.x, y, opts.z);
    this.heading = opts.heading;
    this.lastHeading = opts.heading;
    this.createBody(opts.mode, opts.colliderMap);
    this.syncVisualFromHandle(0);
  }

  get rapier() { return this.g.rapier; }

  private createBody(mode: PhysicsMode, map: Map<number, Vehicle>) {
    const R = this.rapier;
    const m = this.model;
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading);
    const desc = mode === 'dynamic' ? R.RigidBodyDesc.dynamic() : R.RigidBodyDesc.kinematicPositionBased();
    desc.setTranslation(this.position.x, this.position.y + (mode === 'dynamic' ? 0.05 : 0), this.position.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(0.05).setAngularDamping(0.6).setCanSleep(true)
      .setCcdEnabled(mode === 'dynamic');
    this.body = this.g.physics.createRigidBody(desc);
    const t = this.tuning;
    const hx = m.colHalf.x, hy = m.colHalf.y, hz = m.colHalf.z;
    // Main hull collider carries all the mass, with a low center of mass for stability.
    const Ix = (t.mass / 12) * (4 * hy * hy + 4 * hz * hz), Iy = (t.mass / 12) * (4 * hx * hx + 4 * hz * hz), Iz = (t.mass / 12) * (4 * hx * hx + 4 * hy * hy);
    const main = R.ColliderDesc.roundCuboid(hx - 0.06, hy - 0.06, hz - 0.06, 0.06)
      .setTranslation(m.colCenter.x, m.colCenter.y, m.colCenter.z)
      .setMassProperties(t.mass, { x: 0, y: 0.42 - m.colCenter.y + 0.0, z: 0 }, { x: Ix, y: Iy * 1.1, z: Iz }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.4).setRestitution(0.1)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS);
    const c1 = this.g.physics.createCollider(main, this.body);
    const cab = R.ColliderDesc.roundCuboid(Math.max(0.1, m.cabHalf.x - 0.05), Math.max(0.05, m.cabHalf.y - 0.05), Math.max(0.1, m.cabHalf.z - 0.05), 0.05)
      .setTranslation(m.cabCenter.x, m.cabCenter.y, m.cabCenter.z)
      .setDensity(0).setFriction(0.3);
    const c2 = this.g.physics.createCollider(cab, this.body);
    this.colliders = [c1, c2];
    for (const c of this.colliders) map.set(c.handle, this);
    if (mode === 'dynamic') this.createController();
  }

  private createController() {
    if (this.controller) return;
    const t = this.tuning, m = this.model;
    const vc = this.g.physics.createVehicleController(this.body);
    this.controller = vc;
    (vc as any).setIndexForwardAxis = 2; // chassis forward axis = local Z (car faces −Z; see sign handling)
    for (let i = 0; i < 4; i++) {
      const p = m.wheelPos[i];
      vc.addWheel({ x: p.x, y: this.connY, z: p.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, t.rest, m.wheelR);
      vc.setWheelSuspensionStiffness(i, t.stiffness);
      vc.setWheelSuspensionCompression(i, 2.6);
      vc.setWheelSuspensionRelaxation(i, 3.2);
      vc.setWheelMaxSuspensionTravel(i, t.rest * 0.95);
      vc.setWheelMaxSuspensionForce(i, t.mass * 9.81 * 6);
      vc.setWheelFrictionSlip(i, t.grip);
      vc.setWheelSideFrictionStiffness(i, 1.0);
    }
  }

  /** Switch a kinematic car into full dynamic physics (e.g. after a hard crash). */
  makeDynamic() {
    if (this.physicsMode === 'dynamic') return;
    const R = this.rapier;
    this.physicsMode = 'dynamic';
    this.body.setBodyType(R.RigidBodyType.Dynamic, true);
    this.body.enableCcd(true);
    this.createController();
    const f = new THREE.Vector3(Math.sin(this.heading), 0, -Math.cos(this.heading)).multiplyScalar(this.speed);
    this.body.setLinvel({ x: f.x, y: 0, z: f.z }, true);
  }

  /** Hand a (stopped) dynamic car back to kinematic AI control at its current pose. */
  makeKinematic() {
    if (this.physicsMode === 'kinematic') return;
    const R = this.rapier;
    if (this.controller) { this.g.physics.removeVehicleController(this.controller); this.controller = null; }
    this.physicsMode = 'kinematic';
    this.crashed = false;
    this.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
  }

  // ---------------------------------------------------------------- simulation

  fixedUpdate(dt: number) {
    if (this.physicsMode === 'kinematic') return this.fixedKinematic(dt);
    const vc = this.controller!;
    const body = this.body;
    const t = this.tuning;
    const R = this.rapier;
    // Rapier user forces persist across steps: clear last step's assists before adding new ones.
    body.resetForces(false);
    body.resetTorques(false);
    const q = body.rotation();
    _q.set(q.x, q.y, q.z, q.w);
    _fwd.set(0, 0, -1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const lv = body.linvel();
    const vel = _v.set(lv.x, lv.y, lv.z);
    const fwdSpeed = vel.dot(_fwd);
    const ctl = this.control;
    const dead = this.destroyed || this.health <= 0;
    const driven = this.driver !== 'none' && !dead;
    let throttle = driven ? clamp(ctl.throttle, 0, 1) : 0;
    let brakeIn = driven ? clamp(ctl.brake, 0, 1) : 0;
    this.burnout = driven && this.driver === 'player' && throttle > 0.5 && brakeIn > 0.5 && Math.abs(fwdSpeed) < 3;
    // Brake key acts as reverse once (nearly) stopped.
    let reverse = 0;
    if (brakeIn > 0.1 && fwdSpeed < 1.0 && throttle < 0.1) { reverse = brakeIn; brakeIn = 0; }
    if (throttle > 0.1 && fwdSpeed < -1.0) { brakeIn = Math.max(brakeIn, throttle); throttle = 0; }
    const spd = Math.abs(fwdSpeed);
    // Engine force with a smooth fall-off to top speed.
    const topFrac = clamp(spd / t.maxSpeed, 0, 1);
    let engine = throttle * t.engine * (1 - topFrac * topFrac * topFrac) * (spd < 8 ? 1.15 : 1);
    if (reverse > 0) engine = -reverse * t.engine * 0.55 * (fwdSpeed < -12 ? 0 : 1);
    // Pushing against something (parked car, curb, wall) without moving: progressively more torque so the
    // player can shove free or reverse out instead of being pinned.
    if (driven && (throttle > 0.5 || reverse > 0.5) && spd < 0.8) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    engine *= 1 + Math.min(1.6, this.stuckT * 1.2);
    // Gear change: brief drive cut.
    if (this.shiftT > 0) engine *= 0.3;
    if (this.burnout) { engine = 0; brakeIn = 1; }
    // Engine force sign: forward axis is local +Z, our car faces −Z.
    const ef = -engine / 2;
    const hb = driven && ctl.handbrake;
    const parked = this.driver === 'none';
    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      // Note: Rapier ignores the brake impulse on a wheel whose engine force is non-zero.
      let b = brakeIn * t.brake * (rear ? 0.8 : 1.2);
      if (rear && hb) b = t.brake * 1.6;
      if (dead) b = t.brake * 0.8;
      else if (parked) b = 14; // parking brake: holds on slopes but a car can still be shoved
      if (!driven && !parked) b = Math.max(b, 6);
      if (throttle < 0.05 && reverse === 0 && brakeIn === 0 && driven) b = Math.max(b, 1.2); // engine braking
      // ef is half the total drive force; split 60/40 rear/front (sports: pure RWD).
      const rwd = this.model.id === 'sports';
      const e = (rear && hb) || brakeIn > 0.05 || !driven ? 0 : rwd ? (rear ? ef : 0) : rear ? ef * 0.6 : ef * 0.4;
      vc.setWheelEngineForce(i, e);
      vc.setWheelBrake(i, e !== 0 ? 0 : b);
      const grip = t.grip * (rear && hb ? 0.55 : 1) * (rear && throttle > 0.9 && spd < 10 && this.model.id === 'sports' ? 0.8 : 1);
      vc.setWheelFrictionSlip(i, grip);
      vc.setWheelSideFrictionStiffness(i, rear && hb ? 0.75 : 1.0);
    }
    // Speed-sensitive steering with smoothing.
    const steerMax = t.steerMax / (1 + spd / 8);
    const target = (driven ? clamp(ctl.steer, -1, 1) : 0) * steerMax;
    const rate = Math.sign(target - this.steerAngle) !== Math.sign(this.steerAngle) ? 7 : 3.5;
    this.steerAngle += clamp(target - this.steerAngle, -rate * dt, rate * dt);
    // Positive steer = turn right. Rapier steering rotates about local up; sign flipped for −Z forward.
    vc.setWheelSteering(0, -this.steerAngle);
    vc.setWheelSteering(1, -this.steerAngle);
    vc.updateVehicle(dt, undefined, undefined, (c) => !this.ignoreRay(c));

    // --- Arcade assists ---
    const grounded = this.wheelsOnGround();
    const mass = t.mass;
    if (grounded >= 2 && (driven || spd > 2)) {
      // Downforce
      const df = t.downforce * spd * spd * mass * 0.001;
      body.addForce({ x: -_up.x * df, y: -_up.y * df, z: -_up.z * df }, true);
      // Anti-roll: damp roll rate + restore toward level.
      const av = body.angvel();
      const w = _w.set(av.x, av.y, av.z);
      const rollRate = w.dot(_fwd);
      const rollAngle = Math.asin(clamp(_right.y, -1, 1));
      const kRoll = -(rollRate * 0.35 + rollAngle * 1.2) * mass;
      body.addTorque({ x: _fwd.x * kRoll, y: _fwd.y * kRoll, z: _fwd.z * kRoll }, true);
      const pitchRate = w.dot(_right);
      const kPitch = -pitchRate * 0.25 * mass;
      body.addTorque({ x: _right.x * kPitch, y: _right.y * kPitch, z: _right.z * kPitch }, true);
      // Yaw: stability when gripping; drift help with handbrake.
      const yawRate = w.dot(_up);
      const lat = vel.dot(_right);
      this.slip = spd > 3 ? Math.abs(lat) / Math.max(3, Math.hypot(lat, fwdSpeed)) : 0;
      if (hb && driven && spd > 6) {
        // Handbrake: rotate into the drift, but cap the yaw rate so it stays controllable.
        const kick = ctl.steer * -1.0 * mass * Math.min(1, spd / 15);
        const cap = Math.abs(yawRate) > 1.3 ? -Math.sign(yawRate) * (Math.abs(yawRate) - 1.3) * 4 * mass : 0;
        const k = kick + cap;
        body.addTorque({ x: _up.x * k, y: _up.y * k, z: _up.z * k }, true);
      } else if (driven) {
        // Counter excessive yaw not asked for by steering (prevents spin-outs), weak so drifts can be held.
        const wantYaw = -this.steerAngle * fwdSpeed / 2.8;
        let k = -(yawRate - wantYaw) * 0.7 * mass * clamp(spd / 10, 0, 1);
        // Drift recovery: swing the nose back toward the direction of travel (auto counter-steer).
        if (fwdSpeed > 4 && this.slip > 0.15) {
          const beta = Math.atan2(lat, fwdSpeed); // + = sliding right
          k += -beta * 1.6 * mass * clamp(spd / 12, 0, 1);
        }
        body.addTorque({ x: _up.x * k, y: _up.y * k, z: _up.z * k }, true);
        // Lateral grip assist at speed: bleed sideways velocity a bit.
        const latF = -lat * mass * 0.9 * clamp(spd / 12, 0, 1) * (this.slip > 0.35 ? 0.4 : 1);
        body.addForce({ x: _right.x * latF, y: 0, z: _right.z * latF }, true);
      }
    } else {
      // Air: mild self-righting and damping.
      const av = body.angvel();
      body.setAngvel({ x: av.x * 0.985, y: av.y * 0.99, z: av.z * 0.985 }, true);
    }
    void R;
    this.reversing = reverse > 0 && fwdSpeed < 0.5;
    this.braking = driven && (brakeIn > 0.1 || (hb && spd > 1));
    // Auto-flip when stuck upside down / on the side.
    if (_up.y < 0.35 && spd < 2) {
      this.flipTimer += dt;
      if (this.flipTimer > 2.5 && this.driver === 'player') this.flipUpright();
    } else this.flipTimer = 0;
    this.updateGearbox(dt, spd, fwdSpeed, throttle, reverse, grounded);
  }

  /** Simulated automatic gearbox: RPM from wheel speed × ratio, upshift near redline with an RPM drop. */
  private updateGearbox(dt: number, spd: number, fwdSpeed: number, throttle: number, reverse: number, grounded: number) {
    const top = this.tuning.maxSpeed;
    const tops = GEAR_TOPS.map((f) => f * top);
    this.shiftT = Math.max(0, this.shiftT - dt);
    if (reverse > 0 || fwdSpeed < -0.5) this.gear = -1;
    else if (this.gear < 1) this.gear = 1;
    let target: number;
    if (this.burnout) target = 0.9 + Math.sin(this.g.elapsed * 40) * 0.05;
    else if (grounded < 2) target = throttle > 0.1 ? 0.95 : 0.3; // airborne: free rev
    else {
      const gt = this.gear < 0 ? tops[0] : tops[this.gear - 1];
      target = 0.18 + 0.82 * clamp(spd / gt, 0, 1.05);
      if (this.gear > 0 && this.shiftT <= 0) {
        if (target > 0.93 && this.gear < tops.length && throttle > 0.1) { this.gear++; this.shiftT = 0.22; }
        else if (this.gear > 1 && spd < tops[this.gear - 2] * (throttle > 0.5 ? 0.78 : 0.5)) { this.gear--; this.shiftT = 0.12; }
      }
      // Clutch slip at launch.
      if (throttle > 0.1 && spd < 4 && this.gear <= 1) target = Math.max(target, 0.45 + throttle * 0.2);
      if (reverse > 0 && spd < 3) target = Math.max(target, 0.4);
    }
    this.rpm = damp(this.rpm, clamp(target, 0.15, 1.02), this.shiftT > 0 ? 18 : 9, dt);
  }

  flipUpright() {
    const t = this.body.translation();
    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.heading);
    // Reset in place, or nudge to the nearest clear spot if we're wedged into something.
    const R = this.rapier, m = this.model;
    const shape = new R.Cuboid(m.colHalf.x, m.colHalf.y, m.colHalf.z);
    const f = new THREE.Vector3(Math.sin(this.heading), 0, -Math.cos(this.heading)), r = new THREE.Vector3(-f.z, 0, f.x);
    let px = t.x, pz = t.z;
    for (const [a, b] of [[0, 0], [0, -3], [0, 3], [-2.2, 0], [2.2, 0], [-2.2, -3], [2.2, -3], [0, -6], [0, 6]]) {
      const x = t.x + r.x * a + f.x * b, z = t.z + r.z * a + f.z * b;
      const y = groundY(this.g, x, z) + 0.6 + m.colCenter.y;
      let hit = false;
      this.g.physics.intersectionsWithShape({ x, y, z }, { x: rot.x, y: rot.y, z: rot.z, w: rot.w }, shape, (c) => {
        if (this.colliders.includes(c) || c.isSensor()) return true;
        hit = true;
        return false;
      });
      if (!hit) { px = x; pz = z; break; }
    }
    this.body.setTranslation({ x: px, y: groundY(this.g, px, pz) + 0.6, z: pz }, true);
    this.body.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flipTimer = 0;
  }

  /** Colliders the wheel rays should pass through (characters, pedestrians, own hull). */
  ignoreRay: (c: RAPIER_NS.Collider) => boolean = () => false;

  wheelsOnGround() {
    let n = 0;
    if (!this.controller) return 4;
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) n++;
    return n;
  }

  private fixedKinematic(dt: number) {
    // AI writes position.x/z + heading; we follow terrain.
    const x = this.position.x, z = this.position.z;
    const y = groundY(this.g, x, z);
    this.position.y = y;
    const L = this.model.spec.axleR - this.model.spec.axleF;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const yf = groundY(this.g, x + fx * L / 2, z + fz * L / 2), yr = groundY(this.g, x - fx * L / 2, z - fz * L / 2);
    const pitch = Math.atan2(yf - yr, L);
    _e.set(pitch, -this.heading, 0, 'YXZ');
    _q.setFromEuler(_e);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.body.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    const dh = wrapAngle(this.heading - this.lastHeading);
    this.lastHeading = this.heading;
    const yawRate = dh / dt;
    const accel = (this.speed - this.lastSpeed) / dt;
    this.lastSpeed = this.speed;
    this.braking = accel < -1.5 || (this.control.brake > 0.1);
    this.reversing = this.speed < -0.3;
    // Visual steering from yaw rate (bicycle model) or AI control.
    const steer = Math.abs(this.speed) > 0.5 ? Math.atan(yawRate * L / this.speed) : this.control.steer * 0.5;
    this.steerAngle = damp(this.steerAngle, clamp(steer, -0.6, 0.6), 10, dt);
    // Visual body roll/pitch from accelerations.
    this.visRoll = damp(this.visRoll, clamp(yawRate * this.speed * 0.006, -0.05, 0.05), 5, dt);
    this.visPitch = damp(this.visPitch, clamp(-accel * 0.004, -0.03, 0.03), 5, dt);
    this.velocity.set(fx * this.speed, 0, fz * this.speed);
  }

  // ---------------------------------------------------------------- visuals

  /** Pull physics state into the handle + visuals. */
  sync(dt: number) {
    if (this.physicsMode === 'dynamic') {
      const t = this.body.translation();
      const r = this.body.rotation();
      this.object.position.set(t.x, t.y, t.z);
      this.object.quaternion.set(r.x, r.y, r.z, r.w);
      this.position.set(t.x, t.y, t.z);
      _fwd.set(0, 0, -1).applyQuaternion(this.object.quaternion);
      this.heading = Math.atan2(_fwd.x, -_fwd.z);
      const lv = this.body.linvel();
      this.prevVelocity.copy(this.velocity);
      this.velocity.set(lv.x, lv.y, lv.z);
      this.speed = this.velocity.dot(_fwd);
      const vc = this.controller!;
      for (let i = 0; i < 4; i++) {
        const w = this.visual.wheels[i];
        const len = vc.wheelSuspensionLength(i) ?? this.tuning.rest;
        w.position.y = this.connY - len;
        w.rotation.y = i < 2 ? this.steerAngle * -1 * -1 : 0;
        w.rotation.y = i < 2 ? -this.steerAngle : 0;
        const spin = w.children[0];
        const ws = this.burnout && i >= 2 ? 30 : (this.speed / this.model.wheelR) * (this.braking && this.control.handbrake && i >= 2 ? 0 : 1);
        this.spin[i] -= ws * dt;
        spin.rotation.x = this.spin[i];
      }
      // Visual body roll / dive / squat on top of the physical suspension (reads as weight transfer).
      if (dt > 0) {
        _right.set(1, 0, 0).applyQuaternion(this.object.quaternion);
        const ax = (this.velocity.x - this.prevVelocity.x) / dt, az = (this.velocity.z - this.prevVelocity.z) / dt;
        const lat = clamp(ax * _right.x + az * _right.z, -25, 25), lon = clamp(-(ax * _fwd.x + az * _fwd.z) * -1, -25, 25);
        this.latG = damp(this.latG, lat, 6, dt);
        this.lonG = damp(this.lonG, lon, 6, dt);
      }
      const k = this.model.id === 'sports' ? 0.55 : this.model.id === 'van' || this.model.id === 'pickup' || this.model.id.includes('suv') ? 1.35 : 1;
      this.visRoll = damp(this.visRoll, clamp(this.latG * 0.0042 * k, -0.065, 0.065), 8, dt);
      this.visPitch = damp(this.visPitch, clamp(this.lonG * 0.0032 * k, -0.045, 0.045), 8, dt);
      // Pivot roughly around the axle line at ground so the body doesn't slide off its wheels.
      this.visual.chassis.rotation.set(this.visPitch, 0, this.visRoll);
    } else this.syncVisualFromHandle(dt);
    this.updateSignal(dt);
    this.visual.setDriver(this.driver !== 'none' && !this.destroyed);
    this.visual.setLights({ head: this.headlights, brake: this.braking, reverse: this.reversing, siren: !!this.siren, t: this.g.elapsed, signal: this.signal, beam: this.beam });
  }

  private updateSignal(dt: number) {
    if (this.destroyed || (this.crashed && this.driver !== 'player') || (this.driver === 'none' && this.health < 60)) { this.signal = 2; return; }
    if (this.driver !== 'ai') { this.signal = 0; this.signalHold = 0; return; }
    // AI: use explicit steer intent if the AI provides it, else the turn we're in (yaw rate).
    const intent = Math.abs(this.control.steer) > 0.2 ? Math.sign(this.control.steer) : Math.abs(this.steerAngle) > 0.12 && Math.abs(this.speed) < 14 ? Math.sign(this.steerAngle) : 0;
    if (intent) { this.signal = intent; this.signalHold = 1.4; }
    else if ((this.signalHold -= dt) <= 0) this.signal = 0;
  }

  private syncVisualFromHandle(dt: number) {
    this.object.position.copy(this.position);
    const L = this.model.spec.axleR - this.model.spec.axleF;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const yf = groundY(this.g, this.position.x + fx * L / 2, this.position.z + fz * L / 2);
    const yr = groundY(this.g, this.position.x - fx * L / 2, this.position.z - fz * L / 2);
    _e.set(Math.atan2(yf - yr, L), -this.heading, 0, 'YXZ');
    this.object.quaternion.setFromEuler(_e);
    this.visual.chassis.rotation.set(this.visPitch, 0, this.visRoll);
    for (let i = 0; i < 4; i++) {
      const w = this.visual.wheels[i];
      w.position.y = this.model.wheelR;
      w.rotation.y = i < 2 ? -this.steerAngle : 0;
      this.spin[i] -= (this.speed / this.model.wheelR) * dt;
      w.children[0].rotation.x = this.spin[i];
    }
  }

  dispose(colliderMap: Map<number, Vehicle>) {
    for (const c of this.colliders) colliderMap.delete(c.handle);
    if (this.controller) this.g.physics.removeVehicleController(this.controller);
    this.g.physics.removeRigidBody(this.body);
    this.object.removeFromParent();
  }
}
