// In-world vision cone readability: a faint additive light-cone volume per lens plus a ground footprint fan
// (LOS-occluded for static cameras). Visible while holding Q (scan), near a discovered camera, or when a
// camera currently sees the player (then red).
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Cam, Network } from './network';
import { TUNE } from './constants';

const DEG = Math.PI / 180;

const coneVert = /* glsl */ `
attribute vec3 aCone; // u (across), v (vertical), t (along)
varying vec3 vCone;
varying vec3 vN;
varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vCone = aCone;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
const coneFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vCone;
varying vec3 vN;
varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float t = vCone.z;
  float fall = pow(clamp(1.0 - t, 0.0, 1.0), 1.7) * smoothstep(0.0, 0.06, t);
  float edge = smoothstep(0.55, 1.0, max(abs(vCone.x), abs(vCone.y)));
  float graze = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float scan = 0.5 + 0.5 * sin((t * 10.0 - uTime * 2.2));
  float a = uIntensity * fall * (0.18 + 0.55 * graze * graze + 0.35 * edge) * (0.85 + 0.15 * scan);
  gl_FragColor = vec4(uColor * a, 1.0);
}`;
const fanFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vCone;
varying vec3 vN;
varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float t = vCone.z;         // radial 0..1
  float los = vCone.y;       // baked line-of-sight 0..1
  float edge = smoothstep(0.82, 1.0, abs(vCone.x));
  float rim = smoothstep(0.93, 1.0, t) * (1.0 - smoothstep(1.0, 1.02, t));
  float sweep = smoothstep(0.0, 0.08, fract(t * 2.5 - uTime * 0.35)) * (1.0 - smoothstep(0.08, 0.2, fract(t * 2.5 - uTime * 0.35)));
  float fall = pow(clamp(1.0 - t, 0.0, 1.0), 0.7);
  float a = uIntensity * los * (0.22 * fall + 0.8 * edge * fall + 0.5 * rim + 0.25 * sweep * fall);
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

function makeMat(frag: string) {
  return new THREE.ShaderMaterial({
    vertexShader: coneVert, fragmentShader: frag,
    uniforms: { uColor: { value: new THREE.Color(0.7, 0.9, 1) }, uIntensity: { value: 0 }, uTime: { value: 0 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}

/** Pyramid frustum with apex at origin looking down -Z. */
function coneGeometry(hFovDeg: number, vFovDeg: number, range: number): THREE.BufferGeometry {
  const ha = Math.min(hFovDeg, 170) * 0.5 * DEG, va = vFovDeg * 0.5 * DEG;
  const K = 12;
  const pos: number[] = [], cone: number[] = [];
  const far = (u: number, v: number) => new THREE.Vector3(Math.tan(ha) * u * range, Math.tan(va) * v * range, -range);
  const edges: [number, number, number, number][] = [];
  // walk the far rectangle perimeter
  for (let i = 0; i < K; i++) { const a = -1 + (2 * i) / K, b = -1 + (2 * (i + 1)) / K; edges.push([a, -1, b, -1], [a, 1, b, 1], [-1, a, -1, b], [1, a, 1, b]); }
  for (const [u0, v0, u1, v1] of edges) {
    const p0 = far(u0, v0), p1 = far(u1, v1);
    pos.push(0, 0, 0, p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    cone.push(u0, v0, 0, u0, v0, 1, u1, v1, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCone', new THREE.Float32BufferAttribute(cone, 3));
  g.computeVertexNormals();
  return g;
}

interface ConeViz {
  cam: Cam;
  root: THREE.Group;
  cones: THREE.Mesh[];
  fans: THREE.Mesh[];
  mats: THREE.ShaderMaterial[];
  fade: number;
  target: number;
}

export class VisionViz {
  private viz = new Map<string, ConeViz>();
  private root = new THREE.Group();
  scanning = false;
  private red = new THREE.Color(1.0, 0.12, 0.08);
  private day = new THREE.Color(0.75, 0.92, 1.0);
  private nightC = new THREE.Color(0.55, 0.8, 1.0);
  private amber = new THREE.Color(1.0, 0.7, 0.25);

  constructor(private g: Game, private net: Network, parent: THREE.Object3D) {
    this.root.name = 'surv-vision';
    parent.add(this.root);
  }

  /** Force-show cones for specific cameras (dev / debugging). */
  forceAll = false;

  update(dt: number, t: number, night: number, playerPos: THREE.Vector3 | null) {
    for (const cam of this.net.cams) {
      let want = 0;
      if (cam.status === 'active' && (cam.discovered || this.forceAll)) {
        const d = playerPos ? Math.hypot(cam.work.x - playerPos.x, cam.work.z - playerPos.z) : 0;
        if (this.forceAll) want = 1;
        else if (this.scanning && d < TUNE.scanRadius) want = 1;
        else if (d < TUNE.proximityConeRadius) want = 0.55 + 0.45 * (1 - d / TUNE.proximityConeRadius);
        if (cam.seesPlayer && d < 120) want = 1;
      }
      let v = this.viz.get(cam.rc.id);
      if (!v && want > 0) v = this.create(cam);
      if (!v) continue;
      v.target = want;
      v.fade += (want - v.fade) * Math.min(1, dt * (want > v.fade ? 6 : 3));
      if (v.fade < 0.01 && want === 0) { this.destroy(v); continue; }
      v.root.visible = true;
      v.root.matrix.copy(cam.headM);
      v.root.matrixWorldNeedsUpdate = true;
      const col = cam.seesPlayer ? this.red : cam.rc.plateReader ? this.amber : night > 0.5 ? this.nightC : this.day;
      const base = (this.scanning ? 0.34 : 0.22) + night * 0.35;
      for (const m of v.mats) {
        m.uniforms.uColor.value.lerp(col, Math.min(1, dt * 8));
        m.uniforms.uIntensity.value = v.fade * (m.userData.fan ? base * 1.25 : base) * (cam.seesPlayer ? 1.6 : 1);
        m.uniforms.uTime.value = t;
      }
      // fans live in the ground plane under the camera and rotate with the sweep
      for (const f of v.fans) {
        f.position.set(cam.work.x, 0, cam.work.z);
        f.rotation.set(0, -cam.lookHeading, 0);
        f.updateMatrix();
      }
    }
  }

  private lensFov(cam: Cam) { return this.net.lensFov(cam); }

  private create(cam: Cam): ConeViz {
    const root = new THREE.Group();
    root.matrixAutoUpdate = false;
    root.name = `surv-cone-${cam.rc.id}`;
    this.root.add(root);
    const v: ConeViz = { cam, root, cones: [], fans: [], mats: [], fade: 0, target: 0 };
    const hf = this.lensFov(cam);
    const lenses = cam.model.lenses;
    for (const lens of lenses) {
      const mat = makeMat(coneFrag);
      const cone = new THREE.Mesh(coneGeometry(hf, Math.min(40, hf * 0.6), cam.rc.rangeM), mat);
      cone.position.copy(lens.p);
      cone.lookAt(lens.p.clone().sub(lens.d)); // lookAt points +Z at target; we want -Z along d
      cone.frustumCulled = false;
      cone.renderOrder = 5;
      root.add(cone);
      v.cones.push(cone);
      v.mats.push(mat);
      // ground fan (world-space, not a child of the head)
      const fm = makeMat(fanFrag);
      fm.userData.fan = true;
      const yaw = Math.atan2(lens.d.x, -lens.d.z); // clockwise heading offset of this lens
      const fan = new THREE.Mesh(this.fanGeometry(cam, hf, yaw), fm);
      fan.matrixAutoUpdate = false;
      fan.frustumCulled = false;
      fan.renderOrder = 4;
      this.root.add(fan);
      v.fans.push(fan);
      v.mats.push(fm);
    }
    this.viz.set(cam.rc.id, v);
    return v;
  }

  /** Sector on the ground (local frame: origin at camera base, heading 0 = -Z). */
  private fanGeometry(cam: Cam, hFov: number, lensYaw: number): THREE.BufferGeometry {
    const A = 18, Rn = 10;
    const range = cam.rc.rangeM;
    const eyeH = Math.max(1, cam.eye.y - cam.groundY);
    const rNear = Math.min(range * 0.5, eyeH / Math.tan(TUNE.maxDownAngleDeg * DEG));
    const half = Math.min(hFov, 179) * 0.5 * DEG;
    const w = this.g.world;
    const staticCam = !cam.rc.sweep;
    const pos: number[] = [], attr: number[] = [];
    const idx: number[] = [];
    const cosH = Math.cos(cam.lookHeading), sinH = Math.sin(cam.lookHeading);
    for (let j = 0; j <= Rn; j++) {
      const t = j / Rn;
      const r = rNear + (range - rNear) * t;
      for (let i = 0; i <= A; i++) {
        const u = -1 + (2 * i) / A;
        const a = lensYaw + u * half; // clockwise from -Z
        const lx = Math.sin(a) * r, lz = -Math.cos(a) * r;
        // world position for terrain height (fan rotated by current look heading)
        const wx = cam.work.x + lx * cosH - lz * sinH, wz = cam.work.z + lx * sinH + lz * cosH;
        let gy = cam.groundY;
        try { if (w?.groundAt) gy = w.groundAt(wx, wz); } catch { /* */ }
        let los = 1;
        if (staticCam && w?.losBlocked) {
          try { los = w.losBlocked([cam.eye.x, cam.eye.y, cam.eye.z], [wx, gy + 0.4, wz]) ? 0 : 1; } catch { /* */ }
        }
        pos.push(lx, gy + 0.07, lz);
        attr.push(u, los, t);
      }
    }
    for (let j = 0; j < Rn; j++) for (let i = 0; i < A; i++) {
      const a = j * (A + 1) + i, b = a + 1, c = a + A + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCone', new THREE.Float32BufferAttribute(attr, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private destroy(v: ConeViz) {
    this.root.remove(v.root);
    for (const f of v.fans) this.root.remove(f);
    for (const m of [...v.cones, ...v.fans]) m.geometry.dispose();
    for (const m of v.mats) m.dispose();
    this.viz.delete(v.cam.rc.id);
  }

  /** Drop cached geometry (after world/cameras change). */
  reset() { for (const v of [...this.viz.values()]) this.destroy(v); }
}
