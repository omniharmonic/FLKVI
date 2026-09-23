// Shared 16-cell color palette for vehicle interiors and drivers: parts carry UVs pointing at a
// cell, so the whole cabin (and every driver) renders with one tiny texture / one material and
// merges with the other small parts in parked-car instancing.
import * as THREE from 'three';

export const PAL = {
  seatDark: 0, seatBeige: 1, seatGrey: 2, dash: 3, headliner: 4, carpet: 5, panel: 6, wheel: 7,
  skin1: 8, skin2: 9, skin3: 10, shirt1: 11, shirt2: 12, shirt3: 13, pants: 14, hair: 15,
  uniform: 11,
} as const;

const COLORS = [
  '#262628', '#9c8d77', '#505257', '#131416', '#8e8b85', '#1b1b1d', '#2a2b2e', '#0c0c0d',
  '#c29274', '#7d5236', '#dcb194', '#23324d', '#6e2626', '#cfcfca', '#20242b', '#18130f',
];

/** Point every vertex's UV at a palette cell. */
export function palUV(g: THREE.BufferGeometry, cell: number) {
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  const u = (cell + 0.5) / COLORS.length;
  for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

let tex: THREE.DataTexture | null = null;
export function paletteTexture() {
  if (tex) return tex;
  const data = new Uint8Array(COLORS.length * 4);
  COLORS.forEach((c, i) => {
    const h = new THREE.Color(c).getHex();
    data.set([(h >> 16) & 255, (h >> 8) & 255, h & 255, 255], i * 4);
  });
  tex = new THREE.DataTexture(data, COLORS.length, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
