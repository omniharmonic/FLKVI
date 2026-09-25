// Real compiled Boulder street. Incoming AI must hit a stopped player's car with finite mass.
(async () => {
  const g = game, R = g.rapier, vs = g.vehicles;
  g.paused = true; g.input.reset();
  if (g.player.vehicleId) g.player.exitVehicle(true);
  const disabled = [];
  for (const car of vs.vehicles.values()) for (const c of car.colliders) { if (c.isEnabled()) { disabled.push(c); c.setEnabled(false); } }
  for (const slot of vs.parking.slots) if (Math.hypot(slot.x - 495, slot.z - 243.4) < 50) {
    for (const c of slot.colliders) if (c.isEnabled()) { disabled.push(c); c.setEnabled(false); }
  }
  const a = vs.spawn({ kind: 'civilian', model: 'sedan', p: [500,243.4], heading: Math.PI / 2, physics: true });
  a.driver = 'player';
  const step = () => {
    vs.fixedUpdate(1/60); g.physics.timestep = 1/60; g.physics.step(); vs.afterPhysics(1/60);
    a.sync(1/60); if (b) b.sync(1/60);
  };
  let b;
  try {
    for (let i=0;i<90;i++) step();
    const start = a.position.clone();
    b = vs.spawn({ kind: 'civilian', model: 'sedan', p: [470,243.4], heading: Math.PI / 2, physics: false });
    b.speed = 12;
    let promotedDistance = null, transfer = 0, rise = 0;
    for (let i=0;i<250;i++) {
      if (b.physicsMode === 'kinematic') b.position.x += b.speed / 60;
      step();
      if (b.physicsMode === 'dynamic' && promotedDistance === null) promotedDistance = Math.abs(a.position.x - b.position.x);
      transfer = Math.max(transfer, a.velocity.x);
      rise = Math.max(rise, a.position.y-g.world.groundAt(a.position.x,a.position.z));
    }
    const checks = [
      ['Incoming traffic becomes dynamic before striking a stopped car', promotedDistance > 4.8],
      ['A street collision transfers momentum into the stopped car', transfer > 2],
      ['Both cars sustain contact damage on the actual street', a.health < 97 && b.health < 97],
      ['Street impact leaves cars near the road without explosive lift', rise < 1.5],
      ['Impact visibly displaces the stopped car', a.position.x - start.x > 1.5],
    ];
    if (checks.some(c=>!c[1])) throw Error(JSON.stringify({checks,promotedDistance,transfer,rise,health:[a.health,b.health],positions:[a.position,b.position]}));
    return {passed:checks.length,checks,promotedDistance,transfer,rise,health:[a.health,b.health]};
  } finally {
    for (const c of disabled) if (g.physics.getCollider(c.handle)) c.setEnabled(true);
    vs.despawn(a.id); if(b)vs.despawn(b.id);
  }
})()
