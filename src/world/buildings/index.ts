// OWNER: buildings agent. Facade grammar + roofs + windows → merged, chunked meshes.
//
// Every building is generated into per-chunk (≈200 m) geometry buckets that share three materials:
//   surface (all opaque surfaces via a texture array), glass (interior-mapped windows), signs.
// Each chunk has three groups: `lod0` (recessed openings, sills, frames, small details),
// `lod1` (flat walls with flush windows, for distance) and `common` (roofs, cornices, awnings, …).
import * as THREE from 'three';
import type { Game } from '../../core/game';
import type { Progress } from '../../core/location';
import type { Recipe, RecipeBuilding } from '../../core/types';
import { generateBuilding } from './building';
import { setBuildingIndex } from './neighbors';
import { newBuckets, newLod0Buckets, newFarBuckets, type Buckets } from './facade';
import { surfaceMaterial, glassMaterial, signMaterial, setNight, refreshSigns, prepareBuildingTextures, U } from './materials';
import { centroid } from './poly';
import { registerShadowProxy, setShadowCascades } from '../../render/shadowProxy';
import { buildShadowHulls } from './shadowHulls';
import { releaseGeometryAfterUpload } from '../../render/memory';
import { yieldFrame } from '../util';

export interface BuildingsResult {
  group: THREE.Group;
  /** 0 = day, 1 = full night: drives window emissive occupancy / signage glow. */
  setNightFactor(f: number): void;
  /** Optional per-frame update (e.g. LOD). */
  update?(dt: number, g: Game): void;
  /** Build statistics (for debugging / perf reports). */
  stats?: BuildStats;
}

export interface BuildStats { buildings: number; chunks: number; meshes: number; trisLod0: number; trisLod1: number; trisCommon: number; windows: number; ms: number; texMs: number; genMs: number }

export interface BuildOptions {
  /** Shorter work slices while neighboring districts load during play. */
  yieldMs?: number;
  chunkSize?: number;
  /** distance (m) at which chunks switch from detailed to simplified facades */
  lodDistance?: number;
  /** Building ids replaced by hand-built landmarks (src/world/landmarks): no procedural output. */
  skip?: Set<string>;
}

/** 100 m quarter of a chunk: the unit of near-detail (lod0) switching. */
interface Sub {
  cx: number; cz: number; half: number;
  list: RecipeBuilding[];
  /** index ranges of this quarter inside the chunk's lod1 surface / glass geometry */
  r1s: [number, number]; r1g: [number, number];
  /** lod0 triangles of this quarter (density → switch distance) */
  tris0: number;
  /** near-detail switch distance (m), smaller for dense quarters */
  dNear: number;
  near: boolean;
  /** detail geometry present on the GPU */
  built: boolean;
  lod0: THREE.Group;
  /** in-progress time-sliced detail build */
  job: { i: number; B: Buckets } | null;
}

interface Chunk {
  cx: number; cz: number; groundY: number; radius: number;
  group: THREE.Group; lod0: THREE.Group; lod1: THREE.Group;
  lod1Meshes: THREE.Mesh[];
  subs: Sub[];
  /** bitmask of quarters currently drawn from lod1 (-1 = not set yet) */
  mask1: number;
  key: string;
  /** detailed shadow casters of this chunk (surface meshes; glass/signs never cast) */
  casters: THREE.Mesh[];
  /** this chunk's footprint prism (shadow-only) */
  hull: THREE.Mesh | null;
  /** detailed meshes cast (near cascade) vs. the hull covering both cascades */
  shadowDetail: boolean | null;
}

export async function buildBuildings(g: Game, onProgress: Progress, opts: BuildOptions = {}): Promise<BuildingsResult> {
  return buildFromRecipe(g.recipe, onProgress, opts, g.quality);
}

/** lod0 triangles per 100 m quarter above which the near-detail distance starts shrinking. */
const DENSE_TRIS = 60000;

export async function buildFromRecipe(recipe: Recipe, onProgress: Progress = () => {}, opts: BuildOptions = {}, quality: 'high' | 'medium' | 'low' = 'high'): Promise<BuildingsResult> {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'buildings';
  const CH = opts.chunkSize ?? 200;
  const SUB = CH / 2;
  // near-detail distance (to the edge of a 100 m quarter). Detail = recessed openings, frames, sills;
  // beyond it facades are flat walls with the same interior-mapped windows.
  const lodD = opts.lodDistance ?? (quality === 'high' ? 130 : quality === 'medium' ? 95 : 65);
  const minD = quality === 'low' ? 35 : 55;
  onProgress('Preparing building materials', 0);
  await yieldUI();
  try { await prepareBuildingTextures(); } catch { /* fall back to procedural */ }
  const tTex = performance.now();
  const surfM = surfaceMaterial();
  const glassM = glassMaterial();
  const signM = signMaterial();
  const texMs = performance.now() - tTex;

  setBuildingIndex(recipe.buildings); // party-wall detection for the facade grammar
  // bucket buildings by chunk (centroid), then by quarter inside the chunk
  const byChunk = new Map<string, { i: number; j: number; cx: number; cz: number; list: RecipeBuilding[]; y: number }>();
  const quarterOf = new Map<RecipeBuilding, number>();
  for (const b of recipe.buildings ?? []) {
    if (!b.footprint || b.footprint.length < 3 || opts.skip?.has(b.id)) continue;
    const [x, z] = centroid(b.footprint);
    const i = Math.floor(x / CH), j = Math.floor(z / CH);
    const key = i + ',' + j;
    let e = byChunk.get(key);
    if (!e) byChunk.set(key, (e = { i, j, cx: (i + 0.5) * CH, cz: (j + 0.5) * CH, list: [], y: 0 }));
    e.y = (e.y * e.list.length + b.baseY) / (e.list.length + 1);
    e.list.push(b);
    quarterOf.set(b, (x - i * CH >= SUB ? 1 : 0) + (z - j * CH >= SUB ? 2 : 0));
  }
  const stats: BuildStats = { buildings: 0, chunks: 0, meshes: 0, trisLod0: 0, trisLod1: 0, trisCommon: 0, windows: 0, ms: 0, texMs: 0, genMs: 0 };
  const chunks: Chunk[] = [];
  const total = recipe.buildings?.length ?? 0;
  const sp = recipe.spawn?.p ?? [0, 0];
  let done = 0;
  let lastYield = performance.now();
  let genMs = 0;
  for (const e of byChunk.values()) {
    const qs: RecipeBuilding[][] = [[], [], [], []];
    for (const b of e.list) qs[quarterOf.get(b)!].push(b);
    // only chunks near the spawn need their lod0 now (everything else builds it on demand)
    const dsp = Math.hypot(Math.max(0, Math.abs(sp[0] - e.cx) - CH / 2), Math.max(0, Math.abs(sp[1] - e.cz) - CH / 2));
    const want0 = dsp < lodD + 40;
    const B = want0 ? newBuckets() : newFarBuckets();
    const marks: { s0: [number, number]; g0: [number, number]; s1: [number, number]; g1: [number, number] }[] = [];
    for (let q = 0; q < 4; q++) {
      marks.push({ s0: B.s[0].mark(), g0: B.g[0].mark(), s1: B.s[1].mark(), g1: B.g[1].mark() });
      for (const b of qs[q]) {
        try {
          const tg = performance.now();
          setBuildingIndex(recipe.buildings);
          stats.windows += generateBuilding(B, b, recipe.region);
          genMs += performance.now() - tg;
          stats.buildings++;
        } catch (err) {
          console.warn('[buildings] failed', b.id, err);
        }
        done++;
        if (performance.now() - lastYield > (opts.yieldMs ?? 30)) {
          onProgress('Raising buildings', done / Math.max(1, total));
          await yieldUI();
          lastYield = performance.now();
        }
      }
    }
    marks.push({ s0: B.s[0].mark(), g0: B.g[0].mark(), s1: B.s[1].mark(), g1: B.g[1].mark() });
    const subs: Sub[] = [];
    for (let q = 0; q < 4; q++) {
      const a = marks[q], z = marks[q + 1];
      const tris0 = ((z.s0[0] - a.s0[0]) + (z.g0[0] - a.g0[0])) / 3;
      const lod0 = new THREE.Group(); lod0.name = `lod0_q${q}`;
      subs.push({
        cx: e.cx + (q & 1 ? SUB / 2 : -SUB / 2), cz: e.cz + (q & 2 ? SUB / 2 : -SUB / 2), half: SUB / 2,
        list: qs[q], r1s: [a.s1[0], z.s1[0]], r1g: [a.g1[0], z.g1[0]],
        tris0, dNear: lodD, near: false, built: false, lod0, job: null,
      });
    }
    for (const su of subs) su.dNear = nearDistance(su.tris0, lodD, minD);
    const ch = makeChunk(e.cx, e.cz, e.y, CH, B, surfM, glassM, signM, stats, subs);
    ch.key = e.i + ',' + e.j;
    if (want0) {
      // quarters near the spawn get their detail right away (sliced out of this chunk's lod0 buckets)
      for (let q = 0; q < 4; q++) {
        const su = subs[q];
        if (!su.list.length || subDist(su, sp[0], sp[1], 0) >= su.dNear - 20) continue;
        const a = marks[q], z = marks[q + 1];
        addLod0(su, B.s[0].buildRange(a.s0[0], z.s0[0], a.s0[1], z.s0[1]), B.g[0].buildRange(a.g0[0], z.g0[0], a.g0[1], z.g0[1]), surfM, glassM, stats);
        su.built = su.near = true;
      }
    }
    chunks.push(ch);
    group.add(ch.group);
  }
  refreshSigns();
  stats.chunks = chunks.length;
  stats.texMs = texMs;
  stats.genMs = genMs;
  stats.ms = performance.now() - t0;
  onProgress('Raising buildings', 1);
  {
    const t0s = chunks.flatMap((c) => c.subs.filter((q) => q.list.length).map((q) => q.tris0)).sort((a, b) => a - b);
    const dn = chunks.flatMap((c) => c.subs.filter((q) => q.list.length).map((q) => q.dNear));
    if (t0s.length) console.info(`[buildings] detail tris per quarter: median ${t0s[t0s.length >> 1] | 0}, max ${t0s[t0s.length - 1] | 0}; near distance ${Math.min(...dn).toFixed(0)}..${Math.max(...dn).toFixed(0)} m`);
  }
  console.info(`[buildings] ${stats.buildings} buildings, ${stats.chunks} chunks, ${stats.meshes} meshes, tris lod0 ${stats.trisLod0} (near spawn) lod1 ${stats.trisLod1} common ${stats.trisCommon}, ${stats.windows} windows, ${stats.ms.toFixed(0)} ms (gen ${genMs.toFixed(0)})`);

  const camPos = new THREE.Vector3();
  const region = recipe.region;
  const disposeLod0 = (su: Sub) => {
    for (const m of su.lod0.children as THREE.Mesh[]) m.geometry.dispose();
    su.lod0.clear();
    su.built = false;
  };
  let gRef: Game | null = null;
  // Far cascade from extruded footprint hulls; every detailed chunk mesh casts into the near cascade only.
  let hulls = false;
  const initHulls = (g: Game) => {
    const grp = new THREE.Group();
    grp.name = 'building-shadow-hulls';
    try { for (const m of buildShadowHulls((recipe.buildings ?? []).filter((b) => !opts.skip?.has(b.id)), CH)) { releaseGeometryAfterUpload(m.geometry); grp.add(m); } } catch (e) { console.warn('[buildings] shadow hulls failed', e); return; }
    group.add(grp);
    if (!registerShadowProxy(g, grp)) { group.remove(grp); return; }
    setShadowCascades(g, grp, 2);
    hulls = true;
    const byKey = new Map<string, THREE.Mesh>();
    for (const m of grp.children as THREE.Mesh[]) byKey.set(m.name.slice(6), m); // bhull_<i,j>
    for (const c of chunks) { setShadowCascades(g, c.group, 1); c.hull = byKey.get(c.key) ?? null; }
  };
  // perf: only chunks near the camera cast detailed shadows (near cascade); the rest cast their
  // footprint prism into both cascades (their shadows land ≥ 60 m away, where facade relief is sub-texel)
  let activeQuality = quality;
  const setShadowDetail = (c: Chunk, on: boolean) => {
    c.shadowDetail = on;
    for (const m of c.casters) m.castShadow = on;
    for (const su of c.subs) for (const m of su.lod0.children as THREE.Mesh[]) if (m.material === surfM) m.castShadow = on;
    if (c.hull) c.hull.userData.shadowCascades = on ? 2 : 3;
  };
  const setLod = (cam: THREE.Camera) => {
    cam.getWorldPosition(camPos);
    const shadowDetailDistance = activeQuality === 'high' ? 60 : activeQuality === 'medium' ? 45 : 30;
    const budgetEnd = performance.now() + 5;
    for (const c of chunks) {
      let mask = 0;
      for (let q = 0; q < 4; q++) {
        const su = c.subs[q];
        if (!su.list.length) continue;
        const d = subDist(su, camPos.x, camPos.z, camPos.y - c.groundY - 10);
        su.near = su.near ? d < su.dNear + 20 : d < su.dNear - 20;
        if (su.near && !su.built) {
          // time-sliced detail build for quarters that became near
          if (!su.job) su.job = { i: 0, B: newLod0Buckets() };
          const job = su.job;
          while (job.i < su.list.length && performance.now() < budgetEnd) {
            try { setBuildingIndex(recipe.buildings); generateBuilding(job.B, su.list[job.i], region); } catch { /* ignore */ }
            job.i++;
          }
          if (job.i >= su.list.length) {
            addLod0(su, job.B.s[0].build(), job.B.g[0].build(), surfM, glassM, null);
            if (hulls && gRef) {
              setShadowCascades(gRef, su.lod0, 1);
              if (c.shadowDetail === false) for (const m of su.lod0.children as THREE.Mesh[]) m.castShadow = false;
            }
            su.job = null;
            su.built = true;
            refreshSigns();
          }
        } else if (!su.near && su.job) su.job = null;
        else if (!su.near && su.built && d > Math.max(450, su.dNear * 2.2 + 150)) disposeLod0(su);
        const show0 = su.near && su.built;
        su.lod0.visible = show0;
        if (!show0) mask |= 1 << q;
      }
      if (mask !== c.mask1) { c.mask1 = mask; setLod1Mask(c, mask); }
      if (hulls && c.hull) {
        const dc = Math.hypot(Math.max(0, Math.abs(camPos.x - c.cx) - c.radius), Math.max(0, Math.abs(camPos.z - c.cz) - c.radius));
        const want = c.shadowDetail ? dc < shadowDetailDistance + 15 : dc < shadowDetailDistance - 15;
        if (want !== c.shadowDetail) setShadowDetail(c, want);
      }
    }
  };
  let lastNight = -1;
  const setNightFactor = (f: number) => {
    if (Math.abs(f - lastNight) < 1e-4) return;
    lastNight = f;
    setNight(f);
  };
  return {
    group,
    stats,
    setNightFactor,
    update(_dt: number, g: Game) {
      if (!gRef) { gRef = g; initHulls(g); }
      if (activeQuality !== g.quality) {
        activeQuality = g.quality;
        const distance = opts.lodDistance ?? (activeQuality === 'high' ? 130 : activeQuality === 'medium' ? 95 : 65);
        const minimum = activeQuality === 'low' ? 35 : 55;
        for (const c of chunks) for (const su of c.subs) su.dNear = nearDistance(su.tris0, distance, minimum);
      }
      setLod(g.camera);
    },
  };
}

/** Distance (m) from a point to a quarter's footprint box, with an optional height term. */
function subDist(su: Sub, x: number, z: number, dy: number) {
  const dx = Math.max(0, Math.abs(x - su.cx) - su.half), dz = Math.max(0, Math.abs(z - su.cz) - su.half);
  return Math.hypot(dx, dz, Math.max(0, dy));
}

/** Near-detail distance for a quarter: dense quarters (Manhattan blocks) switch closer to the camera. */
function nearDistance(tris0: number, lodD: number, minD: number) {
  if (tris0 <= DENSE_TRIS) return lodD;
  return Math.max(minD, lodD * Math.sqrt(DENSE_TRIS / tris0));
}

/** Draw only the quarters in `mask` from the chunk's flat (lod1) facades, via geometry groups. */
function setLod1Mask(c: Chunk, mask: number) {
  c.lod1.visible = mask !== 0;
  for (const m of c.lod1Meshes) {
    const geo = m.geometry;
    const glass = m.userData.glass as boolean;
    geo.clearGroups();
    if (mask === 0) continue; // hidden (lod1.visible = false)
    if (mask === 15) { geo.addGroup(0, Infinity, 0); continue; } // whole geometry, one draw
    // merge adjacent visible quarters into runs (quarters are stored in order 0..3)
    let run: [number, number] | null = null;
    for (let q = 0; q < 4; q++) {
      const r = glass ? c.subs[q].r1g : c.subs[q].r1s;
      if (!(mask & (1 << q))) { if (run) { geo.addGroup(run[0], run[1] - run[0], 0); run = null; } continue; }
      if (r[1] <= r[0]) continue;
      if (run && run[1] === r[0]) run[1] = r[1];
      else { if (run) geo.addGroup(run[0], run[1] - run[0], 0); run = [r[0], r[1]]; }
    }
    if (run) geo.addGroup(run[0], run[1] - run[0], 0);
    if (!geo.groups.length) geo.addGroup(0, 0, 0);
  }
}

export { U as buildingUniforms };

function makeChunk(cx: number, cz: number, groundY: number, CH: number, B: Buckets, surfM: THREE.Material, glassM: THREE.Material, signM: THREE.Material, stats: BuildStats, subs: Sub[]): Chunk {
  const group = new THREE.Group();
  group.name = `bchunk_${Math.round(cx)}_${Math.round(cz)}`;
  const lod0 = new THREE.Group(); lod0.name = 'lod0';
  const lod1 = new THREE.Group(); lod1.name = 'lod1';
  const common = new THREE.Group(); common.name = 'common';
  const lod1Meshes: THREE.Mesh[] = [];
  const casters: THREE.Mesh[] = [];
  const add = (parent: THREE.Group, geo: THREE.BufferGeometry | null, mat: THREE.Material, shadow: boolean, which: 'l1' | 'c', glass = false) => {
    if (!geo) return;
    releaseGeometryAfterUpload(geo); // memory: GPU-only after upload
    // lod1 draws per-quarter index ranges through geometry groups, which need a material array
    const m = new THREE.Mesh(geo, which === 'l1' ? [mat] : mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    stats.meshes++;
    const t = (geo.index?.count ?? 0) / 3;
    if (which === 'l1') { stats.trisLod1 += t; m.userData.glass = glass; lod1Meshes.push(m); } else stats.trisCommon += t;
    if (shadow) casters.push(m);
  };
  add(lod1, B.s[1].build(), surfM, true, 'l1');
  add(lod1, B.g[1].build(), glassM, false, 'l1', true);
  add(common, B.s[2].build(), surfM, true, 'c');
  add(common, B.g[2].build(), glassM, false, 'c');
  add(common, B.sign.build(), signM, false, 'c');
  for (const su of subs) lod0.add(su.lod0);
  group.add(lod0, lod1, common);
  return { cx, cz, groundY, radius: CH / 2, group, lod0, lod1, lod1Meshes, subs, mask1: -1, key: '', casters, hull: null, shadowDetail: null };
}

function addLod0(su: Sub, sGeo: THREE.BufferGeometry | null, gGeo: THREE.BufferGeometry | null, surfM: THREE.Material, glassM: THREE.Material, stats: BuildStats | null) {
  for (const [geo, mat, sh] of [[sGeo, surfM, true], [gGeo, glassM, false]] as [THREE.BufferGeometry | null, THREE.Material, boolean][]) {
    if (!geo) continue;
    releaseGeometryAfterUpload(geo);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = sh; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    su.lod0.add(m);
    if (stats) { stats.meshes++; stats.trisLod0 += (geo.index?.count ?? 0) / 3; }
  }
}

function yieldUI(): Promise<void> {
  return yieldFrame(); // load-time: fast MessageChannel yields with periodic paint yields (world/util)
}
