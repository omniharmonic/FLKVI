// OWNER: characters agent. Turns the Quaternius Universal Base Characters (CC0, underwear-only "superhero" bodies)
// into believable everyday people without new model files:
//  • Proportions: the bind-pose body is re-sculpted per build (slim / average / heavy): limb girth, glutes,
//    chest/waist, belly, hands. Heights 1.55–1.95 m come from a uniform scale per person.
//  • Clothes with volume: garment "shells" (smoothed + pushed-out copies of the body surface, skinned to the same
//    bones) for tops, bottoms and shoes, plus an A-line tube for skirts, dresses and coat tails. Everything (body,
//    shells, eyes, brows) is merged into ONE skinned mesh + ONE material per person; a garment's coverage (sleeve
//    length, hem, trouser length, boot height…) is decided per fragment from uniforms, so one geometry per
//    sex × build serves every outfit.  Draw calls per person: body 1 + hair 1 + hat/glasses 1 (≤ 3).
//  • Fabric: per-fabric roughness, procedural mottling, fold/wrinkle bump (elbows, knees, ankle stacks, torso drape),
//    puffer channels, denim fading, ribbed hoodie hems, hi-vis stripes, a generic reflective "POLICE" back patch.
//  • Heads: skin tones re-tinted from the painted texture (keeps lips/eyes/stubble detail), procedural eyes with
//    iris colors, brows, hair meshes (short/long, recolored) or buzz cuts, caps, beanies, sunglasses, hard hats.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { rng } from '../core/geo';

// ---------------------------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------------------------

/** Legacy manifest outfit (see manifest.ts MODELS). Mapped onto a full Look by dressCharacter. */
export interface Outfit {
  top: string;
  bottom: string;
  shoes: string;
  /** Long sleeves cover the forearms. */
  longSleeves?: boolean;
  /** Shorts: calves show skin. */
  shorts?: boolean;
  /** Skin tone (sRGB hex). */
  skin?: string;
  hair?: string;
  /** Police-style peaked cap (no insignia). Marks the outfit as a police uniform. */
  cap?: string;
  /** Hair: 'short' | 'long' | 'none' (buzz). Default by body. */
  hairStyle?: 'short' | 'long' | 'none';
  /** Optional full-look overrides. */
  look?: Partial<Look>;
}

export interface DressExtras {
  /** Static hair mesh (rest pose, body space) for this outfit's style. */
  hair?: THREE.Object3D | null;
  normalMap?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
}

export type TopKind = 'tee' | 'polo' | 'longsleeve' | 'shirt' | 'hoodie' | 'jacket' | 'puffer' | 'coat' | 'blazer' | 'uniform' | 'hivis' | 'dress';
export type BottomKind = 'jeans' | 'chinos' | 'slacks' | 'shorts' | 'joggers' | 'leggings' | 'skirt' | 'uniform' | 'work';
export type ShoeKind = 'sneaker' | 'runner' | 'canvas' | 'boot' | 'dress' | 'police';
export type HatKind = 'none' | 'cap' | 'beanie' | 'police' | 'hardhat';
export type HairKind = 'short' | 'long' | 'buzz' | 'bald';
export type PersonKind = 'civilian' | 'police' | 'worker' | 'player';
export type Warmth = 'hot' | 'warm' | 'mild' | 'cool' | 'cold';

export interface Look {
  sex: 'm' | 'f';
  /** 0 slim, 1 average, 2 heavy. */
  build: 0 | 1 | 2;
  /** Standing height in meters (1.55–1.95). */
  height: number;
  skin: string;
  eyes: string;
  hair: HairKind;
  hairColor: string;
  hat: HatKind;
  hatColor: string;
  glasses: boolean;
  top: TopKind;
  topColor: string;
  /** Under-layer / trim: shirt under an open jacket or blazer, tee under a hi-vis vest. */
  topColor2: string;
  /** Open front (jackets/coats): shows topColor2. */
  open: boolean;
  /** Sleeve cover override (0 shoulder … 1 wrist). */
  sleeve?: number;
  bottom: BottomKind;
  bottomColor: string;
  belt: boolean;
  shoes: ShoeKind;
  shoeColor: string;
  soleColor: string;
  sockColor: string;
  /** Crew socks visible above the shoe (with shorts/skirts). */
  crewSocks: boolean;
  gloves: string | null;
  /** Reflective generic "POLICE" text on the back. */
  policeBack: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared resources (hair meshes, maps, patch texture)
// ---------------------------------------------------------------------------------------------------------------

const BASE_URL = (import.meta as any).env?.BASE_URL ?? '/';
const url = (p: string) => `${BASE_URL}assets/${p}`;

const HAIR_SRC: { short: THREE.Object3D | null; long: THREE.Object3D | null } = { short: null, long: null };
const MAPS: Record<'m' | 'f', { normal: THREE.Texture | null; rough: THREE.Texture | null }> = { m: { normal: null, rough: null }, f: { normal: null, rough: null } };
let kitPromise: Promise<void> | null = null;

function loadTex(rel: string): THREE.Texture {
  const t = new THREE.TextureLoader().load(url(rel));
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** Loads shared hair meshes + body normal/roughness maps. Safe to call many times; dress/personalize work without it. */
export function preparePeople(): Promise<void> {
  if (!kitPromise) {
    const loader = new GLTFLoader();
    const hair = (rel: string) => loader.loadAsync(url(rel)).then((g: GLTF) => g.scene).catch(() => null);
    kitPromise = Promise.all([hair('models/characters/hair-short.gltf'), hair('models/characters/hair-long.gltf')]).then(([s, l]) => {
      if (s && !HAIR_SRC.short) HAIR_SRC.short = s;
      if (l && !HAIR_SRC.long) HAIR_SRC.long = l;
      for (const sx of ['m', 'f'] as const) {
        const base = sx === 'm' ? 'models/characters/ubc-male' : 'models/characters/ubc-female';
        if (!MAPS[sx].normal) MAPS[sx].normal = loadTex(`${base}-normal.jpg`);
        if (!MAPS[sx].rough) MAPS[sx].rough = loadTex(`${base}-rough.jpg`);
      }
    });
  }
  return kitPromise;
}

let patchTex: THREE.Texture | null = null;
/** Generic reflective back text (no insignia, no agency name). */
function policePatch(): THREE.Texture {
  if (patchTex) return patchTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000'; x.fillRect(0, 0, 256, 64);
  x.fillStyle = '#fff';
  x.font = 'bold 50px Arial, Helvetica, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('POLICE', 128, 34, 244);
  patchTex = new THREE.CanvasTexture(c);
  patchTex.colorSpace = THREE.NoColorSpace;
  patchTex.anisotropy = 4;
  return patchTex;
}

/** Average linear color of a texture image (skin-ish pixels only when `skinOnly`). */
function avgColor(tex: THREE.Texture | null | undefined, skinOnly: boolean, fallback: THREE.Color): THREE.Color {
  try {
    const img = tex?.image as CanvasImageSource | undefined;
    if (!img) return fallback;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(img, 0, 0, 64, 64);
    const d = x.getImageData(0, 0, 64, 64).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      if (skinOnly && !(R > G && G > B && R > 0.3 && R - B > 0.12)) continue;
      r += R; g += G; b += B; n++;
    }
    if (n < 20) return fallback;
    return new THREE.Color().setRGB(r / n, g / n, b / n, THREE.SRGBColorSpace);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Body analysis
// ---------------------------------------------------------------------------------------------------------------

const enum Cat { Head, Neck, Spine, Clav, UArm, LArm, Hand, Pelvis, Thigh, Calf, Foot, N }

function catOf(n: string): Cat {
  const s = n.toLowerCase();
  if (s.startsWith('head')) return Cat.Head;
  if (s.startsWith('neck')) return Cat.Neck;
  if (s.startsWith('spine')) return Cat.Spine;
  if (s.startsWith('clavicle')) return Cat.Clav;
  if (s.startsWith('upperarm')) return Cat.UArm;
  if (s.startsWith('lowerarm')) return Cat.LArm;
  if (/^(hand|thumb|index|middle|ring|pinky)/.test(s)) return Cat.Hand;
  if (s.startsWith('pelvis') || s === 'root') return Cat.Pelvis;
  if (s.startsWith('thigh')) return Cat.Thigh;
  if (s.startsWith('calf')) return Cat.Calf;
  if (s.startsWith('foot') || s.startsWith('ball')) return Cat.Foot;
  return Cat.Head;
}

interface Landmarks {
  shoulderX: number; elbowX: number; wristX: number; armY: number;
  hipY: number; kneeY: number; ankleY: number; pelvisY: number;
  neckY: number; headY: number; spineZ: number; headTop: number;
  headCZ: number; faceZ: number; eyeY: number; kneeZ: number;
  headMin: THREE.Vector3; headMax: THREE.Vector3; height: number;
}

interface Base {
  sex: 'm' | 'f';
  src: THREE.SkinnedMesh;
  L: Landmarks;
  joints: Map<string, THREE.Vector3>;
  geos: (THREE.BufferGeometry | null)[];
  map: THREE.Texture | null;
  texAvg: THREE.Color;
  lm: { uL1: { value: THREE.Vector4 }; uL2: { value: THREE.Vector4 }; uL3: { value: THREE.Vector4 }; uL4: { value: THREE.Vector4 } };
  headBone: number;
  bindMatrix: THREE.Matrix4;
  brows: THREE.SkinnedMesh | null;
  eyes: THREE.SkinnedMesh | null;
}

const BASES = new Map<THREE.BufferGeometry, Base>(); // original body geometry → base
const GEO_BASE = new WeakMap<THREE.BufferGeometry, Base>(); // any prepared geometry → base
const BASE_BY_SEX: Partial<Record<'m' | 'f', Base>> = {};

function jointPos(mesh: THREE.SkinnedMesh, i: number): THREE.Vector3 {
  const m = new THREE.Matrix4().copy(mesh.skeleton.boneInverses[i]).invert();
  return new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(mesh.bindMatrixInverse);
}

function analyze(body: THREE.SkinnedMesh, brows: THREE.SkinnedMesh | null, eyes: THREE.SkinnedMesh | null, sex: 'm' | 'f'): Base {
  const bones = body.skeleton.bones;
  const joints = new Map<string, THREE.Vector3>();
  bones.forEach((b, i) => joints.set(b.name, jointPos(body, i)));
  const J = (n: string) => joints.get(n) ?? new THREE.Vector3();
  const pos = body.geometry.getAttribute('position');
  const headMin = new THREE.Vector3(1e9, 1e9, 1e9), headMax = new THREE.Vector3(-1e9, -1e9, -1e9);
  let top = -1e9;
  const neckY = J('neck_01').y;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    top = Math.max(top, v.y);
    if (v.y > neckY + 0.06 && Math.abs(v.x) < 0.16) { headMin.min(v); headMax.max(v); }
  }
  let eyeY = J('Head').y + 0.07, faceZ = headMax.z;
  if (eyes) {
    const ep = eyes.geometry.getAttribute('position');
    let s = 0, zmax = -1e9;
    for (let i = 0; i < ep.count; i++) { s += ep.getY(i); zmax = Math.max(zmax, ep.getZ(i)); }
    eyeY = s / ep.count; faceZ = zmax;
  }
  const sp = ['spine_01', 'spine_02', 'spine_03'].map((n) => J(n).z);
  const L: Landmarks = {
    shoulderX: Math.abs(J('upperarm_l').x), elbowX: Math.abs(J('lowerarm_l').x), wristX: Math.abs(J('hand_l').x), armY: J('upperarm_l').y,
    hipY: J('thigh_l').y, kneeY: J('calf_l').y, ankleY: J('foot_l').y, pelvisY: J('pelvis').y,
    neckY, headY: J('Head').y, spineZ: (sp[0] + sp[1] + sp[2]) / 3, headTop: top,
    headCZ: (headMin.z + headMax.z) / 2 - 0.01, faceZ, eyeY, kneeZ: J('calf_l').z,
    headMin, headMax, height: top,
  };
  const map = (body.material as THREE.MeshStandardMaterial).map ?? null;
  const base: Base = {
    sex, src: body, L, joints, geos: [null, null, null], map,
    texAvg: avgColor(map, true, new THREE.Color(0.55, 0.3, 0.19)),
    lm: {
      uL1: { value: new THREE.Vector4(L.shoulderX, L.elbowX, L.wristX, L.armY) },
      uL2: { value: new THREE.Vector4(L.hipY, L.kneeY, L.ankleY, L.pelvisY) },
      uL3: { value: new THREE.Vector4(L.neckY, L.headY, L.spineZ, L.headTop) },
      uL4: { value: new THREE.Vector4(L.headCZ, L.faceZ, L.eyeY, L.kneeZ) },
    },
    headBone: bones.findIndex((b) => b.name === 'Head'),
    bindMatrix: body.bindMatrix.clone(),
    brows, eyes,
  };
  return base;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry: proportions, garment shells, skirt tube, face parts → one merged skinned geometry per sex × build
// ---------------------------------------------------------------------------------------------------------------

interface BuildParams { uarm: number; larm: number; thigh: number; calf: number; chestX: number; chestZ: number; waistX: number; glute: number; belly: number; neck: number; hand: number; hipX: number }
const BUILDS: Record<'m' | 'f', BuildParams[]> = {
  m: [
    { uarm: 0.8, larm: 0.86, thigh: 0.82, calf: 0.86, chestX: 0.9, chestZ: 0.84, waistX: 0.94, glute: 0.66, belly: 0.0, neck: 0.86, hand: 0.9, hipX: 0.94 },
    { uarm: 0.86, larm: 0.9, thigh: 0.88, calf: 0.9, chestX: 0.94, chestZ: 0.88, waistX: 1.02, glute: 0.72, belly: 0.03, neck: 0.9, hand: 0.92, hipX: 0.97 },
    { uarm: 0.97, larm: 0.98, thigh: 0.98, calf: 0.97, chestX: 1.0, chestZ: 0.98, waistX: 1.14, glute: 0.84, belly: 0.085, neck: 0.98, hand: 0.97, hipX: 1.02 },
  ],
  f: [
    { uarm: 0.84, larm: 0.9, thigh: 0.84, calf: 0.88, chestX: 0.94, chestZ: 0.9, waistX: 0.96, glute: 0.7, belly: 0.0, neck: 0.92, hand: 0.94, hipX: 0.92 },
    { uarm: 0.9, larm: 0.94, thigh: 0.9, calf: 0.92, chestX: 0.97, chestZ: 0.94, waistX: 1.04, glute: 0.76, belly: 0.025, neck: 0.95, hand: 0.95, hipX: 0.96 },
    { uarm: 1.0, larm: 1.0, thigh: 1.0, calf: 0.98, chestX: 1.03, chestZ: 1.0, waistX: 1.15, glute: 0.86, belly: 0.07, neck: 1.0, hand: 1.0, hipX: 1.03 },
  ],
};

const smooth01 = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const win = (y: number, a: number, b: number, f: number) => smooth01(a - f, a + f, y) * (1 - smooth01(b - f, b + f, y));

interface Src {
  P: Float32Array; N: Float32Array; UV: Float32Array; SI: Uint16Array; SW: Float32Array; idx: Uint32Array; n: number;
  weld: Int32Array; canon: number;
}

function readMesh(mesh: THREE.SkinnedMesh, xf: THREE.Matrix4 | null, boneRemap: Int32Array | null): Src {
  const g = mesh.geometry;
  const pa = g.getAttribute('position'), na = g.getAttribute('normal'), ua = g.getAttribute('uv');
  const sia = g.getAttribute('skinIndex'), swa = g.getAttribute('skinWeight');
  const n = pa.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), UV = new Float32Array(n * 2), SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  if (xf) nm.getNormalMatrix(xf);
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pa, i); if (xf) v.applyMatrix4(xf);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    v.fromBufferAttribute(na, i); if (xf) v.applyMatrix3(nm).normalize();
    N[i * 3] = v.x; N[i * 3 + 1] = v.y; N[i * 3 + 2] = v.z;
    if (ua) { UV[i * 2] = ua.getX(i); UV[i * 2 + 1] = ua.getY(i); }
    const s4 = [sia.getX(i), sia.getY(i), sia.getZ(i), sia.getW(i)];
    const w4 = [swa.getX(i), swa.getY(i), swa.getZ(i), swa.getW(i)];
    for (let k = 0; k < 4; k++) { SI[i * 4 + k] = boneRemap ? Math.max(0, boneRemap[s4[k]]) : s4[k]; SW[i * 4 + k] = w4[k]; }
  }
  const ia = g.index;
  const idx = new Uint32Array(ia ? ia.count : n);
  for (let i = 0; i < idx.length; i++) idx[i] = ia ? ia.getX(i) : i;
  // weld by position (UV seams duplicate vertices)
  const weld = new Int32Array(n);
  const map = new Map<string, number>();
  let canon = 0;
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(P[i * 3] * 2e4)},${Math.round(P[i * 3 + 1] * 2e4)},${Math.round(P[i * 3 + 2] * 2e4)}`;
    let c = map.get(k);
    if (c === undefined) { c = canon++; map.set(k, c); }
    weld[i] = c;
  }
  return { P, N, UV, SI, SW, idx, n, weld, canon };
}

/** Area-weighted normals over welded topology (no seams). */
function weldedNormals(P: Float32Array, idx: ArrayLike<number>, weld: Int32Array, canon: number, n: number): Float32Array {
  const acc = new Float32Array(canon * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
    a.set(P[i1 * 3] - P[i0 * 3], P[i1 * 3 + 1] - P[i0 * 3 + 1], P[i1 * 3 + 2] - P[i0 * 3 + 2]);
    b.set(P[i2 * 3] - P[i0 * 3], P[i2 * 3 + 1] - P[i0 * 3 + 1], P[i2 * 3 + 2] - P[i0 * 3 + 2]);
    c.crossVectors(a, b);
    for (const i of [i0, i1, i2]) { const w = weld[i]; acc[w * 3] += c.x; acc[w * 3 + 1] += c.y; acc[w * 3 + 2] += c.z; }
  }
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const w = weld[i];
    a.set(acc[w * 3], acc[w * 3 + 1], acc[w * 3 + 2]).normalize();
    N[i * 3] = a.x; N[i * 3 + 1] = a.y; N[i * 3 + 2] = a.z;
  }
  return N;
}

/** Re-sculpt the superhero body toward everyday proportions (bind pose; skinning follows automatically). */
function deformBody(s: Src, base: Base, bp: BuildParams): void {
  const { L } = base;
  const bones = base.src.skeleton.bones;
  const cats = bones.map((b) => catOf(b.name));
  const J = (n: string) => base.joints.get(n) ?? new THREE.Vector3();
  const seg = (a: string, b: string) => [J(a), J(b)] as const;
  const limbs: Partial<Record<Cat, { l: readonly [THREE.Vector3, THREE.Vector3]; r: readonly [THREE.Vector3, THREE.Vector3]; s: number }>> = {
    [Cat.UArm]: { l: seg('upperarm_l', 'lowerarm_l'), r: seg('upperarm_r', 'lowerarm_r'), s: bp.uarm },
    [Cat.LArm]: { l: seg('lowerarm_l', 'hand_l'), r: seg('lowerarm_r', 'hand_r'), s: bp.larm },
    [Cat.Thigh]: { l: seg('thigh_l', 'calf_l'), r: seg('thigh_r', 'calf_r'), s: bp.thigh },
    [Cat.Calf]: { l: seg('calf_l', 'foot_l'), r: seg('calf_r', 'foot_r'), s: bp.calf },
    [Cat.Neck]: { l: seg('neck_01', 'Head'), r: seg('neck_01', 'Head'), s: bp.neck },
  };
  const wristL = J('hand_l'), wristR = J('hand_r');
  const zAxisAt = (y: number) => {
    const pts = [J('pelvis'), J('spine_01'), J('spine_02'), J('spine_03'), J('neck_01')];
    if (y <= pts[0].y) return pts[0].z;
    for (let i = 0; i < pts.length - 1; i++) if (y <= pts[i + 1].y) return THREE.MathUtils.lerp(pts[i].z, pts[i + 1].z, (y - pts[i].y) / (pts[i + 1].y - pts[i].y));
    return pts[pts.length - 1].z;
  };
  const w = new Float32Array(Cat.N);
  const p = new THREE.Vector3(), d = new THREE.Vector3(), ab = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < s.n; i++) {
    w.fill(0);
    for (let k = 0; k < 4; k++) w[cats[s.SI[i * 4 + k]] ?? Cat.Head] += s.SW[i * 4 + k];
    p.set(s.P[i * 3], s.P[i * 3 + 1], s.P[i * 3 + 2]);
    d.set(0, 0, 0);
    const left = p.x >= 0;
    // limbs: radial girth about the bone segment
    for (const [ck, lb] of Object.entries(limbs) as [string, { l: readonly [THREE.Vector3, THREE.Vector3]; r: readonly [THREE.Vector3, THREE.Vector3]; s: number }][]) {
      const wc = w[Number(ck)];
      if (wc <= 0) continue;
      const [A, B] = left ? lb.l : lb.r;
      ab.subVectors(B, A);
      const t = Math.min(1, Math.max(0, q.subVectors(p, A).dot(ab) / ab.lengthSq()));
      q.copy(A).addScaledVector(ab, t);
      let sc = lb.s;
      if (Number(ck) === Cat.UArm) sc *= THREE.MathUtils.lerp(0.9, 1, smooth01(0, 0.35, t)); // deltoid cap
      if (Number(ck) === Cat.Thigh) sc *= THREE.MathUtils.lerp(0.95, 1, smooth01(0, 0.4, t)); // upper-thigh mass
      d.addScaledVector(q.clone().addScaledVector(q.subVectors(p, q), sc).sub(p), wc);
    }
    // hands: shrink toward the wrist
    if (w[Cat.Hand] > 0) {
      const wr = left ? wristL : wristR;
      d.addScaledVector(q.subVectors(p, wr).multiplyScalar(bp.hand - 1), w[Cat.Hand]);
    }
    // torso: width / depth about the spine axis
    const wt = w[Cat.Spine] + w[Cat.Pelvis] + 0.5 * w[Cat.Clav];
    if (wt > 0) {
      const za = zAxisAt(p.y);
      const chest = smooth01(L.armY - 0.32, L.armY - 0.14, p.y);
      const sx = THREE.MathUtils.lerp(p.y < L.hipY + 0.05 ? bp.hipX : bp.waistX, bp.chestX, chest);
      d.x += p.x * (sx - 1) * wt;
      const front = p.z > za;
      if (front) d.z += (p.z - za) * (THREE.MathUtils.lerp(1, bp.chestZ, chest * win(p.y, L.armY - 0.3, L.neckY, 0.04)) - 1) * wt;
      // belly
      if (front && bp.belly > 0) d.z += bp.belly * win(p.y, L.hipY + 0.02, L.armY - 0.24, 0.07) * smooth01(0.02, 0.09, p.z - za) * wt;
    }
    // glutes (pelvis + upper thigh, back side)
    const zg = J('pelvis').z;
    if (p.z < zg && Math.abs(p.x) < 0.24) {
      const wg = win(p.y, L.hipY - 0.24, L.hipY + 0.1, 0.05) * Math.min(1, w[Cat.Pelvis] + w[Cat.Thigh] + w[Cat.Spine]);
      d.z += (p.z - zg) * (bp.glute - 1) * wg;
    }
    s.P[i * 3] += d.x; s.P[i * 3 + 1] += d.y; s.P[i * 3 + 2] += d.z;
  }
}

interface Out { P: number[]; N: number[]; UV: number[]; SI: number[]; SW: number[]; GT: number[]; I: number[] }

function pushVert(o: Out, s: Src, i: number, p: ArrayLike<number>, pi: number, nrm: ArrayLike<number>, ni: number, gt: [number, number, number, number]) {
  o.P.push(p[pi], p[pi + 1], p[pi + 2]);
  o.N.push(nrm[ni], nrm[ni + 1], nrm[ni + 2]);
  o.UV.push(s.UV[i * 2], s.UV[i * 2 + 1]);
  for (let k = 0; k < 4; k++) { o.SI.push(s.SI[i * 4 + k]); o.SW.push(s.SW[i * 4 + k]); }
  o.GT.push(gt[0], gt[1], gt[2], gt[3]);
}

/**
 * A garment shell over the selected body region: Laplacian-smoothed (bridges the concavities between muscles, like
 * fabric draping over the body), never inside the body, pushed out by `push` meters.
 */
function addShell(o: Out, s: Src, sel: (i: number) => boolean, layer: number, iters: number, push: number, post?: (p: THREE.Vector3, orig: THREE.Vector3) => void) {
  const inSel = new Uint8Array(s.n);
  for (let i = 0; i < s.n; i++) inSel[i] = sel(i) ? 1 : 0;
  const tris: number[] = [];
  for (let t = 0; t < s.idx.length; t += 3) {
    const a = s.idx[t], b = s.idx[t + 1], c = s.idx[t + 2];
    if (inSel[a] && inSel[b] && inSel[c]) tris.push(a, b, c);
  }
  if (!tris.length) return;
  const C = s.canon;
  const nb: Set<number>[] = [];
  const used = new Uint8Array(C);
  const edge = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = s.weld[tris[t + e]], b = s.weld[tris[t + ((e + 1) % 3)]];
      if (a === b) continue;
      used[a] = used[b] = 1;
      (nb[a] ??= new Set()).add(b); (nb[b] ??= new Set()).add(a);
      const k = a < b ? a * C + b : b * C + a;
      edge.set(k, (edge.get(k) ?? 0) + 1);
    }
  }
  const boundary = new Uint8Array(C);
  for (const [k, cnt] of edge) if (cnt === 1) { boundary[Math.floor(k / C)] = 1; boundary[k % C] = 1; }
  // canonical positions
  const orig = new Float32Array(C * 3);
  for (let i = 0; i < s.n; i++) { const w = s.weld[i]; orig[w * 3] = s.P[i * 3]; orig[w * 3 + 1] = s.P[i * 3 + 1]; orig[w * 3 + 2] = s.P[i * 3 + 2]; }
  let cur = Float32Array.from(orig);
  let nxt = new Float32Array(C * 3);
  for (let it = 0; it < iters; it++) {
    for (let c = 0; c < C; c++) {
      if (!used[c]) continue;
      const ns = nb[c];
      let x = 0, y = 0, z = 0;
      for (const j of ns) { x += cur[j * 3]; y += cur[j * 3 + 1]; z += cur[j * 3 + 2]; }
      const k = 1 / ns.size, lam = boundary[c] ? 0.12 : 0.55;
      nxt[c * 3] = cur[c * 3] + (x * k - cur[c * 3]) * lam;
      nxt[c * 3 + 1] = cur[c * 3 + 1] + (y * k - cur[c * 3 + 1]) * lam;
      nxt[c * 3 + 2] = cur[c * 3 + 2] + (z * k - cur[c * 3 + 2]) * lam;
    }
    [cur, nxt] = [nxt, cur];
  }
  // smoothed normals (canonical)
  const cn = new Float32Array(C * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), cr = new THREE.Vector3();
  for (let t = 0; t < tris.length; t += 3) {
    const i0 = s.weld[tris[t]], i1 = s.weld[tris[t + 1]], i2 = s.weld[tris[t + 2]];
    a.set(cur[i1 * 3] - cur[i0 * 3], cur[i1 * 3 + 1] - cur[i0 * 3 + 1], cur[i1 * 3 + 2] - cur[i0 * 3 + 2]);
    b.set(cur[i2 * 3] - cur[i0 * 3], cur[i2 * 3 + 1] - cur[i0 * 3 + 1], cur[i2 * 3 + 2] - cur[i0 * 3 + 2]);
    cr.crossVectors(a, b);
    for (const i of [i0, i1, i2]) { cn[i * 3] += cr.x; cn[i * 3 + 1] += cr.y; cn[i * 3 + 2] += cr.z; }
  }
  const fin = new Float32Array(C * 3);
  const pv = new THREE.Vector3(), ov = new THREE.Vector3(), nv = new THREE.Vector3();
  for (let c = 0; c < C; c++) {
    if (!used[c]) continue;
    nv.set(cn[c * 3], cn[c * 3 + 1], cn[c * 3 + 2]).normalize();
    pv.set(cur[c * 3], cur[c * 3 + 1], cur[c * 3 + 2]);
    ov.set(orig[c * 3], orig[c * 3 + 1], orig[c * 3 + 2]);
    const inside = Math.max(0, ov.clone().sub(pv).dot(nv));
    pv.addScaledVector(nv, inside + push);
    post?.(pv, ov);
    fin[c * 3] = pv.x; fin[c * 3 + 1] = pv.y; fin[c * 3 + 2] = pv.z;
    cn[c * 3] = nv.x; cn[c * 3 + 1] = nv.y; cn[c * 3 + 2] = nv.z;
  }
  // final normals after push/post
  const fn = new Float32Array(C * 3);
  for (let t = 0; t < tris.length; t += 3) {
    const i0 = s.weld[tris[t]], i1 = s.weld[tris[t + 1]], i2 = s.weld[tris[t + 2]];
    a.set(fin[i1 * 3] - fin[i0 * 3], fin[i1 * 3 + 1] - fin[i0 * 3 + 1], fin[i1 * 3 + 2] - fin[i0 * 3 + 2]);
    b.set(fin[i2 * 3] - fin[i0 * 3], fin[i2 * 3 + 1] - fin[i0 * 3 + 1], fin[i2 * 3 + 2] - fin[i0 * 3 + 2]);
    cr.crossVectors(a, b);
    for (const i of [i0, i1, i2]) { fn[i * 3] += cr.x; fn[i * 3 + 1] += cr.y; fn[i * 3 + 2] += cr.z; }
  }
  for (let c = 0; c < C; c++) { nv.set(fn[c * 3], fn[c * 3 + 1], fn[c * 3 + 2]).normalize(); fn[c * 3] = nv.x; fn[c * 3 + 1] = nv.y; fn[c * 3 + 2] = nv.z; }
  // emit (one output vertex per canonical vertex: the shell is seamless)
  const outIdx = new Int32Array(C).fill(-1);
  const baseV = o.P.length / 3;
  let nOut = 0;
  const rep = new Int32Array(C).fill(-1);
  for (let t = 0; t < tris.length; t++) { const c = s.weld[tris[t]]; if (rep[c] < 0) rep[c] = tris[t]; }
  for (let c = 0; c < C; c++) {
    if (rep[c] < 0) continue;
    outIdx[c] = baseV + nOut++;
    pushVert(o, s, rep[c], fin, c * 3, fn, c * 3, [layer, 0, 0, 0]);
  }
  for (let t = 0; t < tris.length; t += 3) {
    const a0 = outIdx[s.weld[tris[t]]], a1 = outIdx[s.weld[tris[t + 1]]], a2 = outIdx[s.weld[tris[t + 2]]];
    if (a0 === a1 || a1 === a2 || a0 === a2) continue;
    o.I.push(a0, a1, a2);
  }
}

/** A-line tube (skirts, dresses, coat tails) around hips/thighs, skinned to pelvis + thighs. */
function addTube(o: Out, s: Src, base: Base) {
  const { L } = base;
  const bones = base.src.skeleton.bones;
  const bi = (n: string) => Math.max(0, bones.findIndex((b) => b.name === n));
  const pelvis = bi('pelvis');
  const tl = base.joints.get('thigh_l')!.x > 0 ? bi('thigh_l') : bi('thigh_r');
  const tr = tl === bi('thigh_l') ? bi('thigh_r') : bi('thigh_l');
  const y0 = L.pelvisY + 0.07, y1 = L.kneeY - 0.24;
  const R = 16, S = 28;
  const zc = base.joints.get('pelvis')!.z;
  const rad: number[][] = [];
  for (let r = 0; r < R; r++) {
    const y = y0 + (y1 - y0) * (r / (R - 1));
    const ring = new Array(S).fill(0);
    for (let i = 0; i < s.n; i++) {
      const py = s.P[i * 3 + 1];
      if (Math.abs(py - y) > 0.03) continue;
      const px = s.P[i * 3], pz = s.P[i * 3 + 2] - zc;
      if (Math.abs(px) > 0.35) continue;
      const ang = Math.atan2(px, pz);
      const k = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * S) % S;
      ring[k] = Math.max(ring[k], Math.hypot(px, pz));
    }
    for (let pass = 0; pass < 3; pass++) {
      const cp = ring.slice();
      for (let k = 0; k < S; k++) ring[k] = Math.max(cp[k], (cp[(k + S - 1) % S] + cp[k] * 2 + cp[(k + 1) % S]) / 4);
    }
    if (r > 0) for (let k = 0; k < S; k++) ring[k] = Math.max(ring[k], rad[r - 1][k] + 0.006);
    rad.push(ring);
  }
  const baseV = o.P.length / 3;
  for (let r = 0; r < R; r++) {
    const y = y0 + (y1 - y0) * (r / (R - 1));
    const t = r / (R - 1);
    for (let k = 0; k <= S; k++) {
      const ang = (k / S) * Math.PI * 2 - Math.PI + Math.PI / S;
      const rr = rad[r][k % S] + 0.014;
      const x = Math.sin(ang) * rr, z = Math.cos(ang) * rr + zc;
      o.P.push(x, y, z);
      o.N.push(Math.sin(ang), 0.15, Math.cos(ang));
      o.UV.push(0, 0);
      const side = Math.max(-1, Math.min(1, x / 0.1));
      const wp = 1 - 0.8 * smooth01(0.05, 0.7, t);
      const rest = 1 - wp;
      o.SI.push(pelvis, tl, tr, 0);
      o.SW.push(wp, rest * (0.5 + 0.5 * side), rest * (0.5 - 0.5 * side), 0);
      o.GT.push(4, t, 0, 0);
    }
  }
  const row = S + 1;
  for (let r = 0; r < R - 1; r++) for (let k = 0; k < S; k++) {
    const a = baseV + r * row + k, b = a + 1, c = a + row, d = c + 1;
    o.I.push(a, c, b, b, c, d);
  }
}

function addFacePart(o: Out, base: Base, mesh: THREE.SkinnedMesh, layer: number) {
  const bodyBones = base.src.skeleton.bones.map((b) => b.name);
  const remap = new Int32Array(mesh.skeleton.bones.length);
  mesh.skeleton.bones.forEach((b, i) => { remap[i] = bodyBones.indexOf(b.name); });
  const xf = new THREE.Matrix4().copy(base.src.bindMatrixInverse).multiply(mesh.bindMatrix);
  const s = readMesh(mesh, xf, remap);
  // per-eye centers for the procedural iris
  const cL = new THREE.Vector3(), cR = new THREE.Vector3();
  let nL = 0, nR = 0;
  for (let i = 0; i < s.n; i++) {
    if (s.P[i * 3] >= 0) { cL.x += s.P[i * 3]; cL.y += s.P[i * 3 + 1]; cL.z += s.P[i * 3 + 2]; nL++; }
    else { cR.x += s.P[i * 3]; cR.y += s.P[i * 3 + 1]; cR.z += s.P[i * 3 + 2]; nR++; }
  }
  cL.divideScalar(Math.max(1, nL)); cR.divideScalar(Math.max(1, nR));
  const baseV = o.P.length / 3;
  const v = new THREE.Vector3();
  for (let i = 0; i < s.n; i++) {
    v.set(s.P[i * 3], s.P[i * 3 + 1], s.P[i * 3 + 2]).sub(s.P[i * 3] >= 0 ? cL : cR).normalize();
    pushVert(o, s, i, s.P, i * 3, s.N, i * 3, [layer, v.z, 0, 0]);
  }
  for (let t = 0; t < s.idx.length; t++) o.I.push(baseV + s.idx[t]);
}

function buildGeometry(base: Base, build: 0 | 1 | 2): THREE.BufferGeometry {
  const s = readMesh(base.src, null, null);
  deformBody(s, base, BUILDS[base.sex][build]);
  s.N = weldedNormals(s.P, s.idx, s.weld, s.canon, s.n);
  const { L } = base;
  const o: Out = { P: [], N: [], UV: [], SI: [], SW: [], GT: [], I: [] };
  // body
  for (let i = 0; i < s.n; i++) pushVert(o, s, i, s.P, i * 3, s.N, i * 3, [0, 0, 0, 0]);
  for (let t = 0; t < s.idx.length; t++) o.I.push(s.idx[t]);
  const armT = (i: number) => (Math.abs(s.P[i * 3]) - L.shoulderX) / (L.wristX - L.shoulderX);
  const isArm = (i: number) => armT(i) > 0.12 && s.P[i * 3 + 1] > L.hipY;
  const y = (i: number) => s.P[i * 3 + 1];
  // top (torso + arms)
  addShell(o, s, (i) => (isArm(i) ? armT(i) < 1.04 : y(i) > L.hipY - 0.2 && y(i) < L.neckY + 0.05), 1, 14, 0.009);
  // bottom (hips + legs)
  addShell(o, s, (i) => !isArm(i) && y(i) < L.pelvisY + 0.12 && y(i) > L.ankleY - 0.035, 2, 10, 0.007);
  // shoes: heavily smoothed (no toes), flat sole, slightly longer toe box
  let toeZ = -1e9;
  for (let i = 0; i < s.n; i++) if (y(i) < 0.06) toeZ = Math.max(toeZ, s.P[i * 3 + 2]);
  addShell(o, s, (i) => !isArm(i) && y(i) < L.ankleY + 0.16, 3, 22, 0.011, (p) => {
    if (p.y < 0.02) p.y = Math.min(p.y, -0.006);
    p.y = Math.max(p.y, -0.014);
    if (p.z > toeZ - 0.07 && p.y < 0.07) p.z += 0.012 * smooth01(toeZ - 0.07, toeZ - 0.01, p.z);
  });
  addTube(o, s, base);
  if (base.brows) addFacePart(o, base, base.brows, 5);
  if (base.eyes) addFacePart(o, base, base.eyes, 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(o.P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(o.N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(o.UV, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(o.SI, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(o.SW, 4));
  g.setAttribute('gt', new THREE.Float32BufferAttribute(o.GT, 4));
  g.setIndex(o.I.length > 65535 ? new THREE.Uint32BufferAttribute(o.I, 1) : new THREE.Uint16BufferAttribute(o.I, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.name = `gt-person-${base.sex}${build}`;
  GEO_BASE.set(g, base);
  return g;
}

function geometryFor(base: Base, build: 0 | 1 | 2): THREE.BufferGeometry {
  return (base.geos[build] ??= buildGeometry(base, build));
}

// ---------------------------------------------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------------------------------------------

const GLSL_COMMON = /* glsl */ `
uniform vec4 uL1; uniform vec4 uL2; uniform vec4 uL3; uniform vec4 uL4;
uniform vec4 uTopP; uniform vec4 uTopQ; uniform vec4 uBotP; uniform vec4 uBotQ; uniform vec4 uShoeP; uniform vec4 uMisc;
float pzArmT(vec3 p) { return (abs(p.x) - uL1.x) / (uL1.z - uL1.x); }
float pzLegT(vec3 p) { return (uL2.x - p.y) / (uL2.x - uL2.z); }
// x top, y bottom, z shoe
vec4 pzCover(vec3 p) {
  float at = pzArmT(p);
  bool arm = at > 0.12 && p.y > uL2.x;
  float top = arm ? step(at, uTopP.x) : step(uTopP.y, p.y) * step(p.y, uTopQ.x);
  float bot = arm ? 0.0 : step(p.y, uBotP.w) * step(pzLegT(p), uBotP.x);
  float shoe = arm ? 0.0 : step(p.y, uShoeP.x);
  return vec4(top, bot, shoe, 0.0);
}
`;

const GLSL_FRAG_COMMON = /* glsl */ `
uniform vec3 uTopCol; uniform vec3 uTop2Col; uniform vec3 uBotCol; uniform vec3 uShoeCol; uniform vec3 uSoleCol;
uniform vec3 uSockCol; uniform vec3 uSkinCol; uniform vec3 uHairCol; uniform vec3 uEyeCol; uniform vec3 uGloveCol;
uniform vec3 uTubeCol; uniform vec3 uTexAvg; uniform sampler2D uPatch;
float pzHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pzNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(pzHash(i), pzHash(i + vec3(1,0,0)), f.x), mix(pzHash(i + vec3(0,1,0)), pzHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(pzHash(i + vec3(0,0,1)), pzHash(i + vec3(1,0,1)), f.x), mix(pzHash(i + vec3(0,1,1)), pzHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 pzBumpN(vec3 sp, vec3 sn, float h) {
  vec3 dpx = dFdx(sp); vec3 dpy = dFdy(sp);
  float dhx = dFdx(h); float dhy = dFdy(h);
  vec3 r1 = cross(dpy, sn); vec3 r2 = cross(sn, dpx);
  float det = dot(dpx, r1) * (float(gl_FrontFacing) * 2.0 - 1.0);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * sn - grad);
}
`;

// Fabric ids: 0 cotton knit, 1 denim, 2 nylon puffer, 3 wool/suiting, 4 cotton twill, 5 polyester, 6 leather
const GLSL_SHADE = /* glsl */ `
vec3 pzP = vBind;
float pzL = floor(vGt.x + 0.5);
vec4 pzC = pzCover(pzP);
float pzAt = pzArmT(pzP);
bool pzArm = pzAt > 0.12 && pzP.y > uL2.x;
float pzLt = pzLegT(pzP);
bool pzFront = pzP.z > uL3.z;
float pzKind = 0.0; // 0 skin, 1 top, 2 bottom, 3 shoe, 4 tube, 5 sock, 6 glove, 7 brow, 8 eye
if (pzL < 0.5) {
  if (pzC.z > 0.5 && pzC.y < 0.5) pzKind = 3.0;
  else if (pzC.x > 0.5) pzKind = 1.0;
  else if (pzC.y > 0.5) pzKind = 2.0;
  else if (!pzArm && pzP.y < uShoeP.w) pzKind = 5.0;
  else if (pzArm && pzAt > 1.0 && uMisc.y > 0.5) pzKind = 6.0;
} else if (pzL < 1.5) { if (pzC.x < 0.5) discard; pzKind = 1.0; }
else if (pzL < 2.5) { if (pzC.y < 0.5) discard; pzKind = 2.0; }
else if (pzL < 3.5) { if (pzC.z < 0.5 || pzC.y > 0.5) discard; pzKind = 3.0; }
else if (pzL < 4.5) { if (pzP.y < uTopQ.z || pzP.y > uTopQ.w) discard; pzKind = 4.0; }
else if (pzL < 5.5) pzKind = 7.0;
else pzKind = 8.0;

float pzSkin = pzKind < 0.5 ? 1.0 : 0.0;
float pzRough = 0.9;
float pzFab = 0.0;
float pzH = 0.0;
float pzN = pzNoise(pzP * 36.0);
float pzN2 = pzNoise(pzP * 7.0 + 3.1);
vec3 pzCol = vec3(1.0);
if (pzKind < 0.5) {
  vec3 det = diffuseColor.rgb / max(uTexAvg, vec3(0.02));
  float lum = dot(det, vec3(0.3, 0.59, 0.11));
  det = mix(vec3(lum), det, 0.55);
  pzCol = uSkinCol * clamp(det, 0.0, 2.2);
  // buzz cut / scalp under hair
  if (uMisc.x > 0.5) {
    float scalp = max(smoothstep(uL3.w - 0.085, uL3.w - 0.06, pzP.y),
      smoothstep(uL4.x - 0.005, uL4.x - 0.03, pzP.z) * smoothstep(uL4.z - 0.03, uL4.z - 0.005, pzP.y) * step(abs(pzP.x), 0.085));
    pzCol = mix(pzCol, uHairCol * (0.75 + 0.5 * pzN), scalp * 0.92);
    if (scalp > 0.5) pzSkin = 0.0;
    pzRough = 0.85;
  }
} else if (pzKind < 1.5) {
  float st = uTopQ.y;
  pzCol = uTopCol; pzFab = uTopP.w;
  float yb = pzP.y - uL2.x;
  if (st > 2.5 && st < 3.5) { // hi-vis vest over a tee
    if (pzArm) { pzCol = uTop2Col; pzFab = 0.0; }
    else {
      float band = step(abs(yb - 0.15), 0.022) + step(abs(yb - 0.27), 0.022);
      float vert = step(0.055, abs(pzP.x)) * step(abs(pzP.x), 0.1) * step(0.29, yb);
      if (band + vert > 0.5) { pzCol = vec3(0.72, 0.73, 0.7); pzRough = 0.3; pzFab = -1.0; }
    }
  }
  if ((st > 1.5 && st < 2.5) || (st > 5.5 && st < 6.5)) { // open jacket / blazer: under-layer down the front
    float w = st > 5.5 ? mix(0.012, 0.085, clamp((pzP.y - (uL2.x + 0.16)) / 0.26, 0.0, 1.0)) : 0.05;
    if (!pzArm && pzFront && pzP.y > uL2.x - 0.02) {
      if (abs(pzP.x) < w) { pzCol = uTop2Col; pzFab = 0.0; }
      else if (abs(pzP.x) < w + 0.012) pzCol *= 0.62;
    }
  }
  if (st > 0.5 && st < 1.5) { // hoodie: ribbed hem & cuffs, kangaroo pocket, drawstrings
    if (!pzArm && pzP.y - uTopP.y < 0.05) pzCol *= 0.84;
    if (pzArm && pzAt > uTopP.x - 0.08) pzCol *= 0.84;
    float py = pzP.y - uTopP.y;
    if (!pzArm && pzFront && abs(pzP.x) < 0.125 && py > 0.06 && py < 0.2) {
      float e = min(0.125 - abs(pzP.x), min(py - 0.06, 0.2 - py));
      if (e < 0.007) pzCol *= 0.7;
    }
    if (!pzArm && pzFront && abs(abs(pzP.x) - 0.035) < 0.005 && pzP.y > uTopQ.x - 0.2 && pzP.y < uTopQ.x - 0.03) pzCol = mix(pzCol, vec3(0.8), 0.55);
  }
  if (st > 3.5 && st < 4.5) { // uniform shirt: placket, generic plain badge, pocket flaps
    if (!pzArm && pzFront && abs(pzP.x) < 0.005 && yb > 0.0) pzCol *= 0.7;
    if (!pzArm && pzFront && abs(pzP.x - 0.085) < 0.018 && abs(pzP.y - (uL1.w - 0.11)) < 0.022) { pzCol = vec3(0.55, 0.5, 0.36); pzRough = 0.3; pzFab = -1.0; }
    if (!pzArm && pzFront && abs(abs(pzP.x) - 0.085) < 0.04 && abs(pzP.y - (uL1.w - 0.16)) < 0.008) pzCol *= 0.72;
  }
  if (uMisc.z > 0.5 && !pzArm && !pzFront && abs(pzP.x) < 0.13 && abs(pzP.y - (uL1.w - 0.1)) < 0.04) {
    vec2 puv = vec2(-pzP.x / 0.26 + 0.5, (pzP.y - (uL1.w - 0.14)) / 0.08);
    float t = texture2D(uPatch, puv).r;
    pzCol = mix(pzCol, vec3(0.75, 0.75, 0.7), t); pzRough = mix(pzRough, 0.3, t);
  }
} else if (pzKind < 2.5) {
  pzCol = uBotCol; pzFab = uBotP.z;
  if (pzFab > 0.5 && pzFab < 1.5) pzCol *= 1.0 + 0.22 * smoothstep(0.0, 0.07, pzP.z - uL4.w) * smoothstep(0.08, 0.5, pzLt) * (0.7 + 0.6 * pzN2);
  if (uBotQ.x > 0.5 && abs(pzP.y - (uBotP.w - 0.028)) < (uBotQ.x > 1.5 ? 0.028 : 0.018)) {
    pzCol = vec3(0.025); pzRough = 0.45; pzFab = -1.0;
    if (uBotQ.x > 1.5) { float a = atan(pzP.x, pzP.z - uL3.z); if (sin(a * 7.0) > 0.35) pzCol = vec3(0.05); }
  }
} else if (pzKind < 3.5) {
  float st = uShoeP.z;
  pzCol = uShoeCol; pzRough = st > 1.5 && st < 2.5 ? 0.28 : (st > 0.5 && st < 1.5 ? 0.55 : 0.75); pzFab = -1.0;
  if (pzP.y < uShoeP.y) { pzCol = uSoleCol; pzRough = 0.85; }
  else if ((st < 0.5 || st > 2.5) && pzP.y < uShoeP.y + 0.012) pzCol = mix(pzCol, vec3(0.85), 0.8);
  else if (st < 0.5 || st > 2.5) { if (pzFront && abs(pzP.x) > 0.0 && pzP.y > uL2.z - 0.04 && pzN > 0.55) pzCol *= 0.9; }
} else if (pzKind < 4.5) {
  pzCol = uTubeCol; pzFab = uBotQ.z;
} else if (pzKind < 5.5) {
  pzCol = uSockCol; pzFab = 0.0;
} else if (pzKind < 6.5) {
  pzCol = uGloveCol; pzRough = 0.7; pzFab = -1.0;
} else if (pzKind < 7.5) {
  pzCol = uHairCol * 0.55; pzRough = 0.9; pzFab = -1.0;
} else {
  float fw = vGt.y;
  pzCol = vec3(0.62, 0.6, 0.56);
  if (fw > 0.89) pzCol = uEyeCol;
  if (fw > 0.965) pzCol = vec3(0.012);
  pzRough = 0.15; pzFab = -1.0;
}
if (pzKind > 0.5 && pzKind < 5.5 && pzFab > -0.5 && !(pzKind > 2.5 && pzKind < 3.5)) {
  // fabric: mottling, folds, per-fabric roughness
  pzCol *= 0.94 + 0.1 * pzN;
  float fold = 0.0;
  if (pzKind < 1.5) {
    if (pzArm) fold = exp(-pow((pzAt - 0.5) / 0.1, 2.0)) * sin(pzAt * 90.0 + pzP.y * 50.0 + pzN2 * 3.0);
    else fold = 0.6 * sin(pzP.x * 55.0 + sin(pzP.y * 16.0) * 2.5 + pzN2 * 2.0) * smoothstep(uL1.w - 0.12, uL1.w - 0.32, pzP.y);
  } else if (pzKind < 2.5 || pzKind > 4.5) {
    fold = (exp(-pow((pzLt - 0.5) / 0.08, 2.0)) + smoothstep(0.8, 1.0, pzLt) + 0.5 * exp(-pow(pzLt / 0.08, 2.0))) * sin(pzLt * 110.0 + pzP.x * 30.0 + pzN2 * 3.0);
  } else {
    fold = sin(atan(pzP.x, pzP.z - uL3.z) * 9.0 + pzN2 * 2.0) * smoothstep(0.1, 0.9, vGt.y);
  }
  pzH = fold * 0.0035;
  if (pzFab > 1.5 && pzFab < 2.5) {
    float coord = pzArm ? pzAt * 7.0 : pzP.y / 0.085;
    float ch = abs(sin(coord * 3.14159));
    pzH = ch * 0.012; pzCol *= 0.78 + 0.22 * ch;
    pzRough = 0.42;
  } else {
    pzCol *= 1.0 - 0.12 * clamp(-fold, 0.0, 1.0);
    pzRough = pzFab < 0.5 ? 0.96 : pzFab < 1.5 ? 0.9 : pzFab < 3.5 ? 0.86 : pzFab < 4.5 ? 0.88 : pzFab < 5.5 ? 0.62 : 0.45;
  }
}
diffuseColor.rgb = pzCol;
`;

type U = Record<string, { value: any }>;

function makeUniforms(base: Base): U {
  const c = () => ({ value: new THREE.Color() });
  const v4 = () => ({ value: new THREE.Vector4() });
  return {
    ...base.lm,
    uTopP: v4(), uTopQ: v4(), uBotP: v4(), uBotQ: v4(), uShoeP: v4(), uMisc: v4(),
    uTopCol: c(), uTop2Col: c(), uBotCol: c(), uShoeCol: c(), uSoleCol: c(), uSockCol: c(), uSkinCol: c(),
    uHairCol: c(), uEyeCol: c(), uGloveCol: c(), uTubeCol: c(),
    uTexAvg: { value: new THREE.Vector3(base.texAvg.r, base.texAvg.g, base.texAvg.b) },
    uPatch: { value: policePatch() },
  };
}

function personMaterial(base: Base, u: U): THREE.MeshStandardMaterial {
  const src = base.src.material as THREE.MeshStandardMaterial;
  const m = new THREE.MeshStandardMaterial({ map: src.map, roughness: 1, metalness: 0 });
  m.name = 'gt-person';
  const maps = MAPS[base.sex];
  if (maps.normal) { m.normalMap = maps.normal; m.normalScale.set(0.55, -0.55); }
  if (maps.rough) m.roughnessMap = maps.rough;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 gt;\nvarying vec4 vGt;\nvarying vec3 vBind;\n${GLSL_COMMON}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGt = gt; vBind = position;
        {
          float L = floor(gt.x + 0.5);
          if (L < 0.5) { vec4 cv = pzCover(position); if (cv.x + cv.y + cv.z > 0.5) transformed -= normal * 0.004; }
          else if (L < 1.5) transformed += normal * uTopP.z;
          else if (L < 2.5) transformed += normal * uBotP.y;
          else if (L < 4.5 && L > 3.5) transformed += normal * uBotQ.w;
        }`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        if (abs(floor(gt.x + 0.5) - 4.0) < 0.5 && uTopQ.z < 0.0) transformed = vec3(0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec4 vGt;\nvarying vec3 vBind;\n${GLSL_COMMON}\n${GLSL_FRAG_COMMON}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${GLSL_SHADE}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nif (pzSkin < 0.5) roughnessFactor = pzRough; else roughnessFactor = clamp(roughnessFactor * 0.85, 0.35, 0.8);')
      .replace('#include <normal_fragment_maps>', `vec3 pzBN = pzBumpN(-vViewPosition, normal, pzH);
        if (pzSkin > 0.5) {
        #include <normal_fragment_maps>
        } else normal = pzBN;`);
  };
  m.customProgramCacheKey = () => 'gt-person-v2';
  return m;
}

function personDepthMaterial(u: U): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 gt;\n${GLSL_COMMON}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float L = floor(gt.x + 0.5);
          if (L > 0.5 && L < 1.5) transformed += normal * uTopP.z;
          else if (L > 1.5 && L < 2.5) transformed += normal * uBotP.y;
        }`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>
        if (abs(floor(gt.x + 0.5) - 4.0) < 0.5 && uTopQ.z < 0.0) transformed = vec3(0.0);`);
  };
  m.customProgramCacheKey = () => 'gt-person-depth-v2';
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Look → uniforms
// ---------------------------------------------------------------------------------------------------------------

interface TopSpec { sleeve: number; hem: number; collar: number; loose: number; fab: number; style: number; tube?: number }
const TOPS: Record<TopKind, TopSpec> = {
  tee: { sleeve: 0.3, hem: -0.03, collar: -0.035, loose: 0.006, fab: 0, style: 0 },
  polo: { sleeve: 0.27, hem: -0.03, collar: -0.015, loose: 0.006, fab: 0, style: 0 },
  longsleeve: { sleeve: 1.0, hem: -0.03, collar: -0.03, loose: 0.007, fab: 0, style: 0 },
  shirt: { sleeve: 1.0, hem: 0.0, collar: -0.01, loose: 0.008, fab: 4, style: 0 },
  hoodie: { sleeve: 1.03, hem: -0.05, collar: 0.02, loose: 0.02, fab: 0, style: 1 },
  jacket: { sleeve: 1.03, hem: -0.06, collar: 0.015, loose: 0.02, fab: 5, style: 0 },
  puffer: { sleeve: 1.03, hem: -0.07, collar: 0.035, loose: 0.036, fab: 2, style: 0 },
  coat: { sleeve: 1.03, hem: -0.07, collar: 0.02, loose: 0.022, fab: 3, style: 0, tube: 1 },
  blazer: { sleeve: 1.0, hem: -0.09, collar: 0.005, loose: 0.013, fab: 3, style: 6 },
  uniform: { sleeve: 1.0, hem: 0.0, collar: -0.005, loose: 0.01, fab: 4, style: 4 },
  hivis: { sleeve: 0.3, hem: -0.05, collar: -0.02, loose: 0.014, fab: 5, style: 3 },
  dress: { sleeve: 0.22, hem: 0.0, collar: -0.04, loose: 0.006, fab: 0, style: 0, tube: 2 },
};
interface BotSpec { len: number; loose: number; fab: number; skirt?: boolean }
const BOTTOMS: Record<BottomKind, BotSpec> = {
  jeans: { len: 1.0, loose: 0.008, fab: 1 },
  chinos: { len: 1.0, loose: 0.01, fab: 4 },
  slacks: { len: 1.02, loose: 0.012, fab: 3 },
  shorts: { len: 0.46, loose: 0.02, fab: 4 },
  joggers: { len: 1.0, loose: 0.016, fab: 0 },
  leggings: { len: 1.0, loose: 0.002, fab: 5 },
  skirt: { len: 0.1, loose: 0.004, fab: 3, skirt: true },
  uniform: { len: 1.02, loose: 0.012, fab: 4 },
  work: { len: 1.0, loose: 0.016, fab: 4 },
};
interface ShoeSpec { top: number; sole: number; style: number }
const SHOES: Record<ShoeKind, ShoeSpec> = {
  sneaker: { top: 0.02, sole: 0.022, style: 0 },
  runner: { top: 0.015, sole: 0.026, style: 3 },
  canvas: { top: 0.005, sole: 0.02, style: 0 },
  boot: { top: 0.11, sole: 0.028, style: 1 },
  police: { top: 0.1, sole: 0.026, style: 1 },
  dress: { top: -0.01, sole: 0.014, style: 2 },
};

const col = (u: U, k: string, hex: string) => (u[k].value as THREE.Color).set(hex);

function applyLook(u: U, base: Base, look: Look): void {
  const { L } = base;
  const t = TOPS[look.top], b = BOTTOMS[look.bottom], s = SHOES[look.shoes];
  const waist = L.pelvisY + 0.07;
  let hem = L.hipY + t.hem;
  if (look.top === 'uniform' || look.top === 'shirt') hem = waist - 0.03; // tucked in
  const sleeve = look.sleeve ?? t.sleeve;
  let style = t.style;
  if ((look.top === 'jacket' || look.top === 'coat') && look.open) style = 2;
  // tube: coat tails / dress / skirt
  let tubeHem = -1, tubeTop = 9, tubeCol = look.bottomColor, tubeFab = b.fab;
  if (t.tube === 1) { tubeHem = L.kneeY + 0.02; tubeTop = hem + 0.03; tubeCol = look.topColor; tubeFab = t.fab; }
  else if (t.tube === 2 || b.skirt) {
    tubeHem = L.kneeY + (look.sex === 'f' ? 0.06 : 0.1); tubeTop = waist + 0.02;
    if (t.tube === 2) { tubeCol = look.topColor; tubeFab = 0; tubeTop = 9; hem = waist - 0.04; }
  }
  (u.uTopP.value as THREE.Vector4).set(sleeve, hem, t.loose, t.fab);
  (u.uTopQ.value as THREE.Vector4).set(L.neckY + t.collar, style, tubeHem, tubeTop);
  const len = t.tube === 2 ? 0.1 : b.len;
  (u.uBotP.value as THREE.Vector4).set(len, b.loose, b.fab, waist);
  (u.uBotQ.value as THREE.Vector4).set(look.bottom === 'uniform' ? 2 : look.belt ? 1 : 0, 0, tubeFab, t.tube === 1 ? t.loose * 0.6 : 0.004);
  const shoeTop = L.ankleY + s.top;
  const bare = len < 0.9;
  (u.uShoeP.value as THREE.Vector4).set(shoeTop, s.sole, s.style, bare && look.crewSocks ? shoeTop + 0.07 : shoeTop + 0.012);
  (u.uMisc.value as THREE.Vector4).set(look.hair === 'bald' ? 0 : 1, look.gloves ? 1 : 0, look.policeBack ? 1 : 0, 0);
  col(u, 'uTopCol', look.topColor); col(u, 'uTop2Col', look.topColor2); col(u, 'uBotCol', look.bottomColor);
  col(u, 'uShoeCol', look.shoeColor); col(u, 'uSoleCol', look.soleColor); col(u, 'uSockCol', look.sockColor);
  col(u, 'uSkinCol', look.skin); col(u, 'uHairCol', look.hairColor); col(u, 'uEyeCol', look.eyes);
  col(u, 'uGloveCol', look.gloves ?? '#111111'); col(u, 'uTubeCol', tubeCol);
}

// ---------------------------------------------------------------------------------------------------------------
// Accessories: hair, hats, glasses (static meshes on the Head bone; ≤ 2 draw calls)
// ---------------------------------------------------------------------------------------------------------------

const ACC_GEO = new Map<string, THREE.BufferGeometry | null>();
const ACC_MAT = new Map<string, THREE.Material>();

function colorGeo(g: THREE.BufferGeometry, v: number): THREE.BufferGeometry {
  const gg = g.index ? g.toNonIndexed() : g;
  gg.deleteAttribute('uv');
  const n = gg.getAttribute('position').count;
  gg.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(v), 3));
  return gg;
}

function hatGeometry(base: Base, hat: HatKind, glasses: boolean, longHair: boolean): THREE.BufferGeometry | null {
  const key = `${base.sex}|${hat}|${glasses}|${longHair}`;
  if (ACC_GEO.has(key)) return ACC_GEO.get(key)!;
  const { L } = base;
  const hmn = L.headMin, hmx = L.headMax;
  const rx = (hmx.x - hmn.x) / 2, rz = (hmx.z - hmn.z) / 2 * 0.92;
  const cz = L.headCZ, top = L.headTop;
  const parts: THREE.BufferGeometry[] = [];
  const extra = longHair ? 0.012 : 0;
  if (hat === 'cap' || hat === 'beanie' || hat === 'hardhat') {
    const baseY = L.eyeY + (hat === 'beanie' ? 0.03 : 0.045);
    const pad = (hat === 'beanie' ? 0.016 : hat === 'hardhat' ? 0.03 : 0.012) + extra;
    const ry = top - baseY + pad + (hat === 'hardhat' ? 0.02 : hat === 'beanie' ? 0.015 : 0);
    const crown = new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    crown.scale(rx + pad, ry, rz + pad);
    crown.translate(0, baseY, cz);
    parts.push(colorGeo(crown, 1));
    if (hat === 'beanie') {
      const cuff = new THREE.CylinderGeometry(1, 1, 0.045, 22, 1, true);
      cuff.scale(rx + pad + 0.006, 1, rz + pad + 0.006);
      cuff.translate(0, baseY + 0.005, cz);
      parts.push(colorGeo(cuff, 0.85));
    } else {
      const brimLen = hat === 'cap' ? 0.075 : 0.045;
      const brim = new THREE.CylinderGeometry(1, 1, 0.007, 20, 1, false, -Math.PI / 2, Math.PI);
      brim.scale(rx + pad, 1, brimLen);
      brim.rotateX(hat === 'cap' ? 0.12 : 0.05);
      brim.translate(0, baseY + 0.004, cz + rz + pad - 0.012);
      parts.push(colorGeo(brim, hat === 'cap' ? 0.9 : 1));
      if (hat === 'hardhat') {
        const rim = new THREE.CylinderGeometry(1, 1, 0.01, 24, 1);
        rim.scale(rx + pad + 0.012, 1, rz + pad + 0.012);
        rim.translate(0, baseY + 0.002, cz);
        parts.push(colorGeo(rim, 1));
      }
    }
  } else if (hat === 'police') {
    const baseY = L.eyeY + 0.05, pad = 0.012 + extra;
    const band = new THREE.CylinderGeometry(1, 1, 0.045, 22, 1);
    band.scale(rx + pad, 1, rz + pad); band.translate(0, baseY + 0.02, cz);
    parts.push(colorGeo(band, 0.35));
    const crownG = new THREE.CylinderGeometry(1.14, 1, 0.07, 22, 1);
    crownG.scale(rx + pad + 0.004, 1, rz + pad + 0.012); crownG.translate(0, baseY + 0.075, cz - 0.004);
    parts.push(colorGeo(crownG, 1));
    const bill = new THREE.CylinderGeometry(1, 1, 0.007, 16, 1, false, -Math.PI / 2, Math.PI);
    bill.scale(rx + pad - 0.01, 1, 0.06); bill.rotateX(0.32); bill.translate(0, baseY + 0.004, cz + rz + pad - 0.02);
    parts.push(colorGeo(bill, 0.08));
  }
  if (glasses) {
    const ey = L.eyeY + 0.002, ez = L.faceZ + 0.012;
    for (const sx of [-1, 1]) {
      const lens = new THREE.CylinderGeometry(0.023, 0.021, 0.004, 14);
      lens.rotateX(Math.PI / 2); lens.scale(1.1, 0.8, 1); lens.translate(sx * 0.032, ey, ez);
      parts.push(colorGeo(lens, 0.012));
      const arm = new THREE.BoxGeometry(0.003, 0.004, 0.1);
      arm.translate(sx * (rx - 0.002), ey + 0.006, ez - 0.05);
      parts.push(colorGeo(arm, 0.02));
    }
    const bridge = new THREE.BoxGeometry(0.02, 0.004, 0.004);
    bridge.translate(0, ey + 0.008, ez + 0.001);
    parts.push(colorGeo(bridge, 0.02));
  }
  let g: THREE.BufferGeometry | null = null;
  if (parts.length) {
    g = mergeSimple(parts);
    g.computeVertexNormals();
  }
  ACC_GEO.set(key, g);
  return g;
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], C: number[] = [];
  for (const p of parts) {
    const pa = p.getAttribute('position'), na = p.getAttribute('normal'), ca = p.getAttribute('color');
    for (let i = 0; i < pa.count; i++) {
      P.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      N.push(na.getX(i), na.getY(i), na.getZ(i));
      C.push(ca.getX(i), ca.getY(i), ca.getZ(i));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}

function accMaterial(hat: HatKind, color: string): THREE.Material {
  const key = `${hat}|${color}`;
  let m = ACC_MAT.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, color: hat === 'none' ? '#ffffff' : color, roughness: hat === 'hardhat' ? 0.35 : hat === 'police' ? 0.6 : 0.85, metalness: 0 });
    m.name = 'gt-acc';
    ACC_MAT.set(key, m);
  }
  return m;
}

const HAIR_TEX_AVG = new Map<THREE.Texture | null, THREE.Color>();
function hairMaterial(src: THREE.MeshStandardMaterial, color: string, style: string): THREE.Material {
  const key = `hair|${style}|${color}`;
  let m = ACC_MAT.get(key) as THREE.MeshStandardMaterial | undefined;
  if (!m) {
    m = src.clone();
    let avg = HAIR_TEX_AVG.get(src.map ?? null);
    if (!avg) { avg = avgColor(src.map, false, new THREE.Color(0.08, 0.05, 0.03)); HAIR_TEX_AVG.set(src.map ?? null, avg); }
    const target = new THREE.Color(color);
    m.color.setRGB(Math.min(4, target.r / Math.max(avg.r, 0.01)), Math.min(4, target.g / Math.max(avg.g, 0.01)), Math.min(4, target.b / Math.max(avg.b, 0.01)));
    m.roughness = 0.72; m.metalness = 0; m.side = THREE.DoubleSide;
    m.name = 'gt-hair';
    ACC_MAT.set(key, m);
  }
  return m;
}

const HAIR_GEO = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null>();
/** Hair mesh geometry in the target body's space (long hair comes from the female head, short from the male). */
function hairFor(base: Base, style: 'short' | 'long'): { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial } | null {
  const key = `${base.sex}|${style}`;
  if (HAIR_GEO.has(key)) return HAIR_GEO.get(key)!;
  const src = HAIR_SRC[style];
  if (!src) return null;
  let mesh: THREE.Mesh | null = null;
  src.traverse((o) => { if (!mesh && (o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh; });
  if (!mesh) { HAIR_GEO.set(key, null); return null; }
  const m = mesh as THREE.Mesh;
  src.updateMatrixWorld(true);
  const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
  const native: 'm' | 'f' = style === 'short' ? 'm' : 'f';
  if (native !== base.sex) {
    const nb = BASE_BY_SEX[native];
    if (!nb) return null; // can't fit yet (other body not loaded)
    const hn = nb.L, ht = base.L;
    const k = (ht.headTop - ht.eyeY) / (hn.headTop - hn.eyeY);
    const kx = (ht.headMax.x - ht.headMin.x) / (hn.headMax.x - hn.headMin.x);
    geo.translate(0, -hn.eyeY, -hn.headCZ);
    geo.scale(kx, k, kx);
    geo.translate(0, ht.eyeY, ht.headCZ);
  }
  const r = { geo, mat: m.material as THREE.MeshStandardMaterial };
  HAIR_GEO.set(key, r);
  return r;
}

function attachToHead(root: THREE.Object3D, body: THREE.SkinnedMesh, base: Base, obj: THREE.Object3D) {
  const head = body.skeleton.bones[base.headBone];
  if (!head) return;
  const m = new THREE.Matrix4().copy(body.skeleton.boneInverses[base.headBone]).multiply(body.bindMatrix);
  obj.matrix.identity();
  obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1);
  obj.applyMatrix4(m);
  obj.name = 'gt-acc';
  head.add(obj);
  void root;
}

function setAccessories(root: THREE.Object3D, body: THREE.SkinnedMesh, base: Base, look: Look) {
  const head = body.skeleton.bones[base.headBone];
  if (head) for (const c of [...head.children]) if (c.name === 'gt-acc' || c.name === 'cap') head.remove(c);
  // Hair: short hair is hidden under caps/police caps/hard hats (sides read as the buzz-painted scalp).
  const hatHides = look.hat !== 'none' && look.hair !== 'long';
  if ((look.hair === 'short' || look.hair === 'long') && !hatHides) {
    const h = hairFor(base, look.hair);
    if (h) {
      const mesh = new THREE.Mesh(h.geo, hairMaterial(h.mat, look.hairColor, look.hair));
      mesh.castShadow = true;
      attachToHead(root, body, base, mesh);
    }
  }
  const g = hatGeometry(base, look.hat, look.glasses, look.hair === 'long');
  if (g) {
    const mesh = new THREE.Mesh(g, accMaterial(look.hat, look.hatColor));
    mesh.castShadow = look.hat !== 'none';
    attachToHead(root, body, base, mesh);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Random looks
// ---------------------------------------------------------------------------------------------------------------

type R = () => number;
function pick<T>(r: R, a: readonly T[]): T { return a[Math.floor(r() * a.length) % a.length]; }
function pickW<T extends string>(r: R, w: Partial<Record<T, number>>): T {
  const e = Object.entries(w) as [T, number][];
  let tot = 0; for (const [, v] of e) tot += v;
  let x = r() * tot;
  for (const [k, v] of e) { x -= v; if (x <= 0) return k; }
  return e[e.length - 1][0];
}
function jitter(r: R, hex: string, amt = 0.05): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + (r() - 0.5) * amt * 0.5 + 1) % 1, Math.min(1, Math.max(0, hsl.s * (1 + (r() - 0.5) * amt * 2))), Math.min(1, Math.max(0, hsl.l * (1 + (r() - 0.5) * amt * 3))));
  return '#' + c.getHexString();
}
function gauss(r: R) { return (r() + r() + r() - 1.5) / 0.5; }

const SKIN_TONES: [string, number][] = [
  ['#f2d3bd', 0.12], ['#e8bf9f', 0.16], ['#d6a582', 0.16], ['#c28c67', 0.14], ['#a8734f', 0.12], ['#8a5b3e', 0.12], ['#6b442f', 0.1], ['#4d3024', 0.08],
];
const EYES = ['#2e1c10', '#2e1c10', '#2e1c10', '#1c120a', '#4f3d22', '#3f5f80', '#46583a', '#5a4a36'];
const HAIR_DARK = ['#0f0c0a', '#16110d', '#241911', '#2e2016'];
const HAIR_ALL = ['#0f0c0a', '#16110d', '#241911', '#2e2016', '#3e2a1b', '#5a3d25', '#7a5836', '#a4804f', '#c2a06a', '#6a2e18', '#8d8a84', '#bdb8b0'];
const TOPS_CASUAL = ['#f0eee8', '#1c1d21', '#8e9196', '#3a3d44', '#1f2b44', '#56613f', '#6b2430', '#2f4f3e', '#b8a07a', '#4c6a8c', '#c9b99a', '#b88a2e', '#9a4a2e', '#2f6f73', '#a8323a', '#d4a0a6', '#8a84ad', '#6e8fb3', '#e4d8c4'];
const JACKETS = ['#18191c', '#1f2638', '#4a4f36', '#8a7456', '#3b3e44', '#4a3526', '#5a6470', '#6b2a2a', '#2c3e34'];
const PUFFERS = ['#141518', '#1c2234', '#8f1f22', '#44503a', '#a9adb2', '#3e5d7a', '#c9812b', '#2a2c30'];
const COATS = ['#26272a', '#4b3f35', '#8b6f4e', '#1c2233', '#5b5d61', '#3f2f2a', '#6a6456'];
const BLAZERS = ['#23262d', '#1d2536', '#3d4046', '#5b5347', '#2b2b2b'];
const SHIRTS = ['#f3f3ef', '#cfdcec', '#e9e4da', '#dfe7f2', '#f1ece3', '#e7d9e4'];
const JEANS = ['#1f2a44', '#26355a', '#34466b', '#4a6184', '#6f86a6', '#1b1c20', '#3b4150'];
const CHINOS = ['#b9a47e', '#8d7a5c', '#1f2638', '#5a5d58', '#6b5b45', '#3f4a3a', '#a89a86'];
const SLACKS = ['#1f2126', '#2b2f38', '#1c2233', '#3c3d40', '#3a342e'];
const SHORTS = ['#b9a47e', '#3f5a7a', '#2a2b2f', '#6f86a6', '#56613f', '#8e9196', '#c9b99a'];
const SKIRTS = ['#1d1e22', '#1f2b44', '#6b2430', '#8e9196', '#b8a07a', '#2f4f3e', '#44597c', '#5b4a6e'];
const DRESSES = ['#1d1e22', '#1f2b44', '#8f2a33', '#2f4f3e', '#c9b99a', '#6e8fb3', '#b86a4a', '#e0d6c8', '#5b4a6e'];
const ATHLETIC = ['#1c1d21', '#e8e8e6', '#2d6fb5', '#c43b3b', '#3a3d44', '#e36b2c', '#2f8f6f', '#7a4fa0'];
const LEGGINGS = ['#141518', '#26272c', '#2f2a38', '#1f2638'];
const HATS = ['#1c1d21', '#1f2b44', '#8f1f22', '#e8e6e0', '#56613f', '#b8a07a', '#2d6fb5'];
const BEANIES = ['#1c1d21', '#3a3d44', '#6b2430', '#1f2b44', '#8a6a3a', '#56613f', '#c9812b'];

export function warmthFor(recipe?: { climate?: string; region?: string; origin?: { lat: number } } | null): Warmth {
  if (!recipe) return 'mild';
  const lat = recipe.origin?.lat ?? 38;
  const cl = recipe.climate ?? '', rg = recipe.region ?? '';
  if (cl === 'cold' || rg === 'alaska-hawaii' && lat > 50) return 'cold';
  if ((cl === 'arid' && lat < 36.5) || (cl === 'humid' && lat < 33) || rg === 'southwest' && lat < 35) return 'hot';
  if (rg === 'southeast' || rg === 'south-central') return 'warm';
  if (rg === 'pacific' || rg === 'northeast' || rg === 'midwest') return 'cool';
  return 'mild';
}

/** Deterministic person for `seed`. */
export function randomLook(seed: number, kind: PersonKind, sex: 'm' | 'f', warmth: Warmth = 'mild'): Look {
  const r = rng((seed * 2654435761) ^ 0x5bd1e995);
  const W = { hot: 0, warm: 1, mild: 2, cool: 3, cold: 4 }[warmth];
  const f = sex === 'f';
  const height = Math.min(1.95, Math.max(1.55, (f ? 1.635 : 1.765) + gauss(r) * (f ? 0.055 : 0.06)));
  const build = pickW<'0' | '1' | '2'>(r, { '0': 0.3, '1': 0.45, '2': 0.25 });
  let skin = SKIN_TONES[SKIN_TONES.length - 1][0];
  { let x = r(); for (const [c, w] of SKIN_TONES) { x -= w; if (x <= 0) { skin = c; break; } } }
  skin = jitter(r, skin, 0.03);
  const dark = new THREE.Color(skin).getHSL({ h: 0, s: 0, l: 0 }).l < 0.45;
  const older = r() < 0.15;
  const hairColor = older ? pick(r, ['#8d8a84', '#bdb8b0', '#6e6a64']) : dark ? pick(r, HAIR_DARK) : pick(r, HAIR_ALL);
  let hair: HairKind = f ? pickW<HairKind>(r, { long: 0.82, short: 0.08, buzz: 0.1 }) : pickW<HairKind>(r, { short: 0.5, buzz: 0.3, bald: 0.08, long: 0.12 });
  const look: Look = {
    sex, build: Number(build) as 0 | 1 | 2, height, skin, eyes: pick(r, EYES), hair, hairColor: jitter(r, hairColor, 0.04),
    hat: 'none', hatColor: '#1c1d21', glasses: false,
    top: 'tee', topColor: '#8e9196', topColor2: pick(r, SHIRTS), open: false,
    bottom: 'jeans', bottomColor: pick(r, JEANS), belt: r() < 0.4,
    shoes: 'sneaker', shoeColor: '#ecebe6', soleColor: '#e6e4de', sockColor: r() < 0.6 ? '#e8e8e2' : '#1a1a1c', crewSocks: r() < 0.5,
    gloves: null, policeBack: false,
  };
  if (kind === 'police') {
    Object.assign(look, {
      top: 'uniform', topColor: jitter(r, '#1b2436', 0.03), topColor2: '#1b2436', sleeve: W <= 1 ? 0.3 : 1.0,
      bottom: 'uniform', bottomColor: jitter(r, '#161d2b', 0.03), belt: true,
      shoes: 'police', shoeColor: '#0c0c0d', soleColor: '#0a0a0a', sockColor: '#101012',
      hat: 'police', hatColor: '#141b2a', glasses: r() < (W <= 1 ? 0.35 : 0.12), policeBack: true,
    } satisfies Partial<Look>);
    if (look.hair === 'long') look.hair = 'short';
    return look;
  }
  if (kind === 'worker') {
    const vest = pick(r, ['#c8ee2e', '#d4f03a', '#ff7418', '#ff8a1e']);
    Object.assign(look, {
      top: 'hivis', topColor: vest, topColor2: pick(r, W >= 3 ? ['#3a3d44', '#1f2b44', '#56613f'] : ['#8e9196', '#3a3d44', '#1f2b44', '#f0eee8']),
      sleeve: W >= 2 ? 1.02 : 0.3,
      bottom: 'work', bottomColor: pick(r, ['#8d7a5c', '#3b4150', '#1f2638', '#26355a']), belt: true,
      shoes: 'boot', shoeColor: pick(r, ['#5a3a22', '#6b4a2a', '#2a1d14']), soleColor: '#1c1712',
      hat: r() < 0.55 ? 'hardhat' : r() < 0.5 ? 'cap' : 'none', hatColor: pick(r, ['#f2f0e6', '#f3c521', '#ff7a1a', '#f2f0e6']),
      gloves: r() < 0.4 ? '#8a7a5a' : null, glasses: r() < 0.2,
    } satisfies Partial<Look>);
    return look;
  }
  if (kind === 'player') return look;
  // civilians
  const style = pickW<'casual' | 'business' | 'athletic' | 'street' | 'worker'>(r, { casual: 0.5, business: 0.15, athletic: 0.11, street: 0.18, worker: 0.05 });
  if (style === 'worker') return randomLook(seed + 17, 'worker', sex, warmth);
  const topW: Partial<Record<TopKind, number>>[] = [
    { tee: 0.68, polo: 0.14, longsleeve: 0.06, dress: f ? 0.2 : 0 },
    { tee: 0.5, polo: 0.1, longsleeve: 0.14, jacket: 0.1, hoodie: 0.08, dress: f ? 0.12 : 0 },
    { tee: 0.28, longsleeve: 0.18, hoodie: 0.16, jacket: 0.3, puffer: 0.04, dress: f ? 0.06 : 0 },
    { tee: 0.08, longsleeve: 0.14, hoodie: 0.2, jacket: 0.36, puffer: 0.12, coat: 0.12 },
    { hoodie: 0.08, jacket: 0.18, puffer: 0.42, coat: 0.32 },
  ];
  if (style === 'business') {
    look.top = W <= 0 ? 'shirt' : W >= 4 ? 'coat' : r() < 0.6 ? 'blazer' : 'shirt';
    look.topColor = look.top === 'shirt' ? pick(r, SHIRTS) : look.top === 'coat' ? pick(r, COATS) : pick(r, BLAZERS);
    look.topColor2 = pick(r, SHIRTS); look.open = look.top === 'coat' && r() < 0.5;
    look.bottom = f && r() < 0.4 ? 'skirt' : 'slacks';
    look.bottomColor = look.bottom === 'skirt' ? pick(r, SKIRTS) : r() < 0.6 && look.top === 'blazer' ? look.topColor : pick(r, SLACKS);
    look.belt = !f;
    look.shoes = 'dress'; look.shoeColor = pick(r, ['#121212', '#121212', '#3a2416', '#5a3a22']); look.soleColor = '#0f0d0c'; look.sockColor = '#141416';
    look.crewSocks = false;
    if (look.hair === 'long' && !f) look.hair = 'short';
  } else if (style === 'athletic') {
    look.top = W >= 3 ? pickW<TopKind>(r, { hoodie: 0.5, jacket: 0.5 }) : 'tee';
    look.topColor = look.top === 'jacket' ? pick(r, ATHLETIC) : pick(r, ATHLETIC);
    look.bottom = W <= 2 && r() < 0.65 ? 'shorts' : f && r() < 0.6 ? 'leggings' : 'joggers';
    look.bottomColor = look.bottom === 'leggings' ? pick(r, LEGGINGS) : pick(r, ['#1c1d21', '#2a2b30', '#3a3d44', '#1f2638', '#6e7176']);
    look.shoes = 'runner'; look.shoeColor = pick(r, ['#3a6fb5', '#d9d9d4', '#e0523a', '#2b2d30', '#6ab04c', '#8a8d92']); look.soleColor = '#ebeae5';
    look.sockColor = '#ecece6'; look.crewSocks = r() < 0.3;
    if (r() < 0.2) { look.hat = 'cap'; look.hatColor = pick(r, HATS); }
    look.glasses = r() < 0.25;
    look.belt = false;
  } else {
    look.top = style === 'street' ? (W <= 0 ? 'tee' : pickW<TopKind>(r, { hoodie: 0.6, jacket: 0.25, tee: W <= 1 ? 0.3 : 0.1, puffer: W >= 3 ? 0.3 : 0 })) : pickW<TopKind>(r, topW[W]);
    const t = look.top;
    look.topColor = t === 'jacket' ? pick(r, JACKETS) : t === 'puffer' ? pick(r, PUFFERS) : t === 'coat' ? pick(r, COATS) : t === 'dress' ? pick(r, DRESSES) : pick(r, TOPS_CASUAL);
    look.topColor2 = pick(r, TOPS_CASUAL);
    look.open = (t === 'jacket' && r() < 0.55) || (t === 'coat' && r() < 0.35);
    if (t === 'jacket' && r() < 0.3) look.sleeve = 1.03;
    const botW: Partial<Record<BottomKind, number>>[] = [
      { shorts: 0.5, jeans: 0.24, chinos: 0.1, skirt: f ? 0.2 : 0 },
      { shorts: 0.28, jeans: 0.44, chinos: 0.14, skirt: f ? 0.16 : 0 },
      { shorts: 0.06, jeans: 0.62, chinos: 0.2, joggers: 0.06, skirt: f ? 0.1 : 0 },
      { jeans: 0.64, chinos: 0.2, joggers: 0.08, skirt: f ? 0.06 : 0 },
      { jeans: 0.66, chinos: 0.16, slacks: 0.1, joggers: 0.06 },
    ];
    look.bottom = style === 'street' ? pickW<BottomKind>(r, { jeans: 0.55, joggers: 0.3, shorts: W <= 1 ? 0.35 : 0 }) : pickW<BottomKind>(r, botW[W]);
    const b = look.bottom;
    look.bottomColor = b === 'jeans' ? pick(r, JEANS) : b === 'chinos' ? pick(r, CHINOS) : b === 'shorts' ? pick(r, SHORTS) : b === 'skirt' ? pick(r, SKIRTS) : b === 'slacks' ? pick(r, SLACKS) : pick(r, ['#1c1d21', '#3a3d44', '#6e7176', '#1f2638']);
    look.shoes = pickW<ShoeKind>(r, { sneaker: 0.5, canvas: 0.18, boot: W >= 3 ? 0.3 : 0.1, dress: 0.06, runner: 0.12 });
    if (look.shoes === 'sneaker') { look.shoeColor = pick(r, ['#ecebe6', '#ecebe6', '#1b1b1d', '#8f9296', '#1f2638', '#a33a3a', '#d8cbb0']); look.soleColor = r() < 0.75 ? '#e6e4de' : '#8a6a44'; }
    else if (look.shoes === 'canvas') { look.shoeColor = pick(r, ['#ecebe6', '#1b1b1d', '#8a2a2a', '#2a3a5a', '#4a5a3a']); look.soleColor = '#e9e6de'; }
    else if (look.shoes === 'boot') { look.shoeColor = pick(r, ['#5a3a22', '#2a1d14', '#1a1a1a', '#8a6a44', '#6b4a2a']); look.soleColor = '#1c1712'; }
    else if (look.shoes === 'dress') { look.shoeColor = pick(r, ['#121212', '#3a2416']); look.soleColor = '#0f0d0c'; }
    else { look.shoeColor = pick(r, ['#3a6fb5', '#d9d9d4', '#e0523a', '#2b2d30']); look.soleColor = '#ebeae5'; }
    if (style === 'street' && r() < 0.35) { look.hat = W >= 3 ? 'beanie' : 'cap'; look.hatColor = look.hat === 'beanie' ? pick(r, BEANIES) : pick(r, HATS); }
  }
  // weather accessories
  if (look.hat === 'none') {
    const pc = [0.18, 0.12, 0.07, 0.05, 0.02][W], pb = [0, 0, 0.03, 0.1, 0.3][W];
    const x = r();
    if (x < pc) { look.hat = 'cap'; look.hatColor = pick(r, HATS); }
    else if (x < pc + pb) { look.hat = 'beanie'; look.hatColor = pick(r, BEANIES); }
  }
  if (!look.glasses) look.glasses = r() < [0.3, 0.2, 0.12, 0.05, 0.03][W];
  if (W >= 4 && r() < 0.25) look.gloves = pick(r, ['#1a1a1c', '#3a2a20', '#2a2c30']);
  look.topColor = jitter(r, look.topColor, 0.05);
  look.bottomColor = jitter(r, look.bottomColor, 0.05);
  if (look.hair === 'long' && look.hat === 'cap' && r() < 0.5) look.hat = 'none';
  return look;
}

function outfitToLook(o: Outfit, sex: 'm' | 'f'): Look {
  const police = !!o.cap;
  const seed = [...(o.top + o.bottom + o.shoes)].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) >>> 0;
  const look = randomLook(seed, police ? 'police' : 'player', sex, 'mild');
  if (!police) {
    Object.assign(look, {
      top: o.longSleeves ? 'longsleeve' : 'tee', topColor: o.top,
      bottom: o.shorts ? 'shorts' : 'jeans', bottomColor: o.bottom,
      shoes: 'sneaker', shoeColor: o.shoes, soleColor: '#e6e4de',
    } satisfies Partial<Look>);
  }
  if (o.skin) look.skin = o.skin;
  if (o.hair) look.hairColor = o.hair;
  if (o.hairStyle) look.hair = o.hairStyle === 'none' ? 'buzz' : o.hairStyle;
  return Object.assign(look, o.look ?? {});
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

function findParts(root: THREE.Object3D) {
  let body: THREE.SkinnedMesh | null = null, brows: THREE.SkinnedMesh | null = null, eyes: THREE.SkinnedMesh | null = null;
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
    const n = mat?.name ?? '';
    if (/superhero|gt-person/i.test(n)) body = m;
    else if (/eye/i.test(n)) eyes = m;
    else if (/hair/i.test(n)) brows = m;
  });
  return { body: body as THREE.SkinnedMesh | null, brows: brows as THREE.SkinnedMesh | null, eyes: eyes as THREE.SkinnedMesh | null };
}

function baseFor(body: THREE.SkinnedMesh, brows: THREE.SkinnedMesh | null, eyes: THREE.SkinnedMesh | null): Base | null {
  const known = GEO_BASE.get(body.geometry) ?? BASES.get(body.geometry);
  if (known) return known;
  const n = ((body.material as THREE.Material).name ?? '').toLowerCase();
  if (!/superhero/.test(n)) return null;
  const sex: 'm' | 'f' = /female/.test(n) ? 'f' : 'm';
  const base = analyze(body, brows, eyes, sex);
  BASES.set(body.geometry, base);
  BASE_BY_SEX[sex] ??= base;
  return base;
}

/**
 * Dress a freshly loaded UBC character scene in place (library templates; then SkeletonUtils.clone it).
 * Replaces the body with the merged person geometry + material; hides the separate eye/brow meshes.
 */
export function dressCharacter(root: THREE.Object3D, o: Outfit, x: DressExtras = {}): void {
  const { body, brows, eyes } = findParts(root);
  if (!body) return;
  const base = baseFor(body, brows, eyes);
  if (!base) return;
  if (x.hair) {
    const style = o.hairStyle === 'long' || (!o.hairStyle && base.sex === 'f') ? 'long' : 'short';
    if (!HAIR_SRC[style]) HAIR_SRC[style] = x.hair;
  }
  if (x.normalMap && !MAPS[base.sex].normal) MAPS[base.sex].normal = x.normalMap;
  if (x.roughnessMap && !MAPS[base.sex].rough) MAPS[base.sex].rough = x.roughnessMap;
  applyPerson(root, body, base, outfitToLook(o, base.sex), false);
}

export interface PersonalizeOptions {
  kind: PersonKind;
  seed: number;
  warmth?: Warmth;
  /** Overrides on top of the seeded look. */
  look?: Partial<Look>;
  /** Scale the model to the look's height (default true). */
  applyHeight?: boolean;
}

/** Give a (cloned) dressed character a seeded individual look: build, height, face, hair, outfit. */
export function personalize(model: THREE.Object3D, opts: PersonalizeOptions): Look | null {
  const { body, brows, eyes } = findParts(model);
  if (!body) return null;
  const base = baseFor(body, brows, eyes);
  if (!base) return null;
  const look = Object.assign(randomLook(opts.seed, opts.kind, base.sex, opts.warmth ?? 'mild'), opts.look ?? {});
  look.sex = base.sex;
  applyPerson(model, body, base, look, opts.applyHeight !== false);
  return look;
}

function applyPerson(root: THREE.Object3D, body: THREE.SkinnedMesh, base: Base, look: Look, applyHeight: boolean) {
  body.geometry = geometryFor(base, look.build);
  const u = makeUniforms(base);
  applyLook(u, base, look);
  body.material = personMaterial(base, u);
  body.material.userData.pzU = u;
  body.customDepthMaterial = personDepthMaterial(u);
  body.castShadow = true; body.receiveShadow = true;
  body.frustumCulled = false;
  body.userData.pzLook = { ...look };
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && m !== body) m.visible = false; // eyes + brows live in the merged body
  });
  setAccessories(root, body, base, look);
  if (applyHeight) root.scale.setScalar(look.height / base.L.height);
}
