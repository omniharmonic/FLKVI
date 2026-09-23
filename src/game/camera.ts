// Third-person camera: over-the-shoulder orbit on foot, chase cam in vehicles. Collision via Rapier rays.
import * as THREE from 'three';
import type { Game, System } from '../core/game';
import type { Player } from './player';
import type { VehicleSystem } from './vehicles/manager';
import { clamp, damp, headingToDir, lerpAngle, wrapAngle } from './util';
import { settings, reducedMotion } from '../ui/settings';

const SENS = 0.0022;

export class CameraRig implements System {
  name = 'camera';
  order = 90;
  /** Look heading (util.ts convention) and pitch (+ = looking down). */
  yaw = 0;
  pitch = 0.18;
  private dist = 4.2;
  private zoom = 1;
  private curDist = 4.2;
  private pivot = new THREE.Vector3();
  private pivotInit = false;
  private trauma = 0;
  private fov = 62;
  private idleMouse = 10;
  private vehYawOffset = 0;
  private lookBack = 0;
  private lastVeh: string | null = null;
  private shakeT = 0;
  /** Lateral-G sway (m, along camera right) and roll (rad) while driving. */
  private sway = 0;
  private roll = 0;

  constructor(private g: Game, private player: Player, private vehicles: VehicleSystem) {
    const onClick = () => { if (this.player.controlsEnabled && g.input.enabled) g.input.requestPointerLock(); };
    g.container.addEventListener('click', onClick);
    this.yaw = player.heading;
  }

  addTrauma(t: number) { this.trauma = Math.min(1, this.trauma + t); }

  lateUpdate(dt: number) {
    const g = this.g, inp = g.input, cam = g.camera;
    const p = this.player;
    const veh = p.vehicleId ? this.vehicles.vehicles.get(p.vehicleId) : undefined;
    const sens = settings.mouseSensitivity || 1;
    const dx = inp.mouseDX * sens, dy = inp.mouseDY * sens * (settings.invertY ? -1 : 1);
    const mouseMoved = Math.abs(dx) + Math.abs(dy) > 0.5;
    if (p.controlsEnabled) {
      if (veh) this.vehYawOffset += dx * SENS; else this.yaw += dx * SENS;
      this.pitch = clamp(this.pitch + dy * SENS, -0.75, 1.15);
      if (inp.wheel) this.zoom = clamp(this.zoom * (inp.wheel > 0 ? 1.12 : 1 / 1.12), 0.45, 2.2);
    }
    if (mouseMoved) this.idleMouse = 0; else this.idleMouse += dt;

    const desiredPivot = new THREE.Vector3();
    const baseFov = clamp(settings.fov || 62, 45, 95);
    let targetFov = baseFov;
    let targetDist: number;
    let shoulder = 0;
    if (veh) {
      if (this.lastVeh !== veh.id) { this.yaw = veh.heading; this.vehYawOffset = 0; this.pitch = 0.2; this.lastVeh = veh.id; }
      const spd = Math.abs(veh.speed);
      // Follow the direction of travel when moving forward; car heading otherwise.
      let follow = veh.heading;
      if (veh.speed > 4) {
        const vh = Math.atan2(veh.velocity.x, -veh.velocity.z);
        follow = lerpAngle(veh.heading, vh, 0.5);
      }
      if (veh.speed < -3) follow = veh.heading;
      this.yaw = lerpAngle(this.yaw, follow, 1 - Math.exp(-3.2 * dt));
      // Mouse look offset recenters after a moment.
      if (this.idleMouse > 1.2 && spd > 2) this.vehYawOffset = damp(this.vehYawOffset, 0, 2.5, dt);
      this.vehYawOffset = wrapAngle(this.vehYawOffset);
      if (this.idleMouse > 1.2 && spd > 2) this.pitch = damp(this.pitch, 0.2, 2, dt);
      const back = (inp.isDown('KeyV') || inp.mouseDown(1)) && p.controlsEnabled;
      this.lookBack = damp(this.lookBack, back ? 1 : 0, 14, dt);
      const L = veh.model.L;
      desiredPivot.copy(veh.position).add(new THREE.Vector3(0, veh.model.roofY * 0.8 + 0.45, 0));
      targetDist = (L * 1.12 + 0.6 + clamp(spd * 0.045, 0, 2.2)) * this.zoom;
      targetFov = baseFov + clamp((spd - 8) * 0.5, 0, 22);
      if (spd > 28) this.trauma = Math.max(this.trauma, clamp((spd - 28) / 60, 0, 0.18));
      if (veh.lastImpact > 0) { this.addTrauma(clamp(veh.lastImpact / 12, 0.15, 0.8)); veh.lastImpact = 0; }
      // Lateral G: the camera swings out of the turn (you see more of the car's flank) and leans a touch.
      this.sway = damp(this.sway, clamp(-veh.latG * 0.045, -0.7, 0.7), 2.5, dt);
      this.roll = damp(this.roll, clamp(-veh.latG * 0.0035, -0.045, 0.045), 3, dt);
      desiredPivot.y += clamp(-veh.lonG * 0.012, -0.12, 0.12);
    } else {
      this.lastVeh = null;
      this.lookBack = 0;
      this.sway = damp(this.sway, 0, 6, dt);
      this.roll = damp(this.roll, 0, 6, dt);
      const crouch = p.crouching ? 1 : 0;
      desiredPivot.copy(p.position).add(new THREE.Vector3(0, 1.5 - crouch * 0.45, 0));
      // Head bob / sway.
      const s = p.groundSpeed;
      const ph = p.stepPhase * Math.PI * 4;
      desiredPivot.y += Math.sin(ph) * 0.025 * clamp(s / 4, 0, 1.3);
      targetDist = (p.sprinting ? 4.6 : 4.0) * this.zoom;
      shoulder = 0.55 * clamp(this.zoom, 0.6, 1.3);
      targetFov = p.sprinting ? baseFov + 6 : baseFov;
    }
    if (!this.pivotInit) { this.pivot.copy(desiredPivot); this.pivotInit = true; }
    // Pivot smoothing: tight horizontally, softer vertically (stairs/curbs).
    const k = veh ? 14 : 18;
    this.pivot.x = damp(this.pivot.x, desiredPivot.x, k, dt);
    this.pivot.z = damp(this.pivot.z, desiredPivot.z, k, dt);
    this.pivot.y = damp(this.pivot.y, desiredPivot.y, veh ? 8 : 10, dt);
    if (veh) { this.pivot.x = desiredPivot.x - (desiredPivot.x - this.pivot.x) * 0.5; this.pivot.z = desiredPivot.z - (desiredPivot.z - this.pivot.z) * 0.5; }
    this.dist = targetDist;

    const yaw = (veh ? this.yaw + this.vehYawOffset : this.yaw) + this.lookBack * Math.PI;
    const pitch = this.pitch;
    const fwd = headingToDir(yaw);
    const dir = new THREE.Vector3(fwd.x * Math.cos(pitch), -Math.sin(pitch), fwd.z * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const origin = this.pivot.clone().addScaledVector(right, shoulder + this.sway);
    // Collision: cast from pivot toward the desired camera spot.
    const want = this.dist;
    const hitD = this.castCamera(origin, dir.clone().negate(), want + 0.3, veh ? veh.id : null);
    let d = Math.min(want, Math.max(0.35, hitD - 0.3));
    // Pull in fast, ease out slowly.
    this.curDist = d < this.curDist ? d : damp(this.curDist, d, 3, dt);
    const pos = origin.clone().addScaledVector(dir, -this.curDist);
    // Keep above ground.
    const gy = this.groundAt(pos.x, pos.z);
    if (pos.y < gy + 0.35) pos.y = gy + 0.35;
    cam.position.copy(pos);
    const look = origin.clone().addScaledVector(dir, 10);
    cam.lookAt(look);
    if (Math.abs(this.roll) > 1e-4) cam.rotateZ(this.roll);
    // Shake (trauma²).
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this.shakeT += dt;
    const sh = this.trauma * this.trauma * (reducedMotion() ? 0.3 : 1);
    if (sh > 0.0005) {
      const t = this.shakeT * 28;
      cam.rotateZ(Math.sin(t * 1.1) * 0.04 * sh);
      cam.rotateX(Math.sin(t * 1.7 + 1.3) * 0.03 * sh);
      cam.rotateY(Math.sin(t * 1.3 + 2.1) * 0.03 * sh);
    }
    this.fov = damp(this.fov, targetFov, 3, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }

  private castCamera(o: THREE.Vector3, d: THREE.Vector3, max: number, vehId: string | null) {
    const g = this.g;
    const R = g.rapier;
    if (!R || !g.physics) return max;
    const ray = new R.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const own = this.player.collider;
    const hit = g.physics.castRay(ray, max, true, undefined, undefined, undefined, undefined, (c) => {
      if (c.handle === own.handle || c.isSensor()) return false;
      const v = this.vehicles.colliderMap.get(c.handle);
      if (v) return false; // cars never push the camera around
      if (this.vehicles.parking.colliderToSlot.has(c.handle)) return false;
      const b = c.parent();
      return !b || b.isFixed();
    });
    void vehId;
    return hit ? hit.timeOfImpact : max;
  }

  private groundAt(x: number, z: number) {
    const w = this.g.world as any;
    try { return w?.groundAt ? w.groundAt(x, z) : -1e9; } catch { return -1e9; }
  }
}
