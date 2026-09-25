// Real CC0 Poly Haven street furniture, assembled/simplified offline (tools/build-street-kit.mjs).
// Three tiny GLBs and five PBR material sets are shared across every loaded district.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './library';

export type StreetProp = 'hydrant' | 'bench' | 'trash';
export interface StreetPart { geo: THREE.BufferGeometry; mat: string }
const models = new Map<StreetProp, { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[]>();
let pending: Promise<void> | undefined;

/** Initial loading-screen work only. A missing CDN asset never prevents entering the world. */
export function prepareStreetKit(): Promise<void> {
  if (pending) return pending;
  const loader = new GLTFLoader();
  const load = async (id: StreetProp) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const url = assetUrl(`models/street/${id}.glb`);
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${id}`);
      const data = await response.arrayBuffer();
      const gltf = await loader.parseAsync(data, url.slice(0, url.lastIndexOf('/') + 1));
      const parts: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }[] = [];
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material)) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.name = `street-${id}-${parts.length}`;
        material.envMapIntensity = 0.6;
        for (const texture of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
          if (!texture) continue;
          texture.anisotropy = 4;
        }
        const geometry = mesh.geometry;
        geometry.applyMatrix4(mesh.matrixWorld);
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        parts.push({ geometry, material });
      });
      if (parts.length) models.set(id, parts);
    } catch (error) {
      console.warn(`[assets] ${id} street model unavailable; using procedural kit`, error);
    } finally { clearTimeout(timer); }
  };
  // Texture requests in GLTFLoader do not support AbortSignal. Bound the loading-screen
  // wait as well as the mesh fetch; late completions are only used by future districts.
  const requests = Promise.all((['hydrant', 'bench', 'trash'] as const).map(load));
  pending = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 8000);
    void requests.finally(() => { clearTimeout(timer); resolve(); });
  });
  return pending;
}

/** Each district owns geometry/material clones. Texture images remain cache-shared,
 * and source geometry keeps its CPU data when rendered clones release upload arrays. */
export function streetKitParts(id: StreetProp, materials: Record<string, THREE.Material>): StreetPart[] | null {
  const source = models.get(id);
  if (!source) return null;
  return source.map((part, i) => {
    const key = `street-${id}-${i}`;
    materials[key] ??= part.material.clone();
    return { geo: part.geometry.clone(), mat: key };
  });
}
