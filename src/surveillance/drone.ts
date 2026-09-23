// Surveillance drones (escalation, streak 20+): a public-safety quadcopter with spinning props, nav lights,
// a gimbal camera with a downward vision cone, and a night spotlight. It orbits the player's area,
// periodically descends low to inspect, and can be disabled (hold E) while it hovers low next to the player.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Game } from '../core/game';
import type { Vec3 } from '../core/types';
import { canSee } from '../ai/perception';
import { mats } from './materials';

export const DRONE_CONE_DEG = 32;
export const DRONE_RANGE = 70;

export type DroneMode = 'inbound' | 'patrol' | 'descend' | 'low' | 'ascend' | 'falling' | 'crashed';

export class Drone {
  readonly obj = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  mode: DroneMode = 'inbound';
  timer = 0;
  orbitA = Math.random() * Math.PI * 2;
  seesPlayer = false;
  lastWitnessAt = -1e9;
  spin: THREE.Object3D[] = [];
  discs: THREE.Mesh[] = [];
  nav: THREE.MeshBasicMaterial[] = [];
  cone: THREE.Mesh;
  coneMat: THREE.MeshBasicMaterial;
  light: THREE.SpotLight;
  angVel = new THREE.Vector3();
  crashedAt = 0;
  lowTarget = new THREE.Vector3();

  constructor(public id: string) {
    const M = mats();
    const body = new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.45, metalness: 0.2 });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, parent: THREE.Object3D = this.obj) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; parent.add(m); return m;
    };
    add(new RoundedBoxGeometry(0.42, 0.13, 0.3, 3, 0.04), body, 0, 0, 0);
    add(new RoundedBoxGeometry(0.2, 0.06, 0.24, 2, 0.02), M.plasticDark, 0, 0.09, 0.02);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const ax = sx * 0.42, az = sz * 0.36;
      const len = Math.hypot(ax, az);
      add(new THREE.BoxGeometry(0.045, 0.035, len), body, ax / 2, 0.02, az / 2, 0, Math.atan2(ax, az));
      add(new THREE.CylinderGeometry(0.04, 0.045, 0.06, 14), M.steelDark, ax, 0.05, az);
      const rotor = new THREE.Group();
      rotor.position.set(ax, 0.09, az);
      this.obj.add(rotor);
      for (const r of [0, Math.PI]) add(new THREE.BoxGeometry(0.34, 0.006, 0.035), M.plasticDark, Math.cos(r) * 0.0, 0, 0, 0, r, 0.04, rotor);
      this.spin.push(rotor);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.003, 28), new THREE.MeshBasicMaterial({ color: '#111', transparent: true, opacity: 0.18, depthWrite: false }));
      disc.position.set(ax, 0.09, az);
      this.obj.add(disc);
      this.discs.push(disc);
      // landing leg
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.18, 6), body, ax * 0.55, -0.12, az * 0.55);
    }
    // gimbal camera
    add(new THREE.SphereGeometry(0.06, 16, 12), M.plasticDark, 0, -0.1, -0.1);
    add(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 16), M.lensGlass, 0, -0.14, -0.12, 0.3);
    // nav lights: red port, green starboard, white strobe
    const mk = () => { const m = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false }); this.nav.push(m); return m; };
    add(new THREE.SphereGeometry(0.018, 8, 6), mk(), -0.42, 0.0, -0.36);
    add(new THREE.SphereGeometry(0.018, 8, 6), mk(), 0.42, 0.0, -0.36);
    add(new THREE.SphereGeometry(0.022, 8, 6), mk(), 0, 0.13, 0.12);
    // downward vision cone (additive)
    const h = 1;
    this.coneMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.75, 1), transparent: true, opacity: 0.06, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    this.cone = new THREE.Mesh(new THREE.ConeGeometry(Math.tan((DRONE_CONE_DEG * Math.PI) / 180), h, 32, 1, true).translate(0, -h / 2, 0), this.coneMat);
    this.cone.frustumCulled = false;
    this.obj.add(this.cone);
    this.light = new THREE.SpotLight(0xdde8ff, 0, 60, (DRONE_CONE_DEG * Math.PI) / 180, 0.5, 1.4);
    this.light.position.set(0, -0.15, 0);
    this.light.target.position.set(0, -10, 0);
    this.obj.add(this.light, this.light.target);
    this.obj.name = `surv-${id}`;
  }

  /** Is the drone low enough and close to be grabbed/disabled from the ground? */
  reachable(p: THREE.Vector3, ground: number) {
    return (this.mode === 'low') && this.pos.y - ground < 4.2 && Math.hypot(this.pos.x - p.x, this.pos.z - p.z) < 3.2;
  }

  sees(g: Game, target: Vec3): boolean {
    if (this.mode === 'falling' || this.mode === 'crashed') return false;
    return canSee({ pos: [this.pos.x, this.pos.y - 0.2, this.pos.z], dir: 0, fovDeg: 360, range: DRONE_RANGE, ir: true, downConeDeg: DRONE_CONE_DEG }, target, g);
  }

  update(dt: number, t: number, night: number, focus: THREE.Vector3 | null, ground: (x: number, z: number) => number) {
    const gy = ground(this.pos.x, this.pos.z);
    if (this.mode === 'falling' || this.mode === 'crashed') {
      if (this.mode === 'falling') {
        this.vel.y -= 9.81 * dt;
        this.pos.addScaledVector(this.vel, dt);
        this.obj.rotation.x += this.angVel.x * dt; this.obj.rotation.z += this.angVel.z * dt; this.obj.rotation.y += this.angVel.y * dt;
        if (this.pos.y < gy + 0.12) { this.pos.y = gy + 0.12; this.mode = 'crashed'; this.crashedAt = t; this.obj.rotation.x = 0.25; this.obj.rotation.z = 2.8; }
      }
      for (const m of this.nav) m.color.setRGB(0, 0, 0);
      this.cone.visible = false;
      this.light.intensity = 0;
      for (const d of this.discs) d.visible = false;
      this.obj.position.copy(this.pos);
      return;
    }
    this.timer += dt;
    const cruise = gy + 26;
    let target = new THREE.Vector3();
    if (focus) {
      if (this.mode === 'inbound' && this.pos.distanceTo(focus) < 60) { this.mode = 'patrol'; this.timer = 0; }
      if (this.mode === 'patrol' && this.timer > 26) { this.mode = 'descend'; this.timer = 0; this.lowTarget.set(focus.x + (Math.random() - 0.5) * 8, 0, focus.z + (Math.random() - 0.5) * 8); }
      if (this.mode === 'descend' && this.pos.y < ground(this.lowTarget.x, this.lowTarget.z) + 3.8) { this.mode = 'low'; this.timer = 0; }
      if (this.mode === 'low' && this.timer > 9) { this.mode = 'ascend'; this.timer = 0; }
      if (this.mode === 'ascend' && this.pos.y > cruise - 2) { this.mode = 'patrol'; this.timer = 0; }
      this.orbitA += dt * 0.18;
      if (this.mode === 'descend' || this.mode === 'low') {
        target.set(this.lowTarget.x, ground(this.lowTarget.x, this.lowTarget.z) + (this.mode === 'low' ? 3.3 : 3.5), this.lowTarget.z);
      } else {
        target.set(focus.x + Math.cos(this.orbitA) * 22, cruise, focus.z + Math.sin(this.orbitA) * 22);
      }
    } else target.copy(this.pos);
    // critically damped seek
    const toT = target.sub(this.pos);
    const maxV = this.mode === 'inbound' ? 16 : 7;
    const desired = toT.multiplyScalar(0.9);
    if (desired.length() > maxV) desired.setLength(maxV);
    this.vel.lerp(desired, Math.min(1, dt * 1.6));
    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = Math.max(this.pos.y, gy + 2.5);
    // hover wobble
    const wob = new THREE.Vector3(Math.sin(t * 1.3 + this.orbitA) * 0.05, Math.sin(t * 2.1) * 0.06, Math.cos(t * 1.1) * 0.05);
    this.obj.position.copy(this.pos).add(wob);
    // bank into velocity
    this.obj.rotation.set(this.vel.z * 0.035, 0, -this.vel.x * 0.035);
    for (const r of this.spin) r.rotation.y += dt * 90;
    // lights
    const blink = (t * 1.2 + this.orbitA) % 1;
    this.nav[0].color.setRGB(2, 0, 0);
    this.nav[1].color.setRGB(0, 2, 0.2);
    const s = blink < 0.05 ? 6 : 0;
    this.nav[2].color.setRGB(s, s, s);
    // vision cone scaled to the ground
    const h = Math.max(1, this.pos.y - gy);
    this.cone.visible = true;
    this.cone.scale.set(h, h, h);
    this.cone.rotation.set(-this.obj.rotation.x, 0, -this.obj.rotation.z);
    this.coneMat.color.set(this.seesPlayer ? 0xff2a1a : 0x88c0ff);
    this.coneMat.opacity = (this.seesPlayer ? 0.05 : 0.018) * (1 + night * 0.4);
    this.light.intensity = night > 0.3 ? 900 * night : 0;
  }

  knockDown() {
    this.mode = 'falling';
    this.vel.set((Math.random() - 0.5) * 2, 1.5, (Math.random() - 0.5) * 2);
    this.angVel.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8);
  }
}
