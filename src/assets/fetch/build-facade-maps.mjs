// Resize building source maps to the actual GPU array resolution offline, rather than decoding
// dozens of 2K images to immediately shrink them at every boot. Sources/license remain with each set.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const source=readFileSync('src/world/buildings/materials.ts','utf8');
const ids=[...source.match(/export const LAYER_IDS = \[([\s\S]*?)\] as const/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);
let count=0;
for(const id of ids)for(const map of ['color','normal','rough','ao']){
 const dir=`public/assets/textures/${id}`,file=`${dir}/${map}.jpg`;
 if(!existsSync(file))continue;
 execFileSync('sips',['-Z','512','-s','formatOptions','88',file,'--out',`${dir}/facade-${map}.jpg`],{stdio:'ignore'});count++;
}
console.log(`Prepared ${count} facade maps at the renderer's 512px array resolution`);
