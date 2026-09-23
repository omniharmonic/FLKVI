// Far-LOD batching for live vehicles (perf). Beyond LOD_FAR a car already shows its coarse far
// visual (body 4 groups + wheels + head/tail lamps ≈ 8 draws per car). Those far visuals are
// drawn here instead as per-model InstancedMeshes — ~8 draws per MODEL — with per-instance paint
// and per-instance lamp emission (head on/off, tail off/run/brake), so dusk/night traffic still
// glows correctly. Police cars stay individual (their flashing light bar is a gameplay cue).
import * as THREE from 'three';
import type { CarModel } from './carModels';
import { mats } from './materials';
import { paintFor } from './visual';

interface Batch { body: THREE.InstancedMesh; wheels: THREE.InstancedMesh; head: THREE.InstancedMesh; tail: THREE.InstancedMesh; n: number }

/** Lamp material whose emissive strength comes from instanceColor.r (diffuse untouched). */
function lampMaterial(src: THREE.MeshPhysicalMaterial, key: string) {
  const m = src.clone();
  m.emissiveIntensity = 1;
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', '')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\n  totalEmissiveRadiance *= vColor.r;\n#endif');
  };
  m.customProgramCacheKey = () => 'gt-far-lamp-' + key;
  return m;
}

let headMat: THREE.MeshPhysicalMaterial | null = null;
let tailMat: THREE.MeshPhysicalMaterial | null = null;

export class FarTrafficBatch {
  readonly group = new THREE.Group();
  private batches = new Map<string, Batch>();
  private col = new THREE.Color();

  constructor() { this.group.name = 'far-traffic'; }

  private batch(model: CarModel): Batch {
    let b = this.batches.get(model.id);
    if (b) return b;
    headMat ??= lampMaterial(mats.headOn, 'head');
    tailMat ??= lampMaterial(mats.tailBrake, 'tail');
    const cap = 64;
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadowRecv: boolean) => {
      const im = new THREE.InstancedMesh(geo, mat, cap);
      im.count = 0;
      im.castShadow = false; // CarShadows hulls cast for every car
      im.receiveShadow = shadowRecv;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = `far-traffic:${model.id}`;
      this.group.add(im);
      return im;
    };
    b = {
      body: mk(model.lod.body, [paintFor(model, '#ffffff'), mats.glassFar, mats.dark, mats.trim], true),
      wheels: mk(model.lod.wheels, [mats.tire, mats.rim], false),
      head: mk(model.lod.head, headMat, false),
      tail: mk(model.lod.tail, tailMat, false),
      n: 0,
    };
    for (const im of [b.body, b.head, b.tail]) im.setColorAt(0, this.col.setRGB(1, 1, 1));
    this.batches.set(model.id, b);
    return b;
  }

  private grow(b: Batch, need: number) {
    for (const k of ['body', 'wheels', 'head', 'tail'] as const) {
      const old = b[k];
      if (need <= old.instanceMatrix.count) continue;
      const im = new THREE.InstancedMesh(old.geometry, old.material, Math.max(need, old.instanceMatrix.count * 2));
      im.name = old.name; im.castShadow = false; im.receiveShadow = old.receiveShadow;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      (im.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
      if (old.instanceColor) { im.setColorAt(0, this.col.setRGB(1, 1, 1)); (im.instanceColor!.array as Float32Array).set(old.instanceColor.array as Float32Array); }
      this.group.remove(old); old.dispose(); this.group.add(im);
      b[k] = im;
    }
  }

  begin() { for (const b of this.batches.values()) b.n = 0; }

  /** Add one far car. `paint` hex, lamp emission factors in material-intensity units. */
  add(model: CarModel, m: THREE.Matrix4, paint: string, head: number, tail: number) {
    const b = this.batch(model);
    if (b.n >= b.body.instanceMatrix.count) this.grow(b, b.n + 1);
    const i = b.n++;
    for (const im of [b.body, b.wheels, b.head, b.tail]) im.setMatrixAt(i, m);
    b.body.setColorAt(i, this.col.set(model.livery === 'police' || model.livery === 'taxi' ? '#ffffff' : paint));
    b.head.setColorAt(i, this.col.setRGB(head, head, head));
    b.tail.setColorAt(i, this.col.setRGB(tail, tail, tail));
  }

  end() {
    for (const b of this.batches.values()) {
      for (const im of [b.body, b.wheels, b.head, b.tail]) {
        im.count = b.n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (b.n) im.computeBoundingSphere();
      }
    }
  }
}

/**
 * Near-LOD wheels of live vehicles, instanced per model (perf): each car's 4 wheels × 3 materials
 * were 12 draws per car; batched they are 3 draws per model. Wheel meshes keep spinning/steering —
 * we copy their world matrices every frame and hide the originals.
 */
export class WheelBatch {
  readonly group = new THREE.Group();
  private batches = new Map<string, { im: THREE.InstancedMesh; n: number }>();

  constructor() { this.group.name = 'near-wheels'; }

  begin() { for (const b of this.batches.values()) b.n = 0; }

  add(model: CarModel, wheel: THREE.Mesh) {
    let b = this.batches.get(model.id);
    const cap = b?.im.instanceMatrix.count ?? 0;
    if (!b || b.n >= cap) {
      const im = new THREE.InstancedMesh(model.wheel, [mats.tire, mats.rim, mats.rimDark], Math.max(32, cap * 2));
      im.name = `near-wheels:${model.id}`;
      im.castShadow = false; // CarShadows hulls include the wheels
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (b) { (im.instanceMatrix.array as Float32Array).set(b.im.instanceMatrix.array as Float32Array); this.group.remove(b.im); b.im.dispose(); }
      this.group.add(im);
      b = { im, n: b?.n ?? 0 };
      this.batches.set(model.id, b);
    }
    wheel.updateWorldMatrix(false, false);
    b.im.setMatrixAt(b.n++, wheel.matrixWorld);
  }

  end() {
    for (const b of this.batches.values()) {
      b.im.count = b.n;
      b.im.instanceMatrix.needsUpdate = true;
      if (b.n) b.im.computeBoundingSphere();
    }
  }
}
