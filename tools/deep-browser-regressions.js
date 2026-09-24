// Full-city deterministic regression fixtures. Run only in a disposable browser session.
(async()=>{
 const g=game,p=g.player,R=g.rapier;
 const THREE=await import('/node_modules/.vite/deps/three.js');
 const {Nav}=await import('/src/world/nav.ts');
 const nav=new Nav({nodes:[{id:123,p:[0,0]},{id:456,p:[10,0]}],edges:[{from:0,to:1,length:10,speed:5}]},{});
 const {Heightfield}=await import('/src/world/terrain.ts');
 const {buildTerrainCollider}=await import('/src/world/physics.ts');
 const {districtBounds}=await import('/src/world/stream-coordinates.ts');
 g.paused=true;g.sky.cyclePaused=true;g.removeSystem('ai');
 document.querySelector('.gt-clickplay')?.remove();
 const checks=[];const check=(name,pass,detail='')=>checks.push({name,pass:!!pass,detail});
 check('Routing distinguishes OSM identities from graph indices',nav.route(123,456).join(',')==='123,456');
 const originalRender=g.renderFrame,originalDelta=g.clock.getDelta;
 g.renderFrame=()=>{};g.clock.getDelta=()=>1/60;g.prof=null;g.input.enabled=true;p.controlsEnabled=true;
 const step=(n=1)=>{g.paused=false;for(let i=0;i<n;i++)g.frame();g.paused=true;};
 const key=(code,on=true)=>dispatchEvent(new KeyboardEvent(on?'keydown':'keyup',{code}));
 const tap=code=>{key(code);key(code,false);};
 const s=g.world.streaming,core=s.core,edge=core.maxX;
 const blank=(i,j)=>{
   const b=districtBounds(core,i,j),cols=(b.maxX-b.minX)/4+1,rows=(b.maxZ-b.minZ)/4+1;
   return {...g.recipe,name:'Regression district',bounds:b,farTerrain:undefined,
     terrain:{originX:b.minX,originZ:b.minZ,cellSize:4,cols,rows,heights:Array(cols*rows).fill(-8)},
     roads:[],graph:{nodes:[],edges:[]},buildings:[],trees:[],areas:[],props:[],cameras:[],spawn:{p:[b.minX+40,0],y:-8,heading:Math.PI/2}};
 };
 const beforeBodies=g.physics.bodies.len();
 const sentinel=g.physics.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0,100,0));
 g.physics.createCollider(R.ColliderDesc.ball(0.2),sentinel);
 const terrainCol=buildTerrainCollider(g,new Heightfield(3,3,3000,3000,4));
 check('Attaching terrain never steps existing physics',sentinel.translation().y===100);
 g.physics.removeRigidBody(terrainCol.parent());g.physics.removeRigidBody(sentinel);
 // An unfinished boundary is solid, even for vehicles with CCD.
 g.physics.step();
 const wall=g.physics.castRay(new R.Ray({x:edge-10,y:20,z:0},{x:1,y:0,z:0}),30,true);
 check('Unloaded edge has a solid safety boundary',wall&&wall.timeOfImpact<11);
 const freeCar=g.ai.traffic.addFreeCar('police',p.position.x+10,p.position.z,0.3);
 const freePose=[freeCar.x,freeCar.z,freeCar.h];
 await s.request(1,0,blank(1,0));
 check('District refresh preserves free-driving AI pose and mode',freeCar.mode==='free'&&[freeCar.x,freeCar.z,freeCar.h].every((v,i)=>v===freePose[i]));
 g.ai.traffic.removeCar(freeCar);
 check('Neighbor district attaches',s.districts.has('1,0'),s.status);
 check('Coverage extends beyond initial map',s.isReady(edge+150,0));
 const d=s.districts.get('1,0');
 check('Terrain seams share the same elevation',d&&Math.abs(d.hf.sample(edge,0)-s.initial.sample(edge,0))<0.005);
 g.physics.step();
 const open=g.physics.castRay(new R.Ray({x:edge-10,y:20,z:0},{x:1,y:0,z:0}),30,true);
 check('Loaded seam removes safety boundary',!open);
 const ground=g.world.groundAt(edge+80,0),ray=g.physics.castRay(new R.Ray({x:edge+80,y:100,z:0},{x:0,y:-1,z:0}),200,true);
 check('Streamed visual terrain has matching collision',ray&&Math.abs(100-ray.timeOfImpact-ground)<0.015,{ground,hit:ray&&100-ray.timeOfImpact});
 p.respawn([edge+80,30],0);step(30);
 tap('KeyG');step();check('Keyboard punch starts without pointer lock',p.character.oneShot?.key==='jab'||p.character.oneShot?.key==='punch');
 step(50);tap('Space');step();check('Jump start clip is triggered',p.character.oneShot?.key==='jumpStart');
 let landed=false;for(let i=0;i<70;i++){step();if(p.character.oneShot?.key==='land')landed=true;}
 check('Landing clip is triggered',landed);
 p.hurt(10);check('Damage plays hit reaction',p.character.oneShot?.key==='hit');step(70);
 // Two civilians in the same punch cone: only the nearest is struck.
 const a=g.ai.peds.acquire(),b=g.ai.peds.acquire();
 for(const [q,dz]of [[a,-0.85],[b,-1.2]]){q.x=p.position.x;q.z=p.position.z+dz;q.y=p.position.y;q.state='idle';q.ch.root.position.set(q.x,q.y,q.z);}
 p.camera.yaw=0;tap('KeyG');step(16);
 check('Punch hits nearest civilian only',a.state==='fallen'&&b.state!=='fallen',{a:a.state,b:b.state});
 check('Falling uses the authored animation',a.ch.role==='fall');
 a.ch.setFallen(false);check('Recovery uses the authored get-up animation',a.ch.role==='getup');
 g.ai.peds.release(a);g.ai.peds.release(b);step(40);
 const behind=g.ai.peds.acquire();behind.x=p.position.x;behind.z=p.position.z-1;behind.y=p.position.y;behind.state='idle';
 const blocker=g.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(p.position.x,p.position.y+1,p.position.z-0.5));
 g.physics.createCollider(R.ColliderDesc.cuboid(2,1,0.1),blocker);g.physics.step();tap('KeyG');step(16);
 check('Punch cannot hit through a wall',behind.state!=='fallen');g.physics.removeRigidBody(blocker);g.ai.peds.release(behind);
 step(40);const officer=g.ai.police.makeOfficer(null,p.position.x,p.position.z-0.8,0);
 tap('KeyG');step(16);check('Punch knocks down an officer',officer.stunned>0&&officer.ch.role==='fall');g.ai.police.removeOfficer(officer);
 // Driving across the original edge; the current car remains a full physics body.
 const v=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[edge-8,0],heading:Math.PI/2,physics:true});
 game.__enter(v.id);step(60);key('KeyW');step(180);key('KeyW',false);
 check('Car drives across the original map edge',v.position.x>edge+12&&v.position.y>-20,{x:v.position.x,y:v.position.y,speed:v.speed});
 const q=g.vehicles.spawn({kind:'civilian',model:'sedan',p:[edge+40,60],heading:0,physics:true});
 const shared=q.visual.bodyMesh.geometry;
 const vertices=Array.from(v.visual.bodyMesh.geometry.attributes.position.array);
 g.vehicles.damage(v,45,new THREE.Vector3(-10,0,0),v.position.clone().add(new THREE.Vector3(v.model.W,0.7,0)));
 const after=v.visual.bodyMesh.geometry.attributes.position.array;
 check('Impact deforms actual body vertices',vertices.some((n,i)=>Math.abs(n-after[i])>0.00001));
 check('Damage does not modify another car mesh',q.visual.bodyMesh.geometry===shared&&q.health===100&&v.visual.bodyMesh.geometry!==shared);
 check('Damage affects alignment and condition',v.health===55&&Math.abs(v.alignment)>0);
 check('Damage records a paint scuff',v.visual.bodyMesh.material[0].carUniforms.uDamage.value.some(d=>d.w>0));
 g.sky.wet=1;v.fixedUpdate(1/60);check('Wet weather lowers tire grip',v.gripFactor<0.8);
 g.sky.wet=0;v.fixedUpdate(1/60);check('Dry grip returns',v.gripFactor===1);
 p.exitVehicle(true);g.vehicles.despawn(v.id);g.vehicles.despawn(q.id);
 // Real weather shaders render, and roof sampling rejects rain below a known covered surface.
 for(const weather of ['clear','overcast','rain','storm','fog']){
   g.sky.setWeather(weather);for(let i=0;i<15;i++)g.sky.update(1);originalRender(0);
   check(`Weather ${weather} renders`,g.sky.weather===weather&&g.renderer.info.render.calls>0);
 }
 g.sky.rainFx.update(1,g.camera.position,1,new THREE.Color(1,1,1),()=>12,1);
 check('Rain occlusion samples roof height',g.sky.rainFx.coverData.every(v=>v===12));
 check('Rain splash geometry stays above surfaces',g.sky.rainFx.splashPos.every((v,i)=>i%3!==1||Math.abs(v-12.06)<0.001));
 // Push past the residency limit, then come back: old districts release their colliders and meshes.
 p.respawn([0,0],0);let disposed=false;d.root.traverse(o=>{if(o.isMesh)o.geometry.addEventListener('dispose',()=>disposed=true);});
 for(const [i,j]of [[2,0],[3,0],[4,0],[5,0],[6,0]]){p.position.set(core.maxX+(i-1)*400+100,0,0);await s.request(i,j,blank(i,j));}
 check('District residency stays bounded',s.districts.size<=5,s.districts.size);
 check('Evicted district releases its scene geometry',!d.root.parent&&disposed);
 check('Evicted district is no longer traversable',!s.isReady(edge+100,0));
 check('Collider count remains finite',g.physics.bodies.len()<beforeBodies+60,{before:beforeBodies,after:g.physics.bodies.len()});
 g.renderFrame=originalRender;g.clock.getDelta=originalDelta;g.input.reset();
 const failed=checks.filter(c=>!c.pass);if(failed.length)throw Error(JSON.stringify({checks,failed}));
 return {passed:checks.length,checks};
})()
