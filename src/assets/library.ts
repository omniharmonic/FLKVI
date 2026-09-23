// OWNER: assets agent. Asset library contract — other modules depend on these signatures.
// Textures are CC0 PBR sets in public/assets/textures/<id>/{color,normal,rough,ao}.jpg with real-world size in the manifest.
import * as THREE from 'three';

export interface TextureSetInfo {
  id: string;
  /** Real-world size of one texture tile in meters (for world-space UVs). */
  sizeM: number;
  maps: { map?: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture; aoMap?: THREE.Texture; displacementMap?: THREE.Texture };
}

/** Known texture set ids (extend as assets are added). */
export type TextureId =
  | 'asphalt' | 'asphalt-worn' | 'concrete-sidewalk' | 'concrete' | 'curb' | 'grass' | 'dirt' | 'gravel'
  | 'brick-red' | 'brick-brown' | 'brick-tan' | 'brick-painted' | 'stucco' | 'lap-siding' | 'board-batten'
  | 'stone' | 'sandstone' | 'metal-panel' | 'adobe' | 'wood-shingle' | 'plaster'
  | 'roof-asphalt-shingle' | 'roof-clay-tile' | 'roof-standing-seam' | 'roof-slate' | 'roof-membrane' | 'roof-gravel'
  | 'paving' | 'cobble' | 'wood-planks' | 'rust-metal' | 'painted-metal' | 'bark' | 'water';

/** Load everything needed to start (called by world before building). */
export async function preloadLibrary(onProgress?: (f: number) => void): Promise<void> {
  onProgress?.(1);
}

/** Texture set by id, or null if unavailable (callers must fall back to flat color). */
export function textureSet(id: TextureId): TextureSetInfo | null {
  return null;
}

/**
 * Shared PBR material for a texture set. Callers must generate UVs in METERS; the material's
 * texture repeat is already scaled by 1/sizeM so UV (1,1) = 1 m. `tint` multiplies color.
 * Materials are cached per (id, tint) — do not mutate returned materials.
 */
export function pbrMaterial(id: TextureId, opts: { tint?: string; roughness?: number; metalness?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: opts.tint ?? '#999', roughness: opts.roughness ?? 0.9, metalness: opts.metalness ?? 0 });
}

/** Load a CC0 glTF model by manifest id (e.g. 'character-ped-1', 'car-sedan'). Returns a fresh clone. */
export async function loadModel(id: string): Promise<THREE.Group | null> {
  return null;
}

/** Equirect HDR environment for IBL/background by id (e.g. 'day', 'sunset', 'night'). */
export async function loadEnvironment(id: string): Promise<THREE.Texture | null> {
  return null;
}

/** URL of an audio asset by id, or null. */
export function soundUrl(id: string): string | null {
  return null;
}

export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}assets/${path}`;
}
