// OWNER: world agent. Assembles the Recipe into meshes + physics colliders, provides WorldAPI.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Progress } from '../core/location';
import type { WorldAPI } from '../core/api';
import type { Vec2, Vec3, RecipeTree } from '../core/types';
import { preloadLibrary } from '../assets/library';
import { buildBuildings, type BuildingsResult } from './buildings';
import { setFrontInfo } from './buildings/streetDetail';
import { makeFineHeightfield, bakeLandMask, terrainMaterial, buildTerrainMeshes, buildFarTerrain, updateTerrainLod } from './terrain';
import { RoadNetwork } from './roads';
import { buildAreas, waterUniforms } from './areas';
import { ChunkBatcher, Grid, pointInPoly, yieldFrame } from './util';
import { surfaceMaterial, ensureSurfaces } from './materials';
import { roadMaterials } from './road-materials';
import { PropSystem } from './props';
import { buildRoadDecals } from './decals';
import { TreeSystem } from './trees';
import { buildUnderstory, paintPlantingBeds } from './understory';
import { buildTerrainCollider, buildBuildingColliders, buildPropColliders, buildMeshColliders, buildWallColliders, makeLos } from './physics';
import { Nav } from './nav';
import { GroundCover } from './ground-cover';
import { WorldStreaming } from './streaming';
import { resolveLandmarks, buildLandmarks, type LandmarksResult } from './landmarks';
import { buildRetainingWalls, type WallBox } from './retaining';
import { settleFoundations, type Prism } from './foundations';
import { releaseAfterUpload, uploadNow } from '../render/memory';
import { registerShadowDistance, registerInstancedShadowLod, registerShadowProxy, setShadowCascades } from '../render/shadowProxy';

export { GROUP_STATIC, GROUP_PROPS, LOS_QUERY_GROUPS, groups as collisionGroups } from './physics';

export async function buildWorld(g: Game, onProgress: Progress): Promise<void> {
  const recipe = g.recipe;
  const t0 = performance.now();
  const times: string[] = [];
  let tl = performance.now(), lastStage = 'init';
  const P = (s: string, f: number) => {
    if (s !== lastStage) { const n = performance.now(); times.push(`${lastStage} ${(n - tl).toFixed(0)}`); tl = n; lastStage = s; }
    onProgress(s, Math.max(0, Math.min(1, f)));
  };
  P('Loading materials', 0);
  try { await preloadLibrary((f) => P('Loading materials', f * 0.15)); } catch (e) { console.warn('[world] preloadLibrary failed', e); }

  const root = new THREE.Group();
  root.name = 'world';
  g.scene.add(root);

  // ---- ground data
  P('Shaping terrain', 0.16);
  await yieldFrame();
  await ensureSurfaces(['decal-cracks', 'decal-oil', 'decal-manhole', 'asphalt', 'asphalt-patched', 'concrete', 'concrete-sidewalk', 'curb', 'grass', 'grass-dry', 'dirt', 'gravel', 'paving', 'stone', 'sandstone']);
  const hf = makeFineHeightfield(recipe.terrain, recipe.bounds);
  const h0 = hf.h.slice();
  const roads = new RoadNetwork(recipe);
  roads.analyze();
  const flat = roads.flattenTerrain(hf);

  // building footprint index (placement checks)
  const bGrid = new Grid<number>(50);
  recipe.buildings.forEach((b, i) => {
    if (!b.footprint?.length) return;
    const xs = b.footprint.map((p) => p[0]), zs = b.footprint.map((p) => p[1]);
    bGrid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), i);
  });
  const inBuilding = (x: number, z: number) => {
    let hit = false;
    bGrid.query(x, z, 0, (i) => { if (!hit && pointInPoly(x, z, recipe.buildings[i].footprint)) hit = true; });
    return hit;
  };

  // hand-built landmarks replace some OSM buildings and keep their plazas clear (src/world/landmarks)
  const lm = resolveLandmarks(recipe);

  P('Paving streets', 0.22);
  await yieldFrame();
  const B = new ChunkBatcher(320); // perf: bigger chunks = fewer draw calls (ground tris are cheap)
  // retaining walls where a street's grade leaves the ground beside it (undo the smeared flatten blend there)
  let wallBoxes: WallBox[] = [];
  try {
    const rw = buildRetainingWalls(roads, hf, h0, flat, inBuilding, B);
    wallBoxes = rw.boxes;
    console.info(`[world] retaining walls: ${rw.walls} runs, ${rw.length.toFixed(0)} m`);
  } catch (e) { console.warn('[world] retaining walls failed', e); }
  const waterGroup = new THREE.Group(); waterGroup.name = 'water';
  buildAreas(recipe, B, hf, roads, waterGroup, inBuilding); // also carves water beds into hf
  const crosswalks = recipe.props.filter((p) => p.type === 'crosswalk').map((p) => p.p);
  roads.build(B, hf, crosswalks);
  // seat buildings / landmarks on the rendered ground (street-frontage level) with plinths where it falls away
  let prisms: Prism[] = [];
  try {
    const fd = settleFoundations(recipe, hf, roads, lm, B);
    prisms = fd.prisms;
    console.info(`[world] foundations: ${fd.moved} re-seated, ${fd.plinths} plinths (max ${fd.maxLift.toFixed(1)} m at ${fd.worst}), ${fd.clamped} sunk, ${fd.dropped} dropped over-tall`);
  } catch (e) { console.warn('[world] foundations failed', e); }

  const mats: Record<string, THREE.Material> = {
    ...roadMaterials(),
    retainWall: surfaceMaterial('concrete', { tint: new THREE.Color(1.5, 1.47, 1.4), roughness: 1, patch: { macro: 0.14, macroScale: 5, antiTile: true, tintVar: new THREE.Color(0.78, 0.77, 0.72), tintAmt: 0.5 } }),
    plinthConc: surfaceMaterial('concrete', { tint: new THREE.Color(1.55, 1.52, 1.45), roughness: 1, patch: { macro: 0.1, macroScale: 4, antiTile: true } }),
    plinthStone: surfaceMaterial('stone', { tint: new THREE.Color(0.86, 0.84, 0.8), roughness: 1, patch: { macro: 0.12, macroScale: 6 } }),
  };

  const roadGroup = new THREE.Group(); roadGroup.name = 'roads';
  const roadMeshes = B.emit(roadGroup, mats, { receiveShadow: true, castShadow: { curb: true, bridgeRail: true, retainWall: true, plinthConc: true, plinthStone: true }, renderOrder: { marking: 1 } });
  // perf: curb shadows only near the camera; bridge rails a bit further
  for (const m of roadMeshes) if (m.castShadow) registerShadowDistance(g, m, m.name.startsWith('curb') ? 70 : 200);
  root.add(roadGroup, waterGroup);
  try { roadGroup.add(buildRoadDecals(roads, recipe.props.filter((p) => p.type === 'manhole').map((p) => p.p), (x, z) => roads.surfaceAt(x, z)?.y ?? hf.sample(x, z))); } catch (e) { console.warn('[world] decals failed', e); }

  // ---- terrain
  P('Growing ground cover', 0.3);
  await yieldFrame();
  const mask = bakeLandMask(recipe, hf);
  const tmat = terrainMaterial(recipe, mask);
  const terrainGroup = new THREE.Group(); terrainGroup.name = 'terrain';
  const terrainMeshes = buildTerrainMeshes(hf, tmat);
  for (const m of terrainMeshes) { m.updateMatrix(); terrainGroup.add(m); }
  if (recipe.farTerrain) {
    try { terrainGroup.add(buildFarTerrain(recipe.farTerrain, hf, recipe)); } catch (e) { console.warn('[world] far terrain failed', e); }
  }
  root.add(terrainGroup);

  // ---- API (published early so buildings/props can query ground)
  const groundAt = (x: number, z: number) => {
    const t = hf.sample(x, z);
    const s = roads.surfaceAt(x, z);
    if (!s) return t;
    if (s.kind === 'deck') return s.y;
    return Math.max(t, s.y);
  };
  const nav = new Nav(recipe.graph, roads, inBuilding);
  const staticMeshes: THREE.Object3D[] = [...terrainMeshes];
  let buildings: BuildingsResult | null = null;
  const props = new PropSystem(recipe, roads, groundAt, inBuilding);
  const trees = new TreeSystem();
  let night = -1;
  const setNight = (f: number) => {
    f = Math.max(0, Math.min(1, f));
    if (Math.abs(f - night) < 1e-3) return;
    night = f;
    props.setNightFactor(f);
    buildings?.setNightFactor(f);
  };
  let los: ((a: Vec3, b: Vec3) => boolean) | null = null;
  const api: WorldAPI = {
    heightAt: (x, z) => hf.sample(x, z),
    groundAt,
    coverAt:(x,z)=>{let y=groundAt(x,z);bGrid.query(x,z,0,i=>{const b=recipe.buildings[i];if(pointInPoly(x,z,b.footprint))y=Math.max(y,b.baseY+b.height+b.roofHeight);});return y;},
    losBlocked: (a, b) => (los ? los(a, b) : false),
    nearestNode: (p: Vec2) => nav.nearestNode(p),
    route: (a, b) => nav.route(a, b),
    randomSidewalkPoint: (near, radius, rnd) => nav.randomSidewalkPoint(near, radius, rnd),
    staticMeshes,
    setNightFactor: (f) => { externalNight = true; setNight(f); },
  };
  let externalNight = false;
  g.world = api;
  (api as any).roads = roads; // debug
  (api as any).walls = wallBoxes; // debug

  // ---- props
  P('Placing street furniture', 0.36);
  await yieldFrame();
  props.build();
  root.add(props.group);
  // perf: street furniture casts sun shadows only near the camera (tall poles a bit further)
  for (const o of props.group.children) {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || !im.castShadow) continue;
    if (!im.geometry.boundingSphere) im.geometry.computeBoundingSphere();
    registerInstancedShadowLod(g, im, im.geometry.boundingSphere!.radius > 2 ? 130 : 55);
  }
  (api as any).signalMasts = props.masts; // surveillance mounts signal-mast clusters on these

  // ---- trees (+ shrubs from props)
  P('Planting trees', 0.45);
  await yieldFrame(); // load time: split the props / understory / trees work into separate tasks
  // Street trees: keep the carriageway and the sidewalk walking path clear (snap onto the curb-side
  // tree lawn), and keep a clear zone around the player spawn.
  const sp = recipe.spawn.p;
  const treeList: RecipeTree[] = [];
  let moved = 0, dropped = 0;
  for (const t0 of recipe.trees) {
    const t = { ...t0, p: [t0.p[0], t0.p[1]] as Vec2 };
    if (Math.hypot(t.p[0] - sp[0], t.p[1] - sp[1]) < 5 || lm.clearAt(t.p[0], t.p[1])) { dropped++; continue; }
    const h = roads.nearestChain(t.p, 25);
    if (h && !h.c.internal) {
      const a = Math.abs(h.off), c = h.c;
      if (a < c.w + 0.3) { dropped++; continue; }
      if (c.s > 0 && a < c.w + c.s) {
        const target = c.w + Math.min(0.6, c.s * 0.3);
        const q = roads.chainPoint(c, h.s);
        const sg = Math.sign(h.off) || 1;
        t.p = [q.x - q.dz * target * sg, q.z + q.dx * target * sg];
        t.y = groundAt(t.p[0], t.p[1]);
        moved++;
      }
    }
    if (inBuilding(t.p[0], t.p[1])) { dropped++; continue; }
    treeList.push(t);
  }
  console.info(`[world] trees: ${moved} snapped to curb, ${dropped} dropped`);
  for (const p of recipe.props) {
    if (p.type !== 'shrub') continue;
    const h = 0.9 + ((p.variant * 0.37) % 1) * 0.9;
    treeList.push({ p: p.p, y: groundAt(p.p[0], p.p[1]), species: 'shrub', height: h, crown: h * 1.4, seed: (p.p[0] * 131 + p.p[1] * 71) | 0 });
  }
  await yieldFrame();
  try {
    const under = buildUnderstory({ recipe, groundAt, inBuilding, roads }, treeList);
    paintPlantingBeds(mask, under);
    treeList.push(...under);
  } catch (e) { console.warn('[world] understory failed', e); }
  if (g.sky) trees.sunDir = g.sky.sunDirection;
  trees.spanishMoss = recipe.origin.lon > -95.5 && recipe.origin.lat > 27.5 && recipe.origin.lat < 34 && recipe.climate === 'humid';
  // load time: only species growing near the spawn are generated behind the loading screen; the rest
  // stream in after the game starts (trees.update), so meshes are configured as they are created
  await yieldFrame();
  trees.focus = [sp[0], sp[1]];
  let treeProxyFailed = false;
  trees.onMesh = (m, ring) => {
    // mid-ring trees cast through shadow-only impostors; if proxies are unsupported, mid leaves cast directly
    if (ring === 'mid' && treeProxyFailed) m.castShadow = true;
    // perf: full-detail trees (< ~50 m) only need to cast into the near sun cascade
    if (m.castShadow) setShadowCascades(g, m, 1);
  };
  try { await trees.build(treeList, g.renderer, (f) => P('Planting trees', 0.45 + f * 0.2)); } catch (e) { console.error('[world] trees failed', e); }
  root.add(trees.group);
  if (trees.shadowImpostors && !registerShadowProxy(g, trees.shadowImpostors)) {
    treeProxyFailed = true;
    trees.group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith('tree_') && o !== trees.shadowImpostors && o.name !== 'tree_impostors') { o.castShadow = true; setShadowCascades(g, o, 1); } });
  }

  // ---- buildings (owned by buildings agent)
  P('Raising buildings', 0.66);
  await yieldFrame();
  // sidewalk depth in front of facades (storefront clutter placement)
  let landmarks: LandmarksResult | null = null;
  setFrontInfo((x, z) => {
    const h = roads.nearestChain([x, z], 30);
    const y = groundAt(x, z);
    if (!h) return { clear: 5, y };
    if (h.c.cls === 'pedestrian' || h.c.cls === 'footway' || h.c.cls === 'path') return { clear: 8, y };
    return { clear: Math.abs(h.off) + 1.2 - h.c.w - 0.6, y };
  });
  try {
    buildings = await buildBuildings(g, (s, f) => P(s, 0.66 + f * 0.24), { skip: lm.skip });
    root.add(buildings.group);
    staticMeshes.push(buildings.group);
  } catch (e) { console.error('[world] buildings failed', e); }
  setFrontInfo(null);
  try {
    landmarks = buildLandmarks(g, lm);
    root.add(landmarks.group);
    staticMeshes.push(landmarks.group);
  } catch (e) { console.error('[world] landmarks failed', e); }

  // impostor tiles for the trees (their shader compile ran in parallel with the buildings)
  try { await trees.finishLoad(); } catch (e) { console.warn('[world] tree impostors failed', e); }

  // ---- physics
  P('Solidifying the city', 0.92);
  await yieldFrame();
  if (g.physics && g.rapier) {
    try {
      buildTerrainCollider(g, hf);
      buildBuildingColliders(g, lm.skip.size ? recipe.buildings.filter((b) => !lm.skip.has(b.id)) : recipe.buildings);
      buildPropColliders(g, props.colliders, trees.trunks);
      buildMeshColliders(g, roadMeshes.filter((m) => /^(asphalt|sidewalk|curb|paving|footway|gravel|bridgeRail)\|/.test(m.name)));
      buildWallColliders(g, wallBoxes, prisms);
      los = makeLos(g);
    } catch (e) { console.error('[world] physics failed', e); }
  }
  // memory: static ground/road/building geometry is never read back on the CPU once colliders exist
  // → drop the typed arrays as soon as they reach the GPU (buildings release their own chunks)
  releaseAfterUpload(terrainGroup);
  releaseAfterUpload(roadGroup);
  releaseAfterUpload(waterGroup);
  // push static geometry to the GPU now (behind the loading screen) so the CPU copies are freed even
  // for chunks that are off-screen at spawn
  try { uploadNow(g.renderer, root); } catch (e) { console.warn('[world] upload failed', e); }
  // load time: start compiling the world's shader programs now (in parallel where the browser supports
  // KHR_parallel_shader_compile) so gameplay/AI/surveillance setup overlaps it and the first frame doesn't
  // stall on them. Compiled against an offscreen target: the composer renders the scene into one, and
  // program variants depend on the target's colour space / tone mapping.
  try {
    const rt = new THREE.WebGLRenderTarget(1, 1);
    const prev = g.renderer.getRenderTarget();
    g.renderer.setRenderTarget(rt);
    const warm = g.renderer.compileAsync(g.scene, g.camera);
    g.renderer.setRenderTarget(prev);
    warm.catch(() => {}).finally(() => rt.dispose());
  } catch (e) { console.warn('[world] shader warm-up failed', e); }

  setNight(0);
  g.addSystem({
    name: 'world',
    order: 50,
    update(dt, game) {
      if (!externalNight && game.sky) setNight(game.sky.nightFactor);
      waterUniforms.uTime.value = game.elapsed;
      trees.fullDist = game.quality === 'high' ? 48 : game.quality === 'medium' ? 34 : 24;
      trees.nearDist = game.quality === 'high' ? 150 : game.quality === 'medium' ? 105 : 75;
      trees.update(dt, game.camera, game.elapsed);
      updateTerrainLod(terrainMeshes, game.camera.position);
      props.update(game.elapsed, game.camera);
      buildings?.update?.(dt, game);
      landmarks?.update(game);
    },
  });
  g.addSystem(new WorldStreaming(g, hf));
  g.addSystem(new GroundCover(g));
  P('done', 1);
  console.info('[world] stage ms: ' + times.join(' | '));
  console.info(`[world] built in ${(performance.now() - t0).toFixed(0)} ms: ${roads.chains.length} road chains, ${roads.junctions.size} junctions, ${treeList.length} trees, ${props.lamps.length} lamps`);
  P('World ready', 1);
}
