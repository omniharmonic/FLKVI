// Geographic world packages, shared by the offline baker and the background runtime loader.
import type { Recipe, Terrain, Vec2 } from '../core/types.ts';
import { makeProjection } from '../core/geo.ts';
import { terrainSampler } from './terrain.ts';
import { contains, type Bounds } from '../world/stream-coordinates.ts';
export const WORLD_CHUNK_SIZE = 400;
export interface WorldFile { url: string; bytes: number; sha256: string }
export interface WorldRegion {
  id: string; name: string; origin: Recipe['origin']; bounds: Bounds; elevation: number;
  region: Recipe['region']; climate: Recipe['climate']; biome?: Recipe['biome']; tier: Recipe['tier'];
  spawn: Recipe['spawn']; attribution: string[]; chunks: Record<string, WorldFile>; backdrop?: WorldFile;
}
export interface WorldManifest { version: 1; revision: string; regions: WorldRegion[] }
export function chunkKeys(bounds: Bounds): string[] {
  const keys: string[] = [], S = WORLD_CHUNK_SIZE;
  for (let z = Math.floor(bounds.minZ / S); z <= Math.floor((bounds.maxZ - 1e-6) / S); z++)
    for (let x = Math.floor(bounds.minX / S); x <= Math.floor((bounds.maxX - 1e-6) / S); x++) keys.push(`${x},${z}`);
  return keys;
}
export function chunkBounds(key: string): Bounds {
  const [x,z] = key.split(',').map(Number), S = WORLD_CHUNK_SIZE;
  return { minX:x*S, minZ:z*S, maxX:(x+1)*S, maxZ:(z+1)*S };
}
export function regionalBounds(region: WorldRegion, origin: Recipe['origin'], bounds: Bounds): Bounds {
  const a=makeProjection(origin.lat,origin.lon), b=makeProjection(region.origin.lat,region.origin.lon);
  const move=(x:number,z:number)=>{const ll=a.toLatLon(x,z);return b.toLocal(ll.lat,ll.lon);};
  const min=move(bounds.minX,bounds.minZ),max=move(bounds.maxX,bounds.maxZ);
  return {minX:min[0],minZ:min[1],maxX:max[0],maxZ:max[1]};
}
export function selectRegion(manifest: WorldManifest, lat: number, lon: number): WorldRegion | undefined {
  return manifest.regions.filter(r=>contains(r.bounds,...makeProjection(r.origin.lat,r.origin.lon).toLocal(lat,lon)))
    .sort((a,b)=>Math.hypot(a.origin.lat-lat,(a.origin.lon-lon)*Math.cos(lat*Math.PI/180))-Math.hypot(b.origin.lat-lat,(b.origin.lon-lon)*Math.cos(lat*Math.PI/180)))[0];
}
function intersects(points: readonly Vec2[], b: Bounds, margin=0): boolean {
  let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
  for(const [x,z] of points){minX=Math.min(minX,x);minZ=Math.min(minZ,z);maxX=Math.max(maxX,x);maxZ=Math.max(maxZ,z);}
  return minX<=b.maxX+margin && maxX>=b.minX-margin && minZ<=b.maxZ+margin && maxZ>=b.minZ-margin;
}
/** Retain whole source features so neighboring packages can deduplicate them exactly before clipping.
 * This keeps road junction inference and building ownership independent of the download boundaries. */
export function makeWorldChunk(source: Recipe, bounds: Bounds): Recipe {
  const roads=source.roads.filter(r=>intersects(r.pts,bounds,40)), ids=new Set(roads.map(r=>r.id));
  const graph:Recipe['graph']={nodes:[],edges:[]}, nodes=new Map<number,number>();
  const node=(i:number)=>{let id=nodes.get(i);if(id===undefined){id=graph.nodes.length;nodes.set(i,id);graph.nodes.push(source.graph.nodes[i]);}return id;};
  for(const edge of source.graph.edges)if(ids.has(edge.roadId))graph.edges.push({...edge,from:node(edge.from),to:node(edge.to)});
  const cellSize=4, ox=bounds.minX-4, oz=bounds.minZ-4;
  const cols=Math.ceil((bounds.maxX-bounds.minX+8)/cellSize)+1,rows=Math.ceil((bounds.maxZ-bounds.minZ+8)/cellSize)+1;
  const sample=terrainSampler(source.terrain);
  const terrain:Terrain={cols,rows,cellSize,originX:ox,originZ:oz,heights:Array.from({length:cols*rows},(_,i)=>sample(ox+i%cols*cellSize,oz+Math.floor(i/cols)*cellSize))};
  return {...source,bounds,terrain,farTerrain:undefined,roads,graph,
    buildings:source.buildings.filter(v=>intersects(v.footprint,bounds)),
    areas:source.areas.filter(v=>intersects(v.poly,bounds)),
    trees:source.trees.filter(v=>contains(bounds,...v.p)),props:source.props.filter(v=>contains(bounds,...v.p)),
    cameras:source.cameras.filter(v=>contains(bounds,...v.p))};
}
/** Assemble only requested data. Runs in the worker, never in the gameplay animation loop. */
export function assembleWorldChunks(chunks: Recipe[], region: WorldRegion, bounds: Bounds): Recipe {
  if(!chunks.length)throw Error('Empty world package');
  const unique=<T>(items:T[],key:(item:T)=>string):T[]=>[...new Map(items.map(v=>[key(v),v])).values()];
  const roads=unique(chunks.flatMap(c=>c.roads),r=>r.id);
  const graph:Recipe['graph']={nodes:[],edges:[]}, nodes=new Map<number,number>(), edges=new Set<string>();
  for(const chunk of chunks){const remap=chunk.graph.nodes.map(n=>{let i=nodes.get(n.id);if(i===undefined){i=graph.nodes.length;nodes.set(n.id,i);graph.nodes.push(n);}return i;});
    for(const e of chunk.graph.edges){const from=remap[e.from],to=remap[e.to],key=`${from}:${to}:${e.roadId}`;
      if(!edges.has(key)){edges.add(key);graph.edges.push({...e,from,to});}}
  }
  const sampled=chunks.map(c=>({bounds:c.bounds,sample:terrainSampler(c.terrain)}));
  const cellSize=4,cols=Math.ceil((bounds.maxX-bounds.minX)/cellSize)+1,rows=Math.ceil((bounds.maxZ-bounds.minZ)/cellSize)+1;
  const terrain:Terrain={cols,rows,cellSize,originX:bounds.minX,originZ:bounds.minZ,heights:[]};
  for(let z=0;z<rows;z++)for(let x=0;x<cols;x++){
    const px=bounds.minX+x*cellSize,pz=bounds.minZ+z*cellSize;
    // Final ceil cell may extend <4m past requested bounds; each package has a 4m sample margin.
    const c=sampled.find(c=>contains(c.bounds,Math.min(px,bounds.maxX),Math.min(pz,bounds.maxZ)));
    if(!c)throw Error(`Missing world terrain at ${px},${pz}`);
    terrain.heights.push(c.sample(px,pz));
  }
  return {version:1,name:region.name,origin:region.origin,bounds,elevation:region.elevation,region:region.region,
    climate:region.climate,biome:region.biome,tier:region.tier,spawn:region.spawn,attribution:region.attribution,
    terrain,roads,graph,buildings:unique(chunks.flatMap(c=>c.buildings),b=>b.id),areas:unique(chunks.flatMap(c=>c.areas),a=>a.id),
    trees:unique(chunks.flatMap(c=>c.trees),t=>`${t.p}:${t.species}:${t.seed}`),
    props:unique(chunks.flatMap(c=>c.props),p=>`${p.type}:${p.p}:${p.rot}`),cameras:unique(chunks.flatMap(c=>c.cameras),c=>c.id)};
}
