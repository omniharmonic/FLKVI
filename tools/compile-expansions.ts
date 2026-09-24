// Static first-ring coverage: no public map API is needed to leave a featured starting area.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { compileRecipe, packRecipe } from '../src/compiler/compile.ts';
import { BAKED_CITIES } from '../src/compiler/cities.ts';
import { compilerIO } from './compiler-io.ts';
const dir = new URL('../public/recipes/expansion/', import.meta.url);
mkdirSync(dir, { recursive: true });
const indexFile = new URL('index.json', dir);
const index: Record<string, {half:number}> = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
const ids = process.argv.slice(2);
for (const c of BAKED_CITIES.filter(c => !ids.length || ids.includes(c.id))) {
  if (index[c.id] && existsSync(new URL(`${c.id}.json`,dir))) continue;
  try {
    console.log('Baking expansion', c.id);
    const r = await compileRecipe({ ...c, half:1120, cell:4, farHalf:0, lean:true }, compilerIO, s=>console.log(c.id,s));
    writeFileSync(new URL(`${c.id}.json`,dir), JSON.stringify(packRecipe(r)));
    index[c.id] = {half:1120};
    writeFileSync(indexFile, JSON.stringify(index));
    console.log('Completed',c.id,r.buildings.length,'buildings');
  } catch(e) { console.error('FAILED',c.id,e); process.exitCode=1; }
}
