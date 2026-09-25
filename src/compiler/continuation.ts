// Offline-safe outskirts. These districts are explicitly generated, not claimed to be real map data.
// Only resident roads are continued; terrain follows the available coarse DEM and matches loaded edges.
import type { Recipe, RecipeRoad, Vec2 } from '../core/types.ts';
import { hashString, rng } from '../core/geo.ts';
import { terrainSampler } from './terrain.ts';
import { recipeBiome } from './biome.ts';
import { clipPolylineRect, distToSeg } from './geom.ts';
import { contains, distanceTo, rebaseRecipe, streamNodeId, type Bounds } from '../world/stream-coordinates.ts';

export const CONTINUATION_ATTRIBUTION = 'Procedural outskirts — approximate terrain and roads while map services are unavailable';
export function isContinuation(recipe: Recipe) { return recipe.attribution.includes(CONTINUATION_ATTRIBUTION); }
export interface ContinuationNeighbor { recipe: Recipe; heightAt(x:number,z:number):number; groundAt(x:number,z:number):number }

export function continuationDistrict(root:Recipe,bounds:Bounds,neighbors:ContinuationNeighbor[]):Recipe {
  const biome=recipeBiome(root), key=`${bounds.minX},${bounds.minZ}`, random=rng(hashString(`${root.origin.lat}:${root.origin.lon}:${key}`));
  const far=terrainSampler(root.farTerrain??root.terrain);
  const nearby=neighbors.filter(n=>distanceTo(n.recipe.bounds,(bounds.minX+bounds.maxX)/2,(bounds.minZ+bounds.maxZ)/2)<1000);
  const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
  const height=(x:number,z:number)=>{
    let nearest=Infinity,edgeY=far(x,z),edgeX=x,edgeZ=z;
    for(const n of nearby){const b=n.recipe.bounds,nx=clamp(x,b.minX,b.maxX),nz=clamp(z,b.minZ,b.maxZ),d=Math.hypot(x-nx,z-nz);
      if(d<nearest){nearest=d;edgeY=n.heightAt(nx,nz);edgeX=nx;edgeZ=nz;}}
    // Retain the regional mountain profile, but remove DEM datum/flattening jumps at the join.
    const delta=far(x,z)-far(edgeX,edgeZ);
    return edgeY+clamp(delta,-nearest*0.18,nearest*0.18);
  };
  const cellSize=4,cols=Math.ceil((bounds.maxX-bounds.minX)/cellSize)+1,rows=Math.ceil((bounds.maxZ-bounds.minZ)/cellSize)+1;
  const heights=Array.from({length:cols*rows},(_,i)=>height(bounds.minX+i%cols*cellSize,bounds.minZ+Math.floor(i/cols)*cellSize));
  const terrain={cols,rows,cellSize,originX:bounds.minX,originZ:bounds.minZ,heights};
  const roads:RecipeRoad[]=[],seen=new Set<string>();
  const margin=48, box={minX:bounds.minX-margin,minZ:bounds.minZ-margin,maxX:bounds.maxX+margin,maxZ:bounds.maxZ+margin};
  const roadSample=(road:RecipeRoad,p:Vec2)=>{
    let best=Infinity,y=height(...p);
    for(let i=1;i<road.pts.length;i++){
      const a=road.pts[i-1],b=road.pts[i],dx=b[0]-a[0],dz=b[1]-a[1],t=clamp(((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz||1),0,1);
      const d=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz);
      if(d<best){best=d;y=road.ys[i-1]+(road.ys[i]-road.ys[i-1])*t;}
    }
    return y;
  };
  // Keep all crossing streets up to a bounded budget, prioritizing the player's actual route's
  // continuation by proximity to this tile. Preserve their identifiers for traffic graph stitching.
  const candidates=nearby.flatMap(n=>n.recipe.roads.map(road=>({road,neighbor:n})))
    .filter(({road})=>!['steps','footway','path','cycleway'].includes(road.cls))
    .sort((a,b)=>Math.min(...a.road.pts.map(p=>distanceTo(bounds,...p)))-Math.min(...b.road.pts.map(p=>distanceTo(bounds,...p))));
  for(const {road,neighbor} of candidates){
    if(roads.length>=24)break;
    for(const piece of clipPolylineRect(road.pts,box.minX,box.minZ,box.maxX,box.maxZ)){
      if(!clipPolylineRect(piece.pts,bounds.minX,bounds.minZ,bounds.maxX,bounds.maxZ).length)continue;
      const sig=`${road.id}:${piece.pts[0].map(v=>v.toFixed(1)).join(',')}`;if(seen.has(sig))continue;seen.add(sig);
      const pts=piece.pts.map(p=>[...p] as Vec2),ys=pts.map(p=>roadSample(road,p));
      // A source way ends at its download margin. Extend its tangent across the next district;
      // no empty wall/precipice when the next public map request fails.
      for(const start of [true,false]){
        const k=start?0:pts.length-1,j=start?1:pts.length-2,p=pts[k],q=pts[j];
        if(!contains(bounds,...p))continue;
        const len=Math.hypot(p[0]-q[0],p[1]-q[1]);if(len<0.01)continue;
        const dx=(p[0]-q[0])/len,dz=(p[1]-q[1])/len;
        const ray:Vec2=[p[0]+dx*4000,p[1]+dz*4000];
        const extension=clipPolylineRect([p,ray],box.minX,box.minZ,box.maxX,box.maxZ)[0];if(!extension)continue;
        const end=extension.pts.at(-1)!,distance=Math.hypot(end[0]-p[0],end[1]-p[1]),steps=Math.ceil(distance/24);
        const newPts:Vec2[]=[],newY:number[]=[];const anchor=ys[k],dem=height(...p);
        for(let i=1;i<=steps;i++){const d=distance*i/steps,v:Vec2=[p[0]+dx*d,p[1]+dz*d];newPts.push(v);newY.push(anchor+clamp(height(...v)-dem,-d*0.06,d*0.06));}
        if(start){pts.unshift(...newPts.reverse());ys.unshift(...newY.reverse());}else{pts.push(...newPts);ys.push(...newY);}
      }
      // Anchor the shared boundary to the *built* neighbor road, whose junction grading may
      // differ from source DEM values. Apply the correction to the full continuation profile.
      const nb=neighbor.recipe.bounds;
      let correction=0;
      for(let i=1;i<pts.length;i++){
        const crossing=clipPolylineRect([pts[i-1],pts[i]],nb.minX,nb.minZ,nb.maxX,nb.maxZ)[0];
        if(!crossing)continue;
        const p=crossing.pts.find(p=>Math.min(Math.abs(p[0]-nb.minX),Math.abs(p[0]-nb.maxX),Math.abs(p[1]-nb.minZ),Math.abs(p[1]-nb.maxZ))<0.01);
        if(p){correction=neighbor.groundAt(...p)-roadSample(road,p);break;}
      }
      const nodes=pts.map(streamNodeId);
      roads.push({...road,pts,ys:ys.map(y=>y+correction),nodes});
    }
  }
  const graph:Recipe['graph']={nodes:[],edges:[]},nodeMap=new Map<number,number>();
  for(const road of roads){const ids=road.pts.map((p,i)=>{let id=nodeMap.get(road.nodes[i]);if(id===undefined){id=graph.nodes.length;nodeMap.set(road.nodes[i],id);graph.nodes.push({id:road.nodes[i],p,y:road.ys[i]});}return id;});
    for(let i=1;i<ids.length;i++){const edge={from:ids[i-1],to:ids[i],roadId:road.id,length:Math.hypot(road.pts[i][0]-road.pts[i-1][0],road.pts[i][1]-road.pts[i-1][1]),lanes:road.lanes,speed:road.maxSpeed,cls:road.cls};graph.edges.push(edge);if(!road.oneway)graph.edges.push({...edge,from:edge.to,to:edge.from});}}
  const clearRoad=(x:number,z:number,extra:number)=>!roads.some(r=>r.pts.some((p,i)=>i>0&&distToSeg(x,z,r.pts[i-1],p)<r.width/2+r.sidewalk+extra));
  const trees:Recipe['trees']=[],buildings:Recipe['buildings']=[],props:Recipe['props']=[],cameras:Recipe['cameras']=[];
  const species=biome==='alpine'?'blue-spruce':biome==='desert'?'juniper':biome==='plains'?'cottonwood':'ponderosa-pine';
  const spacing=biome==='desert'||biome==='plains'?48:26;
  for(let x=bounds.minX+12;x<bounds.maxX-12;x+=spacing)for(let z=bounds.minZ+12;z<bounds.maxZ-12;z+=spacing){const px=x+(random()-.5)*16,pz=z+(random()-.5)*16;if(random()<.35||!clearRoad(px,pz,9))continue;const h=biome==='desert'?3+random()*3:7+random()*10;trees.push({p:[px,pz],y:height(px,pz),species,height:h,crown:h*.45,seed:hashString(`outskirts:${px}:${pz}`)});}
  for(const road of roads){for(let i=1;i<road.pts.length;i+=5){const p=road.pts[i],a=road.pts[i-1],len=Math.hypot(p[0]-a[0],p[1]-a[1])||1,nx=-(p[1]-a[1])/len,nz=(p[0]-a[0])/len;
      const cp:Vec2=[p[0]+nx*(road.width/2+3),p[1]+nz*(road.width/2+3)];
      if(contains(bounds,...cp,8)&&cameras.length<6)cameras.push({id:`outskirts:${key}:${cameras.length}`,type:'pole',p:cp,y:height(...cp),heading:Math.atan2(-nx,nz),poleHeight:5,cuttable:true,fovDeg:55,rangeM:45,plateReader:true,mapped:true});
      const bp:Vec2=[p[0]+nx*30,p[1]+nz*30];if(!contains(bounds,...bp,20)||!clearRoad(...bp,14)||buildings.length>=10)continue;
      const id=`outskirts-home:${key}:${buildings.length}`,seed=hashString(id);
      buildings.push({id,footprint:[[bp[0]-6,bp[1]-4],[bp[0]-6,bp[1]+4],[bp[0]+6,bp[1]+4],[bp[0]+6,bp[1]-4]],baseY:height(...bp),height:3.2,roofHeight:2,levels:1,roof:{type:'gable',material:'asphalt-shingle',color:'#494b48'},use:'residential-single',era:'1940-1969',kit:biome==='desert'?'pueblo':'ranch',material:biome==='desert'?'stucco':'lap-siding',color:biome==='desert'?'#b8a48b':'#aaa497',seed,storefront:false,streetEdges:[0]});
    }}
  const result:Recipe={...root,name:`${root.name} · generated outskirts`,bounds,terrain,farTerrain:undefined,roads,graph,buildings,areas:[],trees,props,cameras,attribution:[...root.attribution,CONTINUATION_ATTRIBUTION]};
  return rebaseRecipe(result,root,bounds);
}
