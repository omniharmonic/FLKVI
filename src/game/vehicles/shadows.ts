// Car shadow casters (perf): one instanced, single-material low-poly hull (lod2 body + wheels)
// per car model stands in for every car's sun shadow — parked instances and live vehicles alike.
// The hull is drawn only in the shadow pass (see render/shadowProxy), so the detailed
// multi-material car meshes don't cast: ~2 draw calls per model instead of ~30 per car.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Game } from '../../core/game';
import type { CarModel } from './carModels';
import { registerShadowProxy } from '../../render/shadowProxy';

interface Entry { mesh: THREE.InstancedMesh; staticCount: number; count: number }

const proxyMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
proxyMat.name = 'car-shadow-proxy';

function hullGeometry(m: CarModel) {
  const strip = (src: THREE.BufferGeometry) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    if (src.index) g.setIndex(src.index);
    return g;
  };
  const parts = [strip(m.lod2.body), strip(m.lod.wheels)];
  const hasIndex = parts.every((p) => p.index);
  const geo = mergeGeometries(hasIndex ? parts : parts.map((p) => (p.index ? p.toNonIndexed() : p)), false)!;
  // Pull the hull a hair inside the real body so it never self-shadows the detailed paint.
  geo.computeBoundingBox();
  const c = geo.boundingBox!.getCenter(new THREE.Vector3());
  geo.translate(-c.x, -c.y, -c.z).scale(0.985, 0.985, 0.985).translate(c.x, c.y, c.z);
  geo.computeBoundingSphere();
  return geo;
}

export class CarShadows {
  readonly group = new THREE.Group();
  /** False when the renderer doesn't support shadow proxies: callers keep their own casters. */
  readonly active: boolean;
  private entries = new Map<string, Entry>();

  constructor(private g: Game) {
    this.group.name = 'car-shadow-proxies';
    g.scene.add(this.group);
    this.active = registerShadowProxy(g, this.group);
  }

  private entry(model: CarModel): Entry {
    let e = this.entries.get(model.id);
    if (!e) {
      e = { mesh: this.makeMesh(model, 64), staticCount: 0, count: 0 };
      this.entries.set(model.id, e);
    }
    return e;
  }

  private makeMesh(model: CarModel, cap: number) {
    const mesh = new THREE.InstancedMesh(hullGeometry(model), proxyMat, cap);
    mesh.name = `car-shadow:${model.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false; // per-cascade culling would need instance bounds; 1 call either way
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(mesh);
    return mesh;
  }

  private ensure(model: CarModel, e: Entry, n: number) {
    const cap = e.mesh.instanceMatrix.count;
    if (n <= cap) return;
    const old = e.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, proxyMat, Math.max(n, cap * 2));
    mesh.name = old.name;
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    this.group.remove(old);
    old.dispose();
    this.group.add(mesh);
    e.mesh = mesh;
    void model;
  }

  /** Replace the static (parked) instances of a model. `mats` holds column-major 4x4s back to back. */
  setStatic(model: CarModel, mats: Float32Array, n: number) {
    const e = this.entry(model);
    this.ensure(model, e, n + 16);
    (e.mesh.instanceMatrix.array as Float32Array).set(mats.subarray(0, n * 16), 0);
    e.staticCount = n;
    e.count = n;
    e.mesh.count = n;
    e.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Start a frame of dynamic (live vehicle) instances. */
  begin() {
    for (const e of this.entries.values()) e.count = e.staticCount;
  }

  add(model: CarModel, m: THREE.Matrix4) {
    const e = this.entry(model);
    this.ensure(model, e, e.count + 1);
    m.toArray(e.mesh.instanceMatrix.array as Float32Array, e.count * 16);
    e.count++;
  }

  end() {
    for (const e of this.entries.values()) {
      e.mesh.count = e.count;
      e.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
