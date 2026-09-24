// One InstancedMesh per (model, group, material). Cameras hold a slot index per model.
// Emitter materials (LED / IR / strobe) get per-instance colors.
//
// Perf: the sun shadow of each (model, group) comes from ONE merged single-material proxy
// (render/shadowProxy) instead of every per-material part, and tiny parts / proxies are
// switched off when every instance of the model is far from the camera.
//
// Distance LOD (per instance): beyond FAR_DIST a camera's non-emitter parts are drawn by one
// simplified (vertex-clustered), vertex-coloured mesh per (model, group) instead of the full-detail
// per-material parts. Detail and far meshes are "packed": only the instances in that LOD are written,
// so full-detail triangles are processed only for nearby cameras. Emitters (status LEDs, IR, strobes)
// and shadow proxies stay slot-indexed at full detail so their per-instance colours keep working.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../core/game';
import type { GroupKey, ModelDef } from './models';
import { mats } from './materials';
import { registerShadowProxy } from '../render/shadowProxy';

interface Entry {
  group: GroupKey; mesh: THREE.InstancedMesh; emitter: boolean; proxy?: boolean; small?: boolean; far?: boolean;
  /** packed: instances written compactly (detail / far LOD); else indexed by slot (emitters, proxies) */
  packed: boolean;
}
interface ModelBatch {
  model: ModelDef; entries: Entry[]; cap: number; used: number; free: number[]; dirty: boolean;
  pos: Map<number, THREE.Vector3>; farGroups: Set<GroupKey>;
  /** per slot, per group (4) world matrix */
  store: Float32Array;
  /** per slot LOD: 0 = full detail, 1 = far */
  lod: Uint8Array;
  packDirty: boolean; memberDirty: boolean;
}

const GROUPS: GroupKey[] = ['base', 'post', 'head', 'panel'];
const GI: Record<GroupKey, number> = { base: 0, post: 1, head: 2, panel: 3 };
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
/** Parts smaller than this (bounding radius, m) are hidden when all instances are beyond SMALL_DIST. */
const SMALL_R = 0.12;
const SMALL_DIST = 90;
/** Beyond this distance a model's shadow proxies are skipped (sub-texel in the far cascade). */
const SHADOW_DIST = 220;
/** Beyond this (m, with ±HYST hysteresis) a camera switches to its simplified far model. */
const FAR_DIST = 60;
const HYST = 4;
/** Vertex-clustering cell for the far model (m): ~1 px at 60 m on a 1080p screen. */
const FAR_CELL = 0.06;
const proxyMat = new THREE.MeshBasicMaterial({ color: 0 });
const proxyGeoCache = new Map<string, THREE.BufferGeometry | null>();
const farGeoCache = new Map<string, THREE.BufferGeometry | null>();
let farMat: THREE.MeshStandardMaterial | null = null;

/**
 * Vertex-clustering simplification of a non-indexed, vertex-coloured triangle soup: vertices snap to the
 * mean of their grid cell, collapsed triangles are dropped, normals become flat. Thin details (cables,
 * bolts, lens rings) vanish; boxes, posts and housings keep their silhouette.
 */
function clusterSimplify(g: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const n = pos.count;
  const ids = new Int32Array(n);
  const keyToId = new Map<string, number>();
  const acc: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    let id = keyToId.get(k);
    if (id === undefined) { id = keyToId.size; keyToId.set(k, id); acc.push(0, 0, 0, 0); }
    ids[i] = id;
    acc[id * 4] += x; acc[id * 4 + 1] += y; acc[id * 4 + 2] += z; acc[id * 4 + 3]++;
  }
  const P: number[] = [], C: number[] = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const a = ids[t], b = ids[t + 1], c = ids[t + 2];
    if (a === b || b === c || a === c) continue;
    for (const [v, id] of [[t, a], [t + 1, b], [t + 2, c]]) {
      const w = acc[id * 4 + 3];
      P.push(acc[id * 4] / w, acc[id * 4 + 1] / w, acc[id * 4 + 2] / w);
      C.push(col.getX(v), col.getY(v), col.getZ(v));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  out.computeVertexNormals(); // non-indexed → flat normals
  return out;
}

/** All non-emitter parts of a group merged and simplified, material colours baked into vertex colours (far LOD). */
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
    if (part.geo.index) g.setIndex(part.geo.index);
    if (g.index) g = g.toNonIndexed();
    c.copy(m.color ?? c.setRGB(0.5, 0.5, 0.5));
    if (m.map) c.multiplyScalar(0.75); // average darkening of grime / concrete maps
    if (m.transparent) c.multiplyScalar(0.35);
    const cnt = g.getAttribute('position').count;
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geos.push(g);
  }
  let out: THREE.BufferGeometry | null = null;
  if (geos.length) {
    const merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    out = merged ? clusterSimplify(merged, FAR_CELL) : null;
    if (out && out.getAttribute('position').count === 0) out = null;
    out?.computeBoundingSphere();
  }
  farGeoCache.set(key, out);
  return out;
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
    let slot: number;
    if (b.free.length) slot = b.free.pop()!;
    else {
      if (b.used >= b.cap) this.grow(b, Math.max(4, b.cap * 2));
      slot = b.used++;
    }
    b.lod[slot] = 0;
    return slot;
  }

  release(model: ModelDef, slot: number) {
    const b = this.batches.get(model.id);
    if (!b) return;
    b.pos.delete(slot);
    for (const e of b.entries) if (!e.packed) { e.mesh.setMatrixAt(slot, HIDDEN); e.mesh.instanceMatrix.needsUpdate = true; }
    b.free.push(slot);
    b.dirty = true; b.packDirty = true; b.memberDirty = true;
  }

  setMatrix(model: ModelDef, slot: number, group: GroupKey, m: THREE.Matrix4) {
    const b = this.batches.get(model.id)!;
    m.toArray(b.store, (slot * 4 + GI[group]) * 16);
    for (const e of b.entries) if (!e.packed && e.group === group) { e.mesh.setMatrixAt(slot, m); e.mesh.instanceMatrix.needsUpdate = true; }
    if (group === 'base' || !b.pos.has(slot)) {
      let p = b.pos.get(slot);
      if (!p) { b.pos.set(slot, (p = new THREE.Vector3())); b.memberDirty = true; b.lod[slot] = this.lodFor(p.setFromMatrixPosition(m), 0); }
      p.setFromMatrixPosition(m);
    }
    b.dirty = true; b.packDirty = true;
  }

  /** Per-instance color for emitter materials (led/ir/strobe) in the given model. */
  setEmitter(model: ModelDef, slot: number, mat: THREE.Material, c: THREE.Color) {
    const b = this.batches.get(model.id)!;
    for (const e of b.entries) if (e.emitter && e.mesh.material === mat) { e.mesh.setColorAt(slot, c); e.mesh.instanceColor!.needsUpdate = true; }
  }

  private lodFor(p: THREE.Vector3, cur: number): number {
    const cam = this.g?.camera.position;
    if (!cam) return 0;
    const d2 = (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2;
    if (cur === 0) return d2 > (FAR_DIST + HYST) ** 2 ? 1 : 0;
    return d2 < (FAR_DIST - HYST) ** 2 ? 0 : 1;
  }

  /** Write the packed (detail / far) instance buffers from the per-slot matrix store. */
  private repack(b: ModelBatch) {
    b.packDirty = false;
    const near: number[] = [], far: number[] = [];
    for (const slot of b.pos.keys()) (b.lod[slot] ? far : near).push(slot);
    for (const e of b.entries) {
      if (!e.packed) continue;
      const list = e.far ? far : b.farGroups.has(e.group) ? near : null;
      const arr = e.mesh.instanceMatrix.array as Float32Array;
      const gi = GI[e.group];
      let n = 0;
      if (list) for (const s of list) { arr.set(b.store.subarray((s * 4 + gi) * 16, (s * 4 + gi) * 16 + 16), n * 16); n++; }
      else for (const s of b.pos.keys()) { arr.set(b.store.subarray((s * 4 + gi) * 16, (s * 4 + gi) * 16 + 16), n * 16); n++; }
      e.mesh.count = n;
      e.mesh.instanceMatrix.needsUpdate = true;
      if (b.memberDirty) { e.mesh.computeBoundingSphere(); e.mesh.computeBoundingBox(); }
    }
    b.memberDirty = false;
  }

  /** Per-instance LOD, packed buffers, and occasional bounds refresh for frustum culling. */
  update(dt: number) {
    this.boundsTimer -= dt;
    const tick = this.boundsTimer <= 0;
    if (tick) this.boundsTimer = 0.25;
    const cam = this.g?.camera.position;
    for (const b of this.batches.values()) {
      if (tick && cam) {
        // distance LOD per instance (+ nearest live instance for the per-model toggles)
        let d2 = Infinity;
        for (const [slot, p] of b.pos) {
          d2 = Math.min(d2, (p.x - cam.x) ** 2 + (p.z - cam.z) ** 2);
          const l = this.lodFor(p, b.lod[slot]);
          if (l !== b.lod[slot]) { b.lod[slot] = l; b.packDirty = true; b.memberDirty = true; }
        }
        const smallOn = d2 < SMALL_DIST * SMALL_DIST, shadowOn = d2 < SHADOW_DIST * SHADOW_DIST;
        for (const e of b.entries) {
          if (e.proxy) e.mesh.visible = shadowOn;
          else if (e.small && !e.far) e.mesh.visible = smallOn;
        }
      }
      if (b.packDirty) this.repack(b);
      if (tick && b.dirty) {
        b.dirty = false;
        for (const e of b.entries) { e.mesh.computeBoundingSphere(); e.mesh.computeBoundingBox(); }
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
    b = {
      model, entries: [], cap: 0, used: 0, free: [], dirty: true, pos: new Map(), farGroups: new Set(),
      store: new Float32Array(0), lod: new Uint8Array(0), packDirty: true, memberDirty: true,
    };
    this.batches.set(model.id, b);
    this.grow(b, Math.max(1, initial));
    return b;
  }

  private grow(b: ModelBatch, cap: number) {
    const M = mats();
    const emitters = new Set<THREE.Material>([M.led, M.ir, M.strobe]);
    const old = b.entries;
    const store = new Float32Array(cap * 64); store.set(b.store.subarray(0, Math.min(b.store.length, store.length)));
    const lod = new Uint8Array(cap); lod.set(b.lod.subarray(0, Math.min(b.lod.length, cap)));
    b.store = store; b.lod = lod;
    const m = new THREE.Matrix4();
    /** slot-indexed matrix k of group from the store (HIDDEN for unused slots) */
    const slotMatrix = (k: number, group: GroupKey) => (b.pos.has(k) ? m.fromArray(store, (k * 4 + GI[group]) * 16) : HIDDEN);
    const entries: Entry[] = [];
    let i = 0;
    for (const group of GROUPS) {
      // far LOD for this group (one simplified vertex-coloured mesh)
      const fg = this.g ? farGeometry(b.model, group, emitters) : null;
      for (const part of b.model.groups[group]) {
        const mesh = new THREE.InstancedMesh(part.geo, part.mat, cap);
        mesh.name = `surv:${b.model.id}:${group}:${(part.mat as THREE.Material).name}`;
        const emitter = emitters.has(part.mat);
        const transparent = (part.mat as THREE.Material).transparent;
        // with shadow proxies the per-material parts don't cast (the merged proxy does)
        mesh.castShadow = !emitter && !transparent && !this.shadowRoot;
        mesh.receiveShadow = !emitter;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const packed = !emitter;
        if (packed) mesh.count = 0;
        else for (let k = 0; k < cap; k++) mesh.setMatrixAt(k, slotMatrix(k, group));
        if (emitter) {
          const c = new THREE.Color(0, 0, 0);
          for (let k = 0; k < cap; k++) mesh.setColorAt(k, c);
          const prev = old[i];
          if (prev?.mesh.instanceColor) for (let k = 0; k < b.cap; k++) { prev.mesh.getColorAt(k, c); mesh.setColorAt(k, c); }
        }
        const prev = old[i];
        if (prev) { mesh.visible = prev.mesh.visible; prev.mesh.parent?.remove(prev.mesh); prev.mesh.dispose(); }
        this.root.add(mesh);
        if (!part.geo.boundingSphere) part.geo.computeBoundingSphere();
        entries.push({ group, mesh, emitter, packed, small: !emitter && part.geo.boundingSphere!.radius < SMALL_R });
        i++;
      }
      if (fg) {
        if (!farMat) { farMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 }); farMat.name = 'surv-far'; }
        const mesh = new THREE.InstancedMesh(fg, farMat, cap);
        mesh.name = `surv-far:${b.model.id}:${group}`;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const prev = old[i];
        if (prev) { prev.mesh.parent?.remove(prev.mesh); prev.mesh.dispose(); }
        this.root.add(mesh);
        entries.push({ group, mesh, emitter: false, far: true, packed: true });
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
        for (let k = 0; k < cap; k++) mesh.setMatrixAt(k, slotMatrix(k, group));
        const prev = old[i];
        if (prev) { mesh.visible = prev.mesh.visible; prev.mesh.parent?.remove(prev.mesh); prev.mesh.dispose(); }
        this.shadowRoot!.add(mesh);
        entries.push({ group, mesh, emitter: false, proxy: true, packed: false });
        i++;
      }
    }
    b.entries = entries;
    b.cap = cap;
    b.dirty = true; b.packDirty = true; b.memberDirty = true;
  }
}
