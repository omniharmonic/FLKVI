// Parked cars: rendered with instancing (near/far LOD sets per model) + static colliders.
// Cars near the player are promoted to full Vehicles (sleeping dynamic bodies) so they can be
// entered, pushed and crashed into; when far away and untouched they are demoted back.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../../core/game';
import { hashString, rng } from '../../core/geo';
import { CIVILIAN_MODELS, getCarModel, type CarModel, type CarModelId } from './carModels';
import { mats, plateMaterial } from './materials';
import { paintFor } from './visual';
import { groundY } from '../util';

/** Pleasant US car colors for parked cars (white, silver, black, grey, blue, red, beige, green). */
const PARKED_COLORS = ['#ecedef', '#f3f3f0', '#b8bbbf', '#a3a6aa', '#15161a', '#0d0e11', '#5a5e63', '#6d7176', '#243f6b', '#2f5580', '#8f1c1c', '#a52124', '#cbb99b', '#b5a488', '#2f4b37', '#46624d'];

export interface ParkedSlot {
  index: number;
  model: CarModelId;
  color: string;
  x: number; y: number; z: number;
  heading: number;
  seed: number;
  active: boolean; // true while promoted (hidden from instancing)
  colliders: RAPIER_NS.Collider[];
  near: boolean;
}

interface ModelSet {
  model: CarModel;
  slots: ParkedSlot[];
  nearBody: THREE.InstancedMesh;
  nearMisc: THREE.InstancedMesh;
  nearWheels: THREE.InstancedMesh;
  farBody: THREE.InstancedMesh;
  farMisc: THREE.InstancedMesh;
}

const NEAR_DIST = 45;
const MAX_DIST = 520;
const EXTRA = 24;

/** Recipe prop rot → heading (see util.ts heading convention). The recipe rot is a THREE-style yaw. */
export function rotToHeading(rot: number) { return -rot; }

export class ParkingSystem {
  readonly group = new THREE.Group();
  slots: ParkedSlot[] = [];
  private sets = new Map<CarModelId, ModelSet>();
  private body: RAPIER_NS.RigidBody;
  readonly colliderToSlot = new Map<number, ParkedSlot>();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(private g: Game) {
    this.group.name = 'parked-cars';
    this.body = g.physics.createRigidBody(g.rapier.RigidBodyDesc.fixed());
    const props = g.recipe.props.filter((p) => p.type === 'parked-car');
    props.forEach((p, i) => {
      const r = rng(hashString(`pk${i}:${p.p[0].toFixed(1)},${p.p[1].toFixed(1)}`) ^ p.variant);
      const model = CIVILIAN_MODELS[Math.abs(p.variant) % CIVILIAN_MODELS.length];
      const y = g.world ? groundY(g, p.p[0], p.p[1]) : p.y;
      this.slots.push({
        index: i, model, color: PARKED_COLORS[Math.floor(r() * PARKED_COLORS.length)],
        x: p.p[0], y: Number.isFinite(y) ? y : p.y, z: p.p[1], heading: rotToHeading(p.rot), seed: Math.floor(r() * 1e6),
        active: false, colliders: [], near: false,
      });
    });
    const byModel = new Map<CarModelId, ParkedSlot[]>();
    for (const s of this.slots) {
      if (!byModel.has(s.model)) byModel.set(s.model, []);
      byModel.get(s.model)!.push(s);
    }
    for (const [id, list] of byModel) this.sets.set(id, this.buildSet(id, list));
    for (const s of this.slots) this.addColliders(s);
    this.refresh(new THREE.Vector3(1e9, 0, 1e9));
  }

  private buildSet(id: CarModelId, slots: ParkedSlot[]): ModelSet {
    const m = getCarModel(id);
    const cap = slots.length + EXTRA;
    const paint = paintFor(m, '#ffffff');
    // Near: body (paint tinted per instance), misc (all small parts merged, multi-material), wheels.
    const nearBody = new THREE.InstancedMesh(m.body, [paint, mats.glass, mats.dark, mats.trim], cap);
    const miscGeos: THREE.BufferGeometry[] = [];
    const miscMats: THREE.Material[] = [];
    const push = (g: THREE.BufferGeometry | null | undefined, mat: THREE.Material) => { if (g) { miscGeos.push(g); miscMats.push(mat); } };
    push(m.trim, mats.trim); push(m.chrome, mats.chrome); push(m.grille, mats.grille); push(m.head, mats.headOff);
    push(m.tail, mats.tailOff); push(m.reverse, mats.revOff); push(m.plate, plateMaterial()); push(m.paintParts, mats.trim);
    const misc = mergeGeometries(miscGeos.map(clean), true)!;
    const nearMisc = new THREE.InstancedMesh(misc, miscMats, cap);
    const wheelGeos = m.wheelPos.map((p, i) => {
      const w = m.wheel.clone();
      if (i % 2 === 0) w.rotateY(Math.PI);
      w.translate(p.x, p.y, p.z);
      return w;
    });
    const wheels = mergeWheelGroups(wheelGeos);
    const nearWheels = new THREE.InstancedMesh(wheels, [mats.tire, mats.rim, mats.rimDark], cap);
    const farBody = new THREE.InstancedMesh(m.lod.body, [paint, mats.glass, mats.dark, mats.trim], cap);
    // One group per merged input: wheels (tire+rim collapse to tire at distance), head, tail.
    const farMisc = new THREE.InstancedMesh(mergeGeometries([clean(m.lod.wheels.clone()), clean(m.lod.head.clone()), clean(m.lod.tail.clone())], true)!, [mats.tire, mats.headOff, mats.tailOff], cap);
    for (const im of [nearBody, nearMisc, nearWheels, farBody, farMisc]) {
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = im === nearBody || im === farBody || im === nearWheels;
      im.receiveShadow = im === nearBody;
      this.group.add(im);
    }
    const col = new THREE.Color();
    // instanceColor on bodies
    for (let i = 0; i < cap; i++) { nearBody.setColorAt(i, col.set('#ffffff')); farBody.setColorAt(i, col); }
    return { model: m, slots, nearBody, nearMisc, nearWheels, farBody, farMisc };
  }

  private addColliders(s: ParkedSlot) {
    const R = this.g.rapier;
    const m = getCarModel(s.model);
    this.q.setFromEuler(this.e.set(0, -s.heading, 0));
    const rot = { x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w };
    const mk = (half: THREE.Vector3, c: THREE.Vector3) => {
      const off = c.clone().applyQuaternion(this.q);
      const d = R.ColliderDesc.cuboid(half.x, half.y, half.z)
        .setTranslation(s.x + off.x, s.y + off.y, s.z + off.z).setRotation(rot).setFriction(0.5);
      const col = this.g.physics.createCollider(d, this.body);
      this.colliderToSlot.set(col.handle, s);
      return col;
    };
    s.colliders = [mk(m.colHalf, m.colCenter), mk(m.cabHalf, m.cabCenter)];
  }

  private removeColliders(s: ParkedSlot) {
    for (const c of s.colliders) { this.colliderToSlot.delete(c.handle); this.g.physics.removeCollider(c, false); }
    s.colliders = [];
  }

  /** Hide slot from instancing (it becomes a live Vehicle). */
  activate(s: ParkedSlot) {
    if (s.active) return;
    s.active = true;
    this.removeColliders(s);
    this.dirty = true;
  }

  /** Put a vehicle back as a parked instance at its current pose. */
  deactivate(s: ParkedSlot, x: number, y: number, z: number, heading: number) {
    s.active = false;
    s.x = x; s.y = y; s.z = z; s.heading = heading;
    this.addColliders(s);
    this.dirty = true;
  }

  private dirty = true;
  private lastRefresh = new THREE.Vector3(1e9, 0, 1e9);

  /** Rebuild instance lists around the camera (near/far LOD). Cheap enough to run a few times a second. */
  refresh(cam: THREE.Vector3, force = false) {
    if (!force && !this.dirty && cam.distanceToSquared(this.lastRefresh) < 4) return;
    this.dirty = false;
    this.lastRefresh.copy(cam);
    for (const set of this.sets.values()) {
      let n = 0, f = 0;
      for (const s of set.slots) {
        if (s.active) continue;
        const d2 = (s.x - cam.x) ** 2 + (s.z - cam.z) ** 2;
        if (d2 > MAX_DIST * MAX_DIST) continue;
        this.q.setFromEuler(this.e.set(0, -s.heading, 0));
        this.m4.compose(new THREE.Vector3(s.x, s.y, s.z), this.q, this.one);
        const col = new THREE.Color(s.color);
        if (d2 < NEAR_DIST * NEAR_DIST) {
          set.nearBody.setMatrixAt(n, this.m4); set.nearBody.setColorAt(n, col);
          set.nearMisc.setMatrixAt(n, this.m4); set.nearWheels.setMatrixAt(n, this.m4);
          n++;
        } else {
          set.farBody.setMatrixAt(f, this.m4); set.farBody.setColorAt(f, col);
          set.farMisc.setMatrixAt(f, this.m4);
          f++;
        }
      }
      for (const im of [set.nearBody, set.nearMisc, set.nearWheels]) { im.count = n; im.instanceMatrix.needsUpdate = true; }
      for (const im of [set.farBody, set.farMisc]) { im.count = f; im.instanceMatrix.needsUpdate = true; }
      if (set.nearBody.instanceColor) set.nearBody.instanceColor.needsUpdate = true;
      if (set.farBody.instanceColor) set.farBody.instanceColor.needsUpdate = true;
    }
  }

  /** Inactive slots within radius of (x,z), nearest first. */
  query(x: number, z: number, radius: number): ParkedSlot[] {
    const out: [number, ParkedSlot][] = [];
    const r2 = radius * radius;
    for (const s of this.slots) {
      if (s.active) continue;
      const d2 = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d2 < r2) out.push([d2, s]);
    }
    return out.sort((a, b) => a[0] - b[0]).map((o) => o[1]);
  }
}

function clean(g: THREE.BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  // Collapse multi-group geometries into a single group so mergeGeometries(useGroups) assigns one material each.
  return g;
}

/** Merge 4 wheel geometries that each carry groups (tire/rim/dark) into one geometry with 3 groups. */
function mergeWheelGroups(ws: THREE.BufferGeometry[]) {
  const byGroup: THREE.BufferGeometry[][] = [[], [], []];
  for (const w of ws) {
    for (const gr of w.groups) {
      const sub = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) if (w.attributes[k]) sub.setAttribute(k, w.attributes[k]);
      sub.setIndex(Array.from((w.index!.array as ArrayLike<number>)).slice(gr.start, gr.start + gr.count));
      byGroup[gr.materialIndex ?? 0].push(sub);
    }
  }
  const parts = byGroup.filter((l) => l.length).map((l) => mergeGeometries(l)!);
  return mergeGeometries(parts, true)!;
}
