import { readFileSync } from 'node:fs';
import { BAKED_CITIES } from '../src/compiler/cities.ts';
import { budgetPixelRatio } from '../src/render/budget.ts';
import assert from 'node:assert/strict';
import { biomeFor } from '../src/compiler/biome.ts';
import { paletteFor } from '../src/compiler/region.ts';
import { compileRecipe } from '../src/compiler/compile.ts';
import { gridRecipe } from '../src/ai/tests/grid.ts';
import { makeProjection } from '../src/core/geo.ts';
import { districtBounds, districtIndex, contains, rebaseRecipe } from '../src/world/stream-coordinates.ts';
import { mergeDistrictGraphs } from '../src/ai/stream-network.ts';
const checks:string[]=[];
function test(name:string,fn:()=>void){fn();checks.push(name);console.log('  ok',name);}
test('Landscape classification separates alpine, desert, plains and coast',()=>{assert.equal(biomeFor(39.57,-106.09,2760,'arid'),'alpine');assert.equal(biomeFor(38.57,-109.55,1220,'arid'),'desert');assert.equal(biomeFor(38.89,-98.86,550,'cold'),'plains');assert.equal(biomeFor(37.76,-122.42,30,'coastal'),'coastal');assert.equal(biomeFor(40.01,-105.28,1640,'arid'),'temperate');});
test('High elevation forests use conifers and aspen',()=>{const p=paletteFor(39.57,-106.09,'mountain-west',2760);assert.equal(p.id,'alpine');assert(p.forest.every(s=>/pine|spruce|aspen/.test(s.name)));});
const bounds={minX:-660,minZ:-660,maxX:660,maxZ:660};
test('District grid has no gaps at positive and negative boundaries',()=>{
 for(const x of [-1661,-1060,-661,-660,0,660,661,1060,1661])for(const z of [-661,0,661]){
  const b=districtBounds(bounds,districtIndex(x,-660,660),districtIndex(z,-660,660));assert(contains(b,x,z));
 }
 assert.equal(districtBounds(bounds,1,0).minX,660);assert.equal(districtBounds(bounds,-1,0).maxX,-660);
});
const root=gridRecipe();root.origin={lat:40,lon:-105};root.elevation=1500;
const source=gridRecipe();source.origin=makeProjection(40,-105).toLatLon(1000,0);source.elevation=1520;
source.graph.nodes.forEach(n=>n.id+=1000);
source.roads.forEach(r=>r.id='new-'+r.id);source.graph.edges.forEach(e=>e.roadId='new-'+e.roadId);
const rebased=rebaseRecipe(source,root,{minX:660,minZ:-660,maxX:1060,maxZ:660});
test('District geometry uses the initial coordinate frame and elevation datum',()=>{
 assert(Math.abs(rebased.roads[0].pts[0][0]-1000)<0.001);assert.equal(rebased.roads[0].ys[0],20);assert.equal(rebased.terrain.heights[0],20);
 assert.equal(source.roads[0].ys[0],0);assert.equal(rebased.graph.nodes[0].y,20);
});
test('A district does not assemble roads in distant source areas',()=>{
 const extra={...source.roads[0],id:'far-away',pts:[[10000,10000],[10100,10000]],ys:[0,0]};
 const clipped=rebaseRecipe({...source,roads:[...source.roads,extra]},root,{minX:660,minZ:-660,maxX:1060,maxZ:660});
 assert(!clipped.roads.some(r=>r.id==='far-away'));assert(clipped.roads.some(r=>r.id===source.roads[0].id));
});
test('Network merge preserves initial node indices and deduplicates overlapping sources',()=>{
 const r=mergeDistrictGraphs(root,[rebased,rebased],()=>true);
 const once=mergeDistrictGraphs(root,[rebased],()=>true);
 assert.equal(r.graph.nodes.length,once.graph.nodes.length);
 assert.equal(r.graph.edges.length,once.graph.edges.length);
 assert(r.graph.edges.length>mergeDistrictGraphs(root,[],()=>true).graph.edges.length);
 assert.equal(r.graph.nodes[0].id,root.graph.nodes[0].id);
 for(const e of r.graph.edges){assert(r.graph.nodes[e.from]);assert(r.graph.nodes[e.to]);}
});
test('Network excludes edges leading into unready districts',()=>{
 const r=mergeDistrictGraphs(root,[rebased],()=>false);assert.equal(r.graph.edges.length,mergeDistrictGraphs(root,[],()=>true).graph.edges.length);
});
// A valid flat Terrarium tile at 100 m absolute elevation, with no mapped roads/buildings.
const pixels=new Uint8Array(256*256*4);for(let i=0;i<256*256;i++)pixels.set([128,100,0,255],i*4);
const rural=await compileRecipe({lat:38.5,lon:-109.6,name:'Rural regression',half:80,farHalf:0,cell:4,lean:true},{
 overpass:async()=>({elements:[]}),tiles:async()=>({width:256,height:256,channels:4,data:pixels}),
});
test('Unmapped rural terrain compiles without requiring a city street',()=>{
 assert.equal(rural.roads.length,0);assert.equal(rural.graph.edges.length,0);assert.equal(rural.farTerrain,undefined);
 assert(Number.isFinite(rural.spawn.y));assert.equal(rural.elevation,100);assert(contains(rural.bounds,...rural.spawn.p));
});
test('Render targets have a firm pixel budget on high-density displays',()=>{
 for(const [quality,max] of [['high',2400000],['medium',1600000],['low',1000000]] as const){
  const ratio=budgetPixelRatio(3840,2160,1.5,quality);assert(3840*2160*ratio*ratio<=max+1);
 }
 assert.equal(budgetPixelRatio(1440,900,1,'high'),1);
 assert.equal(budgetPixelRatio(1440,900,.5,'high'),.5);
});
test('Every featured location ships a valid first-ring expansion pack',()=>{
 const base=new URL('../public/recipes/expansion/',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('index.json',base),'utf8'));
 for(const city of BAKED_CITIES){
  assert(manifest[city.id]?.half>=1000,city.id);
  const pack=JSON.parse(readFileSync(new URL(`${city.id}.json`,base),'utf8'));
  assert.equal(pack.origin.lat,city.lat);assert.equal(pack.origin.lon,city.lon);
  assert(pack.bounds.minX<=-1000&&pack.bounds.maxX>=1000&&pack.bounds.minZ<=-1000&&pack.bounds.maxZ>=1000);
  assert.equal(pack.terrain.q.d.length,pack.terrain.cols*pack.terrain.rows);
  for(const e of pack.graph.edges)assert(pack.graph.nodes[e.from]&&pack.graph.nodes[e.to]);
 }
});
console.log(`${checks.length} deep regressions passed`);
