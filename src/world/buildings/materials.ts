// Building materials: facade/roof PBR (asset library or procedural fallback), trims, metals, fabric,
// signage, and the window glass with interior mapping + night occupancy.
import * as THREE from 'three';
import { textureSet, textureSetReady, type TextureId } from '../../assets/library';
import { procTexture, TEX_RES } from './textures';
import { SHOP_GLSL } from './shopGlsl';

/** Shared uniforms: night factor drives window occupancy and signage glow. */
export const U = {
  uNight: { value: 0 },
  /** Interior daylight brightness multiplier (tuned against the sun/hemisphere levels). */
  uInteriorDay: { value: 0.38 },
  /** Night lamp intensity. */
  uLamp: { value: 0.45 }, // look-dev: 0.75 clipped storefronts/windows at night exposure
  /** Scale of the env-map reflection on clear glass. */
  uGlassEnv: { value: 1.0 },
  /** debug: 0 off, 1 interior only, 2 reflection only, 3 fresnel */
  uGDbg: { value: 0 },
};
(globalThis as unknown as { __bldgU: typeof U }).__bldgU = U;

/** GLSL: cheap hash noise used for grime streaks. */
const NOISE_GLSL = /* glsl */ `
float bh21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float bvn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(bh21(i), bh21(i+vec2(1,0)), f.x), mix(bh21(i+vec2(0,1)), bh21(i+vec2(1,1)), f.x), f.y); }
`;

// ---------------------------------------------------------------------------------------------
// Surface layers: every opaque building surface (walls, roofs, trims, metal, fabric) shares ONE
// MeshStandardMaterial that samples a DataArrayTexture by a per-vertex layer index. This keeps the
// draw calls per chunk at ~3 (surface, glass, signs) regardless of how many materials are used.
// ---------------------------------------------------------------------------------------------
export const LAYER_IDS = [
  'brick-red', 'brick-brown', 'brick-tan', 'brick-painted', 'stucco', 'lap-siding', 'board-batten', 'stone', 'sandstone',
  'concrete', 'glass-curtain', 'metal-panel', 'adobe', 'wood-shingle', 'plaster',
  'roof-asphalt-shingle', 'roof-clay-tile', 'roof-standing-seam', 'roof-slate', 'roof-membrane', 'roof-gravel',
  'paint', 'fabric', 'metal', 'concrete-plain', 'wood-planks', 'dark', 'trim-stone',
  // overlays / atlases (canvas-generated): faded painted wall signs (alpha = paint), address plaques
  'ghost', 'plaque',
] as const;
export type LayerId = (typeof LAYER_IDS)[number];

/** Per-layer weathering strength (walls get streaks, trims little). */
const GRIME: Partial<Record<LayerId, number>> = {
  'brick-red': 0.22, 'brick-brown': 0.2, 'brick-tan': 0.24, 'brick-painted': 0.22, stucco: 0.3, 'lap-siding': 0.16,
  'board-batten': 0.16, stone: 0.26, sandstone: 0.26, concrete: 0.32, 'metal-panel': 0.12, adobe: 0.2, 'wood-shingle': 0.12,
  plaster: 0.2, 'trim-stone': 0.18, 'roof-membrane': 0.25, 'roof-asphalt-shingle': 0.1, paint: 0.05, 'concrete-plain': 0.28,
};
/** Corrections for library tile sizes that measure wrong against their brick/shingle modules. */
const SIZE_FIX: Record<string, number> = { 'brick-tan': 1.35, 'roof-asphalt-shingle': 5.0 };
const NO_LIB = new Set(['trim-stone', 'paint', 'fabric', 'metal', 'dark', 'concrete-plain', 'glass-curtain', 'ghost', 'plaque']);
/** Normal-map strength per layer (mortar joints / stone relief read at street level). */
const NRM: Partial<Record<LayerId, number>> = {
  'brick-red': 1.7, 'brick-brown': 1.7, 'brick-tan': 1.6, 'brick-painted': 1.4, stone: 1.5, sandstone: 1.5, 'trim-stone': 1.2,
  stucco: 1.3, adobe: 1.3, 'lap-siding': 1.3, 'board-batten': 1.3, 'wood-shingle': 1.3,
};
/** Index offset in aLayer marking a painted-sign overlay quad (base layer + OVERLAY). */
export const OVERLAY = 64;

const GHOST_TEXTS = [
  ['GENERAL MERCHANDISE', '#e9dfc6', '#5a2b22'], ['HOTEL · ROOMS', '#f1e8d2', null], ['HARDWARE & FEED', '#1f1d1a', '#d9cfb4'], ['DRY GOODS · NOTIONS', '#efe3c4', '#2b3a4a'],
] as const;
/** Ghost-sign atlas: 4 rows (4:1 cells) of weathered painted lettering; alpha = paint coverage. */
function ghostCanvas(R: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = R;
  const x = c.getContext('2d')!;
  const H = R / 4;
  GHOST_TEXTS.forEach(([t, fg, bg], i) => {
    const y = i * H;
    if (bg) { x.fillStyle = bg; x.fillRect(4, y + 4, R - 8, H - 8); }
    x.fillStyle = fg; x.strokeStyle = fg;
    let size = H * 0.55;
    x.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    while (x.measureText(t).width > R - 30 && size > 8) { size -= 2; x.font = `700 ${size}px Georgia, "Times New Roman", serif`; }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(t, R / 2, y + H / 2 + 2);
    if (!bg) { x.lineWidth = 3; x.strokeRect(10, y + 10, R - 20, H - 20); }
  });
  // weathering: flaking paint + fade toward the bottom of each panel
  const d = x.getImageData(0, 0, R, R);
  let s = 1234567;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const flake = new Float32Array((R / 8) * (R / 8)).map(() => rnd());
  for (let py = 0; py < R; py++) for (let px = 0; px < R; px++) {
    const i = (py * R + px) * 4;
    const f = flake[(py >> 3) * (R / 8) + (px >> 3)];
    const n = 0.55 + 0.45 * rnd();
    const k = f < 0.18 ? 0.15 : n * (0.7 + 0.3 * f);
    d.data[i + 3] = Math.round(d.data[i + 3] * k * 0.8);
  }
  x.putImageData(d, 0, 0);
  return c;
}
/** Address-plaque atlas: 4x4 cells of house numbers on enamel / brass / black plates. */
function plaqueCanvas(R: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = R;
  const x = c.getContext('2d')!;
  const S = R / 4;
  const styles = [['#1e2430', '#f2efe6'], ['#b08d4a', '#2a2116'], ['#f1eee6', '#1a1a1a'], ['#2a2a2a', '#d9c690']];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const k = j * 4 + i;
    const [bg, fg] = styles[k % 4];
    x.fillStyle = bg; x.fillRect(i * S, j * S, S, S);
    x.strokeStyle = fg; x.lineWidth = 3; x.strokeRect(i * S + 6, j * S + 6, S - 12, S - 12);
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `700 ${S * 0.42}px "Helvetica Neue", Arial, sans-serif`;
    x.fillText(String([1024, 1138, 207, 1845, 316, 2210, 1419, 88, 1307, 942, 1650, 511, 2034, 1273, 64, 1911][k]), i * S + S / 2, j * S + S / 2 + 2);
  }
  return c;
}
function flatNormal(R: number): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = R;
  const x = c.getContext('2d')!; x.fillStyle = 'rgb(128,128,255)'; x.fillRect(0, 0, R, R);
  return c;
}

export interface LayerInfo { index: number; base: THREE.Color; sizeM: number; rough: number; metal: number }
const layers = new Map<string, LayerInfo>();
let surfaceMat: THREE.MeshStandardMaterial | null = null;
/** true when at least one layer came from the asset library */
export let usingLibraryTextures = false;

function drawToCanvas(img: unknown, res: number): HTMLCanvasElement | null {
  const im = img as (CanvasImageSource & { width?: number }) | undefined;
  if (!im || ((im as { width?: number }).width ?? 0) < 64) return null;
  try {
    const c = document.createElement('canvas'); c.width = c.height = res;
    c.getContext('2d')!.drawImage(im, 0, 0, res, res);
    return c;
  } catch { return null; }
}

function averageOf(c: HTMLCanvasElement): THREE.Color {
  const x = document.createElement('canvas'); x.width = x.height = 8;
  const g = x.getContext('2d')!; g.drawImage(c, 0, 0, 8, 8);
  const d = g.getImageData(0, 0, 8, 8).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < 64; i++) { r += d[i * 4]; gg += d[i * 4 + 1]; b += d[i * 4 + 2]; }
  return new THREE.Color().setRGB(r / 64 / 255, gg / 64 / 255, b / 64 / 255, THREE.SRGBColorSpace);
}

/** Wait (bounded) for the library texture sets used by the building layers to finish loading. */
export async function prepareBuildingTextures(timeoutMs = 10000): Promise<void> {
  if (surfaceMat) return;
  const ids: string[] = LAYER_IDS.filter((id) => !NO_LIB.has(id));
  ids.push('decal-leak-2');
  const all = Promise.all(ids.map((id) => textureSetReady(id).catch(() => null)));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}

/** Build (once) the layer texture arrays and the shared surface material. */
export function surfaceMaterial(): THREE.MeshStandardMaterial {
  if (surfaceMat) return surfaceMat;
  const R = TEX_RES, N = LAYER_IDS.length;
  const alb = new Uint8Array(R * R * 4 * N), nrm = new Uint8Array(R * R * 4 * N);
  const scale: number[] = [], rough: number[] = [], metal: number[] = [], grime: number[] = [], nstr: number[] = [];
  LAYER_IDS.forEach((id, li) => {
    let a: HTMLCanvasElement | null = null, n: HTMLCanvasElement | null = null;
    let sizeM = 2, rgh = 0.85, mtl = 0;
    let lib = null;
    try { lib = NO_LIB.has(id) ? null : textureSet(id as TextureId); } catch { lib = null; }
    if (lib?.maps.map?.image) {
      a = drawToCanvas(lib.maps.map.image, R);
      if (a) {
        usingLibraryTextures = true;
        n = lib.maps.normalMap?.image ? drawToCanvas(lib.maps.normalMap.image, R) : null;
        sizeM = SIZE_FIX[id] ?? (lib.sizeM || 2);
        const pt = procTexture(id);
        rgh = pt.roughness; mtl = pt.metalness;
        if (!n) n = pt.nrm;
      }
    }
    if (id === 'ghost' || id === 'plaque') {
      a = id === 'ghost' ? ghostCanvas(R) : plaqueCanvas(R); n = flatNormal(R); sizeM = 1; rgh = id === 'ghost' ? 0.9 : 0.45; mtl = 0;
    }
    if (!a) {
      const pt = procTexture(id);
      a = pt.alb; n = pt.nrm; sizeM = pt.sizeM; rgh = pt.roughness; mtl = pt.metalness;
    }
    const base = averageOf(a);
    const da = a.getContext('2d')!.getImageData(0, 0, R, R).data;
    const dn = n!.getContext('2d')!.getImageData(0, 0, R, R).data;
    // canvas row 0 = top = v 1 → flip rows into the data texture
    const off = li * R * R * 4;
    for (let y = 0; y < R; y++) {
      const src = y * R * 4, dst = off + (R - 1 - y) * R * 4;
      alb.set(da.subarray(src, src + R * 4), dst);
      nrm.set(dn.subarray(src, src + R * 4), dst);
    }
    scale.push(sizeM); rough.push(rgh); metal.push(mtl); grime.push(GRIME[id] ?? 0); nstr.push(NRM[id] ?? 1);
    layers.set(id, { index: li, base, sizeM, rough: rgh, metal: mtl });
  });
  const mk = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataArrayTexture(data, R, R, N);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const texA = mk(alb, true), texN = mk(nrm, false);
  // dummy 1x1 maps so three enables the USE_MAP / USE_NORMALMAP code paths (we swap the samplers)
  const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  dummy.needsUpdate = true;
  const dummyN = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  dummyN.needsUpdate = true;
  // rain-streak mask (CC0 leak decal opacity), tiled horizontally; flat fallback = procedural only
  let streak: THREE.Texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  streak.needsUpdate = true;
  let hasStreak = 0;
  try {
    const ls = textureSet('decal-leak-2' as TextureId);
    const img = ls?.maps.alphaMap?.image as (HTMLImageElement & { width: number }) | undefined;
    if (ls?.maps.alphaMap && img && img.width > 0) {
      streak = ls.maps.alphaMap.clone();
      streak.wrapS = THREE.RepeatWrapping; streak.wrapT = THREE.ClampToEdgeWrapping;
      streak.repeat.set(1, 1); streak.colorSpace = THREE.NoColorSpace; streak.needsUpdate = true;
      hasStreak = 1;
    }
  } catch { /* procedural streaks only */ }
  const m = new THREE.MeshStandardMaterial({ map: dummy, normalMap: dummyN, vertexColors: true, roughness: 1, metalness: 0, name: 'bldg:surface' });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uAlbArr = { value: texA };
    sh.uniforms.uNrmArr = { value: texN };
    sh.uniforms.uLScale = { value: scale };
    sh.uniforms.uLRough = { value: rough };
    sh.uniforms.uLMetal = { value: metal };
    sh.uniforms.uLGrime = { value: grime };
    sh.uniforms.uLNrm = { value: nstr };
    sh.uniforms.uStreak = { value: streak };
    sh.uniforms.uHasStreak = { value: hasStreak };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLayer;\nattribute vec4 aWx;\nflat varying int vLayer;\nvarying vec4 vWx;\nvarying vec3 vBWPos;\nvarying vec3 vBWN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvLayer = int(aLayer + 0.5);\nvWx = aWx;\nvBWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvBWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uAlbArr;
uniform sampler2DArray uNrmArr;
uniform float uLScale[${N}];
uniform float uLRough[${N}];
uniform float uLMetal[${N}];
uniform float uLGrime[${N}];
uniform float uLNrm[${N}];
uniform sampler2D uStreak;
uniform float uHasStreak;
flat varying int vLayer;
varying vec4 vWx;
varying vec3 vBWPos;
varying vec3 vBWN;
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `
  int bL = vLayer >= ${OVERLAY} ? vLayer - ${OVERLAY} : vLayer;
  vec4 bTex = texture(uAlbArr, vec3(vMapUv / uLScale[bL], float(bL)));
  if (vLayer >= ${OVERLAY}) { // faded painted sign over the wall texture
    vec4 gp = texture(uAlbArr, vec3(vWx.zw, ${LAYER_IDS.indexOf('ghost')}.0));
    float lum = dot(bTex.rgb, vec3(0.3, 0.55, 0.15));
    bTex.rgb = mix(bTex.rgb, gp.rgb * (0.6 + 0.9 * lum), gp.a);
  }
  diffuseColor.rgb *= bTex.rgb;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    float gs = uLGrime[bL];
    if (gs > 0.0) {
      float along = dot(vBWPos.xz, vec2(-vBWN.z, vBWN.x));
      float vertical = 1.0 - abs(vBWN.y);
      float streak = bvn(vec2(along*2.3, vBWPos.y*0.18)) * bvn(vec2(along*7.1, vBWPos.y*0.05 + 3.0));
      float blotch = bvn(vBWPos.xz*0.11 + vBWPos.y*0.07);
      diffuseColor.rgb *= 1.0 - gs * (smoothstep(0.25, 0.8, streak) * 0.9 * vertical + blotch * 0.35);
      // macro tint variation (weathering / repointing / sun fade) at 5-15 m scale
      float mt = bvn(vBWPos.xz * 0.075 + vec2(vBWPos.y * 0.05, 7.3));
      diffuseColor.rgb *= mix(vec3(0.9, 0.9, 0.92), vec3(1.07, 1.04, 0.99), mt);
      // rain streaks under sills / cornices
      if (vWx.x > 0.001 && vWx.y < 1.8 && vertical > 0.5) {
        float sm = uHasStreak > 0.5 ? texture2D(uStreak, vec2(along / 2.6, 1.0 - vWx.y / 1.8)).r : smoothstep(0.3, 0.9, bvn(vec2(along * 9.0, vWx.y * 0.6))) * (1.0 - vWx.y / 1.8);
        diffuseColor.rgb *= 1.0 - min(1.0, gs * 2.6) * vWx.x * sm * vec3(0.5, 0.52, 0.55);
      }
    }
  }`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = uLRough[bL];')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = uLMetal[bL];')
      .replace('texture2D( normalMap, vNormalMapUv )', 'texture(uNrmArr, vec3(vNormalMapUv / uLScale[bL], float(bL)))')
      .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * uLNrm[bL];');
  };
  m.customProgramCacheKey = () => 'bldg-surface-v2';
  surfaceMat = m;
  return m;
}

export function layer(id: string): LayerInfo {
  if (!surfaceMat) surfaceMaterial();
  return layers.get(id) ?? layers.get('plaster')!;
}

/** Relative tint so that texture base × tint ≈ target color. Clamped to keep texture detail. */
export function relTint(target: THREE.Color, base: THREE.Color, strength = 1): [number, number, number] {
  const f = (t: number, b: number) => {
    const r = t / Math.max(b, 0.02);
    return Math.max(0.02, Math.min(3, 1 + (r - 1) * strength));
  };
  return [f(target.r, base.r), f(target.g, base.g), f(target.b, base.b)];
}

// ---------------------------------------------------------------------------------------------
// Signage atlas: canvas with generic business names; emissive at night.
// ---------------------------------------------------------------------------------------------
const SIGN_W = 512, SIGN_H = 96, ATLAS_W = 2048, ATLAS_H = 4096;
const COLS = ATLAS_W / SIGN_W, ROWS = Math.floor(ATLAS_H / SIGN_H);
let signCanvas: HTMLCanvasElement | null = null;
let signTex: THREE.CanvasTexture | null = null;
const signSlots = new Map<string, number>();
let signMat: THREE.MeshStandardMaterial | null = null;

const SIGN_STYLES = [
  { bg: '#1d2b24', fg: '#f3e9cf', font: '700 58px Georgia, "Times New Roman", serif', rule: true },
  { bg: '#7a1f1b', fg: '#fbf3e4', font: '700 56px "Helvetica Neue", Arial, sans-serif', rule: false },
  { bg: '#10243f', fg: '#e8d9a8', font: 'italic 700 58px Georgia, serif', rule: true },
  { bg: '#f1ece0', fg: '#24211d', font: '800 54px "Futura", "Avenir Next", "Helvetica Neue", sans-serif', rule: false },
  { bg: '#2d2d2d', fg: '#f2b33d', font: '700 56px "Gill Sans", "Trebuchet MS", sans-serif', rule: true },
  { bg: '#3e5a3c', fg: '#f5f0e0', font: '600 56px "Palatino", "Book Antiqua", serif', rule: false },
  { bg: '#e7dcc5', fg: '#5b2a1c', font: '700 58px "Baskerville", Georgia, serif', rule: true },
  { bg: '#101010', fg: '#ffffff', font: '300 60px "Helvetica Neue", Arial, sans-serif', rule: false },
];

/** Returns atlas UV rect [u0,v0,u1,v1] for a sign, drawing it on first use. */
export function signSlot(text: string, style: number): [number, number, number, number] {
  const key = text + '|' + style;
  let slot = signSlots.get(key);
  if (!signCanvas) {
    signCanvas = document.createElement('canvas');
    signCanvas.width = ATLAS_W; signCanvas.height = ATLAS_H;
    const x = signCanvas.getContext('2d')!;
    x.fillStyle = '#222'; x.fillRect(0, 0, ATLAS_W, ATLAS_H);
  }
  if (slot === undefined && signSlots.size >= COLS * ROWS) {
    // atlas full: reuse any slot with the same text, else a hashed slot
    for (const [k, v] of signSlots) if (k.startsWith(text + '|')) { slot = v; break; }
    if (slot === undefined) { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; slot = h % (COLS * ROWS); }
    const cx = (slot % COLS) * SIGN_W, cy = Math.floor(slot / COLS) * SIGN_H;
    return [cx / ATLAS_W, 1 - (cy + SIGN_H) / ATLAS_H, (cx + SIGN_W) / ATLAS_W, 1 - cy / ATLAS_H];
  }
  if (slot === undefined) {
    slot = signSlots.size;
    signSlots.set(key, slot);
    const cx = (slot % COLS) * SIGN_W, cy = Math.floor(slot / COLS) * SIGN_H;
    const x = signCanvas.getContext('2d')!;
    const st = SIGN_STYLES[style % SIGN_STYLES.length];
    x.save();
    x.beginPath(); x.rect(cx, cy, SIGN_W, SIGN_H); x.clip();
    x.fillStyle = st.bg; x.fillRect(cx, cy, SIGN_W, SIGN_H);
    // subtle panel gradient
    const gr = x.createLinearGradient(0, cy, 0, cy + SIGN_H);
    gr.addColorStop(0, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0.18)');
    x.fillStyle = gr; x.fillRect(cx, cy, SIGN_W, SIGN_H);
    x.fillStyle = st.fg; x.strokeStyle = st.fg;
    let font = st.font;
    x.font = font;
    let size = parseInt(font.match(/(\d+)px/)![1]);
    while (x.measureText(text).width > SIGN_W - 60 && size > 20) { size -= 2; font = font.replace(/\d+px/, size + 'px'); x.font = font; }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(text, cx + SIGN_W / 2, cy + SIGN_H / 2 + 3);
    if (st.rule) { x.lineWidth = 3; x.strokeRect(cx + 10, cy + 10, SIGN_W - 20, SIGN_H - 20); }
    x.restore();
    if (signTex) signTex.needsUpdate = true;
  }
  const cx = (slot % COLS) * SIGN_W, cy = Math.floor(slot / COLS) * SIGN_H;
  // CanvasTexture flipY → v = 1 - y/H
  return [cx / ATLAS_W, 1 - (cy + SIGN_H) / ATLAS_H, (cx + SIGN_W) / ATLAS_W, 1 - cy / ATLAS_H];
}

/** Atlas rect of a warm lamp-lens swatch (glows with the signs at night). */
export function lampSlot(): [number, number, number, number] {
  const key = '\u0000lamp';
  if (!signCanvas) signSlot('OPEN', 0);
  let slot = signSlots.get(key);
  if (slot === undefined) {
    slot = signSlots.size % (COLS * ROWS);
    signSlots.set(key, slot);
    const cx = (slot % COLS) * SIGN_W, cy = Math.floor(slot / COLS) * SIGN_H;
    const x = signCanvas!.getContext('2d')!;
    const gr = x.createRadialGradient(cx + SIGN_W / 2, cy + SIGN_H / 2, 4, cx + SIGN_W / 2, cy + SIGN_H / 2, SIGN_W / 2);
    gr.addColorStop(0, '#fff6dc'); gr.addColorStop(0.5, '#ffd99a'); gr.addColorStop(1, '#f0b060');
    x.fillStyle = gr; x.fillRect(cx, cy, SIGN_W, SIGN_H);
    if (signTex) signTex.needsUpdate = true;
  }
  const cx = (slot % COLS) * SIGN_W, cy = Math.floor(slot / COLS) * SIGN_H;
  return [(cx + 128) / ATLAS_W, 1 - (cy + SIGN_H - 20) / ATLAS_H, (cx + SIGN_W - 128) / ATLAS_W, 1 - (cy + 20) / ATLAS_H];
}

export function signMaterial(): THREE.MeshStandardMaterial {
  if (signMat) return signMat;
  if (!signCanvas) signSlot('OPEN', 0);
  signTex = new THREE.CanvasTexture(signCanvas!);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 8;
  signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: '#ffffff', emissiveIntensity: 0, roughness: 0.5, name: 'bldg:sign' });
  return signMat;
}
export function refreshSigns() { if (signTex) signTex.needsUpdate = true; }

// ---------------------------------------------------------------------------------------------
// Window glass with interior mapping.
// Attributes: aWin0 (window-local meters), aWinA (winW, winH, sillAboveFloor, floorH),
// aWinB (seed, kind+reflect, muntin, roomW). Vertex color = sash / muntin color.
// kinds: 0 residential, 1 office, 2 retail, 3 industrial, 4 spandrel, 5 parking, 6 lobby/civic
// muntin: 0 none, 1 one-over-one, 2 six-over-six, 3 craftsman 3/1, 4 two-over-two, 5 industrial grid,
//         6 casement pair, 7 storefront transom, 8 slider
// ---------------------------------------------------------------------------------------------
const WINDOW_GLSL = /* glsl */ `
uniform float uNight;
uniform float uGlassEnv;
uniform float uGDbg;
uniform float uInteriorDay;
uniform float uLamp;
varying vec2 vWin0;
varying vec4 vWinA;
varying vec4 vWinB;
varying vec3 vGWPos;
varying vec3 vGWN;
vec3 gDayIrr = vec3(0.3);
float gFixture = 0.0;
float wh1(float n){ return fract(sin(n*12.9898)*43758.5453); }
float wh2(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
float bar(float x, float c, float w){ float fw = max(fwidth(x), 1e-4); return 1.0 - smoothstep(w - fw, w + fw, abs(x - c)); }
float muntinMask(vec2 p, float W, float H, float m){
  float s = 0.0;
  float edge = min(min(p.x, W - p.x), min(p.y, H - p.y));
  float fw = max(fwidth(edge), 1e-4);
  s = 1.0 - smoothstep(0.035 - fw, 0.035 + fw, edge); // sash edge
  if (m < 0.5) return s * 0.6;
  if (m < 1.5 || (m > 1.5 && m < 4.5)) {
    s = max(s, bar(p.y, H*0.5, 0.035)); // meeting rail
  }
  if (m > 1.5 && m < 2.5) { // 6/6
    s = max(s, bar(p.x, W/3.0, 0.014)); s = max(s, bar(p.x, 2.0*W/3.0, 0.014));
    s = max(s, bar(p.y, H*0.25, 0.014)); s = max(s, bar(p.y, H*0.75, 0.014));
  } else if (m > 2.5 && m < 3.5) { // craftsman 3/1
    if (p.y > H*0.5) { s = max(s, bar(p.x, W/3.0, 0.016)); s = max(s, bar(p.x, 2.0*W/3.0, 0.016)); }
  } else if (m > 3.5 && m < 4.5) { // 2/2
    s = max(s, bar(p.x, W*0.5, 0.018));
  } else if (m > 4.5 && m < 5.5) { // industrial steel sash
    float nx = max(1.0, floor(W/0.45 + 0.5)), ny = max(1.0, floor(H/0.4 + 0.5));
    float gx = fract(p.x / W * nx), gy = fract(p.y / H * ny);
    float fx = fwidth(p.x / W * nx), fy = fwidth(p.y / H * ny);
    s = max(s, 1.0 - smoothstep(0.03, 0.03 + fx*1.5, min(gx, 1.0-gx)));
    s = max(s, 1.0 - smoothstep(0.035, 0.035 + fy*1.5, min(gy, 1.0-gy)));
  } else if (m > 5.5 && m < 6.5) { // casement pair
    s = max(s, bar(p.x, W*0.5, 0.03));
  } else if (m > 6.5 && m < 7.5) { // storefront transom bar
    s = max(s, bar(p.y, H - 0.55, 0.04));
  } else if (m > 7.5 && m < 8.5) { // slider
    s = max(s, bar(p.x, W*0.5, 0.03));
  } else if (m > 8.5) { // ribbon / curtain mullions every roomW
    float rw = max(vWinB.w, 0.5);
    float gx = fract(p.x / rw); float fx = fwidth(p.x / rw);
    s = max(s, 1.0 - smoothstep(0.025/rw, 0.025/rw + fx*1.5, min(gx, 1.0-gx)));
  }
  return s;
}
vec3 wallPalette(float h, float kind){
  if (kind > 0.5 && kind < 1.5) return mix(vec3(0.62,0.63,0.62), vec3(0.72,0.71,0.68), h);
  if (kind > 1.5 && kind < 2.5) return h < 0.35 ? vec3(0.62,0.60,0.56) : h < 0.7 ? vec3(0.42,0.33,0.26) : vec3(0.30,0.34,0.33);
  if (kind > 2.5 && kind < 3.5) return vec3(0.42,0.40,0.37);
  if (kind > 4.5 && kind < 5.5) return vec3(0.33,0.33,0.32);
  vec3 a = vec3(0.80,0.76,0.68), b = vec3(0.66,0.70,0.72), c = vec3(0.74,0.66,0.56), d = vec3(0.56,0.60,0.52);
  return h < 0.3 ? a : h < 0.55 ? b : h < 0.8 ? c : d;
}
// returns rgb interior radiance, a = solid mask (sash/muntin)
vec4 shadeWindow(vec3 V, vec3 N){
  float W = vWinA.x, H = vWinA.y, sill = vWinA.z, flH = max(vWinA.w, 2.4);
  float seed = vWinB.x;
  float kind = floor(vWinB.y + 0.001);
  float roomW = max(vWinB.w, 0.5);
  vec2 lp = vWin0;
  gFixture = 0.0;
  float solid = muntinMask(lp, W, H, vWinB.z);
  if (kind > 3.5 && kind < 4.5) return vec4(vec3(0.0), solid);
  vec3 T = normalize(vec3(N.z, 0.0, -N.x));
  vec3 d = vec3(dot(V, T), V.y, -dot(V, N));
  d.z = max(d.z, 0.03);
  if (kind > 1.5 && kind < 2.5) {
    float cat = floor(fract(vWinB.z + 0.001) * 20.0 + 0.001);
    return vec4(shadeShop(d, lp, W, H, sill, flH, seed, cat, vWinB.z < 0.5 ? 1.0 : 0.0), solid);
  }
  // room tiling along the facade
  float off = wh1(seed * 1.7) * roomW;
  float rxAll = lp.x + off;
  float ri = floor(rxAll / roomW);
  float rs = wh2(vec2(seed, ri));
  float rx = rxAll - ri * roomW;
  float ry = lp.y + sill;
  float D = kind > 4.5 && kind < 5.5 ? 14.0 : (kind > 0.5 && kind < 2.5 ? 7.0 : 4.0 + rs * 2.0);
  vec3 p = vec3(rx, ry, 0.0);
  float tx = d.x > 0.0 ? (roomW - rx) / max(d.x, 1e-4) : -rx / min(d.x, -1e-4);
  float ty = d.y > 0.0 ? (flH - ry) / max(d.y, 1e-4) : -ry / min(d.y, -1e-4);
  float tz = D / d.z;
  float t = min(tx, min(ty, tz));
  vec3 hp = p + d * t;
  vec3 wallC = wallPalette(rs, kind);
  vec3 col;
  float depthF = clamp(hp.z / D, 0.0, 1.0);
  if (t == ty) {
    if (d.y < 0.0) { // floor
      col = kind < 0.5 ? mix(vec3(0.36,0.24,0.15), vec3(0.45,0.42,0.40), step(0.6, rs)) : kind < 1.5 ? vec3(0.26,0.28,0.30) : kind > 4.5 && kind < 5.5 ? vec3(0.30,0.30,0.29) : mix(vec3(0.42,0.30,0.20), vec3(0.35,0.35,0.34), step(0.5, rs));
      if (kind < 0.5 && rs < 0.6) col *= 0.85 + 0.15 * step(0.5, fract(hp.x * 5.0)); // floor boards
    } else { // ceiling
      col = vec3(0.86);
      if (kind > 0.5 && kind < 2.5) { // ceiling grid + troffers
        vec2 g = fract(hp.xz / vec2(1.2, 1.2));
        col *= 0.93 + 0.07 * step(0.04, min(g.x, g.y));
        vec2 fx = fract(hp.xz / vec2(2.4, 2.4));
        gFixture = step(abs(fx.x - 0.5), 0.12) * step(abs(fx.y - 0.5), 0.25);
      }
    }
  } else if (t == tx) {
    col = wallC * 0.9;
    if (kind > 0.5 && kind < 1.5 && hp.y < 1.1) col *= 0.7;
    if (kind > 1.5 && kind < 2.5) { // wall shelving along the side walls
      float sh = step(fract(hp.y / 0.42), 0.78) * step(hp.y, 2.1) * step(0.4, hp.z);
      vec3 goods = vec3(wh2(vec2(floor(hp.z*2.5), floor(hp.y/0.42))), wh2(vec2(floor(hp.z*2.5)+5.0, floor(hp.y/0.42)+1.0)), wh2(vec2(floor(hp.z*2.5)+9.0, 3.0)));
      col = mix(col, mix(vec3(0.35), goods, 0.45) * 0.8 + 0.06, sh);
    }
  } else {
    col = wallC;
    // picture / doorway on back wall
    float pc = step(abs(hp.x - roomW * (0.3 + rs * 0.4)), 0.35) * step(abs(hp.y - 1.6), 0.28);
    if (kind < 0.5) col = mix(col, vec3(0.25 + rs*0.4, 0.2, 0.15 + rs*0.2), pc);
    float door = step(abs(hp.x - roomW * (0.15 + 0.7*fract(rs*7.0))), 0.45) * step(hp.y, 2.1);
    if (kind < 1.5) col = mix(col, col * 0.55, door * step(0.4, fract(rs * 13.0)));
    if (kind > 1.5 && kind < 2.5) { // shelving on back wall
      float sh = step(fract(hp.y / 0.45), 0.8) * step(hp.y, 2.0);
      vec3 goods = vec3(wh2(vec2(floor(hp.x*3.0), floor(hp.y/0.45))), wh2(vec2(floor(hp.x*3.0)+3.0, 1.0)), wh2(vec2(floor(hp.x*3.0)+7.0, 2.0)));
      col = mix(col, mix(vec3(0.38), goods, 0.45) * 0.8 + 0.08, sh);
    }
  }
  // furniture plane
  float zf = D * (0.35 + 0.25 * fract(rs * 3.1));
  float tf = zf / d.z;
  if (tf < t) {
    vec3 q = p + d * tf;
    float m = 0.0;
    vec3 fc = vec3(0.12, 0.11, 0.10);
    if (kind < 0.5) {
      float a0 = roomW * fract(rs * 5.3) * 0.5;
      m = step(a0, q.x) * step(q.x, a0 + 1.9) * step(q.y, 0.85) * (step(q.y, 0.45) + step(q.x, a0 + 0.25) + step(a0 + 1.65, q.x) + step(0.42, q.y) * step(abs(q.x - a0 - 0.95), 0.9) * 0.0);
      m = min(m, 1.0);
      float lampx = a0 + 2.3;
      m = max(m, step(abs(q.x - lampx), 0.02) * step(q.y, 1.4) + step(abs(q.x - lampx), 0.18) * step(abs(q.y - 1.5), 0.13));
      fc = mix(vec3(0.20,0.16,0.13), vec3(0.14,0.17,0.22), fract(rs * 9.7));
    } else if (kind < 1.5) {
      float c = fract(q.x / 1.6);
      m = step(q.y, 1.2) * step(0.06, c) * step(c, 0.94) * (step(1.1, q.y) + step(q.y, 0.76) * step(0.7, q.y) + step(abs(c - 0.5), 0.02));
      m = max(m, step(abs(c - 0.5), 0.12) * step(abs(q.y - 1.0), 0.16));
      m = min(m, 1.0);
      fc = vec3(0.16, 0.17, 0.18);
    } else if (kind < 2.5) {
      float c = fract(q.x / 2.2);
      m = step(q.y, 1.5) * step(0.15, c) * step(c, 0.8);
      fc = vec3(wh2(vec2(floor(q.x/2.2), 5.0)), wh2(vec2(floor(q.x/2.2), 9.0)), 0.5) * 0.45 + 0.1;
      fc *= 0.8 + 0.2 * step(0.5, fract(q.y / 0.35));
    } else if (kind > 4.5 && kind < 5.5) {
      float c = fract(q.x / 2.6);
      float cabin = smoothstep(0.25, 0.4, c) * smoothstep(0.8, 0.65, c);
      m = step(q.y, 1.35) * step(0.1, c) * step(c, 0.9) * step(q.y, 0.75 + 0.6 * cabin);
      // parked cars in real paint colours (white/silver/black/grey/dark red/navy/beige)
      float ch = wh2(vec2(floor(q.x/2.6), 1.0));
      fc = ch < 0.22 ? vec3(0.72,0.72,0.70) : ch < 0.42 ? vec3(0.42,0.43,0.44) : ch < 0.6 ? vec3(0.03,0.03,0.035) : ch < 0.74 ? vec3(0.18,0.18,0.19)
         : ch < 0.84 ? vec3(0.3,0.03,0.03) : ch < 0.93 ? vec3(0.04,0.07,0.16) : vec3(0.5,0.45,0.36);
      if (q.y > 0.8 && q.y < 1.28 && cabin > 0.7) fc = vec3(0.03, 0.035, 0.04); // windows
      if (q.y < 0.32 && (abs(c - 0.25) < 0.07 || abs(c - 0.75) < 0.07)) fc = vec3(0.02); // wheels
      m *= step(0.35, wh2(vec2(floor(q.x/2.6), seed)));
      // columns
      m = max(m, step(abs(fract(q.x / 8.0) - 0.5), 0.03));
      if (m > 0.5 && step(abs(fract(q.x / 8.0) - 0.5), 0.03) > 0.5) fc = vec3(0.38);
    }
    if (m > 0.5) { col = fc; depthF = zf / D; }
  }
  // lighting
  float isLit = 0.0;
  float occ = wh2(vec2(seed * 0.37 + ri, rs * 11.0));
  float night = uNight;
  float occupancy;
  if (kind > 0.5 && kind < 1.5) occupancy = 0.62 * smoothstep(0.15, 0.45, night) * (1.0 - 0.55 * smoothstep(0.75, 1.0, night)) + 0.08;
  else if (kind > 1.5 && kind < 2.5) occupancy = 0.85;
  else if (kind > 4.5) occupancy = 1.0;
  else if (kind > 2.5 && kind < 3.5) occupancy = 0.18;
  else occupancy = 0.48 * smoothstep(0.2, 0.6, night) * (1.0 - 0.25 * smoothstep(0.85, 1.0, night)) + 0.05;
  isLit = step(occ, occupancy) * smoothstep(0.02, 0.35, night);
  vec3 lampC = kind > 0.5 && kind < 1.5 ? vec3(0.86, 0.93, 1.0) : kind > 4.5 ? vec3(0.95, 0.9, 0.7) : mix(vec3(1.0, 0.66, 0.36), vec3(1.0, 0.84, 0.62), fract(rs * 17.0));
  if (kind > 1.5 && kind < 2.5) lampC = vec3(1.0, 0.8, 0.58);
  vec3 lampPos = vec3(roomW * 0.5, flH - 0.05, D * 0.45);
  float dl = length(hp - lampPos);
  float lampFall = 1.0 / (0.6 + 0.12 * dl * dl);
  vec3 dayL = gDayIrr * (0.35 + 0.65 * (1.0 - depthF) * (1.0 - depthF)) * (kind > 1.5 && kind < 2.5 ? 0.6 : 1.0);
  float nightL = isLit * uLamp * lampFall * (kind > 1.5 && kind < 2.5 ? 1.5 : 1.0);
  vec3 radiance = col * (dayL + lampC * nightL) + lampC * gFixture * isLit * uLamp * 2.0;
  // blinds / curtains on the glass
  float bt = wh1(seed * 3.3 + ri);
  if (kind < 1.5) {
    if (bt < 0.35) {
      float f = 0.15 + 0.7 * wh1(seed * 5.1 + ri);
      float yb = H * (1.0 - f);
      if (lp.y > yb) {
        vec3 shadeC = kind < 0.5 ? mix(vec3(0.85,0.80,0.70), vec3(0.75,0.72,0.68), fract(bt*7.0)) : vec3(0.78,0.78,0.76);
        float slat = kind > 0.5 ? 0.85 + 0.15 * step(0.5, fract(lp.y * 18.0)) : 1.0;
        radiance = shadeC * slat * (gDayIrr * 1.6 + lampC * isLit * uLamp * 0.3);
      }
    } else if (bt < 0.6 && kind < 0.5) {
      float cw = W * (0.14 + 0.16 * wh1(seed * 7.7 + ri));
      if (lp.x < cw || lp.x > W - cw) {
        vec3 cc = mix(vec3(0.62,0.52,0.40), vec3(0.45,0.50,0.58), wh1(seed * 9.1));
        float fold = 0.8 + 0.2 * sin(lp.x * 45.0);
        radiance = cc * fold * (gDayIrr * 1.3 + lampC * isLit * uLamp * 0.3);
      }
    }
  }
  return vec4(radiance, solid);
}
`;

let glassMat: THREE.MeshStandardMaterial | null = null;

export function glassMaterial(): THREE.MeshStandardMaterial {
  if (glassMat) return glassMat;
  const m = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.04, metalness: 0.0, vertexColors: true, name: 'bldg:glass', envMapIntensity: 2.5 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = U.uNight;
    sh.uniforms.uInteriorDay = U.uInteriorDay;
    sh.uniforms.uLamp = U.uLamp;
    sh.uniforms.uGlassEnv = U.uGlassEnv;
    sh.uniforms.uGDbg = U.uGDbg;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aWin0; attribute vec4 aWinA; attribute vec4 aWinB;
varying vec2 vWin0; varying vec4 vWinA; varying vec4 vWinB; varying vec3 vGWPos; varying vec3 vGWN;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vWin0 = aWin0; vWinA = aWinA; vWinB = aWinB;
vGWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vGWN = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WINDOW_GLSL.replace('vec3 wallPalette(', SHOP_GLSL + '\nvec3 wallPalette(') + '\nfloat gSolid; float gReflect; float gKind;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    gKind = floor(vWinB.y + 0.001);
    gReflect = fract(vWinB.y + 0.001);
    gSolid = muntinMask(vWin0, vWinA.x, vWinA.y, vWinB.z);
    vec3 sash = diffuseColor.rgb;
    vec3 glassTint = gKind > 3.5 && gKind < 4.5 ? vec3(0.04, 0.05, 0.06) : vec3(0.0);
    diffuseColor.rgb = mix(glassTint, sash, gSolid);
  }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(gKind > 4.5 && gKind < 5.5 ? 1.0 : 0.04, 0.55, gSolid);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = mix(gReflect, 0.0, gSolid);
  if (gReflect > 0.01) diffuseColor.rgb = mix(mix(vec3(0.30,0.40,0.45), vec3(0.55,0.62,0.66), fract(gReflect*7.0)), diffuseColor.rgb, gSolid);`)
      .replace('#include <opaque_fragment>', `
  {
    #if defined( RE_IndirectDiffuse )
      vec3 gIrr = irradiance;
      #if defined( ENVMAP_TYPE_CUBE_UV )
        gIrr += iblIrradiance / max(envMapIntensity, 1e-3);
      #endif
    #else
      vec3 gIrr = vec3(1.0);
    #endif
    gDayIrr = gIrr * RECIPROCAL_PI * uInteriorDay;
    gOutIrr = gIrr * RECIPROCAL_PI;
    vec3 gV = normalize(vGWPos - cameraPosition);
    vec3 gN = normalize(vGWN);
    vec4 gw = shadeWindow(gV, gN);
    if (gReflect > 0.01) {
      outgoingLight += gw.rgb * (1.0 - gSolid) * (1.0 - gReflect * 0.85);
    } else {
      // clear glass: fresnel mix of interior and a street/sky reflection
      float cosT = clamp(dot(-gV, gN), 0.0, 1.0);
      float F = (gKind > 1.5 && gKind < 2.5 ? 0.15 : 0.09) + 0.85 * pow(1.0 - cosT, 4.0);
      vec3 R = reflect(gV, gN);
      #ifdef USE_ENVMAP
        vec3 envR = getIBLRadiance(geometryViewDir, geometryNormal, 0.02) * uGlassEnv;
      #else
        vec3 envR = gOutIrr * mix(vec3(0.35), vec3(0.6, 0.75, 1.0), step(0.0, R.y));
      #endif
      vec4 sb = streetBand(R, uNight);
      vec3 refl = mix(envR, sb.rgb, sb.a);
      vec3 glassOut = gw.rgb * (1.0 - F) + refl * F + reflectedLight.directSpecular;
      if (uGDbg > 0.5) glassOut = uGDbg < 1.5 ? gw.rgb : uGDbg < 2.5 ? refl : vec3(F);
      outgoingLight = mix(glassOut, outgoingLight, gSolid);
    }
  }
#include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'bldg-glass-v3';
  glassMat = m;
  return m;
}

export function setNight(f: number) {
  U.uNight.value = f;
  if (signMat) signMat.emissiveIntensity = f * 1.3;
}
