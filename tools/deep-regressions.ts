import assert from 'node:assert/strict';
import { compileRecipe } from '../src/compiler/compile.ts';
import { gridRecipe } from '../src/ai/tests/grid.ts';
import { makeProjection } from '../src/core/geo.ts';
import { districtBounds, districtIndex, contains, rebaseRecipe } from '../src/world/stream-coordinates.ts';
import { mergeDistrictGraphs } from '../src/ai/stream-network.ts';
const checks:string[]=[];
function test(name:string,fn:()=>void){fn();checks.push(name);console.log('  ok',name);}
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
test('Network merge preserves initial node indices and deduplicates overlapping sources',()=>{
 const r=mergeDistrictGraphs(root,[rebased,rebased],()=>true);
 assert.equal(r.graph.nodes.length,root.graph.nodes.length+source.graph.nodes.length);
 assert.equal(r.graph.edges.length,root.graph.edges.length+source.graph.edges.length);
 assert.equal(r.graph.nodes[0].id,root.graph.nodes[0].id);
 for(const e of r.graph.edges){assert(r.graph.nodes[e.from]);assert(r.graph.nodes[e.to]);}
});
test('Network excludes edges leading into unready districts',()=>{
 const r=mergeDistrictGraphs(root,[rebased],()=>false);assert.equal(r.graph.edges.length,root.graph.edges.length);
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
console.log(`${checks.length} deep regressions passed`);
