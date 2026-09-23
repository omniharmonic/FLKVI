// One InstancedMesh per (model, group, material). Cameras hold a slot index per model.
// Emitter materials (LED / IR / strobe) get per-instance colors.
import * as THREE from 'three';
import type { GroupKey, ModelDef } from './models';
import { mats } from './materials';

interface Entry { group: GroupKey; mesh: THREE.InstancedMesh; emitter: boolean }
interface ModelBatch { model: ModelDef; entries: Entry[]; cap: number; used: number; free: number[]; dirty: boolean }

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class InstancePool {
  private batches = new Map<string, ModelBatch>();
  private boundsTimer = 0;

  constructor(private root: THREE.Group) {}

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
    for (const e of b.entries) e.mesh.setMatrixAt(slot, HIDDEN), (e.mesh.instanceMatrix.needsUpdate = true);
    b.free.push(slot);
    b.dirty = true;
  }

  setMatrix(model: ModelDef, slot: number, group: GroupKey, m: THREE.Matrix4) {
    const b = this.batches.get(model.id)!;
    for (const e of b.entries) if (e.group === group) { e.mesh.setMatrixAt(slot, m); e.mesh.instanceMatrix.needsUpdate = true; }
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
    this.boundsTimer = 0.5;
    for (const b of this.batches.values()) {
      if (!b.dirty) continue;
      b.dirty = false;
      for (const e of b.entries) { e.mesh.computeBoundingSphere(); e.mesh.computeBoundingBox(); }
    }
  }

  dispose() {
    for (const b of this.batches.values()) for (const e of b.entries) { this.root.remove(e.mesh); e.mesh.dispose(); }
    this.batches.clear();
  }

  private batch(model: ModelDef, initial: number): ModelBatch {
    let b = this.batches.get(model.id);
    if (b) return b;
    b = { model, entries: [], cap: 0, used: 0, free: [], dirty: true };
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
        mesh.castShadow = !emitter && !transparent;
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
        entries.push({ group, mesh, emitter });
        i++;
      }
    }
    b.entries = entries;
    b.cap = cap;
    b.dirty = true;
  }
}
