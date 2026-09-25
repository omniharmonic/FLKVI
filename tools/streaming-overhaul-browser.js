(async()=>{
const g=game,s=g.world.streaming,p=g.player;
g.paused=true;g.removeSystem('ai');
const settle=async()=>{g.paused=false;await new Promise(r=>setTimeout(r,1200));g.paused=true;};
const checks=[],check=(name,ok,details)=>{checks.push({name,ok,details});if(!ok)throw Error(JSON.stringify(checks));};
await s.request(1,0);
check('Bundled first ring available',s.isReady(800,244));
// Newly streamed buildings must render complete walls even before their first update.
const missingWalls=[];
s.districts.get('1,0').root.traverse(mesh=>{
 if(!mesh.isMesh||mesh.parent?.name!=='lod1'||!mesh.parent.visible)return;
 if(mesh.geometry.index?.count>0&&!mesh.geometry.groups.some(group=>group.count>0))missingWalls.push(mesh.uuid);
});
check('Paused freshly loaded district has drawable facade groups',missingWalls.length===0,missingWalls);
await settle();
p.respawn([950,244]);
const started=performance.now();await s.request(2,0);
const second=s.districts.get('2,0');
check('Offline second ring finishes with generated terrain',!!second&&second.recipe.attribution.some(a=>a.startsWith('Procedural outskirts')),Math.round(performance.now()-started));
// Exercise a public carriageway, not a narrow service access beside roadside props.
const continuingRoads=second.recipe.roads.filter(r=>['primary','secondary','tertiary','residential','unclassified','living_street'].includes(r.cls)&&r.pts.some(p=>p[0]>1300)&&r.pts.some(p=>p[0]<1001));
const testServiceAlley=new URLSearchParams(location.search).has('test-service-alley');
const r=testServiceAlley?second.recipe.roads.find(r=>r.id==='w362660888'):(continuingRoads.find(r=>r.name==='Grove Street')??continuingRoads[0]);
check('A road continues beyond the original source pack',!!r);
let cross;
for(let i=1;i<r.pts.length;i++){const a=r.pts[i-1],b=r.pts[i];if((a[0]-1000)*(b[0]-1000)<=0&&Math.abs(b[0]-a[0])>1){const t=(1000-a[0])/(b[0]-a[0]);cross={z:a[1]+(b[1]-a[1])*t,dx:b[0]-a[0],dz:b[1]-a[1]};break;}}
check('Continued road crosses district boundary',!!cross);
if(cross.dx<0){cross.dx*=-1;cross.dz*=-1;}
const len=Math.hypot(cross.dx,cross.dz),dx=cross.dx/len,dz=cross.dz/len;
// A 5m single-lane road cannot fit a sedan at a forced 1.5m offset.
// Centre narrow lanes; use the travel lane centre on wider roads.
const z=cross.z+(r.width>=6?r.width/4:0)/Math.max(.3,dx);
const seam=[g.world.groundAt(999.99,z),g.world.groundAt(1000.01,z)];
check('Generated road seam is smooth',Math.abs(seam[0]-seam[1])<.15,seam);
for(const v of g.vehicles.all())g.vehicles.despawn(v.id);
for(const slot of g.vehicles.parking.query(1000,z,100))g.vehicles.parking.activate(slot);
const car=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[1000-dx*22,z-dz*22],heading:Math.atan2(dx,-dz),physics:true});g.__enter(car.id);
const render=g.renderFrame,delta=g.clock.getDelta;g.renderFrame=()=>{};g.clock.getDelta=()=>1/60;g.prof=null;g.input.enabled=true;p.controlsEnabled=true;
const step=()=>{g.paused=false;g.frame();g.paused=true;};
const samples=[];let start,firstBeyondSeam=null,maxGroundGap=0,finite=true;
try {
 g.input.reset();for(let i=0;i<90;i++)step();start=car.position.clone();
 // Use the actual keyboard/player/engine path. A one-time velocity followed by
 // three seconds of engine braking measured coast distance, not seam physics.
 dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w',bubbles:true}));
 for(let i=0;i<240;i++){
  step();
  const at=car.position,ground=g.world.groundAt(at.x,at.z);
  finite=finite&&Number.isFinite(at.x+at.y+at.z+ground);
  maxGroundGap=Math.max(maxGroundGap,Math.abs(at.y-ground));
  if(at.x>1005&&firstBeyondSeam===null)firstBeyondSeam=at.x;
  if(i%30===29)samples.push({frame:i+1,x:at.x,z:at.z,speed:Math.hypot(car.velocity.x,car.velocity.z),health:car.health});
 }
} finally {
 dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w',bubbles:true}));g.input.reset();
 g.renderFrame=render;g.clock.getDelta=delta;
}
const drivenProgress=(car.position.x-start.x)*dx+(car.position.z-start.z)*dz;
check('Throttle drives across offline seam with sustained grounded progression and no damage',
 start.x<1000&&car.position.x>1020&&firstBeyondSeam!==null&&car.position.x-firstBeyondSeam>10&&drivenProgress>35&&finite&&maxGroundGap<2&&car.health===100&&samples.at(-1).speed>3,
 {start:{x:start.x,z:start.z},x:car.position.x,y:car.position.y,health:car.health,drivenProgress,maxGroundGap,samples});
p.respawn([1200,z]);g.vehicles.despawn(car.id);
const residency=[];
for(let i=3;i<=6;i++){
 p.respawn([600+(i-1)*400-45,z]);await s.request(i,0);
 check(`Offline ring ${i} loads`,s.isReady(600+(i-1)*400+30,z));
 await settle();
 residency.push({ring:i,resident:s.districts.size,bodies:g.physics.bodies.len(),colliders:g.physics.colliders.len(),geometries:g.renderer.info.memory.geometries,textures:g.renderer.info.memory.textures});
}
check('District residency stays bounded while travelling',residency.every(r=>r.resident<=3),residency);
check('Old far district evicts and releases scene root',!s.districts.has('1,0')&&!g.scene.getObjectByName('district:1,0'));
p.respawn([950,z]);await s.request(1,0);
await settle();
check('Evicted bundled district rebuilds on return',s.isReady(800,z)&&!!g.scene.getObjectByName('district:1,0'));
check('Streaming slot is released after all jobs',s.loading===null);
check('All compiled shader programs are runnable',g.renderer.info.programs.every(program=>program.diagnostics?.runnable!==false));
return {passed:checks.length,checks,residency};
})()
