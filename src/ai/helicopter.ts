// Police helicopter (heat 5): procedural model, spinning rotors, searchlight at night,
// wide downward vision cone. Follows the player when seen, sweeps lastKnown otherwise.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec2 } from '../core/types';
import { canSee, headingOf, angleDiff } from './perception';
import { nightFactor, playSound, groundY } from './util';

const BODY = '#1a202c';

function buildModel(): { group: THREE.Group; rotor: THREE.Object3D; tail: THREE.Object3D; nav: THREE.Mesh; lamp: THREE.Object3D } {
  const g = new THREE.Group();
  g.name = 'police-helicopter';
  const body = new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.45, metalness: 0.55 });
  const trim = new THREE.MeshStandardMaterial({ color: '#c9ccd2', roughness: 0.5, metalness: 0.4 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0d1a24', roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: '#0b0d10', roughness: 0.6, metalness: 0.3 });
  // fuselage
  const fus = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), body);
  fus.scale.set(1.25, 1.2, 2.5);
  fus.position.set(0, 0, 0.1);
  g.add(fus);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), glass);
  canopy.scale.set(1.12, 1.0, 1.35);
  canopy.rotation.x = -1.25;
  canopy.position.set(0, 0.05, -1.35);
  g.add(canopy);
  // stripe (generic, no insignia)
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(1.27, 1.27, 0.25, 20, 1, true), trim);
  stripe.rotation.x = Math.PI / 2;
  stripe.scale.set(1, 1.2, 0.95);
  stripe.position.set(0, -0.15, 0.4);
  g.add(stripe);
  // tail boom
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.38, 5.2, 10), body);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.35, 4.3);
  g.add(boom);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 0.9), body);
  fin.position.set(0, 1.0, 6.7);
  fin.rotation.x = -0.35;
  g.add(fin);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 0.5), body);
  stab.position.set(0, 0.4, 6.1);
  g.add(stab);
  // skids
  for (const s of [-1, 1]) {
    const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.6, 6), dark);
    skid.rotation.x = Math.PI / 2;
    skid.position.set(s * 1.05, -1.55, 0);
    g.add(skid);
    for (const zz of [-0.8, 0.9]) {
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 6), dark);
      strut.position.set(s * 0.95, -1.2, zz);
      strut.rotation.z = s * 0.3;
      g.add(strut);
    }
  }
  // mast + main rotor
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.6, 8), dark);
  mast.position.set(0, 1.35, 0);
  g.add(mast);
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.7, 0);
  const bladeGeo = new THREE.BoxGeometry(0.3, 0.04, 5.2);
  bladeGeo.translate(0, 0, 2.6);
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(bladeGeo, dark);
    b.rotation.y = (i * Math.PI) / 2;
    rotor.add(b);
  }
  // blur disc for motion
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5.3, 32), new THREE.MeshBasicMaterial({ color: '#15181d', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }));
  disc.rotation.x = -Math.PI / 2;
  rotor.add(disc);
  g.add(rotor);
  const tail = new THREE.Group();
  tail.position.set(0.25, 1.0, 6.8);
  const tb = new THREE.BoxGeometry(0.04, 1.4, 0.14);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(tb, dark);
    b.rotation.x = (i * Math.PI) / 2;
    tail.add(b);
  }
  g.add(tail);
  // nav light
  const nav = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: '#ff2020' }));
  nav.position.set(0, 1.8, 7.0);
  g.add(nav);
  for (const [x, c] of [[-1.25, '#ff2a2a'], [1.25, '#2aff5a']] as [number, string][]) {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: c }));
    l.position.set(x, 0.1, 0.3);
    g.add(l);
  }
  // searchlight housing (under the nose)
  const lamp = new THREE.Group();
  lamp.position.set(0.7, -1.1, -1.4);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.4, 10), trim);
  housing.rotation.x = Math.PI / 2;
  lamp.add(housing);
  g.add(lamp);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return { group: g, rotor, tail, nav, lamp };
}

export class Helicopter {
  group: THREE.Group;
  private rotor: THREE.Object3D;
  private tail: THREE.Object3D;
  private nav: THREE.Mesh;
  light: THREE.SpotLight;
  private beam: THREE.Mesh;
  private lightTarget = new THREE.Object3D();
  x = 0; y = 80; z = 0; h = 0; v = 0;
  /** where the searchlight / attention points */
  ax = 0; az = 0;
  state: 'inbound' | 'track' | 'search' | 'leaving' = 'inbound';
  sees = false;
  private sweepT = 0;
  private sound: ReturnType<typeof playSound> = null;
  gone = false;
  altitude = 62;

  constructor(private g: Game, x: number, z: number) {
    const m = buildModel();
    this.group = m.group; this.rotor = m.rotor; this.tail = m.tail; this.nav = m.nav;
    this.x = x; this.z = z;
    this.y = groundY(g, x, z) + this.altitude + 20;
    this.light = new THREE.SpotLight('#eaf2ff', 0, 170, 0.16, 0.45, 1.2);
    this.light.castShadow = false;
    this.light.position.copy(m.lamp.position);
    this.group.add(this.light);
    this.group.add(this.lightTarget);
    this.light.target = this.lightTarget;
    // visible beam (additive cone), shown at night
    const beamGeo = new THREE.ConeGeometry(1, 1, 24, 1, true);
    beamGeo.translate(0, -0.5, 0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: '#cfe0ff', transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.beam.renderOrder = 5;
    g.scene.add(this.beam);
    g.scene.add(this.group);
    this.sound = playSound(g, 'helicopter', { at: [this.x, this.y, this.z], loop: true, volume: 0.9 });
  }

  /**
   * Fly & look. `player` = player position (for perception), `goal` = where to go (player if seen, else lastKnown).
   * Returns true if the helicopter sees the player this tick.
   */
  update(dt: number, player: [number, number, number] | null, goal: Vec2 | null, leaving: boolean, t: number): boolean {
    const g = this.g;
    if (leaving) this.state = 'leaving';
    // navigation target
    let tx = this.x, tz = this.z;
    if (this.state === 'leaving') {
      tx = this.x + Math.sin(this.h) * 500; tz = this.z - Math.cos(this.h) * 500;
    } else if (goal) {
      if (this.sees && player) {
        // hover-track slightly behind/around the player
        const a = t * 0.25;
        tx = player[0] + Math.cos(a) * 28; tz = player[2] + Math.sin(a) * 28;
      } else {
        // orbit lastKnown
        const a = t * 0.35;
        const r = 45;
        tx = goal[0] + Math.cos(a) * r; tz = goal[1] + Math.sin(a) * r;
      }
    }
    const dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    const vDes = this.state === 'leaving' ? 40 : Math.min(36, d * 0.6);
    this.v += Math.max(-8 * dt, Math.min(6 * dt, vDes - this.v));
    const want = headingOf(dx, dz);
    if (d > 2) this.h += Math.max(-1.1 * dt, Math.min(1.1 * dt, angleDiff(want, this.h)));
    this.x += Math.sin(this.h) * this.v * dt;
    this.z += -Math.cos(this.h) * this.v * dt;
    const gy = groundY(g, this.x, this.z, this.y - this.altitude);
    const ty = gy + this.altitude;
    this.y += (ty - this.y) * Math.min(1, dt * 0.8);
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(0, -this.h, 0);
    // bank & pitch with speed
    this.group.rotateX(-Math.min(0.25, this.v / 150));
    this.rotor.rotation.y += dt * 38;
    this.tail.rotation.x += dt * 60;
    (this.nav.material as THREE.MeshBasicMaterial).color.set(Math.sin(t * 6) > 0.6 ? '#ff2020' : '#300000');
    this.sound?.setPosition([this.x, this.y, this.z]);

    // attention point: player if seen, else sweep around goal
    this.sweepT += dt;
    let lx: number, lz: number;
    if (this.sees && player) { lx = player[0]; lz = player[2]; }
    else if (goal) {
      lx = goal[0] + Math.sin(this.sweepT * 0.9) * 32 + Math.sin(this.sweepT * 0.37) * 18;
      lz = goal[1] + Math.cos(this.sweepT * 0.7) * 32;
    } else { lx = this.x; lz = this.z; }
    this.ax += (lx - this.ax) * Math.min(1, dt * 2.5);
    this.az += (lz - this.az) * Math.min(1, dt * 2.5);
    const ly = groundY(g, this.ax, this.az, gy);
    const night = nightFactor(g);
    this.light.intensity = night > 0.25 ? 2500 * night : 0;
    // light target is in group space
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    this.group.updateMatrixWorld();
    inv.copy(this.group.matrixWorld).invert();
    this.lightTarget.position.set(this.ax, ly, this.az).applyMatrix4(inv);
    // beam
    const lp = new THREE.Vector3();
    this.light.getWorldPosition(lp);
    const tgt = new THREE.Vector3(this.ax, ly, this.az);
    const len = lp.distanceTo(tgt);
    this.beam.visible = night > 0.25 && this.state !== 'leaving';
    this.beam.position.copy(lp);
    this.beam.scale.set(len * Math.tan(0.16), len, len * Math.tan(0.16));
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), tgt.clone().sub(lp).normalize());

    // perception: wide downward FLIR cone; searchlight extends it at night
    this.sees = false;
    if (player && this.state !== 'leaving') {
      const eye: [number, number, number] = [this.x, this.y - 1.5, this.z];
      const cone = night > 0.5 ? 30 : 40;
      if (canSee({ pos: eye, dir: this.h, fovDeg: 360, range: 150, ir: true, downConeDeg: cone }, player, g, { crouching: false })) this.sees = true;
      else if (night > 0.25 && Math.hypot(player[0] - this.ax, player[2] - this.az) < 9 &&
        canSee({ pos: eye, dir: this.h, fovDeg: 360, range: 190, ir: true }, player, g, { crouching: false })) this.sees = true;
    }
    this.state = this.state === 'leaving' ? 'leaving' : this.sees ? 'track' : goal && Math.hypot(goal[0] - this.x, goal[1] - this.z) < 120 ? 'search' : 'inbound';
    if (this.state === 'leaving' && player && Math.hypot(player[0] - this.x, player[2] - this.z) > 600) this.gone = true;
    return this.sees;
  }

  dispose() {
    this.sound?.stop();
    this.g.scene.remove(this.group);
    this.g.scene.remove(this.beam);
    this.light.dispose();
    this.gone = true;
  }
}
