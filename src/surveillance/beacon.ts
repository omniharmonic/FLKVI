// Target beacon: a floating amber diamond above the selected camera plus a faint vertical light beam that
// stays readable at distance (scaled to keep a minimum on-screen size).
import * as THREE from 'three';

const beamVert = /* glsl */ `
varying float vH;
varying vec2 vUv;
void main() { vH = position.y; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const beamFrag = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
varying float vH; varying vec2 vUv;
void main() {
  float fade = exp(-vH / 55.0) * smoothstep(0.0, 2.0, vH);
  float core = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float pulse = 0.75 + 0.25 * sin(vH * 0.25 - uTime * 4.0);
  gl_FragColor = vec4(uColor * fade * core * pulse * uAlpha, 1.0);
}`;

export class Beacon {
  readonly obj = new THREE.Group();
  private diamond: THREE.Mesh;
  private beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private diaMat: THREE.MeshBasicMaterial;
  distance: number | null = null;

  constructor() {
    this.obj.name = 'surv-beacon';
    this.diaMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 1.9, 0.35), toneMapped: false, transparent: true, opacity: 0.95 });
    this.diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0).scale(0.75, 1.2, 0.75), this.diaMat);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(this.diamond.geometry), new THREE.LineBasicMaterial({ color: new THREE.Color(5, 3.5, 1), toneMapped: false }));
    this.diamond.add(edge);
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: beamVert, fragmentShader: beamFrag,
      uniforms: { uColor: { value: new THREE.Color(1.0, 0.62, 0.15) }, uAlpha: { value: 0.5 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    });
    const bg = new THREE.PlaneGeometry(0.5, 160, 1, 32).translate(0, 80, 0);
    this.beam = new THREE.Mesh(bg, this.beamMat);
    this.beam.frustumCulled = false;
    this.obj.add(this.diamond, this.beam);
    this.obj.visible = false;
    this.obj.renderOrder = 20;
  }

  update(t: number, target: THREE.Vector3 | null, top: number, viewer: THREE.Vector3, camPos: THREE.Vector3) {
    if (!target) { this.obj.visible = false; this.distance = null; return; }
    this.obj.visible = true;
    this.distance = Math.hypot(target.x - viewer.x, target.z - viewer.z);
    const camD = camPos.distanceTo(target);
    const s = Math.max(1, camD / 35);
    this.diamond.scale.setScalar(s);
    this.diamond.position.set(target.x, top + 1.6 * s + Math.sin(t * 2) * 0.2 * s, target.z);
    this.diamond.rotation.y = t * 1.4;
    this.beam.position.set(target.x, top, target.z);
    // beam billboard around Y toward the camera, widening with distance
    this.beam.rotation.y = Math.atan2(camPos.x - target.x, camPos.z - target.z);
    this.beam.scale.set(Math.max(1, camD / 60), 1, 1);
    this.beamMat.uniforms.uTime.value = t;
    // fade out when standing right under it
    const near = Math.min(1, Math.max(0, (this.distance - 4) / 20));
    this.beamMat.uniforms.uAlpha.value = 0.55 * near;
    this.diaMat.opacity = 0.35 + 0.6 * near;
  }
}
