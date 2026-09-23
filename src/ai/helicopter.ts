// Police helicopter (heat 5): procedural light-twin model (lathe fuselage, glass canopy, tail boom + fin,
// tail rotor, tubular skids, rotor blur discs, nav/strobe/beacon lights), smooth velocity-steered flight
// with banking, orbit-tracking of the player, and a night searchlight (real SpotLight + additive beam +
// ground light pool) that sweeps the search area. Rotor audio via g.audio.play('helicopter').
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec2 } from '../core/types';
import { canSee, headingOf, angleDiff } from './perception';
import { nightFactor, playSound, groundY } from './util';
import { BEAM_GEO, POOL_GEO, makeBeamMaterial, makePoolMaterial, glowTexture, aimBeam } from './beams';

export const HELI_TUNING = {
  altitude: 58,
  /** orbit radius while tracking / searching */
  trackRadius: 42,
  searchRadius: 75,
  maxSpeed: 40,
  accel: 7,
  yawRate: 0.7,
  /** searchlight half-angle (rad) */
  beamHalf: 0.12,
  /** perception cone (deg off straight-down) by day / at night (outside the light) */
  flirDay: 40,
  flirNight: 24,
  /** player inside the light pool (m, as a fraction of pool radius) is seen */
  poolSee: 1.1,
};

interface HeliModel {
  group: THREE.Group;
  body: THREE.Group;
  rotor: THREE.Object3D;
  rotorDisc: THREE.Mesh;
  tail: THREE.Object3D;
  lamp: THREE.Object3D;
  beacons: THREE.Sprite[];
  strobes: THREE.Sprite[];
}

function glow(color: string, size: number): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false, fog: false }));
  s.scale.set(size, size, 1);
  return s;
}

function discTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  // rotor blur: faint near the hub, darker band where the blades' chord is, bright-ish tip ring
  g.addColorStop(0.0, 'rgba(20,22,26,0.0)');
  g.addColorStop(0.12, 'rgba(20,22,26,0.35)');
  g.addColorStop(0.2, 'rgba(20,22,26,0.22)');
  g.addColorStop(0.85, 'rgba(26,28,32,0.2)');
  g.addColorStop(0.95, 'rgba(60,62,66,0.32)');
  g.addColorStop(1.0, 'rgba(60,62,66,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 256, 256);
  // faint streaks (motion)
  x.globalCompositeOperation = 'source-over';
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    x.strokeStyle = `rgba(30,32,36,${0.03 + (i % 3) * 0.015})`;
    x.lineWidth = 3;
    x.beginPath();
    x.arc(128, 128, 40 + (i * 2.1) % 80, a, a + 0.9);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let cachedModel: HeliModel | null = null;

function buildModel(): HeliModel {
  if (cachedModel) return cachedModel;
  const group = new THREE.Group();
  group.name = 'police-helicopter';
  const body = new THREE.Group();
  group.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ color: '#1b2230', roughness: 0.38, metalness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 });
  const paintLow = new THREE.MeshPhysicalMaterial({ color: '#d9dde3', roughness: 0.4, metalness: 0.25, clearcoat: 0.6, clearcoatRoughness: 0.25 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#0c1822', roughness: 0.04, metalness: 0.1, transmission: 0, transparent: true, opacity: 0.72, clearcoat: 1, envMapIntensity: 1.6 });
  const dark = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.55, metalness: 0.6 });
  const metal = new THREE.MeshStandardMaterial({ color: '#8a8f96', roughness: 0.35, metalness: 0.9 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  // fuselage: lathe teardrop along Z (nose at -Z)
  const prof: THREE.Vector2[] = [
    [0.0, -2.35], [0.42, -2.25], [0.78, -1.95], [1.02, -1.45], [1.14, -0.8], [1.18, -0.1], [1.14, 0.6], [1.0, 1.25], [0.74, 1.85], [0.46, 2.3], [0.3, 2.55], [0.0, 2.6],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fusGeo = new THREE.LatheGeometry(prof, 28);
  fusGeo.rotateX(Math.PI / 2);
  fusGeo.scale(0.86, 0.92, 1.12);
  const fus = add(fusGeo, paint);
  fus.position.set(0, 0, 0);
  // lower belly in light livery (a slightly bigger lathe clipped by a scaled copy under the body)
  const belly = add(fusGeo.clone(), paintLow);
  belly.scale.set(1.012, 0.5, 0.99);
  belly.position.set(0, -0.5, 0.02);
  // canopy glass (front upper)
  const canGeo = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const canopy = add(canGeo, glass);
  canopy.scale.set(0.9, 0.88, 1.7);
  canopy.rotation.x = -Math.PI / 2 + 0.5;
  canopy.position.set(0, 0.06, -1.2);
  // side windows (dark insets)
  for (const s of [-1, 1]) {
    const w = add(new THREE.PlaneGeometry(1.1, 0.62), glass);
    w.position.set(s * 1.075, 0.22, 0.25);
    w.rotation.y = s * Math.PI / 2;
    // stripe along the side
    const st = add(new THREE.PlaneGeometry(3.4, 0.12), new THREE.MeshStandardMaterial({ color: '#2f6fd8', roughness: 0.5, metalness: 0.2 }));
    st.position.set(s * 1.155, -0.25, 0.1);
    st.rotation.y = s * Math.PI / 2;
  }
  // engine cowling
  const cowl = add(new THREE.CapsuleGeometry(0.46, 1.6, 6, 14), paint);
  cowl.rotation.x = Math.PI / 2;
  cowl.scale.set(1.25, 1, 0.9);
  cowl.position.set(0, 1.12, 0.55);
  for (const s of [-1, 1]) {
    const ex = add(new THREE.CylinderGeometry(0.13, 0.15, 0.4, 10), dark);
    ex.rotation.x = Math.PI / 2;
    ex.position.set(s * 0.42, 1.12, 1.55);
  }
  // tail boom (tapered) + fairing
  const boom = add(new THREE.CylinderGeometry(0.15, 0.34, 5.0, 14), paint);
  boom.rotation.x = Math.PI / 2;
  boom.position.set(0, 0.45, 4.7);
  // horizontal stabilizer with endplates
  const stab = add(new THREE.BoxGeometry(2.3, 0.07, 0.55), paint);
  stab.position.set(0, 0.5, 5.9);
  for (const s of [-1, 1]) {
    const ep = add(new THREE.BoxGeometry(0.05, 0.5, 0.5), paint);
    ep.position.set(s * 1.15, 0.6, 5.92);
  }
  // vertical fin (swept)
  const finShape = new THREE.Shape();
  finShape.moveTo(0, 0); finShape.lineTo(0.95, 0); finShape.lineTo(1.35, 1.55); finShape.lineTo(0.8, 1.55); finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.08, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2);
  finGeo.translate(0.04, 0, 0);
  const fin = add(finGeo, paint);
  fin.position.set(0, 0.45, 6.35);
  // lower fin
  const lf = add(new THREE.BoxGeometry(0.06, 0.55, 0.45), paint);
  lf.position.set(0, 0.05, 6.95);
  lf.rotation.x = 0.4;
  // tail rotor (side of the fin): blades + blur disc
  const tail = new THREE.Group();
  tail.position.set(-0.22, 1.35, 7.35);
  const tb = new THREE.BoxGeometry(0.03, 1.3, 0.1);
  for (let i = 0; i < 2; i++) { const b = add(tb, dark, tail); b.rotation.x = (i * Math.PI) / 2; }
  const tdisc = new THREE.Mesh(new THREE.CircleGeometry(0.68, 24), new THREE.MeshBasicMaterial({ map: discTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  tdisc.rotation.y = Math.PI / 2;
  tail.add(tdisc);
  body.add(tail);
  // skids: tubular with upturned toes + curved cross tubes
  for (const s of [-1, 1]) {
    const pts = [new THREE.Vector3(s * 1.2, -1.62, 1.6), new THREE.Vector3(s * 1.2, -1.62, -1.3), new THREE.Vector3(s * 1.2, -1.5, -1.85), new THREE.Vector3(s * 1.2, -1.25, -2.05)];
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.055, 8, false), metal);
  }
  for (const z of [-0.9, 0.95]) {
    const pts = [new THREE.Vector3(-1.2, -1.6, z), new THREE.Vector3(-1.05, -0.95, z), new THREE.Vector3(-0.6, -0.72, z), new THREE.Vector3(0.6, -0.72, z), new THREE.Vector3(1.05, -0.95, z), new THREE.Vector3(1.2, -1.6, z)];
    add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.05, 8, false), metal);
  }
  // FLIR ball (left chin) + searchlight gimbal (right chin)
  const flir = add(new THREE.SphereGeometry(0.2, 14, 10), dark);
  flir.position.set(-0.55, -0.95, -1.55);
  const lamp = new THREE.Group();
  lamp.position.set(0.6, -1.05, -1.4);
  const housing = add(new THREE.CylinderGeometry(0.18, 0.22, 0.42, 14), metal, lamp);
  housing.rotation.x = Math.PI / 2;
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.17, 16), new THREE.MeshBasicMaterial({ color: '#fffbe8', toneMapped: false }));
  lens.position.set(0, -0.05, -0.215);
  lens.rotation.x = Math.PI;
  lamp.add(lens);
  body.add(lamp);
  // mast + hub + main rotor blades + blur disc
  const mast = add(new THREE.CylinderGeometry(0.1, 0.14, 0.55, 10), dark);
  mast.position.set(0, 1.55, 0.2);
  const rotor = new THREE.Group();
  rotor.position.set(0, 1.86, 0.2);
  add(new THREE.CylinderGeometry(0.28, 0.22, 0.18, 12), dark, rotor);
  const bladeGeo = new THREE.BoxGeometry(0.34, 0.035, 5.3);
  bladeGeo.translate(0, 0, 2.75);
  for (let i = 0; i < 4; i++) {
    const b = add(bladeGeo, dark, rotor);
    b.rotation.y = (i * Math.PI) / 2;
    b.rotation.x = 0.025; // droop
  }
  const rotorDisc = new THREE.Mesh(new THREE.CircleGeometry(5.55, 48), new THREE.MeshBasicMaterial({ map: discTexture(), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
  rotorDisc.rotation.x = -Math.PI / 2;
  rotorDisc.position.set(0, 1.9, 0.2);
  rotorDisc.renderOrder = 2;
  body.add(rotorDisc);
  body.add(rotor);
  // lights: port red, starboard green, tail white, red beacons top/bottom, white strobes on the stabilizer tips
  const port = glow('#ff2a1a', 0.55); port.position.set(-1.2, 0.55, 5.9); body.add(port);
  const stbd = glow('#29ff5a', 0.55); stbd.position.set(1.2, 0.55, 5.9); body.add(stbd);
  const tailW = glow('#ffffff', 0.45); tailW.position.set(0, 0.45, 7.5); body.add(tailW);
  const beaconTop = glow('#ff1a1a', 0.9); beaconTop.position.set(0, 1.62, 1.25); body.add(beaconTop);
  const beaconBot = glow('#ff1a1a', 0.9); beaconBot.position.set(0, -1.12, 0.3); body.add(beaconBot);
  const strobeL = glow('#ffffff', 1.4); strobeL.position.set(-1.2, 0.62, 5.95); body.add(strobeL);
  const strobeR = glow('#ffffff', 1.4); strobeR.position.set(1.2, 0.62, 5.95); body.add(strobeR);
  // center of mass roughly at the mast
  body.position.set(0, 0, -0.2);
  cachedModel = { group, body, rotor, rotorDisc, tail, lamp, beacons: [beaconTop, beaconBot], strobes: [strobeL, strobeR] };
  return cachedModel;
}

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

export class Helicopter {
  group: THREE.Group;
  private m: HeliModel;
  light: THREE.SpotLight;
  private lightTarget: THREE.Object3D;
  private beam: THREE.Mesh;
  private pool: THREE.Mesh;
  x = 0; y = 80; z = 0;
  /** nose heading (0 = -Z, clockwise) */
  h = 0;
  vx = 0; vz = 0;
  /** horizontal speed (m/s) */
  v = 0;
  private pitch = 0; private roll = 0;
  /** where the searchlight / attention points */
  ax = 0; az = 0;
  state: 'inbound' | 'track' | 'search' | 'leaving' = 'inbound';
  sees = false;
  private sweepT = 0;
  private orbitA = 0;
  private sound: ReturnType<typeof playSound> = null;
  gone = false;
  altitude = HELI_TUNING.altitude;
  /** light pool radius on the ground (m) */
  poolR = 6;

  /** `light` is a persistent SpotLight owned by the police system (adding lights at runtime recompiles shaders). */
  constructor(private g: Game, x: number, z: number, light: THREE.SpotLight, private searchArea?: () => { p: Vec2; r: number } | null) {
    this.m = buildModel();
    this.group = this.m.group;
    this.x = x; this.z = z;
    this.y = groundY(g, x, z) + this.altitude + 25;
    this.ax = x; this.az = z;
    this.light = light;
    this.lightTarget = light.target;
    this.light.intensity = 0;
    this.beam = new THREE.Mesh(BEAM_GEO, makeBeamMaterial('#dfe9ff', 0.16, 0.9));
    this.beam.renderOrder = 5;
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.pool = new THREE.Mesh(POOL_GEO, makePoolMaterial('#e8f0ff', 0.55));
    this.pool.renderOrder = 4;
    this.pool.visible = false;
    g.scene.add(this.beam, this.pool, this.group);
    this.sound = playSound(g, 'helicopter', { at: [this.x, this.y, this.z], loop: true, volume: 0.95 });
    this.orbitA = Math.atan2(z, x);
  }

  /**
   * Fly & look. `player` = player chest point (for perception), `goal` = lastKnown (search center).
   * Returns true if the helicopter sees the player this tick.
   */
  update(dt: number, player: [number, number, number] | null, goal: Vec2 | null, leaving: boolean, t: number, playerVel?: Vec2, radioed = false): boolean {
    const g = this.g;
    const T = HELI_TUNING;
    if (leaving) this.state = 'leaving';
    // ---- navigation target (orbit the player while tracking, the search area otherwise)
    let tx = this.x, tz = this.z, fvx = 0, fvz = 0;
    if (this.state === 'leaving') {
      tx = this.x + Math.sin(this.h) * 600; tz = this.z - Math.cos(this.h) * 600;
    } else if (this.sees && player) {
      this.orbitA += dt * 0.16;
      tx = player[0] + Math.cos(this.orbitA) * T.trackRadius;
      tz = player[2] + Math.sin(this.orbitA) * T.trackRadius;
      if (playerVel) { fvx = playerVel[0]; fvz = playerVel[1]; }
    } else if (goal && radioed) {
      // ground units have eyes on: come in tight over the reported position
      this.orbitA += dt * 0.14;
      tx = goal[0] + Math.cos(this.orbitA) * T.trackRadius;
      tz = goal[1] + Math.sin(this.orbitA) * T.trackRadius;
    } else if (goal) {
      this.orbitA += dt * 0.11;
      const sa = this.searchArea?.();
      const r = Math.max(T.trackRadius, Math.min(T.searchRadius, (sa?.r ?? 60) * 0.8));
      tx = goal[0] + Math.cos(this.orbitA) * r;
      tz = goal[1] + Math.sin(this.orbitA) * r;
    }
    // velocity steering: desired velocity toward the target + feed-forward of the target's motion
    const dx = tx - this.x, dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    const vmax = this.state === 'leaving' ? 45 : T.maxSpeed;
    const vApp = Math.min(vmax, Math.sqrt(2 * T.accel * 0.6 * d)); // arrive without overshoot
    let dvx = (d > 0.5 ? (dx / d) * vApp : 0) + fvx;
    let dvz = (d > 0.5 ? (dz / d) * vApp : 0) + fvz;
    const dl = Math.hypot(dvx, dvz);
    if (dl > vmax) { dvx *= vmax / dl; dvz *= vmax / dl; }
    let axw = (dvx - this.vx) * 1.4, azw = (dvz - this.vz) * 1.4;
    const al = Math.hypot(axw, azw);
    if (al > T.accel) { axw *= T.accel / al; azw *= T.accel / al; }
    this.vx += axw * dt; this.vz += azw * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;
    this.v = Math.hypot(this.vx, this.vz);
    // nose: toward the attention point while working, along the velocity when transiting
    const look = this.state === 'track' || this.state === 'search' ? headingOf(this.ax - this.x, this.az - this.z) + 0.5 : headingOf(this.vx, this.vz);
    if (this.v > 1 || this.state === 'track' || this.state === 'search') {
      const dh = angleDiff(look, this.h);
      this.h += Math.max(-T.yawRate * dt, Math.min(T.yawRate * dt, dh * 1.5 * dt * 2));
    }
    // altitude: clear the terrain ahead
    const la = 1.5;
    const gy = Math.max(groundY(g, this.x, this.z, this.y - this.altitude), groundY(g, this.x + this.vx * la, this.z + this.vz * la, this.y - this.altitude));
    const ty = gy + this.altitude + (this.state === 'inbound' ? 8 : 0);
    this.y += (ty - this.y) * Math.min(1, dt * 0.7);
    // attitude from acceleration in the body frame (nose-down to accelerate, bank into turns)
    const fx = Math.sin(this.h), fz = -Math.cos(this.h);
    const rx = Math.cos(this.h), rz = Math.sin(this.h);
    const aFwd = axw * fx + azw * fz, aRight = axw * rx + azw * rz;
    const vFwd = this.vx * fx + this.vz * fz;
    const tp = Math.max(-0.22, Math.min(0.22, -aFwd * 0.022 - vFwd * 0.0035));
    const tr = Math.max(-0.3, Math.min(0.3, -aRight * 0.03));
    this.pitch += (tp - this.pitch) * Math.min(1, dt * 2.2);
    this.roll += (tr - this.roll) * Math.min(1, dt * 2.2);
    this.group.position.set(this.x, this.y, this.z);
    this.group.rotation.set(0, -this.h, 0, 'YXZ');
    this.m.body.rotation.set(this.pitch, 0, this.roll, 'YXZ');
    // rotors: blades strobe slowly (reads as spinning), the blur disc carries the motion
    this.m.rotor.rotation.y += dt * 9.3;
    this.m.rotorDisc.rotation.z += dt * 2.1;
    this.m.tail.rotation.x += dt * 23;
    // lights: beacons pulse, strobes double-flash
    const bp = (Math.sin(t * 7.5) + 1) * 0.5;
    for (const b of this.m.beacons) (b.material as THREE.SpriteMaterial).opacity = 0.25 + 0.75 * bp * bp;
    const sp = (t * 1.1) % 1;
    const strobe = sp < 0.04 || (sp > 0.1 && sp < 0.14);
    for (const s of this.m.strobes) s.visible = strobe;
    this.sound?.setPosition([this.x, this.y, this.z]);
    this.sound?.setRate(0.94 + Math.min(0.14, this.v / 300));

    // ---- attention point: player if seen, else a lissajous sweep of the search area
    this.sweepT += dt;
    let lx: number, lz: number;
    if (this.sees && player) {
      lx = player[0] + (playerVel?.[0] ?? 0) * 0.15; lz = player[2] + (playerVel?.[1] ?? 0) * 0.15;
    } else if (goal && radioed && this.state !== 'leaving') {
      lx = goal[0] + Math.sin(this.sweepT * 1.3) * 3; lz = goal[1] + Math.cos(this.sweepT * 1.1) * 3;
    } else if (goal && this.state !== 'leaving') {
      const sa = this.searchArea?.();
      const r = Math.max(18, Math.min(70, (sa?.r ?? 45) * 0.75));
      lx = goal[0] + Math.sin(this.sweepT * 0.55) * r * 0.9 + Math.sin(this.sweepT * 0.21) * r * 0.25;
      lz = goal[1] + Math.cos(this.sweepT * 0.43) * r * 0.9;
    } else { lx = this.x + fx * 30; lz = this.z + fz * 30; }
    const k = this.sees ? 3.5 : radioed ? 2.2 : 1.1;
    this.ax += (lx - this.ax) * Math.min(1, dt * k);
    this.az += (lz - this.az) * Math.min(1, dt * k);
    const ly = groundY(g, this.ax, this.az, gy);
    const night = nightFactor(g);
    const lampOn = night > 0.25 && this.state !== 'leaving';
    this.light.intensity = lampOn ? 5200 * Math.min(1, night * 1.4) : 0;
    this.group.updateMatrixWorld(true);
    this.m.lamp.getWorldPosition(_v);
    this.light.position.copy(_v);
    _t.set(this.ax, ly, this.az);
    this.lightTarget.position.copy(_t);
    this.lightTarget.updateMatrixWorld();
    // point the lamp housing (-Z = lens) at the target: lookAt aims +Z, so look at the mirrored point
    this.m.lamp.lookAt(_v.x * 2 - _t.x, _v.y * 2 - _t.y, _v.z * 2 - _t.z);
    this.beam.visible = lampOn;
    this.pool.visible = lampOn;
    if (lampOn) {
      aimBeam(this.beam, _v, _t, T.beamHalf);
      const len = _v.distanceTo(_t);
      this.poolR = len * Math.tan(T.beamHalf) * 1.15;
      this.pool.position.set(this.ax, ly + 0.2, this.az);
      this.pool.scale.set(this.poolR, 1, this.poolR);
      (this.beam.material as THREE.ShaderMaterial).uniforms.intensity.value = 0.13 + 0.07 * night;
    }

    // ---- perception: wide downward FLIR cone by day; at night the light pool (plus a narrower FLIR cone)
    this.sees = false;
    if (player && this.state !== 'leaving') {
      const eye: [number, number, number] = [this.x, this.y - 1.5, this.z];
      const cone = night > 0.5 ? T.flirNight : T.flirDay;
      if (canSee({ pos: eye, dir: this.h, fovDeg: 360, range: 150, ir: true, downConeDeg: cone }, player, g, { crouching: false })) this.sees = true;
      else if (lampOn && Math.hypot(player[0] - this.ax, player[2] - this.az) < this.poolR * T.poolSee + 2 &&
        canSee({ pos: eye, dir: this.h, fovDeg: 360, range: 210, ir: true }, player, g, { crouching: false })) this.sees = true;
    }
    this.state = this.state === 'leaving' ? 'leaving' : this.sees ? 'track' : goal && Math.hypot(goal[0] - this.x, goal[1] - this.z) < 140 ? 'search' : 'inbound';
    if (this.state === 'leaving' && player && Math.hypot(player[0] - this.x, player[2] - this.z) > 600) this.gone = true;
    return this.sees;
  }

  dispose() {
    this.sound?.stop();
    this.sound = null;
    this.g.scene.remove(this.group, this.beam, this.pool);
    (this.beam.material as THREE.Material).dispose();
    (this.pool.material as THREE.Material).dispose();
    this.light.intensity = 0;
    this.gone = true;
  }
}
