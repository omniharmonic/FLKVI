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
import { newBuckets, type Buckets } from './facade';
import { surfaceMaterial, glassMaterial, signMaterial, setNight, refreshSigns, prepareBuildingTextures, U } from './materials';
import { centroid } from './poly';
import { registerShadowProxy, unregisterShadowProxy, setShadowCascades } from '../../render/shadowProxy';
import { buildShadowHulls } from './shadowHulls';

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
  chunkSize?: number;
  /** distance (m) at which chunks switch from detailed to simplified facades */
  lodDistance?: number;
}

interface Chunk {
  cx: number; cz: number; groundY: number; radius: number;
  group: THREE.Group; lod0: THREE.Group; lod1: THREE.Group; near: boolean;
  /** perf: lod0 chunk whose shadows come from its flat lod1 walls (shadow-only) */
  lod1Shadow?: boolean;
  list: RecipeBuilding[];
  /** detail geometry present on the GPU */
  built: boolean;
  /** in-progress time-sliced detail build */
  job: { i: number; B: Buckets } | null;
}

export async function buildBuildings(g: Game, onProgress: Progress, opts: BuildOptions = {}): Promise<BuildingsResult> {
  return buildFromRecipe(g.recipe, onProgress, opts, g.quality);
}

export async function buildFromRecipe(recipe: Recipe, onProgress: Progress = () => {}, opts: BuildOptions = {}, quality: 'high' | 'medium' | 'low' = 'high'): Promise<BuildingsResult> {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'buildings';
  const CH = opts.chunkSize ?? 200;
  const lodD = opts.lodDistance ?? (quality === 'high' ? 170 : quality === 'medium' ? 120 : 80);
  onProgress('Preparing building materials', 0);
  await yieldUI();
  try { await prepareBuildingTextures(); } catch { /* fall back to procedural */ }
  const tTex = performance.now();
  const surfM = surfaceMaterial();
  const glassM = glassMaterial();
  const signM = signMaterial();
  const texMs = performance.now() - tTex;

  // bucket buildings by chunk (centroid)
  const byChunk = new Map<string, { cx: number; cz: number; list: RecipeBuilding[]; y: number }>();
  for (const b of recipe.buildings ?? []) {
    if (!b.footprint || b.footprint.length < 3) continue;
    const [x, z] = centroid(b.footprint);
    const i = Math.floor(x / CH), j = Math.floor(z / CH);
    const key = i + ',' + j;
    let e = byChunk.get(key);
    if (!e) byChunk.set(key, (e = { cx: (i + 0.5) * CH, cz: (j + 0.5) * CH, list: [], y: 0 }));
    e.y = (e.y * e.list.length + b.baseY) / (e.list.length + 1);
    e.list.push(b);
  }
  const stats: BuildStats = { buildings: 0, chunks: 0, meshes: 0, trisLod0: 0, trisLod1: 0, trisCommon: 0, windows: 0, ms: 0, texMs: 0, genMs: 0 };
  const chunks: Chunk[] = [];
  const total = recipe.buildings?.length ?? 0;
  let done = 0;
  let lastYield = performance.now();
  let genMs = 0;
  for (const e of byChunk.values()) {
    const B = newBuckets();
    for (const b of e.list) {
      try {
        const tg = performance.now();
        stats.windows += generateBuilding(B, b, recipe.region);
        genMs += performance.now() - tg;
        stats.buildings++;
      } catch (err) {
        console.warn('[buildings] failed', b.id, err);
      }
      done++;
      if (performance.now() - lastYield > 40) {
        onProgress('Raising buildings', done / Math.max(1, total));
        await yieldUI();
        lastYield = performance.now();
      }
    }
    const sp = recipe.spawn?.p ?? [0, 0];
    const dsp = Math.hypot(Math.max(0, Math.abs(sp[0] - e.cx) - CH / 2), Math.max(0, Math.abs(sp[1] - e.cz) - CH / 2));
    const keep0 = dsp < lodD;
    const ch = makeChunk(e.cx, e.cz, e.y, CH, B, surfM, glassM, signM, stats, keep0);
    ch.list = e.list;
    chunks.push(ch);
    group.add(ch.group);
  }
  refreshSigns();
  stats.chunks = chunks.length;
  stats.texMs = texMs;
  stats.genMs = genMs;
  stats.ms = performance.now() - t0;
  onProgress('Raising buildings', 1);
  console.info(`[buildings] ${stats.buildings} buildings, ${stats.chunks} chunks, ${stats.meshes} meshes, tris lod0 ${stats.trisLod0} lod1 ${stats.trisLod1} common ${stats.trisCommon}, ${stats.windows} windows, ${stats.ms.toFixed(0)} ms`);

  const camPos = new THREE.Vector3();
  const region = recipe.region;
  const disposeLod0 = (c: Chunk) => {
    for (const m of c.lod0.children as THREE.Mesh[]) m.geometry.dispose();
    c.lod0.clear();
    c.built = false;
  };
  // perf: detailed (lod0) chunks cast their full-detail shadows only into the NEAR sun cascade;
  // the far cascade gets their flat lod1 walls instead, drawn in the shadow pass only (same
  // silhouette and window apertures — the far cascade can't resolve sills/frames anyway).
  let gRef: Game | null = null;
  // Preferred: far cascade from extruded footprint hulls; every detailed chunk mesh casts near only.
  let hulls: THREE.Group | null = null;
  const initHulls = (g: Game) => {
    const grp = new THREE.Group();
    grp.name = 'building-shadow-hulls';
    try { for (const m of buildShadowHulls(recipe.buildings ?? [], CH)) grp.add(m); } catch (e) { console.warn('[buildings] shadow hulls failed', e); return; }
    group.add(grp);
    if (!registerShadowProxy(g, grp)) { group.remove(grp); return; }
    setShadowCascades(g, grp, 2);
    hulls = grp;
  };
  const setLod = (cam: THREE.Camera) => {
    cam.getWorldPosition(camPos);
    const budgetEnd = performance.now() + 6;
    for (const c of chunks) {
      const dx = Math.max(0, Math.abs(camPos.x - c.cx) - c.radius), dz = Math.max(0, Math.abs(camPos.z - c.cz) - c.radius);
      const d = Math.hypot(dx, dz, Math.max(0, camPos.y - c.groundY - 10));
      c.near = c.near ? d < lodD + 30 : d < lodD - 30;
      // time-sliced detail build for chunks that became near
      if (c.near && !c.built) {
        if (!c.job) c.job = { i: 0, B: newBuckets() };
        while (c.job.i < c.list.length && performance.now() < budgetEnd) {
          try { generateBuilding(c.job.B, c.list[c.job.i], region); } catch { /* ignore */ }
          c.job.i++;
        }
        if (c.job.i >= c.list.length) {
          addLod0(c, c.job.B, surfM, glassM);
          c.job = null;
          c.built = true;
          refreshSigns();
        }
      } else if (!c.near && c.job) c.job = null;
      else if (!c.near && c.built && d > lodD * 2.2 + 200) disposeLod0(c);
      const show0 = c.near && c.built;
      c.lod0.visible = show0;
      if (hulls) {
        // all detail casts into the near cascade only (lazily built lod0 meshes included)
        setShadowCascades(gRef!, c.group, 1);
        c.lod1.visible = !show0;
        continue;
      }
      const proxy = !!gRef && show0;
      if (proxy !== !!c.lod1Shadow) {
        c.lod1Shadow = proxy && registerShadowProxy(gRef!, c.lod1);
        if (!c.lod1Shadow && gRef) unregisterShadowProxy(gRef, c.lod1);
        if (gRef) {
          setShadowCascades(gRef, c.lod1, c.lod1Shadow ? 2 : 3);
          setShadowCascades(gRef, c.lod0, c.lod1Shadow ? 1 : 3);
        }
      }
      // lod0 meshes are (re)built lazily: keep the near-cascade mask on (cheap: ~2 meshes)
      if (c.lod1Shadow) setShadowCascades(gRef!, c.lod0, 1);
      if (!c.lod1Shadow) c.lod1.visible = !show0;
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
      if (!gRef) initHulls(g);
      gRef = g;
      setLod(g.camera);
    },
  };
}

export { U as buildingUniforms };

function makeChunk(cx: number, cz: number, groundY: number, CH: number, B: Buckets, surfM: THREE.Material, glassM: THREE.Material, signM: THREE.Material, stats: BuildStats, keep0: boolean): Chunk {
  const group = new THREE.Group();
  group.name = `bchunk_${Math.round(cx)}_${Math.round(cz)}`;
  const lod0 = new THREE.Group(); lod0.name = 'lod0';
  const lod1 = new THREE.Group(); lod1.name = 'lod1';
  const common = new THREE.Group(); common.name = 'common';
  const add = (parent: THREE.Group, geo: THREE.BufferGeometry | null, mat: THREE.Material, shadow: boolean, which: 'l0' | 'l1' | 'c') => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    stats.meshes++;
    const t = (geo.index?.count ?? 0) / 3;
    if (which === 'l0') stats.trisLod0 += t; else if (which === 'l1') stats.trisLod1 += t; else stats.trisCommon += t;
  };
  if (keep0) {
    add(lod0, B.s[0].build(), surfM, true, 'l0');
    add(lod0, B.g[0].build(), glassM, false, 'l0');
  }
  add(lod1, B.s[1].build(), surfM, true, 'l1');
  add(lod1, B.g[1].build(), glassM, false, 'l1');
  add(common, B.s[2].build(), surfM, true, 'c');
  add(common, B.g[2].build(), glassM, false, 'c');
  add(common, B.sign.build(), signM, false, 'c');
  lod1.visible = !keep0;
  lod0.visible = keep0;
  group.add(lod0, lod1, common);
  return { cx, cz, groundY, radius: CH / 2, group, lod0, lod1, near: keep0, list: [], built: keep0, job: null };
}

function addLod0(c: Chunk, B: Buckets, surfM: THREE.Material, glassM: THREE.Material) {
  for (const [geo, mat, sh] of [[B.s[0].build(), surfM, true], [B.g[0].build(), glassM, false]] as [THREE.BufferGeometry | null, THREE.Material, boolean][]) {
    if (!geo) continue;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = sh; m.receiveShadow = true;
    m.matrixAutoUpdate = false; m.updateMatrix();
    c.lod0.add(m);
  }
}

function yieldUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
