// A fresh paused district and a deliberately unavailable detail mesh must both keep complete walls.
(async()=>{
 const g=game;g.paused=true;
 const {buildFromRecipe}=await import('/src/world/buildings/index.ts');
 const {unregisterShadowProxy}=await import('/src/render/shadowProxy.ts');
 const source=g.recipe.buildings.find(b=>b.footprint.length>=4&&b.height>3&&!b.boat);
 if(!source)throw Error('Fixture needs a normal building');
 const building=structuredClone(source);
 const recipe={...g.recipe,buildings:[building],spawn:{...g.recipe.spawn,p:[100000,100000]}};
 const result=await buildFromRecipe(recipe,()=>{},{yieldMs:6},g.quality);
 const chunks=result.group.children.filter(o=>o.name.startsWith('bchunk_'));
 const facades=chunks.flatMap(c=>c.getObjectByName('lod1').children);
 const checks=[],check=(name,ok,details)=>{checks.push({name,ok,details});if(!ok)throw Error(JSON.stringify(checks));};
 check('Fresh unupdated building has drawable complete facades',facades.length>0&&facades.every(m=>m.geometry.groups.some(group=>group.count>0)));
 const pos=g.camera.position.clone(),rot=g.camera.quaternion.clone();
 const x=building.footprint.reduce((n,p)=>n+p[0],0)/building.footprint.length,z=building.footprint.reduce((n,p)=>n+p[1],0)/building.footprint.length;
 g.camera.position.set(x,building.baseY+3,z);g.camera.updateMatrixWorld(true);
 building.footprint=[]; // Simulate a detail recipe becoming unavailable after the far facade was assembled.
 const warn=console.warn;let warnings=0;
 console.warn=(...args)=>{if(String(args[0]).includes('empty detail'))warnings++;warn(...args);};
 try{for(let i=0;i<6;i++)result.update(1/60,g);}finally{console.warn=warn;g.camera.position.copy(pos);g.camera.quaternion.copy(rot);g.camera.updateMatrixWorld(true);}
 check('Empty near detail retains the complete far walls',chunks.every(c=>c.getObjectByName('lod1').visible)&&facades.every(m=>m.geometry.groups.some(group=>group.count>0)));
 check('Failed detail logs once instead of rebuilding every frame',warnings===1,warnings);
 result.group.traverse(o=>{unregisterShadowProxy(g,o);if(o.isMesh)o.geometry.dispose();});result.group.clear();
 return {passed:checks.length,checks};
})()
