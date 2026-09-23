// Maintenance repair crew: a generic white high-roof work van that drives in and parks at the curb nearest the
// camera, with a hi-vis crew member working at the post base for the repair duration.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Game } from '../core/game';
import type { Cam } from './network';
import { mats } from './materials';

const NO_VAN = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian']);

let template: THREE.Group | null = null;
let beaconMat: THREE.MeshBasicMaterial | null = null;

function buildVanTemplate(): THREE.Group {
  const M = mats();
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; m.receiveShadow = true; g.add(m); return m;
  };
  const paint = new THREE.MeshPhysicalMaterial({ color: '#f2f2ee', roughness: 0.32, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.12 });
  const trim = new THREE.MeshStandardMaterial({ color: '#1c1d1f', roughness: 0.7 });
  const stripe = new THREE.MeshStandardMaterial({ color: '#e0661a', roughness: 0.5 });
  // van faces -Z; origin at ground center
  add(new RoundedBoxGeometry(2.0, 2.05, 4.1, 3, 0.12), paint, 0, 0.45 + 1.03, 0.85);             // cargo box
  add(new RoundedBoxGeometry(1.96, 1.05, 1.5, 3, 0.18), paint, 0, 0.45 + 0.5, -1.85);             // hood / cab base
  add(new RoundedBoxGeometry(1.94, 0.95, 1.1, 3, 0.15), paint, 0, 1.5 + 0.45, -1.0, 0.0);        // cab upper
  add(new THREE.PlaneGeometry(1.7, 0.85), M.windowGlass, 0, 1.95, -1.62, -0.55);                   // windshield
  for (const s of [-1, 1]) {
    add(new THREE.PlaneGeometry(0.9, 0.6), M.windowGlass, s * 0.975, 1.95, -1.0, 0, s * Math.PI / 2); // side windows
    add(new THREE.BoxGeometry(0.02, 0.12, 5.4), stripe, s * 1.005, 1.15, -0.2);                        // side stripe
    add(new THREE.BoxGeometry(0.01, 1.7, 0.01), trim, s * 1.002, 1.35, 0.35);                          // sliding door seam
    add(new THREE.BoxGeometry(0.05, 0.06, 0.25), trim, s * 1.02, 1.95, -1.45);                          // mirror
  }
  add(new THREE.BoxGeometry(2.05, 0.28, 0.2), trim, 0, 0.55, -2.62);   // front bumper
  add(new THREE.BoxGeometry(2.05, 0.25, 0.18), trim, 0, 0.55, 2.92);   // rear bumper
  add(new THREE.BoxGeometry(1.2, 0.35, 0.03), trim, 0, 0.95, -2.61);   // grille
  const head = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.1, 1.9), toneMapped: false });
  const tail = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.05, 0.03), toneMapped: false });
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.32, 0.14, 0.03), head, s * 0.72, 1.02, -2.61);
    add(new THREE.BoxGeometry(0.1, 0.4, 0.03), tail, s * 0.93, 1.3, 2.91);
  }
  // wheels
  for (const [x, z] of [[-0.9, -1.6], [0.9, -1.6], [-0.9, 1.9], [0.9, 1.9]]) {
    add(new THREE.CylinderGeometry(0.36, 0.36, 0.24, 20), M.rubber, x, 0.36, z, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.25, 16), M.aluminum, x * 1.01, 0.36, z, 0, 0, Math.PI / 2);
  }
  // ladder rack + ladder
  for (const z of [-0.6, 1.0, 2.4]) add(new THREE.BoxGeometry(1.8, 0.04, 0.05), M.aluminum, 0, 2.58, z);
  for (const x of [-0.3, 0.1]) add(new THREE.BoxGeometry(0.05, 0.05, 3.6), M.aluminum, x, 2.64, 0.9);
  for (let i = 0; i < 10; i++) add(new THREE.BoxGeometry(0.4, 0.025, 0.025), M.aluminum, -0.1, 2.64, -0.8 + i * 0.36);
  // amber light bar (flashing)
  beaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0, 0), toneMapped: false });
  add(new THREE.BoxGeometry(1.2, 0.06, 0.25), trim, 0, 2.56, -1.3);
  const bar = add(new RoundedBoxGeometry(1.1, 0.1, 0.22, 2, 0.04), beaconMat, 0, 2.64, -1.3);
  bar.name = 'lightbar';
  return g;
}

function buildCrew(): THREE.Group {
  const M = mats();
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = true; g.add(m); return m;
  };
  for (const s of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), M.denim, s * 0.1, 0.48, 0);
    add(new RoundedBoxGeometry(0.12, 0.08, 0.26, 2, 0.03), M.rubber, s * 0.1, 0.04, -0.04);
  }
  add(new THREE.CapsuleGeometry(0.19, 0.42, 4, 12), M.hiVis, 0, 1.2, 0);
  add(new THREE.BoxGeometry(0.4, 0.04, 0.3), new THREE.MeshStandardMaterial({ color: '#d8d8d8', roughness: 0.3, metalness: 0.4 }), 0, 1.15, 0); // reflective band
  add(new THREE.SphereGeometry(0.11, 16, 12), M.skin, 0, 1.63, 0);
  add(new THREE.SphereGeometry(0.13, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.plasticWhite, 0, 1.68, 0);
  add(new THREE.CylinderGeometry(0.15, 0.15, 0.012, 16), M.plasticWhite, 0, 1.68, -0.02);
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.24, 1.42, 0); armR.position.set(0.24, 1.42, 0);
  const arm = () => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.5, 4, 8), M.hiVis); m.position.y = -0.3; m.castShadow = true; return m; };
  armL.add(arm()); armR.add(arm());
  armL.name = 'armL'; armR.name = 'armR';
  g.add(armL, armR);
  return g;
}

export interface RepairCrew {
  cam: Cam;
  van: THREE.Group;
  crew: THREE.Group;
  from: THREE.Vector3;
  to: THREE.Vector3;
  heading: number;
  t: number;
  leaving: boolean;
  done: boolean;
}

export class CrewManager {
  readonly root = new THREE.Group();
  readonly crews: RepairCrew[] = [];

  constructor(private g: Game) { this.root.name = 'surv-crews'; }

  private spot(cam: Cam): { p: THREE.Vector3; heading: number } {
    const w = cam.work;
    let best: { x: number; z: number; d: number; dx: number; dz: number; hw: number } | null = null;
    for (const r of this.g.recipe.roads ?? []) {
      if (NO_VAN.has(r.cls) || r.tunnel) continue;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz;
        if (L2 < 1) continue;
        let t = ((w.x - a[0]) * dx + (w.z - a[1]) * dz) / L2;
        t = Math.max(0.05, Math.min(0.95, t));
        const x = a[0] + dx * t, z = a[1] + dz * t;
        const d = Math.hypot(x - w.x, z - w.z);
        if (d < 45 && (!best || d < best.d)) best = { x, z, d, dx, dz, hw: r.width / 2 };
      }
    }
    if (best) {
      const L = Math.hypot(best.dx, best.dz);
      const fx = best.dx / L, fz = best.dz / L;
      // offset from centerline toward the camera side, parked against the curb
      const nx = -fz, nz = fx;
      const side = Math.sign((w.x - best.x) * nx + (w.z - best.z) * nz) || 1;
      const off = Math.max(0, best.hw - 1.15);
      const x = best.x + nx * side * off, z = best.z + nz * side * off;
      // face along the lane direction on that side (right-hand traffic)
      const dir = side > 0 ? 1 : -1;
      return { p: new THREE.Vector3(x, 0, z), heading: Math.atan2(fx * dir, -fz * dir) };
    }
    const back = new THREE.Vector3(Math.sin(cam.rc.heading), 0, -Math.cos(cam.rc.heading)).multiplyScalar(-5);
    return { p: w.clone().add(back).setY(0), heading: cam.rc.heading + Math.PI / 2 };
  }

  dispatch(cam: Cam) {
    template ??= buildVanTemplate();
    const { p, heading } = this.spot(cam);
    const van = template.clone();
    const crew = buildCrew();
    const fwd = new THREE.Vector3(Math.sin(heading), 0, -Math.cos(heading));
    const from = p.clone().addScaledVector(fwd, -45);
    const c: RepairCrew = { cam, van, crew, from, to: p, heading, t: 0, leaving: false, done: false };
    van.rotation.y = -heading;
    crew.visible = false;
    this.root.add(van, crew);
    this.crews.push(c);
    this.place(c, 0);
  }

  release(cam: Cam) {
    for (const c of this.crews) if (c.cam === cam && !c.leaving) { c.leaving = true; c.t = 0; }
  }

  clear() {
    for (const c of this.crews) this.root.remove(c.van, c.crew);
    this.crews.length = 0;
  }

  private ground(x: number, z: number, fb: number) {
    try { const w = this.g.world; if (w?.groundAt) return w.groundAt(x, z); } catch { /* */ }
    return fb;
  }

  private place(c: RepairCrew, k: number) {
    const e = 1 - Math.pow(1 - Math.min(1, k), 3);
    const fwd = new THREE.Vector3(Math.sin(c.heading), 0, -Math.cos(c.heading));
    const p = c.leaving ? c.to.clone().addScaledVector(fwd, 50 * k * k) : c.from.clone().lerp(c.to, e);
    p.y = this.ground(p.x, p.z, c.cam.groundY);
    c.van.position.copy(p);
  }

  update(dt: number, t: number, night: number) {
    if (beaconMat) {
      const on = (t * 2.5) % 1 < 0.5;
      const k = on ? 2 + night * 4 : 0.05;
      beaconMat.color.setRGB(k, k * 0.55, 0);
    }
    for (const c of this.crews) {
      c.t += dt;
      if (!c.leaving) {
        this.place(c, c.t / 5);
        if (c.t > 5.5 && !c.crew.visible) {
          c.crew.visible = true;
          const dir = new THREE.Vector3().subVectors(c.cam.work, c.van.position).setY(0);
          const d = dir.length();
          dir.normalize();
          c.crew.position.copy(c.cam.work).addScaledVector(dir, -Math.min(0.9, d)).setY(this.ground(c.cam.work.x, c.cam.work.z, c.cam.groundY));
          c.crew.rotation.y = Math.atan2(-dir.x, -dir.z) + Math.PI;
        }
        if (c.crew.visible) {
          const armR = c.crew.getObjectByName('armR')!, armL = c.crew.getObjectByName('armL')!;
          armR.rotation.x = -2.4 + Math.sin(t * 5) * 0.25;
          armL.rotation.x = -0.4 + Math.sin(t * 1.3) * 0.1;
        }
      } else {
        c.crew.visible = false;
        this.place(c, c.t / 6);
        if (c.t > 6) c.done = true;
      }
    }
    for (let i = this.crews.length - 1; i >= 0; i--) {
      if (this.crews[i].done) { this.root.remove(this.crews[i].van, this.crews[i].crew); this.crews.splice(i, 1); }
    }
  }

  /** Crew members present on site (for NPC-witness checks). */
  onSite(): THREE.Vector3[] {
    return this.crews.filter((c) => c.crew.visible).map((c) => c.crew.position);
  }
}
