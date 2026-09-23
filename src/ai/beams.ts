// Fake volumetric light beams (additive cone shader) + ground light pools, shared by the police
// helicopter searchlight and officer flashlights. Cheap: no real volumetrics, one draw per beam.
import * as THREE from 'three';

/** Unit cone: apex at the origin, base (radius 1) at y = -1. Orient -Y toward the target and scale (r, len, r). */
export const BEAM_GEO = (() => {
  const g = new THREE.ConeGeometry(1, 1, 28, 6, true);
  g.translate(0, -0.5, 0);
  return g;
})();

const beamVert = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const beamFrag = /* glsl */ `
uniform vec3 color;
uniform float intensity;
uniform float falloff;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  float t = 1.0 - vUv.y;               // 0 at the lamp, 1 at the ground
  float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.8); // soft silhouette, bright core
  float along = smoothstep(0.0, 0.04, t) * mix(1.0, 0.28, pow(t, falloff));
  float a = intensity * edge * along;
  gl_FragColor = vec4(color * a, a);
}`;

/** Additive "dusty air" beam material. */
export function makeBeamMaterial(color: THREE.ColorRepresentation, intensity: number, falloff = 0.8): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, intensity: { value: intensity }, falloff: { value: falloff } },
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
}

let poolTex: THREE.Texture | null = null;
function poolTexture(): THREE.Texture {
  if (poolTex) return poolTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.85, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  poolTex = new THREE.CanvasTexture(c);
  return poolTex;
}

/** Unit ground disc (radius 1) lying flat; scale x/z by the pool radius. */
export const POOL_GEO = (() => {
  const g = new THREE.PlaneGeometry(2, 2);
  g.rotateX(-Math.PI / 2);
  return g;
})();

/** Additive light pool drawn on the ground (reads as a lit circle even without a real light). */
export function makePoolMaterial(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: poolTexture(), color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: false, toneMapped: false,
  });
}

let glowTex: THREE.Texture | null = null;
/** Soft round glow sprite texture (nav lights, beacons). */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

const _up = new THREE.Vector3(0, -1, 0);
const _d = new THREE.Vector3();

/** Point a BEAM_GEO mesh from `from` to `to` with the given half-angle (radians). */
export function aimBeam(mesh: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, halfAngle: number) {
  _d.subVectors(to, from);
  const len = Math.max(0.01, _d.length());
  mesh.position.copy(from);
  const r = len * Math.tan(halfAngle);
  mesh.scale.set(r, len, r);
  mesh.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / len));
}
