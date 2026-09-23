// OWNER: buildings agent. Facade grammar + roofs + windows → merged, chunked meshes.
import * as THREE from 'three';
import type { Game } from '../../core/game';
import type { Progress } from '../../core/location';

export interface BuildingsResult {
  group: THREE.Group;
  /** 0 = day, 1 = full night: drives window emissive occupancy / signage glow. */
  setNightFactor(f: number): void;
  /** Optional per-frame update (e.g. LOD). */
  update?(dt: number, g: Game): void;
}

export async function buildBuildings(g: Game, onProgress: Progress): Promise<BuildingsResult> {
  const group = new THREE.Group();
  group.name = 'buildings';
  return { group, setNightFactor() {} };
}
