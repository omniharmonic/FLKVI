// Deterministic, locally streamed landscape kits. Small opaque blades avoid alpha-card overdraw.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Recipe, RecipeArea, RecipeBuilding } from '../core/types';
import { rng, hashString } from '../core/geo';
import { Grid, pointInPoly } from './util';
import { recipeBiome, type Biome } from '../compiler/biome';
import { surfaceMaterial } from './materials';

const CELL = 80;
type Segment = { ax:number;az:number;dx:number;dz:number;len2:number;clear:number };
interface Index { recipe:Recipe; buildings:Grid<RecipeBuilding>; areas:Grid<RecipeArea>; roads:Grid<Segment>; biome:Biome }
function box(grid:Grid<any>, points: [number,number][], value:unknown, margin=0) {
  if(!points.length)return;
  const xs=points.map(p=>p[0]),zs=points.map(p=>p[1]);
  grid.addBox(Math.min(...xs)-margin,Math.min(...zs)-margin,Math.max(...xs)+margin,Math.max(...zs)+margin,value);
}
function index(recipe:Recipe):Index {
  const buildings=new Grid<RecipeBuilding>(32),areas=new Grid<RecipeArea>(48),roads=new Grid<Segment>(32);
  for(const b of recipe.buildings)box(buildings,b.footprint,b,1);
  for(const a of recipe.areas)box(areas,a.poly,a);
  for(const r of recipe.roads)for(let i=1;i<r.pts.length;i++){
    const a=r.pts[i-1],b=r.pts[i],dx=b[0]-a[0],dz=b[1]-a[1],clear=r.width/2+Math.max(r.sidewalk??0,r.sidewalkL??0,r.sidewalkR??0)+.8;
    box(roads,[a,b],{ax:a[0],az:a[1],dx,dz,len2:dx*dx+dz*dz,clear},clear);
  }
  return {recipe,buildings,areas,roads,biome:recipeBiome(recipe)};
}
function plantGeometry(kind:Biome) {
  const pos:number[]=[],colors:number[]=[];const random=rng(8264);
  const grass=new THREE.Color(kind==='desert'?'#737e50':kind==='plains'?'#b2a36b':kind==='alpine'?'#6d814d':'#768b51');
  const tips=new THREE.Color(kind==='desert'?'#b4b18a':kind==='plains'?'#d7bc7c':'#a6ad71');
  for(let i=0;i<11;i++){
    const a=random()*Math.PI*2,h=kind==='desert'?.4+random()*.55:.3+random()*.45,w=kind==='desert'?.045:.012+random()*.015;
    const dx=Math.cos(a),dz=Math.sin(a),offset=random()*.13,bend=.15+random()*.35;
    const v=(t:number,side:number)=>[dx*(offset+bend*t*t)-dz*w*(1-t)*side,t*h,dz*(offset+bend*t*t)+dx*w*(1-t)*side];
    for(let j=0;j<3;j++)for(const [t,side]of [[j/3,-1],[j/3,1],[(j+1)/3,1],[j/3,-1],[(j+1)/3,1],[(j+1)/3,-1]]){
      pos.push(...v(t,side));const c=grass.clone().lerp(tips,t*.65).multiplyScalar(.8+random()*.2);colors.push(c.r,c.g,c.b);
    }
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geo.computeVertexNormals();return geo;
}

export class GroundCover {
  name='ground-cover';order=52;
  readonly group=new THREE.Group();
  private indices:Index[];
  private indexCache = new WeakMap<Recipe, Index>();
  private chunks=new Map<string,THREE.Group>();
  private kits=new Map<Biome,{plant:THREE.BufferGeometry;rock:THREE.BufferGeometry;mat:THREE.Material}>();
  private timer=0;private quality='';
  private time={value:0};private range={value:100};
  private plantMat:THREE.MeshStandardMaterial;
  constructor(private g:Game){
    this.group.name='regional-ground-cover';g.scene.add(this.group);this.indices=[this.getIndex(g.recipe)];
    this.plantMat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.92,side:THREE.DoubleSide});
    this.plantMat.onBeforeCompile=sh=>{
      sh.uniforms.uCoverTime=this.time;sh.uniforms.uCoverRange=this.range;
      sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nuniform float uCoverTime;varying float vCoverDistance;')
        .replace('#include <begin_vertex>',`#include <begin_vertex>
          #ifdef USE_INSTANCING
          transformed.x+=sin(uCoverTime*1.7+instanceMatrix[3].x*.2+instanceMatrix[3].z*.15)*.065*position.y*position.y;
          #endif`)
        .replace('#include <project_vertex>',`#include <project_vertex>
          vCoverDistance=length(mvPosition.xyz);`);
      sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nuniform float uCoverRange;varying float vCoverDistance;')
        .replace('#include <clipping_planes_fragment>',`#include <clipping_planes_fragment>
          float coverFade=1.0-smoothstep(uCoverRange-24.0,uCoverRange,vCoverDistance);
          if(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)>coverFade)discard;`);
    };
    this.plantMat.customProgramCacheKey=()=> 'flk-ground-cover-v1';
    g.events.on('districtsChanged',({recipes})=>{
      this.indices=[this.getIndex(g.recipe),...recipes.map(r=>this.getIndex(r))];
      // Preserve unaffected plants. Re-indexing the entire initial city and rebuilding every nearby
      // instance buffer on each district arrival produced avoidable main-thread and GPU churn.
      for(const [key,root]of this.chunks) {
        const [i,j]=key.split(',').map(Number);
        if(!g.world.streaming?.isReady((i+.5)*CELL,(j+.5)*CELL))this.remove(key,root);
        else if(!root.children.length)this.remove(key,root);
      }
    });
  }
  private getIndex(recipe:Recipe){let cached=this.indexCache.get(recipe);if(!cached){cached=index(recipe);this.indexCache.set(recipe,cached);}return cached;}
  private kit(biome:Biome){
    let k=this.kits.get(biome);if(k)return k;
    const rock=new THREE.IcosahedronGeometry(1,2),p=rock.attributes.position;
    for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),n=1+.14*Math.sin(x*12+z*7)*Math.cos(y*9);p.setXYZ(i,x*n,y*n*.72,z*n);}
    rock.computeVertexNormals();
    k={plant:plantGeometry(biome),rock,mat:surfaceMaterial('alpine-rock',{tint:biome==='desert'?'#c9aa8b':'#d5d6ce',roughness:.92,patch:{worldUv:true,macro:.12,macroScale:3}})};
    this.kits.set(biome,k);return k;
  }
  private build(i:number,j:number){
    const g=this.g,random=rng(hashString(`${g.recipe.origin.lat}:${i},${j}`)),plants=new Map<Biome,THREE.Matrix4[]>(),rocks=new Map<Biome,THREE.Matrix4[]>();
    const obj=new THREE.Object3D(),count=g.quality==='high'?360:g.quality==='medium'?220:100;
    for(let n=0;n<count;n++){
      const x=(i+random())*CELL,z=(j+random())*CELL;
      if(!g.world.streaming?.isReady(x,z))continue;
      const ix=this.indices.find(d=>{const b=d.recipe.bounds;return x>=b.minX&&x<=b.maxX&&z>=b.minZ&&z<=b.maxZ;});if(!ix)continue;
      let blocked=false,lawn=false,natural=false;
      ix.areas.query(x,z,0,a=>{if(!pointInPoly(x,z,a.poly)||a.holes?.some(h=>pointInPoly(x,z,h)))return;
        if(['water','parking','pedestrian','plaza','pitch','playground','commercial','industrial'].includes(a.kind))blocked=true;
        if(['residential','park','grass','cemetery'].includes(a.kind))lawn=true;
        if(['forest','farmland','sand'].includes(a.kind))natural=true;
      });
      if(blocked)continue;
      ix.buildings.query(x,z,0,b=>{if(pointInPoly(x,z,b.footprint))blocked=true;});if(blocked)continue;
      ix.roads.query(x,z,0,r=>{const t=Math.max(0,Math.min(1,((x-r.ax)*r.dx+(z-r.az)*r.dz)/Math.max(.01,r.len2)));if(Math.hypot(x-r.ax-r.dx*t,z-r.az-r.dz*t)<r.clear)blocked=true;});if(blocked)continue;
      const y=g.world.groundAt(x,z),slope=Math.hypot(g.world.heightAt(x+1,z)-g.world.heightAt(x-1,z),g.world.heightAt(x,z+1)-g.world.heightAt(x,z-1))/2;
      if(slope>.85||Math.abs(y-g.world.heightAt(x,z))>.4)continue;
      // Managed lawns stay short; sparse open areas can carry rocks and taller native plants.
      const isRock=!lawn&&random()<(ix.biome==='alpine'?.09:ix.biome==='desert'?.06:.015);
      const size=isRock?.15+random()*.6:lawn?.12+random()*.18:ix.biome==='plains'?.7+random()*.55:.45+random()*.6;
      if(!natural&&!lawn&&random()>.6)continue;
      obj.position.set(x,y-(isRock?size*.2:.015),z);obj.rotation.set(0,random()*Math.PI*2,0);obj.scale.setScalar(size);obj.updateMatrix();
      const map=isRock?rocks:plants;let list=map.get(ix.biome);if(!list)map.set(ix.biome,list=[]);list.push(obj.matrix.clone());
    }
    const root=new THREE.Group();root.name=`cover:${i},${j}`;
    for(const [map,isRock]of [[plants,false],[rocks,true]] as const)for(const [biome,matrices]of map){
      const kit=this.kit(biome),m=new THREE.InstancedMesh(isRock?kit.rock:kit.plant,isRock?kit.mat:this.plantMat,matrices.length);
      matrices.forEach((v,i)=>m.setMatrixAt(i,v));m.instanceMatrix.needsUpdate=true;m.computeBoundingSphere();m.receiveShadow=true;m.castShadow=false;m.name=`${biome}-${isRock?'rocks':'plants'}`;root.add(m);
    }
    this.chunks.set(`${i},${j}`,root);this.group.add(root);
  }
  private remove(key:string,root:THREE.Group){root.removeFromParent();root.traverse(o=>{if((o as THREE.InstancedMesh).isInstancedMesh)(o as THREE.InstancedMesh).dispose();});this.chunks.delete(key);}
  private clear(){for(const [key,root]of this.chunks)this.remove(key,root);}
  update(dt:number){
    const g=this.g;this.time.value=g.elapsed;if(!g.player)return;
    if(this.quality!==g.quality){this.quality=g.quality;this.clear();}
    this.range.value=g.quality==='high'?115:g.quality==='medium'?85:55;
    this.timer-=dt;if(this.timer>0)return;this.timer=.12;
    const p=g.player.position,range=this.range.value,ci=Math.floor(p.x/CELL),cj=Math.floor(p.z/CELL);
    const candidates:{i:number;j:number;d:number}[]=[];
    for(let i=ci-2;i<=ci+2;i++)for(let j=cj-2;j<=cj+2;j++){
      const d=Math.hypot(Math.max(0,Math.abs((i+.5)*CELL-p.x)-CELL/2),Math.max(0,Math.abs((j+.5)*CELL-p.z)-CELL/2));
      if(d<range&&!this.chunks.has(`${i},${j}`))candidates.push({i,j,d});
    }
    for(const [key,root]of this.chunks){const [i,j]=key.split(',').map(Number);if(Math.hypot((i+.5)*CELL-p.x,(j+.5)*CELL-p.z)>range+CELL)this.remove(key,root);}
    candidates.sort((a,b)=>a.d-b.d);if(candidates.length)this.build(candidates[0].i,candidates[0].j);
  }
}
