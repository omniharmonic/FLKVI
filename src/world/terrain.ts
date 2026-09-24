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
/** Blur a canvas in place with a single filter pass (optionally over an opaque background colour). */
export function blurCanvas(c: HTMLCanvasElement, px: number, bg?: string) {
  const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
  const tx = t.getContext('2d')!;
  tx.filter = `blur(${px}px)`;
  tx.drawImage(c, 0, 0);
  const x = c.getContext('2d')!;
  x.save();
  x.filter = 'none';
  x.globalCompositeOperation = 'source-over';
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height); } else x.clearRect(0, 0, c.width, c.height);
  x.drawImage(t, 0, 0);
  x.restore();
  t.width = t.height = 0; // free the scratch backing store now
}

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
  // load time: shapes are drawn sharp and the canvas is blurred ONCE at the end. A ctx.filter set while
  // drawing runs a separate blur pass per fill (thousands of GPU passes; ~10 s of GPU stall on software GL).
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
  blurCanvas(c, 1.5, '#000');
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // canvas row 0 = min z (sampled with v = (z - oz) / size)
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  // hardscape: paved aprons around non-residential buildings + plazas
  const hc = document.createElement('canvas'); hc.width = cw; hc.height = ch;
  const hx = hc.getContext('2d')!;
  hx.fillStyle = '#000'; hx.fillRect(0, 0, cw, ch);
  hx.fillStyle = '#fff'; hx.strokeStyle = '#fff'; hx.lineJoin = 'round';
  for (const b of recipe.buildings) {
    if (b.use === 'residential-single' || b.use === 'agricultural' || !b.footprint?.length) continue;
    const apron = b.use === 'residential-multi' ? 2.5 : 6;
    hx.lineWidth = (apron * 2) / res;
    hx.beginPath();
    b.footprint.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) hx.lineTo(x, y); else hx.moveTo(x, y); });
    hx.closePath(); hx.fill(); hx.stroke();
  }
  // downtown frontage: storefront buildings get a deep paved apron (sidewalk continues to the face)
  hx.lineWidth = 20 / res;
  for (const b of recipe.buildings) {
    if (!b.storefront || !b.footprint?.length) continue;
    hx.beginPath();
    b.footprint.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) hx.lineTo(x, y); else hx.moveTo(x, y); });
    hx.closePath(); hx.stroke();
  }
  // commercial / retail landuse is hardscape (no lawn strips between sidewalk and shopfronts)
  hx.fillStyle = 'rgb(210,210,210)';
  for (const a of recipe.areas) {
    if (a.kind !== 'commercial') continue;
    hx.beginPath();
    a.poly.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) hx.lineTo(x, y); else hx.moveTo(x, y); });
    hx.closePath(); hx.fill();
  }
  hx.fillStyle = '#fff';
  for (const a of recipe.areas) {
    if (a.kind !== 'pedestrian' && a.kind !== 'plaza' && a.kind !== 'parking') continue;
    hx.lineWidth = 2 / res;
    hx.beginPath();
    a.poly.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) hx.lineTo(x, y); else hx.moveTo(x, y); });
    hx.closePath(); hx.fill(); hx.stroke();
  }
  // parks/lawns win over aprons
  hx.fillStyle = '#000';
  for (const a of recipe.areas) {
    if (!['park', 'grass', 'pitch', 'cemetery', 'forest', 'playground'].includes(a.kind)) continue;
    hx.beginPath();
    a.poly.forEach((p, i) => { const x = (p[0] - hf.ox) / res, y = (p[1] - hf.oz) / res; if (i) hx.lineTo(x, y); else hx.moveTo(x, y); });
    hx.closePath(); hx.fill();
  }
  blurCanvas(hc, 1, '#000');
  const hard = new THREE.CanvasTexture(hc);
  hard.flipY = false;
  hard.colorSpace = THREE.NoColorSpace;
  hard.wrapS = hard.wrapT = THREE.ClampToEdgeWrapping;
  return { tex, hard, origin: new THREE.Vector2(hf.ox, hf.oz), size: new THREE.Vector2(cw * res, ch * res) };
}

export function terrainMaterial(recipe: Recipe, mask: ReturnType<typeof bakeLandMask>) {
  const grass = surface('grass'), dirt = surface('dirt'), dry = surface('grass-dry', 'grass'), conc = surface('concrete');
  const arid = recipe.climate === 'arid';
  // vegetation: Sonoran-desert cities landscape yards with decomposed granite / gravel instead of lawn
  const xeri = recipe.region === 'southwest';
  const grav = surface('gravel');
  const mat = new THREE.MeshStandardMaterial({ map: grass.map ?? null, normalMap: grass.normalMap ?? null, roughness: 0.95, metalness: 0 });
  mat.name = 'terrain';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.dirtMap = { value: dirt.map };
    sh.uniforms.dryMap = { value: dry.map };
    sh.uniforms.dryScale = { value: 1 / dry.sizeM };
    sh.uniforms.hardMap = { value: mask.hard };
    sh.uniforms.concMap = { value: conc.map };
    sh.uniforms.concScale = { value: 1 / conc.sizeM };
    sh.uniforms.maskMap = { value: mask.tex };
    sh.uniforms.maskOrigin = { value: mask.origin };
    sh.uniforms.maskSize = { value: mask.size };
    sh.uniforms.grassScale = { value: 1 / grass.sizeM };
    sh.uniforms.dirtScale = { value: 1 / dirt.sizeM };
    sh.uniforms.gravMap = { value: grav.map };
    sh.uniforms.gravScale = { value: 1 / grav.sizeM };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGtW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvGtW = (modelMatrix * vec4(transformed,1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGtW; uniform sampler2D dirtMap; uniform sampler2D maskMap; uniform vec2 maskOrigin; uniform vec2 maskSize;
        uniform float grassScale; uniform float dirtScale; uniform sampler2D dryMap; uniform float dryScale; uniform sampler2D hardMap; uniform sampler2D concMap; uniform float concScale; uniform sampler2D gravMap; uniform float gravScale;
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
        vec3 d1 = texture2D(dryMap, wuv * dryScale).rgb;
        vec3 d2 = texture2D(dryMap, wuv * dryScale * 0.23 + vec2(0.61, 0.29)).rgb;
        vec3 dryGrass = mix(d1, d2, smoothstep(0.3, 0.7, gt_noise(wuv * 0.043 + 3.0)) * 0.6) * 1.05;
        vec3 lushGrass = grassC * vec3(0.95, 1.0, 0.9);
        dryGrass = mix(dryGrass, lushGrass * 0.85, ${arid ? '0.3' : '0.5'} * smoothstep(0.35, 0.7, gt_fbm(wuv * 0.07 + 11.0)));
        float dirtAmt = smoothstep(0.58, 0.78, nA + 0.18 * gt_noise(wuv * 0.45)) * ${arid ? '0.7' : '0.35'};
        float lushAmt = clamp(lawn * (0.75 + 0.35 * gt_noise(wuv * 0.08)) + ${arid ? '0.0' : '0.4'}, 0.0, 1.0);
        vec3 base = mix(dryGrass, lushGrass, lushAmt);
        base *= 0.88 + 0.24 * gt_fbm(wuv * 0.11 + 7.0);
        base = mix(base, dirtC, clamp(max(dirtAmt * (1.0 - lawn), bare), 0.0, 1.0));
        base = mix(base, mix(dirtC * 0.55, grassC * 0.6, 0.5), forest * 0.6);
        ${xeri ? `{
          // decomposed granite: residential yards + unmapped ground (parks keep irrigated turf)
          float yard = smoothstep(0.3, 0.45, lawn) * (1.0 - smoothstep(0.72, 0.9, lawn));
          float dgAmt = clamp(max(yard, (1.0 - smoothstep(0.1, 0.3, lawn)) * 0.9) * (1.0 - forest), 0.0, 1.0);
          vec3 dg1 = texture2D(gravMap, wuv * gravScale * 1.6).rgb, dg2 = texture2D(gravMap, wuv * gravScale * 0.45 + 0.3).rgb;
          vec3 dg = mix(dg1, dg2, 0.35) * mix(vec3(1.32, 1.12, 0.94), vec3(1.2, 1.06, 0.95), gt_noise(wuv * 0.07));
          dg *= 0.9 + 0.2 * gt_fbm(wuv * 0.23 + 5.0);
          base = mix(base, dg, dgAmt * (0.85 + 0.15 * gt_noise(wuv * 0.5)));
        }` : ''}
        float slope = 1.0 - abs(normalize(cross(dFdx(vGtW), dFdy(vGtW))).y);
        base = mix(base, dirtC * vec3(0.95, 0.9, 0.85), smoothstep(0.25, 0.45, abs(slope)));
        float hard = texture2D(hardMap, (wuv - maskOrigin) / maskSize).r;
        if (hard > 0.01) {
          vec3 cc = mix(texture2D(concMap, wuv * concScale).rgb, texture2D(concMap, wuv * concScale * 0.29 + 0.4).rgb, 0.35) * vec3(1.62, 1.58, 1.5);
          vec2 jg = abs(fract(wuv / 1.5 + 0.5) - 0.5) * 1.5;
          cc *= 1.0 - 0.35 * (1.0 - smoothstep(0.005, 0.02, min(jg.x, jg.y)));
          cc *= 0.9 + 0.2 * gt_fbm(wuv * 0.2);
          base = mix(base, cc, smoothstep(0.35, 0.65, hard));
        }
        diffuseColor.rgb *= base;
      `)
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale * (1.0 - 0.85 * hard);'));
  };
  mat.customProgramCacheKey = () => 'gt-terrain-' + arid + (xeri ? '-xeri' : '');
  return mat;
}

const SKIRT = 1.5;
/** Chunk LOD distances (m, camera to chunk bounds): full grid inside LOD1_DIST, 2x cells, then 4x. */
const LOD1_DIST = 260, LOD2_DIST = 560;
const _box = new THREE.Box3();

/** Pick each terrain chunk's index buffer (full / half / quarter resolution) by camera distance. */
export function updateTerrainLod(meshes: THREE.Mesh[], cam: THREE.Vector3) {
  for (const m of meshes) {
    const lods = m.userData.lods as THREE.BufferAttribute[] | undefined;
    if (!lods) continue;
    _box.copy(m.geometry.boundingBox!);
    const d = _box.distanceToPoint(cam);
    const lod = d < LOD1_DIST ? 0 : d < LOD2_DIST ? 1 : 2;
    if (lod !== m.userData.lod) { m.userData.lod = lod; m.geometry.setIndex(lods[lod]); }
  }
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
    // Skirt vertices (perf LOD): a copy of every border vertex dropped SKIRT m, so coarser
    // neighbours never open cracks. Border ring order: top row, right col, bottom row, left col.
    const ring: number[] = [];
    for (let c = 0; c < w; c++) ring.push(c);
    for (let r = 1; r < d; r++) ring.push(r * w + w - 1);
    for (let c = w - 2; c >= 0; c--) ring.push((d - 1) * w + c);
    for (let r = d - 2; r >= 1; r--) ring.push(r * w);
    ring.push(0);
    const nv = w * d, nSk = ring.length;
    const P = new Float32Array((nv + nSk) * 3), N = new Float32Array((nv + nSk) * 3), UV = new Float32Array((nv + nSk) * 2);
    P.set(pos); N.set(nrm); UV.set(uv);
    // (plain loop, not a closure: a closure here would capture pos/P/... into the scope context that the
    // raycast closure below keeps alive forever — ~25 MB of vertex arrays per city)
    for (let i = 0; i < nSk; i++) {
      const v = ring[i], j = nv + i;
      P[j * 3] = pos[v * 3]; P[j * 3 + 1] = pos[v * 3 + 1] - SKIRT; P[j * 3 + 2] = pos[v * 3 + 2];
      N[j * 3] = nrm[v * 3]; N[j * 3 + 1] = nrm[v * 3 + 1]; N[j * 3 + 2] = nrm[v * 3 + 2];
      UV[j * 2] = uv[v * 2]; UV[j * 2 + 1] = uv[v * 2 + 1];
    }
    const lodIndex = (step: number) => {
      const idx: number[] = [];
      const cs: number[] = [], rs: number[] = [];
      for (let c = 0; c < w - 1; c += step) cs.push(c); cs.push(w - 1);
      for (let r = 0; r < d - 1; r += step) rs.push(r); rs.push(d - 1);
      for (let i = 0; i < rs.length - 1; i++) for (let k = 0; k < cs.length - 1; k++) {
        const a = rs[i] * w + cs[k], b = rs[i] * w + cs[k + 1], e = rs[i + 1] * w + cs[k], f = rs[i + 1] * w + cs[k + 1];
        // diagonal a-f (matches Heightfield.sample)
        idx.push(a, f, b, a, e, f);
      }
      {
        // skirts along the border, at this LOD's vertex spacing (both windings: visible from any side)
        const onGrid = (v: number) => { const r = Math.floor(v / w), c = v % w; return (r % step === 0 || r === d - 1) && (c % step === 0 || c === w - 1); };
        let prev = -1;
        for (let i = 0; i < ring.length; i++) {
          if (!onGrid(ring[i]) && i !== ring.length - 1) continue;
          if (prev >= 0) {
            const a = ring[prev], b = ring[i], as = nv + prev, bs = nv + i;
            idx.push(a, as, b, b, as, bs, a, b, as, b, bs, as);
          }
          prev = i;
        }
      }
      return new THREE.Uint32BufferAttribute(idx, 1);
    };
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    const lods = [lodIndex(1), lodIndex(2), lodIndex(4)];
    g.setIndex(lods[0]);
    g.computeBoundingSphere(); g.computeBoundingBox();
    // bounds from the grid only (skirts hang below)
    g.boundingBox!.min.y = Math.min(g.boundingBox!.min.y + SKIRT, g.boundingBox!.max.y);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.name = `terrain_${c0}_${r0}`;
    m.matrixAutoUpdate = false;
    m.userData.lods = lods;
    m.userData.lod = 0;
    // raycasts (camera collision, LOS) always use the full-resolution triangles
    const rc = m.raycast.bind(m);
    m.raycast = (raycaster, hits) => { const cur = g.index; g.index = lods[0]; try { rc(raycaster, hits); } finally { g.index = cur; } };
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
