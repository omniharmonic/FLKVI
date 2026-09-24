// Bounded articulated physics for nearby impacts. Bodies drive the existing skinned character.
import * as THREE from 'three';
import type { RigidBody, RevoluteImpulseJoint } from '@dimforge/rapier3d-compat';
import type { Game } from '../core/game';

interface Part {
  bone: THREE.Object3D; body: RigidBody; offset: THREE.Vector3; rotation: THREE.Quaternion;
  localPosition: THREE.Vector3; localRotation: THREE.Quaternion;
}
const active = new WeakMap<Game, Set<Ragdoll>>();
const V = new THREE.Vector3(), Q = new THREE.Quaternion(), PQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class Ragdoll {
  readonly parts: Part[] = [];
  readonly position = new THREE.Vector3();
  private removed = false;
  private constructor(private g: Game, private model: THREE.Object3D) {}

  static create(g: Game, model: THREE.Object3D, dx: number, dz: number, speed: number): Ragdoll | null {
    let live = active.get(g);
    if (!live) {
      active.set(g, live = new Set());
      const set = live;
      g.addSystem({ name: 'ragdolls', order: 85, lateUpdate: () => { for (const r of set) r.sync(); } });
    }
    if (live.size >= (g.quality === 'low' ? 2 : 4)) return null;
    const r = new Ragdoll(g, model);
    try {
      if (!r.build(dx, dz, speed)) { r.dispose(); return null; }
      live.add(r); return r;
    } catch (e) { r.dispose(); console.warn('[ragdoll] using animation fallback', e); return null; }
  }

  private build(dx: number, dz: number, speed: number) {
    const g = this.g, R = g.rapier, W = g.physics;
    this.model.updateWorldMatrix(true, true);
    const bones = new Map<string, THREE.Object3D>();
    this.model.traverse(o => { if ((o as THREE.Bone).isBone) bones.set(o.name.toLowerCase(), o); });
    const bone = (...names: string[]) => names.map(n => bones.get(n.toLowerCase())).find(Boolean);
    const pelvis = bone('pelvis', 'hips'), chest = bone('spine_01', 'spine'), neck = bone('neck_01', 'neck'), head = bone('Head');
    if (!pelvis || !chest || !head) return false;
    const specs: { b: THREE.Object3D; end?: THREE.Object3D; radius: number; mass: number; parent: number; hinge?: boolean }[] = [
      { b: pelvis, end: chest, radius: .15, mass: 15, parent: -1 },
      { b: chest, end: neck ?? head, radius: .17, mass: 24, parent: 0 },
      { b: head, radius: .115, mass: 5, parent: 1 },
    ];
    for (const side of ['l', 'r']) {
      const suffix = side.toUpperCase();
      const arm = bone(`upperarm_${side}`, `upperArm${suffix}`), fore = bone(`lowerarm_${side}`, `foreArm${suffix}`), hand = bone(`hand_${side}`, `hand${suffix}`);
      const thigh = bone(`thigh_${side}`, `thigh${suffix}`), calf = bone(`calf_${side}`, `shin${suffix}`), foot = bone(`foot_${side}`, `foot${suffix}`);
      if (!arm || !fore || !hand || !thigh || !calf || !foot) return false;
      const a = specs.length;
      specs.push({b:arm,end:fore,radius:.065,mass:3,parent:1},{b:fore,end:hand,radius:.05,mass:2,parent:a,hinge:true});
      const t = specs.length;
      specs.push({b:thigh,end:calf,radius:.085,mass:7,parent:0},{b:calf,end:foot,radius:.065,mass:4,parent:t,hinge:true});
    }
    const len = Math.hypot(dx,dz) || 1, velocity = new THREE.Vector3(dx/len,0,dz/len).multiplyScalar(Math.min(9,Math.max(1.8,speed)));
    velocity.y = Math.min(2, .3 + speed*.12);
    for (const s of specs) {
      const start = s.b.getWorldPosition(new THREE.Vector3());
      const end = s.end?.getWorldPosition(new THREE.Vector3()) ?? start.clone().add(new THREE.Vector3(0,.16,0));
      const center = start.clone().lerp(end,.5), length = start.distanceTo(end);
      const body = W.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(center.x,center.y,center.z)
        .setLinvel(velocity.x,velocity.y,velocity.z).setLinearDamping(.3).setAngularDamping(2.8).setCcdEnabled(true).setAdditionalSolverIterations(4));
      const part: Part = {bone:s.b,body,offset:start.sub(center),rotation:s.b.getWorldQuaternion(new THREE.Quaternion()),localPosition:s.b.position.clone(),localRotation:s.b.quaternion.clone()};
      this.parts.push(part);
      const axis = end.sub(center).normalize();
      const shape = R.ColliderDesc.capsule(Math.max(.01,length/2-s.radius*.5),s.radius)
        .setRotation(new THREE.Quaternion().setFromUnitVectors(UP,axis)).setMass(s.mass).setFriction(.65).setRestitution(.02)
        .setCollisionGroups(0x0008fff7); // collide with world/vehicles; exclude ragdoll self-contact
      W.createCollider(shape,body);
      body.setAngvel({x:dz/len*2,y:.1,z:-dx/len*2},true);
    }
    const right = new THREE.Vector3(1,0,0).applyQuaternion(this.model.getWorldQuaternion(new THREE.Quaternion())).normalize();
    for (let i=1;i<specs.length;i++) {
      const s=specs[i],p=this.parts[s.parent],c=this.parts[i];
      const jointPos=s.b.getWorldPosition(new THREE.Vector3());
      const a=jointPos.clone().sub(p.body.translation()),b=jointPos.clone().sub(c.body.translation());
      const data=s.hinge?R.JointData.revolute(a,b,right):R.JointData.spherical(a,b);
      const j=W.createImpulseJoint(data,p.body,c.body,true);j.setContactsEnabled(false);
      if(s.hinge)(j as RevoluteImpulseJoint).setLimits(-1.9,.25);
    }
    this.position.copy(this.parts[0].body.translation());
    return true;
  }

  sync() {
    if (this.removed) return;
    this.model.updateWorldMatrix(true, true);
    // Parent-before-child order makes world-space simulation independent of the animation rig's axes/scale.
    for (const p of this.parts) {
      Q.copy(p.body.rotation());
      V.copy(p.offset).applyQuaternion(Q).add(p.body.translation());
      p.bone.parent!.worldToLocal(V);p.bone.position.copy(V);
      PQ.copy(p.bone.parent!.getWorldQuaternion(PQ)).invert();
      p.bone.quaternion.copy(PQ.multiply(Q).multiply(p.rotation));
      p.bone.updateWorldMatrix(false,true);
    }
    this.position.copy(this.parts[0].body.translation());
  }

  dispose() {
    if(this.removed)return;this.removed=true;
    active.get(this.g)?.delete(this);
    for(const p of this.parts){if(p.body.isValid())this.g.physics.removeRigidBody(p.body);p.bone.position.copy(p.localPosition);p.bone.quaternion.copy(p.localRotation);}
    this.model.updateWorldMatrix(true,true);
  }
}
