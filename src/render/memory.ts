// Memory helpers (perf). Static city geometry is uploaded to the GPU once and never read back on the
// CPU, so its typed arrays can be dropped right after upload (three.js' documented onUpload pattern).
// That removes a second full copy of every building / road / terrain vertex from the JS heap.
//
//   releaseAfterUpload(obj)   every non-instanced Mesh under obj frees its vertex + index arrays once
//                             they reach the GPU. Bounding volumes are computed first (culling needs
//                             them). Do NOT use on geometry that is later read on the CPU (colliders,
//                             raycasts, morphing) or edited in place.
import * as THREE from 'three';

const EMPTY = new Float32Array(0);
function drop(this: THREE.BufferAttribute) {
  // keep a zero-length array of the same kind (some code checks `.array.constructor`)
  const C = this.array.constructor as unknown as { new (n: number): THREE.TypedArray };
  try { this.array = new C(0); } catch { this.array = EMPTY; }
}

const released = new WeakSet<THREE.BufferGeometry>();

export function releaseGeometryAfterUpload(geo: THREE.BufferGeometry) {
  if (released.has(geo)) return;
  released.add(geo);
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  if (!geo.boundingBox) geo.computeBoundingBox();
  for (const k in geo.attributes) {
    const a = geo.attributes[k] as THREE.BufferAttribute;
    if ((a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) continue;
    if (a.usage !== THREE.StaticDrawUsage) continue;
    a.onUpload(drop);
  }
  const idx = geo.index;
  if (idx) idx.onUpload(drop);
}

export function releaseAfterUpload(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (m.morphTargetInfluences) return;
    releaseGeometryAfterUpload(m.geometry);
    // alternate index buffers swapped in by LOD code (terrain)
    const lods = m.userData.lods as THREE.BufferAttribute[] | undefined;
    if (Array.isArray(lods)) for (const a of lods) if (a?.isBufferAttribute) a.onUpload(drop);
  });
}

/**
 * Upload every (non-instanced) mesh geometry under `root` to the GPU now, without drawing anything:
 * shadow-less, off-screen chunks would otherwise keep their CPU arrays until they first enter the view.
 * (three uploads geometry while projecting an object, before it checks material.visible.)
 */
export function uploadNow(renderer: THREE.WebGLRenderer, root: THREE.Object3D) {
  const scene = new THREE.Scene();
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (seen.has(m.geometry)) return;
    seen.add(m.geometry);
    const p = new THREE.Mesh(m.geometry, hidden);
    p.frustumCulled = false;
    p.matrixAutoUpdate = false;
    scene.add(p);
  });
  if (!seen.size) return;
  const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const prev = renderer.getRenderTarget();
  const cam = new THREE.OrthographicCamera();
  const shadowAuto = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
  } finally {
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadowAuto;
    rt.dispose();
    hidden.dispose();
    scene.clear();
  }
}
