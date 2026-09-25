import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { chunkKeys, chunkBounds, makeWorldChunk, assembleWorldChunks, selectRegion, regionalBounds, type WorldManifest } from '../src/compiler/world-data.ts';
import { unpackRecipe } from '../src/compiler/unpack.ts';
import { terrainSampler } from '../src/compiler/terrain.ts';
import { makeProjection } from '../src/core/geo.ts';
import { rebaseRecipe } from '../src/world/stream-coordinates.ts';
const manifest:WorldManifest=JSON.parse(readFileSync('public/world/index.json','utf8'));
let count=0;const check=(name:string,fn:()=>void)=>{fn();console.log('ok',name);count++;};
check('Geographic grid handles exact and negative boundaries',()=>{
 assert.deepEqual(chunkKeys({minX:-400,minZ:-400,maxX:0,maxZ:0}),['-1,-1']);
 assert.deepEqual(chunkKeys({minX:0,minZ:0,maxX:400,maxZ:400}),['0,0']);
 assert.equal(chunkKeys({minX:-600,minZ:-600,maxX:600,maxZ:600}).length,16);
});
check('Every hosted region has complete immutable packages and valid road graph indices',()=>{
 assert(manifest.regions.length>=16);let files=0;
 for(const region of manifest.regions)for(const key of chunkKeys(region.bounds)){
  const f=region.chunks[key];assert(f,`${region.id}:${key}`);
  const bytes=readFileSync(`public/world/${f.url}`);assert.equal(bytes.length,f.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256);
  const chunk=unpackRecipe(JSON.parse(gunzipSync(bytes).toString()));assert.equal(chunk.terrain.heights.length,chunk.terrain.rows*chunk.terrain.cols);
  assert(chunk.terrain.heights.every(Number.isFinite));for(const e of chunk.graph.edges){assert(chunk.graph.nodes[e.from]);assert(chunk.graph.nodes[e.to]);}files++;
 }
 assert(files>=576);
});
const region=manifest.regions.find(r=>r.id==='boulder')!;
const read=(key:string)=>unpackRecipe(JSON.parse(gunzipSync(readFileSync(`public/world/${region.chunks[key].url}`)).toString()));
const bounds={minX:-400,minZ:-400,maxX:400,maxZ:400},chunks=chunkKeys(bounds).map(read),assembled=assembleWorldChunks(chunks,region,bounds);
check('Neighboring packages agree on shared terrain samples',()=>{
 const a=terrainSampler(read('-1,0').terrain),b=terrainSampler(read('0,0').terrain);
 for(let z=0;z<=400;z+=4)assert(Math.abs(a(0,z)-b(0,z))<=.04);
});
check('Package assembly deduplicates complete source features and graph edges',()=>{
 const twice=assembleWorldChunks([...chunks,...chunks],region,bounds);
 for(const field of ['roads','buildings','areas','trees','props','cameras'] as const)assert.equal(twice[field].length,assembled[field].length);
 assert.equal(twice.graph.nodes.length,assembled.graph.nodes.length);assert.equal(twice.graph.edges.length,assembled.graph.edges.length);
 assert(assembled.buildings.length>0&&assembled.roads.length>0);
});
check('An arbitrary pin inside coverage finds hosted data without a featured-city ID',()=>{
 const origin=makeProjection(region.origin.lat,region.origin.lon).toLatLon(315,170);
 assert.equal(selectRegion(manifest,origin.lat,origin.lon)?.id,'boulder');
 const b=regionalBounds(region,origin,{minX:-200,minZ:-200,maxX:200,maxZ:200});
 assert(Math.abs(b.minX-115)<.01);assert(Math.abs(b.minZ+30)<.01);
 const r=assembleWorldChunks(chunkKeys(b).map(read),region,b);
 const rebased=rebaseRecipe(r,{...r,origin}, {minX:-200,minZ:-200,maxX:200,maxZ:200});
 assert.deepEqual(rebased.origin,origin);assert(rebased.terrain.heights.every(Number.isFinite));
});
check('Locations outside hosted coverage are not represented as surveyed worlds',()=>assert.equal(selectRegion(manifest,44,-100),undefined));
check('Missing terrain packages fail instead of silently filling real coverage',()=>{
 assert.throws(()=>assembleWorldChunks([chunks[0]],region,bounds),/Missing world terrain/);
});
check('Baking preserves roads intersecting a chunk even with endpoints outside it',()=>{
 const r={...assembled,roads:[{...assembled.roads[0],id:'cross',pts:[[-1000,100],[1000,100]] as [number,number][],ys:[0,0],nodes:[1,2]}],graph:{nodes:[],edges:[]}};
 assert.equal(makeWorldChunk(r,chunkBounds('0,0')).roads.length,1);
});
console.log(`${count} hosted-world regressions passed`);
