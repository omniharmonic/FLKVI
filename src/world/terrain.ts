// Terrain: fine heightfield (resampled + flattened under roads), land-cover mask, chunked meshes, far backdrop.
import * as THREE from 'three';
import type { Recipe, Terrain, RecipeArea } from '../core/types';
import { surface, NOISE_GLSL } from './materials';

export class Heightfield {
  h: Float32Array;
  constructor(public cols: number, public rows: number, public ox: number, public oz: number, public cell: number, h?: Float32Array) {
    this.h = h ?? new Float32Array(cols * rows);
  }
  get maxX() { return this.ox + (this.cols - 1) * this.cell; }
  get maxZ() { return this.oz + (this.rows - 1) * this.cell; }
  at(c: number, r: number) {
    c = c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
    r = r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
    return this.h[r * this.cols + c];
  }
  /** Triangle interpolation matching the mesh (diagonal from (c,r) to (c+1,r+1)). */
  sample(x: number, z: number) {
    let fx = (x - this.ox) / this.cell, fz = (z - this.oz) / this.cell;
    fx = Math.max(0, Math.min(this.cols - 1.0001, fx));
    fz = Math.max(0, Math.min(this.rows - 1.0001, fz));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r;
    const h00 = this.at(c, r), h11 = this.at(c + 1, r + 1);
    if (u >= v) { const h10 = this.at(c + 1, r); return h00 + (h10 - h00) * u + (h11 - h10) * v; }
    const h01 = this.at(c, r + 1); return h00 + (h11 - h01) * u + (h01 - h00) * v;
  }
  /** Bilinear (for resampling source terrains). */
  bilinear(x: number, z: number) {
    let fx = (x - this.ox) / this.cell, fz = (z - this.oz) / this.cell;
    fx = Math.max(0, Math.min(this.cols - 1.0001, fx));
    fz = Math.max(0, Math.min(this.rows - 1.0001, fz));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r;
    const a = this.at(c, r), b = this.at(c + 1, r), d = this.at(c, r + 1), e = this.at(c + 1, r + 1);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + d * (1 - u) * v + e * u * v;
  }
  normal(c: number, r: number, out: THREE.Vector3) {
    const dx = (this.at(c + 1, r) - this.at(c - 1, r)) / (2 * this.cell);
    const dz = (this.at(c, r + 1) - this.at(c, r - 1)) / (2 * this.cell);
    return out.set(-dx, 1, -dz).normalize();
  }
  static fromTerrain(t: Terrain) {
    return new Heightfield(t.cols, t.rows, t.originX, t.originZ, t.cellSize, Float32Array.from(t.heights));
  }
}

/** Resample the recipe terrain to a finer grid (≤ target cell, capped vertex count). */
export function makeFineHeightfield(t: Terrain): Heightfield {
  const src = Heightfield.fromTerrain(t);
  const w = (t.cols - 1) * t.cellSize, d = (t.rows - 1) * t.cellSize;
  let cell = Math.min(t.cellSize, 2.5);
  while ((w / cell + 1) * (d / cell + 1) > 700_000) cell *= 1.25;
  if (cell >= t.cellSize * 0.99) return src;
  const cols = Math.floor(w / cell) + 1, rows = Math.floor(d / cell) + 1;
  const hf = new Heightfield(cols, rows, t.originX, t.originZ, cell);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) hf.h[r * cols + c] = src.bilinear(t.originX + c * cell, t.originZ + r * cell);
  return hf;
}

/** Land-cover mask canvas: R lawn, G bare/dirt, B forest. 1 texel ≈ res m. */
export function bakeLandMask(recipe: Recipe, hf: Heightfield) {
  const W = hf.maxX - hf.ox, D = hf.maxZ - hf.oz;
  const res = Math.max(1, Math.max(W, D) / 2048);
  const cw = Math.ceil(W / res), ch = Math.ceil(D / res);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
  const col: Partial<Record<RecipeArea['kind'], string>> = {
    park: 'rgb(255,0,0)', grass: 'rgb(255,0,0)', pitch: 'rgb(255,0,0)', cemetery: 'rgb(255,0,0)', residential: 'rgb(150,0,0)',
    playground: 'rgb(60,200,0)', sand: 'rgb(0,255,0)', farmland: 'rgb(90,150,0)', forest: 'rgb(60,40,255)', industrial: 'rgb(0,140,0)',
    commercial: 'rgb(40,40,0)',
  };
  const order: RecipeArea['kind'][] = ['residential', 'commercial', 'industrial', 'farmland', 'forest', 'park', 'grass', 'cemetery', 'pitch', 'playground', 'sand'];
  ctx.filter = 'blur(1.5px)';
  for (const kind of order) {
    const fill = col[kind];
    if (!fill) continue;
    ctx.fillStyle = fill;
    for (const a of recipe.areas) {
      if (a.kind !== kind) continue;
      ctx.beginPath();
      const ring = (r: [number, number][]) => r.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ring(a.poly); ctx.closePath();
      for (const h of a.holes ?? []) { ring(h); ctx.closePath(); }
      ctx.fill('evenodd');
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return { tex, origin: new THREE.Vector2(hf.ox, hf.oz), size: new THREE.Vector2(cw * res, ch * res) };
}

export function terrainMaterial(recipe: Recipe, mask: ReturnType<typeof bakeLandMask>) {
  const grass = surface('grass'), dirt = surface('dirt');
  const arid = recipe.climate === 'arid';
  const mat = new THREE.MeshStandardMaterial({ map: grass.map ?? null, normalMap: grass.normalMap ?? null, roughness: 0.95, metalness: 0 });
  mat.name = 'terrain';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.dirtMap = { value: dirt.map };
    sh.uniforms.maskMap = { value: mask.tex };
    sh.uniforms.maskOrigin = { value: mask.origin };
    sh.uniforms.maskSize = { value: mask.size };
    sh.uniforms.grassScale = { value: 1 / grass.sizeM };
    sh.uniforms.dirtScale = { value: 1 / dirt.sizeM };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGtW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGtW = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGtW; uniform sampler2D dirtMap; uniform sampler2D maskMap; uniform vec2 maskOrigin; uniform vec2 maskSize;
        uniform float grassScale; uniform float dirtScale;
        ${NOISE_GLSL}`)
      .replace('#include <map_fragment>', `
        vec2 wuv = vGtW.xz;
        vec3 g1 = texture2D(map, wuv * grassScale).rgb;
        vec3 g2 = texture2D(map, wuv * grassScale * 0.29 + vec2(0.37, 0.11)).rgb;
        float nA = gt_fbm(wuv * 0.035);
        vec3 grassC = mix(g1, g2, smoothstep(0.35, 0.65, gt_noise(wuv * 0.05)) * 0.6);
        vec3 dirtC = mix(texture2D(dirtMap, wuv * dirtScale).rgb, texture2D(dirtMap, wuv * dirtScale * 0.31 + 0.5).rgb, 0.4);
        vec4 m = texture2D(maskMap, (wuv - maskOrigin) / maskSize);
        float lawn = m.r, bare = m.g, forest = m.b;
        vec3 dryGrass = grassC * vec3(1.35, 1.12, 0.72);
        vec3 lushGrass = grassC * vec3(0.92, 1.1, 0.88);
        float dirtAmt = smoothstep(0.52, 0.72, nA + 0.18 * gt_noise(wuv * 0.45)) * ${arid ? '0.85' : '0.45'};
        vec3 base = mix(dryGrass, lushGrass, clamp(lawn + ${arid ? '0.0' : '0.35'}, 0.0, 1.0));
        base *= 0.85 + 0.3 * gt_fbm(wuv * 0.11 + 7.0);
        base = mix(base, dirtC, clamp(max(dirtAmt * (1.0 - lawn), bare), 0.0, 1.0));
        base = mix(base, mix(dirtC * 0.55, grassC * 0.6, 0.5), forest * 0.6);
        float slope = 1.0 - abs(normalize(cross(dFdx(vGtW), dFdy(vGtW))).y);
        base = mix(base, dirtC * vec3(0.95, 0.9, 0.85), smoothstep(0.25, 0.45, abs(slope)));
        diffuseColor.rgb *= base;
      `);
  };
  mat.customProgramCacheKey = () => 'gt-terrain-' + arid;
  return mat;
}

/** Build chunked terrain meshes (+ a skirt around the edge). */
export function buildTerrainMeshes(hf: Heightfield, mat: THREE.Material, chunkCells = 64): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const n = new THREE.Vector3();
  for (let r0 = 0; r0 < hf.rows - 1; r0 += chunkCells) for (let c0 = 0; c0 < hf.cols - 1; c0 += chunkCells) {
    const r1 = Math.min(hf.rows - 1, r0 + chunkCells), c1 = Math.min(hf.cols - 1, c0 + chunkCells);
    const w = c1 - c0 + 1, d = r1 - r0 + 1;
    const pos = new Float32Array(w * d * 3), nrm = new Float32Array(w * d * 3), uv = new Float32Array(w * d * 2);
    let k = 0;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = hf.ox + c * hf.cell, z = hf.oz + r * hf.cell;
      pos[k * 3] = x; pos[k * 3 + 1] = hf.at(c, r); pos[k * 3 + 2] = z;
      hf.normal(c, r, n); nrm[k * 3] = n.x; nrm[k * 3 + 1] = n.y; nrm[k * 3 + 2] = n.z;
      uv[k * 2] = x; uv[k * 2 + 1] = z; k++;
    }
    const idx: number[] = [];
    for (let r = 0; r < d - 1; r++) for (let c = 0; c < w - 1; c++) {
      const a = r * w + c, b = a + 1, e = a + w, f = e + 1;
      // diagonal a-f (matches Heightfield.sample)
      idx.push(a, f, b, a, e, f);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere(); g.computeBoundingBox();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.name = `terrain_${c0}_${r0}`;
    m.matrixAutoUpdate = false;
    meshes.push(m);
  }
  // Edge skirt (one mesh): drops 40 m below boundary to hide gaps against far terrain.
  const sp: number[] = [], si: number[] = [], sn: number[] = [], su: number[] = [];
  const ring: [number, number][] = [];
  for (let c = 0; c < hf.cols; c++) ring.push([c, 0]);
  for (let r = 1; r < hf.rows; r++) ring.push([hf.cols - 1, r]);
  for (let c = hf.cols - 2; c >= 0; c--) ring.push([c, hf.rows - 1]);
  for (let r = hf.rows - 2; r >= 1; r--) ring.push([0, r]);
  ring.push(ring[0]);
  for (let i = 0; i < ring.length; i++) {
    const [c, r] = ring[i];
    const x = hf.ox + c * hf.cell, z = hf.oz + r * hf.cell, y = hf.at(c, r);
    sp.push(x, y, z, x, y - 40, z); sn.push(0, 1, 0, 0, 1, 0); su.push(x, z, x, z);
    if (i > 0) { const a = (i - 1) * 2, b = i * 2; si.push(a, a + 1, b, b, a + 1, b + 1); }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  sg.setAttribute('normal', new THREE.Float32BufferAttribute(sn, 3));
  sg.setAttribute('uv', new THREE.Float32BufferAttribute(su, 2));
  sg.setIndex(si);
  const skirtMat = (mat as THREE.MeshStandardMaterial).clone();
  skirtMat.side = THREE.DoubleSide;
  skirtMat.onBeforeCompile = (mat as THREE.MeshStandardMaterial).onBeforeCompile;
  skirtMat.customProgramCacheKey = (mat as THREE.MeshStandardMaterial).customProgramCacheKey;
  const skirtMesh = new THREE.Mesh(sg, skirtMat);
  skirtMesh.name = 'terrain_skirt';
  meshes.push(skirtMesh);
  return meshes;
}

/** Distant backdrop terrain with a hole where the near terrain is. */
export function buildFarTerrain(far: Terrain, near: Heightfield): THREE.Mesh {
  const hf = Heightfield.fromTerrain(far);
  const pos: number[] = [], col: number[] = [], nrm: number[] = [], uv: number[] = [];
  const idx: number[] = [];
  const n = new THREE.Vector3();
  const inset = far.cellSize;
  const inNear = (x: number, z: number) => x > near.ox + inset && x < near.maxX - inset && z > near.oz + inset && z < near.maxZ - inset;
  const cRock = new THREE.Color('#8a7a6c'), cDry = new THREE.Color('#9c9366'), cForest = new THREE.Color('#3d4a2e'), cGrass = new THREE.Color('#77804a');
  const tmp = new THREE.Color();
  const baseY = near.sample((near.ox + near.maxX) / 2, (near.oz + near.maxZ) / 2);
  for (let r = 0; r < hf.rows; r++) for (let c = 0; c < hf.cols; c++) {
    const x = hf.ox + c * hf.cell, z = hf.oz + r * hf.cell;
    let y = hf.at(c, r);
    // tuck under near terrain inside its footprint to avoid z-fighting
    const insideNear = x >= near.ox && x <= near.maxX && z >= near.oz && z <= near.maxZ;
    if (insideNear) y = Math.min(y, near.sample(x, z)) - 3;
    pos.push(x, y, z);
    hf.normal(c, r, n); nrm.push(n.x, n.y, n.z);
    const slope = 1 - n.y, rel = y - baseY;
    tmp.copy(cDry).lerp(cGrass, 0.3);
    const forestAmt = Math.max(0, Math.min(1, (rel - 150) / 250)) * (1 - Math.max(0, Math.min(1, (rel - 900) / 300)));
    tmp.lerp(cForest, forestAmt * 0.85 * (0.6 + 0.4 * Math.sin(x * 0.01) * Math.cos(z * 0.013)));
    tmp.lerp(cRock, Math.max(0, Math.min(1, (slope - 0.18) * 3.5)));
    col.push(tmp.r, tmp.g, tmp.b);
    uv.push(x / 12, z / 12);
  }
  for (let r = 0; r < hf.rows - 1; r++) for (let c = 0; c < hf.cols - 1; c++) {
    const x0 = hf.ox + c * hf.cell, z0 = hf.oz + r * hf.cell;
    if (inNear(x0, z0) && inNear(x0 + hf.cell, z0 + hf.cell)) continue;
    const a = r * hf.cols + c, b = a + 1, e = a + hf.cols, f = e + 1;
    idx.push(a, f, b, a, e, f);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const rock = surface('stone', 'rock');
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: rock.map ?? null, roughness: 1 });
  if (mat.map) { mat.map = mat.map.clone(); mat.map.repeat.set(1, 1); mat.map.needsUpdate = true; }
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec3 tx = texture2D(map, vMapUv).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), tx * 2.2, 0.55);
      #endif`);
  };
  mat.name = 'farTerrain';
  const m = new THREE.Mesh(g, mat);
  m.name = 'farTerrain';
  m.receiveShadow = false;
  m.matrixAutoUpdate = false;
  return m;
}
