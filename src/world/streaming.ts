// Runtime district streaming for static hosting: one network/build job, bounded residency, retry/backoff.
import type { Game, System } from '../core/game';
import type { Recipe } from '../core/types';
import { makeProjection } from '../core/geo';
import { bundledDistrict } from '../compiler/expansion';
import { continuationDistrict, isContinuation } from '../compiler/continuation';
import { loadDistrict } from '../compiler/district-cache';
import { buildDistrict, type District } from './district';
import { contains, distanceTo, districtIndex, districtBounds, rebaseRecipe, type Bounds } from './stream-coordinates';
import type { PropSystem } from './props';
import type { Heightfield } from './terrain';
import { groups, GROUP_STATIC } from './physics';

const MAX_RESIDENT = 5, PREFETCH = 380;
import { streamedTerrainBounds } from './stream-uniforms';
export class WorldStreaming implements System {
  name='world-streaming';order=48;
  readonly districts=new Map<string,District>();
  readonly core: Bounds;
  status=''; loading:string|null=null;
  private failures=new Map<string,{until:number;attempts:number}>();
  private nextBuildAt=0;
  private job:Promise<void>|null=null;
  private generated=new Map<string,Recipe>();
  private networkRetryAt=0;
  private tick=0;private toastAt=-100;private barriers: ReturnType<Game['physics']['createRigidBody']>;
  private buildingIds: Set<string>;
  constructor(private g:Game,private initial:Heightfield,private streetLights?:PropSystem){
    this.core={minX:initial.ox,minZ:initial.oz,maxX:initial.maxX,maxZ:initial.maxZ};
    this.buildingIds=new Set(g.recipe.buildings.map(b=>b.id));
    this.barriers=g.physics.createRigidBody(g.rapier.RigidBodyDesc.fixed());
    const base=g.world, cover=base.coverAt?.bind(base), height=base.heightAt.bind(base), ground=base.groundAt.bind(base);
    base.heightAt=(x,z)=>this.find(x,z)?.hf.sample(x,z)??height(x,z);
    base.groundAt=(x,z)=>this.find(x,z)?.groundAt(x,z)??ground(x,z);
    base.coverAt=(x,z)=>this.find(x,z)?.coverAt(x,z)??cover?.(x,z)??ground(x,z);
    base.streaming=this;
    this.rebuildBarriers();
  }
  recipes(){return [...this.districts.values()].map(d=>d.recipe);}
  private find(x:number,z:number){if(contains(this.core,x,z))return undefined;for(const d of this.districts.values())if(contains(d.bounds,x,z))return d;}
  private ready(i:number,j:number){return i===0&&j===0||this.districts.has(`${i},${j}`);}
  /** Public read-only coverage query used by tools and the map. */
  isReady(x:number,z:number){return contains(this.core,x,z)||!!this.find(x,z);}
  private seam=(x:number,z:number):number|undefined=>{
    if(contains(this.core,x,z))return this.initial.sample(x,z);
    for(const d of this.districts.values())if(contains(d.bounds,x,z))return d.hf.sample(x,z);
    return undefined;
  };
  update(dt:number){
    for(const d of this.districts.values())d.update(dt);
    if(!this.g.player || new URLSearchParams(location.search).has('nostream'))return;
    this.tick-=dt;if(this.tick>0)return;this.tick=0.5;
    const p=this.g.player.position, v=this.g.player.velocity;
    const i=districtIndex(p.x,this.core.minX,this.core.maxX),j=districtIndex(p.z,this.core.minZ,this.core.maxZ);
    const options:{i:number;j:number;score:number}[]=[];
    for(let a=i-1;a<=i+1;a++)for(let b=j-1;b<=j+1;b++){
      if(this.ready(a,b))continue;
      const bounds=districtBounds(this.core,a,b),d=distanceTo(bounds,p.x,p.z);
      if(d>PREFETCH)continue;
      const key=`${a},${b}`,retry=this.failures.get(key);
      if(d<35&&this.g.elapsed-this.toastAt>8){this.toastAt=this.g.elapsed;this.g.events.emit('toast',{text:retry?'Map data unavailable. Retrying shortly.':'Loading the next district…',kind:'info',ms:3500});}
      if(retry&&retry.until>this.g.elapsed)continue;
      // Prefer the direction of travel; still load adjacent corner tiles before crossing them.
      const ahead=distanceTo(bounds,p.x+v.x*6,p.z+v.z*6);
      options.push({i:a,j:b,score:d+ahead*0.7});
    }
    if(!this.loading&&options.length){options.sort((a,b)=>a.score-b.score);const next=options[0];
      if(performance.now()>=this.nextBuildAt||distanceTo(districtBounds(this.core,next.i,next.j),p.x,p.z)<160)void this.request(next.i,next.j);}
  }
  /** Injectable source supports deterministic seam/disposal tests without live map servers. */
  async request(i:number,j:number,source?:Recipe){
    while(this.job)await this.job;
    if(this.ready(i,j))return;
    const job=this.load(i,j,source);this.job=job;
    try{await job;}finally{if(this.job===job)this.job=null;}
  }
  private async load(i:number,j:number,source?:Recipe){
    const key=`${i},${j}`;if(this.ready(i,j))return;
    this.loading=key;
    try{
      const bounds=districtBounds(this.core,i,j),cx=(bounds.minX+bounds.maxX)/2,cz=(bounds.minZ+bounds.maxZ)/2;
      const ll=makeProjection(this.g.recipe.origin.lat,this.g.recipe.origin.lon).toLatLon(cx,cz);
      this.status='Loading nearby streets';
      let raw=source??this.generated.get(key)??await bundledDistrict(this.g.recipe,bounds);
      if(!raw&&performance.now()>=this.networkRetryAt){
        try{raw=await loadDistrict({...ll,name:this.g.recipe.name,half:Math.max(bounds.maxX-bounds.minX,bounds.maxZ-bounds.minZ)/2+24,farHalf:0,cell:4,lean:true},s=>{this.status=s;});}
        catch(e){this.networkRetryAt=performance.now()+45000;console.info('[streaming] map service unavailable, generating drivable outskirts',e);}
      }
      // The compiler's no-DEM flat fallback is valid for an initial world, but not beside
      // a mountain town with an existing elevation datum (it would put roads kilometres below it).
      if(raw&&Math.abs(this.g.recipe.elevation??0)>300&&(raw.elevation??0)===0&&raw.terrain.heights.every(y=>Math.abs(y)<.001))raw=undefined;
      const generate=()=>{
        const recipe=continuationDistrict(this.g.recipe,bounds,[
          {recipe:{...this.g.recipe,bounds:this.core},heightAt:(x,z)=>this.initial.sample(x,z),groundAt:(x,z)=>this.g.world.groundAt(x,z)},
          ...[...this.districts.values()].map(d=>({recipe:d.recipe,heightAt:(x:number,z:number)=>d.hf.sample(x,z),groundAt:d.groundAt})),
        ]);
        this.generated.set(key,recipe);
        if(this.generated.size>8)this.generated.delete(this.generated.keys().next().value!);
        return recipe;
      };
      let recipe=raw?rebaseRecipe(raw,this.g.recipe,bounds):generate();
      recipe.buildings=recipe.buildings.filter(b=>!this.buildingIds.has(b.id));
      // Initial recipe's margin already owns some props/buildings outside the terrain square.
      recipe.props=recipe.props.filter(p=>!this.g.recipe.props.some(q=>q.type===p.type&&Math.hypot(q.p[0]-p.p[0],q.p[1]-p.p[1])<0.8));
      recipe.spawn.p=[this.g.player.position.x,this.g.player.position.z];
      this.status='Building neighboring district';
      let d:District;
      try{d=await buildDistrict(this.g,key,recipe,this.seam);}
      catch(e){
        if(isContinuation(recipe)||this.g.renderer.getContext().isContextLost())throw e;
        console.warn('[streaming] district assembly failed; trying lightweight continuation',key,e);
        recipe=generate();d=await buildDistrict(this.g,key,recipe,this.seam);
      }
      this.districts.set(key,d);for(const b of recipe.buildings)this.buildingIds.add(b.id);
      this.failures.delete(key);this.status='';
      if(isContinuation(recipe))this.g.events.emit('toast',{text:'Map service unavailable — exploring generated outskirts.',kind:'info',ms:5000});
      this.evict();this.rebuildBarriers();this.updateBackdrop();
      this.streetLights?.setResidentLamps([...this.districts.values()].flatMap(d=>[...d.lamps]));
      this.g.events.emit('districtsChanged',{recipes:[...this.districts.values()].map(d=>d.recipe)});
    }catch(e){
      const attempts=(this.failures.get(key)?.attempts??0)+1;
      this.failures.set(key,{attempts,until:this.g.elapsed+Math.min(120,15*2**(attempts-1))});
      // Bound retry metadata during long trips.
      if(this.failures.size>24)this.failures.delete(this.failures.keys().next().value!);
      this.status='Waiting for map data';console.warn('[streaming] district failed',key,e);
    }finally{this.loading=null;this.nextBuildAt=performance.now()+2000;}
  }
  private evict(){
    const p=this.g.player.position;
    const entries=[...this.districts.values()].sort((a,b)=>distanceTo(b.bounds,p.x,p.z)-distanceTo(a.bounds,p.x,p.z));
    while(this.districts.size>(this.g.quality==='low'?2:3)&&entries.length){
      const d=entries.shift()!;if(distanceTo(d.bounds,p.x,p.z)<60)continue;
      // Never remove collision beneath an occupied vehicle.
      if(this.g.player.vehicleId){const v=this.g.vehicles.get(this.g.player.vehicleId);if(v&&contains(d.bounds,v.position.x,v.position.z))continue;}
      this.districts.delete(d.key);for(const b of d.recipe.buildings)this.buildingIds.delete(b.id);d.dispose();
    }
  }
  private updateBackdrop(){let k=0;for(const d of this.districts.values()){if(k===MAX_RESIDENT)break;const b=d.bounds;streamedTerrainBounds.value[k++].set(b.minX,b.minZ,b.maxX,b.maxZ);}for(;k<MAX_RESIDENT;k++)streamedTerrainBounds.value[k].setScalar(1e9);}
  private rebuildBarriers(){
    const W=this.g.physics,R=this.g.rapier;
    while(this.barriers.numColliders())W.removeCollider(this.barriers.collider(0),false);
    const keys=['0,0',...this.districts.keys()];
    for(const key of keys){const [i,j]=key.split(',').map(Number),b=districtBounds(this.core,i,j);
      for(const [di,dj]of [[-1,0],[1,0],[0,-1],[0,1]]){
        if(this.ready(i+di,j+dj))continue;
        const x=di<0?b.minX:di>0?b.maxX:(b.minX+b.maxX)/2,z=dj<0?b.minZ:dj>0?b.maxZ:(b.minZ+b.maxZ)/2;
        // Tall safety boundary prevents driving/falling into a district whose terrain is not ready.
        W.createCollider(R.ColliderDesc.cuboid(di?0.3:(b.maxX-b.minX)/2,2000,dj?0.3:(b.maxZ-b.minZ)/2)
          .setTranslation(x,0,z).setCollisionGroups(groups(GROUP_STATIC)).setFriction(0).setRestitution(0),this.barriers);
      }
    }
  }
}
