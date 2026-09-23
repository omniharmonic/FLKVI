// Synthetic buildings covering every kit, roof type and facade material (dev only).
import type { Recipe, RecipeBuilding, StyleKit, RoofType, FacadeMaterial, RoofMaterial, BuildingUse, Era, Vec2 } from '../../../core/types';
import { hashString } from '../../../core/geo';

/** Rectangle whose edge 0 faces the street. facing 'S' → street at +z side (zFront), 'N' → street at −z side. */
function rect(x0: number, x1: number, zFront: number, depth: number, facing: 'S' | 'N'): Vec2[] {
  if (facing === 'S') {
    const z1 = zFront, z0 = zFront - depth;
    return [[x0, z1], [x1, z1], [x1, z0], [x0, z0]];
  }
  const z0 = zFront, z1 = zFront + depth;
  return [[x1, z0], [x0, z0], [x0, z1], [x1, z1]];
}

interface Spec {
  fp: Vec2[]; kit: StyleKit; h: number; levels: number; roof: RoofType; roofH?: number; mat: FacadeMaterial; color: string;
  roofMat?: RoofMaterial; roofColor?: string; use: BuildingUse; era: Era; storefront?: boolean; signage?: string; street?: number[]; holes?: Vec2[][];
}

let n = 0;
function mk(s: Spec): RecipeBuilding {
  const id = 'dev' + n++;
  return {
    id, footprint: s.fp, holes: s.holes, baseY: 0, height: s.h, roofHeight: s.roofH ?? 0, levels: s.levels,
    roof: { type: s.roof, material: s.roofMat ?? (s.roof === 'flat' ? 'membrane' : 'asphalt-shingle'), color: s.roofColor ?? (s.roof === 'flat' ? '#8d8d8a' : '#4d4c4a') },
    use: s.use, era: s.era, kit: s.kit, material: s.mat, color: s.color, seed: hashString(id), storefront: !!s.storefront,
    streetEdges: s.street ?? [0], signage: s.signage,
  };
}

export function testRecipe(): Recipe {
  n = 0;
  const B: RecipeBuilding[] = [];
  // --- Main street (north side, facing south onto a street at z = 0): continuous 1–4 story brick blocks
  const ms: [number, number, FacadeMaterial, string, string?][] = [
    [7.5, 2, 'brick-red', '#9a4a36', 'BOOKS'], [9, 3, 'brick-brown', '#6e4a3a', 'TAVERN'], [6.5, 1, 'brick-painted', '#d9d2c3', 'CAFE'],
    [12, 4, 'brick-red', '#a85a40', 'OUTFITTERS'], [8, 2, 'brick-tan', '#c4a07a', 'GALLERY'], [7, 2, 'stone', '#b3a996', 'JEWELRY'],
    [10, 3, 'sandstone', '#c79a7f', 'MERCANTILE'], [8.5, 2, 'brick-red', '#8e4a36', 'DINER'],
  ];
  let x = -60;
  for (const [w, lv, mat, col, sign] of ms) {
    const h = 4.4 + (lv - 1) * 3.8 + 1.2;
    B.push(mk({ fp: rect(x, x + w, -3, 24, 'S'), kit: 'main-street-block', h, levels: lv, roof: 'flat', mat, color: col, use: 'commercial', era: '1900-1939', storefront: true, signage: sign }));
    x += w;
  }
  // --- South side of main street: modern infill, podium, strip mall
  B.push(mk({ fp: rect(-60, -24, 21, 30, 'N'), kit: 'podium-mixed-use', h: 5 + 4 * 3.1 + 1.1, levels: 5, roof: 'flat', mat: 'stucco', color: '#d8d0c0', use: 'mixed-use', era: '2000+', storefront: true, signage: 'MARKET' }));
  B.push(mk({ fp: rect(-22, -8, 21, 16, 'N'), kit: 'modern-infill', h: 3.2 + 3.1 * 2 + 0.5, levels: 3, roof: 'flat', mat: 'metal-panel', color: '#4a4f55', use: 'mixed-use', era: '2000+', storefront: true, signage: 'COFFEE' }));
  B.push(mk({ fp: rect(-6, 34, 21, 20, 'N'), kit: 'strip-mall', h: 5.5, levels: 1, roof: 'flat', mat: 'stucco', color: '#cdbfa6', use: 'commercial', era: '1970-1999', storefront: true }));

  // --- Residential street (z = -60 street, houses north of it facing south)
  const houses: [StyleKit, number, number, number, RoofType, FacadeMaterial, string, Era, RoofMaterial?, string?][] = [
    ['craftsman', 10, 14, 1, 'gable', 'lap-siding', '#6f7d62', '1900-1939'],
    ['victorian', 9, 15, 2, 'hip', 'lap-siding', '#8a5a7a', 'pre-1900', 'slate', '#4a4f57'],
    ['ranch', 17, 10, 1, 'hip', 'brick-tan', '#bf9f78', '1940-1969'],
    ['contemporary-suburban', 14, 12, 2, 'gable', 'lap-siding', '#c9c4b5', '2000+'],
    ['colonial', 13, 9, 2, 'gable', 'lap-siding', '#e8e2d2', '1900-1939'],
    ['craftsman', 9, 13, 1, 'hip', 'wood-shingle', '#8a6b4c', '1900-1939'],
    ['victorian', 8, 14, 2, 'gambrel', 'lap-siding', '#5a7a8a', 'pre-1900'],
    ['mediterranean', 14, 12, 1, 'hip', 'stucco', '#e6d2b5', '1900-1939', 'clay-tile', '#b0583a'],
    ['pueblo', 13, 11, 1, 'flat', 'adobe', '#b98e66', '1900-1939', 'membrane'],
    ['modern-infill', 9, 14, 2, 'shed', 'board-batten', '#3a3a3a', '2000+', 'standing-seam', '#3d4247'],
    ['ranch', 15, 10, 1, 'gable', 'board-batten', '#7a8a7a', '1940-1969'],
  ];
  x = -80;
  for (const [kit, w, d, lv, roof, mat, col, era, rm, rc] of houses) {
    const h = lv === 1 ? 3.3 : 3.3 + 2.9 * (lv - 1);
    B.push(mk({ fp: rect(x, x + w, -66, d, 'S'), kit, h: h + (kit === 'victorian' ? 0.6 : 0), levels: lv, roof, mat, color: col, use: 'residential-single', era, roofMat: rm, roofColor: rc }));
    x += w + 6;
  }
  // L-shaped (non-convex) house with gable roof + a pyramid cottage
  B.push(mk({ fp: [[x, -66], [x + 14, -66], [x + 14, -74], [x + 7, -74], [x + 7, -80], [x, -80]], kit: 'craftsman', h: 3.4, levels: 1, roof: 'gable', mat: 'lap-siding', color: '#a39070', use: 'residential-single', era: '1900-1939' }));
  B.push(mk({ fp: rect(x + 20, x + 28, -66, 8, 'S'), kit: 'colonial', h: 3.2, levels: 1, roof: 'pyramid', mat: 'brick-red', color: '#9c4630', use: 'residential-single', era: '1900-1939' }));
  B.push(mk({ fp: rect(x + 34, x + 46, -66, 10, 'S'), kit: 'victorian', h: 6.4, levels: 2, roof: 'mansard', mat: 'brick-brown', color: '#6e4535', use: 'residential-single', era: 'pre-1900', roofMat: 'slate', roofColor: '#4a4f57' }));

  // --- Brownstone row (south side of residential street, facing north)
  x = -80;
  for (let i = 0; i < 6; i++) {
    B.push(mk({ fp: rect(x, x + 6, -52, 16, 'N'), kit: 'brownstone', h: 13.5, levels: 4, roof: 'flat', mat: 'sandstone', color: ['#7a5444', '#6e4a3a', '#8a5f4c'][i % 3], use: 'residential-multi', era: 'pre-1900' }));
    x += 6;
  }
  B.push(mk({ fp: rect(-40, -2, -52, 18, 'N'), kit: 'garden-apartments', h: 9, levels: 3, roof: 'hip', mat: 'brick-brown', color: '#7d5140', use: 'residential-multi', era: '1940-1969' }));
  B.push(mk({ fp: rect(4, 34, -52, 16, 'N'), kit: 'garden-apartments', h: 6.2, levels: 2, roof: 'flat', mat: 'stucco', color: '#e0d6c2', use: 'residential-multi', era: '1970-1999' }));

  // --- Downtown / civic / industrial cluster (east)
  B.push(mk({ fp: rect(60, 90, -3, 30, 'S'), kit: 'glass-tower', h: 5.5 + 3.9 * 17 + 1.5, levels: 18, roof: 'flat', mat: 'glass-curtain', color: '#4a5a66', use: 'office', era: '2000+' }));
  B.push(mk({ fp: rect(96, 122, -3, 22, 'S'), kit: 'curtain-wall-tower', h: 5.5 + 3.9 * 11 + 1.5, levels: 12, roof: 'flat', mat: 'glass-curtain', color: '#39434b', use: 'office', era: '1940-1969' }));
  B.push(mk({ fp: rect(128, 158, -3, 24, 'S'), kit: 'office-park', h: 4.2 + 3.9 * 3 + 1.2, levels: 4, roof: 'flat', mat: 'concrete', color: '#c9c3b6', use: 'office', era: '1970-1999' }));
  B.push(mk({ fp: rect(164, 184, -3, 20, 'S'), kit: 'masonry-tower', h: 5 + 3.7 * 9 + 1.2, levels: 10, roof: 'flat', mat: 'brick-tan', color: '#c4a47e', use: 'office', era: '1900-1939', storefront: true, signage: 'PHARMACY' }));
  B.push(mk({ fp: rect(190, 208, -3, 18, 'S'), kit: 'art-deco', h: 4.5 + 3.8 * 7 + 1.8, levels: 8, roof: 'flat', mat: 'stone', color: '#d2c8b4', use: 'office', era: '1900-1939' }));
  B.push(mk({ fp: rect(60, 100, 21, 36, 'N'), kit: 'civic', h: 4.8 + 4.4 + 1.2 + 1.0, levels: 2, roof: 'dome', mat: 'sandstone', color: '#d1a78c', use: 'civic', era: '1900-1939' }));
  B.push(mk({ fp: rect(106, 130, 21, 40, 'N'), kit: 'worship', h: 9, levels: 1, roof: 'gable', mat: 'stone', color: '#a9a39a', use: 'religious', era: 'pre-1900', roofMat: 'slate', roofColor: '#4a4f57' }));
  B.push(mk({ fp: rect(136, 176, 21, 30, 'N'), kit: 'parking-garage', h: 3.2 + 3 * 4 + 1.1, levels: 5, roof: 'flat', mat: 'concrete', color: '#b8b4ab', use: 'parking', era: '1970-1999' }));
  B.push(mk({ fp: rect(182, 222, 21, 30, 'N'), kit: 'school', h: 8.8, levels: 2, roof: 'flat', mat: 'brick-red', color: '#9c4630', use: 'school', era: '1940-1969' }));
  // industrial (further south, street at z=60)
  B.push(mk({ fp: rect(60, 96, 60, 30, 'S'), kit: 'brick-warehouse', h: 4.6 + 4.2 * 3 + 1, levels: 4, roof: 'flat', mat: 'brick-red', color: '#8a3b28', use: 'industrial', era: '1900-1939' }));
  B.push(mk({ fp: rect(102, 140, 60, 30, 'S'), kit: 'metal-shed', h: 7, levels: 1, roof: 'gable', mat: 'metal-panel', color: '#c9ccce', use: 'industrial', era: '1970-1999', roofMat: 'standing-seam', roofColor: '#8a9096' }));
  B.push(mk({ fp: rect(146, 206, 60, 50, 'S'), kit: 'big-box', h: 9, levels: 1, roof: 'flat', mat: 'concrete', color: '#cfc7b6', use: 'commercial', era: '1970-1999', storefront: true, signage: 'HARDWARE' }));
  B.push(mk({ fp: rect(212, 228, 60, 12, 'S'), kit: 'gas-station', h: 4.5, levels: 1, roof: 'flat', mat: 'stucco', color: '#e2ddd0', use: 'commercial', era: '1970-1999', storefront: true, signage: 'MARKET' }));
  // courtyard building (hole)
  B.push(mk({ fp: [[-60, 90], [-20, 90], [-20, 50], [-60, 50]], holes: [[[-50, 80], [-30, 80], [-30, 60], [-50, 60]]], kit: 'generic', h: 12.5, levels: 4, roof: 'flat', mat: 'brick-brown', color: '#7d5140', use: 'residential-multi', era: '1900-1939' }));
  // generic fallbacks
  B.push(mk({ fp: rect(-14, 6, 90, 16, 'S'), kit: 'generic', h: 7, levels: 2, roof: 'hip', mat: 'stucco', color: '#d6c8a8', use: 'residential-single', era: '1970-1999' }));
  B.push(mk({ fp: rect(12, 40, 90, 22, 'S'), kit: 'generic', h: 8, levels: 2, roof: 'flat', mat: 'concrete', color: '#bdb8ad', use: 'office', era: '1970-1999' }));
  B.push(mk({ fp: [[46, 90], [62, 84], [64, 70], [50, 64], [40, 76]], kit: 'generic', h: 6, levels: 2, roof: 'hip', mat: 'lap-siding', color: '#b8c0b0', use: 'residential-single', era: '1940-1969' }));

  const recipe: Recipe = {
    version: 1, name: 'buildings-dev', origin: { lat: 40.0176, lon: -105.2797 }, bounds: { minX: -200, minZ: -200, maxX: 300, maxZ: 200 },
    region: 'mountain-west', climate: 'cold', tier: 'S',
    terrain: { cols: 2, rows: 2, originX: -200, originZ: -200, cellSize: 500, heights: [0, 0, 0, 0] },
    roads: [], graph: { nodes: [], edges: [] }, buildings: B, areas: [], trees: [], props: [], cameras: [],
    spawn: { p: [0, 10], y: 0, heading: 0 }, attribution: [],
  };
  return recipe;
}
