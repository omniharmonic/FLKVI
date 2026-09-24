import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Recipe } from '../core/types';
import type { RigidBody } from '@dimforge/rapier3d-compat';
import { Heightfield, bakeLandMask, terrainMaterial, buildTerrainMeshes, updateTerrainLod } from './terrain';
import { RoadNetwork } from './roads';
import { ChunkBatcher, Grid, pointInPoly, yieldFrame } from './util';
import { surfaceMaterial } from './materials';
import { buildFromRecipe, type BuildingsResult } from './buildings';
import { buildTerrainCollider, buildBuildingColliders, buildMeshColliders, buildPropColliders } from './physics';
import { buildAreas } from './areas';
import { TreeSystem } from './trees';
import { PropSystem } from './props';
import { clipGeometry } from './clip';
import { unregisterShadowProxy } from '../render/shadowProxy';
import type { Bounds } from './stream-coordinates';

export interface District {
  key: string; bounds: Bounds; recipe: Recipe; root: THREE.Group; hf: Heightfield;
  groundAt(x: number, z: number): number;
  coverAt(x: number, z: number): number;
  update(dt: number): void;
  dispose(): void;
}
/** A district owns its geometry, instance buffers and rigid bodies; common asset materials stay shared. */
export async function buildDistrict(g: Game, key: string, recipe: Recipe, seamHeight: (x: number, z: number) => number | undefined): Promise<District> {
  const root = new THREE.Group(); root.name = `district:${key}`;
  const hf = Heightfield.fromTerrain(recipe.terrain), roads = new RoadNetwork(recipe);
  const bodies: RigidBody[] = [], ownedMaterials = new Set<THREE.Material>();
  let buildings: BuildingsResult | undefined;
  let props: PropSystem | undefined;
  const trees = new TreeSystem();
  const mask = bakeLandMask(recipe, hf);
  const dispose = () => {
    root.removeFromParent();
    for (const b of bodies) if (b.isValid()) g.physics.removeRigidBody(b);
    trees.dispose();
    props?.disposeMaterials();
    root.traverse(o => {
      unregisterShadowProxy(g, o);
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
      if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    });
    for (const m of ownedMaterials) m.dispose();
    mask.tex.dispose(); mask.hard.dispose();
    root.clear();
  };
  try {
    roads.analyze(); roads.flattenTerrain(hf);
    const B = new ChunkBatcher(200), water = new THREE.Group();
    const buildingGrid = new Grid<Recipe['buildings'][number]>(32);
    for (const b of recipe.buildings) {
      const xs = b.footprint.map(p => p[0]), zs = b.footprint.map(p => p[1]);
      buildingGrid.addBox(Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), b);
    }
    const inBuilding = (x: number, z: number) => {
      let hit = false;
      buildingGrid.query(x, z, 0, b => { if (!hit && pointInPoly(x, z, b.footprint)) hit = true; });
      return hit;
    };
    buildAreas(recipe, B, hf, roads, water, inBuilding);
    // Seam vertices agree exactly with already resident terrain; feather the correction over 24 m.
    for (let r=0;r<hf.rows;r++)for(let c=0;c<hf.cols;c++) {
      const x=hf.ox+c*hf.cell,z=hf.oz+r*hf.cell;
      const edges: [number,number,number][]=[[x,hf.oz,z-hf.oz],[x,hf.maxZ,hf.maxZ-z],[hf.ox,z,x-hf.ox],[hf.maxX,z,hf.maxX-x]];
      let sum=0,weight=0;
      for(const [sx,sz,d] of edges)if(d<24){const y=seamHeight(sx,sz);if(y!==undefined){const w=(1-d/24)**2;sum+=(y-hf.sample(sx,sz))*w;weight+=w;}}
      if(weight>0)hf.h[r*hf.cols+c]+=sum/Math.max(1,weight);
    }
    roads.build(B,hf,recipe.props.filter(p=>p.type==='crosswalk').map(p=>p.p));
    const groundAt=(x:number,z:number)=>{const s=roads.surfaceAt(x,z);return s?.kind==='deck'?s.y:Math.max(hf.sample(x,z),s?.y??-Infinity);};
    // Set bases against the actual rendered terrain, not the source DEM.
    for(const b of recipe.buildings)if(!b.minHeight)b.baseY=Math.max(...b.footprint.map(p=>hf.sample(...p)));
    const concrete=surfaceMaterial('concrete',{roughness:1,patch:{joints:1.52,antiTile:true}});
    const asphalt=surfaceMaterial('asphalt',{roughness:1,patch:{macro:0.12,antiTile:true}});
    const gravel=surfaceMaterial('gravel'), paving=surfaceMaterial('paving');
    const marking=new THREE.MeshStandardMaterial({vertexColors:true,roughness:0.8,polygonOffset:true,polygonOffsetFactor:-4});
    const rail=new THREE.MeshStandardMaterial({color:0x606568,metalness:0.6,roughness:0.5,side:THREE.DoubleSide});
    const mats={asphalt,lot:asphalt,sidewalk:concrete,curb:concrete,footway:concrete,gravel,paving,bridgeRail:rail,marking};
    Object.values(mats).forEach(m=>ownedMaterials.add(m));
    const meshes=B.emit(root,mats,{receiveShadow:true,castShadow:{bridgeRail:true},renderOrder:{marking:1}});
    root.add(water);
    water.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh)meshes.push(m);});
    for(const m of meshes){const old=m.geometry;m.geometry=clipGeometry(old,recipe.bounds);old.dispose();}
    const tm=terrainMaterial(recipe,mask);ownedMaterials.add(tm);
    const terrain=buildTerrainMeshes(hf,tm);root.add(...terrain);
    await yieldFrame();
    buildings=await buildFromRecipe(recipe,()=>{},{},g.quality);root.add(buildings.group);
    props=new PropSystem(recipe,roads,groundAt,inBuilding);props.build();root.add(props.group);
    trees.focus=[g.player.position.x,g.player.position.z];trees.eagerDist=100;trees.sunDir=g.sky?.sunDirection??null;
    await trees.build(recipe.trees.filter(t=>!inBuilding(...t.p)).map(t=>({...t,y:groundAt(...t.p)})),g.renderer);
    await trees.finishLoad();root.add(trees.group);
    // All collision attachment is synchronous: a frame sees either the complete district or none of it.
    bodies.push(buildTerrainCollider(g,hf).parent()!);
    bodies.push(buildBuildingColliders(g,recipe.buildings));
    bodies.push(buildMeshColliders(g,meshes.filter(m=>!/^(marking|water)/.test(m.name))));
    bodies.push(buildPropColliders(g,props.colliders,trees.trunks));
    g.scene.add(root);
    return {key,bounds:recipe.bounds,recipe,root,hf,groundAt,
      coverAt(x,z){let y=groundAt(x,z);buildingGrid.query(x,z,0,b=>{if(pointInPoly(x,z,b.footprint))y=Math.max(y,b.baseY+b.height+b.roofHeight);});return y;},
      dispose,update(dt){
      buildings!.setNightFactor(g.sky.nightFactor);buildings!.update?.(dt,g);
      props!.setNightFactor(g.sky.nightFactor);props!.update(g.elapsed,g.camera);
      trees.fullDist=g.quality==='high'?42:26;trees.nearDist=g.quality==='high'?120:80;trees.update(dt,g.camera,g.elapsed);
      updateTerrainLod(terrain,g.camera.position);
    }};
  } catch(e){dispose();throw e;}
}
