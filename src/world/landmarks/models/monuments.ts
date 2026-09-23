// OWNER: landmarks. Monuments, sculpture, park features and backdrops:
//   • Washington Square Arch (1892, white marble, 23.5 m; opening 9.1 m × 14.3 m) + the park fountain
//   • Jackson Square iron fence + a generic rearing equestrian bronze on a granite pedestal
//   • "Cloud Gate"-style mirror sculpture (20.1 × 12.8 × 10 m, 3.7 m arch), live cube-map reflections
//   • Space Needle (184 m) as a distant backdrop for Capitol Hill
//   • Miami Beach candy-striped lifeguard tower + generic Art Deco neon "HOTEL" fins on Ocean Drive
import * as THREE from 'three';
import type { Vec2 } from '../../../core/types';
import type { Game } from '../../../core/game';
import { Kit, archWall, polyEdges, rect } from '../kit';
import { stoneMat, flatMat, lampMat, landmarkNight } from '../materials';
import type { LandmarkCtx } from '../registry';

// ------------------------------------------------------------------------------------------------
export function washingtonArch(ctx: LandmarkCtx) {
  const marble = { color: '#fff4e2', strength: 1.0, falloff: 16, top: 0.45 };
  const kit = new Kit({
    marble: stoneMat('plaster', { tint: '#f1ede4', roughness: 0.75 }, marble),
    relief: stoneMat('plaster', { tint: '#e6e1d6', roughness: 0.8, normalScale: 2 }, marble),
    granite: stoneMat('stone', { tint: '#a9a49b' }, { strength: 0.6 }),
  });
  const W = Math.max(17, Math.min(ctx.W, 21)), D = Math.max(6, Math.min(ctx.D, 9));
  const ow = 9.1, oh = 14.3, spring = oh - ow / 2;
  const pw = (W - ow) / 2, px = ow / 2 + pw / 2;
  // granite plinths under the piers + marble arch body with the opening cut out
  for (const s of [-1, 1]) kit.box('granite', s * px, -1.5, 0, pw + 0.5, 2.1, D + 0.5, { collide: true });
  kit.prismZ('marble', archWall(W, 17.4, ow, spring), D, 0, 0, 0, { collide: true });
  // impost bands on the piers, archivolt rings, keystones, spandrel reliefs
  for (const z of [-1, 1]) {
    for (const s of [-1, 1]) kit.box('marble', s * px, spring - 0.2, z * (D / 2 + 0.1), pw, 0.6, 0.3, { detail: true });
    kit.put('marble', new THREE.TorusGeometry(ow / 2 + 0.35, 0.3, 6, 28, Math.PI), 0, spring + 0.6, z * (D / 2 + 0.05), [0, 0, 0], { detail: true });
    kit.box('marble', 0, oh + 0.2, z * (D / 2 + 0.15), 1.1, 1.8, 0.4, { detail: true });
    for (const s of [-1, 1]) kit.box('relief', s * 3.6, 12.5, z * (D / 2 + 0.06), 3.6, 3.4, 0.2, { detail: true });
    // pier panels (lower) with rosette frames
    for (const s of [-1, 1]) kit.box('relief', s * px, 1.6, z * (D / 2 + 0.05), pw - 1.4, 6.5, 0.12, { detail: true });
  }
  // entablature, frieze, cornice, attic, top cornice
  kit.box('marble', 0, 18.0, 0, W + 0.4, 1.3, D + 0.4, { collide: true });
  kit.box('relief', 0, 18.2, 0, W + 0.5, 0.8, D + 0.5, { detail: true });
  kit.box('marble', 0, 19.3, 0, W + 0.9, 0.55, D + 0.9);
  kit.box('marble', 0, 19.85, 0, W - 0.3, 3.5, D - 0.3);
  kit.box('relief', 0, 20.5, D / 2 - 0.1, W - 4, 1.8, 0.3, { detail: true }); // inscription panel (blank)
  kit.box('marble', 0, 23.35, 0, W + 0.2, 0.55, D + 0.2);
  // statue groups against the north (front) face of the piers: pedestal + stylised standing figures
  for (const s of [-1, 1]) {
    const x = s * px, z = D / 2 + 1.1;
    kit.box('marble', x, 0.6, z, 3.3, 2.4, 1.8, { collide: true });
    kit.box('marble', x, 3.0, z, 3.6, 0.35, 2.0, { detail: true });
    kit.cyl('marble', x, 3.35, z, 0.55, 0.75, 2.6, 10, { detail: true });
    kit.cyl('marble', x, 5.95, z, 0.5, 0.45, 1.2, 10, { detail: true });
    kit.put('marble', new THREE.SphereGeometry(0.32, 10, 8), x, 7.5, z, [0, 0, 0], { detail: true });
    kit.cyl('marble', x - s * 1.05, 3.35, z - 0.2, 0.35, 0.45, 2.3, 8, { detail: true });
    kit.put('marble', new THREE.SphereGeometry(0.26, 8, 6), x - s * 1.05, 5.95, z - 0.2, [0, 0, 0], { detail: true });
    kit.cyl('marble', x + s * 1.05, 3.35, z - 0.2, 0.35, 0.45, 2.1, 8, { detail: true });
  }
  return { kit };
}

// ------------------------------------------------------------------------------------------------
const waterMat = () => new THREE.MeshStandardMaterial({ color: '#f4f8fb', roughness: 0.15, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide });

export function squareFountain(ctx: LandmarkCtx) {
  const kit = new Kit({
    granite: stoneMat('stone', { tint: '#b7b1a6' }, { strength: 0.4 }),
    water: waterMat(),
    lamp: lampMat('#d8dde0', '#ffffff', 0.0, 0.7, ctx.lamps, 0.2),
  });
  const poly = ctx.polys[0];
  const R = poly.reduce((s, p) => s + Math.hypot(p[0], p[1]), 0) / poly.length;
  const y = ctx.ground(R + 1, 0);
  // granite coping ring: outer wall up, top inward, inner wall down
  kit.lathe('granite', 0, y, 0, [[R + 0.55, -0.6], [R + 0.55, 0.42], [R + 0.45, 0.5], [R + 0.02, 0.5], [R - 0.05, 0.4], [R - 0.05, -0.9]], 72, { collide: true });
  // central jet + spray veil + ring of small jets
  kit.cyl('water', 0, y - 0.4, 0, 0.06, 0.32, 5.2, 10, { noShadow: true });
  kit.lathe('water', 0, y - 0.4, 0, [[2.6, 0], [2.2, 1.6], [1.4, 3.1], [0.5, 4.2], [0.05, 4.6]], 20, { noShadow: true });
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2, r = R * 0.55;
    kit.put('water', new THREE.ConeGeometry(0.22, 1.5, 6, 1, true), Math.sin(a) * r, y + 0.35, Math.cos(a) * r, [0, 0, Math.PI], { noShadow: true, detail: true });
    kit.put('water', new THREE.CylinderGeometry(0.03, 0.12, 1.6, 6, 1, true), Math.sin(a) * r, y + 0.2, Math.cos(a) * r, [0, 0, 0], { noShadow: true, detail: true });
  }
  // submerged lamps
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + 0.2; kit.cyl('lamp', Math.sin(a) * (R - 0.6), y - 0.45, Math.cos(a) * (R - 0.6), 0.18, 0.18, 0.08, 10, { noShadow: true, detail: true }); }
  return { kit };
}

// ------------------------------------------------------------------------------------------------
export function jacksonSquare(ctx: LandmarkCtx) {
  const kit = new Kit({
    iron: flatMat('#161616', 0.5, 0.75),
    granite: stoneMat('stone', { tint: '#b8b1a5' }, { strength: 0.5, falloff: 6 }),
    bronze: flatMat('#4a3d2a', 0.42, 0.85, { color: '#ffe0b0', strength: 0.5, falloff: 5, top: 0.4 }),
  });
  // iron fence along the square with gates at the middle of each long side
  const poly = ctx.polys[0];
  for (const e of polyEdges(poly, 2)) {
    const gate = e.len > 30 ? [e.len / 2 - 2, e.len / 2 + 2] : null;
    const runs: [number, number][] = gate ? [[0, gate[0]], [gate[1], e.len]] : [[0, e.len]];
    for (const [t0, t1] of runs) {
      const L = t1 - t0; if (L < 0.5) continue;
      const tm = (t0 + t1) / 2;
      const mx = e.a[0] + e.dir[0] * tm, mz = e.a[1] + e.dir[1] * tm;
      const gy = ctx.ground(mx, mz);
      for (const hy of [0.25, 1.85]) kit.box('iron', mx, gy + hy, mz, L, 0.07, 0.05, { collide: hy > 1 }, e.ry);
      kit.box('iron', mx, gy, mz, L, 1.95, 0.05, { colliderOnly: true }, e.ry); // solid collision between pickets
      for (let t = t0; t <= t1 + 1e-3; t += 2.6) kit.box('iron', e.a[0] + e.dir[0] * t, gy, e.a[1] + e.dir[1] * t, 0.14, 2.25, 0.14, {}, e.ry);
      for (let t = t0 + 0.12; t < t1; t += 0.2) {
        const x = e.a[0] + e.dir[0] * t, z = e.a[1] + e.dir[1] * t;
        kit.box('iron', x, gy + 0.05, z, 0.025, 2.0, 0.025, { detail: true }, e.ry);
      }
    }
    if (gate) for (const t of gate) kit.box('iron', e.a[0] + e.dir[0] * t, ctx.ground(e.a[0], e.a[1]), e.a[1] + e.dir[1] * t, 0.3, 2.6, 0.3, {}, e.ry);
  }
  // equestrian statue on the central circle, facing away from the cathedral
  const circ = ctx.recipe.areas.find((a) => a.id === 'r7037951-0');
  const cath = ctx.recipe.buildings.find((b) => b.id === 'w329364492');
  if (circ) {
    const c = circ.poly.reduce<Vec2>((s, q) => [s[0] + q[0] / circ.poly.length, s[1] + q[1] / circ.poly.length], [0, 0]);
    const [sx, sz] = ctx.toLocal(c[0], c[1]);
    let face = 0;
    if (cath) {
      const k = cath.footprint.reduce<Vec2>((s, q) => [s[0] + q[0] / cath.footprint.length, s[1] + q[1] / cath.footprint.length], [0, 0]);
      const [kx, kz] = ctx.toLocal(k[0], k[1]);
      face = Math.atan2(sx - kx, sz - kz);
    }
    equestrian(kit, sx, ctx.ground(sx, sz), sz, face);
  }
  return { kit };
}

/** Generic rearing horse + rider (no likeness), bronze on a granite pedestal. Faces +Z rotated by `face`. */
function equestrian(kit: Kit, x0: number, y0: number, z0: number, face: number) {
  const c = Math.cos(face), s = Math.sin(face);
  const P = (x: number, z: number): [number, number] => [x0 + x * c + z * s, z0 - x * s + z * c];
  const box = (key: string, x: number, y: number, z: number, w: number, h: number, d: number, o = {}) => { const [px, pz] = P(x, z); kit.box(key, px, y0 + y, pz, w, h, d, o, face); };
  const limb = (key: string, a: [number, number, number], b: [number, number, number], r0: number, r1: number) => {
    const va = new THREE.Vector3(a[0], a[1], a[2]), vb = new THREE.Vector3(b[0], b[1], b[2]);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(r1, r0, len, 8, 1);
    const dir = vb.clone().sub(va).normalize();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    const m = va.add(vb).multiplyScalar(0.5);
    g.rotateY(face);
    const [px, pz] = P(m.x, m.z);
    g.translate(px, y0 + m.y, pz);
    kit.add(key, g, { detail: false });
  };
  const blob = (key: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, rx: number) => {
    const g = new THREE.SphereGeometry(1, 14, 10);
    g.scale(sx, sy, sz); g.rotateX(rx); g.rotateY(face);
    const [px, pz] = P(x, z);
    g.translate(px, y0 + y, pz);
    kit.add(key, g);
  };
  // pedestal
  box('granite', 0, -0.8, 0, 5.6, 1.2, 3.8, { collide: true });
  box('granite', 0, 0.4, 0, 4.6, 3.4, 2.8, { collide: true });
  box('granite', 0, 3.8, 0, 5.0, 0.45, 3.2);
  const t = 4.25; // top of pedestal
  // horse rearing on hind legs
  blob('bronze', 0, t + 2.0, -0.1, 0.5, 0.55, 1.3, -0.62);
  limb('bronze', [0.22, t, -0.55], [0.22, t + 1.55, -0.95], 0.11, 0.16);
  limb('bronze', [-0.22, t, -0.3], [-0.22, t + 1.55, -0.9], 0.11, 0.16);
  limb('bronze', [0, t + 1.5, -1.1], [0, t + 0.3, -1.75], 0.14, 0.05); // tail to the plinth (third support)
  limb('bronze', [0.22, t + 2.45, 0.75], [0.22, t + 2.05, 1.35], 0.1, 0.08);
  limb('bronze', [0.22, t + 2.05, 1.35], [0.22, t + 1.55, 1.3], 0.08, 0.07);
  limb('bronze', [-0.22, t + 2.5, 0.7], [-0.22, t + 2.3, 1.35], 0.1, 0.08);
  limb('bronze', [-0.22, t + 2.3, 1.35], [-0.22, t + 1.85, 1.45], 0.08, 0.07);
  limb('bronze', [0, t + 2.7, 0.75], [0, t + 3.55, 1.1], 0.3, 0.2); // neck
  blob('bronze', 0, t + 3.65, 1.35, 0.16, 0.2, 0.42, 0.7); // head
  // rider
  limb('bronze', [0, t + 2.55, -0.05], [0, t + 3.5, -0.2], 0.24, 0.2);
  blob('bronze', 0, t + 3.72, -0.22, 0.14, 0.16, 0.14, 0);
  limb('bronze', [0.25, t + 3.35, -0.15], [0.45, t + 4.05, 0.05], 0.06, 0.05); // raised arm with hat
  blob('bronze', 0.48, t + 4.1, 0.06, 0.2, 0.05, 0.2, 0);
  limb('bronze', [0.22, t + 2.55, 0], [0.3, t + 1.95, 0.25], 0.08, 0.07);
  limb('bronze', [-0.22, t + 2.55, 0], [-0.3, t + 1.95, 0.25], 0.08, 0.07);
}

// ------------------------------------------------------------------------------------------------
export function cloudGate(ctx: LandmarkCtx) {
  const cube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const mirror = new THREE.MeshStandardMaterial({ color: '#e9ecef', metalness: 1, roughness: 0.035, envMap: cube.texture, envMapIntensity: 1 });
  mirror.name = 'landmark:mirror';
  const kit = new Kit({ mirror, granite: stoneMat('stone', { tint: '#9d9993' }, null) });
  const L = 10.05, H = 10, B = 6.4, ARCH = 3.7, n = 2.7;
  const g = new THREE.SphereGeometry(1, 96, 56);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const pw = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);
  for (let i = 0; i < pos.count; i++) {
    const X = pw(pos.getX(i)) * L, Z = pw(pos.getZ(i)) * B;
    let Y = H / 2 + pw(pos.getY(i)) * (H / 2);
    if (Y < H / 2) {
      const u = X / 7.6;
      const lift = Math.abs(u) < 1 ? ARCH * Math.pow(Math.cos((u * Math.PI) / 2), 0.8) : 0;
      const sgt = (H / 2 - Y) / (H / 2);
      Y += lift * sgt * sgt;
    }
    pos.setXYZ(i, X, Y, Z);
  }
  g.computeVertexNormals();
  kit.add('mirror', g, { collide: true });
  // granite plaza (the sculpture sits on an open paved plaza) — also what the mirror mostly reflects
  const plaza = new THREE.CircleGeometry(1, 48);
  plaza.rotateX(-Math.PI / 2);
  kit.put('granite', plaza, 0, 0.04, 0, [0, 0, 0], {}, [23, 1, 17]);
  // cube camera lives in the scene (unrotated) at the sculpture's center
  const cam = new THREE.CubeCamera(0.5, 1500, cube);
  const w = ctx.toWorld(0, 0);
  cam.position.set(w[0], ctx.baseY + H * 0.45, w[1]);
  cam.name = 'landmark:cloud-gate:probe';
  ctx.game.scene.add(cam);
  let next = 1.5, lastN = -1, self: THREE.Object3D | null = null;
  ctx.onUpdate((game: Game) => {
    if (game.elapsed < next) return;
    const d = game.camera.position.distanceTo(cam.position);
    const n2 = landmarkNight.value;
    if (d > 450 && lastN >= 0 && Math.abs(n2 - lastN) < 0.15) { next = game.elapsed + 2; return; }
    self ??= game.scene.getObjectByName('landmark:cloud-gate') ?? null;
    const r = game.renderer as THREE.WebGLRenderer;
    if (!(r as unknown as { isWebGLRenderer?: boolean })?.isWebGLRenderer) return;
    const vis = self?.visible ?? true;
    if (self) self.visible = false;
    const sm = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    try { cam.update(r, game.scene); } finally { r.shadowMap.autoUpdate = sm; if (self) self.visible = vis; }
    lastN = n2;
    next = game.elapsed + (d < 200 ? 6 : 20);
  });
  return { kit };
}

// ------------------------------------------------------------------------------------------------
export function spaceNeedle(ctx: LandmarkCtx) {
  const flood = { color: '#f4f6ff', strength: 0.7, falloff: 400, top: 0.85 };
  const kit = new Kit({
    white: flatMat('#efeee8', 0.45, 0.3, flood),
    core: flatMat('#bfc1bf', 0.6, 0.3, flood),
    glass: lampMat('#2b3137', '#ffe2b0', 0, 1.6, ctx.lamps, 0.1),
    beacon: lampMat('#ffffff', '#ffffff', 0.2, 4, ctx.lamps, 0.3),
  });
  const y0 = -2;
  // six legs (three pairs) with the famous waist at ~113 m
  const prof: [number, number][] = [[17, 0], [12.5, 40], [8, 80], [5.8, 105], [5.6, 116], [7.5, 136], [11, 150], [13, 156]];
  for (let k = 0; k < 3; k++) for (const off of [-0.2, 0.2]) {
    const a = (k / 3) * Math.PI * 2 + off;
    const pts = prof.map(([r, h]) => new THREE.Vector3(Math.sin(a) * r, y0 + h, Math.cos(a) * r));
    const curve = new THREE.CatmullRomCurve3(pts);
    kit.add('white', new THREE.TubeGeometry(curve, 24, 1.1, 6, false));
  }
  kit.cyl('core', 0, y0, 0, 2.6, 3.4, 150, 10);
  kit.put('white', new THREE.TorusGeometry(9.2, 0.7, 6, 32), 0, y0 + 30, 0, [Math.PI / 2, 0, 0]); // 100 ft halo
  // top house (restaurant/observation saucer, 42 m across), glass band, roof, spire
  kit.lathe('white', 0, y0, 0, [[4, 145], [10, 150], [17, 154.5], [21, 158.5], [21, 159]], 40);
  kit.lathe('glass', 0, y0, 0, [[21, 159], [20.6, 163]], 40, { noShadow: true });
  kit.lathe('white', 0, y0, 0, [[20.6, 163], [21.6, 164.2], [19.5, 166.5], [14, 169.5], [7, 172], [2.5, 173]], 40);
  kit.cyl('core', 0, y0 + 173, 0, 0.35, 1.6, 11, 8);
  kit.cyl('beacon', 0, y0 + 184, 0, 0.25, 0.25, 0.8, 8, { noShadow: true });
  return { kit };
}

// ------------------------------------------------------------------------------------------------
export function lifeguardTower(ctx: LandmarkCtx) {
  const kit = new Kit({
    pink: flatMat('#f28cb1', 0.6, 0),
    teal: flatMat('#3cc2c7', 0.55, 0),
    yellow: flatMat('#f7d65a', 0.55, 0),
    white: flatMat('#f4f1ea', 0.6, 0),
    wood: stoneMat('wood-planks', { tint: '#c9b28f' }, null),
    dark: flatMat('#243038', 0.15, 0.3),
  });
  const dy = 2.2;
  for (const [x, z] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) kit.box('white', x, -0.8, z, 0.22, dy + 0.8, 0.22, { collide: true });
  kit.box('wood', 0, dy, 0.3, 3.6, 0.18, 4.2, { collide: true });
  kit.box('pink', 0, dy + 0.18, -0.3, 2.8, 2.2, 2.6, { collide: true });
  for (let i = 0; i < 4; i++) kit.box(i % 2 ? 'white' : 'teal', 0, dy + 0.35 + i * 0.45, 1.02, 2.84, 0.22, 0.04, { detail: true });
  kit.box('dark', 0, dy + 1.15, 1.02, 2.0, 0.8, 0.06);
  for (const s of [-1, 1]) kit.box('dark', s * 1.42, dy + 1.15, -0.3, 0.06, 0.8, 1.6);
  const roof = new THREE.CylinderGeometry(1.7, 1.7, 3.2, 16, 1, false, 0, Math.PI);
  kit.put('yellow', roof, 0, dy + 2.38, -0.3, [0, 0, Math.PI / 2], {}, [0.5, 1, 1]);
  // railing on the front deck, ramp down the back
  kit.box('teal', 0, dy + 0.18, 2.35, 3.6, 0.08, 0.08, { detail: true });
  kit.box('teal', 0, dy + 1.0, 2.35, 3.6, 0.08, 0.08);
  for (const x of [-1.75, -0.6, 0.6, 1.75]) kit.box('teal', x, dy + 0.18, 2.35, 0.07, 0.9, 0.07, { detail: true });
  const rampL = 5.2, ang = Math.asin((dy + 0.1) / rampL);
  const rg = new THREE.BoxGeometry(1.2, 0.12, rampL);
  kit.put('wood', rg, 0, (dy + 0.1) / 2, -1.6 - Math.cos(ang) * rampL / 2, [-ang, 0, 0], { collide: true });
  kit.cyl('white', 1.6, dy, -1.4, 0.03, 0.04, 3.4, 6, { detail: true });
  kit.box('teal', 1.95, dy + 2.8, -1.4, 0.7, 0.45, 0.02, { detail: true });
  return { kit };
}

// ------------------------------------------------------------------------------------------------
/** Vertical neon "HOTEL" canvas (white strokes on black, used as emissive map). */
let neonTex: THREE.CanvasTexture | null = null;
function neonTexture(): THREE.CanvasTexture {
  if (neonTex) return neonTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000'; x.fillRect(0, 0, 64, 512);
  x.strokeStyle = '#fff'; x.lineWidth = 5; x.lineJoin = 'round';
  x.font = 'bold 74px Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  const word = 'HOTEL';
  for (let i = 0; i < word.length; i++) x.strokeText(word[i], 32, 58 + i * 99);
  x.strokeRect(6, 6, 52, 500);
  neonTex = new THREE.CanvasTexture(c);
  neonTex.colorSpace = THREE.SRGBColorSpace;
  return neonTex;
}

export function neonFin(color: string) {
  return (ctx: LandmarkCtx) => {
    const tex = neonTexture();
    const letters = new THREE.MeshStandardMaterial({ color: '#efe9dc', roughness: 0.6, emissive: color, emissiveMap: tex, emissiveIntensity: 0.5 });
    letters.name = 'landmark:neon';
    ctx.lamps.push({ mat: letters, day: 0.5, night: 3.2 });
    const kit = new Kit({
      fin: flatMat('#f3eee2', 0.6, 0),
      tube: lampMat(color, color, 0.3, 3.0, ctx.lamps, 0.3),
      letters,
    });
    const h = Math.max(8, ctx.heights?.[0] ?? 12);
    const fz = ctx.D / 2 + 0.75, y0 = 3.4, y1 = h + 3.2;
    kit.box('fin', 0, y0, fz, 0.36, y1 - y0, 1.5);
    const fh = y1 - y0 - 0.8;
    for (const s of [-1, 1]) {
      const g = new THREE.PlaneGeometry(1.2, fh);
      kit.put('letters', g, s * 0.185, y0 + 0.4 + fh / 2, fz + 0.05, [0, s * Math.PI / 2, 0], { keepUv: [1, 1], noShadow: true });
    }
    kit.box('tube', 0, y0, fz + 0.77, 0.08, y1 - y0, 0.06, { noShadow: true });
    // neon band along the street facade just under the parapet
    kit.box('tube', 0, h - 1.1, ctx.D / 2 + 0.06, Math.max(4, ctx.W - 1.5), 0.07, 0.07, { noShadow: true });
    void rect;
    return { kit };
  };
}
