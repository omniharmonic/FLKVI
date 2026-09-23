// OWNER: landmarks. PBR materials for hero landmarks (library textures, cloned so the shared cache
// is never mutated) with a cheap "floodlit facade" night term: emissive = albedo × warm flood ×
// night, strongest at the base and fading up the facade, weaker on up-facing surfaces. No real lights.
import * as THREE from 'three';
import { pbrMaterial, type PbrOptions } from '../../assets/library';

/** Shared night factor (0 day .. 1 night) driving every landmark flood/lamp term. */
export const landmarkNight = { value: 0 };

export interface FloodOpts {
  /** Flood tint (linear-ish, multiplied by albedo). */
  color?: string;
  /** Peak flood strength at the base. */
  strength?: number;
  /** e-folding height of the flood falloff (m). */
  falloff?: number;
  /** Floor of the flood term at the top of the facade (fraction of strength). */
  top?: number;
}

function addFlood(mat: THREE.MeshStandardMaterial, f: FloodOpts) {
  const uColor = { value: new THREE.Color(f.color ?? '#ffd9a8') };
  const uS = { value: f.strength ?? 0.55 };
  const uF = { value: f.falloff ?? 14 };
  const uTop = { value: f.top ?? 0.3 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.lmNight = landmarkNight;
    sh.uniforms.lmFloodColor = uColor;
    sh.uniforms.lmFlood = uS;
    sh.uniforms.lmFall = uF;
    sh.uniforms.lmTop = uTop;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLmY; varying float vLmUp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLmY = position.y; vLmUp = abs(normal.y);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLmY; varying float vLmUp; uniform float lmNight; uniform vec3 lmFloodColor; uniform float lmFlood; uniform float lmFall; uniform float lmTop;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float lmH = max(vLmY, 0.0);
          float lmK = mix(lmTop, 1.0, exp(-lmH / lmFall)) * (1.0 - 0.65 * vLmUp);
          totalEmissiveRadiance += diffuseColor.rgb * lmFloodColor * (0.5 * lmFlood * lmNight * lmK);
        }`);
  };
  mat.customProgramCacheKey = () => 'lm-flood';
}

/** Cloned library PBR material + optional flood term. */
export function stoneMat(id: string, opts: PbrOptions = {}, flood: FloodOpts | null = {}): THREE.MeshStandardMaterial {
  const m = pbrMaterial(id, opts).clone();
  m.name = `landmark:${id}`;
  if (flood) addFlood(m, flood);
  return m;
}

/** Flat PBR material (no texture) + optional flood term. */
export function flatMat(color: string, roughness: number, metalness = 0, flood: FloodOpts | null = null, extra: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  m.name = 'landmark:flat';
  if (flood) addFlood(m, flood);
  return m;
}

/** Self-lit element (lamps, lit windows, clock faces) whose emissive fades in at night. */
export interface NightLamp { mat: THREE.MeshStandardMaterial; day: number; night: number }
export function lampMat(color: string, emissive: string, day: number, night: number, lamps: NightLamp[], roughness = 0.4, metalness = 0): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity: day });
  mat.name = 'landmark:lamp';
  lamps.push({ mat, day, night });
  return mat;
}
