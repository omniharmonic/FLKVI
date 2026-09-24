(async()=>{
const g=game,R=g.rapier;g.paused=true;g.removeSystem('ai');g.removeSystem('world-streaming');
for(const v of g.vehicles.all())g.vehicles.despawn(v.id);
g.world.groundAt=()=>100;g.world.heightAt=()=>100;
const pad=g.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0,99.5,0));g.physics.createCollider(R.ColliderDesc.cuboid(60,.5,60),pad);
const a=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[0,20],heading:0,physics:true});
a.driver='player';
const step=n=>{for(let i=0;i<n;i++){g.vehicles.fixedUpdate(1/60);g.physics.timestep=1/60;g.physics.step();g.vehicles.afterPhysics(1/60);for(const v of g.vehicles.vehicles.values())v.sync(1/60);}};
step(90);
const before=a.health; a.control.throttle=1;step(90);a.control.throttle=0;a.control.brake=1;step(90);a.control.brake=0;
const braking=a.health;
a.body.setTranslation({x:0,y:100.1,z:15},true);a.body.setLinvel({x:0,y:0,z:0},true);a.body.setAngvel({x:0,y:0,z:0},true);a.sync(0);step(60);
const b=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[0,0],heading:0,physics:false});step(2);
a.body.setLinvel({x:0,y:0,z:-17},true);
let promotedDistance=null,maxY=0,maxTransfer=0;const hist=[];
for(let i=0;i<150;i++){step(1);if(b.physicsMode==='dynamic'&&promotedDistance===null)promotedDistance=Math.abs(a.position.z-b.position.z);maxY=Math.max(maxY,a.body.linvel().y,b.body.linvel().y);maxTransfer=Math.max(maxTransfer,-b.body.linvel().z);if(i%15===0)hist.push({i,az:a.position.z,bz:b.position.z,av:a.body.linvel().z,bv:b.body.linvel().z,health:[a.health,b.health]});}
const checks=[['Acceleration and braking cause no collision damage',before===braking],['Traffic promoted before hull contact',promotedDistance>4.4],['Both cars sustain physical impact damage',a.health<95&&b.health<95],['Collision transfers momentum',maxTransfer>3],['Crash avoids artificial vertical launch',maxY<5],['Bodies remain finite',Number.isFinite(a.position.x+b.position.x+a.position.y+b.position.y)]];
const wall=g.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(20,101,-15));
g.physics.createCollider(R.ColliderDesc.cuboid(5,1.5,.5),wall);
const c=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[20,0],heading:0,physics:true});c.driver='player';step(90);
c.body.setLinvel({x:0,y:0,z:-22},true);step(150);
checks.push(['A solid wall absorbs speed and damages the car',c.health<80&&Math.abs(c.body.linvel().z)<3]);
checks.push(['CCD keeps the car on the near side of the wall',c.position.z>-15&&c.position.y>99]);
const failed=checks.filter(c=>!c[1]);
if(failed.length)throw Error(JSON.stringify({failed,hist}));
return {passed:checks.length,checks,promotedDistance,maxY,maxTransfer,before,braking,health:[a.health,b.health]};
})()
