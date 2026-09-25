// One shared worker serves initial worlds and travel; gameplay never parses or compiles map data.
import type { Recipe } from '../core/types';
import type { SpawnLocation, Progress } from '../core/location';
import type { Bounds } from '../world/stream-coordinates';
export type WorldRoot = Pick<Recipe,'origin'|'elevation'|'name'|'region'|'climate'|'tier'|'biome'>;
export interface WorldRequest { id:number; base:string; location?:SpawnLocation; root?:WorldRoot; bounds?:Bounds; prefetch?:boolean }
interface Pending { resolve:(recipe:Recipe|undefined)=>void; reject:(error:Error)=>void; progress?:Progress; timer:ReturnType<typeof setTimeout> }
let worker:Worker|undefined, sequence=0;
const pending=new Map<number,Pending>();
const prefetching=new Set<string>();
const prefetchedUntil=new Map<string,number>();
function stop(error:Error){
  worker?.terminate();worker=undefined;
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();
}
function background(){
  if(worker)return worker;
  worker=new Worker(new URL('./world-store.worker.ts',import.meta.url),{type:'module'});
  worker.onmessage=({data:m})=>{
    if(m.metrics)(globalThis as unknown as {__worldStore:Readonly<Record<string,number|boolean>>}).__worldStore=Object.freeze({...m.metrics});
    const p=pending.get(m.id);if(!p)return;
    if(m.type==='progress'){p.progress?.(m.stage,m.fraction);return;}
    clearTimeout(p.timer);pending.delete(m.id);
    if(m.type==='error')p.reject(new Error(m.message));else p.resolve(m.recipe);
  };
  worker.onerror=e=>stop(new Error(e.message||'Background world loader failed'));
  worker.onmessageerror=()=>stop(new Error('World package could not be decoded'));
  return worker;
}
function request(input:Omit<WorldRequest,'id'|'base'>,progress?:Progress):Promise<Recipe|undefined>{
  // A hung worker is replaced rather than accumulating workers, callbacks or queued jobs.
  if(pending.size>=6)return Promise.reject(new Error('World loading queue is full'));
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    try{
      const w=background();
      const base=new URL(import.meta.env.VITE_WORLD_DATA_URL||`${import.meta.env.BASE_URL}world/`,location.href).href;
      const timer=setTimeout(()=>stop(new Error('World package download timed out')),30_000);
      pending.set(id,{resolve,reject,progress,timer});
      w.postMessage({...input,id,base:base.endsWith('/')?base:`${base}/`} satisfies WorldRequest);
    }catch(e){
      const entry=pending.get(id);if(entry)clearTimeout(entry.timer);
      pending.delete(id);reject(e instanceof Error?e:new Error(String(e)));
    }
  });
}
function rootData(root:Recipe):WorldRoot{
  const {origin,elevation,name,region,climate,tier,biome}=root;
  return {origin,elevation,name,region,climate,tier,biome};
}
/** Undefined means no complete hosted coverage; network/corrupt package failures reject. */
export function loadHostedWorld(location:SpawnLocation,onProgress:Progress){return request({location},onProgress);}
export function loadHostedDistrict(root:Recipe,bounds:Bounds,onProgress?:Progress){return request({root:rootData(root),bounds},onProgress);}
/** Speculative work is bounded and silent. Actual loads share its decoded/cache entries. */
export function prefetchHostedDistrict(root:Recipe,bounds:Bounds){
  if(prefetching.size>=2||pending.size>=3)return;
  const key=`${root.origin.lat},${root.origin.lon}:${bounds.minX},${bounds.minZ},${bounds.maxX},${bounds.maxZ}`;
  if(prefetching.has(key)||(prefetchedUntil.get(key)??0)>performance.now())return;
  prefetchedUntil.set(key,performance.now()+30_000);
  while(prefetchedUntil.size>32)prefetchedUntil.delete(prefetchedUntil.keys().next().value!);
  prefetching.add(key);
  void request({root:rootData(root),bounds,prefetch:true}).catch(()=>{}).finally(()=>prefetching.delete(key));
}
