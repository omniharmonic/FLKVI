// Shared paving appearance across initial and streamed districts.
import * as THREE from 'three';
import { surfaceMaterial } from './materials';
import { markingWearTexture } from './textures';
export function roadMaterials():Record<string,THREE.Material> {
  const mats:Record<string,THREE.Material>={
    asphalt: surfaceMaterial('asphalt', { tint: new THREE.Color(2.1, 2.08, 2.05), roughness: 1, polygonOffset: -1, patch: { macro: 0.14, macroScale: 26, antiTile: true, tintVar: new THREE.Color(1.25, 1.24, 1.22), tintAmt: 0.5 } }),
    lot: surfaceMaterial('asphalt', { tint: new THREE.Color(2.3, 2.28, 2.25), roughness: 1, polygonOffset: -1, patch: { macro: 0.14, macroScale: 15, antiTile: true } }),
    sidewalk: surfaceMaterial('concrete', { tint: new THREE.Color(1.75, 1.7, 1.62), roughness: 1, patch: { joints: 1.52, macro: 0.07, macroScale: 12, antiTile: true } }),
    curb: surfaceMaterial('concrete', { tint: new THREE.Color(1.85, 1.82, 1.76), roughness: 1, patch: { macro: 0.06 } }),
    footway: surfaceMaterial('concrete', { tint: new THREE.Color(1.7, 1.66, 1.6), polygonOffset: -1, patch: { joints: 1.52, macro: 0.1, antiTile: true } }),
    gravel: surfaceMaterial('gravel', { polygonOffset: -1, patch: { macro: 0.12 } }),
    paving: surfaceMaterial('paving', { polygonOffset: -2, patch: { macro: 0.1, antiTile: true } }),
    bridgeRail: new THREE.MeshStandardMaterial({ color: 0x5a5f63, metalness: 0.6, roughness: 0.5, side: THREE.DoubleSide }),
  };
  const wear = markingWearTexture().clone();
  wear.repeat.set(1 / 4, 1 / 4); wear.needsUpdate = true;
  mats.marking = new THREE.MeshStandardMaterial({
    map: wear, vertexColors: true, transparent: true, depthWrite: false, roughness: 0.62,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  mats.marking.name = 'marking';

  return mats;
}
