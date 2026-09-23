// Near-LOD draw-call merge (perf). A live near car used ~15 draws (one per material). Here every
// opaque part (paint, dark underbody, trim, chrome, grille, plate, cabin, drivers) shares ONE per-car
// MeshPhysicalMaterial driven by vertex attributes, and every lamp (head/tail/reverse/signals/light
// bar/sign) shares ONE per-car lamp material driven by a small uniform table. A car is then:
//   body (opaque group + glass group) = 2, misc opaque = 1, lamps = 1  →  4 draws (+ night beam).
// Per-car material objects share a single compiled program (same customProgramCacheKey/defines).
//
// Opaque vertex attributes:
//   aCol  vec3  base colour (linear) for non-paint parts
//   aSurf vec4  (roughness, metalness, clearcoat, paintMask) — paintMask 1 = use the material's paint
//   aTex  float texture slot: 0 body livery (material.map), 1 grille, 2 plate atlas, 3 palette,
//               4 none, 5..7 driver variant 0..2 (palette; hidden unless uDriver == variant + 1)
// Lamp vertex attributes:
//   aLCol vec3 off colour, aLOn vec3 lit colour, aLEm vec3 emissive colour,
//   aLK   vec3 (slot 0..7, texture 0 none/1 head/2 tail/3 sign, tint-when-on 0/1)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarModel } from './carModels';
import { grilleTex, headTex, headEm, tailTex, plateTexture, flakeNormal, PLATE_CELLS } from './materials';
import { paletteTexture } from './palette';

// ------------------------------------------------------------------ part descriptors

interface Surf { col: number; rough: number; metal: number; coat: number; paint: number; tex: number }
const S = {
  paint: { col: 0xffffff, rough: 0, metal: 0, coat: 1, paint: 1, tex: 0 },
  dark: { col: 0x0b0b0c, rough: 0.95, metal: 0, coat: 0, paint: 0, tex: 4 },
  trim: { col: 0x141517, rough: 0.55, metal: 0.1, coat: 0, paint: 0, tex: 4 },
  chrome: { col: 0xe6e8ea, rough: 0.1, metal: 1, coat: 0, paint: 0, tex: 4 },
  grille: { col: 0xffffff, rough: 0.6, metal: 0.4, coat: 0, paint: 0, tex: 1 },
  plate: { col: 0xffffff, rough: 0.45, metal: 0.3, coat: 0, paint: 0, tex: 2 },
  cabin: { col: 0xffffff, rough: 0.85, metal: 0, coat: 0, paint: 0, tex: 3 },
} satisfies Record<string, Surf>;

const _c = new THREE.Color();
/** Copy of g (position/normal/uv only, indexed) with the opaque surface attributes filled in. */
function tag(src: THREE.BufferGeometry, s: Surf, texOverride?: number) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv'] as const) {
    const a = src.getAttribute(k);
    if (a) g.setAttribute(k, a.clone());
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.setIndex(src.index ? src.index.clone() : [...Array(g.attributes.position.count).keys()]);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), surf = new Float32Array(n * 4), tex = new Float32Array(n);
  _c.setHex(s.col);
  for (let i = 0; i < n; i++) {
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
    surf[i * 4] = s.rough; surf[i * 4 + 1] = s.metal; surf[i * 4 + 2] = s.coat; surf[i * 4 + 3] = s.paint;
    tex[i] = texOverride ?? s.tex;
  }
  g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 4));
  g.setAttribute('aTex', new THREE.BufferAttribute(tex, 1));
  return g;
}

/** Triangles of one geometry group as a standalone indexed geometry (vertices duplicated per group). */
function groupGeo(src: THREE.BufferGeometry, group: number) {
  const idx = src.index!;
  const remap = new Map<number, number>();
  const out: number[] = [];
  for (const gr of src.groups) {
    if (gr.materialIndex !== group) continue;
    for (let i = gr.start; i < gr.start + gr.count; i++) {
      const v = idx.getX(i);
      let r = remap.get(v);
      if (r === undefined) { r = remap.size; remap.set(v, r); }
      out.push(r);
    }
  }
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv'] as const) {
    const a = src.getAttribute(k) as THREE.BufferAttribute | undefined;
    if (!a) continue;
    const arr = new Float32Array(remap.size * a.itemSize);
    for (const [o, nIdx] of remap) for (let c = 0; c < a.itemSize; c++) arr[nIdx * a.itemSize + c] = a.array[o * a.itemSize + c];
    g.setAttribute(k, new THREE.BufferAttribute(arr, a.itemSize));
  }
  g.setIndex(out);
  return g;
}

// Lamp slots.
export const LAMP = { head: 0, tail: 1, rev: 2, sigL: 3, sigR: 4, red: 5, blue: 6, sign: 7 } as const;
interface LampSpec { slot: number; tex: number; tint: number; off: number; on: number; em: number }
const LS: Record<string, LampSpec> = {
  head: { slot: 0, tex: 1, tint: 0, off: 0xffffff, on: 0xffffff, em: 0xfff2dc },
  tail: { slot: 1, tex: 2, tint: 0, off: 0xffffff, on: 0xffffff, em: 0xff1208 },
  rev: { slot: 2, tex: 0, tint: 1, off: 0x6a6d72, on: 0xffffff, em: 0xffffff },
  sigL: { slot: 3, tex: 0, tint: 1, off: 0x8a4a05, on: 0xffa030, em: 0xff8a10 },
  sigR: { slot: 4, tex: 0, tint: 1, off: 0x8a4a05, on: 0xffa030, em: 0xff8a10 },
  red: { slot: 5, tex: 0, tint: 1, off: 0x4a0508, on: 0xff2020, em: 0xff0a14 },
  blue: { slot: 6, tex: 0, tint: 1, off: 0x05103a, on: 0x3050ff, em: 0x1f45ff },
  sign: { slot: 7, tex: 3, tint: 0, off: 0xffffff, on: 0xffffff, em: 0xffffff },
};
const _c2 = new THREE.Color(), _c3 = new THREE.Color();
function lampTag(src: THREE.BufferGeometry, l: LampSpec) {
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv'] as const) { const a = src.getAttribute(k); if (a) g.setAttribute(k, a.clone()); }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  g.setIndex(src.index ? src.index.clone() : [...Array(g.attributes.position.count).keys()]);
  const n = g.attributes.position.count;
  const off = new Float32Array(n * 3), on = new Float32Array(n * 3), em = new Float32Array(n * 3), k = new Float32Array(n * 3);
  _c.setHex(l.off); _c2.setHex(l.on); _c3.setHex(l.em);
  for (let i = 0; i < n; i++) {
    off.set([_c.r, _c.g, _c.b], i * 3); on.set([_c2.r, _c2.g, _c2.b], i * 3); em.set([_c3.r, _c3.g, _c3.b], i * 3);
    k.set([l.slot, l.tex, l.tint], i * 3);
  }
  g.setAttribute('aLCol', new THREE.BufferAttribute(off, 3));
  g.setAttribute('aLOn', new THREE.BufferAttribute(on, 3));
  g.setAttribute('aLEm', new THREE.BufferAttribute(em, 3));
  g.setAttribute('aLK', new THREE.BufferAttribute(k, 3));
  return g;
}

function subGroup(src: THREE.BufferGeometry, group: number) { return groupGeo(src, group); }

export interface NearGeometry {
  /** Groups: 0 opaque (paint + dark + trim), 1 glass. */
  body: THREE.BufferGeometry;
  /** All other opaque parts incl. cabin + the 3 driver variants (hidden by uniform). */
  misc: THREE.BufferGeometry;
  /** All lamps. */
  lamps: THREE.BufferGeometry;
  signTex: THREE.Texture | null;
  signLevel: number;
}

const nearCache = new Map<string, NearGeometry>();
export function nearGeometry(model: CarModel): NearGeometry {
  let n = nearCache.get(model.id);
  if (n) return n;
  // Body: paint(0) / dark(2) / trim(3) → one opaque group, glass(1) → second group.
  const opaque = mergeGeometries([tag(groupGeo(model.body, 0), S.paint), tag(groupGeo(model.body, 2), S.dark), tag(groupGeo(model.body, 3), S.trim)], false)!;
  const glass = tag(groupGeo(model.body, 1), S.dark);
  const body = mergeGeometries([opaque, glass], true)!;
  const parts: THREE.BufferGeometry[] = [tag(model.paintParts, S.paint), tag(model.trim, S.trim), tag(model.grille, S.grille), tag(model.plate, S.plate), tag(model.interior, S.cabin)];
  if (model.chrome) parts.push(tag(model.chrome, S.chrome));
  if (model.lightbar) parts.push(tag(model.lightbar.base, S.trim));
  model.drivers.slice(0, 3).forEach((d, i) => parts.push(tag(d, S.cabin, 5 + i)));
  const misc = mergeGeometries(parts, false)!;
  const lp: THREE.BufferGeometry[] = [lampTag(model.head, LS.head), lampTag(model.tail, LS.tail), lampTag(model.reverse, LS.rev),
    lampTag(subGroup(model.signals, 0), LS.sigL), lampTag(subGroup(model.signals, 1), LS.sigR)];
  if (model.lightbar) { lp.push(lampTag(model.lightbar.red, LS.red), lampTag(model.lightbar.blue, LS.blue)); }
  let signTex: THREE.Texture | null = null, signLevel = 0;
  if (model.taxiSign) { lp.push(lampTag(model.taxiSign, LS.sign)); signTex = taxiSignTexture(); signLevel = 0.4; }
  if (model.destSign) { lp.push(lampTag(model.destSign, LS.sign)); signTex = destSignTexture(); signLevel = 1.6; }
  const lamps = mergeGeometries(lp, false)!;
  for (const g of [body, misc, lamps]) { g.computeBoundingSphere(); g.computeBoundingBox(); }
  n = { body, misc, lamps, signTex, signLevel };
  nearCache.set(model.id, n);
  return n;
}

// ------------------------------------------------------------------ textures

let taxiTex: THREE.CanvasTexture | null = null;
function taxiSignTexture() {
  if (taxiTex) return taxiTex;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#f7e9a8'; x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#1a1a1a'; x.font = 'bold 72px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('TAXI', 128, 68);
  taxiTex = new THREE.CanvasTexture(cv);
  taxiTex.colorSpace = THREE.SRGBColorSpace;
  return taxiTex;
}

let destTex: THREE.CanvasTexture | null = null;
/** Amber LED dot-matrix destination sign: "12 DOWNTOWN" (generic route, no agency). */
export function destSignTexture() {
  if (destTex) return destTex;
  // Render the text at the LED grid resolution, then draw each lit cell as a round LED.
  const cols = 120, rows = 14;
  const lo = document.createElement('canvas');
  lo.width = cols; lo.height = rows;
  const l = lo.getContext('2d')!;
  l.fillStyle = '#000'; l.fillRect(0, 0, cols, rows);
  l.fillStyle = '#fff'; l.textBaseline = 'middle';
  l.font = 'bold 13px "Arial Narrow", Arial, sans-serif';
  l.textAlign = 'left'; l.fillText('12', 3, rows / 2 + 1);
  l.font = 'bold 11px "Arial Narrow", Arial, sans-serif';
  l.textAlign = 'center'; l.fillText('DOWNTOWN', 70, rows / 2 + 1, 92);
  const px = l.getImageData(0, 0, cols, rows).data;
  const cell = 8;
  const cv = document.createElement('canvas');
  cv.width = cols * cell; cv.height = rows * cell;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#050403'; x.fillRect(0, 0, cv.width, cv.height);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const on = px[(j * cols + i) * 4] > 90;
    x.fillStyle = on ? '#ffb020' : '#1a1206';
    x.beginPath(); x.arc(i * cell + cell / 2, j * cell + cell / 2, cell * 0.36, 0, Math.PI * 2); x.fill();
  }
  destTex = new THREE.CanvasTexture(cv);
  destTex.colorSpace = THREE.SRGBColorSpace;
  destTex.anisotropy = 4;
  return destTex;
}

// ------------------------------------------------------------------ materials

const NORMAL_MAPS = THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * vSurf.w;');

export type CarBodyMaterial = THREE.MeshPhysicalMaterial & { carUniforms: { uPlateOff: { value: THREE.Vector2 }; uDriver: { value: number } } };

/** Paint parameters (mirrors materials.paintMaterial). */
function applyPaint(m: THREE.MeshPhysicalMaterial, color: string) {
  const c = new THREE.Color(color);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const solid = hsl.l > 0.8 || (hsl.s > 0.6 && hsl.h > 0.1 && hsl.h < 0.2);
  m.color.copy(c);
  m.metalness = solid ? 0.05 : 0.62;
  m.roughness = solid ? 0.36 : 0.34;
  const nm = solid ? null : flakeNormal();
  if (m.normalMap !== nm) { m.normalMap = nm; m.needsUpdate = true; }
}

/** One per car: paint + every other opaque part. */
export function createBodyMaterial(model: CarModel, color: string, plateCell: number, driverVariant: number): CarBodyMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: model.paintMap, normalScale: new THREE.Vector2(0.22, 0.22),
    clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.15,
  }) as CarBodyMaterial;
  m.name = `veh-body-${model.id}`;
  applyPaint(m, color);
  const cell = ((plateCell % PLATE_CELLS) + PLATE_CELLS) % PLATE_CELLS;
  const u = {
    uPlateOff: { value: new THREE.Vector2((cell % 4) * 0.25, -Math.floor(cell / 4) * 0.25) },
    uDriver: { value: driverVariant + 1 },
    uGrille: { value: grilleTex },
    uPlate: { value: plateTexture() },
    uPal: { value: paletteTexture() },
  };
  m.carUniforms = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aCol; attribute vec4 aSurf; attribute float aTex;
varying vec3 vCol; varying vec4 vSurf; varying float vTex; varying vec2 vRawUv;
uniform vec2 uPlateOff; uniform float uDriver;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
vCol = aCol; vSurf = aSurf; vTex = aTex;
vRawUv = uv + ((aTex > 1.5 && aTex < 2.5) ? uPlateOff : vec2(0.0));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
if (aTex > 4.5 && abs(aTex - 4.0 - uDriver) > 0.5) transformed = vec3(0.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCol; varying vec4 vSurf; varying float vTex; varying vec2 vRawUv;
uniform sampler2D uGrille; uniform sampler2D uPlate; uniform sampler2D uPal;`)
      .replace('#include <map_fragment>', `
vec4 tD = texture2D(map, vMapUv);
vec4 tG = texture2D(uGrille, vRawUv * vec2(4.0, 1.5));
vec4 tP = texture2D(uPlate, vRawUv);
vec4 tL = texture2D(uPal, vRawUv);
vec4 tx = vTex < 0.5 ? tD : vTex < 1.5 ? tG : vTex < 2.5 ? tP : (vTex < 3.5 || vTex > 4.5) ? tL : vec4(1.0);
diffuseColor = mix(vec4(vCol, diffuseColor.a) * tx, diffuseColor * tx, vSurf.w);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(vSurf.x, roughnessFactor, vSurf.w);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(vSurf.y, metalnessFactor, vSurf.w);`)
      .replace('#include <normal_fragment_maps>', NORMAL_MAPS)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
material.clearcoat *= vSurf.z;
#endif`);
  };
  m.customProgramCacheKey = () => 'gt-car-body-v1';
  return m;
}
export function setBodyPaint(m: CarBodyMaterial, color: string) { applyPaint(m, color); }

export type CarLampMaterial = THREE.MeshPhysicalMaterial & { lampI: number[]; lampOn: number[] };

/** One per car: every lamp; per-slot emission + lit state are uniforms. */
export function createLampMaterial(model: CarModel): CarLampMaterial {
  const near = nearGeometry(model);
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, emissive: 0xffffff, roughness: 0.1, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03,
  }) as CarLampMaterial;
  m.name = `veh-lamps-${model.id}`;
  const lampI = new Array(8).fill(0), lampOn = new Array(8).fill(0);
  lampI[LAMP.red] = lampI[LAMP.blue] = 0.05;
  lampI[LAMP.sign] = near.signLevel;
  m.lampI = lampI; m.lampOn = lampOn;
  const u = {
    uLampI: { value: lampI }, uLampOn: { value: lampOn },
    uHead: { value: headTex }, uHeadEm: { value: headEm }, uTail: { value: tailTex }, uSign: { value: near.signTex ?? headTex },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aLCol; attribute vec3 aLOn; attribute vec3 aLEm; attribute vec3 aLK;
uniform float uLampI[8]; uniform float uLampOn[8];
varying vec3 vLBase; varying vec3 vLEm; varying float vLTex; varying vec2 vLUv;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
int slot = int(aLK.x + 0.5);
float lon = uLampOn[slot] * aLK.z;
vLBase = mix(aLCol, aLOn, lon);
vLEm = aLEm * uLampI[slot];
vLTex = aLK.y; vLUv = uv;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vLBase; varying vec3 vLEm; varying float vLTex; varying vec2 vLUv;
uniform sampler2D uHead; uniform sampler2D uHeadEm; uniform sampler2D uTail; uniform sampler2D uSign;`)
      .replace('#include <map_fragment>', `
vec4 lH = texture2D(uHead, vLUv), lE = texture2D(uHeadEm, vLUv), lT = texture2D(uTail, vLUv), lS = texture2D(uSign, vLUv);
vec4 lD = vLTex < 0.5 ? vec4(1.0) : vLTex < 1.5 ? lH : vLTex < 2.5 ? lT : lS;
vec3 lEmTex = vLTex < 0.5 ? vec3(1.0) : vLTex < 1.5 ? lE.rgb : lD.rgb;
diffuseColor.rgb *= vLBase * lD.rgb;`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vLEm * lEmTex;');
  };
  m.customProgramCacheKey = () => 'gt-car-lamps-v1';
  return m;
}
