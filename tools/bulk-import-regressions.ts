import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { importBulkRecipe } from './bulk-import-world.ts';
import { indexOsm, multipolygonRings } from '../src/compiler/osm.ts';
import { unpackRecipe } from '../src/compiler/compile.ts';

const work = mkdtempSync(join(tmpdir(), 'flk-bulk-test-'));
const source = resolve('tools/fixtures/bulk-osm/region.osm');
const output = join(work, 'selected.json'), index = join(work, 'index.sqlite');
let checks = 0;
const check = (condition: unknown, message: string) => { assert(condition, message); checks++; console.log(`PASS ${message}`); };
const select = (input=source, extra: string[]=[]) => JSON.parse(execFileSync('python3', ['tools/osm-extract.py','--input',input,'--index',index,'--bounds=-105.001,39.999,-104.999,40.001','--output',output,...extra], {encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const oldFetch = globalThis.fetch;
try {
  const first = select(), raw = JSON.parse(readFileSync(output, 'utf8')), data = indexOsm(raw);
  check(!first.indexReused && first.counts.relations===2, 'Streaming XML index includes multipolygon relation');
  check(data.ways.get(1003)?.nodes.join(',')==='30,31' && data.nodes.has(30) && data.nodes.has(31), 'Crossing way preserves both nodes outside clip');
  check(!data.ways.has(9999) && !data.nodes.has(99), 'Unrelated distant geometry excluded');
  check(data.ways.get(1001)?.tags?.name==='A & B Street', 'XML entity tags decoded');
  const rings = multipolygonRings(data.rels.get(3001)!,data);
  check(rings.outers.length===1 && rings.inners.length===1, 'Joined outer and courtyard inner rings survive conversion');
  check(!data.rels.has(9000), 'Unrendered global archipelago does not pull missing continental references');
  check(data.rels.has(4000) && multipolygonRings(data.rels.get(4000)!,data).outers.length===1, 'Multipart feature enclosing the entire clip survives outside member edges');
  check(select().indexReused, 'Second window extraction reuses disk index');
  const damaged = join(work,'incomplete.osm');
  writeFileSync(damaged,readFileSync(source,'utf8').replace('<nd ref="2"/>','<nd ref="700000"/>'));
  assert.throws(()=>select(damaged),/missing references/); checks++; console.log('PASS Missing way node rejects incomplete snapshot');
  check(select(damaged,['--allow-incomplete']).missingReferences.nodes===1, 'Explicit incomplete mode reports missing node');
  const malformed = join(work,'malformed.osm'); writeFileSync(malformed,'<not-osm/>');
  assert.throws(()=>select(malformed),/Expected an OSM XML/); checks++; console.log('PASS Non-OSM input rejected');
  const pixel=new Uint8Array(256*256*4);for(let i=0;i<256*256;i++)pixel.set([128,100,0,255],i*4);
  globalThis.fetch = async () => { throw new Error('Network forbidden in offline import regression'); };
  const recipeOutput = join(work,'recipe.json');
  const result = await importBulkRecipe({input:source,output:recipeOutput,lat:40,lon:-105,half:100,cell:4,name:'Offline test'}, {tiles:async()=>({width:256,height:256,channels:4,data:pixel}),log:()=>{}});
  check(result.recipe.roads.length>=2 && result.recipe.graph.nodes.some(n=>n.id===2&&n.signal), 'Local OSM drives real road and signal graph compilation without network');
  check(result.recipe.buildings.length>=1, 'Multipolygon compiles into actual building asset');
  check(result.recipe.elevation===100 && result.recipe.terrain.heights.length>0, 'Injected terrain is used in compiled recipe');
  check(result.recipe.attribution.some(a=>a.includes('ODbL')) && result.provenance.source.sha256.length===64, 'ODbL attribution and source digest retained');
  const packed=JSON.parse(readFileSync(recipeOutput,'utf8')), unpacked=unpackRecipe(packed);
  check(unpacked.roads.length===result.recipe.roads.length && unpacked.terrain.heights.length===result.recipe.terrain.heights.length, 'Packed output round trips through production recipe decoder');
  await assert.rejects(importBulkRecipe({input:source,output:recipeOutput,lat:40,lon:-105,half:100000,cell:1}),/budget exceeded/);checks++;console.log('PASS Oversized terrain compile rejected before allocation');
  await assert.rejects(importBulkRecipe({input:source,output:recipeOutput,lat:40,lon:-105,half:80,cell:4,offlineTerrain:true,terrainDir:join(work,'missing-tiles')},{log:()=>{}}),/terrain/i);checks++;console.log('PASS Missing offline elevation rejects instead of silently flattening world');
  const originalPath=process.env.PATH;
  try {
    process.env.PATH=join(work,'no-binaries');
    await assert.rejects(importBulkRecipe({input:join(work,'region.osm.pbf'),output:recipeOutput,lat:40,lon:-105,half:80},{log:()=>{}}),/Install osmium-tool/);checks++;console.log('PASS Missing PBF decoder gives actionable install/XML guidance');
  } finally {process.env.PATH=originalPath;}
  console.log(`${checks} offline bulk import regressions passed`);
} finally { globalThis.fetch=oldFetch;rmSync(work,{recursive:true,force:true}); }
