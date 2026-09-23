// One InstancedMesh per (model, group, material). Cameras hold a slot index per model.
// Emitter materials (LED / IR / strobe) get per-instance colors.
//
// Perf: the sun shadow of each (model, group) comes from ONE merged single-material proxy
// (render/shadowProxy) instead of every per-material part, and tiny parts / proxies are
// switched off when every instance of the model is far from the camera.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { GroupKey, ModelDef } from './models';
import { mats } from './materials';
import { registerShadowProxy } from '../render/shadowProxy';

interface Entry { group: GroupKey; mesh: THREE.InstancedMesh; emitter: boolean; proxy?: boolean; small?: boolean; far?: boolean }
interface ModelBatch { model: ModelDef; entries: Entry[]; cap: number; used: number; free: number[]; dirty: boolean; pos: Map<number, THREE.Vector3>; farGroups: Set<GroupKey> }

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
/** Parts smaller than this (bounding radius, m) are hidden when all instances are beyond SMALL_DIST. */
const SMALL_R = 0.12;
const SMALL_DIST = 90;
/** Beyond this distance a model's shadow proxies are skipped (sub-texel in the far cascade). */
const SHADOW_DIST = 220;
/** Beyond this, a model's (model, group) parts collapse to one vertex-coloured mesh per group. */
const FAR_DIST = 70;
const proxyMat = new THREE.MeshBasicMaterial({ color: 0 });
const proxyGeoCache = new Map<string, THREE.BufferGeometry | null>();
const farGeoCache = new Map<string, THREE.BufferGeometry | null>();
let farMat: THREE.MeshStandardMaterial | null = null;

/** All non-emitter parts of a group merged, material colours baked into vertex colours (far LOD). */
function farGeometry(model: ModelDef, group: GroupKey, emitters: Set<THREE.Material>): THREE.BufferGeometry | null {
  const key = `${model.id}:${group}`;
  if (farGeoCache.has(key)) return farGeoCache.get(key)!;
  const geos: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  for (const part of model.groups[group]) {
    const m = part.mat as THREE.MeshStandardMaterial;
    if (emitters.has(m)) continue;
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', part.geo.getAttribute('position'));
    const n = part.geo.getAttribute('normal');
    if (n) g.setAttribute('normal', n);
    if (part.geo.index) g.setIndex(part.geo.index);
    if (g.index) g = g.toNonIndexed();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    c.copy(m.color ?? c.setRGB(0.5, 0.5, 0.5));
    if (m.map) c.multiplyScalar(0.75); // average darkening of grime / concrete maps
    if (m.transparent) c.multiplyScalar(0.35);
    const cnt = g.getAttribute('position').count;
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  const merged = geos.length > 1 ? mergeGeometries(geos, false) : null; // single-part groups need no far copy
  merged?.computeBoundingSphere();
  farGeoCache.set(key, merged);
  return merged;
}

function proxyGeometry(model: ModelDef, group: GroupKey, emitters: Set<THREE.Material>): THREE.BufferGeometry | null {
  const key = `${model.id}:${group}`;
  if (proxyGeoCache.has(key)) return proxyGeoCache.get(key)!;
  const geos: THREE.BufferGeometry[] = [];
  for (const part of model.groups[group]) {
    const m = part.mat as THREE.Material;
    if (emitters.has(m) || m.transparent) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', part.geo.getAttribute('position'));
    if (part.geo.index) g.setIndex(part.geo.index);
    geos.push(g.index ? g.toNonIndexed() : g);
  }
  const merged = geos.length ? mergeGeometries(geos, false) : null;
  merged?.computeBoundingSphere();
  proxyGeoCache.set(key, merged);
  return merged;
}

export class InstancePool {
  private batches = new Map<string, ModelBatch>();
  private boundsTimer = 0;
  /** Shadow-only proxies (one per model+group); null when proxies are unavailable. */
  private shadowRoot: THREE.Group | null = null;

  constructor(private root: THREE.Group, private g?: Game) {
    if (g) {
      const sr = new THREE.Group();
      sr.name = 'surv-shadow-proxies';
      root.add(sr);
      if (registerShadowProxy(g, sr)) this.shadowRoot = sr;
      else root.remove(sr);
    }
  }

  /** Reserve capacity up front (avoids regrowth). */
  reserve(model: ModelDef, n: number) {
    const b = this.batch(model, n);
    if (b.cap < n) this.grow(b, n);
  }

  alloc(model: ModelDef): number {
    const b = this.batch(model, 4);
    if (b.free.length) return b.free.pop()!;
    if (b.used >= b.cap) this.grow(b, Math.max(4, b.cap * 2));
    return b.used++;
  }

  release(model: ModelDef, slot: number) {
    const b = this.batches.get(model.id);
    if (!b) return;
    b.pos.delete(slot);
    for (const e of b.entries) e.mesh.setMatrixAt(slot, HIDDEN), (e.mesh.instanceMatrix.needsUpdate = true);
    b.free.push(slot);
    b.dirty = true;
  }

  setMatrix(model: ModelDef, slot: number, group: GroupKey, m: THREE.Matrix4) {
    const b = this.batches.get(model.id)!;
    for (const e of b.entries) if (e.group === group) { e.mesh.setMatrixAt(slot, m); e.mesh.instanceMatrix.needsUpdate = true; }
    if (group === 'base' || !b.pos.has(slot)) {
      let p = b.pos.get(slot);
      if (!p) b.pos.set(slot, (p = new THREE.Vector3()));
      p.setFromMatrixPosition(m);
    }
    b.dirty = true;
  }

  /** Per-instance color for emitter materials (led/ir/strobe) in the given model. */
  setEmitter(model: ModelDef, slot: number, mat: THREE.Material, c: THREE.Color) {
    const b = this.batches.get(model.id)!;
    for (const e of b.entries) if (e.emitter && e.mesh.material === mat) { e.mesh.setColorAt(slot, c); e.mesh.instanceColor!.needsUpdate = true; }
  }

  /** Recompute instanced bounding spheres occasionally so frustum culling stays correct. */
  update(dt: number) {
    this.boundsTimer -= dt;
    if (this.boundsTimer > 0) return;
    this.boundsTimer = 0.25;
    const cam = this.g?.camera.position;
    for (const b of this.batches.values()) {
      if (b.dirty) {
        b.dirty = false;
        for (const e of b.entries) { e.mesh.computeBoundingSphere(); e.mesh.computeBoundingBox(); }
      }
      if (!cam) continue;
      // distance LOD: nearest live instance of this model
      let d2 = Infinity;
      for (const p of b.pos.values()) d2 = Math.min(d2, (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2);
      const smallOn = d2 < SMALL_DIST * SMALL_DIST, shadowOn = d2 < SHADOW_DIST * SHADOW_DIST;
      const farOn = d2 > FAR_DIST * FAR_DIST;
      const farGroups = b.farGroups;
      for (const e of b.entries) {
        if (e.proxy) e.mesh.visible = shadowOn;
        else if (e.far) e.mesh.visible = farOn;
        else if (e.emitter) continue;
        else if (farOn && farGroups.has(e.group)) e.mesh.visible = false;
        else e.mesh.visible = e.small ? smallOn : true;
      }
    }
  }

  dispose() {
    for (const b of this.batches.values()) for (const e of b.entries) { e.mesh.parent?.remove(e.mesh); e.mesh.dispose(); }
    this.batches.clear();
  }

  private batch(model: ModelDef, initial: number): ModelBatch {
    let b = this.batches.get(model.id);
    if (b) return b;
    b = { model, entries: [], cap: 0, used: 0, free: [], dirty: true, pos: new Map(), farGroups: new Set() };
    this.batches.set(model.id, b);
    this.grow(b, Math.max(1, initial));
    return b;
  }

  private grow(b: ModelBatch, cap: number) {
    const M = mats();
    const emitters = new Set<THREE.Material>([M.led, M.ir, M.strobe]);
    const old = b.entries;
    const entries: Entry[] = [];
    let i = 0;
    for (const group of ['base', 'post', 'head', 'panel'] as GroupKey[]) {
      for (const part of b.model.groups[group]) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, cap);
        mesh.name = `surv:${b.model.id}:${group}:${(part.mat as THREE.Material).name}`;
        const emitter = emitters.has(part.mat);
        const transparent = (part.mat as THREE.Material).transparent;
        // with shadow proxies the per-material parts don't cast (the merged proxy does)
        mesh.castShadow = !emitter && !transparent && !this.shadowRoot;
        mesh.receiveShadow = !emitter;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        for (let k = 0; k < cap; k++) mesh.setMatrixAt(k, HIDDEN);
        if (emitter) { const c = new THREE.Color(0, 0, 0); for (let k = 0; k < cap; k++) mesh.setColorAt(k, c); }
        const prev = old[i];
        if (prev) {
          const m = new THREE.Matrix4(), c = new THREE.Color();
          for (let k = 0; k < b.cap; k++) {
            prev.mesh.getMatrixAt(k, m); mesh.setMatrixAt(k, m);
            if (emitter && prev.mesh.instanceColor) { prev.mesh.getColorAt(k, c); mesh.setColorAt(k, c); }
          }
          this.root.remove(prev.mesh);
          prev.mesh.dispose();
        }
        this.root.add(mesh);
        if (!part.geo.boundingSphere) part.geo.computeBoundingSphere();
        entries.push({ group, mesh, emitter, small: !emitter && part.geo.boundingSphere!.radius < SMALL_R });
        i++;
      }
      // far LOD for this group (one vertex-coloured mesh)
      const fg = this.g ? farGeometry(b.model, group, emitters) : null;
      if (fg) {
        if (!farMat) { farMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 }); farMat.name = 'surv-far'; }
        const mesh = new THREE.InstancedMesh(fg, farMat, cap);
        mesh.name = `surv-far:${b.model.id}:${group}`;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.visible = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const prev = old[i];
        const m = new THREE.Matrix4();
        for (let k = 0; k < cap; k++) {
          if (prev && k < b.cap) prev.mesh.getMatrixAt(k, m); else m.copy(HIDDEN);
          mesh.setMatrixAt(k, m);
        }
        if (prev) { mesh.visible = prev.mesh.visible; prev.mesh.parent?.remove(prev.mesh); prev.mesh.dispose(); }
        this.root.add(mesh);
        entries.push({ group, mesh, emitter: false, far: true });
        b.farGroups.add(group);
        i++;
      }
      // shadow proxy for this group
      const pg = this.shadowRoot && proxyGeometry(b.model, group, emitters);
      if (pg) {
        const mesh = new THREE.InstancedMesh(pg, proxyMat, cap);
        mesh.name = `surv-shadow:${b.model.id}:${group}`;
        mesh.castShadow = true;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const prev = old[i];
        const m = new THREE.Matrix4();
        for (let k = 0; k < cap; k++) {
          if (prev && k < b.cap) prev.mesh.getMatrixAt(k, m); else m.copy(HIDDEN);
          mesh.setMatrixAt(k, m);
        }
        if (prev) { prev.mesh.parent?.remove(prev.mesh); prev.mesh.dispose(); }
        this.shadowRoot!.add(mesh);
        entries.push({ group, mesh, emitter: false, proxy: true });
        i++;
      }
    }
    b.entries = entries;
    b.cap = cap;
    b.dirty = true;
  }
}
