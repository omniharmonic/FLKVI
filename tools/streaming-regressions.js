(async()=>{
const g=game,R=g.rapier,p=g.player;g.paused=true;g.removeSystem('ai');
await g.world.streaming.request(1,0);
for(const v of g.vehicles.all())g.vehicles.despawn(v.id);
for(const slot of g.vehicles.parking.query(600,243,200))g.vehicles.parking.activate(slot);
const heights=[];for(const x of [596,598,599,599.99,600.01,601,602,604])heights.push([x,g.world.groundAt(x,244.4)]);
const v=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[575,244.4],heading:Math.PI/2,physics:true});g.__enter(v.id);
const render=g.renderFrame,delta=g.clock.getDelta;g.renderFrame=()=>{};g.clock.getDelta=()=>1/60;g.prof=null;g.input.enabled=true;p.controlsEnabled=true;
const step=()=>{g.paused=false;g.frame();g.paused=true;};for(let i=0;i<90;i++)step();
v.body.setLinvel({x:15,y:0,z:0},true);dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW'}));
const impacts=[];let health=v.health;
for(let i=0;i<300;i++){step();if(v.health!==health){impacts.push({x:v.position.x,z:v.position.z,health:v.health});health=v.health;}}
dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW'}));g.renderFrame=render;g.clock.getDelta=delta;
const checks=[['Bundled district is ready',g.world.streaming.isReady(650,244.4)],['Car crosses real road seam',v.position.x>630],['Road seam causes no damage',v.health===100&&impacts.length===0],['Road surface has no large step',Math.abs(heights[3][1]-heights[4][1])<.08]];
if(checks.some(c=>!c[1]))throw Error(JSON.stringify({checks,heights,impacts}));
return {passed:checks.length,checks,heights,health:v.health,position:v.position};
})()
