(() => {
const g=game,stream=g.world.streaming;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frames=[],errors=[],samples=[],spikes=[];let phase="settling";let running=true,last=performance.now();
const timed=(object,key,name)=>{const original=object[key];if(!original)return;object[key]=function(...args){const t=performance.now();try{return original.apply(this,args);}finally{const ms=performance.now()-t;if(ms>40)spikes.push({name,ms,phase,at:performance.now(),elapsed:g.elapsed});}};};
for(const system of g.systems)for(const key of ['update','fixedUpdate','lateUpdate','afterPhysics'])timed(system,key,system.name+':'+key);
timed(g,'renderFrame','render');timed(g.physics,'step','physics');timed(g.events,'emit','event');
const observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())if(entry.duration>100)spikes.push({name:'longtask',ms:entry.duration,at:entry.startTime,phase});});observer.observe({entryTypes:['longtask']});
const nativeError=console.error;console.error=(...args)=>{if(errors.length<30)errors.push(args.map(String).join(' '));nativeError.apply(console,args);};
const tick=now=>{if(!running)return;frames.push(now-last);last=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
window.__soak={done:false};
(async()=>{
 g.paused=false;g.mode='freeroam';g.heat.clear();g.input.reset();g.player.controlsEnabled=false;
 document.querySelectorAll('.gt-clickplay').forEach(e=>e.remove());
 await wait(5000);
 for(const ring of [1,2,3,4,3,2,1]){
   phase=`loading ${ring}`;
   await stream.request(ring,0);
   phase=`playing ${ring}`;
   const d=stream.districts.get(`${ring},0`);if(!d)throw Error(`Missing district ${ring}`);
   const cx=(d.bounds.minX+d.bounds.maxX)/2;
   // Stay alongside a real resident road, not inside a building or outside loaded collision.
   let best=null;
   for(const road of d.recipe.roads)for(let i=1;i<road.pts.length;i++){
    const a=road.pts[i-1],b=road.pts[i],mx=(a[0]+b[0])/2,mz=(a[1]+b[1])/2;
    if(mx<d.bounds.minX+35||mx>d.bounds.maxX-35||Math.abs(mz)>450)continue;
    const dist=Math.abs(mx-cx)+Math.abs(mz-244)*.5;
    if(!best||dist<best.dist){const len=Math.hypot(b[0]-a[0],b[1]-a[1]);best={dist,x:mx-(b[1]-a[1])/len*(road.width/2+.6),z:mz+(b[0]-a[0])/len*(road.width/2+.6)};}
   }
   if(!best)best={x:cx,z:0};
   g.player.respawn([best.x,best.z]);g.player.controlsEnabled=false;g.paused=false;
   g.sky.setWeather(ring%2?'clear':'rain');
   await wait(7000);
   samples.push({ring,elapsed:g.elapsed,position:{x:g.player.position.x,y:g.player.position.y,z:g.player.position.z},ready:stream.isReady(g.player.position.x,g.player.position.z),districts:stream.districts.size,heapMB:Math.round(performance.memory.usedJSHeapSize/1048576),memory:{...g.renderer.info.memory},draw:g.renderer.info.render.calls,triangles:g.renderer.info.render.triangles,ai:{...g.ai.stats},paused:g.paused,quality:g.quality});
 }
 const sorted=frames.slice().sort((a,b)=>a-b);
 const result={done:true,samples,errors,spikes,frames:frames.length,median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)],worst:sorted.at(-1),over100ms:frames.filter(t=>t>100).length,failedShaders:g.renderer.info.programs.filter(p=>p.diagnostics?.runnable===false).length};
 window.__soak=result;
})().catch(e=>{window.__soak={done:true,error:String(e),samples,errors};}).finally(()=>{running=false;console.error=nativeError;observer.disconnect();});
return 'Soak started';
})()
