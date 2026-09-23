// Driving FX: tire skid-mark decal trails (one ring-buffered mesh) and collision sparks (one Points pool).
import * as THREE from 'three';

const MAX_SEG = 3000;

/** Ring buffer of flat quads laid on the road behind sliding tires. One draw call. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(MAX_SEG * 4 * 3);
  private col = new Float32Array(MAX_SEG * 4 * 4);
  private next = 0;
  private tracks = new Map<string, { p: THREE.Vector3; l: THREE.Vector3; r: THREE.Vector3; a: number; t: number }>();
  private dirty = false;
  private minIdx = Infinity;
  private maxIdx = -1;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(MAX_SEG * 6);
    for (let i = 0; i < MAX_SEG; i++) {
      const a = i * 4;
      idx.set([a, a + 2, a + 1, a + 1, a + 2, a + 3], i * 6);
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.MeshBasicMaterial({
      color: 0x0b0b0b, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    m.name = 'skidmarks';
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'skidmarks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Continue (or start) the trail `key` at contact point p. `side` = car right vector, `w` tire width, `a` 0..1 darkness. */
  add(key: string, p: THREE.Vector3, side: THREE.Vector3, w: number, a: number, now: number) {
    const hw = w / 2;
    const l = p.clone().addScaledVector(side, -hw), r = p.clone().addScaledVector(side, hw);
    const tr = this.tracks.get(key);
    if (!tr || now - tr.t > 0.12 || tr.p.distanceToSquared(p) > 4) {
      this.tracks.set(key, { p: p.clone(), l, r, a, t: now });
      return;
    }
    if (tr.p.distanceToSquared(p) < 0.04) { tr.t = now; return; } // < 20 cm: wait for more travel
    const i = this.next;
    this.next = (this.next + 1) % MAX_SEG;
    const o = i * 12;
    const put = (k: number, v: THREE.Vector3) => { this.pos[o + k * 3] = v.x; this.pos[o + k * 3 + 1] = v.y; this.pos[o + k * 3 + 2] = v.z; };
    put(0, tr.l); put(1, tr.r); put(2, l); put(3, r);
    const c = i * 16;
    const a0 = Math.min(0.75, tr.a * 0.75), a1 = Math.min(0.75, a * 0.75);
    for (let k = 0; k < 4; k++) {
      this.col[c + k * 4] = this.col[c + k * 4 + 1] = this.col[c + k * 4 + 2] = 1;
      this.col[c + k * 4 + 3] = k < 2 ? a0 : a1;
    }
    tr.p.copy(p); tr.l.copy(l); tr.r.copy(r); tr.a = a; tr.t = now;
    this.minIdx = Math.min(this.minIdx, i);
    this.maxIdx = Math.max(this.maxIdx, i);
    this.dirty = true;
  }

  end(key: string) { this.tracks.delete(key); }

  update() {
    if (!this.dirty) return;
    const g = this.mesh.geometry;
    const pa = g.attributes.position as THREE.BufferAttribute, ca = g.attributes.color as THREE.BufferAttribute;
    pa.clearUpdateRanges(); ca.clearUpdateRanges();
    pa.addUpdateRange(this.minIdx * 12, (this.maxIdx - this.minIdx + 1) * 12);
    ca.addUpdateRange(this.minIdx * 16, (this.maxIdx - this.minIdx + 1) * 16);
    pa.needsUpdate = true; ca.needsUpdate = true;
    this.dirty = false;
    this.minIdx = Infinity; this.maxIdx = -1;
  }
}

const MAX_SPARK = 400;

/** Bright additive spark streaks with gravity + bounce-free fade. One draw call. */
export class Sparks {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX_SPARK * 3);
  private vel = new Float32Array(MAX_SPARK * 3);
  private life = new Float32Array(MAX_SPARK);
  private age = new Float32Array(MAX_SPARK);
  private alpha = new Float32Array(MAX_SPARK);
  private next = 0;
  private alive = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float aAlpha; varying float vA; uniform float uScale;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = max(1.5, 0.05 * uScale / max(0.1, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0 || vA <= 0.0) discard;
          float k = (1.0 - d) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.62, 0.22) * (2.5 + 5.0 * vA) * k, k);
        }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.name = 'sparks';
    this.points.frustumCulled = false;
    this.points.renderOrder = 11;
  }

  /** Burst of n sparks at p, thrown along dir (world) with spread. */
  emit(p: THREE.Vector3, dir: THREE.Vector3, n: number, speed = 6) {
    const r = Math.random;
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_SPARK;
      this.pos.set([p.x, p.y, p.z], i * 3);
      const s = speed * (0.4 + r() * 0.8);
      this.vel.set([dir.x * s + (r() - 0.5) * speed, dir.y * s + r() * speed * 0.6, dir.z * s + (r() - 0.5) * speed], i * 3);
      this.life[i] = 0.25 + r() * 0.45;
      this.age[i] = 0;
    }
    this.alive = MAX_SPARK;
  }

  update(dt: number, viewportH: number) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewportH;
    if (!this.alive) { this.points.visible = false; return; }
    let alive = 0;
    for (let i = 0; i < MAX_SPARK; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.alpha[i] = 0; continue; }
      alive++;
      const k = i * 3;
      this.vel[k + 1] -= 9.8 * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.alpha[i] = 1 - t;
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
