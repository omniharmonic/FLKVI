// OWNER: landmarks. Civic hero buildings: Boulder County Courthouse (1933 WPA Moderne, buff sandstone),
// Savannah City Hall (1906, gilded dome, 42.7 m), Phoenix Historic City Hall / Maricopa County
// Courthouse (1929 Spanish Colonial Revival), Texas State Capitol (distant backdrop, 92 m).
import * as THREE from 'three';
import type { Vec2 } from '../../../core/types';
import { Kit, eachBay, rect, pediment, polyEdges, archWall } from '../kit';
import { stoneMat, flatMat, lampMat } from '../materials';
import type { LandmarkCtx } from '../registry';

const glass = () => flatMat('#1d2327', 0.12, 0.6, null, { envMapIntensity: 1.2 });

// ------------------------------------------------------------------------------------------------
// Boulder County Courthouse — 1325 Pearl St. Buff sandstone, WPA Moderne: three-story wings with vertical
// window strips between pilasters and a five-story central tower block with stepped Art Deco top.
export function boulderCourthouse(ctx: LandmarkCtx) {
  const kit = new Kit({
    stone: stoneMat('sandstone', { tint: '#fff0d8', uvScale: 0.8 }, { strength: 0.6, falloff: 12 }),
    base: stoneMat('stone', { tint: '#b3a58f' }, { strength: 0.5 }),
    glass: glass(),
    spandrel: flatMat('#4a4038', 0.6, 0.3),
    lit: lampMat('#2a2c2c', '#ffcf8a', 0, 0.33, ctx.lamps, 0.12, 0.7),
    clock: lampMat('#efe8d6', '#fff2d0', 0, 0.8, ctx.lamps, 0.5),
    metal: flatMat('#2c2a27', 0.45, 0.8),
  });
  const poly = ctx.polys[0];
  const H = 13.2; // three stories
  kit.extrude('base', poly, -2, 1.1, { collide: true });
  kit.extrude('stone', poly, 1.1, H, { collide: true });
  // parapet coping (slightly proud)
  for (const e of polyEdges(poly, 0.5)) {
    const mx = (e.a[0] + e.b[0]) / 2, mz = (e.a[1] + e.b[1]) / 2;
    kit.box('stone', mx, H, mz, e.len + 0.3, 0.55, 0.5, {}, e.ry);
  }
  // window strips between sandstone pilasters, dark spandrels at floor lines
  eachBay(poly, 3.1, 1.6, 6, (x, z, ry, e) => {
    const ox = e.n[0] * 0.05, oz = e.n[1] * 0.05;
    kit.box('lit', x + ox * 0.5, 1.9, z + oz * 0.5, 1.5, 10.3, 0.12, { noShadow: true }, ry);
    for (const y of [5.1, 8.7]) kit.box('spandrel', x + ox, y, z + oz, 1.55, 0.75, 0.14, { detail: true }, ry);
    // pilaster to the right of the bay
    const px = x + e.dir[0] * 1.55 + e.n[0] * 0.18, pz = z + e.dir[1] * 1.55 + e.n[1] * 0.18;
    kit.box('stone', px, 1.1, pz, 0.62, H - 0.4, 0.36, { detail: true }, ry);
  });
  // central tower block (front-center), stepped top
  const W = ctx.W, D = ctx.D;
  const tw = Math.min(14, W * 0.42), td = Math.min(13, D * 0.45), tz = D * 0.5 - td / 2 - 2.2;
  kit.box('stone', 0, H, tz, tw, 8.6, td, { collide: true });
  kit.box('stone', 0, H + 8.6, tz, tw - 1.6, 1.6, td - 1.6);
  kit.box('stone', 0, H + 10.2, tz, tw - 3.4, 1.1, td - 3.4);
  kit.box('base', 0, H + 11.3, tz, tw - 4.2, 0.35, td - 4.2);
  // tower vertical window strips (front + back + sides) and sandstone fins; clock above the center strip
  const cf = tz + td / 2;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * (tw / 3.4);
      const hWin = i === 1 && side > 0 ? 4.0 : 6.3;
      kit.box('lit', x, H + 0.8, tz + side * (td / 2 + 0.02), 1.3, hWin, 0.1, { noShadow: true });
    }
    for (const fx of [-1.5, -0.5, 0.5, 1.5]) kit.box('stone', fx * (tw / 3.4), H - 0.2, tz + side * (td / 2 + 0.15), 0.5, 9.2, 0.3, { detail: true });
    kit.box('lit', side * (tw / 2 + 0.02), H + 0.8, tz, 0.1, 6.3, 1.4, { noShadow: true });
  }
  const cy = H + 6.4;
  kit.put('clock', new THREE.CylinderGeometry(1.2, 1.2, 0.14, 32), 0, cy, cf + 0.07, [Math.PI / 2, 0, 0]);
  kit.put('metal', new THREE.TorusGeometry(1.25, 0.09, 6, 32), 0, cy, cf + 0.12, [0, 0, 0], { detail: true });
  kit.box('metal', 0, cy - 0.05, cf + 0.17, 0.1, 0.85, 0.04, { detail: true });
  kit.put('metal', new THREE.BoxGeometry(0.09, 0.6, 0.04), 0.26, cy + 0.15, cf + 0.19, [0, 0, -Math.PI / 3], { detail: true });
  // entrance: recessed bronze doors under a stone surround + steps
  const fz = D / 2;
  kit.box('base', 0, 1.1, fz - 0.4, 5.4, 4.6, 1.0, { detail: true });
  kit.box('metal', 0, 1.1, fz + 0.12, 3.4, 3.6, 0.1);
  kit.box('lit', 0, 4.8, fz + 0.12, 3.4, 0.6, 0.1, { noShadow: true });
  for (let s = 0; s < 4; s++) { const d = (4 - s) * 0.45; kit.box('base', 0, -0.6, fz + d / 2, 7 - s * 0.4, 0.6 + 0.28 * (s + 1), d, { collide: true }); }
  // flagpole on the lawn toward Pearl Street
  const g0 = ctx.ground(0, fz + 12);
  kit.cyl('metal', 5, g0, fz + 12, 0.05, 0.1, 15, 8, { collide: false });
  kit.put('metal', new THREE.SphereGeometry(0.16, 8, 6), 5, g0 + 15.1, fz + 12, [0, 0, 0], { detail: true });
  return { kit };
}

// ------------------------------------------------------------------------------------------------
// Savannah City Hall — 2 E Bay St (1906). Four-story Renaissance Revival block of pale granite/limestone
// with a rusticated base, columned central bay facing Bull St, and a gilded (23k gold leaf) dome to 42.7 m.
export function savannahCityHall(ctx: LandmarkCtx) {
  const kit = new Kit({
    stone: stoneMat('plaster', { tint: '#e4dfd4', uvScale: 0.7 }, { strength: 0.55, falloff: 16 }),
    base: stoneMat('concrete-precast', { tint: '#c9c2b4', uvScale: 0.5 }, { strength: 0.55 }),
    gold: flatMat('#e7b454', 0.26, 1, { color: '#ffd9a0', strength: 0.55, falloff: 30, top: 0.6 }, { envMapIntensity: 1.4 }),
    copper: flatMat('#6f9c86', 0.55, 0.5),
    lit: lampMat('#23282b', '#ffd49a', 0, 0.36, ctx.lamps, 0.12, 0.7),
    dark: flatMat('#2a2724', 0.7, 0.1),
  });
  const W = Math.min(ctx.W, 34), D = Math.min(ctx.D, 34);
  const poly = rect(0, 0, W, D);
  kit.extrude('base', poly, -1.5, 5.2, { collide: true });
  kit.extrude('stone', rect(0, 0, W - 0.3, D - 0.3), 5.2, 19.6, { collide: true });
  // rustication grooves on the base
  for (let y = 0.8; y < 5; y += 0.9) kit.extrude('dark', rect(0, 0, W + 0.02, D + 0.02), y, y + 0.06, { detail: true, cap: false });
  // belt course, main cornice, balustrade
  kit.extrude('stone', rect(0, 0, W + 0.5, D + 0.5), 5.2, 5.7, {});
  kit.extrude('stone', rect(0, 0, W + 1.1, D + 1.1), 19.6, 20.5, {});
  kit.extrude('stone', rect(0, 0, W - 0.2, D - 0.2), 20.5, 21.6, { cap: true });
  // windows: arched on the base, rectangular above
  eachBay(poly, 3.6, 2.2, 8, (x, z, ry, e, i, n) => {
    const center = Math.abs(i - (n - 1) / 2) < 0.6 && e.n[1] > 0.7;
    if (!center) kit.box('lit', x, 1.2, z, 1.4, 2.9, 0.14, { noShadow: true }, ry);
    for (const [y, h] of [[6.6, 2.8], [10.4, 2.8], [14.2, 2.8], [17.6, 1.4]]) {
      kit.box('lit', x, y, z, 1.35, h, 0.12, { noShadow: true }, ry);
      kit.box('stone', x + e.n[0] * 0.12, y + h, z + e.n[1] * 0.12, 1.9, 0.3, 0.3, { detail: true }, ry);
    }
  });
  // front (Bull St) central bay: arched entrance + four-column screen over floors 2-3 + pediment
  const fz = D / 2;
  kit.prismZ('base', archWall(6, 5.2, 3, 2.6), 0.8, 0, 0, fz + 0.35, { detail: true });
  kit.box('dark', 0, 0, fz - 0.05, 3, 4, 0.2);
  for (let k = 0; k < 4; k++) {
    const x = (k - 1.5) * 2.4;
    kit.cyl('stone', x, 5.7, fz + 1.1, 0.42, 0.46, 9.3, 14, { detail: false });
    kit.box('stone', x, 15, fz + 1.1, 1.1, 0.5, 1.1, { detail: true });
  }
  kit.box('stone', 0, 15.5, fz + 0.6, 9.8, 1.2, 1.4);
  kit.prismZ('stone', pediment(10.6, 2.2), 1.3, 0, 16.7, fz + 0.6);
  // drum, colonnade, gilded dome, lantern
  const r = Math.min(W, D) * 0.2 + 0.8; // ≈ 7 m
  kit.cyl('stone', 0, 21.6, 0, r + 1.2, r + 1.2, 1.4, 32);
  kit.cyl('stone', 0, 23, 0, r - 0.4, r - 0.4, 6.2, 32, { collide: true });
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    kit.cyl('stone', Math.sin(a) * (r + 0.35), 23, Math.cos(a) * (r + 0.35), 0.28, 0.3, 5.6, 8, { detail: true });
    if (k % 2 === 0) kit.box('lit', Math.sin(a) * (r - 0.35), 24, Math.cos(a) * (r - 0.35), 1.1, 3.4, 0.2, { noShadow: true, detail: true }, a);
  }
  kit.cyl('stone', 0, 28.6, 0, r + 0.9, r + 0.9, 0.9, 32);
  const prof: [number, number][] = [];
  for (let i = 0; i <= 12; i++) { const t = (i / 12) * (Math.PI / 2); prof.push([Math.max(0.01, Math.cos(t) * r), Math.sin(t) * r * 1.22]); }
  kit.lathe('gold', 0, 29.5, 0, prof, 40);
  // dome ribs
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const rib = new THREE.TorusGeometry(r, 0.12, 4, 16, Math.PI / 2);
    rib.scale(1, 1.22, 1);
    kit.put('gold', rib, 0, 29.5, 0, [0, a, 0], { detail: true });
  }
  kit.cyl('stone', 0, 29.5 + r * 1.22 - 0.3, 0, 1.4, 1.6, 3.2, 12);
  kit.lathe('gold', 0, 29.5 + r * 1.22 + 2.9, 0, [[1.7, 0], [1.5, 0.6], [0.8, 1.3], [0.2, 1.8], [0.01, 2.0]], 16);
  kit.cyl('gold', 0, 29.5 + r * 1.22 + 4.9, 0, 0.05, 0.12, 1.3, 6, { detail: true });
  return { kit };
}

// ------------------------------------------------------------------------------------------------
// Phoenix Historic City Hall & Maricopa County Courthouse (1929): extruded from its real OSM parts, cream
// terracotta/stucco walls, arched upper windows, clay-tile hip roof over the central courthouse block.
export function phoenixCityHall(ctx: LandmarkCtx) {
  const kit = new Kit({
    wall: stoneMat('stucco', { tint: '#e3c9a6', uvScale: 0.8 }, { strength: 0.55, falloff: 14 }),
    trim: stoneMat('sandstone', { tint: '#d9b48a' }, { strength: 0.5 }),
    tile: stoneMat('roof-clay-tile', { tint: '#c2714e' }, null),
    lit: lampMat('#262a2c', '#ffcf90', 0, 0.33, ctx.lamps, 0.12, 0.7),
    dark: flatMat('#35302a', 0.6, 0.2),
  });
  const hs = ctx.heights ?? [];
  ctx.polys.forEach((poly, k) => {
    const h = hs[k] ?? 20;
    const roofed = h > 26;
    kit.extrude('trim', poly, -1.5, 1.4, { collide: true });
    kit.extrude('wall', poly, 1.4, h, { collide: true });
    for (const e of polyEdges(poly, 0.5)) {
      const mx = (e.a[0] + e.b[0]) / 2, mz = (e.a[1] + e.b[1]) / 2;
      kit.box('trim', mx + e.n[0] * 0.15, h - 1.1, mz + e.n[1] * 0.15, e.len + 0.3, 0.7, 0.5, { detail: true }, e.ry);
      kit.box('trim', mx, h, mz, e.len + 0.2, 0.5, 0.35, {}, e.ry);
      kit.box('trim', mx + e.n[0] * 0.1, 4.6, mz + e.n[1] * 0.1, e.len + 0.2, 0.35, 0.3, { detail: true }, e.ry);
    }
    const floors = Math.max(3, Math.round((h - 1.5) / 3.9));
    eachBay(poly, 3.3, 1.6, 7, (x, z, ry, e) => {
      for (let f = 0; f < floors; f++) {
        const y = 1.9 + f * ((h - 2.8) / floors);
        const top = f === floors - 1;
        kit.box('lit', x, y, z, 1.25, top ? 2.2 : 2.3, 0.12, { noShadow: true }, ry);
        if (top) kit.put('lit', new THREE.CylinderGeometry(0.625, 0.625, 0.12, 12, 1, false, Math.PI / 2, Math.PI), x, y + 2.2, z, [Math.PI / 2, ry, 0], { noShadow: true, detail: true });
        else kit.box('trim', x + e.n[0] * 0.1, y - 0.25, z + e.n[1] * 0.1, 1.6, 0.22, 0.25, { detail: true }, ry);
      }
    });
    if (roofed) {
      // low hip roof over the central block (pyramid scaled to the block's extents)
      const xs = poly.map((p) => p[0]), zs = poly.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
      const sx = Math.max(...xs) - Math.min(...xs), sz = Math.max(...zs) - Math.min(...zs);
      const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
      g.rotateY(Math.PI / 4);
      kit.put('tile', g, cx, h + 0.5 + 2.1, cz, [0, 0, 0], {}, [sx + 1.2, 4.2, sz + 1.2]);
    }
  });
  // entrance arches on the two longest outward edges of the main part
  const main = ctx.polys[0];
  const long = polyEdges(main, 12).sort((a, b) => b.len - a.len).slice(0, 2);
  for (const e of long) {
    const mx = (e.a[0] + e.b[0]) / 2 + e.n[0] * 0.3, mz = (e.a[1] + e.b[1]) / 2 + e.n[1] * 0.3;
    for (const o of [-3.2, 0, 3.2]) {
      const x = mx + e.dir[0] * o, z = mz + e.dir[1] * o;
      kit.box('dark', x, 0, z, 2.2, 3.4, 0.3, {}, e.ry);
      kit.put('dark', new THREE.CylinderGeometry(1.1, 1.1, 0.3, 12, 1, false, Math.PI / 2, Math.PI), x, 3.4, z, [Math.PI / 2, e.ry, 0], { detail: true });
      kit.box('trim', x, 0, z, 2.9, 4.9, 0.2, { detail: true }, e.ry);
    }
  }
  return { kit };
}

// ------------------------------------------------------------------------------------------------
// Texas State Capitol (1888), ~2.9 km north up Congress Ave from SoCo: Sunset Red granite, 92 m to the
// Goddess of Liberty. Built as a distant backdrop (no collider) facing south down Congress Avenue.
export function texasCapitol(ctx: LandmarkCtx) {
  const kit = new Kit({
    granite: stoneMat('stone', { tint: '#d8a790', uvScale: 0.25 }, { strength: 0.35, falloff: 40, top: 0.5 }),
    dome: flatMat('#e5d9c3', 0.6, 0.1, { color: '#fff1dc', strength: 1.1, falloff: 200, top: 1 }),
    roof: flatMat('#6f7a74', 0.7, 0.3),
    lit: lampMat('#2d2f30', '#ffd9a0', 0, 0.3, ctx.lamps, 0.12, 0.7),
  });
  const g = (x: number, z: number) => Math.min(0, ctx.ground(x, z));
  const y0 = Math.min(g(0, 0), g(-80, 0), g(80, 0)) - 2;
  // center block + two long wings (E/W), pavilions at the wing ends
  kit.box('granite', 0, y0, 0, 62, 28 - y0, 58);
  for (const s of [-1, 1]) {
    kit.box('granite', s * 55, y0, 0, 50, 25 - y0, 44);
    kit.box('granite', s * 81, y0, 0, 14, 27 - y0, 52);
    kit.box('roof', s * 55, 25, 0, 49, 3, 40);
    for (let i = 0; i < 9; i++) for (let f = 0; f < 3; f++) kit.box('lit', s * (34 + i * 5), 4 + f * 7, 22.05, 1.6, 3.6, 0.2, { noShadow: true });
  }
  // south portico + pediment
  kit.box('granite', 0, y0, 32, 30, 30 - y0, 8);
  kit.prismZ('granite', pediment(31, 6), 8, 0, 30, 32);
  for (let k = 0; k < 6; k++) kit.cyl('granite', (k - 2.5) * 5, 8, 36.5, 0.9, 1, 20, 10);
  // drum base, drum with colonnade, dome, lantern, statue
  kit.cyl('granite', 0, 28, 0, 20, 20, 8, 32);
  kit.cyl('dome', 0, 36, 0, 15.5, 15.5, 17, 40);
  for (let k = 0; k < 24; k++) { const a = (k / 24) * Math.PI * 2; kit.cyl('dome', Math.sin(a) * 16.4, 36, Math.cos(a) * 16.4, 0.6, 0.6, 14, 8); }
  kit.cyl('dome', 0, 50, 0, 17, 17, 1.6, 40);
  const prof: [number, number][] = [];
  for (let i = 0; i <= 14; i++) { const t = (i / 14) * (Math.PI / 2); prof.push([Math.max(0.01, Math.cos(t) * 15.5), Math.sin(t) * 19]); }
  kit.lathe('dome', 0, 51.6, 0, prof, 40);
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; kit.box('lit', Math.sin(a) * 15.2, 38, Math.cos(a) * 15.2, 2.2, 8, 0.4, { noShadow: true }, a); }
  kit.cyl('dome', 0, 69, 0, 3.6, 3.6, 9, 16);
  kit.lathe('dome', 0, 78, 0, [[4.2, 0], [3.8, 1.2], [2.4, 3], [0.6, 4.2], [0.01, 4.4]], 16);
  kit.cyl('roof', 0, 82.4, 0, 0.5, 0.9, 5, 8);
  kit.put('roof', new THREE.SphereGeometry(1, 8, 6), 0, 88.5, 0, [0, 0, 0], {}, [0.9, 2.1, 0.9]);
  kit.cyl('lit', 0, 90.4, 0, 0.1, 0.4, 1.8, 6, { noShadow: true });
  return { kit };
}

export type { Vec2 };
