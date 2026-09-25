// Hosted coordinate chunks are fetched, validated, decompressed, assembled and reprojected off-thread.
import type { Recipe, Terrain } from '../core/types.ts';
import type { WorldRequest, WorldRoot } from './world-store.ts';
import { assembleWorldChunks, chunkKeys, regionalBounds, selectRegion, type WorldManifest, type WorldFile, type WorldRegion } from './world-data.ts';
import { makeProjection } from '../core/geo.ts';
import { rebaseRecipe, type Bounds } from '../world/stream-coordinates.ts';
import { terrainSampler } from './terrain.ts';
import { pointInPoly, headingOf } from './geom.ts';
import { unpackRecipe, unpackTerrain } from './unpack.ts';

const CACHE='flk-world-packages-v1', MAX_DECODED=24, MAX_CACHE_FILES=96, MAX_CACHE_BYTES=64*1024*1024;
const decoded=new Map<string,Recipe>();
const downloading=new Map<string,Promise<Recipe>>();
let manifestPromise:Promise<WorldManifest>|undefined, manifestBase='';
let activeFetches=0, networkBytes=0, downloadedFiles=0, cacheHits=0, failedRequests=0;
const fetchQueue:Array<()=>void>=[];
let cacheWrites=Promise.resolve(), cacheDisabled=false, pendingWrites=0;
function storageDeadline<T>(work:Promise<T>,fallback:T):Promise<T>{
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{cacheDisabled=true;resolve(fallback);},1000);
    work.then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);cacheDisabled=true;resolve(fallback);});
  });
}
async function withFetchSlot<T>(job:()=>Promise<T>):Promise<T>{
  if(activeFetches>=2)await new Promise<void>(resolve=>fetchQueue.push(resolve));
  activeFetches++;
  try{return await job();}finally{activeFetches--;fetchQueue.shift()?.();}
}
async function download(url:string):Promise<Response>{
  return withFetchSlot(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12_000);
    try{
      const res=await fetch(url,{signal:controller.signal});
      if(!res.ok)throw Error(`World package HTTP ${res.status}`);
      // Consume while the deadline still covers body transfer, not only response headers.
      const buffer=await res.arrayBuffer();
      if(buffer.byteLength>16*1024*1024)throw Error('World package exceeds size limit');
      networkBytes+=buffer.byteLength;downloadedFiles++;
      return new Response(buffer,{headers:res.headers});
    }finally{clearTimeout(timer);}
  });
}
async function manifest(base:string){
  if(base!==manifestBase){manifestBase=base;manifestPromise=undefined;decoded.clear();}
  if(!manifestPromise)manifestPromise=(async()=>{
    const url=new URL('index.json',base).href;
    let response:Response;
    try{response=await download(url);}catch(e){const hit=await cached(url);if(!hit)throw e;response=hit;}
    const bytes=await response.arrayBuffer();
    const value=JSON.parse(new TextDecoder().decode(bytes)) as WorldManifest;
    if(value.version!==1||!value.revision||!Array.isArray(value.regions))throw Error('Unsupported world manifest');
    persist(url,bytes);return value;
  })().catch(e=>{manifestPromise=undefined;throw e;});
  return manifestPromise;
}
async function cached(url:string):Promise<Response|undefined>{
  if(cacheDisabled)return;
  try{return await storageDeadline((async()=> (await caches.open(CACHE)).match(url))(),undefined);}catch{return undefined;}
}
function persist(url:string,bytes:ArrayBuffer){
  if(cacheDisabled||pendingWrites>=8)return;
  pendingWrites++;
  // Serialize quota accounting. A bounded downloaded buffer is the only retained write payload.
  cacheWrites=cacheWrites.then(()=>storageDeadline((async()=>{
    if(cacheDisabled)return;
    try{
      const cache=await caches.open(CACHE);
      await cache.put(url,new Response(bytes,{headers:{'x-flk-bytes':String(bytes.byteLength)}}));
      const keys=await cache.keys();let size=0;
      const sizes=await Promise.all(keys.map(async key=>Number((await cache.match(key))?.headers.get('x-flk-bytes')||0)));
      for(const n of sizes)size+=n;
      let count=keys.length;
      for(let i=0;i<keys.length&&(count>MAX_CACHE_FILES||size>MAX_CACHE_BYTES);i++){await cache.delete(keys[i]);size-=sizes[i];count--;}
    }catch{cacheDisabled=true;/* Private mode/quota never prevents play. */}
  })(),undefined)).finally(()=>{pendingWrites--;});
}
async function readFile(file:WorldFile,base:string,revision:string):Promise<unknown>{
  const url=new URL(file.url,base);url.searchParams.set('v',file.sha256);
  const key=url.href;
  let hit=await cached(key),buffer:ArrayBuffer;
  for(let attempt=0;;attempt++){
    const local=hit?await storageDeadline(hit.arrayBuffer(),undefined):undefined;
    if(hit&&!local)hit=undefined;
    buffer=local??await (await download(key)).arrayBuffer();
    try{
      const bytes=new Uint8Array(buffer),gzip=bytes[0]===31&&bytes[1]===139;
      // Some CDNs transparently decode gzip. Verify stored gzip bytes; do not double-decompress.
      if(gzip&&file.sha256){
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),v=>v.toString(16).padStart(2,'0')).join('');
        if(hash!==file.sha256)throw Error('World package checksum mismatch');
      }
      const text=gzip?await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).text():new TextDecoder().decode(buffer);
      if(text.length>32*1024*1024)throw Error('Decoded world package exceeds size limit');
      const value=JSON.parse(text);
      if(!hit)persist(key,buffer);else cacheHits++;
      return value;
    }catch(e){
      if(!hit||attempt)throw e;
      try{await storageDeadline((async()=>{await (await caches.open(CACHE)).delete(key);})(),undefined);}catch{}
      hit=undefined; // Repair corrupt local storage with one network retry.
    }
  }
}
async function chunk(file:WorldFile,base:string,revision:string):Promise<Recipe>{
  const key=`${base}:${file.url}:${file.sha256}`;
  const hit=decoded.get(key);if(hit){cacheHits++;decoded.delete(key);decoded.set(key,hit);return hit;}
  const inflight=downloading.get(key);if(inflight)return inflight;
  const promise=(async()=>{
    const value=unpackRecipe(await readFile(file,base,revision));
    if(value.version!==1||!value.terrain||!Array.isArray(value.roads)||!value.graph)throw Error('Invalid world chunk');
    if(value.terrain.heights.length!==value.terrain.cols*value.terrain.rows||!value.terrain.heights.every(Number.isFinite))throw Error('Invalid world terrain');
    decoded.set(key,value);
    while(decoded.size>MAX_DECODED)decoded.delete(decoded.keys().next().value!);
    return value;
  })();
  downloading.set(key,promise);
  try{return await promise;}finally{downloading.delete(key);}
}
function skeleton(root:WorldRoot):Recipe{
  return {...root,version:1,bounds:{minX:0,minZ:0,maxX:0,maxZ:0},terrain:{cols:1,rows:1,cellSize:4,originX:0,originZ:0,heights:[0]},roads:[],graph:{nodes:[],edges:[]},buildings:[],areas:[],props:[],trees:[],cameras:[],spawn:{p:[0,0],y:0,heading:0},attribution:[]};
}
function covered(region:WorldRegion,b:Bounds){
  const r=region.bounds,t=.001;
  return b.minX>=r.minX-t&&b.minZ>=r.minZ-t&&b.maxX<=r.maxX+t&&b.maxZ<=r.maxZ+t;
}
function snapBounds(b:Bounds):Bounds{
  // Equivalent ENU frames accumulate submillimetre noise; avoid requesting a nonexistent sliver.
  const round=(v:number)=>Math.round(v*1000)/1000;
  return {minX:round(b.minX),minZ:round(b.minZ),maxX:round(b.maxX),maxZ:round(b.maxZ)};
}
function safeSpawn(recipe:Recipe){
  const b=recipe.bounds,inset=8,sample=terrainSampler(recipe.terrain);
  const candidates:Array<{x:number;z:number;y:number;heading:number;score:number}>=[];
  const segments=recipe.roads.flatMap(road=>road.pts.slice(1).map((p,i)=>({road,a:road.pts[i],b:p})));
  const segmentDistance=(x:number,z:number,a:number[],b:number[])=>{
    const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1)));
    return Math.hypot(x-a[0]-t*dx,z-a[1]-t*dz);
  };
  const safe=(x:number,z:number)=>x>=b.minX+inset&&x<=b.maxX-inset&&z>=b.minZ+inset&&z<=b.maxZ-inset
    &&!recipe.buildings.some(v=>pointInPoly(x,z,v.footprint,v.holes))
    &&!recipe.areas.some(v=>v.kind==='water'&&pointInPoly(x,z,v.poly,v.holes))
    &&!segments.some(s=>s.road.cls!=='pedestrian'&&segmentDistance(x,z,s.a,s.b)<s.road.width/2+.5);
  for(const road of recipe.roads){
    if(road.tunnel||road.bridge||road.cls==='motorway'||road.cls==='trunk')continue;
    for(let i=1;i<road.pts.length;i++){
      const a=road.pts[i-1],c=road.pts[i],dx=c[0]-a[0],dz=c[1]-a[1],length=Math.hypot(dx,dz);
      if(length<.1)continue;
      const t=Math.max(.05,Math.min(.95,-(a[0]*dx+a[1]*dz)/(length*length)));
      const off=road.width/2+Math.max(1.2,Math.min(1.8,road.sidewalk*.5));
      for(const side of [-1,1]){
        const x=a[0]+dx*t-dz/length*off*side,z=a[1]+dz*t+dx/length*off*side;
        candidates.push({x,z,y:road.sidewalk>0?road.ys[i-1]+(road.ys[i]-road.ys[i-1])*t+.15:sample(x,z),heading:headingOf(dx,dz),score:x*x+z*z});
      }
    }
  }
  candidates.sort((a,b)=>a.score-b.score);
  for(const c of candidates.slice(0,256))if(safe(c.x,c.z)){recipe.spawn={p:[c.x,c.z],y:c.y,heading:c.heading};return;}
  // Parks/undeveloped pins may have no road; search free terrain instead of spawning inside a footprint.
  for(let radius=0;radius<380;radius+=12)for(let step=0;step<Math.max(1,Math.ceil(radius/6));step++){
    const angle=step/Math.max(1,Math.ceil(radius/6))*Math.PI*2,x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
    if(safe(x,z)){recipe.spawn={p:[x,z],y:sample(x,z),heading:0};return;}
  }
  throw Error('No safe walking spawn in hosted coverage');
}
function rebaseBackdrop(terrain:Terrain,region:WorldRegion,root:WorldRoot):Terrain{
  const source=makeProjection(region.origin.lat,region.origin.lon),target=makeProjection(root.origin.lat,root.origin.lon);
  const a=source.toLatLon(terrain.originX,terrain.originZ),b=source.toLatLon(terrain.originX+(terrain.cols-1)*terrain.cellSize,terrain.originZ+(terrain.rows-1)*terrain.cellSize);
  const min=target.toLocal(a.lat,a.lon),max=target.toLocal(b.lat,b.lon),cellSize=terrain.cellSize;
  const cols=Math.ceil((max[0]-min[0])/cellSize)+1,rows=Math.ceil((max[1]-min[1])/cellSize)+1,sample=terrainSampler(terrain),dy=region.elevation-(root.elevation??0);
  const heights=Array.from({length:cols*rows},(_,i)=>{const ll=target.toLatLon(min[0]+i%cols*cellSize,min[1]+Math.floor(i/cols)*cellSize);return sample(...source.toLocal(ll.lat,ll.lon))+dy;});
  return {cols,rows,cellSize,originX:min[0],originZ:min[1],heights};
}
async function handle(m:WorldRequest){
  const progress=(stage:string,fraction:number)=>self.postMessage({id:m.id,type:'progress',stage,fraction});
  progress('Locating world packages',.03);
  const data=await manifest(m.base);
  let region:WorldRegion|undefined,root:WorldRoot,bounds:Bounds;
  if(m.location){
    const loc=m.location;
    region=loc.baked?data.regions.find(r=>r.id===loc.baked):selectRegion(data,loc.lat,loc.lon);
    if(!region)return;
    root={origin:loc.baked?region.origin:{lat:loc.lat,lon:loc.lon},elevation:region.elevation,name:region.name,region:region.region,climate:region.climate,tier:region.tier,biome:region.biome};
    const half=loc.baked?600:400;bounds={minX:-half,minZ:-half,maxX:half,maxZ:half};
    if(!loc.baked){
      // A pin near a region edge still gets a real window, cropped to published coverage.
      const local=regionalBounds({...region,origin:root.origin},region.origin,region.bounds);
      bounds={minX:Math.max(bounds.minX,Math.ceil(local.minX/4)*4),minZ:Math.max(bounds.minZ,Math.ceil(local.minZ/4)*4),maxX:Math.min(bounds.maxX,Math.floor(local.maxX/4)*4),maxZ:Math.min(bounds.maxZ,Math.floor(local.maxZ/4)*4)};
      if(bounds.maxX-bounds.minX<80||bounds.maxZ-bounds.minZ<80)return;
    }
  }else{
    if(!m.root||!m.bounds)throw Error('Missing world request coordinates');
    root=m.root;bounds=m.bounds;
    const center=makeProjection(root.origin.lat,root.origin.lon).toLatLon((bounds.minX+bounds.maxX)/2,(bounds.minZ+bounds.maxZ)/2);
    region=selectRegion(data,center.lat,center.lon);if(!region)return;
  }
  const regional=snapBounds(regionalBounds(region,root.origin,bounds));
  if(!covered(region,regional))return;
  const keys=chunkKeys(regional);
  if(keys.length>25||keys.some(k=>!region!.chunks[k]))return;
  let done=0;
  const chunks=await Promise.all(keys.map(async key=>{
    const value=await chunk(region!.chunks[key],m.base,data.revision);progress('Downloading world packages',.08+.72*++done/keys.length);return value;
  }));
  if(m.prefetch)return;
  progress('Assembling nearby streets',.85);
  const assembled=assembleWorldChunks(chunks,region,regional);
  const recipe=rebaseRecipe(assembled,skeleton(root),bounds);
  if(m.location&&!m.location.baked)safeSpawn(recipe);
  if(m.location&&region.backdrop){
    try{const far=unpackTerrain(await readFile(region.backdrop,m.base,data.revision) as Terrain);recipe.farTerrain=m.location.baked?far:rebaseBackdrop(far,region,root);}catch{/* Distant scenery is optional; drivable terrain is validated above. */}
  }
  progress('World ready',1);
  return recipe;
}
// Requests share downloads and only two simultaneous network bodies. Only loads assemble geometry data.
self.onmessage=({data:m}:MessageEvent<WorldRequest>)=>{
  const started=performance.now();
  const metrics=()=>({networkBytes,downloadedFiles,cacheHits,decodedEntries:decoded.size,activeFetches,failedRequests,cacheDisabled,lastLoadMs:Math.round(performance.now()-started)});
  void handle(m).then(recipe=>self.postMessage({id:m.id,type:'done',recipe,metrics:metrics()}),e=>{failedRequests++;self.postMessage({id:m.id,type:'error',message:e instanceof Error?e.message:String(e),metrics:metrics()});});
};
