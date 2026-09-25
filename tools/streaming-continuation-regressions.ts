import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unpackRecipe } from '../src/compiler/unpack.ts';
import { continuationDistrict, isContinuation } from '../src/compiler/continuation.ts';
import { terrainSampler } from '../src/compiler/terrain.ts';
import { rebaseRecipe, clipRoadGraph, streamNodeId } from '../src/world/stream-coordinates.ts';
import { gridRecipe } from '../src/ai/tests/grid.ts';
import type { Recipe } from '../src/core/types.ts';
const checks:string[]=[];
const test=(name:string,fn:()=>void)=>{fn();checks.push(name);console.log('ok',name);};
const root=unpackRecipe(JSON.parse(readFileSync('public/recipes/boulder.json','utf8')));
const source=unpackRecipe(JSON.parse(readFileSync('public/recipes/expansion/boulder.json','utf8')));
const first=rebaseRecipe(source,root,{minX:600,minZ:-600,maxX:1000,maxZ:600});
const neighbors=[{recipe:root,heightAt:terrainSampler(root.terrain),groundAt:terrainSampler(root.terrain)},{recipe:first,heightAt:terrainSampler(first.terrain),groundAt:terrainSampler(first.terrain)}];
const next=continuationDistrict(root,{minX:1000,minZ:-600,maxX:1400,maxZ:600},neighbors);
test('Offline second ring contains finite playable terrain, continued roads and objectives',()=>{
 assert(isContinuation(next));assert(next.terrain.heights.every(Number.isFinite));assert(next.roads.length>0);assert(next.graph.edges.length>0);assert(next.cameras.length>0);assert(next.roads.every(r=>r.pts.length===r.ys.length));
 assert(next.roads.some(r=>r.pts.some(p=>p[0]>1380)),'Road must continue all the way through next tile');
});
test('Generated terrain is deterministic for the same resident neighborhood',()=>{
 const again=continuationDistrict(root,next.bounds,neighbors);assert.deepEqual(next,again);
});
test('Terrain boundary agrees with resident tile before visual seam feathering',()=>{
 const h=terrainSampler(next.terrain),old=terrainSampler(first.terrain);
 for(let z=-600;z<=600;z+=40)assert(Math.abs(h(1000,z)-old(1000,z))<.001);
});
test('Far source roads, areas and graph are clipped before geometry allocation',()=>{
 const r=gridRecipe(2,10000);r.areas=[{id:'large',kind:'parking',poly:[[-10000,-10000],[-10000,10000],[10000,10000],[10000,-10000]]}];
 const c=rebaseRecipe(r,r,{minX:0,minZ:0,maxX:400,maxZ:400});
 for(const road of c.roads)for(const p of road.pts)assert(p[0]>=-32&&p[0]<=432.001&&p[1]>=-32&&p[1]<=432.001);
 for(const a of c.areas)for(const p of a.poly)assert(p[0]>=-32&&p[0]<=432.001&&p[1]>=-32&&p[1]<=432.001);
 for(const n of c.graph.nodes)assert(n.p[0]>=0&&n.p[0]<=400&&n.p[1]>=0&&n.p[1]<=400);
});
test('Long rural road graphs connect at stable chunk boundaries in both directions',()=>{
 const graph:Recipe['graph']={nodes:[{id:1,p:[0,0],y:10},{id:2,p:[2000,0],y:30}],edges:[{from:0,to:1,roadId:'country',length:2000,lanes:2,speed:20,cls:'secondary'},{from:1,to:0,roadId:'country',length:2000,lanes:2,speed:20,cls:'secondary'}]};
 const a=clipRoadGraph(graph,{minX:0,minZ:-200,maxX:1000,maxZ:200},true),b=clipRoadGraph(graph,{minX:1000,minZ:-200,maxX:1400,maxZ:200});
 const common=a.nodes.find(n=>n.p[0]===1000)!;assert(b.nodes.some(n=>n.id===common.id));assert.equal(a.nodes[0].id,1);assert.equal(a.nodes[1].id,2);assert.equal(common.y,20);assert.equal(a.edges.length,2);assert.equal(b.edges.length,2);
 assert.equal(streamNodeId([1000,-1e-10]),streamNodeId([1000,0]));
});
test('Multiple offline rings retain bounded geometry and valid graph indices',()=>{
 let previous=next;
 for(let i=0;i<5;i++){
  const bounds={...previous.bounds,minX:previous.bounds.maxX,maxX:previous.bounds.maxX+400};
  const h=terrainSampler(previous.terrain);
  previous=continuationDistrict(root,bounds,[{recipe:previous,heightAt:h,groundAt:h}]);
  assert(previous.roads.length<=24);assert(previous.terrain.heights.length<=31000);assert(previous.trees.length<800);assert(previous.graph.edges.length>0);
  for(const e of previous.graph.edges){assert(previous.graph.nodes[e.from]);assert(previous.graph.nodes[e.to]);assert(Number.isFinite(e.length));}
 }
});
test('Curved rural edges meet at the real road crossing, not an off-road chord',()=>{
 const road={...gridRecipe(2,2000).roads[0],id:'bend',pts:[[0,0],[500,500],[1000,600],[1500,500],[2000,0]] as [number,number][],ys:[10,12,15,17,20],nodes:[1,3,4,5,2]};
 const graph:Recipe['graph']={nodes:[{id:1,p:[0,0],y:10},{id:2,p:[2000,0],y:20}],edges:[{from:0,to:1,roadId:'bend',length:2400,lanes:2,speed:20,cls:'secondary'}]};
 const left=clipRoadGraph(graph,{minX:0,minZ:-800,maxX:1000,maxZ:800},false,[road]);
 const right=clipRoadGraph(graph,{minX:1000,minZ:-800,maxX:2000,maxZ:800},false,[road]);
 const crossing=left.nodes.find(n=>n.p[0]===1000)!;assert.equal(crossing.p[1],600);assert.equal(crossing.y,15);assert(right.nodes.some(n=>n.id===crossing.id));assert(left.edges[0].length>1200);
});
console.log(`${checks.length} continuation regressions passed`);
