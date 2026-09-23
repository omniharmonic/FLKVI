// OWNER: landmarks. Religious landmarks, modelled respectfully and plainly (no interiors, no signage);
// their registry entries are flagged `sensitive` (no camera targets / spawns nearby, consistent with the
// compiler's sensitive flag on religious buildings).
//   • St. Louis Cathedral, New Orleans (1794/1850): white stucco, three slate spires, faces Jackson Square.
//   • Mission Dolores (Misión San Francisco de Asís, 1791): whitewashed adobe, four-column facade, bells.
//   • Mission Dolores Basilica (1918/1926): Churrigueresque facade with twin bell towers.
import * as THREE from 'three';
import { Kit, archWall, pediment, curvedGable, rect } from '../kit';
import { stoneMat, flatMat, lampMat } from '../materials';
import type { LandmarkCtx } from '../registry';

/** Gable roof prism over a rectangle (ridge along Z), eaves at y, ridge at y + h. */
function gableZ(kit: Kit, key: string, cx: number, cz: number, w: number, d: number, y: number, h: number, o = {}) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.lineTo(-w / 2, 0);
  kit.prismZ(key, s, d, cx, y, cz, o);
}

/** Hexagonal / square spire. */
function spire(kit: Kit, key: string, x: number, y: number, z: number, r: number, h: number, sides: number) {
  kit.put(key, new THREE.ConeGeometry(r, h, sides, 1), x, y + h / 2, z, [0, sides === 4 ? Math.PI / 4 : 0, 0]);
}

function cross(kit: Kit, key: string, x: number, y: number, z: number, s: number) {
  kit.box(key, x, y, z, 0.12 * s, 1.6 * s, 0.12 * s, { detail: true });
  kit.box(key, x, y + 0.95 * s, z, 0.8 * s, 0.12 * s, 0.12 * s, { detail: true });
}

// ------------------------------------------------------------------------------------------------
export function stLouisCathedral(ctx: LandmarkCtx) {
  const kit = new Kit({
    wall: stoneMat('stucco', { tint: '#f4f1ea', uvScale: 0.7 }, { color: '#fff3e0', strength: 0.75, falloff: 22, top: 0.45 }),
    trim: stoneMat('plaster', { tint: '#fbfaf6' }, { color: '#fff3e0', strength: 0.75, falloff: 22, top: 0.45 }),
    slate: stoneMat('roof-slate', { tint: '#7c8288' }, { color: '#dfe6ff', strength: 0.35, falloff: 60, top: 0.7 }),
    door: flatMat('#3b2a1f', 0.7, 0),
    glass: lampMat('#2a2d33', '#ffc98a', 0, 0.27, ctx.lamps, 0.12, 0.7),
    clock: lampMat('#f4efe2', '#fff4da', 0, 0.8, ctx.lamps, 0.5),
    iron: flatMat('#1f1f1f', 0.5, 0.7),
  });
  const W = Math.max(22, Math.min(ctx.W, 34)), D = Math.max(40, Math.min(ctx.D, 70));
  const fz = D / 2; // front face (Jackson Square)
  // nave + slate gable roof
  const nw = W * 0.78;
  kit.extrude('wall', rect(0, -2, nw, D - 4), -1.5, 15, { collide: true });
  gableZ(kit, 'slate', 0, -3.5, nw + 1, D - 7, 15, 7);
  // buttress pilasters along the nave
  for (let z = -D / 2 + 4; z < fz - 8; z += 5.5) for (const s of [-1, 1]) {
    kit.box('trim', s * (nw / 2 + 0.2), -1, z, 0.6, 15.8, 0.9, { detail: true });
    kit.box('glass', s * (nw / 2 + 0.02), 5, z + 2.75, 0.1, 6.5, 1.8, { noShadow: true, detail: true });
  }
  // two-story facade block
  const fd = 7;
  kit.extrude('wall', rect(0, fz - fd / 2, W, fd), -1.5, 18.5, { collide: true });
  kit.box('trim', 0, 9.2, fz + 0.1, W + 0.4, 0.9, 0.6); // entablature between stories
  kit.box('trim', 0, 17.7, fz + 0.1, W + 0.4, 0.8, 0.6);
  // paired columns on both stories
  for (const k of [-3, -2, -1, 1, 2, 3]) {
    const x = k * (W / 7.4) + Math.sign(k) * 0.9 * (Math.abs(k) === 1 ? 0 : 0);
    kit.cyl('trim', x, 0, fz + 0.55, 0.42, 0.46, 9.2, 12, { detail: false });
    kit.cyl('trim', x, 10.1, fz + 0.45, 0.34, 0.38, 7.6, 12, { detail: true });
  }
  // three arched portals (central larger) + upper arched windows
  for (const [x, w, h] of [[0, 3.4, 6.6], [-W / 3.7, 2.4, 5.2], [W / 3.7, 2.4, 5.2]] as [number, number, number][]) {
    kit.box('door', x, 0, fz + 0.02, w, h - w / 2, 0.1);
    kit.put('door', new THREE.CylinderGeometry(w / 2, w / 2, 0.1, 16, 1, false, Math.PI / 2, Math.PI), x, h - w / 2, fz + 0.02, [Math.PI / 2, 0, 0]);
    kit.prismZ('trim', archWall(w + 0.9, h + 0.5, w, h - w / 2), 0.25, x, 0, fz + 0.12, { detail: true });
    kit.box('glass', x, 11.2, fz + 0.03, w * 0.6, 4.2, 0.1, { noShadow: true });
  }
  // side towers (square base → hexagonal belfry → slate spire)
  for (const s of [-1, 1]) {
    const tx = s * (W / 2 - 2.6), tz = fz - 2.6;
    kit.box('wall', tx, 18.5, tz, 5.2, 5.5, 5.2, { collide: true });
    kit.box('trim', tx, 23.9, tz, 5.6, 0.5, 5.6);
    kit.cyl('wall', tx, 24.4, tz, 2.3, 2.3, 4.2, 6);
    kit.cyl('trim', tx, 28.6, tz, 2.6, 2.6, 0.45, 6);
    spire(kit, 'slate', tx, 29, tz, 2.4, 8.5, 6);
    cross(kit, 'iron', tx, 37.5, tz, 1);
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + Math.PI / 6; kit.box('door', tx + Math.sin(a) * 2.1, 25.2, tz + Math.cos(a) * 2.1, 0.9, 2.4, 0.2, { detail: true }, a); }
  }
  // central tower: pedimented clock stage, open belfry, tall slender spire
  const cz = fz - 3.2;
  kit.prismZ('trim', pediment(W * 0.44, 3.2), 1.2, 0, 18.5, fz - 0.3);
  kit.box('wall', 0, 18.5, cz, 6.4, 7.3, 6.4, { collide: true });
  kit.put('clock', new THREE.CylinderGeometry(1.25, 1.25, 0.12, 28), 0, 23.4, cz + 3.26, [Math.PI / 2, 0, 0]);
  kit.put('iron', new THREE.TorusGeometry(1.3, 0.1, 6, 28), 0, 23.4, cz + 3.33, [0, 0, 0], { detail: true });
  kit.box('iron', 0, 23.35, cz + 3.37, 0.1, 0.9, 0.04, { detail: true });
  kit.box('trim', 0, 25.8, cz, 7, 0.6, 7);
  kit.cyl('wall', 0, 26.4, cz, 2.9, 3.1, 5, 8);
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; kit.box('door', Math.sin(a) * 2.8, 27.2, cz + Math.cos(a) * 2.8, 1.1, 3, 0.25, { detail: true }, a); }
  kit.cyl('trim', 0, 31.4, cz, 3.3, 3.3, 0.5, 8);
  spire(kit, 'slate', 0, 31.9, cz, 2.8, 14, 8);
  cross(kit, 'iron', 0, 45.9, cz, 1.3);
  return { kit };
}

// ------------------------------------------------------------------------------------------------
export function missionDolores(ctx: LandmarkCtx) {
  const kit = new Kit({
    adobe: stoneMat('stucco', { tint: '#f2eee4', uvScale: 0.6 }, { strength: 0.6, falloff: 9 }),
    tile: stoneMat('roof-clay-tile', { tint: '#b86a47' }, null),
    wood: stoneMat('wood-planks', { tint: '#6e4a31' }, null),
    bronze: flatMat('#5b4a2a', 0.45, 0.85),
    dark: flatMat('#2a2420', 0.8, 0),
  });
  // the adobe church: ~35 m × 9 m exterior, facade ~11 m wide, ridge ~11 m
  const L = Math.min(ctx.D, 38), w = 9.4;
  const fz = ctx.D / 2;
  const cz = fz - L / 2;
  kit.extrude('adobe', rect(0, cz, w, L), -1.5, 7.4, { collide: true });
  gableZ(kit, 'tile', 0, cz - 0.4, w + 1.4, L - 0.8, 7.2, 3.6);
  // facade: wall with low gable, projecting roof eave carried on the columns
  const facW = 11.2;
  kit.box('adobe', 0, -1.5, fz - 0.6, facW, 9.3, 1.2, { collide: true });
  kit.prismZ('adobe', pediment(facW, 2.6), 1.2, 0, 7.8, fz - 0.6);
  gableZ(kit, 'tile', 0, fz + 0.9, facW + 1.2, 3.0, 9.5, 2.4);
  kit.box('wood', 0, 9.2, fz + 0.9, facW + 0.6, 0.35, 3, { detail: true });
  // four columns lower story, four upper columns, balcony between
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * 2.6;
    kit.cyl('adobe', x, 0, fz + 0.35, 0.36, 0.4, 4.6, 12, { collide: true });
    kit.cyl('adobe', x, 5.2, fz + 0.35, 0.3, 0.33, 4.0, 12, { detail: true });
  }
  kit.box('adobe', 0, 4.6, fz + 0.3, facW - 0.4, 0.6, 1.3);
  kit.box('wood', 0, 5.2, fz + 0.95, facW - 1.0, 0.9, 0.08, { detail: true }); // balcony rail
  // doors and the three bells in niches on the upper facade
  kit.box('wood', 0, 0, fz + 0.02, 2.6, 3.6, 0.1);
  for (const x of [-2.6, 0, 2.6]) {
    kit.box('dark', x, 6.3, fz + 0.02, 1.4, 2.0, 0.12);
    kit.put('dark', new THREE.CylinderGeometry(0.7, 0.7, 0.12, 12, 1, false, Math.PI / 2, Math.PI), x, 8.3, fz + 0.02, [Math.PI / 2, 0, 0]);
    kit.lathe('bronze', x, 6.5, fz + 0.3, [[0.66, 0], [0.62, 0.15], [0.45, 0.9], [0.35, 1.35], [0.01, 1.4]], 14, { detail: true });
  }
  return { kit };
}

// ------------------------------------------------------------------------------------------------
export function missionBasilica(ctx: LandmarkCtx) {
  const kit = new Kit({
    wall: stoneMat('stucco', { tint: '#ece0c9', uvScale: 0.7 }, { strength: 0.65, falloff: 16, top: 0.4 }),
    orn: stoneMat('sandstone', { tint: '#e8d5b5' }, { strength: 0.65, falloff: 16, top: 0.4 }),
    tile: stoneMat('roof-clay-tile', { tint: '#b36746' }, null),
    dome: stoneMat('tiles-terracotta', { tint: '#c07a55' }, { strength: 0.3, falloff: 40, top: 0.6 }),
    door: flatMat('#3a2a1e', 0.7, 0),
    glass: lampMat('#2b2e33', '#ffc98a', 0, 0.27, ctx.lamps, 0.12, 0.7),
    iron: flatMat('#2a2a2a', 0.5, 0.7),
  });
  const W = Math.max(22, Math.min(ctx.W, 32)), D = Math.max(40, Math.min(ctx.D, 62));
  const fz = D / 2;
  const nw = W * 0.72;
  kit.extrude('wall', rect(0, -1, nw, D - 2), -1.5, 17, { collide: true });
  gableZ(kit, 'tile', 0, -2.5, nw + 1.2, D - 5, 17, 6.5);
  for (let z = -D / 2 + 4; z < fz - 9; z += 6) for (const s of [-1, 1]) kit.box('glass', s * (nw / 2 + 0.02), 6, z, 0.1, 7, 2, { noShadow: true, detail: true });
  // central Churrigueresque frontispiece
  const cw = W * 0.46;
  kit.box('wall', 0, -1.5, fz - 2.5, cw, 23.5, 5, { collide: true });
  kit.prismZ('orn', curvedGable(cw, 0.1, 5.5), 1.2, 0, 22, fz - 0.6);
  kit.prismZ('orn', archWall(cw * 0.55, 13, cw * 0.36, 9.5), 0.5, 0, 0, fz + 0.25, { detail: true });
  kit.box('door', 0, 0, fz + 0.02, cw * 0.36 - 0.2, 5.4, 0.1);
  kit.put('glass', new THREE.CylinderGeometry(2.2, 2.2, 0.1, 24), 0, 14.5, fz + 0.03, [Math.PI / 2, 0, 0], { noShadow: true });
  kit.put('orn', new THREE.TorusGeometry(2.3, 0.28, 8, 24), 0, 14.5, fz + 0.1, [0, 0, 0], { detail: true });
  for (const s of [-1, 1]) for (let k = 0; k < 2; k++) {
    kit.box('orn', s * (cw / 2 - 0.7 - k * 1.6), 0, fz + 0.25, 0.8, 20, 0.5, { detail: true });
  }
  kit.box('orn', 0, 11, fz + 0.3, cw + 0.4, 0.7, 0.8);
  // twin bell towers
  for (const s of [-1, 1]) {
    const tx = s * (W / 2 - 3.2), tz = fz - 3.2;
    kit.box('wall', tx, -1.5, tz, 6.4, 26.5, 6.4, { collide: true });
    kit.box('orn', tx, 25, tz, 7, 0.7, 7);
    kit.box('door', tx, 1, fz + 0.02, 1.8, 3.2, 0.1);
    kit.box('glass', tx, 10, fz + 0.02, 1.3, 3.2, 0.1, { noShadow: true });
    // belfry stage with arched openings
    kit.box('wall', tx, 25.7, tz, 5.4, 5.6, 5.4);
    for (const [dx, dz, ry] of [[0, 2.72, 0], [0, -2.72, 0], [2.72, 0, Math.PI / 2], [-2.72, 0, Math.PI / 2]] as [number, number, number][]) {
      kit.prismZ('door', archWall(1.8, 3.6, 1.79, 2.7), 0.1, tx + dx, 26.5, tz + dz, { detail: true }, ry);
    }
    kit.box('orn', tx, 31.3, tz, 6, 0.6, 6);
    kit.cyl('wall', tx, 31.9, tz, 2, 2.3, 2.2, 8);
    kit.lathe('dome', tx, 34.1, tz, [[2.4, 0], [2.3, 0.8], [1.8, 1.9], [0.9, 2.7], [0.01, 3]], 16);
    kit.cyl('orn', tx, 37.1, tz, 0.3, 0.4, 1.1, 8);
    cross(kit, 'iron', tx, 38.2, tz, 0.9);
  }
  return { kit };
}
