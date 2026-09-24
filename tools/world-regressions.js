// Disposable browser test: quality/resolution, frozen-scene culling, night lighting and real hold-to-act input.
// The uncull sample reconstructs the previous traffic submissions without moving the camera or simulation.
(async()=>{
 const g=game; const {saveSettings}=await import('/src/ui/settings.ts');
 const checks=[];const check=(name,pass,detail)=>checks.push({name,pass:!!pass,detail});
 g.paused=true;g.sky.cyclePaused=true;document.querySelector('.gt-clickplay')?.remove();
 check('World services booted',g.player&&g.physics&&g.ai&&g.surveillance);
 check('Player agrees with rendered ground',Math.abs(g.player.position.y-g.world.groundAt(g.player.position.x,g.player.position.z))<0.15);
 const widths=[];
 for(const quality of ['high','medium','low','high']){
   __render.setQuality(quality);saveSettings({resScale:0.65});
   const expected=(quality==='low'?Math.min(devicePixelRatio,1)*0.8:Math.min(devicePixelRatio,quality==='high'?1.5:1))*0.65;
   const actual=g.renderer.getPixelRatio();
   check(`Resolution preserved at ${quality}`,Math.abs(actual-expected)<0.0001,actual);
   check(`Composer size matches canvas at ${quality}`,Math.abs(__render.post.composer.inputBuffer.width-g.renderer.domElement.width)<=1);
   widths.push(g.renderer.domElement.width);
 }
 saveSettings({resScale:1});
 // Same frozen scene and camera: isolate vehicle submission cost from variable traffic population.
 const v=g.vehicles, originalTest=v.viewFrustum.intersectsSphere;
 const sample=async()=>{g.prof={};await new Promise(resolve=>{let n=0;const tick=()=>{if(++n===120)resolve();else requestAnimationFrame(tick)};requestAnimationFrame(tick)});return {draws:g.renderer.info.render.calls,triangles:g.renderer.info.render.triangles,cpuMs:g.prof.total/g.prof.frames,frames:g.prof.frames};};
 v.viewFrustum.intersectsSphere=()=>true;v.lateUpdate(0);
 v.shadows.begin();for(const car of v.vehicles.values())if(!v.sleepyParked(car)&&car.object.parent)v.shadows.add(car.model,car.visual.chassis.matrixWorld);v.shadows.end();
 const uncull=await sample();
 v.viewFrustum.intersectsSphere=originalTest;v.lateUpdate(0);const culled=await sample();
 check('Culling reduces submitted geometry',culled.triangles<uncull.triangles,{uncull,culled});
 for(const quality of ['medium','low']){__render.setQuality(quality);const world=g.systems.find(s=>s.name==='world');world.update(0,g);world.update(0,g);v.parking.refresh(g.camera.position,true,g.camera);v.lateUpdate(0);g.renderFrame(0);check(`Quality ${quality} renders`,g.renderer.info.render.calls>0,g.renderer.info.render.triangles);}
 __render.setQuality('high');const world=g.systems.find(s=>s.name==='world');world.update(0,g);world.update(0,g);
 g.sky.time=21;for(let i=0;i<10;i++)g.sky.update(0.25);g.renderFrame(0);check('Night lighting renders',g.sky.nightFactor>0.9);
 g.sky.time=16.4;for(let i=0;i<10;i++)g.sky.update(0.25);
 // Hold-to-act through actual keyboard input and the main game loop.
 const p=g.player, s=__surv;const originalRender=g.renderFrame,originalDelta=g.clock.getDelta;
 g.clock.getDelta=()=>1/60;g.renderFrame=()=>{};g.input.enabled=true;p.controlsEnabled=true;
 const advance=n=>{g.paused=false;for(let i=0;i<n;i++)g.frame();g.paused=true;};
 let target=null;
 for(const c of [...s.net.cams].sort((a,b)=>a.work.distanceTo(p.position)-b.work.distanceTo(p.position)).slice(0,20)){
   if(c.status!=='active')continue;
   for(const [dx,dz]of [[1.2,0],[-1.2,0],[0,1.2],[0,-1.2]]){
     p.respawn([c.work.x+dx,c.work.z+dz],0);advance(15);
     if(s.targetCam(p.position)===c){target=c;break;}
   }
   if(target)break;
 }
 check('Camera reachable on foot',target);
 if(target){
   dispatchEvent(new KeyboardEvent('keydown',{code:'KeyE'}));for(let i=0;i<480&&target.status==='active';i++)advance(1);dispatchEvent(new KeyboardEvent('keyup',{code:'KeyE'}));
   check('Hold E disables a camera',target.status==='disabled',target.status);
   check('Takedown scores and frees movement',g.surveillance.score>0&&!p.busy,{score:g.surveillance.score,busy:p.busy});
 }
 g.clock.getDelta=originalDelta;g.renderFrame=originalRender;g.input.reset();g.paused=false;g.prof={};
 const failed=checks.filter(c=>!c.pass);if(failed.length)throw Error(JSON.stringify({checks,uncull,culled}));
 return {checks,uncull,culled};
})()
