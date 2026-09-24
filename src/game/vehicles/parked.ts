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
import type { CarShadows } from './shadows';

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
  /** Hull overlapped static geometry with no clear spot nearby: removed for good. */
  dead?: boolean;
  /** perf: promoted but still asleep and untouched — keep drawing it via instancing (its Vehicle visual is hidden). */
  sleepy?: boolean;
  colliders: RAPIER_NS.Collider[];
  near: boolean;
  /** Cached instance matrix (column-major) and color; rebuilt when the pose changes. */
  m?: Float32Array;
  col?: THREE.Color;
}

interface ModelSet {
  model: CarModel;
  slots: ParkedSlot[];
  nearBody: THREE.InstancedMesh;
  nearMisc: THREE.InstancedMesh;
  nearWheels: THREE.InstancedMesh;
  farBody: THREE.InstancedMesh;
  /** Very far (> FAR2_DIST): box proxy (body + glasshouse + dark wheel band), one draw. */
  farBody2: THREE.InstancedMesh;
  farMisc: THREE.InstancedMesh;
}

const NEAR_DIST = 40;
/** Parked cars beyond this are culled (perf: ~1M tris of parked cars in dense cities otherwise). */
const MAX_DIST = 300;
const EXTRA = 24;
/** Parked cars cast sun shadows (via the shared hull proxies) out to this distance. */
const SHADOW_DIST = 100;
/** Beyond this, parked cars switch to a ~36-triangle box proxy (no wheels / lamps). */
const FAR2_DIST = 120;
/** Always keep instances this close regardless of the view frustum (their shadows reach into view). */
const KEEP_DIST = 30;

/** Recipe prop rot → heading. The compiler uses the same convention (headingOf = atan2(dx, −dz)). */
export function rotToHeading(rot: number) { return rot; }

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

  constructor(private g: Game, private shadows?: CarShadows) {
    this.group.name = 'parked-cars';
    this.body = g.physics.createRigidBody(g.rapier.RigidBodyDesc.fixed());
    const props = g.recipe.props.filter((p) => p.type === 'parked-car');
    // Spacing: a stolen car must be able to pull out, so every parked car keeps ≥ GAP m to its in-lane
    // neighbors; if the preferred model doesn't fit, fall back to shorter ones, else leave the space empty.
    const GAP = 0.85;
    const near = new Map<string, ParkedSlot[]>();
    const cellOf = (x: number, z: number) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    const fits = (x: number, z: number, h: number, m: CarModel) => {
      const cx = Math.floor(x / 10), cz = Math.floor(z / 10);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const o of near.get(`${cx + a},${cz + b}`) ?? []) {
          const om = getCarModel(o.model);
          const dx = o.x - x, dz = o.z - z;
          const fx = Math.sin(h), fz = -Math.cos(h);
          const along = Math.abs(dx * fx + dz * fz), lat = Math.abs(dx * fz - dz * fx);
          const par = Math.abs(Math.cos(o.heading - h)) > 0.7;
          const needAlong = par ? (m.L + om.L) / 2 + GAP : (m.L + om.W * 2) / 2 + GAP;
          const needLat = par ? m.W + om.W + 0.25 : m.W + om.L / 2 + 0.25;
          if (along < needAlong && lat < needLat) return false;
        }
      }
      return true;
    };
    const SHORTER: CarModelId[] = ['sedan', 'sports', 'hatchback'];
    let skipped = 0;
    props.forEach((p, i) => {
      const r = rng(hashString(`pk${i}:${p.p[0].toFixed(1)},${p.p[1].toFixed(1)}`) ^ p.variant);
      let model: CarModelId | null = CIVILIAN_MODELS[Math.abs(p.variant) % CIVILIAN_MODELS.length];
      const heading = rotToHeading(p.rot);
      if (!fits(p.p[0], p.p[1], heading, getCarModel(model))) {
        model = SHORTER.find((m) => getCarModel(m).L < getCarModel(model!).L && fits(p.p[0], p.p[1], heading, getCarModel(m))) ?? null;
      }
      if (!model) { skipped++; return; }
      const y = g.world ? groundY(g, p.p[0], p.p[1]) : p.y;
      const slot: ParkedSlot = {
        index: this.slots.length, model, color: PARKED_COLORS[Math.floor(r() * PARKED_COLORS.length)],
        x: p.p[0], y: Number.isFinite(y) ? y : p.y, z: p.p[1], heading, seed: Math.floor(r() * 1e6),
        active: false, colliders: [], near: false,
      };
      this.slots.push(slot);
      const k = cellOf(slot.x, slot.z);
      (near.get(k) ?? near.set(k, []).get(k)!).push(slot);
    });
    if (skipped) console.info(`[vehicles] parked: ${skipped} of ${props.length} spots left empty for spacing`);
    const byModel = new Map<CarModelId, ParkedSlot[]>();
    for (const s of this.slots) {
      if (!byModel.has(s.model)) byModel.set(s.model, []);
      byModel.get(s.model)!.push(s);
    }
    for (const [id, list] of byModel) this.sets.set(id, this.buildSet(id, list));
    for (const s of this.slots) this.addColliders(s);
    this.refresh(new THREE.Vector3(1e9, 0, 1e9), true);
  }

  private buildSet(id: CarModelId, slots: ParkedSlot[]): ModelSet {
    const m = getCarModel(id);
    const cap = slots.length + EXTRA;
    const paint = paintFor(m, '#ffffff');
    // Near: body (paint tinted per instance), misc (all small parts merged, multi-material), wheels.
    const nearBody = new THREE.InstancedMesh(m.body, [paint, mats.glass, mats.dark, mats.trim], cap);
    const miscGeos: THREE.BufferGeometry[] = [];
    const miscMats: THREE.Material[] = [];
    // parts sharing a material share one group (one draw call per material, perf)
    const push = (g: THREE.BufferGeometry | null | undefined, mat: THREE.Material) => {
      if (!g) return;
      const k = miscMats.indexOf(mat);
      if (k >= 0) miscGeos[k] = mergeGeometries([clean(miscGeos[k].clone()), clean(g.clone())], false)!;
      else { miscGeos.push(g); miscMats.push(mat); }
    };
    push(m.trim, mats.trim); push(m.chrome, mats.chrome); push(m.grille, mats.grille); push(m.head, mats.headOff);
    push(m.tail, mats.tailOff); push(m.reverse, mats.revOff); push(m.plate, plateMaterial()); push(m.paintParts, mats.trim);
    push(m.interior, mats.interior); push(m.signals, mats.amber);
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
    const farBody = new THREE.InstancedMesh(m.lod.body, [paint, mats.glassFar, mats.dark, mats.trim], cap);
    // One group per merged input: wheels (tire+rim collapse to tire at distance), head, tail.
    // very far: one draw — box proxy with vertex colours (× instance paint)
    const farBody2 = new THREE.InstancedMesh(boxProxy(m), veryFarMaterial(), cap);
    const farMisc = new THREE.InstancedMesh(mergeGeometries([clean(m.lod.wheels.clone()), clean(m.lod.head.clone()), clean(m.lod.tail.clone())], true)!, [mats.tire, mats.headOff, mats.tailOff], cap);
    for (const im of [nearBody, nearMisc, nearWheels, farBody, farBody2, farMisc]) {
      im.count = 0;
      im.frustumCulled = false;
      // Shadows come from the shared hull proxies when available (CarShadows).
      im.castShadow = !this.shadows?.active && (im === nearBody || im === farBody || im === nearWheels);
      im.receiveShadow = im === nearBody;
      this.group.add(im);
    }
    const col = new THREE.Color();
    // instanceColor on bodies
    for (let i = 0; i < cap; i++) { nearBody.setColorAt(i, col.set('#ffffff')); farBody.setColorAt(i, col); farBody2.setColorAt(i, col); }
    return { model: m, slots, nearBody, nearMisc, nearWheels, farBody, farBody2, farMisc };
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

  /** perf: draw a promoted-but-sleeping car through instancing (pose = its current pose) or hand it back to its Vehicle. */
  setSleepy(s: ParkedSlot, on: boolean, x?: number, y?: number, z?: number, heading?: number) {
    if (!!s.sleepy === on) return;
    s.sleepy = on;
    if (on && x !== undefined) { s.x = x; s.y = y!; s.z = z!; s.heading = heading!; s.m = undefined; }
    this.dirty = true;
  }

  /** Put a vehicle back as a parked instance at its current pose. */
  deactivate(s: ParkedSlot, x: number, y: number, z: number, heading: number) {
    s.active = false;
    s.sleepy = false;
    s.x = x; s.y = y; s.z = z; s.heading = heading;
    s.m = undefined;
    this.addColliders(s);
    this.dirty = true;
  }

  private dirty = true;
  private lastRefresh = new THREE.Vector3(1e9, 0, 1e9);
  private lastDir = new THREE.Vector3(0, 0, 1);
  private dir = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sph = new THREE.Sphere();
  private shadowBuf = new Map<CarModelId, Float32Array>();

  private slotMatrix(s: ParkedSlot) {
    if (!s.m) {
      this.q.setFromEuler(this.e.set(0, -s.heading, 0));
      this.m4.compose(new THREE.Vector3(s.x, s.y, s.z), this.q, this.one);
      s.m = new Float32Array(this.m4.elements);
      s.col = new THREE.Color(s.color);
    }
    return s.m;
  }

  /**
   * Rebuild instance lists around the camera (near/far LOD + view-frustum culling). Runs when the
   * camera moves ~2 m or turns ~2°, or when slots change. Pass the camera to enable frustum culling.
   */
  private lastQuality = '';
  refresh(cam: THREE.Vector3, force = false, camera?: THREE.Camera) {
    const quality = this.g.quality;
    if (quality !== this.lastQuality) { this.lastQuality = quality; force = true; }
    const detailScale = quality === 'high' ? 1 : quality === 'medium' ? 0.8 : 0.6;
    let turned = false;
    if (camera) {
      camera.getWorldDirection(this.dir);
      turned = this.dir.dot(this.lastDir) < 0.9994;
    }
    if (!force && !this.dirty && !turned && cam.distanceToSquared(this.lastRefresh) < 4) return;
    const moved = force || this.dirty || cam.distanceToSquared(this.lastRefresh) >= 4;
    this.dirty = false;
    this.lastRefresh.copy(cam);
    this.lastDir.copy(this.dir);
    if (camera) {
      camera.updateMatrixWorld();
      this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pm);
    }
    const near2 = (NEAR_DIST * detailScale) ** 2, max2 = MAX_DIST * MAX_DIST, keep2 = KEEP_DIST * KEEP_DIST, sh2 = (SHADOW_DIST * detailScale) ** 2;
    const shadows = this.shadows?.active ? this.shadows : undefined;
    for (const set of this.sets.values()) {
      let n = 0, f = 0, f2 = 0, sc = 0;
      let sbuf = shadows && moved ? this.shadowBuf.get(set.model.id) : undefined;
      if (shadows && moved && (!sbuf || sbuf.length < set.slots.length * 16)) {
        sbuf = new Float32Array(Math.max(16, set.slots.length * 16));
        this.shadowBuf.set(set.model.id, sbuf);
      }
      const nb = set.nearBody.instanceMatrix.array as Float32Array, nm = set.nearMisc.instanceMatrix.array as Float32Array;
      const nw = set.nearWheels.instanceMatrix.array as Float32Array;
      const fb = set.farBody.instanceMatrix.array as Float32Array, fm = set.farMisc.instanceMatrix.array as Float32Array;
      const fb2 = set.farBody2.instanceMatrix.array as Float32Array;
      const far2 = (FAR2_DIST * detailScale) ** 2;
      for (const s of set.slots) {
        if (s.active && !s.sleepy) continue;
        const d2 = (s.x - cam.x) ** 2 + (s.z - cam.z) ** 2;
        if (d2 > max2) continue;
        const m = this.slotMatrix(s);
        if (sbuf && d2 < sh2) { sbuf.set(m, sc * 16); sc++; }
        if (camera && d2 > keep2) {
          this.sph.center.set(s.x, s.y + 1, s.z);
          this.sph.radius = 3.5 + Math.sqrt(d2) * 0.06; // margin so quick turns don't pop
          if (!this.frustum.intersectsSphere(this.sph)) continue;
        }
        if (d2 < near2) {
          nb.set(m, n * 16); nm.set(m, n * 16); nw.set(m, n * 16);
          set.nearBody.setColorAt(n, s.col!);
          n++;
        } else if (d2 < far2) {
          fb.set(m, f * 16);
          set.farBody.setColorAt(f, s.col!);
          fm.set(m, f * 16);
          f++;
        } else {
          fb2.set(m, f2 * 16);
          set.farBody2.setColorAt(f2, s.col!);
          f2++;
        }
      }
      if (sbuf && shadows) shadows.setStatic(set.model, sbuf, sc);
      for (const im of [set.nearBody, set.nearMisc, set.nearWheels]) { im.count = n; im.instanceMatrix.needsUpdate = true; }
      set.farBody.count = f; set.farBody2.count = f2; set.farMisc.count = f;
      for (const im of [set.farBody, set.farBody2, set.farMisc]) im.instanceMatrix.needsUpdate = true;
      for (const im of [set.nearBody, set.farBody, set.farBody2]) if (im.instanceColor) im.instanceColor.needsUpdate = true;
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

let vfMat: THREE.MeshStandardMaterial | null = null;
function veryFarMaterial() {
  if (!vfMat) { vfMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.15 }); vfMat.name = 'parked-very-far'; }
  return vfMat;
}

/**
 * Box proxy for distant parked cars (> FAR2_DIST): paint body box, tapered dark glasshouse with a
 * paint roof, and a dark band underneath standing in for wheels/underbody. Vertex colours × paint.
 */
function boxProxy(m: CarModel) {
  const bottom = m.colCenter.y - m.colHalf.y, belt = m.colCenter.y + m.colHalf.y;
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, y: number, z: number, faceCol: (face: number) => number, taper = 1) => {
    const g = new THREE.BoxGeometry(w, h, d);
    const p = g.attributes.position as THREE.BufferAttribute;
    if (taper !== 1) for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setXYZ(i, p.getX(i) * taper, p.getY(i), p.getZ(i) * (0.5 + taper * 0.5) - d * 0.04);
    g.translate(0, y, z);
    g.deleteAttribute('uv');
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) col.fill(faceCol(Math.floor(i / 4)), i * 3, i * 3 + 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    parts.push(g);
  };
  const dark = 0.03;
  box(m.W * 2 - 0.12, bottom - 0.02, m.L - 0.4, (bottom + 0.02) / 2, 0, () => 0.015);
  box(m.W * 2, belt - bottom, m.L, (belt + bottom) / 2, 0, () => 1);
  const cabLen = (m.cabHalf.z * 2) / 0.8;
  box(m.cabHalf.x * 2 + 0.1, m.roofY - belt, cabLen, (m.roofY + belt) / 2, m.cabCenter.z, (f) => (f === 2 ? 1 : dark), 0.82);
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  return g;
}

/** lod2 body with groups (paint, glass, dark, trim) baked into a colour attribute. */
export function bakedLod2(m: CarModel) {
  const src = m.lod2.body;
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
  g.setIndex(src.index);
  const n = src.attributes.position.count;
  const col = new Float32Array(n * 3).fill(1);
  const tint = [[1, 1, 1], [0.035, 0.04, 0.045], [0.02, 0.02, 0.02], [0.06, 0.06, 0.065]];
  const idx = src.index!;
  for (const gr of src.groups) {
    const t = tint[gr.materialIndex ?? 0];
    if (!t || gr.materialIndex === 0) continue;
    for (let i = gr.start; i < gr.start + gr.count; i++) { const v = idx.getX(i); col.set(t, v * 3); }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
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
