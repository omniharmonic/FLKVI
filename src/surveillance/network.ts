// Camera entities: placement, per-frame transforms, status LEDs, physics colliders, toppling, disabled overlays.
import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Game } from '../core/game';
import type { RecipeCamera, CameraType, Vec2, Vec3 } from '../core/types';
import { hashString, rng } from '../core/geo';
import { canSee, type Observer } from '../ai/perception';
import { getModel, type ModelDef } from './models';
import { InstancePool } from './pool';
import { mats, splatterTexture } from './materials';
import { TUNE } from './constants';

export type CamStatus = 'active' | 'disabled' | 'down' | 'repairing';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const Y = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

export class Cam {
  status: CamStatus = 'active';
  discovered: boolean;
  coverage = 0;
  seesPlayer = false;
  installed = false;
  /** Times this camera has been disabled (for reduced re-hit points). */
  hits = 0;
  lastTakedownAt = -1e9;
  repairAt = 0;
  repairEndAt = 0;
  sweepYaw = 0;
  readonly phase: number;
  slot: number;
  /** World matrices. */
  readonly baseM = new THREE.Matrix4();
  readonly postM = new THREE.Matrix4();
  readonly headM = new THREE.Matrix4();
  readonly eye = new THREE.Vector3();
  readonly dir = new THREE.Vector3();
  /** World point where the player stands to work (post base). */
  readonly work = new THREE.Vector3();
  groundY: number;
  body: RAPIER_NS.RigidBody | null = null;
  fixedColliders: RAPIER_NS.Collider[] = [];
  baseColliders: RAPIER_NS.Collider[] = [];
  padCollider: RAPIER_NS.Collider | null = null;
  fallT = 0;
  clanged = 0;
  /** Fallback topple (no physics): angle and axis. */
  fallAngle = 0; fallVel = 0; fallAxis = new THREE.Vector3(1, 0, 0);
  overlay: THREE.Group | null = null;
  lastWitnessAt = -1e9;
  lastPlateAt = -1e9;
  nextCheckAt = 0;

  constructor(public rc: RecipeCamera, public model: ModelDef, slot: number, groundY: number) {
    this.discovered = rc.mapped;
    this.slot = slot;
    this.groundY = groundY;
    this.phase = (hashString(rc.id) % 1000) / 1000;
  }

  get type(): CameraType { return this.rc.type; }
  get active() { return this.status === 'active'; }
  /** Effective horizontal look heading (radians, 0 = north, clockwise). */
  get lookHeading() { return this.rc.heading - this.sweepYaw; }
  get cuttable() { return this.rc.cuttable && this.status !== 'down'; }
}

export class Network {
  readonly cams: Cam[] = [];
  readonly byId = new Map<string, Cam>();
  readonly pool: InstancePool;
  private emitTimer = 0;
  private overlayMats = new Map<string, THREE.Material>();

  constructor(private g: Game, readonly root: THREE.Group) {
    this.pool = new InstancePool(root, g);
  }

  groundAt(x: number, z: number, fallback: number) {
    const w = this.g.world;
    try {
      if (w?.groundAt) { const y = w.groundAt(x, z); if (Number.isFinite(y)) return y; }
      if (w?.heightAt) { const y = w.heightAt(x, z); if (Number.isFinite(y)) return y; }
    } catch { /* world not ready */ }
    return fallback;
  }

  private hasSignalNear(x: number, z: number, r: number) {
    for (const p of this.g.recipe.props ?? []) {
      if (p.type !== 'traffic-signal') continue;
      if ((p.p[0] - x) ** 2 + (p.p[1] - z) ** 2 < r * r) return true;
    }
    return false;
  }

  modelFor(rc: RecipeCamera): ModelDef {
    const v = hashString(rc.id);
    const h = rc.type === 'cluster' ? (rc.poleHeight || 6.8) : rc.poleHeight || (rc.type === 'ptz' ? 6.5 : rc.type === 'tower' ? 8 : 4.6);
    const arm = (rc as RecipeCamera & { armOffset?: number }).armOffset;
    if (rc.type === 'cluster' && arm !== undefined) return getModel('cluster', 0, h, { armOffset: arm });
    return getModel(rc.type, v % 3, h, { fallbackMast: rc.type === 'cluster' && !this.hasSignalNear(rc.p[0], rc.p[1], 1.5) });
  }

  private usedMasts = new Set<number>();
  /**
   * Move a signal-mast cluster onto the nearest real traffic-signal mast arm the world built (g.world.signalMasts),
   * hung ~45% along the arm and looking back across the junction at approaching traffic. Keeps the recipe
   * position (with its own fallback mast) when no world mast is near.
   */
  private snapCluster(rc: RecipeCamera): RecipeCamera {
    const masts = (this.g.world as unknown as { signalMasts?: { x: number; y: number; z: number; dx: number; dz: number; len: number }[] })?.signalMasts;
    if (!masts?.length) return rc;
    let bi = -1, bd = 40 * 40;
    for (let i = 0; i < masts.length; i++) {
      if (this.usedMasts.has(i)) continue;
      const m = masts[i];
      const d = (m.x - rc.p[0]) ** 2 + (m.z - rc.p[1]) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return rc;
    this.usedMasts.add(bi);
    const m = masts[bi];
    const a = Math.max(1.2, Math.min(m.len - 0.4, m.len * 0.45, 3));
    const p: Vec2 = [m.x + m.dx * a, m.z + m.dz * a];
    return { ...rc, p, y: m.y, heading: Math.atan2(m.dz, m.dx), armOffset: a } as RecipeCamera;
  }

  add(rc: RecipeCamera): Cam {
    const model = this.modelFor(rc);
    const slot = this.pool.alloc(model);
    // mast clusters hang from the arm: keep the signal pole's base height so the clamp meets the arm
    const gy = (rc as RecipeCamera & { armOffset?: number }).armOffset !== undefined ? rc.y : this.groundAt(rc.p[0], rc.p[1], rc.y);
    const cam = new Cam({ ...rc }, model, slot, gy);
    this.cams.push(cam);
    this.byId.set(rc.id, cam);
    this.place(cam);
    this.createColliders(cam);
    return cam;
  }

  build() {
    const recipeCams = (this.g.recipe.cameras ?? []).map((rc) => (rc.type === 'cluster' ? this.snapCluster(rc) : rc));
    const counts = new Map<string, { m: ModelDef; n: number }>();
    for (const rc of recipeCams) {
      const m = this.modelFor(rc);
      const e = counts.get(m.id) ?? { m, n: 0 };
      e.n++;
      counts.set(m.id, e);
    }
    for (const { m, n } of counts.values()) this.pool.reserve(m, n + 2);
    for (const rc of recipeCams) this.add(rc);
  }

  /** Compute static world transforms for the intact state. */
  place(cam: Cam) {
    const { rc, model } = cam;
    _q.setFromAxisAngle(Y, -rc.heading);
    cam.baseM.compose(_v.set(rc.p[0], cam.groundY, rc.p[1]), _q, new THREE.Vector3(1, 1, 1));
    cam.postM.copy(cam.baseM).multiply(_m.makeTranslation(model.postOrigin));
    cam.work.copy(model.workPoint).applyMatrix4(cam.baseM);
    this.pool.setMatrix(model, cam.slot, 'base', cam.baseM);
    this.writeUpper(cam);
  }

  /** Post / head / panel instance matrices from cam.postM and sweep. */
  writeUpper(cam: Cam) {
    const { model } = cam;
    this.pool.setMatrix(model, cam.slot, 'post', cam.postM);
    cam.headM.copy(cam.postM).multiply(_m.makeTranslation(model.headPivot)).multiply(_m2.makeRotationY(cam.sweepYaw));
    this.pool.setMatrix(model, cam.slot, 'head', cam.headM);
    if (model.panelPivot) {
      _m.copy(cam.postM).multiply(_m2.makeTranslation(model.panelPivot)).multiply(new THREE.Matrix4().makeRotationY(cam.rc.heading));
      this.pool.setMatrix(model, cam.slot, 'panel', _m);
    }
    cam.eye.copy(model.eye).applyMatrix4(cam.headM);
    cam.dir.copy(model.eyeDir).transformDirection(cam.headM);
  }

  // ------------------------------------------------------------------ physics
  private createColliders(cam: Cam) {
    const g = this.g;
    if (!g.physics || !g.rapier) return;
    const R = g.rapier;
    const make = (specs: ModelDef['postColliders'], frame: THREE.Matrix4) => {
      const out: RAPIER_NS.Collider[] = [];
      const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      frame.decompose(pos, q, s);
      for (const c of specs) {
        const center = new THREE.Vector3(...c.center).applyQuaternion(q).add(pos);
        const d = R.ColliderDesc.cuboid(...c.half).setTranslation(center.x, center.y, center.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
        out.push(g.physics.createCollider(d));
      }
      return out;
    };
    cam.baseColliders = make(cam.model.baseColliders, cam.baseM);
    cam.fixedColliders = make(cam.model.postColliders, cam.postM);
  }

  private removeColliders(list: RAPIER_NS.Collider[]) {
    for (const c of list) { try { this.g.physics.removeCollider(c, false); } catch { /* gone */ } }
    list.length = 0;
  }

  /** Cut: turn the post into a dynamic rigid body that topples away from `from`. */
  topple(cam: Cam, from: THREE.Vector3) {
    const g = this.g;
    cam.status = 'down';
    cam.fallT = 0;
    cam.clanged = 0;
    this.removeColliders(cam.fixedColliders);
    const away = new THREE.Vector3().subVectors(cam.work, from).setY(0);
    if (away.lengthSq() < 1e-4) away.set(0, 0, 1).applyQuaternion(_q.setFromAxisAngle(Y, -cam.rc.heading));
    away.normalize();
    const r = rng(hashString(cam.rc.id) + g.elapsed * 1000);
    away.applyAxisAngle(Y, (r() - 0.5) * 0.6);
    if (!g.physics || !g.rapier) {
      cam.fallAxis.crossVectors(Y, away).normalize();
      cam.fallVel = 0.25;
      return;
    }
    const R = g.rapier;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    cam.postM.decompose(pos, q, s);
    const body = g.physics.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y + 0.015, pos.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCcdEnabled(true).setAngularDamping(0.15).setLinearDamping(0.05),
    );
    for (const c of cam.model.postColliders) {
      const d = R.ColliderDesc.cuboid(...c.half).setTranslation(...c.center).setDensity(c === cam.model.postColliders[0] ? 1400 : 350)
        .setFriction(0.9).setRestitution(0.12);
      g.physics.createCollider(d, body);
    }
    cam.body = body;
    // make sure there is ground to land on (world may not have a terrain collider)
    const hit = g.physics.castRay(new R.Ray({ x: pos.x + away.x * 2.5, y: pos.y + 6, z: pos.z + away.z * 2.5 }, { x: 0, y: -1, z: 0 }), 60, true);
    if (!hit) {
      const d = R.ColliderDesc.cuboid(12, 0.5, 12).setTranslation(pos.x, cam.groundY - 0.5, pos.z);
      cam.padCollider = g.physics.createCollider(d);
    }
    const top = cam.model.postColliders[0].half[1] * 2;
    const m = body.mass();
    const tip = new THREE.Vector3(0, top, 0).applyQuaternion(q).add(pos);
    body.applyImpulseAtPoint({ x: away.x * m * 0.9, y: 0, z: away.z * m * 0.9 }, { x: tip.x, y: tip.y, z: tip.z }, true);
  }

  /** Per frame: sync fallen posts, sweep heads, emitters. */
  update(dt: number, t: number, night: number) {
    const g = this.g;
    for (const cam of this.cams) {
      if (cam.status === 'down') {
        if (cam.body) {
          const p = cam.body.translation(), r = cam.body.rotation();
          cam.postM.compose(_v.set(p.x, p.y, p.z), _q.set(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
          if (cam.fallT < 30) { cam.fallT += dt; this.writeUpper(cam); this.clangCheck(cam); }
        } else if (cam.fallAngle < Math.PI / 2 - 0.02 || cam.fallVel !== 0) {
          // fallback topple without physics: rotate about the cut pivot, small bounce
          cam.fallVel += dt * 7.8 * Math.sin(cam.fallAngle + 0.08);
          cam.fallAngle += cam.fallVel * dt;
          if (cam.fallAngle >= Math.PI / 2 - 0.02) {
            if (Math.abs(cam.fallVel) > 0.3) { cam.fallVel = -cam.fallVel * 0.18; this.clang(cam, cam.clanged++ === 0 ? 1 : 0.4); }
            else cam.fallVel = 0;
            cam.fallAngle = Math.min(cam.fallAngle, Math.PI / 2 - 0.02);
          }
          const origin = cam.model.postOrigin.clone().applyMatrix4(cam.baseM);
          _q.setFromAxisAngle(Y, -cam.rc.heading);
          cam.postM.makeRotationFromQuaternion(_q).premultiply(_m.makeRotationAxis(cam.fallAxis, cam.fallAngle)).setPosition(origin);
          this.writeUpper(cam);
        }
        continue;
      }
      if (cam.rc.sweep && cam.status === 'active') {
        const s = cam.rc.sweep;
        cam.sweepYaw = -s.amplitudeDeg * DEG * Math.sin((2 * Math.PI * (t + cam.phase * s.periodS)) / Math.max(1, s.periodS));
        this.writeUpper(cam);
      }
    }
    this.emitTimer -= dt;
    if (this.emitTimer <= 0) { this.emitTimer = 0.05; this.updateEmitters(t, night); }
    this.pool.update(dt);
    void g;
  }

  private clangCheck(cam: Cam) {
    if (!cam.body || cam.clanged >= 2) return;
    const top = cam.model.postColliders[0].half[1] * 2;
    const tip = new THREE.Vector3(0, top, 0).applyMatrix4(cam.postM);
    const v = cam.body.linvel();
    const threshold = cam.groundY + (cam.clanged === 0 ? 0.9 : 0.5);
    if (tip.y < threshold && (cam.clanged === 0 || Math.abs(v.y) < 0.4)) {
      this.clang(cam, cam.clanged === 0 ? 1 : 0.45);
      cam.clanged++;
    }
  }

  onClang: (cam: Cam, strength: number, p: THREE.Vector3) => void = () => {};

  private clang(cam: Cam, strength: number) {
    const top = cam.model.postColliders[0]?.half[1] ?? 2;
    const tip = new THREE.Vector3(0, top * 1.5, 0).applyMatrix4(cam.postM);
    tip.y = Math.max(tip.y, cam.groundY + 0.1);
    this.onClang(cam, strength, tip);
  }

  private updateEmitters(t: number, night: number) {
    const M = mats();
    for (const cam of this.cams) {
      const on = cam.status === 'active';
      // status LED: short red blink every 1.6 s (green-ish solid when repairing)
      if (on) {
        const ph = (t / 1.6 + cam.phase) % 1;
        const k = ph < 0.09 ? 1.2 + night * 5 : 0.03 + night * 0.08;
        _c.setRGB(k, k * 0.04, k * 0.03);
      } else if (cam.status === 'repairing') {
        const k = ((t * 3) % 1) < 0.5 ? 1.5 + night * 3 : 0.1;
        _c.setRGB(k * 0.9, k * 0.55, 0);
      } else _c.setRGB(0, 0, 0);
      this.pool.setEmitter(cam.model, cam.slot, M.led, _c);
      // IR illuminators glow faint red at night
      const ir = on ? night * 0.9 : 0;
      _c.setRGB(ir * 0.55, ir * 0.03, ir * 0.03);
      this.pool.setEmitter(cam.model, cam.slot, M.ir, _c);
      if (cam.type === 'tower') {
        const ph = (t + cam.phase * 2) % 2.2;
        const flash = on && (ph < 0.06 || (ph > 0.16 && ph < 0.22));
        const alt = Math.floor((t + cam.phase * 2) / 2.2) % 2 === 0;
        if (flash) alt ? _c.setRGB(3, 4.2, 8) : _c.setRGB(8, 5, 0.6);
        else _c.setRGB(0.05, 0.05, 0.06);
        this.pool.setEmitter(cam.model, cam.slot, M.strobe, _c);
      }
    }
  }

  // ------------------------------------------------------------------ perception
  /** Horizontal FOV of each lens (cluster/tower heads are the union of several lenses). */
  lensFov(cam: Cam) {
    return cam.type === 'tower' ? 125 : cam.type === 'cluster' ? cam.rc.fovDeg * 0.8 : cam.rc.fovDeg;
  }

  /** Can this active camera see world point `p`? Union of lens cones, vertical blind spot under the head, LOS. */
  sees(cam: Cam, p: Vec3, opts: { sweepAll?: boolean; crouching?: boolean } = {}): boolean {
    if (cam.status !== 'active') return false;
    const dx = p[0] - cam.eye.x, dy = p[1] - cam.eye.y, dz = p[2] - cam.eye.z;
    const hd = Math.hypot(dx, dz);
    const elev = Math.atan2(dy, hd);
    if (elev < -TUNE.maxDownAngleDeg * DEG || elev > TUNE.maxUpAngleDeg * DEG) return false;
    const pos: Vec3 = [cam.eye.x, cam.eye.y, cam.eye.z];
    let fov = this.lensFov(cam);
    let heading = cam.lookHeading;
    if (opts.sweepAll && cam.rc.sweep) { fov = Math.min(360, fov + cam.rc.sweep.amplitudeDeg * 2); heading = cam.rc.heading; }
    let inCone = false;
    for (const lens of cam.model.lenses) {
      const obs: Observer = { pos, dir: heading + Math.atan2(lens.d.x, -lens.d.z), fovDeg: fov, range: cam.rc.rangeM, ir: true };
      if (canSee(obs, p, this.g, { skipLos: true, crouching: opts.crouching })) { inCone = true; break; }
    }
    if (!inCone) return false;
    const w = this.g.world;
    if (!w?.losBlocked) return true;
    try { return !w.losBlocked(pos, p); } catch { return true; }
  }

  /** Recompute the coverage count (active cameras watching each camera's base). */
  recomputeCoverage() {
    for (const c of this.cams) c.coverage = 0;
    for (const target of this.cams) {
      if (target.status === 'down') continue;
      const p: Vec3 = [target.work.x, target.groundY + 1.2, target.work.z];
      for (const w of this.cams) {
        if (w === target || w.status !== 'active') continue;
        const d2 = (w.eye.x - p[0]) ** 2 + (w.eye.z - p[2]) ** 2;
        if (d2 > w.rc.rangeM * w.rc.rangeM || d2 < 4) continue;
        if (this.sees(w, p, { sweepAll: true, crouching: false })) target.coverage++;
      }
    }
  }

  // ------------------------------------------------------------------ disabled overlays
  private paintMat(color: string, seed: number) {
    const key = `${color}:${seed % 4}`;
    let m = this.overlayMats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color, map: splatterTexture(seed % 4 + 1), transparent: true, alphaTest: 0.35, roughness: 0.25, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false,
      });
      this.overlayMats.set(key, m);
    }
    return m;
  }

  /** Create the disabled look (paint splatter over each lens, or a bag over the head). Returns update fn for progress. */
  makeOverlay(cam: Cam, kind: 'spray' | 'bag', seed: number): (t: number) => void {
    this.clearOverlay(cam);
    const grp = new THREE.Group();
    grp.name = `surv-overlay-${cam.rc.id}`;
    grp.matrixAutoUpdate = false;
    grp.matrix.copy(cam.headM);
    const r = rng(seed);
    const palette = ['#0b0b0c', '#0b0b0c', '#101010', '#ff2d87', '#ff6a00', '#8bff1f', '#1fd3ff'];
    const color = palette[Math.floor(r() * palette.length)];
    const parts: THREE.Object3D[] = [];
    if (kind === 'spray') {
      const mat = this.paintMat(color, seed);
      for (const lens of cam.model.lenses) {
        const size = cam.type === 'ptz' ? 0.3 : 0.2;
        const pl = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
        pl.position.copy(lens.p).addScaledVector(lens.d, 0.004);
        pl.lookAt(pl.position.clone().add(lens.d));
        pl.rotateZ((r() - 0.5) * 0.6);
        pl.renderOrder = 3;
        grp.add(pl);
        parts.push(pl);
        // overspray on top of the housing
        const top = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.2, size * 1.2), mat);
        top.position.copy(lens.p).addScaledVector(lens.d, -0.12).add(new THREE.Vector3(0, 0.07, 0));
        top.rotation.x = -Math.PI / 2;
        top.rotateZ(r() * 6);
        grp.add(top);
        parts.push(top);
      }
      if (cam.type === 'ptz') {
        // painted dome
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.118, 24, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), this.paintMat(color, seed + 1));
        dome.position.set(0, 0.005, 0);
        grp.add(dome);
        parts.push(dome);
      }
    } else {
      const M = mats();
      const c = cam.model.lenses.reduce((a, l) => a.add(l.p), new THREE.Vector3()).multiplyScalar(1 / cam.model.lenses.length);
      const geo = new THREE.SphereGeometry(cam.type === 'cluster' || cam.type === 'tower' ? 0.5 : 0.26, 18, 12);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const n = 1 + 0.08 * Math.sin(x * 40 + seed) * Math.sin(z * 37) + 0.05 * Math.sin(y * 55);
        pos.setXYZ(i, x * n, y * n * (y > 0 ? 1.0 : 1.15), z * n * 1.25);
      }
      geo.computeVertexNormals();
      const bag = new THREE.Mesh(geo, M.trashBag);
      bag.position.copy(c).add(new THREE.Vector3(0, -0.02, 0.05));
      bag.castShadow = true;
      grp.add(bag);
      parts.push(bag);
      const tie = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 16), M.trashBag);
      tie.position.copy(bag.position).add(new THREE.Vector3(0, 0.02, 0.28));
      grp.add(tie);
      parts.push(tie);
    }
    this.root.add(grp);
    grp.updateMatrixWorld(true);
    cam.overlay = grp;
    return (t: number) => {
      const k = Math.min(1, Math.max(0.001, t));
      for (const p of parts) p.scale.setScalar(kind === 'bag' ? Math.max(0.001, k) : 0.35 + 0.65 * k);
      grp.visible = t > 0.02;
    };
  }

  clearOverlay(cam: Cam) {
    if (!cam.overlay) return;
    this.root.remove(cam.overlay);
    cam.overlay.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
    cam.overlay = null;
  }

  /** Restore a camera to its intact, active state (new run). */
  restore(cam: Cam) {
    const g = this.g;
    this.clearOverlay(cam);
    if (cam.body && g.physics) { try { g.physics.removeRigidBody(cam.body); } catch { /* gone */ } }
    cam.body = null;
    if (cam.padCollider) this.removeColliders([cam.padCollider]);
    cam.padCollider = null;
    this.removeColliders(cam.fixedColliders);
    this.removeColliders(cam.baseColliders);
    cam.status = 'active';
    cam.fallAngle = 0; cam.fallVel = 0; cam.fallT = 0; cam.hits = 0;
    cam.sweepYaw = 0;
    this.place(cam);
    this.createColliders(cam);
  }

  /** Remove a camera entirely (installed cameras on a new run). */
  remove(cam: Cam) {
    const g = this.g;
    this.clearOverlay(cam);
    if (cam.body && g.physics) { try { g.physics.removeRigidBody(cam.body); } catch { /* gone */ } }
    this.removeColliders(cam.fixedColliders);
    this.removeColliders(cam.baseColliders);
    if (cam.padCollider) this.removeColliders([cam.padCollider]);
    this.pool.release(cam.model, cam.slot);
    this.cams.splice(this.cams.indexOf(cam), 1);
    this.byId.delete(cam.rc.id);
  }
}
