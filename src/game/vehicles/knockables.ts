// Light street furniture the player's car can knock over (bollards, trash cans, stop signs, news boxes,
// parking meters, mailboxes). The world draws these as instanced kits (`prop_<kit>_<mat>`) with fixed
// colliders; on a hit we hide that instance, drop its static collider and spawn a small dynamic copy.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../../core/game';
import type { Vehicle } from './vehicle';
import { playSound } from '../util';

interface KitInfo { r: number; h: number; mass: number; sound: string }
const KITS: Record<string, KitInfo> = {
  bollard: { r: 0.12, h: 1.0, mass: 45, sound: 'metal-fall' },
  trash: { r: 0.32, h: 1.0, mass: 22, sound: 'crash' },
  stop: { r: 0.08, h: 2.4, mass: 14, sound: 'metal-fall' },
  news: { r: 0.3, h: 1.1, mass: 30, sound: 'crash' },
  meter: { r: 0.1, h: 1.4, mass: 18, sound: 'metal-fall' },
  mailbox: { r: 0.3, h: 1.2, mass: 35, sound: 'crash' },
};

interface Item { kit: string; i: number; x: number; y: number; z: number; q: THREE.Quaternion; down: boolean }
interface Debris { body: RAPIER_NS.RigidBody; obj: THREE.Group; col: RAPIER_NS.Collider }

const CELL = 8;
const MAX_DEBRIS = 28;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _l = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Knockables {
  readonly group = new THREE.Group();
  private meshes = new Map<string, THREE.InstancedMesh[]>();
  private grid = new Map<string, Item[]>();
  private debris: Debris[] = [];
  private ready = false;

  constructor(private g: Game, private rayIgnore: Set<number>) {
    this.group.name = 'knocked-props';
    g.scene.add(this.group);
  }

  private init() {
    this.ready = true;
    this.g.scene.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh) return;
      const m = /^prop_([a-z]+)_/.exec(im.name);
      if (!m || !KITS[m[1]]) return;
      const list = this.meshes.get(m[1]) ?? [];
      list.push(im);
      this.meshes.set(m[1], list);
    });
    for (const [kit, list] of this.meshes) {
      const im = list[0];
      im.updateMatrixWorld();
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, _m);
        const q = new THREE.Quaternion();
        _m.premultiply(im.matrixWorld).decompose(_p, q, _s);
        if (_s.x === 0) continue;
        const it: Item = { kit, i, x: _p.x, y: _p.y, z: _p.z, q, down: false };
        const k = `${Math.floor(it.x / CELL)},${Math.floor(it.z / CELL)}`;
        (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(it);
      }
    }
  }

  /** Check a moving vehicle against nearby props (with a short look-ahead so the static collider is gone before contact). */
  check(v: Vehicle, dt: number) {
    if (!this.ready) this.init();
    const spd = Math.abs(v.speed);
    if (spd < 2) return;
    const m = v.model;
    const look = spd * dt * 4 + 0.15;
    const reach = m.L / 2 + look + 0.5;
    const cx = Math.floor(v.position.x / CELL), cz = Math.floor(v.position.z / CELL);
    const inv = v.object.matrixWorld.clone().invert();
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const list = this.grid.get(`${cx + a},${cz + b}`);
      if (!list) continue;
      for (const it of list) {
        if (it.down) continue;
        if (Math.abs(it.x - v.position.x) > reach || Math.abs(it.z - v.position.z) > reach) continue;
        if (it.y + KITS[it.kit].h < v.position.y - 0.3 || it.y > v.position.y + 1.5) continue;
        _l.set(it.x, it.y, it.z).applyMatrix4(inv);
        const r = KITS[it.kit].r;
        const front = v.speed >= 0 ? -1 : 1;
        const zMin = front < 0 ? -m.L / 2 - look - r : -m.L / 2 - r;
        const zMax = front < 0 ? m.L / 2 + r : m.L / 2 + look + r;
        if (Math.abs(_l.x) < m.W + r + 0.05 && _l.z > zMin && _l.z < zMax) this.knock(it, v);
      }
    }
  }

  private knock(it: Item, v: Vehicle) {
    const g = this.g, R = g.rapier;
    const info = KITS[it.kit];
    it.down = true;
    const list = this.meshes.get(it.kit) ?? [];
    for (const im of list) { im.setMatrixAt(it.i, ZERO); im.instanceMatrix.needsUpdate = true; }
    // Remove the prop's static collider (fixed cylinder under the prop's axis).
    const kill: RAPIER_NS.Collider[] = [];
    // Direct scan, not a world scene query: two knocks in one frame would otherwise query after a
    // removal and panic Rapier. The prop's cylinder is centred on its axis.
    g.physics.colliders.forEach((c) => {
      if (c.shapeType() !== R.ShapeType.Cylinder) return;
      const b = c.parent();
      if (!b || !b.isFixed()) return;
      const t = c.translation();
      if (Math.abs(t.x - it.x) < 0.35 && Math.abs(t.z - it.z) < 0.35 && t.y > it.y - 0.5 && t.y < it.y + info.h + 0.5) kill.push(c);
    });
    for (const c of kill) g.physics.removeCollider(c, false);
    // Dynamic copy.
    const obj = new THREE.Group();
    for (const im of list) {
      const mesh = new THREE.Mesh(im.geometry, im.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      obj.add(mesh);
    }
    obj.position.set(it.x, it.y, it.z);
    obj.quaternion.copy(it.q);
    this.group.add(obj);
    const body = g.physics.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(it.x, it.y, it.z).setRotation({ x: it.q.x, y: it.q.y, z: it.q.z, w: it.q.w })
      .setLinearDamping(0.3).setAngularDamping(0.4).setCcdEnabled(true));
    const col = g.physics.createCollider(R.ColliderDesc.cylinder(info.h / 2, info.r).setTranslation(0, info.h / 2, 0)
      .setMass(info.mass).setFriction(0.7).setRestitution(0.2), body);
    this.rayIgnore.add(col.handle);
    // Throw it: along the car's velocity, a bit up, with a tumble.
    const vel = v.velocity;
    const k = 1.15 + Math.random() * 0.3;
    body.setLinvel({ x: vel.x * k + (Math.random() - 0.5) * 2, y: 1.5 + Math.abs(v.speed) * 0.12, z: vel.z * k + (Math.random() - 0.5) * 2 }, true);
    body.setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 8 }, true);
    // The car loses a little speed (momentum transfer).
    const lv = v.body.linvel();
    const f = 1 - Math.min(0.12, info.mass / v.tuning.mass * 1.2);
    v.body.setLinvel({ x: lv.x * f, y: lv.y, z: lv.z * f }, true);
    playSound(g, info.sound, { at: [it.x, it.y + 0.5, it.z], volume: Math.min(1, 0.35 + Math.abs(v.speed) / 30) });
    g.events.emit('noise', { p: [it.x, it.z], radius: 22, kind: 'crash' });
    this.debris.push({ body, obj, col });
    if (this.debris.length > MAX_DEBRIS) this.remove(this.debris.shift()!);
  }

  private remove(d: Debris) {
    this.rayIgnore.delete(d.col.handle);
    this.g.physics.removeRigidBody(d.body);
    d.obj.removeFromParent();
  }

  /** Pull debris poses from physics. */
  sync() {
    for (const d of this.debris) {
      if (d.body.isSleeping()) continue;
      const t = d.body.translation(), r = d.body.rotation();
      d.obj.position.set(t.x, t.y, t.z);
      d.obj.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
