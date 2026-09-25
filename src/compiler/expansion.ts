import type { Recipe } from '../core/types';
import type { Bounds } from '../world/stream-coordinates';
import { BAKED_CITIES } from './cities';
import { unpackRecipe } from './unpack';

let manifest: Promise<Record<string,{half:number}>> | undefined;
const sources = new WeakMap<Recipe, Promise<Recipe | undefined>>();
/** One lazy source per world, shared by the eight first-ring districts. Failures fall back to live data. */
export async function bundledDistrict(root:Recipe, bounds:Bounds):Promise<Recipe|undefined> {
  const city=BAKED_CITIES.find(c=>Math.abs(c.lat-root.origin.lat)<1e-5&&Math.abs(c.lon-root.origin.lon)<1e-5);
  if(!city)return;
  const base=`${import.meta.env.BASE_URL}recipes/expansion/`;
  manifest??=fetch(`${base}index.json`,{signal:AbortSignal.timeout(4000)})
    .then(r=>{if(!r.ok)throw new Error(`Expansion index HTTP ${r.status}`);return r.json();}).catch(()=>{manifest=undefined;return {};});
  const entry=(await manifest)[city.id];
  if(!entry||Math.max(Math.abs(bounds.minX),Math.abs(bounds.maxX),Math.abs(bounds.minZ),Math.abs(bounds.maxZ))>entry.half)return;
  let source=sources.get(root);
  if(!source){
    source=fetch(`${base}${city.id}.json`,{signal:AbortSignal.timeout(12000)})
      .then(async r=>r.ok?unpackRecipe(await r.json()):undefined).catch(()=>undefined);
    sources.set(root,source);
    source.then(r=>{if(!r)sources.delete(root);});
  }
  return source;
}
