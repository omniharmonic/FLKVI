// Vegetation: ez-tree generated broadleaf/conifer variants + procedural palms, cacti, succulents, grasses,
// flowers and shrubs (plants.ts). All instanced: full LOD < fullDist, reduced LOD < nearDist, cross-billboard
// impostors beyond (small plants are culled instead). Wind sway, per-instance hue/value jitter and sun
// back-lighting (translucency) are shader patches shared by every vegetation material.
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import type { RecipeTree } from '../core/types';
import { rng, hashString } from '../core/geo';
import { textureSet } from '../assets/library';
import { yieldFrame } from './util';
import { plantAtlas, foliageTexture } from './plantAtlas';
import { buildProc, mossFor, blossomsFor, PROC_REF_H, type ProcKind } from './plants';

type BarkKind = 'lib' | 'birch' | 'pine' | 'oak' | 'willow';
interface EzProfile {
  kind: 'ez';
  preset: string;
  leafTint: number; barkTint: number;
  bark?: BarkKind;
  /** bark texture repeat (u around, v along) */
  barkRep?: [number, number];
  tweak?: (o: any) => void;
  leafType?: 'oak' | 'ash' | 'aspen' | 'pine';
  /** custom canvas leaf-card texture (plantAtlas.foliageTexture) */
  foliage?: 'fine' | 'small';
  leafRough?: number;
  extra?: 'moss' | 'blossom';
  extraTint?: number;
  /** trunk radius / height for physics */
  trunkK?: number;
  fallback?: string;
}
interface ProcProfile { kind: 'proc'; proc: ProcKind; trunkR?: number; fallback?: string }
type Profile = EzProfile | ProcProfile;

const lowBranch = (o: any, start: number) => { o.branch.start[1] = start; };
const PROFILES: Record<string, Profile> = {
  // --- broadleaf street & park trees
  locust: { kind: 'ez', preset: 'Ash Medium', leafTint: 0xc8d890, barkTint: 0x8a8078, bark: 'lib', leafType: 'ash', foliage: 'fine', tweak: (o) => { o.leaves.size *= 1.2; o.leaves.count = Math.round(o.leaves.count * 1.4); o.branch.angle[1] = 55; } },
  broadleaf: { kind: 'ez', preset: 'Oak Medium', leafTint: 0xa8c080, barkTint: 0x9a9088, bark: 'lib' },
  oak: { kind: 'ez', preset: 'Oak Medium', leafTint: 0x9cb878, barkTint: 0x8a8278, bark: 'lib', tweak: (o) => { o.branch.children[0] = 8; o.leaves.count = Math.round(o.leaves.count * 1.15); } },
  maple: { kind: 'ez', preset: 'Oak Medium', leafTint: 0xa8c47c, barkTint: 0x908a84, bark: 'lib', leafType: 'oak', tweak: (o) => { o.leaves.size *= 1.1; o.leaves.count = Math.round(o.leaves.count * 1.25); o.branch.angle[1] = 42; } },
  linden: { kind: 'ez', preset: 'Oak Medium', leafTint: 0xb0c882, barkTint: 0x8a847c, bark: 'lib', leafType: 'oak', tweak: (o) => { o.leaves.count = Math.round(o.leaves.count * 1.4); o.branch.angle[1] = 38; o.branch.start[1] = 0.3; } },
  pear: { kind: 'ez', preset: 'Oak Small', leafTint: 0x98b870, barkTint: 0x7a746c, bark: 'lib', leafType: 'oak', leafRough: 0.55, tweak: (o) => { o.branch.angle[1] = 28; o.leaves.count = Math.round(o.leaves.count * 1.4); }, fallback: 'linden' },
  ginkgo: { kind: 'ez', preset: 'Aspen Medium', leafTint: 0xc0d088, barkTint: 0x8a8278, bark: 'lib', leafType: 'ash', tweak: (o) => { o.branch.angle[1] = 40; o.leaves.count = Math.round(o.leaves.count * 1.3); }, fallback: 'linden' },
  plane: { kind: 'ez', preset: 'Oak Large', leafTint: 0xb4cc84, barkTint: 0xd8d0b0, bark: 'birch', barkRep: [1, 0.35], leafType: 'oak', tweak: (o) => { o.leaves.size *= 1.1; o.branch.angle[1] = 48; o.leaves.count = Math.round(o.leaves.count * 1.2); } },
  cottonwood: { kind: 'ez', preset: 'Oak Large', leafTint: 0xc0d48a, barkTint: 0xa8a098, bark: 'lib', leafType: 'oak', tweak: (o) => { o.branch.angle[1] = 42; } },
  ash: { kind: 'ez', preset: 'Ash Large', leafTint: 0xb0cc84, barkTint: 0x989088, bark: 'lib' },
  elm: { kind: 'ez', preset: 'Ash Large', leafTint: 0xa4c07c, barkTint: 0x8a8078, bark: 'lib', leafType: 'oak', tweak: (o) => { o.branch.angle[1] = 30; o.branch.start[1] = 0.28; o.leaves.size *= 0.75; o.leaves.count = Math.round(o.leaves.count * 1.5); } },
  aspen: { kind: 'ez', preset: 'Aspen Medium', leafTint: 0xd0e090, barkTint: 0xffffff, bark: 'birch' },
  ornamental: { kind: 'ez', preset: 'Oak Small', leafTint: 0xa0bc78, barkTint: 0x6a5a52, bark: 'lib', leafType: 'oak', tweak: (o) => { o.branch.angle[1] = 62; lowBranch(o, 0.25); }, fallback: 'broadleaf' },
  eucalyptus: { kind: 'ez', preset: 'Ash Large', leafTint: 0xa8b898, barkTint: 0xe8e0d0, bark: 'birch', leafType: 'ash', tweak: (o) => { o.leaves.count = Math.round(o.leaves.count * 0.8); o.branch.angle[1] = 32; }, fallback: 'broadleaf' },
  // --- southern
  liveoak: {
    kind: 'ez', preset: 'Oak Large', leafTint: 0x8aa468, barkTint: 0x6e665e, bark: 'lib', leafType: 'oak', foliage: 'small', trunkK: 0.035,
    tweak: (o) => { o.branch.start[1] = 0.16; o.branch.angle[1] = 84; o.branch.angle[2] = 55; o.branch.children[0] = 7; o.branch.length[1] *= 1.45; o.branch.force.strength = -0.035; o.branch.gnarliness[1] = 0.28; o.leaves.size *= 1.0; o.leaves.count = Math.round(o.leaves.count * 2.0); o.branch.radius[0] *= 1.35; },
  },
  liveoakmoss: {
    kind: 'ez', preset: 'Oak Large', leafTint: 0x8aa468, barkTint: 0x6e665e, bark: 'lib', leafType: 'oak', foliage: 'small', extra: 'moss', trunkK: 0.035, fallback: 'liveoak',
    tweak: (o) => { o.branch.start[1] = 0.16; o.branch.angle[1] = 84; o.branch.angle[2] = 55; o.branch.children[0] = 7; o.branch.length[1] *= 1.45; o.branch.force.strength = -0.035; o.branch.gnarliness[1] = 0.28; o.leaves.size *= 1.0; o.leaves.count = Math.round(o.leaves.count * 2.0); o.branch.radius[0] *= 1.35; },
  },
  magnolia: { kind: 'ez', preset: 'Oak Medium', leafTint: 0x7a9860, barkTint: 0x7a746e, bark: 'lib', leafType: 'aspen', foliage: 'small', leafRough: 0.6, tweak: (o) => { o.branch.angle[1] = 50; lowBranch(o, 0.12); o.leaves.size *= 1.25; o.leaves.count = Math.round(o.leaves.count * 1.5); o.branch.length[1] *= 0.8; }, fallback: 'broadleaf' },
  crape: { kind: 'ez', preset: 'Aspen Small', leafTint: 0x98b474, barkTint: 0xc8a898, bark: 'birch', barkRep: [1, 0.5], leafType: 'oak', foliage: 'small', extra: 'blossom', extraTint: 0xf07ab0, tweak: (o) => { o.branch.angle[1] = 35; lowBranch(o, 0.1); o.branch.children[0] = 6; o.leaves.size *= 0.7; o.leaves.count = Math.round(o.leaves.count * 1.4); }, fallback: 'ornamental' },
  gumbo: { kind: 'ez', preset: 'Ash Medium', leafTint: 0xa8c47c, barkTint: 0xd89878, bark: 'birch', leafType: 'oak', tweak: (o) => { o.branch.angle[1] = 60; o.leaves.count = Math.round(o.leaves.count * 0.9); }, fallback: 'broadleaf' },
  seagrape: { kind: 'ez', preset: 'Oak Small', leafTint: 0x7a9a60, barkTint: 0x7a6a5a, bark: 'lib', leafType: 'oak', leafRough: 0.5, tweak: (o) => { lowBranch(o, 0.05); o.branch.angle[1] = 70; o.leaves.size *= 1.6; o.leaves.count = Math.round(o.leaves.count * 1.5); }, fallback: 'broadleaf' },
  // --- desert
  paloverde: { kind: 'ez', preset: 'Ash Medium', leafTint: 0xd8dca0, barkTint: 0xb8d890, bark: 'birch', barkRep: [1, 0.6], leafType: 'ash', foliage: 'fine', trunkK: 0.02, tweak: (o) => { lowBranch(o, 0.08); o.branch.angle[1] = 62; o.branch.children[0] = 5; o.leaves.size *= 0.95; o.leaves.count = Math.round(o.leaves.count * 3); o.branch.gnarliness[1] = 0.3; } },
  mesquite: { kind: 'ez', preset: 'Oak Medium', leafTint: 0xa8b080, barkTint: 0x5a4e46, bark: 'lib', leafType: 'ash', foliage: 'fine', trunkK: 0.03, tweak: (o) => { lowBranch(o, 0.1); o.branch.angle[1] = 70; o.branch.gnarliness[0] = 0.2; o.branch.gnarliness[1] = 0.35; o.branch.force.strength = -0.04; o.leaves.size *= 0.95; o.leaves.count = Math.round(o.leaves.count * 3); } },
  desertwillow: { kind: 'ez', preset: 'Aspen Small', leafTint: 0xb0c080, barkTint: 0x8a7a6a, bark: 'lib', leafType: 'ash', foliage: 'fine', tweak: (o) => { lowBranch(o, 0.15); o.branch.angle[1] = 50; o.leaves.size *= 1.1; o.leaves.count = Math.round(o.leaves.count * 1.6); }, fallback: 'mesquite' },
  // --- conifers
  spruce: { kind: 'ez', preset: 'Pine Medium', leafTint: 0x94b0b8, barkTint: 0x8a7a6a, bark: 'pine', tweak: (o) => { o.leaves.count = Math.round(o.leaves.count * 1.8); o.leaves.size *= 1.35; o.branch.start[1] = 0.08; o.branch.children[0] = Math.round(o.branch.children[0] * 1.2); } },
  pine: { kind: 'ez', preset: 'Pine Large', leafTint: 0xbcd08c, barkTint: 0xd8a07a, bark: 'pine', tweak: (o) => { o.branch.start[1] = 0.45; o.branch.angle[1] = 100; } },
  fir: { kind: 'ez', preset: 'Pine Large', leafTint: 0x80a070, barkTint: 0x8a6a5a, bark: 'pine', tweak: (o) => { o.branch.start[1] = 0.18; o.branch.angle[1] = 106; o.branch.length[1] *= 0.8; o.leaves.count = Math.round(o.leaves.count * 1.9); o.leaves.size *= 1.4; o.branch.force.strength = -0.004; }, fallback: 'spruce' },
  cedar: { kind: 'ez', preset: 'Pine Medium', leafTint: 0x90b070, barkTint: 0x9a6a50, bark: 'willow', leafType: 'ash', tweak: (o) => { o.branch.start[1] = 0.1; o.branch.angle[1] = 112; o.leaves.size *= 1.6; o.leaves.count = Math.round(o.leaves.count * 1.6); o.branch.force.strength = -0.012; }, fallback: 'fir' },
  baldcypress: { kind: 'ez', preset: 'Pine Medium', leafTint: 0xb8cc90, barkTint: 0xa08070, bark: 'willow', leafType: 'ash', tweak: (o) => { o.branch.start[1] = 0.25; o.branch.angle[1] = 95; o.leaves.size *= 0.9; }, fallback: 'fir' },
  juniper: { kind: 'ez', preset: 'Pine Small', leafTint: 0x7a9068, barkTint: 0x7a6a5a, bark: 'pine', tweak: (o) => { o.leaves.count = Math.round(o.leaves.count * 1.8); o.leaves.size *= 1.5; o.branch.angle[1] = 95; }, fallback: 'spruce' },
  // --- shrubs (ez)
  shrub: { kind: 'ez', preset: 'Bush 1', leafTint: 0xa8c47c, barkTint: 0x806a5a, bark: 'lib' },
  // --- procedural
  'palm-fan': { kind: 'proc', proc: 'palm-fan', trunkR: 0.28 },
  'palm-sabal': { kind: 'proc', proc: 'palm-sabal', trunkR: 0.26 },
  'palm-canary': { kind: 'proc', proc: 'palm-canary', trunkR: 0.5 },
  'palm-date': { kind: 'proc', proc: 'palm-date', trunkR: 0.3, fallback: 'palm-canary' },
  'palm-royal': { kind: 'proc', proc: 'palm-royal', trunkR: 0.34 },
  'palm-queen': { kind: 'proc', proc: 'palm-queen', trunkR: 0.2, fallback: 'palm-royal' },
  'palm-coconut': { kind: 'proc', proc: 'palm-coconut', trunkR: 0.22 },
  saguaro: { kind: 'proc', proc: 'saguaro', trunkR: 0.3 },
  'barrel-cactus': { kind: 'proc', proc: 'barrel-cactus' },
  'prickly-pear': { kind: 'proc', proc: 'prickly-pear' },
  agave: { kind: 'proc', proc: 'agave' },
  yucca: { kind: 'proc', proc: 'yucca' },
  ocotillo: { kind: 'proc', proc: 'ocotillo' },
  grass: { kind: 'proc', proc: 'grass' },
  flowers: { kind: 'proc', proc: 'flowers' },
  'shrub-box': { kind: 'proc', proc: 'shrub-box' },
  'shrub-leafy': { kind: 'proc', proc: 'shrub-leafy' },
  'shrub-desert': { kind: 'proc', proc: 'shrub-desert' },
};

/** Species id (compiler / understory) → rendering profile key. */
export function profileFor(species: string): string {
  const s = species.toLowerCase();
  if (PROFILES[s]) return s;
  // palms first ('washingtonia' contains 'ash')
  if (s.includes('washingtonia') || s.includes('fan-palm')) return 'palm-fan';
  if (s.includes('sabal') || s.includes('cabbage') || s.includes('palmetto')) return 'palm-sabal';
  if (s.includes('canary')) return 'palm-canary';
  if (s.includes('date-palm') || s.includes('phoenix')) return 'palm-date';
  if (s.includes('royal')) return 'palm-royal';
  if (s.includes('queen') || s.includes('syagrus')) return 'palm-queen';
  if (s.includes('coconut') || s.includes('cocos')) return 'palm-coconut';
  if (s.includes('palm')) return 'palm-fan';
  if (s.includes('saguaro')) return 'saguaro';
  if (s.includes('barrel') || s.includes('cactus')) return 'barrel-cactus';
  if (s.includes('prickly') || s.includes('opuntia')) return 'prickly-pear';
  if (s.includes('agave')) return 'agave';
  if (s.includes('yucca')) return 'yucca';
  if (s.includes('ocotillo')) return 'ocotillo';
  if (s.includes('flower')) return 'flowers';
  if (s.includes('grass')) return 'grass';
  if (s.includes('box')) return s.includes('brisbane') ? 'magnolia' : 'shrub-box';
  if (s.includes('sea-grape')) return 'seagrape';
  if (s.includes('shrub') || s.includes('bush')) return s.includes('desert') ? 'shrub-desert' : 'shrub-leafy';
  if (s.includes('live-oak') || s.includes('banyan')) return s === 'live-oak' ? 'liveoakmoss' : 'liveoak';
  if (s.includes('crape')) return 'crape';
  if (s.includes('magnolia') || s.includes('olive')) return 'magnolia';
  if (s.includes('gumbo')) return 'gumbo';
  if (s.includes('palo')) return 'paloverde';
  if (s.includes('mesquite') || s.includes('ironwood')) return 'mesquite';
  if (s.includes('desert-willow')) return 'desertwillow';
  if (s.includes('eucalyptus')) return 'eucalyptus';
  if (s.includes('bald-cypress')) return 'baldcypress';
  if (s.includes('douglas') || s.includes('fir') || s.includes('hemlock')) return 'fir';
  if (s.includes('cedar') && !s.includes('elm')) return 'cedar';
  if (s.includes('spruce')) return 'spruce';
  if (s.includes('pine') || s.includes('conifer')) return 'pine';
  if (s.includes('juniper') || s.includes('cypress') || s.includes('arbor')) return 'juniper';
  if (s.includes('locust') || s.includes('mimosa') || s.includes('coffee')) return 'locust';
  if (s.includes('plane') || s.includes('sycamore')) return 'plane';
  if (s.includes('oak') || s.includes('pecan')) return 'oak';
  if (s.includes('tulip')) return 'maple';
  if (s.includes('cottonwood') || s.includes('poplar') || s.includes('willow')) return 'cottonwood';
  if (s.includes('aspen') || s.includes('birch')) return 'aspen';
  if (s.includes('elm')) return 'elm';
  if (s.includes('ash') || s.includes('hackberry')) return 'ash';
  if (s.includes('maple') || s.includes('tulip')) return 'maple';
  if (s.includes('linden') || s.includes('basswood')) return 'linden';
  if (s.includes('pear')) return 'pear';
  if (s.includes('ginkgo')) return 'ginkgo';
  if (s.includes('crab') || s.includes('cherry') || s.includes('redbud') || s.includes('plum')) return 'ornamental';
  return 'broadleaf';
}

interface Variant {
  key: string;
  bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry | null; extra: THREE.BufferGeometry | null;
  /** crown width / height ratio of the normalized model */
  ratio: number;
  /** uniform-scale model (palms, cacti, plants): instance scale = height */
  uniform: boolean;
  refH: number;
  barkMat: THREE.Material; leafMat: THREE.Material | null; extraMat: THREE.Material | null;
  near: THREE.InstancedMesh[]; mid: THREE.InstancedMesh[];
  bark1?: THREE.BufferGeometry; leaves1?: THREE.BufferGeometry | null;
  atlasIdx: number;
}

interface TreeInst { x: number; y: number; z: number; v: number; m: Float32Array; r: number; h: number; md2: number }

export const treeUniforms = { uTime: { value: 0 }, uWind: { value: 1 }, uTrans: { value: 1 } };

type PatchMode = 'bark' | 'leaf' | 'proc';
/** Wind sway, per-instance color jitter, two-sided foliage normals and sun back-lighting. */
function vegPatch(mat: THREE.Material, mode: PatchMode) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = treeUniforms.uTime;
    sh.uniforms.uWind = treeUniforms.uWind;
    sh.uniforms.uTrans = treeUniforms.uTrans;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uWind; varying float vGtJit; varying float vGtVar; varying float vGtLeaf;
        ${mode === 'proc' ? 'attribute float aFlex;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          #else
            vec2 ip = vec2(0.0);
          #endif
          float ph = dot(ip, vec2(0.13, 0.071));
          float hh = max(transformed.y, 0.0);
          float sway = hh * hh * uWind * (sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 1.9 + ph * 1.7) * 0.3 + sin(uTime * 0.37 + ph * 0.3) * 0.5);
          transformed.x += sway * 0.018;
          transformed.z += sway * 0.011;
          vGtJit = fract(sin(dot(ip, vec2(12.9898, 78.233))) * 43758.5453);
          vGtVar = fract(sin(dot(position.xyz, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          ${mode === 'leaf' ? `vGtLeaf = 1.0;
          transformed.xyz += 0.0035 * uWind * hh * vec3(sin(uTime * 5.3 + position.x * 40.0 + ph), sin(uTime * 4.1 + position.z * 33.0), cos(uTime * 6.1 + position.y * 37.0 + ph));` : ''}
          ${mode === 'bark' ? 'vGtLeaf = 0.0;' : ''}
          ${mode === 'proc' ? `vGtLeaf = step(0.01, aFlex);
          transformed.xyz += aFlex * uWind * 0.01 * vec3(sin(uTime * 2.3 + ph + position.x * 9.0), 0.6 * sin(uTime * 3.1 + position.z * 11.0 + ph), cos(uTime * 2.7 + ph + position.y * 7.0));` : ''}
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTrans; varying float vGtJit; varying float vGtVar; varying float vGtLeaf;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          vec3 jl = mix(vec3(0.80, 0.86, 0.80), vec3(1.10, 1.06, 0.92), vGtJit) * (0.9 + 0.2 * vGtVar);
          vec3 jb = vec3(0.85 + 0.3 * vGtJit);
          diffuseColor.rgb *= mix(jb, jl, vGtLeaf);
        }`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        #if defined( DOUBLE_SIDED ) && !defined( FLAT_SHADED )
          if (vGtLeaf > 0.5) normal *= faceDirection; // foliage: keep soft outward normals on both faces
        #endif`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
        #if NUM_SUN_LIGHTS > 0
        if (vGtLeaf > 0.5) {
          // thin foliage transmits sunlight: bright when looking toward the sun through leaves
          float gtBack = pow(saturate(dot(-geometryViewDir, directLight.direction)), 4.0);
          float gtWrap = saturate(0.5 - 0.5 * dot(geometryNormal, directLight.direction));
          reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * uTrans * (0.45 * gtBack + 0.1 * gtWrap) * vec3(0.85, 1.0, 0.62);
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => 'gt-veg-' + mode;
}

let procMat: THREE.MeshStandardMaterial | null = null;
function proceduralMaterial() {
  if (procMat) return procMat;
  procMat = new THREE.MeshStandardMaterial({ map: plantAtlas(), vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78 });
  (procMat as any).shadowSide = THREE.DoubleSide;
  procMat.name = 'veg-proc';
  vegPatch(procMat, 'proc');
  return procMat;
}

const barkCache = new Map<string, THREE.MeshStandardMaterial>();
function barkMaterial(P: EzProfile, src: THREE.MeshPhongMaterial): THREE.MeshStandardMaterial {
  const key = `${P.bark}|${P.barkTint}|${P.barkRep}`;
  const hit = barkCache.get(key);
  if (hit) return hit;
  let map: THREE.Texture | null = src.map, nmap: THREE.Texture | null = (src as any).normalMap ?? null;
  const rep = P.barkRep ?? [2, 0.5];
  if (P.bark === 'lib') {
    const set = textureSet('bark');
    if (set?.maps.map) {
      map = set.maps.map.clone(); map.repeat.set(rep[0], rep[1]); map.needsUpdate = true;
      if (set.maps.normalMap) { nmap = set.maps.normalMap.clone(); nmap.repeat.set(rep[0], rep[1]); nmap.needsUpdate = true; }
    }
  } else if (map) {
    map = map.clone(); map.repeat.set(rep[0], rep[1]); map.needsUpdate = true;
    if (nmap) { nmap = nmap.clone(); nmap.repeat.set(rep[0], rep[1]); nmap.needsUpdate = true; }
  }
  const m = new THREE.MeshStandardMaterial({ map, normalMap: nmap, color: new THREE.Color(P.barkTint), roughness: 0.95 });
  m.name = 'veg-bark';
  vegPatch(m, 'bark');
  barkCache.set(key, m);
  return m;
}

function normalizeGeos(geos: THREE.BufferGeometry[], xzFrom?: THREE.BufferGeometry) {
  const bb = new THREE.Box3();
  for (const g of geos) bb.union(new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute));
  const H = bb.max.y - Math.min(0, bb.min.y);
  const s = 1 / H;
  for (const g of geos) { g.translate(0, -Math.min(0, bb.min.y), 0); g.scale(s, s, s); }
  const lb = new THREE.Box3().setFromBufferAttribute((xzFrom ?? geos[0]).getAttribute('position') as THREE.BufferAttribute);
  return { H, ratio: Math.max(lb.max.x - lb.min.x, lb.max.z - lb.min.z, 0.2) };
}

function makeEzGeos(P: EzProfile, seed: number, lod: number) {
  const t = new Tree();
  t.loadPreset(P.preset);
  const o: any = t.options;
  o.seed = seed;
  o.leaves.tint = 0xffffff;
  o.bark.tint = 0xffffff;
  if (P.leafType) o.leaves.type = P.leafType;
  if (P.bark && P.bark !== 'lib') o.bark.type = P.bark;
  o.branch.sections = { 0: Math.min(o.branch.sections[0], 10), 1: Math.min(o.branch.sections[1], 7), 2: Math.min(o.branch.sections[2], 5), 3: Math.min(o.branch.sections[3], 3) };
  o.branch.segments = { 0: Math.min(o.branch.segments[0], 8), 1: Math.min(o.branch.segments[1], 5), 2: Math.min(o.branch.segments[2], 3), 3: 3 };
  P.tweak?.(o);
  if (lod > 0) {
    o.leaves.count = Math.max(1, Math.round(o.leaves.count * 0.42));
    o.leaves.size *= 1.5;
    o.branch.sections = { 0: Math.max(3, Math.round(o.branch.sections[0] / 2)), 1: Math.max(2, Math.round(o.branch.sections[1] / 2)), 2: 2, 3: 2 };
    o.branch.segments = { 0: 5, 1: 3, 2: 3, 3: 3 };
  }
  t.generate();
  const bark = t.branchesMesh.geometry.clone();
  const leaves = t.leavesMesh.geometry.clone();
  const srcBark = t.branchesMesh.material as THREE.MeshPhongMaterial;
  const srcLeaf = t.leavesMesh.material as THREE.MeshPhongMaterial;
  return { bark, leaves, srcBark, srcLeaf };
}

function softLeafNormals(leaves: THREE.BufferGeometry) {
  const lb = new THREE.Box3().setFromBufferAttribute(leaves.getAttribute('position') as THREE.BufferAttribute);
  const lc = lb.getCenter(new THREE.Vector3());
  const lp = leaves.getAttribute('position') as THREE.BufferAttribute;
  const ln = new Float32Array(lp.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < lp.count; i++) {
    v.fromBufferAttribute(lp, i).sub(lc); v.y *= 0.6; v.y += 0.25 * (lb.max.y - lb.min.y); v.normalize();
    ln[i * 3] = v.x; ln[i * 3 + 1] = v.y; ln[i * 3 + 2] = v.z;
  }
  leaves.setAttribute('normal', new THREE.BufferAttribute(ln, 3));
}

const leafMatCache = new Map<string, THREE.MeshStandardMaterial>();
function makeEzVariant(key: string, P: EzProfile, seed: number): Omit<Variant, 'atlasIdx' | 'near' | 'mid'> {
  const g0 = makeEzGeos(P, seed, 0);
  const { ratio } = normalizeGeos([g0.bark, g0.leaves], g0.leaves);
  softLeafNormals(g0.leaves);
  g0.bark.computeBoundingSphere(); g0.leaves.computeBoundingSphere();
  let bark1: THREE.BufferGeometry | undefined, leaves1: THREE.BufferGeometry | undefined;
  try {
    const g1 = makeEzGeos(P, seed, 1);
    normalizeGeos([g1.bark, g1.leaves], g1.leaves);
    softLeafNormals(g1.leaves);
    bark1 = g1.bark; leaves1 = g1.leaves;
  } catch { /* no lod1 */ }
  const barkMat = barkMaterial(P, g0.srcBark);
  const lk = `${P.foliage ?? P.leafType ?? P.preset}|${P.leafTint}|${P.leafRough ?? 0.8}`;
  let leafMat = leafMatCache.get(lk);
  if (!leafMat) {
    leafMat = new THREE.MeshStandardMaterial({ map: P.foliage ? foliageTexture(P.foliage) : g0.srcLeaf.map, color: new THREE.Color(P.leafTint).multiplyScalar(0.8), alphaTest: 0.5, side: THREE.DoubleSide, roughness: P.leafRough ?? 0.8 });
    (leafMat as any).shadowSide = THREE.DoubleSide;
    leafMat.name = 'veg-leaf';
    vegPatch(leafMat, 'leaf');
    leafMatCache.set(lk, leafMat);
  }
  let extra: THREE.BufferGeometry | null = null;
  if (P.extra === 'moss') extra = mossFor(g0.bark, seed, 90, 0.1);
  else if (P.extra === 'blossom') extra = blossomsFor(g0.leaves, seed, 70, 0.14, new THREE.Color([0xf07ab0, 0xd04890, 0xfff0f6, 0xc8a0e8][seed % 4]));
  return { key, bark: g0.bark, leaves: g0.leaves, extra, ratio, uniform: false, refH: 0, barkMat, leafMat, extraMat: extra ? proceduralMaterial() : null, bark1, leaves1 };
}

function makeProcVariant(key: string, P: ProcProfile, seed: number, refH: number): Omit<Variant, 'atlasIdx' | 'near' | 'mid'> {
  const g = buildProc(P.proc, refH, seed, 0);
  const { ratio } = normalizeGeos([g]);
  let bark1: THREE.BufferGeometry | undefined;
  try { bark1 = buildProc(P.proc, refH, seed, 1); normalizeGeos([bark1]); } catch { /* none */ }
  return { key, bark: g, leaves: null, extra: null, ratio, uniform: true, refH, barkMat: proceduralMaterial(), leafMat: null, extraMat: null, bark1, leaves1: null };
}

/**
 * Cross-billboard impostor atlas: one tile per planned variant, baked incrementally (tiles for variants that
 * stream in after the game starts are added later). Bake materials are cached per source material and
 * compiled up front (in parallel where KHR_parallel_shader_compile exists) — re-creating them per variant
 * used to recompile the same programs dozens of times (the old multi-second loading freeze).
 */
class ImpostorAtlas {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cols: number;
  private scene = new THREE.Scene();
  private mats = new Map<string, THREE.Material>();
  private cleared = false;
  constructor(n: number, private tile = 256) {
    this.cols = Math.ceil(Math.sqrt(Math.max(1, n)));
    const size = this.cols * tile;
    this.rt = new THREE.WebGLRenderTarget(size, size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, samples: 4 });
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(0.3, 1, 0.8); this.scene.add(dl);
  }
  /** Bake material for a source material. Every bake material is one of just two programs (Lambert + map +
   *  alpha test, ± vertex colours): the tiles are tiny and ~diffuse, and on software GL each extra program
   *  costs seconds of compile (per-variant PBR clones were the old multi-second loading freeze). */
  private plain(m: THREE.Material | null, k: string) {
    if (!m) return null;
    const key = `${m.uuid}|${k}`;
    let c = this.mats.get(key);
    if (!c) {
      const s = m as THREE.MeshStandardMaterial;
      c = new THREE.MeshLambertMaterial({ map: s.map ?? null, color: s.color ?? 0xffffff, vertexColors: s.vertexColors, alphaTest: 0.4, side: THREE.DoubleSide });
      c.name = 'veg-bake-' + k;
      this.mats.set(key, c);
    }
    return c;
  }
  private legacyGroup(V: Variant) {
    const plain = (m: THREE.Material | null, alphaTest: number, k: string) => { if (!m) return null; const c = m.clone(); c.onBeforeCompile = () => {}; c.customProgramCacheKey = () => 'bake-' + k; c.alphaTest = alphaTest; return c; };
    const grp = new THREE.Group();
    const mats = [plain(V.barkMat, V.uniform ? 0.4 : 0, 'b'), plain(V.leafMat, 0.4, 'l'), plain(V.extraMat, 0.4, 'x')];
    grp.add(new THREE.Mesh(V.bark, mats[0]!));
    if (V.leaves && mats[1]) grp.add(new THREE.Mesh(V.leaves, mats[1]));
    if (V.extra && mats[2]) grp.add(new THREE.Mesh(V.extra, mats[2]));
    return grp;
  }
  private groupFor(V: Variant) {
    const grp = new THREE.Group();
    const mats = [this.plain(V.barkMat, 'b'), this.plain(V.leafMat, 'l'), this.plain(V.extraMat, 'x')];
    grp.add(new THREE.Mesh(V.bark, mats[0]!));
    if (V.leaves && mats[1]) grp.add(new THREE.Mesh(V.leaves, mats[1]));
    if (V.extra && mats[2]) grp.add(new THREE.Mesh(V.extra, mats[2]));
    return grp;
  }
  private compile(renderer: THREE.WebGLRenderer, objs: THREE.Object3D[]): Promise<unknown> {
    for (const o of objs) this.scene.add(o);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, 0, -10, 10);
    // compile against the atlas target (program variants depend on the target's colour space / tone mapping)
    const prev = renderer.getRenderTarget();
    let ready: Promise<unknown> = Promise.resolve();
    renderer.setRenderTarget(this.rt);
    try { ready = renderer.compileAsync(this.scene, cam); } catch { /* compiled lazily on first bake */ }
    renderer.setRenderTarget(prev);
    for (const o of objs) this.scene.remove(o);
    return ready.catch(() => {});
  }
  /** Start compiling the two bake programs right away (GPU process works while the CPU generates trees). */
  warm(renderer: THREE.WebGLRenderer) {
    const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(0.1, 0.1);
    geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(geo.getAttribute('position').count * 3).fill(1), 3));
    const mk = (vc: boolean) => new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex, vertexColors: vc, alphaTest: 0.4, side: THREE.DoubleSide }));
    const objs = [mk(false), mk(true)];
    return this.compile(renderer, objs).then(() => { for (const o of objs) (o.material as THREE.Material).dispose(); geo.dispose(); tex.dispose(); });
  }
  /** Compile the bake programs the given variants need without blocking (parallel compile when available). */
  precompile(renderer: THREE.WebGLRenderer, variants: Variant[]) {
    return this.compile(renderer, variants.map((V) => this.groupFor(V))).then(() => {});
  }
  bake(renderer: THREE.WebGLRenderer, V: Variant, idx: number) {
    V.atlasIdx = idx;
    const { tile, cols, rt } = this;
    const prevRT = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const prevScissor = renderer.getScissorTest();
    if (!this.cleared) {
      this.cleared = true;
      rt.scissorTest = false;
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
    }
    const cx = idx % cols, cy = Math.floor(idx / cols);
    const w = V.ratio;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, 1, 0, -10, 10);
    cam.position.set(0, 0, 2); cam.lookAt(0, 0, 0);
    const legacy = (typeof location !== 'undefined' && location.search.includes('legacyload'));
    const grp = legacy ? this.legacyGroup(V) : this.groupFor(V);
    this.scene.add(grp);
    rt.viewport.set(cx * tile, cy * tile, tile, tile);
    rt.scissor.set(cx * tile, cy * tile, tile, tile);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.render(this.scene, cam);
    this.scene.remove(grp);
    if (legacy) grp.traverse((o) => ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose?.());
    renderer.setScissorTest(prevScissor);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevClear, prevAlpha);
  }
  /** Bake materials are only needed while tiles are still being added. */
  releaseMaterials() { for (const m of this.mats.values()) m.dispose(); this.mats.clear(); }
}

/** Max visible distance (m) for small plants; beyond it they are culled (no impostor). */
function maxDistFor(h: number) { return h < 1.2 ? 70 : h < 3 ? 110 : Infinity; }

type VariantBase = Omit<Variant, 'atlasIdx' | 'near' | 'mid'>;
/** Generated variant geometry per (profile, seed, refH) — reused if another city (or a reload of this one
 *  in the same session) needs the same species. Materials are cached separately. */
const variantCache = new Map<string, VariantBase>();
interface PlanItem { k: string; seed: number; refH: number; trees: number[]; minD: number }

export class TreeSystem {
  group = new THREE.Group();
  private variants: (Variant | undefined)[] = [];
  private byProfile = new Map<string, number[]>();
  private insts: TreeInst[] = [];
  private far!: THREE.InstancedMesh;
  private farAtlas!: THREE.InstancedBufferAttribute;
  /** Shadow-only impostors for mid-distance trees (perf: their leaves don't cast). Registered as a shadow proxy by world. */
  shadowImpostors: THREE.InstancedMesh | null = null;
  private shadowAtlas!: THREE.InstancedBufferAttribute;
  private nearCount: number[] = [];
  private midCount: number[] = [];
  fullDist = 48;
  private frame = 0;
  nearDist = 150;
  /** Sun direction (world, toward the sun) — optional, dims back-lighting at night. */
  sunDir: THREE.Vector3 | null = null;
  /** Spanish moss on live oaks (humid Gulf / Southeast coast; off for Texas Hill Country, Florida, …). */
  spanishMoss = true;
  /** Trunk cylinders for physics: x,z,y,radius,height */
  trunks: { x: number; z: number; y: number; r: number; h: number }[] = [];
  /** Where the player starts: variants with plants within `eagerDist` of it are built during loading;
   *  the rest stream in after the game starts (a few ms per frame). */
  focus: [number, number] | null = null;
  eagerDist = 190;
  /** Called for every instanced mesh created (also for meshes of variants that stream in later). */
  onMesh: ((m: THREE.InstancedMesh, ring: 'near' | 'mid') => void) | null = null;

  private plan: PlanItem[] = [];
  private trees: RecipeTree[] = [];
  private treeProf: string[] = [];
  private treeRot: number[] = [];
  private pending: number[] = [];
  private atlas: ImpostorAtlas | null = null;
  private renderer: THREE.WebGLRenderer | undefined;

  constructor() { this.group.name = 'trees'; }

  async build(trees: RecipeTree[], renderer: THREE.WebGLRenderer | undefined, onProgress?: (f: number) => void) {
    this.trees = trees;
    this.renderer = renderer;
    // profiles used (rare profiles fold into their fallback to keep draw calls bounded)
    const used = new Map<string, number>();
    const prof = trees.map((t) => { const p = profileFor(t.species); return p === 'liveoakmoss' && !this.spanishMoss ? 'liveoak' : p; });
    for (const p of prof) used.set(p, (used.get(p) ?? 0) + 1);
    const remap = new Map<string, string>();
    for (let pass = 0; pass < 3; pass++) {
      if (used.size <= 12) break;
      const rare = [...used.entries()].filter(([k, n]) => n < 30 && PROFILES[k]?.fallback).sort((a, b) => a[1] - b[1]);
      for (const [k, n] of rare) {
        if (used.size <= 12) break;
        const fb = PROFILES[k].fallback!;
        used.delete(k); used.set(fb, (used.get(fb) ?? 0) + n); remap.set(k, fb);
      }
    }
    const resolve = (p: string) => { let q = p; for (let i = 0; i < 4 && remap.has(q); i++) q = remap.get(q)!; return q; };
    if (!used.size) return;
    // variant plan (only for profiles present in this city)
    for (const k of used.keys()) {
      const P = PROFILES[k] ?? PROFILES.broadleaf;
      const n = used.get(k) ?? 0;
      const add = (seed: number, refH: number) => {
        const ids = this.byProfile.get(k) ?? [];
        ids.push(this.plan.length);
        this.byProfile.set(k, ids);
        this.plan.push({ k, seed, refH, trees: [], minD: Infinity });
      };
      if (P.kind === 'proc') {
        const hs = PROC_REF_H[P.proc];
        const list = n < 40 ? [hs[hs.length - 1]] : hs;
        list.forEach((h, i) => add((hashString(k) + i * 7919) % 100000, h));
      } else {
        const nv = n > 150 ? 2 : 1;
        for (let i = 0; i < nv; i++) add((hashString(k) + i * 7919) % 100000, 0);
      }
    }
    // assign every plant to a planned variant (deterministic; independent of build order) + physics trunks
    const fx = this.focus?.[0] ?? 0, fz = this.focus?.[1] ?? 0;
    trees.forEach((t, ti) => {
      const pk = resolve(prof[ti]);
      this.treeProf[ti] = pk;
      this.treeRot[ti] = 0;
      const ids = this.byProfile.get(pk) ?? this.byProfile.get('broadleaf') ?? this.byProfile.values().next().value;
      if (!ids) return;
      const R = rng(t.seed || hashString(`${t.p[0]},${t.p[1]}`));
      const h = Math.max(0.3, t.height || 8);
      let v = ids[Math.floor(R() * ids.length)];
      if (PROFILES[this.plan[v].k]?.kind === 'proc' && ids.length > 1) {
        let best = Infinity;
        for (const id of ids) { const d = Math.abs(this.plan[id].refH - h) * (0.85 + R() * 0.3); if (d < best) { best = d; v = id; } }
      }
      this.treeRot[ti] = R() * Math.PI * 2;
      const it = this.plan[v];
      it.trees.push(ti);
      it.minD = Math.min(it.minD, Math.hypot(t.p[0] - fx, t.p[1] - fz));
      if (h > 2.5) {
        const P = PROFILES[pk];
        const r = P?.kind === 'proc' ? (P.trunkR ?? 0.25) : Math.max(0.12, Math.min(0.45, h * ((P as EzProfile)?.trunkK ?? 0.018)));
        this.trunks.push({ x: t.p[0], z: t.p[1], y: t.y, r, h: Math.min(h * 0.4, 4) });
      }
    });
    this.variants = new Array(this.plan.length).fill(undefined);
    this.nearCount = new Array(this.plan.length).fill(0);
    this.midCount = new Array(this.plan.length).fill(0);
    this.buildImpostors(renderer);
    const warm = renderer && this.atlas ? this.atlas.warm(renderer) : null;
    // near-spawn variants now (behind the loading screen), the rest after the game starts
    const order = this.plan.map((_, i) => i).filter((i) => this.plan[i].trees.length).sort((a, b) => this.plan[a].minD - this.plan[b].minD);
    if ((typeof location !== 'undefined' && location.search.includes('legacyload'))) this.focus = null;
    const eager = this.focus ? order.filter((i) => this.plan[i].minD < this.eagerDist) : order;
    this.pending = order.filter((i) => !eager.includes(i));
    let done = 0, t0 = performance.now();
    const step = async (f: number) => {
      onProgress?.(f);
      if (performance.now() - t0 > 24) { await yieldFrame(); t0 = performance.now(); }
    };
    const built: number[] = [];
    for (const i of eager) {
      if (this.generate(i)) built.push(i);
      await step(++done / eager.length);
    }
    for (const i of built) this.activate(i);
    // impostor tiles: kick off the (parallel) bake-shader compile now; the tiles are rendered in
    // finishLoad(), after the rest of the world has been built, so the compile overlaps that work
    if (renderer && this.atlas) {
      const atlas = this.atlas;
      const t = performance.now();
      this.atlasPending = Promise.all([warm, atlas.precompile(renderer, built.map((i) => this.variants[i]!))]).then(() => {
        console.info(`[veg] impostor programs ready after ${(performance.now() - t).toFixed(0)} ms`);
      });
      this.unbaked = built;
    }
    (globalThis as any).__gtVegList = trees; // debug: inspected by dev tools
    console.info(`[veg] ${built.length}/${this.plan.length} variants at load (${[...this.byProfile.keys()].join(', ')}), ${this.insts.length}/${trees.length} plants; ${this.pending.length} variants stream in later`);
  }

  private atlasPending: Promise<void> | null = null;
  private unbaked: number[] = [];
  /** Render the impostor tiles of the variants built at load (call before the game starts). */
  async finishLoad() {
    const r = this.renderer, atlas = this.atlas;
    if (!r || !atlas) return;
    await this.atlasPending;
    this.atlasPending = null;
    let t0 = performance.now();
    for (const i of this.unbaked) {
      const V = this.variants[i];
      if (V) atlas.bake(r, V, i);
      if (performance.now() - t0 > 24) { await yieldFrame(); t0 = performance.now(); }
    }
    this.unbaked = [];
    if (!this.pending.length) atlas.releaseMaterials();
  }

  /** Generate (or fetch from cache) the geometry of planned variant i. */
  private generate(i: number): boolean {
    const it = this.plan[i];
    const P = PROFILES[it.k] ?? PROFILES.broadleaf;
    const ck = `${it.k}|${it.seed}|${it.refH}`;
    try {
      let base = variantCache.get(ck);
      if (!base) {
        base = P.kind === 'proc' ? makeProcVariant(it.k, P, it.seed, it.refH) : makeEzVariant(it.k, P, it.seed);
        variantCache.set(ck, base);
      }
      this.variants[i] = { ...base, atlasIdx: i, near: [], mid: [] };
      return true;
    } catch (e) { console.warn('[world] tree variant failed', it.k, e); return false; }
  }

  /** Instances + near/mid meshes for a generated variant. */
  private activate(i: number) {
    const V = this.variants[i];
    if (!V) return;
    const it = this.plan[i];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (const ti of it.trees) {
      const t = this.trees[ti];
      const h = Math.max(0.3, t.height || 8);
      let sxz: number;
      if (V.uniform) sxz = h;
      else { sxz = (t.crown || h * 0.6) / V.ratio; sxz = Math.max(h * 0.65, Math.min(h * 1.5, sxz)); }
      q.setFromAxisAngle(up, this.treeRot[ti]);
      sc.set(sxz, h, sxz);
      pos.set(t.p[0], t.y - 0.05, t.p[1]);
      m4.compose(pos, q, sc);
      const md = maxDistFor(h);
      this.insts.push({ x: t.p[0], y: t.y, z: t.p[1], v: i, m: new Float32Array(m4.elements), r: Math.max(sxz * V.ratio * 0.5, h * 0.5), h, md2: md * md });
    }
    const cap = Math.max(1, Math.min(it.trees.length, 1500));
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, ring: 'near' | 'mid', part: string) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.castShadow = ring === 'near'; m.receiveShadow = true; m.frustumCulled = false; m.count = 0; m.visible = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.name = `tree_${V.key}_${part}_${ring}`;
      this.group.add(m);
      (ring === 'near' ? V.near : V.mid).push(m);
      this.onMesh?.(m, ring);
    };
    mk(V.bark, V.barkMat, 'near', 'b');
    if (V.leaves && V.leafMat) mk(V.leaves, V.leafMat, 'near', 'l');
    if (V.extra && V.extraMat) mk(V.extra, V.extraMat, 'near', 'x');
    mk(V.bark1 ?? V.bark, V.barkMat, 'mid', 'b');
    if (V.leaves && V.leafMat) mk(V.leaves1 ?? V.leaves, V.leafMat, 'mid', 'l');
    if (V.extra && V.extraMat) mk(V.extra, V.extraMat, 'mid', 'x');
  }

  /** Stream one pending variant per call: generate → (next call) bake + activate. Keeps each frame's cost to one step. */
  private streamStep = 0;
  private streamWait: Promise<void> | null = null;
  private stream() {
    if (!this.pending.length || this.atlasPending || this.unbaked.length || this.streamWait) return;
    if (++this.streamStep % 3) return; // spread the work: at most one step every third frame
    const i = this.pending[0];
    if (!this.variants[i]) {
      if (!this.generate(i)) { this.pending.shift(); return; }
      // compile its bake program off-thread before baking (no in-game compile hitch)
      if (this.renderer && this.atlas) {
        this.streamWait = this.atlas.precompile(this.renderer, [this.variants[i]!]).catch(() => {}).then(() => { this.streamWait = null; });
      }
      return;
    }
    this.pending.shift();
    if (this.renderer && this.atlas) this.atlas.bake(this.renderer, this.variants[i]!, i);
    this.activate(i);
    if (!this.pending.length) { this.atlas?.releaseMaterials(); console.info('[veg] all variants streamed in'); }
  }

  private buildImpostors(renderer: THREE.WebGLRenderer | undefined) {
    let atlas: THREE.Texture | null = null, cols = 1;
    if (renderer) { this.atlas = new ImpostorAtlas(this.plan.length); atlas = this.atlas.rt.texture; cols = this.atlas.cols; }
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const q2 = quad.clone(); q2.rotateY(Math.PI / 2);
    const geo = new THREE.BufferGeometry();
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    [quad, q2].forEach((g) => {
      const p = g.getAttribute('position'), uv = g.getAttribute('uv');
      const base = P.length / 3;
      for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); N.push(0, 1, 0); U.push(uv.getX(i), uv.getY(i)); }
      const idx = g.getIndex()!;
      for (let i = 0; i < idx.count; i++) I.push(idx.getX(i) + base);
    });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setIndex(I);
    const total2 = this.trees.length;
    this.farAtlas = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total2) * 3), 3);
    this.farAtlas.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAtlas', this.farAtlas);
    const fm = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: atlas ? 0xffffff : 0x4a6a3a });
    fm.onBeforeCompile = (sh) => {
      sh.uniforms.uCols = { value: cols };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aAtlas; uniform float uCols; varying vec2 vAtl; varying float vGtJit;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.x *= aAtlas.z; transformed.z *= aAtlas.z;
          vAtl = (vec2(aAtlas.x, aAtlas.y) + uv) / uCols;
          #ifdef USE_INSTANCING
            vGtJit = fract(sin(dot(vec2(instanceMatrix[3][0], instanceMatrix[3][2]), vec2(12.9898, 78.233))) * 43758.5453);
          #else
            vGtJit = 0.5;
          #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vAtl; varying float vGtJit;')
        .replace('#include <map_fragment>', `
          #ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D(map, vAtl);
            diffuseColor *= sampledDiffuseColor;
            diffuseColor.rgb *= mix(vec3(0.82, 0.87, 0.82), vec3(1.08, 1.05, 0.93), vGtJit);
          #endif`);
    };
    fm.customProgramCacheKey = () => 'gt-impostor';
    this.far = new THREE.InstancedMesh(geo, fm, Math.max(1, total2));
    this.far.castShadow = true; this.far.receiveShadow = false; this.far.frustumCulled = false; this.far.count = 0;
    this.far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.far.name = 'tree_impostors';
    this.group.add(this.far);
    // depth material that applies the same atlas cell + width scaling, so impostor shadows are tree-shaped
    const dm = new THREE.MeshDepthMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide });
    dm.onBeforeCompile = (sh) => {
      sh.uniforms.uCols = { value: cols };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aAtlas; uniform float uCols; varying vec2 vAtl;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.x *= aAtlas.z; transformed.z *= aAtlas.z;
          vAtl = (vec2(aAtlas.x, aAtlas.y) + uv) / uCols;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vAtl;')
        .replace('#include <map_fragment>', `
          #ifdef USE_MAP
            diffuseColor *= texture2D(map, vAtl);
          #endif`);
    };
    dm.customProgramCacheKey = () => 'gt-impostor-depth';
    this.far.customDepthMaterial = dm;
    // shadow-only impostors for the mid ring (leaves there stop casting; see update)
    const sgeo = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv']) sgeo.setAttribute(k, geo.getAttribute(k));
    sgeo.setIndex(geo.getIndex());
    this.shadowAtlas = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total2) * 3), 3);
    this.shadowAtlas.setUsage(THREE.DynamicDrawUsage);
    sgeo.setAttribute('aAtlas', this.shadowAtlas);
    const si = new THREE.InstancedMesh(sgeo, fm, Math.max(1, total2));
    si.customDepthMaterial = dm;
    si.castShadow = true; si.receiveShadow = false; si.frustumCulled = false; si.count = 0; si.visible = false;
    si.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    si.name = 'tree_shadow_impostors';
    this.group.add(si);
    this.shadowImpostors = si;
    this.cols = cols;
  }
  private cols = 1;

  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sph = new THREE.Sphere();

  update(dt: number, camera: THREE.Camera, t: number) {
    treeUniforms.uTime.value = t;
    if (this.sunDir) treeUniforms.uTrans.value = THREE.MathUtils.smoothstep(this.sunDir.y, -0.02, 0.12);
    if (!this.far) return;
    this.stream();
    this.frame++;
    if (this.frame % 2 === 1) return;
    camera.updateMatrixWorld();
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const cx = camera.position.x, cz = camera.position.z;
    const nd2 = this.nearDist * this.nearDist, fd2 = this.fullDist * this.fullDist;
    for (let i = 0; i < this.nearCount.length; i++) { this.nearCount[i] = 0; this.midCount[i] = 0; }
    let fc = 0, sc = 0;
    const farArr = this.far.instanceMatrix.array as Float32Array;
    const atl = this.farAtlas.array as Float32Array;
    const si = this.shadowImpostors;
    const sArr = si ? (si.instanceMatrix.array as Float32Array) : null;
    const sAtl = si ? (this.shadowAtlas.array as Float32Array) : null;
    for (const T of this.insts) {
      const d2 = (T.x - cx) ** 2 + (T.z - cz) ** 2;
      if (d2 > T.md2) continue;
      this.sph.center.set(T.x, T.y + T.h * 0.5, T.z); this.sph.radius = T.h * 0.7 + T.r;
      if (!this.frustum.intersectsSphere(this.sph)) continue;
      const V = this.variants[T.v]!;
      if (d2 < fd2) {
        const n = this.nearCount[T.v];
        if (n < V.near[0].instanceMatrix.count) {
          for (const m of V.near) (m.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          this.nearCount[T.v] = n + 1;
          continue;
        }
      } else if (d2 < nd2) {
        const n = this.midCount[T.v];
        if (n < V.mid[0].instanceMatrix.count) {
          for (const m of V.mid) (m.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          this.midCount[T.v] = n + 1;
          if (sArr && sAtl && T.h > 3) {
            sArr.set(T.m, sc * 16);
            sAtl[sc * 3] = V.atlasIdx % this.cols; sAtl[sc * 3 + 1] = Math.floor(V.atlasIdx / this.cols); sAtl[sc * 3 + 2] = V.ratio;
            sc++;
          }
          continue;
        }
      }
      farArr.set(T.m, fc * 16);
      atl[fc * 3] = V.atlasIdx % this.cols; atl[fc * 3 + 1] = Math.floor(V.atlasIdx / this.cols); atl[fc * 3 + 2] = V.ratio;
      fc++;
    }
    this.variants.forEach((V, i) => {
      if (!V) return;
      for (const m of V.near) { m.count = this.nearCount[i]; m.visible = m.count > 0; m.instanceMatrix.needsUpdate = m.visible; }
      for (const m of V.mid) { m.count = this.midCount[i]; m.visible = m.count > 0; m.instanceMatrix.needsUpdate = m.visible; }
    });
    this.far.count = fc;
    if (si) { si.count = sc; si.instanceMatrix.needsUpdate = true; this.shadowAtlas.needsUpdate = true; }
    this.far.instanceMatrix.needsUpdate = true;
    this.farAtlas.needsUpdate = true;
  }
}
