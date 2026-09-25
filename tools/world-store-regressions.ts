/** Exercise the actual worker message handler, hosted gzip files and network queue without WebGL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { terrainSampler } from '../src/compiler/terrain.ts';
import { pointInPoly } from '../src/compiler/geom.ts';
import { makeProjection } from '../src/core/geo.ts';
import type { Recipe } from '../src/core/types.ts';
import type { WorldRequest } from '../src/compiler/world-store.ts';
import type { WorldManifest } from '../src/compiler/world-data.ts';
const base='https://world.invalid/world/';
const manifest=JSON.parse(await readFile('public/world/index.json','utf8')) as WorldManifest;
let requests=0,active=0,peak=0,corrupt=false;
const mode=process.argv[2];
let cacheCalls=0,cacheDeletions=0,badCacheOnce=mode==='cache';
const storage=new Map<string,Response>();
const fakeCache={
  match:async(key:string|Request)=>{
    const url=typeof key==='string'?key:key.url;
    if(badCacheOnce&&url.includes('.gz')){badCacheOnce=false;return new Response(new Uint8Array([31,139,0,0,0,0]));}
    return storage.get(url)?.clone();
  },
  put:async(key:string,response:Response)=>{storage.set(key,response.clone());},
  keys:async()=>[...storage.keys()].map(url=>new Request(url)),
  delete:async(key:string|Request)=>{cacheDeletions++;return storage.delete(typeof key==='string'?key:key.url);},
};
const urls:string[]=[];
Object.assign(globalThis,{
  caches:{open:async()=>{
    cacheCalls++;
    if(mode==='cache')return fakeCache;
    if(mode==='hung')return new Promise(()=>{});
    throw Error('private mode');
  }},
  fetch:async(input:string)=>{
    const url=new URL(input);assert.equal(url.origin,'https://world.invalid');assert(url.pathname.startsWith('/world/'));
    requests++;urls.push(url.pathname);active++;peak=Math.max(peak,active);
    try{
      await new Promise(r=>setTimeout(r,1));
      const bytes=await readFile(resolve('public',`.${url.pathname}`));
      if(corrupt&&url.pathname.endsWith('.gz')){const broken=Buffer.from(bytes);broken[broken.length-5]^=255;return new Response(broken);}
      return new Response(bytes);
    }finally{active--;}
  },
});
let sequence=0;
const pending=new Map<number,{resolve:(recipe:Recipe|undefined)=>void;reject:(error:Error)=>void}>();
let lastMetrics:any;
const scope={postMessage:(m:any)=>{
  if(m.metrics)lastMetrics=m.metrics;
  const p=pending.get(m.id);if(!p||m.type==='progress')return;
  pending.delete(m.id);if(m.type==='error')p.reject(Error(m.message));else p.resolve(m.recipe);
},onmessage:undefined as undefined|((m:{data:WorldRequest})=>void)};
Object.assign(globalThis,{self:scope});
await import('../src/compiler/world-store.worker.ts');
function request(input:Omit<WorldRequest,'id'|'base'>){return new Promise<Recipe|undefined>((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});scope.onmessage!({data:{...input,id,base}});});}
let passed=0;
function pass(message:string){passed++;console.log(`PASS ${message}`);}
if(mode==='cache'||mode==='hung'){
  const r=manifest.regions[0];
  const recipe=await request({location:{...r.origin,baked:r.id,name:r.name}});assert(recipe);
  assert(lastMetrics.decodedEntries<=24);
  if(mode==='cache'){
    assert.equal(cacheDeletions,1);assert(!lastMetrics.cacheDisabled);
    const reads=requests;
    const again=await request({location:{...r.origin,baked:r.id,name:r.name}});assert(again);
    assert.equal(requests,reads);assert(lastMetrics.cacheHits>0);
    console.log('PASS corrupt CacheStorage repaired; repeated startup uses decoded chunks + cached backdrop');
  }else{
    assert(lastMetrics.cacheDisabled);assert(cacheCalls<=18);
    const calls=cacheCalls,second=manifest.regions[1];
    assert(await request({location:{...second.origin,baked:second.id,name:second.name}}));
    assert.equal(cacheCalls,calls);
    console.log('PASS hung CacheStorage bounded to first batch, circuit breaker skips every future storage operation');
  }
  process.exit(0);
}
for(const region of manifest.regions){
  const recipe=await request({location:{...region.origin,baked:region.id,name:region.name}});
  assert(recipe);assert.equal(recipe.origin.lat,region.origin.lat);assert.equal(recipe.origin.lon,region.origin.lon);
  assert.equal(recipe.terrain.heights.length,301*301);assert(recipe.terrain.heights.every(Number.isFinite));
  assert(recipe.roads.length);if(region.backdrop)assert(recipe.farTerrain);assert(recipe.spawn.p.every(Number.isFinite));
  assert.equal(recipe.elevation,region.elevation);assert.equal(recipe.bounds.minX,-600);
}
assert(manifest.regions.length>=16);pass(`all${manifest.regions.length} featured worlds use actual hosted gzip chunks + backdrop`);
assert(peak<=2,`peak downloads ${peak}`);pass('global network bodies bounded to two concurrent fetches');
const region=manifest.regions.find(r=>r.id==='boulder')!;
const pin=makeProjection(region.origin.lat,region.origin.lon).toLatLon(950,120);
const custom=await request({location:{...pin,name:'Near edge'}});assert(custom);
assert.equal(custom.origin.lat,pin.lat);assert.equal(custom.origin.lon,pin.lon);
assert(custom.bounds.maxX<200);assert(custom.bounds.maxX>=160);
assert(custom.spawn.p[0]>=custom.bounds.minX&&custom.spawn.p[0]<=custom.bounds.maxX);
assert(custom.spawn.p[1]>=custom.bounds.minZ&&custom.spawn.p[1]<=custom.bounds.maxZ);
assert(custom.farTerrain);assert(custom.farTerrain.heights.every(Number.isFinite));
assert(!custom.buildings.some(b=>pointInPoly(...custom.spawn.p,b.footprint,b.holes)));
for(const r of custom.roads)if(r.cls!=='pedestrian')for(let i=1;i<r.pts.length;i++){
  const a=r.pts[i-1],b=r.pts[i],dx=b[0]-a[0],dz=b[1]-a[1],p=custom.spawn.p,t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz||1)));
  assert(Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz)>=r.width/2+.49);
}
const rawFar=JSON.parse((await import('node:zlib')).gunzipSync(await readFile(resolve('public/world',region.backdrop!.url))).toString());
const far=(await import('../src/compiler/unpack.ts')).unpackTerrain(rawFar);
const originalSample=terrainSampler(far),movedSample=terrainSampler(custom.farTerrain);
for(const [x,z] of [[0,0],[-200,-200],[100,200]]){
 const ll=makeProjection(custom.origin.lat,custom.origin.lon).toLatLon(x,z),p=makeProjection(region.origin.lat,region.origin.lon).toLocal(ll.lat,ll.lon);
 assert(Math.abs(originalSample(...p)-movedSample(x,z))<.25);
}
pass('custom pin clips coverage, retains continuous distant terrain, and spawns off carriageways/footprints');
const root={origin:region.origin,elevation:region.elevation,name:region.name,region:region.region,climate:region.climate,tier:region.tier,biome:region.biome};
const bounds={minX:600,minZ:-600,maxX:1000,maxZ:600};
await request({root,bounds,prefetch:true});const before=requests;
const district=await request({root,bounds});assert(district);assert.equal(requests,before);
assert.deepEqual(district.bounds,bounds);assert(district.terrain.heights.every(Number.isFinite));
pass('driving district reuses prefetched decoded chunks without network or main thread compilation');
const beyond=await request({root,bounds:{minX:1000,minZ:-600,maxX:1400,maxZ:600}});
assert.equal(beyond,undefined);
const outside=await request({location:{lat:0,lon:0,name:'Outside'}});assert.equal(outside,undefined);
pass('partial/outside coverage explicitly returns undefined instead of inventing geographic terrain');
const reloaded=await request({location:{...manifest.regions[0].origin,baked:manifest.regions[0].id,name:'Reload'}});assert(reloaded);
pass(`evicted decoded worlds can reload after touring all${manifest.regions.length} regions`);
// A new revision URL bypasses decoded entries and a damaged gzip must reject before parsing.
corrupt=true;
const other=manifest.regions[1];
await assert.rejects(()=>request({location:{...other.origin,baked:other.id,name:'Corrupt'}}),/checksum/);
pass('corrupt hosted package rejected with actionable checksum error');
assert(urls.every(u=>u.startsWith('/world/')));pass('startup/travel invoke only hosted world URLs, never Overpass');
console.log(`${passed} world store regressions passed; ${requests} hosted file reads; peak ${peak} downloads.`);
