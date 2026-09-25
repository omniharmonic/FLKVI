// Deterministic standing poses across every civilian and police model variant.
(async()=>{
  const g=game,R=g.rapier;g.paused=true;g.input.reset();
  const pad=g.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0,99.5,0));
  g.physics.createCollider(R.ColliderDesc.cuboid(40,.5,40),pad);
  const results=[];
  try {
    for(const kind of ['civilian','officer'])for(let seed=0;seed<8;seed++) {
      const ch=g.ai.peds.factory.create(kind,seed);
      ch.root.position.set(0,100.03,0);g.scene.add(ch.root);
      ch.play('idle',0);ch.update(0);ch.root.updateWorldMatrix(true,true);
      ch.impact(g,0,-1,1.5);
      const rag=ch.ragdoll;
      if(!rag)throw Error(`No ragdoll for ${kind}:${seed}`);
      const start={...rag.parts[0].body.translation()},initial=rag.parts.map(p=>({bone:p.bone.name,at:p.body.translation()}));
      let maxSpeed=0,maxHeight=start.y;
      const hist=[];
      for(let i=0;i<90;i++){
        g.physics.timestep=1/60;g.physics.step();rag.sync();
        const v=rag.parts[0].body.linvel();maxSpeed=Math.max(maxSpeed,Math.hypot(v.x,v.y,v.z));maxHeight=Math.max(maxHeight,rag.position.y);
        if(i<5)hist.push({i,p:rag.position.toArray(),v});
      }
      const d=Math.hypot(rag.position.x-start.x,rag.position.z-start.z);
      results.push({kind,seed,start,end:rag.position.toArray(),d,maxSpeed,maxHeight,initial,hist});
      ch.clearPhysics();ch.root.removeFromParent();
    }
  } finally {g.physics.removeRigidBody(pad);}
  const failed=results.filter(r=>r.d<=.2||r.end[1]>=r.start.y||r.maxSpeed>12||r.end[1]<99.8);
  if(failed.length)throw Error(JSON.stringify({failed,results}));
  return {passed:results.length,results};
})()
