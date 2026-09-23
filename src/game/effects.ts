// Pooled particle smoke (engine damage, tire smoke, dust). One draw call.
import * as THREE from 'three';

const MAX = 600;

export class Smoke {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX);
  private life = new Float32Array(MAX);
  private size = new Float32Array(MAX);
  private grow = new Float32Array(MAX);
  private alpha = new Float32Array(MAX);
  private a0 = new Float32Array(MAX);
  private shade = new Float32Array(MAX);
  private next = 0;
  private geo: THREE.BufferGeometry;

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aShade', new THREE.BufferAttribute(this.shade, 1).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uScale: { value: 600 }, uLight: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; attribute float aShade;
        varying float vAlpha; varying float vShade;
        uniform float uScale;
        void main() {
          vAlpha = aAlpha; vShade = aShade;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying float vShade; uniform float uLight;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c) * 2.0;
          if (d > 1.0) discard;
          float a = (1.0 - d * d) * vAlpha;
          // cheap fake noise so puffs aren't perfect discs
          a *= 0.75 + 0.25 * sin(gl_PointCoord.x * 13.0 + gl_PointCoord.y * 7.0);
          gl_FragColor = vec4(vec3(vShade) * uLight, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.name = 'smoke';
    this.points.renderOrder = 10;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, opts: { size: number; grow: number; life: number; shade: number; alpha?: number }) {
    const i = this.next;
    this.next = (this.next + 1) % MAX;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.age[i] = 0;
    this.life[i] = opts.life;
    this.size[i] = opts.size;
    this.grow[i] = opts.grow;
    this.shade[i] = opts.shade;
    this.a0[i] = opts.alpha ?? 0.5;
    this.alpha[i] = 0;
    (this.geo.attributes.aShade as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, light = 1, viewportH = 800) {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = viewportH * 0.9;
    (this.points.material as THREE.ShaderMaterial).uniforms.uLight.value = light;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) { this.life[i] = 0; this.alpha[i] = 0; continue; }
      alive++;
      const k = i * 3;
      this.vel[k + 1] += 0.6 * dt; // buoyancy
      this.vel[k] *= 1 - 0.8 * dt; this.vel[k + 2] *= 1 - 0.8 * dt;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = this.a0[i] * (1 - t) * (t < 0.1 ? t * 10 : 1);
    }
    const a = this.geo.attributes;
    (a.position as THREE.BufferAttribute).needsUpdate = true;
    (a.aSize as THREE.BufferAttribute).needsUpdate = true;
    (a.aAlpha as THREE.BufferAttribute).needsUpdate = true;
    this.points.visible = alive > 0;
  }
}
