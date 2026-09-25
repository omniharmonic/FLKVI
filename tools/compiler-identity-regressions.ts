import assert from 'node:assert/strict';
import {compileRecipe} from '../src/compiler/compile.ts';
const pixel=new Uint8Array(256*256*4);for(let i=0;i<256*256;i++)pixel.set([128,100,0,255],i*4);
const node=(id:number,lat:number,lon:number,tags?:Record<string,string>)=>({type:'node',id,lat,lon,tags});
const recipe=await compileRecipe({lat:40,lon:-105,name:'Identity regression',half:80,farHalf:0,cell:4,lean:true},{
 overpass:async()=>({elements:[
  node(101,40,-105,{highway:'traffic_signals'}),node(102,40,-105.001),node(103,40,-104.999),node(104,40.001,-105),node(105,39.999,-105),
  {type:'way',id:5001,nodes:[102,101,103],tags:{highway:'secondary',lanes:'2'}},
  {type:'way',id:5002,nodes:[104,101,105],tags:{highway:'secondary',lanes:'2'}},
 ]}),tiles:async()=>({width:256,height:256,channels:4,data:pixel}),
});
assert(recipe.graph.nodes.some(n=>n.id===101&&n.signal),'Graph must retain the actual OSM junction identity');
assert(recipe.props.filter(p=>p.type==='traffic-signal').length>=2,'Signal props must survive graph identities changing from local indices to OSM IDs');
assert(recipe.graph.edges.every(e=>recipe.graph.nodes[e.from]&&recipe.graph.nodes[e.to]),'Edges still reference local array indices');
console.log('Compiler identity and signal-furniture integration passed');
