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
const r=second.recipe.roads.find(r=>r.pts.some(p=>p[0]>1300)&&r.pts.some(p=>p[0]<1001)&&Math.abs(r.pts[0][1]-244)<40)??second.recipe.roads.find(r=>r.pts.some(p=>p[0]>1300)&&r.pts.some(p=>p[0]<1001));
check('A road continues beyond the original source pack',!!r);
let cross;
for(let i=1;i<r.pts.length;i++){const a=r.pts[i-1],b=r.pts[i];if((a[0]-1000)*(b[0]-1000)<=0&&Math.abs(b[0]-a[0])>1){const t=(1000-a[0])/(b[0]-a[0]);cross={z:a[1]+(b[1]-a[1])*t,dx:b[0]-a[0],dz:b[1]-a[1]};break;}}
check('Continued road crosses district boundary',!!cross);
if(cross.dx<0){cross.dx*=-1;cross.dz*=-1;}
const len=Math.hypot(cross.dx,cross.dz),dx=cross.dx/len,dz=cross.dz/len;
const z=cross.z+Math.max(1.5,r.width/4)/Math.max(.3,dx);
const seam=[g.world.groundAt(999.99,z),g.world.groundAt(1000.01,z)];
check('Generated road seam is smooth',Math.abs(seam[0]-seam[1])<.15,seam);
for(const v of g.vehicles.all())g.vehicles.despawn(v.id);
for(const slot of g.vehicles.parking.query(1000,z,100))g.vehicles.parking.activate(slot);
const car=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[1000-dx*22,z-dz*22],heading:Math.atan2(dx,dz),physics:true});g.__enter(car.id);
const render=g.renderFrame,delta=g.clock.getDelta;g.renderFrame=()=>{};g.clock.getDelta=()=>1/60;g.prof=null;g.input.enabled=true;p.controlsEnabled=true;
const step=()=>{g.paused=false;g.frame();g.paused=true;};for(let i=0;i<90;i++)step();
car.body.setLinvel({x:dx*13,y:0,z:dz*13},true);
for(let i=0;i<180;i++)step();
g.renderFrame=render;g.clock.getDelta=delta;
check('Vehicle crosses into offline continuation without falling',car.position.x>1005&&Number.isFinite(car.position.y)&&Math.abs(car.position.y-g.world.groundAt(car.position.x,car.position.z))<2,{x:car.position.x,y:car.position.y,health:car.health});
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
