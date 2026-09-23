// OWNER: world agent. Assembles the Recipe into meshes + physics colliders, provides WorldAPI.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Progress } from '../core/location';
import type { WorldAPI } from '../core/api';
import type { Vec2, Vec3, RecipeTree } from '../core/types';
import { preloadLibrary } from '../assets/library';
import { buildBuildings, type BuildingsResult } from './buildings';
import { makeFineHeightfield, bakeLandMask, terrainMaterial, buildTerrainMeshes, buildFarTerrain } from './terrain';
import { RoadNetwork } from './roads';
import { buildAreas, waterUniforms } from './areas';
import { ChunkBatcher, Grid, pointInPoly, yieldFrame } from './util';
import { surfaceMaterial, ensureSurfaces } from './materials';
import { markingWearTexture } from './textures';
import { PropSystem } from './props';
import { buildRoadDecals } from './decals';
import { TreeSystem } from './trees';
import { buildTerrainCollider, buildBuildingColliders, buildPropColliders, makeLos } from './physics';
import { Nav } from './nav';

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
  await ensureSurfaces(['decal-cracks', 'decal-oil', 'decal-manhole', 'asphalt', 'asphalt-patched', 'concrete', 'concrete-sidewalk', 'curb', 'grass', 'grass-dry', 'dirt', 'gravel', 'paving']);
  const hf = makeFineHeightfield(recipe.terrain);
  const roads = new RoadNetwork(recipe);
  roads.analyze();
  roads.flattenTerrain(hf);

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

  P('Paving streets', 0.22);
  await yieldFrame();
  const B = new ChunkBatcher(180);
  const waterGroup = new THREE.Group(); waterGroup.name = 'water';
  buildAreas(recipe, B, hf, roads, waterGroup, inBuilding); // also carves water beds into hf
  const crosswalks = recipe.props.filter((p) => p.type === 'crosswalk').map((p) => p.p);
  roads.build(B, hf, crosswalks);

  const mats: Record<string, THREE.Material> = {
    asphalt: surfaceMaterial('asphalt', { tint: new THREE.Color(2.1, 2.08, 2.05), roughness: 1, polygonOffset: -1, patch: { macro: 0.14, macroScale: 26, antiTile: true, tintVar: new THREE.Color(1.25, 1.24, 1.22), tintAmt: 0.5 } }),
    lot: surfaceMaterial('asphalt', { tint: new THREE.Color(2.3, 2.28, 2.25), roughness: 1, polygonOffset: -1, patch: { macro: 0.14, macroScale: 15, antiTile: true } }),
    sidewalk: surfaceMaterial('concrete', { tint: new THREE.Color(1.75, 1.7, 1.62), roughness: 1, patch: { joints: 1.52, macro: 0.07, macroScale: 12, antiTile: true } }),
    curb: surfaceMaterial('concrete', { tint: new THREE.Color(1.85, 1.82, 1.76), roughness: 1, patch: { macro: 0.06 } }),
    footway: surfaceMaterial('concrete', { tint: new THREE.Color(1.7, 1.66, 1.6), polygonOffset: -1, patch: { joints: 1.52, macro: 0.1, antiTile: true } }),
    gravel: surfaceMaterial('gravel', { polygonOffset: -1, patch: { macro: 0.12 } }),
    paving: surfaceMaterial('paving', { polygonOffset: -2, patch: { macro: 0.1, antiTile: true } }),
    bridgeRail: new THREE.MeshStandardMaterial({ color: 0x5a5f63, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }),
  };
  const wear = markingWearTexture().clone();
  wear.repeat.set(1 / 4, 1 / 4); wear.needsUpdate = true;
  mats.marking = new THREE.MeshStandardMaterial({
    map: wear, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.62,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  mats.marking.name = 'marking';

  const roadGroup = new THREE.Group(); roadGroup.name = 'roads';
  B.emit(roadGroup, mats, { receiveShadow: true, castShadow: { curb: true, bridgeRail: true }, renderOrder: { marking: 1 } });
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
    try { terrainGroup.add(buildFarTerrain(recipe.farTerrain, hf)); } catch (e) { console.warn('[world] far terrain failed', e); }
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
  const nav = new Nav(recipe.graph, roads);
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

  // ---- props
  P('Placing street furniture', 0.36);
  await yieldFrame();
  props.build();
  root.add(props.group);

  // ---- trees (+ shrubs from props)
  P('Planting trees', 0.45);
  const treeList: RecipeTree[] = recipe.trees.slice();
  for (const p of recipe.props) {
    if (p.type !== 'shrub') continue;
    const h = 0.9 + ((p.variant * 0.37) % 1) * 0.9;
    treeList.push({ p: p.p, y: groundAt(p.p[0], p.p[1]), species: 'shrub', height: h, crown: h * 1.4, seed: (p.p[0] * 131 + p.p[1] * 71) | 0 });
  }
  try { await trees.build(treeList, g.renderer, (f) => P('Planting trees', 0.45 + f * 0.2)); } catch (e) { console.error('[world] trees failed', e); }
  root.add(trees.group);

  // ---- buildings (owned by buildings agent)
  P('Raising buildings', 0.66);
  await yieldFrame();
  try {
    buildings = await buildBuildings(g, (s, f) => P(s, 0.66 + f * 0.24));
    root.add(buildings.group);
    staticMeshes.push(buildings.group);
  } catch (e) { console.error('[world] buildings failed', e); }

  // ---- physics
  P('Solidifying the city', 0.92);
  await yieldFrame();
  if (g.physics && g.rapier) {
    try {
      buildTerrainCollider(g, hf);
      buildBuildingColliders(g, recipe.buildings);
      buildPropColliders(g, props.colliders, trees.trunks);
      los = makeLos(g);
    } catch (e) { console.error('[world] physics failed', e); }
  }

  setNight(0);
  g.addSystem({
    name: 'world',
    order: 50,
    update(dt, game) {
      if (!externalNight && game.sky) setNight(game.sky.nightFactor);
      waterUniforms.uTime.value = game.elapsed;
      trees.update(dt, game.camera, game.elapsed);
      props.update(game.elapsed, game.camera);
      buildings?.update?.(dt, game);
    },
  });
  P('done', 1);
  console.info('[world] stage ms: ' + times.join(' | '));
  console.info(`[world] built in ${(performance.now() - t0).toFixed(0)} ms: ${roads.chains.length} road chains, ${roads.junctions.size} junctions, ${treeList.length} trees, ${props.lamps.length} lamps`);
  P('World ready', 1);
}
