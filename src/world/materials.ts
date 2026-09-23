// Shared world materials: CC0 texture sets from the asset library when available, else procedural fallbacks.
// All surface UVs are in METERS (texture repeat = 1/sizeM).
import * as THREE from 'three';
import { textureSet, type TextureId } from '../assets/library';
import { procSet } from './textures';

export interface SurfaceMaps { map?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture; aoMap?: THREE.Texture; sizeM: number; fromLibrary: boolean }

const PROC_FOR: Partial<Record<TextureId, string>> = {
  asphalt: 'asphalt', 'asphalt-worn': 'asphalt', concrete: 'concrete', 'concrete-sidewalk': 'concrete', curb: 'curb',
  grass: 'grass', dirt: 'dirt', gravel: 'gravel', paving: 'paving', cobble: 'paving', stone: 'rock',
};

const surfCache = new Map<string, SurfaceMaps>();
/** Library texture set cloned with repeat=1/sizeM, or a procedural fallback. */
export function surface(id: TextureId, fallback?: string): SurfaceMaps {
  const key = id + '|' + (fallback ?? '');
  const hit = surfCache.get(key);
  if (hit) return hit;
  let out: SurfaceMaps;
  const ts = textureSet(id);
  if (ts && ts.maps.map) {
    const rep = 1 / ts.sizeM;
    const cl = (t?: THREE.Texture) => {
      if (!t) return undefined;
      const c = t.clone();
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(rep, rep);
      c.anisotropy = 8;
      c.needsUpdate = true;
      return c;
    };
    out = { map: cl(ts.maps.map), normalMap: cl(ts.maps.normalMap), roughnessMap: cl(ts.maps.roughnessMap), aoMap: cl(ts.maps.aoMap), sizeM: ts.sizeM, fromLibrary: true };
  } else {
    const p = procSet(fallback ?? PROC_FOR[id] ?? 'concrete');
    const rep = 1 / p.sizeM;
    const cl = (t?: THREE.Texture) => { if (!t) return undefined; const c = t.clone(); c.repeat.set(rep, rep); c.needsUpdate = true; return c; };
    out = { map: cl(p.map), normalMap: cl(p.normalMap), roughnessMap: cl(p.roughnessMap), sizeM: p.sizeM, fromLibrary: false };
  }
  surfCache.set(key, out);
  return out;
}

/** GLSL: hash-based value noise + fbm for macro variation. */
export const NOISE_GLSL = /* glsl */ `
float gt_hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float gt_noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(gt_hash(i),gt_hash(i+vec2(1,0)),f.x), mix(gt_hash(i+vec2(0,1)),gt_hash(i+vec2(1,1)),f.x), f.y); }
float gt_fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<4;i++){ s+=a*gt_noise(p); p*=2.03; a*=0.5; } return s; }
`;

export interface PatchOpts {
  /** Macro brightness variation amount (0..0.5) and world scale (m). */
  macro?: number; macroScale?: number;
  /** Anti-tiling second map sample at different scale. */
  antiTile?: boolean;
  /** Sidewalk expansion joints: spacing in meters along uv.x; also joint at uv.y = 0 edge. */
  joints?: number;
  /** Tint variation towards a color by noise (e.g. dry patches). */
  tintVar?: THREE.Color; tintAmt?: number;
  /** Extra per-material hook. */
  extraFrag?: string;
}

/** Inject world-space varyings + macro variation into a MeshStandardMaterial. */
export function patchSurface(mat: THREE.MeshStandardMaterial, o: PatchOpts) {
  const key = JSON.stringify({ ...o, tintVar: o.tintVar?.getHexString() });
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.gtTint = { value: o.tintVar ?? new THREE.Color(1, 1, 1) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGtW;\nvarying vec2 vGtUv;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef USE_INSTANCING
          vGtW = (modelMatrix * instanceMatrix * vec4(transformed,1.0)).xyz;
        #else
          vGtW = (modelMatrix * vec4(transformed,1.0)).xyz;
        #endif
        vGtUv = uv;`);
    let mapCode = `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        ${o.antiTile ? `
        vec4 s2 = texture2D( map, vMapUv * 0.27 + vec2(0.31, 0.77) );
        float at = smoothstep(0.35, 0.65, gt_noise(vGtW.xz * 0.06));
        sampledDiffuseColor = mix(sampledDiffuseColor, s2, at * 0.6);` : ''}
        diffuseColor *= sampledDiffuseColor;
      #endif
      ${o.macro ? `
        float mv = gt_fbm(vGtW.xz / ${(o.macroScale ?? 20).toFixed(2)});
        diffuseColor.rgb *= 1.0 + (mv - 0.5) * ${(o.macro * 2).toFixed(3)};` : ''}
      ${o.tintVar ? `
        float tv = smoothstep(0.45, 0.75, gt_fbm(vGtW.xz / 9.0 + 17.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * gtTint, tv * ${(o.tintAmt ?? 0.5).toFixed(3)});` : ''}
      ${o.joints ? `
        float ja = abs(fract(vGtUv.x / ${o.joints.toFixed(3)} + 0.5) - 0.5) * ${o.joints.toFixed(3)};
        float jline = 1.0 - smoothstep(0.004, 0.018, ja);
        float edge = 1.0 - smoothstep(0.02, 0.05, vGtUv.y);
        diffuseColor.rgb *= 1.0 - 0.45 * max(jline, edge * 0.6);` : ''}
      ${o.extraFrag ?? ''}
    `;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vGtW;\nvarying vec2 vGtUv;\nuniform vec3 gtTint;\n${NOISE_GLSL}`)
      .replace('#include <map_fragment>', mapCode);
  };
  return mat;
}

export function surfaceMaterial(id: TextureId, opts: { tint?: THREE.ColorRepresentation; roughness?: number; metalness?: number; normalScale?: number; fallback?: string; patch?: PatchOpts; polygonOffset?: number } = {}) {
  const s = surface(id, opts.fallback);
  const m = new THREE.MeshStandardMaterial({
    map: s.map ?? null, normalMap: s.normalMap ?? null, roughnessMap: s.roughnessMap ?? null, aoMap: s.aoMap ?? null,
    color: new THREE.Color(opts.tint ?? '#ffffff'), roughness: opts.roughness ?? 1, metalness: opts.metalness ?? 0,
  });
  if (s.normalMap) m.normalScale.setScalar(opts.normalScale ?? 1);
  if (opts.polygonOffset) { m.polygonOffset = true; m.polygonOffsetFactor = opts.polygonOffset; m.polygonOffsetUnits = opts.polygonOffset; }
  m.name = id;
  if (opts.patch) patchSurface(m, opts.patch);
  return m;
}
