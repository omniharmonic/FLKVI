// Trees: ez-tree generated variants per species profile, instanced near LOD + cross-billboard impostors far.
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import type { RecipeTree } from '../core/types';
import { rng, hashString } from '../core/geo';
import { yieldFrame } from './util';

interface Profile {
  preset: string;
  leafTint: number; barkTint: number;
  tweak?: (o: any) => void;
  conifer?: boolean;
}

const PROFILES: Record<string, Profile> = {
  locust: { preset: 'Ash Medium', leafTint: 0xdfeea0, barkTint: 0x9a8f86, tweak: (o) => { o.leaves.size *= 0.8; o.leaves.count = Math.round(o.leaves.count * 1.2); o.branch.angle[1] = 55; } },
  broadleaf: { preset: 'Oak Medium', leafTint: 0xb4d08a, barkTint: 0xa09588 },
  cottonwood: { preset: 'Oak Large', leafTint: 0xc8dc8a, barkTint: 0xb5aba0, tweak: (o) => { o.leaves.type = 'aspen'; o.branch.angle[1] = 42; } },
  ash: { preset: 'Ash Large', leafTint: 0xb8d488, barkTint: 0xa8a098 },
  aspen: { preset: 'Aspen Medium', leafTint: 0xd8e890, barkTint: 0xffffff },
  spruce: { preset: 'Pine Medium', leafTint: 0x9fbcc4, barkTint: 0x8a7a6a, conifer: true, tweak: (o) => { o.leaves.count = Math.round(o.leaves.count * 1.1); o.leaves.size *= 1.05; o.branch.start[1] = 0.1; } },
  pine: { preset: 'Pine Large', leafTint: 0xbcd08c, barkTint: 0xd8a07a, conifer: true, tweak: (o) => { o.branch.start[1] = 0.45; o.branch.angle[1] = 100; } },
  juniper: { preset: 'Pine Small', leafTint: 0x9ab08a, barkTint: 0x8a7a6a, conifer: true },
  shrub: { preset: 'Bush 1', leafTint: 0xa8c47c, barkTint: 0x806a5a },
  shrub2: { preset: 'Bush 2', leafTint: 0xb6cc88, barkTint: 0x806a5a },
};

export function profileFor(species: string): string {
  const s = species.toLowerCase();
  if (s.includes('shrub') || s.includes('bush')) return 'shrub';
  if (s.includes('spruce') || s.includes('fir') || s.includes('cedar')) return 'spruce';
  if (s.includes('pine') || s.includes('conifer')) return 'pine';
  if (s.includes('juniper') || s.includes('cypress') || s.includes('arbor')) return 'juniper';
  if (s.includes('locust') || s.includes('mimosa') || s.includes('coffee')) return 'locust';
  if (s.includes('cottonwood') || s.includes('poplar') || s.includes('willow') || s.includes('sycamore') || s.includes('plane')) return 'cottonwood';
  if (s.includes('aspen') || s.includes('birch')) return 'aspen';
  if (s.includes('ash') || s.includes('elm') || s.includes('hackberry')) return 'ash';
  return 'broadleaf';
}

interface Variant {
  key: string;
  bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry;
  /** crown width / height ratio of the normalized model */
  ratio: number;
  barkMat: THREE.MeshStandardMaterial; leafMat: THREE.MeshStandardMaterial;
  nearBark?: THREE.InstancedMesh; nearLeaves?: THREE.InstancedMesh;
  /** reduced LOD */
  bark1?: THREE.BufferGeometry; leaves1?: THREE.BufferGeometry;
  midBark?: THREE.InstancedMesh; midLeaves?: THREE.InstancedMesh;
  atlasIdx: number;
}

interface TreeInst { x: number; y: number; z: number; v: number; m: Float32Array; r: number; h: number }

export const treeUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };

function windPatch(mat: THREE.MeshStandardMaterial, leaves: boolean) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = treeUniforms.uTime;
    sh.uniforms.uWind = treeUniforms.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; uniform float uWind;')
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
          ${leaves ? 'transformed.xyz += 0.0035 * uWind * hh * vec3(sin(uTime * 5.3 + position.x * 40.0 + ph), sin(uTime * 4.1 + position.z * 33.0), cos(uTime * 6.1 + position.y * 37.0 + ph));' : ''}
        }`);
  };
  mat.customProgramCacheKey = () => 'gt-tree-' + leaves;
}

function makeVariant(profileKey: string, seed: number, lod = 0): Omit<Variant, 'atlasIdx'> {
  const P = PROFILES[profileKey];
  const t = new Tree();
  t.loadPreset(P.preset);
  const o: any = t.options;
  o.seed = seed;
  o.leaves.tint = P.leafTint;
  o.bark.tint = P.barkTint;
  // keep geometry modest
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
  // normalize: base at 0, height 1
  const bb = new THREE.Box3().setFromBufferAttribute(bark.getAttribute('position') as THREE.BufferAttribute);
  bb.union(new THREE.Box3().setFromBufferAttribute(leaves.getAttribute('position') as THREE.BufferAttribute));
  const H = bb.max.y - Math.min(0, bb.min.y);
  const s = 1 / H;
  for (const g of [bark, leaves]) { g.translate(0, -Math.min(0, bb.min.y), 0); g.scale(s, s, s); }
  const lb = new THREE.Box3().setFromBufferAttribute(leaves.getAttribute('position') as THREE.BufferAttribute);
  const ratio = Math.max(lb.max.x - lb.min.x, lb.max.z - lb.min.z, 0.2);
  // soft spherical foliage normals
  const lc = lb.getCenter(new THREE.Vector3());
  const lp = leaves.getAttribute('position') as THREE.BufferAttribute;
  const ln = new Float32Array(lp.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < lp.count; i++) {
    v.fromBufferAttribute(lp, i).sub(lc); v.y *= 0.6; v.y += 0.25 * (lb.max.y - lb.min.y); v.normalize();
    ln[i * 3] = v.x; ln[i * 3 + 1] = v.y; ln[i * 3 + 2] = v.z;
  }
  leaves.setAttribute('normal', new THREE.BufferAttribute(ln, 3));
  bark.computeBoundingSphere(); leaves.computeBoundingSphere();
  const barkMat = new THREE.MeshStandardMaterial({ map: srcBark.map, normalMap: (srcBark as any).normalMap ?? null, aoMap: null, color: new THREE.Color(P.barkTint), roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({
    map: srcLeaf.map, color: new THREE.Color(P.leafTint).multiplyScalar(0.85), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8,
  });
  (leafMat as any).shadowSide = THREE.DoubleSide;
  windPatch(barkMat, false); windPatch(leafMat, true);
  return { key: `${profileKey}:${seed}`, bark, leaves, ratio, barkMat, leafMat };
}

/** Renders each variant from the side into an atlas for cross-billboard impostors. */
function bakeAtlas(renderer: THREE.WebGLRenderer, variants: Variant[], tile = 256) {
  const cols = Math.ceil(Math.sqrt(variants.length));
  const size = cols * tile;
  const rt = new THREE.WebGLRenderTarget(size, size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, samples: 4 });
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(0.3, 1, 0.8); scene.add(dl);
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  const prevScissor = renderer.getScissorTest();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  variants.forEach((V, i) => {
    V.atlasIdx = i;
    const cx = i % cols, cy = Math.floor(i / cols);
    const w = V.ratio;
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, 1, 0, -10, 10);
    cam.position.set(0, 0, 2); cam.lookAt(0, 0, 0);
    const grp = new THREE.Group();
    // materials without wind for baking
    const bm = V.barkMat.clone(); bm.onBeforeCompile = () => {}; bm.customProgramCacheKey = () => 'bake-b';
    const lm = V.leafMat.clone(); lm.onBeforeCompile = () => {}; lm.customProgramCacheKey = () => 'bake-l'; lm.alphaTest = 0.4;
    grp.add(new THREE.Mesh(V.bark, bm), new THREE.Mesh(V.leaves, lm));
    scene.add(grp);
    rt.viewport.set(cx * tile, cy * tile, tile, tile);
    rt.scissor.set(cx * tile, cy * tile, tile, tile);
    rt.scissorTest = true;
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    scene.remove(grp);
    bm.dispose(); lm.dispose();
  });
  renderer.setScissorTest(prevScissor);
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  return { tex: rt.texture, cols };
}

export class TreeSystem {
  group = new THREE.Group();
  private variants: Variant[] = [];
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
  /** Trunk cylinders for physics: x,z,y,radius,height */
  trunks: { x: number; z: number; y: number; r: number; h: number }[] = [];

  constructor() { this.group.name = 'trees'; }

  async build(trees: RecipeTree[], renderer: THREE.WebGLRenderer | undefined, onProgress?: (f: number) => void) {
    // variants per profile that is used
    const used = new Map<string, number>();
    for (const t of trees) { const p = profileFor(t.species); used.set(p, (used.get(p) ?? 0) + 1); }
    if (!used.size) return;
    const keys = [...used.keys()];
    let done = 0;
    const total = keys.reduce((s, k) => s + ((used.get(k) ?? 0) > 20 ? 2 : 1), 0);
    for (const k of keys) {
      const n = (used.get(k) ?? 0) > 20 ? 2 : 1;
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const seed = (hashString(k) + i * 7919) % 100000;
        try {
          const v = makeVariant(k, seed) as Variant;
          v.atlasIdx = 0;
          try { const l1 = makeVariant(k, seed, 1); v.bark1 = l1.bark; v.leaves1 = l1.leaves; l1.barkMat.dispose(); l1.leafMat.dispose(); } catch { /* no lod1 */ }
          ids.push(this.variants.length);
          this.variants.push(v);
        } catch (e) { console.warn('[world] tree variant failed', k, e); }
        done++; onProgress?.(done / total);
        await yieldFrame();
      }
      if (ids.length) this.byProfile.set(k, ids);
    }
    if (!this.variants.length) return;
    // instances
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const counts = new Array(this.variants.length).fill(0);
    for (const t of trees) {
      const ids = this.byProfile.get(profileFor(t.species));
      if (!ids) continue;
      const R = rng(t.seed || hashString(`${t.p[0]},${t.p[1]}`));
      const v = ids[Math.floor(R() * ids.length)];
      const V = this.variants[v];
      const h = Math.max(1, t.height || 8);
      let sxz = (t.crown || h * 0.6) / V.ratio;
      sxz = Math.max(h * 0.65, Math.min(h * 1.5, sxz));
      q.setFromAxisAngle(up, R() * Math.PI * 2);
      sc.set(sxz, h, sxz);
      pos.set(t.p[0], t.y - 0.05, t.p[1]);
      m4.compose(pos, q, sc);
      this.insts.push({ x: t.p[0], y: t.y, z: t.p[1], v, m: new Float32Array(m4.elements), r: Math.max(sxz * V.ratio * 0.5, h * 0.5), h });
      counts[v]++;
      if (h > 2.5) this.trunks.push({ x: t.p[0], z: t.p[1], y: t.y, r: Math.max(0.12, Math.min(0.4, h * 0.018)), h: Math.min(h * 0.4, 4) });
    }
    // near meshes: capacity = min(count, cap)
    this.variants.forEach((V, i) => {
      const cap = Math.max(1, Math.min(counts[i], 1500));
      V.nearBark = new THREE.InstancedMesh(V.bark, V.barkMat, cap);
      V.nearLeaves = new THREE.InstancedMesh(V.leaves, V.leafMat, cap);
      V.midBark = new THREE.InstancedMesh(V.bark1 ?? V.bark, V.barkMat, cap);
      V.midLeaves = new THREE.InstancedMesh(V.leaves1 ?? V.leaves, V.leafMat, cap);
      for (const m of [V.nearBark, V.nearLeaves, V.midBark, V.midLeaves]) {
        m.castShadow = m === V.nearBark || m === V.nearLeaves; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.name = 'tree_' + V.key;
        this.group.add(m);
      }
      this.nearCount[i] = 0; this.midCount[i] = 0;
    });
    // impostors
    let atlas: THREE.Texture | null = null, cols = 1;
    if (renderer) { const a = bakeAtlas(renderer, this.variants); atlas = a.tex; cols = a.cols; }
    const quad = new THREE.PlaneGeometry(1, 1);
    quad.translate(0, 0.5, 0);
    const q2 = quad.clone(); q2.rotateY(Math.PI / 2);
    const geo = new THREE.BufferGeometry();
    const merged = [quad, q2];
    const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
    merged.forEach((g, gi) => {
      const p = g.getAttribute('position'), uv = g.getAttribute('uv');
      const base = P.length / 3;
      for (let i = 0; i < p.count; i++) { P.push(p.getX(i), p.getY(i), p.getZ(i)); N.push(0, 1, 0); U.push(uv.getX(i), uv.getY(i)); }
      const idx = g.getIndex()!;
      for (let i = 0; i < idx.count; i++) I.push(idx.getX(i) + base);
      void gi;
    });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    geo.setIndex(I);
    const total2 = this.insts.length;
    this.farAtlas = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, total2) * 3), 3);
    this.farAtlas.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAtlas', this.farAtlas);
    const fm = new THREE.MeshStandardMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9, color: atlas ? 0xffffff : 0x4a6a3a });
    fm.onBeforeCompile = (sh) => {
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
            vec4 sampledDiffuseColor = texture2D(map, vAtl);
            diffuseColor *= sampledDiffuseColor;
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
    if (!this.far) return;
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
      this.sph.center.set(T.x, T.y + T.h * 0.5, T.z); this.sph.radius = T.h * 0.7 + T.r;
      if (!this.frustum.intersectsSphere(this.sph)) continue;
      const d2 = (T.x - cx) ** 2 + (T.z - cz) ** 2;
      const V = this.variants[T.v];
      if (d2 < fd2) {
        const n = this.nearCount[T.v];
        if (n < V.nearBark!.instanceMatrix.count) {
          (V.nearBark!.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          (V.nearLeaves!.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          this.nearCount[T.v] = n + 1;
          continue;
        }
      } else if (d2 < nd2) {
        const n = this.midCount[T.v];
        if (n < V.midBark!.instanceMatrix.count) {
          (V.midBark!.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          (V.midLeaves!.instanceMatrix.array as Float32Array).set(T.m, n * 16);
          this.midCount[T.v] = n + 1;
          if (sArr && sAtl) {
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
      V.nearBark!.count = V.nearLeaves!.count = this.nearCount[i];
      V.nearBark!.instanceMatrix.needsUpdate = V.nearLeaves!.instanceMatrix.needsUpdate = true;
      V.midBark!.count = V.midLeaves!.count = this.midCount[i];
      V.midBark!.instanceMatrix.needsUpdate = V.midLeaves!.instanceMatrix.needsUpdate = true;
    });
    this.far.count = fc;
    if (si) { si.count = sc; si.instanceMatrix.needsUpdate = true; this.shadowAtlas.needsUpdate = true; }
    this.far.instanceMatrix.needsUpdate = true;
    this.farAtlas.needsUpdate = true;
  }
}
