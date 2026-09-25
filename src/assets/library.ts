// OWNER: assets agent. Asset library contract — other modules depend on these signatures.
// Textures are CC0 PBR sets in public/assets/textures/<id>/{color,normal,rough,ao}.jpg with real-world size in the manifest.
// See src/assets/manifest.ts for every id, and public/assets/LICENSES.json for sources (all CC0).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { TEXTURES, CORE_TEXTURES, FALLBACK_COLORS, MODELS, ENVIRONMENTS, SOUNDS, CHARACTER_CLIPS, type TextureMapKey, type TextureEntry } from './manifest';
import { dressCharacter } from './characters';
export type { Outfit } from './characters';

export { TEXTURES, MODELS, ENVIRONMENTS, SOUNDS, CHARACTER_CLIPS };

export interface TextureSetInfo {
  id: string;
  /** Real-world size of one texture tile in meters (for world-space UVs). */
  sizeM: number;
  maps: { map?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture; aoMap?: THREE.Texture; displacementMap?: THREE.Texture; alphaMap?: THREE.Texture };
  /** Average sRGB color of the color map (for LOD/impostors/flat fallback). */
  avg?: string;
  /** Color map is desaturated: tint fully controls hue. */
  tintable?: boolean;
}

/** Known texture set ids (extend as assets are added). */
export type TextureId =
  | 'asphalt' | 'asphalt-worn' | 'concrete-sidewalk' | 'concrete' | 'curb' | 'grass' | 'dirt' | 'gravel'
  | 'brick-red' | 'brick-brown' | 'brick-tan' | 'brick-painted' | 'stucco' | 'lap-siding' | 'board-batten'
  | 'stone' | 'sandstone' | 'metal-panel' | 'adobe' | 'wood-shingle' | 'plaster'
  | 'roof-asphalt-shingle' | 'roof-clay-tile' | 'roof-standing-seam' | 'roof-slate' | 'roof-membrane' | 'roof-gravel'
  | 'paving' | 'cobble' | 'wood-planks' | 'rust-metal' | 'painted-metal' | 'bark' | 'water'
  // added by assets agent
  | 'asphalt-patched' | 'grass-dry' | 'leaves-ground' | 'brick-white' | 'brick-old' | 'cmu-block' | 'concrete-precast'
  | 'corrugated-metal' | 'metal-shutter' | 'tiles-terracotta'
  | 'forest-floor' | 'alpine-rock' | 'desert-sand' | 'coastal-sand' | 'snow';

/** Alpha-masked decal ids (use decalMaterial). */
export type DecalId = 'decal-leak-1' | 'decal-leak-2' | 'decal-cracks' | 'decal-manhole' | 'decal-manhole-2' | 'decal-graffiti' | 'decal-gum'
  | 'decal-puddle' | 'decal-paint-splat' | 'decal-oil';

export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}

// ---------------------------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------------------------

const texLoader = new THREE.TextureLoader();
let maxAnisotropy = 8;
/** Every texture the library created (so setAnisotropy can update them). */
const allTextures = new Set<THREE.Texture>();
/** url → base texture (shared GPU source). */
const baseTex = new Map<string, THREE.Texture>();
/** url → load promise. */
const texPromise = new Map<string, Promise<THREE.Texture>>();

const NEUTRAL: Record<TextureMapKey, string> = { color: '#ffffff', normal: '#8080ff', rough: '#ffffff', ao: '#ffffff', opacity: '#ffffff' };

function neutralImage(hex: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex; ctx.fillRect(0, 0, 4, 4);
  return c;
}

function configure(t: THREE.Texture, srgb: boolean): THREE.Texture {
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = maxAnisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  allTextures.add(t);
  return t;
}

/** Load (cached) a texture by asset-relative path. Returns immediately; image fills in async. Missing files → neutral 4x4. */
function loadTex(rel: string, key: TextureMapKey): THREE.Texture {
  const url = assetUrl(rel);
  let t = baseTex.get(url);
  if (t) return t;
  let resolve!: (t: THREE.Texture) => void;
  texPromise.set(url, new Promise((r) => (resolve = r)));
  t = texLoader.load(url, (tt) => resolve(tt), undefined, () => {
    console.warn(`[assets] missing texture ${rel}; using neutral`);
    t!.image = neutralImage(NEUTRAL[key]);
    t!.needsUpdate = true;
    resolve(t!);
  });
  configure(t, key === 'color');
  baseTex.set(url, t);
  return t;
}

function whenLoaded(t: THREE.Texture): Promise<THREE.Texture> {
  for (const [url, bt] of baseTex) if (bt === t || bt.source === t.source) return texPromise.get(url)!;
  return Promise.resolve(t);
}

const setCache = new Map<string, TextureSetInfo>();

function entry(id: string): TextureEntry | undefined {
  return TEXTURES[id];
}

function buildSet(id: string, e: TextureEntry, variant?: 'facade'): TextureSetInfo {
  const has = (k: TextureMapKey) => e.maps.includes(k);
  const rep = 1 / e.sizeM;
  const mk = (k: TextureMapKey) => {
    const t = loadTex(`textures/${id}/${variant ? 'facade-' : ''}${k}.jpg`, k);
    t.repeat.set(rep, rep);
    return t;
  };
  return {
    id, sizeM: e.sizeM, avg: e.avg, tintable: e.tintable,
    maps: {
      map: has('color') ? mk('color') : undefined,
      normalMap: has('normal') ? mk('normal') : undefined,
      roughnessMap: has('rough') ? mk('rough') : undefined,
      aoMap: has('ao') ? mk('ao') : undefined,
      alphaMap: has('opacity') ? mk('opacity') : undefined,
    },
  };
}

/** Texture set by id, or null if unavailable (callers must fall back to flat color). Textures stream in if not preloaded. */
export function textureSet(id: TextureId | DecalId | string, variant?: 'facade'): TextureSetInfo | null {
  const key = variant ? `${id}:${variant}` : id;
  const cached = setCache.get(key);
  if (cached) return cached;
  const e = entry(id);
  if (!e) return null;
  const s = buildSet(id, e, variant);
  setCache.set(key, s);
  return s;
}

/** Real-world tile size (m) of a texture set, or 2 if unknown. */
export function textureSizeM(id: string): number {
  return entry(id)?.sizeM ?? 2;
}

/** Average color of a texture set (sRGB hex) — for distant LOD / flat-shaded instances. */
export function textureAvgColor(id: string): string {
  return entry(id)?.avg ?? FALLBACK_COLORS[id] ?? '#888888';
}

/** Promise resolving when all maps of the set have loaded (or failed to neutral). */
export async function textureSetReady(id: string, variant?: 'facade'): Promise<TextureSetInfo | null> {
  const s = textureSet(id, variant);
  if (!s) return null;
  await Promise.all(Object.values(s.maps).filter(Boolean).map((t) => whenLoaded(t!)));
  return s;
}

/** Hook for render: apply renderer.capabilities.getMaxAnisotropy() to all library textures. */
export function setAnisotropy(n: number): void {
  maxAnisotropy = n;
  for (const t of allTextures) {
    if (t.anisotropy !== n) { t.anisotropy = n; t.needsUpdate = t.image != null; }
  }
}

/** Load an arbitrary image under public/assets as a configured texture (e.g. 'fx/lens-dirt.jpg'). */
export function imageTexture(rel: string, opts: { srgb?: boolean; repeat?: boolean } = {}): THREE.Texture {
  const t = loadTex(rel, opts.srgb === false ? 'rough' : 'color');
  if (opts.repeat === false) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
  return t;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

export interface PbrOptions {
  /** Multiplies the color map (sRGB hex/css). For `tintable` sets this is effectively the paint color. */
  tint?: string;
  /** Roughness multiplier on the roughness map (default 1), or absolute roughness when no map. */
  roughness?: number;
  metalness?: number;
  /** Normal strength (default 1). */
  normalScale?: number;
  /** AO map intensity (default 1). */
  aoIntensity?: number;
  /** Extra UV scale on top of meters (e.g. 0.5 → texture twice as large). Default 1. */
  uvScale?: number;
  /** Emissive color (e.g. lit signage); defaults none. */
  emissive?: string;
  emissiveIntensity?: number;
  side?: THREE.Side;
  /** Env map intensity (default 1). */
  envMapIntensity?: number;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();

const DEFAULT_ROUGH: Record<string, number> = { 'roof-standing-seam': 0.55, 'painted-metal': 0.6, 'metal-panel': 0.7, 'metal-shutter': 0.7, water: 0.05 };
const DEFAULT_METAL: Record<string, number> = { 'roof-standing-seam': 0.6, 'metal-panel': 0.5, 'corrugated-metal': 0.4, 'metal-shutter': 0.3, 'painted-metal': 0.2, 'rust-metal': 0.2 };

/**
 * Shared PBR material for a texture set. Callers must generate UVs in METERS; the material's
 * texture repeat is already scaled by 1/sizeM so UV (1,1) = 1 m. `tint` multiplies color.
 * Materials are cached per (id, options) — do not mutate returned materials (clone first).
 */
export function pbrMaterial(id: TextureId | string, opts: PbrOptions = {}): THREE.MeshStandardMaterial {
  const key = `${id}|${opts.tint ?? ''}|${opts.roughness ?? ''}|${opts.metalness ?? ''}|${opts.normalScale ?? ''}|${opts.aoIntensity ?? ''}|${opts.uvScale ?? ''}|${opts.emissive ?? ''}|${opts.emissiveIntensity ?? ''}|${opts.side ?? ''}|${opts.envMapIntensity ?? ''}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const set = textureSet(id);
  const mat = new THREE.MeshStandardMaterial({
    color: opts.tint ?? (set ? '#ffffff' : FALLBACK_COLORS[id] ?? '#999999'),
    roughness: opts.roughness ?? (set?.maps.roughnessMap ? 1 : DEFAULT_ROUGH[id] ?? 0.9),
    metalness: opts.metalness ?? DEFAULT_METAL[id] ?? 0,
    side: opts.side ?? THREE.FrontSide,
    envMapIntensity: opts.envMapIntensity ?? 1,
  });
  mat.name = `pbr:${id}`;
  if (set) {
    const scale = opts.uvScale ?? 1;
    const pick = (t?: THREE.Texture) => {
      if (!t) return null;
      if (scale === 1) return t;
      const c = t.clone(); // shares Source → single GPU upload
      c.repeat.set(scale / set.sizeM, scale / set.sizeM);
      allTextures.add(c);
      whenLoaded(t).then(() => { c.needsUpdate = true; });
      return c;
    };
    mat.map = pick(set.maps.map);
    mat.normalMap = pick(set.maps.normalMap);
    mat.roughnessMap = pick(set.maps.roughnessMap);
    mat.aoMap = pick(set.maps.aoMap);
    if (mat.normalMap) mat.normalScale.setScalar(opts.normalScale ?? 1);
    mat.aoMapIntensity = opts.aoIntensity ?? 1;
  }
  if (opts.emissive) { mat.emissive.set(opts.emissive); mat.emissiveIntensity = opts.emissiveIntensity ?? 1; }
  matCache.set(key, mat);
  return mat;
}

/**
 * Decal material (alpha-masked, polygonOffset, no depth write). Use on a quad slightly above the surface
 * or with three's DecalGeometry. UVs are 0..1 over the decal (not meters). Cached per (id, tint, opacity).
 */
export function decalMaterial(id: DecalId | string, opts: { tint?: string; opacity?: number; roughness?: number } = {}): THREE.MeshStandardMaterial {
  const key = `decal|${id}|${opts.tint ?? ''}|${opts.opacity ?? ''}|${opts.roughness ?? ''}`;
  const hit = matCache.get(key);
  if (hit) return hit;
  const mat = new THREE.MeshStandardMaterial({
    color: opts.tint ?? '#ffffff', transparent: true, opacity: opts.opacity ?? 1, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: opts.roughness ?? 1,
  });
  mat.name = `decal:${id}`;
  const e = entry(id);
  if (e) {
    const one = (k: TextureMapKey) => {
      if (!e.maps.includes(k)) return null;
      const base = loadTex(`textures/${id}/${k}.jpg`, k);
      const c = base.clone(); c.repeat.set(1, 1); c.wrapS = c.wrapT = THREE.ClampToEdgeWrapping;
      allTextures.add(c); whenLoaded(base).then(() => { c.needsUpdate = true; });
      return c;
    };
    mat.map = one('color'); mat.normalMap = one('normal'); mat.roughnessMap = one('rough'); mat.alphaMap = one('opacity');
    if (!mat.alphaMap) mat.alphaMap = null;
  }
  matCache.set(key, mat);
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Preload
// ---------------------------------------------------------------------------------------------

let preloadPromise: Promise<void> | null = null;

/** Load everything needed to start (called by world before building). Loads core texture sets in parallel. */
export function preloadLibrary(onProgress?: (f: number) => void, extra: string[] = []): Promise<void> {
  if (preloadPromise && !extra.length) { onProgress?.(1); return preloadPromise; }
  const ids = [...new Set([...CORE_TEXTURES, ...extra])].filter((id) => entry(id));
  const texs: THREE.Texture[] = [];
  for (const id of ids) {
    const s = textureSet(id);
    if (s) for (const t of Object.values(s.maps)) if (t) texs.push(t);
  }
  let done = 0;
  onProgress?.(0);
  const p = Promise.all(texs.map((t) => whenLoaded(t).then(() => onProgress?.(++done / texs.length)))).then(() => undefined);
  if (!extra.length) preloadPromise = p;
  return p;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

const gltfLoader = new GLTFLoader();
/** path → raw glTF (shared). */
const rawCache = new Map<string, Promise<GLTF | null>>();
/** id → prepared template (scaled, tinted, dressed) + clips. */
const templCache = new Map<string, Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null>>();

function loadRaw(path: string): Promise<GLTF | null> {
  let p = rawCache.get(path);
  if (!p) {
    p = gltfLoader.loadAsync(assetUrl(path)).catch((err) => { console.warn(`[assets] model ${path} failed`, err); return null; });
    rawCache.set(path, p);
  }
  return p;
}

function loadTemplate(id: string) {
  const e = MODELS[id];
  if (!e) return Promise.resolve(null);
  let p = templCache.get(id);
  if (!p) {
    const hairScenes: Record<string, GLTF | null> = {};
    const hairP = e.outfit ? Promise.all([loadRaw('models/characters/hair-short.gltf'), loadRaw('models/characters/hair-long.gltf')])
      .then(([hs, hl]) => { hairScenes.short = hs; hairScenes.long = hl; }) : Promise.resolve();
    p = Promise.all([loadRaw(e.path), e.anims ? loadRaw(e.anims) : Promise.resolve(null), hairP]).then(([g, a]) => {
      if (!g) return null;
      const root = SkeletonUtils.clone(g.scene);
      if (e.scale && e.scale !== 1) root.scale.setScalar(e.scale);
      if (e.rotY) root.rotation.y = e.rotY;
      if (e.outfit) {
        const female = e.path.includes('female');
        const style = e.outfit.hairStyle ?? (female ? 'long' : 'short');
        const hairG = style === 'none' ? null : hairScenes[style];
        const base = female ? 'models/characters/ubc-female' : 'models/characters/ubc-male';
        dressCharacter(root, e.outfit, {
          hair: hairG?.scene ?? null,
          normalMap: charMap(`${base}-normal.jpg`, false),
          roughnessMap: charMap(`${base}-rough.jpg`, false),
        });
      }
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true; m.receiveShadow = true;
        if ((m as THREE.SkinnedMesh).isSkinnedMesh) m.frustumCulled = false;
        if (e.tint) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          const out = mats.map((mat) => {
            for (const [sub, col] of Object.entries(e.tint!)) {
              if (mat.name.toLowerCase().includes(sub.toLowerCase())) {
                const c = (mat as THREE.MeshStandardMaterial).clone(); c.color.set(col); return c;
              }
            }
            return mat;
          });
          m.material = Array.isArray(m.material) ? out : out[0];
        }
      });
      root.name = `model:${id}`;
      return { scene: root, animations: [...g.animations, ...(a?.animations ?? [])] };
    });
    templCache.set(id, p);
  }
  return p;
}

function charMap(rel: string, srgb: boolean): THREE.Texture {
  const t = loadTex(rel, srgb ? 'color' : 'rough');
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.flipY = false; // glTF UV convention
  return t;
}

/** Load a CC0 glTF model by manifest id (e.g. 'character-ped-1', 'character-police'). Returns a fresh clone (skeleton-safe; geometry/materials shared). */
export async function loadModel(id: string): Promise<THREE.Group | null> {
  const t = await loadTemplate(id);
  if (!t) return null;
  const wrap = new THREE.Group();
  wrap.name = id;
  wrap.add(SkeletonUtils.clone(t.scene));
  return wrap;
}

/**
 * Model + its animation clips. `clips` maps semantic names ('idle','walk','run','kneelWork',... see CHARACTER_CLIPS)
 * to AnimationClips; `animations` is the raw list. Create a THREE.AnimationMixer(scene) per instance.
 */
export async function loadModelWithAnimations(id: string): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[]; clips: Record<string, THREE.AnimationClip> } | null> {
  const t = await loadTemplate(id);
  if (!t) return null;
  const scene = new THREE.Group();
  scene.name = id;
  scene.add(SkeletonUtils.clone(t.scene));
  const clips: Record<string, THREE.AnimationClip> = {};
  for (const [sem, real] of Object.entries(MODELS[id].clips ?? {})) {
    const c = t.animations.find((a) => a.name === real);
    if (c) clips[sem] = c;
  }
  return { scene, animations: t.animations, clips };
}

/** Preload (and prepare) model templates so later loadModel calls resolve immediately. */
export function preloadModels(ids: string[]): Promise<void> {
  return Promise.all(ids.map(loadTemplate)).then(() => undefined);
}

/** Model ids by kind / tag (e.g. modelIds('character', 'civilian')). */
export function modelIds(kind?: 'character' | 'vehicle' | 'prop', tag?: string): string[] {
  return Object.entries(MODELS).filter(([, e]) => (!kind || e.kind === kind) && (!tag || e.tags?.includes(tag))).map(([k]) => k);
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

const hdrLoader = new HDRLoader();
const envCache = new Map<string, Promise<THREE.Texture | null>>();

/** Equirect HDR environment for IBL/background by id ('day', 'sunset', 'overcast', 'night'). Render does PMREM. */
export function loadEnvironment(id: string): Promise<THREE.Texture | null> {
  const e = ENVIRONMENTS[id];
  if (!e) return Promise.resolve(null);
  let p = envCache.get(id);
  if (!p) {
    p = hdrLoader.loadAsync(assetUrl(e.path)).then((t) => {
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.name = `env:${id}`;
      return t as THREE.Texture;
    }).catch((err) => { console.warn(`[assets] env ${id} failed`, err); return null; });
    envCache.set(id, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

/** URL of an audio asset by id, or null. For ids with variants, returns a random variant (or `variant` index). */
export function soundUrl(id: string, variant?: number): string | null {
  const list = SOUNDS[id];
  if (!list || !list.length) return null;
  const i = variant === undefined ? Math.floor(Math.random() * list.length) : ((variant % list.length) + list.length) % list.length;
  return assetUrl(list[i]);
}

/** All variant URLs for a sound id (e.g. footsteps). */
export function soundUrls(id: string): string[] {
  return (SOUNDS[id] ?? []).map(assetUrl);
}

// ---------------------------------------------------------------------------------------------
// Atlases
// ---------------------------------------------------------------------------------------------

/** Atlas grid of decal sets that pack several variants (e.g. 'decal-graffiti' = 4x4 tags). */
export const DECAL_ATLAS: Record<string, { cols: number; rows: number }> = { 'decal-graffiti': { cols: 4, rows: 4 } };

/**
 * UV sub-rectangle [u0, v0, u1, v1] of variant `index` in an atlas decal (row-major from top-left).
 * Remap a quad's 0..1 UVs into this rect; decalMaterial textures use ClampToEdge so no bleeding across tiles.
 */
export function decalAtlasRect(id: string, index: number): [number, number, number, number] {
  const a = DECAL_ATLAS[id];
  if (!a) return [0, 0, 1, 1];
  const i = ((index % (a.cols * a.rows)) + a.cols * a.rows) % (a.cols * a.rows);
  const c = i % a.cols, r = Math.floor(i / a.cols);
  const inset = 0.004;
  return [c / a.cols + inset, 1 - (r + 1) / a.rows + inset, (c + 1) / a.cols - inset, 1 - r / a.rows - inset];
}

/** Lens-dirt texture for bloom (dark with soft smudges, sRGB). */
export function lensDirtTexture(): THREE.Texture {
  return imageTexture('fx/lens-dirt.jpg', { repeat: false });
}
