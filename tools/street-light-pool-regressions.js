(async()=>{
 const g=game,s=g.world.streaming;g.paused=true;
 const checks=[],check=(name,ok,details)=>{checks.push({name,ok,details});if(!ok)throw Error(JSON.stringify(checks));};
 const pools=()=>{const out=[];g.scene.traverse(o=>{if(o.isSpotLight&&o.name.startsWith('streetlight-pool-'))out.push(o);});return out;};
 const before=pools();check('Initial world owns one fixed streetlight pool',before.length===16,before.length);
 await s.request(1,0);
 const d=s.districts.get('1,0');
 check('A streamed district does not change global streetlight shader count',pools().length===16,pools().length);
 let districtLights=0;d.root.traverse(o=>{if(o.isSpotLight)districtLights++;});
 check('Streamed street furniture creates no additional real lights',districtLights===0,districtLights);
 const lamp=d.lamps.find(p=>p.x>s.core.maxX+80);
 check('Streamed district publishes physical lamp positions',!!lamp,d.lamps.length);
 const camera=g.camera.position.clone(),rotation=g.camera.quaternion.clone();
 g.camera.position.set(lamp.x,lamp.y-3,lamp.z);g.camera.lookAt(lamp.x,lamp.y-3,lamp.z+20);g.camera.updateMatrixWorld(true);
 s.streetLights.setNightFactor(1);
 for(let i=0;i<4;i++)s.streetLights.update(g.elapsed,g.camera);
 const active=pools().filter(light=>light.intensity>0&&light.position.x>s.core.maxX+30);
 check('The original light pool illuminates streets outside the core',active.length>0,active.map(l=>({x:l.position.x,z:l.position.z,intensity:l.intensity})));
 check('Outer illumination targets actual resident lamp heads',active.every(l=>d.lamps.some(p=>p.distanceTo(l.position)<.001)));
 s.streetLights.setNightFactor(0);for(let i=0;i<4;i++)s.streetLights.update(g.elapsed,g.camera);
 check('Daylight keeps the same visible shader lights at zero intensity',pools().length===16&&pools().every(l=>l.visible&&l.intensity===0));
 s.streetLights.setNightFactor(g.sky.nightFactor);g.camera.position.copy(camera);g.camera.quaternion.copy(rotation);g.camera.updateMatrixWorld(true);
 return {passed:checks.length,checks};
})()
