// Publish immutable 400m geographic packages. No live map queries.
// Default: migrate bundled featured sources. Additional imports: --recipe path.json --id region-id.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { BAKED_CITIES } from '../src/compiler/cities.ts';
import { unpackRecipe } from '../src/compiler/unpack.ts';
import { packRecipe, packTerrain } from '../src/compiler/compile.ts';
import { chunkKeys, chunkBounds, makeWorldChunk, type WorldManifest, type WorldRegion, type WorldFile } from '../src/compiler/world-data.ts';
import type { Recipe } from '../src/core/types.ts';
const args=process.argv.slice(2), value=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
const output=resolve(value('--out')??'public/world'),extra=value('--recipe'),id=value('--id');
if(extra&&!id)throw Error('--recipe requires --id');
if(id&&!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id))throw Error('Region ID must use lowercase letters, digits and hyphens');
const indexPath=resolve(output,'index.json');mkdirSync(output,{recursive:true});
const previous:WorldManifest=existsSync(indexPath)?JSON.parse(readFileSync(indexPath,'utf8')):{version:1,revision:'',regions:[]};
const jobs=extra?[{id:id!,source:extra,initial:extra}]:BAKED_CITIES.map(c=>({id:c.id,source:`public/recipes/expansion/${c.id}.json`,initial:`public/recipes/${c.id}.json`}));
let bytes=0,maxBytes=0,count=0;
const readRecipe=(path:string):Recipe=>{
  const bytes=readFileSync(path);
  return unpackRecipe(JSON.parse((path.endsWith('.gz')?gunzipSync(bytes):bytes).toString('utf8')));
};
for(const job of jobs){
  const source=readRecipe(job.source),initial=readRecipe(job.initial);
  if(source.origin.lat!==initial.origin.lat||source.origin.lon!==initial.origin.lon)
    throw Error(`${job.id}: source and spawn/backdrop origins must match before baking`);
  const dy=(initial.elevation??0)-(source.elevation??0);
  const region:WorldRegion={id:job.id,name:initial.name,origin:source.origin,bounds:source.bounds,elevation:source.elevation??0,
    region:source.region,climate:source.climate,biome:source.biome,tier:initial.tier,spawn:{...initial.spawn,y:initial.spawn.y+dy},attribution:source.attribution,chunks:{}};
  const save=(name:string,data:unknown):WorldFile=>{
    const compressed=gzipSync(JSON.stringify(data),{level:6}),sha256=createHash('sha256').update(compressed).digest('hex');
    const url=`${job.id}/${name}.${sha256.slice(0,16)}.json.gz`,path=resolve(output,url);mkdirSync(dirname(path),{recursive:true});
    if(!existsSync(path))writeFileSync(path,compressed);
    bytes+=compressed.length;maxBytes=Math.max(maxBytes,compressed.length);count++;
    return {url,bytes:compressed.length,sha256};
  };
  for(const key of chunkKeys(source.bounds))region.chunks[key]=save(key.replace(',','_'),packRecipe(makeWorldChunk(source,chunkBounds(key))));
  if(initial.farTerrain)region.backdrop=save('backdrop',packTerrain({...initial.farTerrain,heights:initial.farTerrain.heights.map(y=>y+dy)},.1));
  const old=previous.regions.findIndex(r=>r.id===region.id);if(old<0)previous.regions.push(region);else previous.regions[old]=region;
  console.log(`${region.id}: ${Object.keys(region.chunks).length} chunks`);
}
previous.regions.sort((a,b)=>a.id.localeCompare(b.id));previous.version=1;
previous.revision=createHash('sha256').update(JSON.stringify(previous.regions)).digest('hex').slice(0,20);
writeFileSync(indexPath,JSON.stringify(previous));
console.log(JSON.stringify({regions:previous.regions.length,files:count,bytes,maxBytes,revision:previous.revision}));
