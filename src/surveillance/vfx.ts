// Takedown VFX: grinder spark fountain (HDR additive streaks + glowing heads, gravity, ground bounces),
// flickering orange point light, hot cut line on the post, spray paint mist, impact dust, held tools.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mats } from './materials';

const N_SPARK = 700;
const N_MIST = 360;

const pointVert = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const pointFrag = /* glsl */ `
varying vec4 vColor;
uniform float uSoft;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = uSoft > 0.5 ? (1.0 - smoothstep(0.2, 1.0, d)) : (1.0 - smoothstep(0.0, 1.0, d));
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb * (uSoft > 0.5 ? 1.0 : a), vColor.a * a);
}`;

export class Sparks {
  readonly obj = new THREE.Group();
  private pos = new Float32Array(N_SPARK * 3);
  private vel = new Float32Array(N_SPARK * 3);
  private life = new Float32Array(N_SPARK);
  private maxLife = new Float32Array(N_SPARK);
  private groundY = new Float32Array(N_SPARK);
  private lines: THREE.LineSegments;
  private heads: THREE.Points;
  private linePos = new Float32Array(N_SPARK * 6);
  private lineCol = new Float32Array(N_SPARK * 6);
  private headPos = new Float32Array(N_SPARK * 3);
  private headCol = new Float32Array(N_SPARK * 4);
  private headSize = new Float32Array(N_SPARK);
  private next = 0;
  private alive = 0;

  constructor() {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.lines.frustumCulled = false;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.BufferAttribute(this.headCol, 4).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this.headSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.heads = new THREE.Points(pg, new THREE.ShaderMaterial({
      vertexShader: pointVert, fragmentShader: pointFrag, uniforms: { uSoft: { value: 0 } },
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false,
    }));
    this.heads.frustumCulled = false;
    this.obj.add(this.lines, this.heads);
    this.obj.name = 'surv-sparks';
    this.obj.renderOrder = 10;
  }

  /** Emit `n` sparks at p, sprayed around `dir` (tangent of the disc), spread radians. */
  emit(p: THREE.Vector3, dir: THREE.Vector3, n: number, groundY: number, speed = 7, spread = 0.55) {
    const t = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
    side.crossVectors(dir, up).normalize();
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % N_SPARK;
      const a = (Math.random() - 0.5) * 2 * spread, b = (Math.random() - 0.5) * 2 * spread * 0.6;
      t.copy(dir).addScaledVector(side, Math.tan(a)).addScaledVector(up2, Math.tan(b)).normalize();
      const s = speed * (0.45 + Math.random() * 0.9);
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.02;
      this.pos[i * 3 + 1] = p.y + (Math.random() - 0.5) * 0.02;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.02;
      this.vel[i * 3] = t.x * s; this.vel[i * 3 + 1] = t.y * s; this.vel[i * 3 + 2] = t.z * s;
      this.maxLife[i] = this.life[i] = 0.35 + Math.random() * 0.9;
      this.groundY[i] = groundY;
    }
  }

  update(dt: number) {
    let alive = 0;
    const drag = Math.exp(-dt * 0.9);
    for (let i = 0; i < N_SPARK; i++) {
      if (this.life[i] <= 0) {
        this.headSize[i] = 0;
        for (let k = 0; k < 6; k++) this.lineCol[i * 6 + k] = 0;
        continue;
      }
      alive++;
      this.life[i] -= dt;
      const o = i * 3;
      this.vel[o + 1] -= 9.81 * dt;
      this.vel[o] *= drag; this.vel[o + 1] *= drag; this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < this.groundY[i] + 0.01 && this.vel[o + 1] < 0) {
        this.pos[o + 1] = this.groundY[i] + 0.01;
        this.vel[o + 1] *= -0.32;
        this.vel[o] *= 0.55; this.vel[o + 2] *= 0.55;
        this.life[i] -= 0.08;
      }
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      // color cools white-yellow → orange → deep red; HDR so bloom picks it up
      const heat = f * f;
      const r = 6 * (0.4 + 0.6 * f), gcol = 6 * (0.12 + 0.6 * heat), b = 6 * (0.02 + 0.3 * heat * heat);
      const tail = 0.022 + 0.018 * f;
      const lp = i * 6;
      this.linePos[lp] = this.pos[o]; this.linePos[lp + 1] = this.pos[o + 1]; this.linePos[lp + 2] = this.pos[o + 2];
      this.linePos[lp + 3] = this.pos[o] - this.vel[o] * tail; this.linePos[lp + 4] = this.pos[o + 1] - this.vel[o + 1] * tail; this.linePos[lp + 5] = this.pos[o + 2] - this.vel[o + 2] * tail;
      this.lineCol[lp] = r; this.lineCol[lp + 1] = gcol; this.lineCol[lp + 2] = b;
      this.lineCol[lp + 3] = r * 0.15; this.lineCol[lp + 4] = gcol * 0.08; this.lineCol[lp + 5] = 0;
      this.headPos[o] = this.pos[o]; this.headPos[o + 1] = this.pos[o + 1]; this.headPos[o + 2] = this.pos[o + 2];
      this.headCol[i * 4] = r * 0.6; this.headCol[i * 4 + 1] = gcol * 0.6; this.headCol[i * 4 + 2] = b * 0.6; this.headCol[i * 4 + 3] = 1;
      this.headSize[i] = 0.035 * (0.5 + f);
    }
    this.alive = alive;
    this.obj.visible = alive > 0;
    const lg = this.lines.geometry, pg = this.heads.geometry;
    (lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (lg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (pg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (pg.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (pg.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }

  get count() { return this.alive; }
}

/** Soft particles for spray paint mist and impact dust (normal blending). */
export class Mist {
  readonly obj: THREE.Points;
  private pos = new Float32Array(N_MIST * 3);
  private vel = new Float32Array(N_MIST * 3);
  private life = new Float32Array(N_MIST);
  private maxLife = new Float32Array(N_MIST);
  private col = new Float32Array(N_MIST * 4);
  private base = new Float32Array(N_MIST * 3);
  private size = new Float32Array(N_MIST);
  private grow = new Float32Array(N_MIST);
  private next = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.obj = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: pointVert, fragmentShader: pointFrag, uniforms: { uSoft: { value: 1 } },
      transparent: true, depthWrite: false,
    }));
    this.obj.frustumCulled = false;
    this.obj.name = 'surv-mist';
  }

  emit(p: THREE.Vector3, dir: THREE.Vector3, n: number, color: THREE.Color, opts: { speed?: number; spread?: number; life?: number; size?: number; grow?: number; alpha?: number } = {}) {
    const speed = opts.speed ?? 5, spread = opts.spread ?? 0.22;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % N_MIST;
      const o = i * 3;
      this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
      const s = speed * (0.6 + Math.random() * 0.6);
      this.vel[o] = (dir.x + (Math.random() - 0.5) * spread * 2) * s;
      this.vel[o + 1] = (dir.y + (Math.random() - 0.5) * spread * 2) * s;
      this.vel[o + 2] = (dir.z + (Math.random() - 0.5) * spread * 2) * s;
      this.maxLife[i] = this.life[i] = (opts.life ?? 0.7) * (0.6 + Math.random() * 0.8);
      this.base[o] = color.r; this.base[o + 1] = color.g; this.base[o + 2] = color.b;
      this.col[i * 4 + 3] = opts.alpha ?? 0.35;
      this.size[i] = opts.size ?? 0.05;
      this.grow[i] = opts.grow ?? 0.5;
    }
  }

  update(dt: number) {
    const drag = Math.exp(-dt * 3.5);
    let any = false;
    for (let i = 0; i < N_MIST; i++) {
      const o = i * 3;
      if (this.life[i] <= 0) { this.col[i * 4 + 3] = 0; this.size[i] = 0; continue; }
      any = true;
      this.life[i] -= dt;
      this.vel[o] *= drag; this.vel[o + 1] = this.vel[o + 1] * drag - 0.25 * dt; this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.size[i] += this.grow[i] * dt;
      this.col[i * 4] = this.base[o]; this.col[i * 4 + 1] = this.base[o + 1]; this.col[i * 4 + 2] = this.base[o + 2];
      this.col[i * 4 + 3] = Math.min(this.col[i * 4 + 3], 0.45) * (f > 0.3 ? 1 : f / 0.3);
    }
    this.obj.visible = any;
    const g = this.obj.geometry;
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Glowing incision ring around the post at the cut height. */
export class CutGlow {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshStandardMaterial;
  heat = 0;
  constructor() {
    this.mat = mats().hotMetal.clone();
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.mat);
    this.mesh.visible = false;
    this.mesh.name = 'surv-cutglow';
  }
  place(center: THREE.Vector3, halfW: number, round: boolean, yaw: number) {
    this.mesh.geometry.dispose();
    this.mesh.geometry = round ? new THREE.CylinderGeometry(halfW * 1.02, halfW * 1.02, 0.014, 24, 1, true) : new THREE.BoxGeometry(halfW * 2.04, 0.014, halfW * 2.04);
    this.mesh.position.copy(center);
    this.mesh.rotation.set(0, yaw, 0);
    this.mesh.visible = true;
  }
  update(dt: number, cooling: boolean) {
    if (cooling) this.heat = Math.max(0, this.heat - dt * 0.12);
    const flick = cooling ? 1 : 0.8 + Math.random() * 0.4;
    this.mat.emissiveIntensity = this.heat * 9 * flick;
    this.mat.emissive.setRGB(1, 0.28 + this.heat * 0.35, 0.05 + this.heat * 0.1);
    if (cooling && this.heat <= 0) this.mesh.visible = false;
  }
}

/** Battery angle grinder, built at real scale (~0.35 m), disc at origin facing +X. */
export function buildGrinder(): THREE.Group {
  const M = mats();
  const g = new THREE.Group();
  g.name = 'surv-grinder';
  const body = new THREE.MeshStandardMaterial({ color: '#2d6b3a', roughness: 0.5, metalness: 0.05 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); m.castShadow = true; g.add(m); return m;
  };
  add(new THREE.CylinderGeometry(0.032, 0.036, 0.22, 16), body, 0, 0, -0.16, Math.PI / 2);
  add(new RoundedBoxGeometry(0.07, 0.09, 0.1, 2, 0.01), M.plasticDark, 0, -0.01, -0.3);
  add(new THREE.CylinderGeometry(0.04, 0.04, 0.06, 16), M.aluminum, 0, 0, -0.04, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 10), M.plasticDark, 0, 0.06, -0.06);
  add(new THREE.CylinderGeometry(0.063, 0.063, 0.004, 32), new THREE.MeshStandardMaterial({ color: '#555', roughness: 0.6, metalness: 0.6 }), 0.03, 0, 0, 0, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.068, 0.068, 0.03, 24, 1, true, 0, Math.PI), M.steelDark, 0.02, 0, 0, 0, 0, Math.PI / 2);
  return g;
}

/** Telescopic paint pole with a spray can at the tip (length set by scale.z). Tip at (0,0,-1). */
export function buildPaintPole(): { group: THREE.Group; setLength(l: number): void; tip: THREE.Object3D } {
  const M = mats();
  const group = new THREE.Group();
  group.name = 'surv-paintpole';
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, 1, 8).rotateX(Math.PI / 2).translate(0, 0, -0.5), M.aluminum);
  pole.castShadow = true;
  const tip = new THREE.Group();
  const can = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.19, 16), new THREE.MeshStandardMaterial({ color: '#c8341f', roughness: 0.35, metalness: 0.6 }));
  can.rotation.x = Math.PI / 2;
  can.position.z = -0.05;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.03, 12), M.plasticWhite);
  cap.rotation.x = Math.PI / 2;
  cap.position.z = -0.16;
  tip.add(can, cap);
  group.add(pole, tip);
  return {
    group, tip,
    setLength(l: number) { pole.scale.set(1, 1, l); tip.position.set(0, 0, -l); },
  };
}
