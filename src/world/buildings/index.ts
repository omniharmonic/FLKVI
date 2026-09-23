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
import { surfaceMaterial, glassMaterial, signMaterial, setNight, refreshSigns, U } from './materials';
import { centroid } from './poly';

export interface BuildingsResult {
  group: THREE.Group;
  /** 0 = day, 1 = full night: drives window emissive occupancy / signage glow. */
  setNightFactor(f: number): void;
  /** Optional per-frame update (e.g. LOD). */
  update?(dt: number, g: Game): void;
  /** Build statistics (for debugging / perf reports). */
  stats?: BuildStats;
}

export interface BuildStats { buildings: number; chunks: number; meshes: number; trisLod0: number; trisLod1: number; trisCommon: number; windows: number; ms: number }

export interface BuildOptions {
  chunkSize?: number;
  /** distance (m) at which chunks switch from detailed to simplified facades */
  lodDistance?: number;
}

interface Chunk { cx: number; cz: number; radius: number; group: THREE.Group; lod0: THREE.Group; lod1: THREE.Group; near: boolean }

export async function buildBuildings(g: Game, onProgress: Progress, opts: BuildOptions = {}): Promise<BuildingsResult> {
  return buildFromRecipe(g.recipe, onProgress, opts, g.quality);
}

export async function buildFromRecipe(recipe: Recipe, onProgress: Progress = () => {}, opts: BuildOptions = {}, quality: 'high' | 'medium' | 'low' = 'high'): Promise<BuildingsResult> {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'buildings';
  const CH = opts.chunkSize ?? 200;
  const lodD = opts.lodDistance ?? (quality === 'high' ? 320 : quality === 'medium' ? 220 : 140);
  onProgress('Preparing building materials', 0);
  await yieldUI();
  const surfM = surfaceMaterial();
  const glassM = glassMaterial();
  const signM = signMaterial();

  // bucket buildings by chunk (centroid)
  const byChunk = new Map<string, { cx: number; cz: number; list: RecipeBuilding[] }>();
  for (const b of recipe.buildings ?? []) {
    if (!b.footprint || b.footprint.length < 3) continue;
    const [x, z] = centroid(b.footprint);
    const i = Math.floor(x / CH), j = Math.floor(z / CH);
    const key = i + ',' + j;
    let e = byChunk.get(key);
    if (!e) byChunk.set(key, (e = { cx: (i + 0.5) * CH, cz: (j + 0.5) * CH, list: [] }));
    e.list.push(b);
  }
  const stats: BuildStats = { buildings: 0, chunks: 0, meshes: 0, trisLod0: 0, trisLod1: 0, trisCommon: 0, windows: 0, ms: 0 };
  const chunks: Chunk[] = [];
  const total = recipe.buildings?.length ?? 0;
  let done = 0;
  let lastYield = performance.now();
  for (const e of byChunk.values()) {
    const B = newBuckets();
    for (const b of e.list) {
      try {
        stats.windows += generateBuilding(B, b, recipe.region);
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
    const ch = makeChunk(e.cx, e.cz, CH, B, surfM, glassM, signM, stats);
    chunks.push(ch);
    group.add(ch.group);
  }
  refreshSigns();
  stats.chunks = chunks.length;
  stats.ms = performance.now() - t0;
  onProgress('Raising buildings', 1);
  console.info(`[buildings] ${stats.buildings} buildings, ${stats.chunks} chunks, ${stats.meshes} meshes, tris lod0 ${stats.trisLod0} lod1 ${stats.trisLod1} common ${stats.trisCommon}, ${stats.windows} windows, ${stats.ms.toFixed(0)} ms`);

  const camPos = new THREE.Vector3();
  const setLod = (cam: THREE.Camera) => {
    cam.getWorldPosition(camPos);
    for (const c of chunks) {
      const dx = Math.max(0, Math.abs(camPos.x - c.cx) - c.radius), dz = Math.max(0, Math.abs(camPos.z - c.cz) - c.radius);
      const d = Math.hypot(dx, dz, Math.max(0, camPos.y - 60) * 0.5);
      const near = c.near ? d < lodD + 30 : d < lodD - 30;
      if (near !== c.near) { c.near = near; c.lod0.visible = near; c.lod1.visible = !near; }
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
      setLod(g.camera);
      if (g.sky && typeof g.sky.nightFactor === 'number') setNightFactor(g.sky.nightFactor);
    },
  };
}

export { U as buildingUniforms };

function makeChunk(cx: number, cz: number, CH: number, B: Buckets, surfM: THREE.Material, glassM: THREE.Material, signM: THREE.Material, stats: BuildStats): Chunk {
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
  add(lod0, B.s[0].build(), surfM, true, 'l0');
  add(lod0, B.g[0].build(), glassM, false, 'l0');
  add(lod1, B.s[1].build(), surfM, true, 'l1');
  add(lod1, B.g[1].build(), glassM, false, 'l1');
  add(common, B.s[2].build(), surfM, true, 'c');
  add(common, B.g[2].build(), glassM, false, 'c');
  add(common, B.sign.build(), signM, false, 'c');
  lod1.visible = false;
  group.add(lod0, lod1, common);
  return { cx, cz, radius: CH / 2, group, lod0, lod1, near: true };
}

function yieldUI(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
