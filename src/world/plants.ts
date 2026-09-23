// OWNER: world (vegetation). Procedural plant geometry: palms (fan + feather), saguaro and other cacti,
// agave / yucca / ocotillo, ornamental grasses, flower beds, dense shrubs, Spanish moss and crape-myrtle
// blossom cards. Everything samples the single plant atlas (plantAtlas.ts) so a species variant is ONE
// geometry + ONE shared material (one draw call per LOD ring). Geometry is built in meters, base at y = 0.
// Attributes: position, normal, uv, color (species tint × baked AO), aFlex (0 rigid trunk … 1 leaf tip).
import * as THREE from 'three';
import { rng } from '../core/geo';
import { cellUV, type CellId } from './plantAtlas';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

export class PlantBuilder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = []; flex: number[] = []; idx: number[] = [];
  get count() { return this.pos.length / 3; }
  vert(p: V3, n: V3, uv: [number, number], c: THREE.Color, f: number) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.uv.push(uv[0], uv[1]); this.col.push(c.r, c.g, c.b); this.flex.push(f);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.idx.push(a, b, c, a, c, d); }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aFlex', new THREE.Float32BufferAttribute(this.flex, 1));
    g.setIndex(this.count > 65000 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const C = (hex: number) => new THREE.Color(hex);
const shade = (c: THREE.Color, k: number) => c.clone().multiplyScalar(k);

// ------------------------------------------------------------------------------------------------
// primitives
// ------------------------------------------------------------------------------------------------

interface TubeOpts {
  n: number; segs: number; cell: CellId;
  /** meters of length per texture repeat */
  mpr: number;
  color: (t: number) => THREE.Color;
  flex?: (t: number) => number;
  /** radius at (t, angle) */
  rad: (t: number, a: number) => number;
}

/** Tube along P(t), t ∈ [0,1]. Texture repeats along length every `mpr` m (rings duplicated at seams). */
export function tube(b: PlantBuilder, P: (t: number) => V3, o: TubeOpts) {
  // arc length table
  const N = 64;
  const acc: number[] = [0];
  let prev = P(0);
  for (let i = 1; i <= N; i++) { const q = P(i / N); acc.push(acc[i - 1] + q.distanceTo(prev)); prev = q; }
  const L = acc[N];
  const tOfS = (s: number) => {
    let i = 1; while (i < N && acc[i] < s) i++;
    const f = (s - acc[i - 1]) / Math.max(1e-9, acc[i] - acc[i - 1]);
    return (i - 1 + f) / N;
  };
  const ss: number[] = [];
  for (let i = 0; i <= o.n; i++) ss.push((i / o.n) * L);
  for (let k = 1; k * o.mpr < L; k++) ss.push(k * o.mpr);
  ss.sort((a, c) => a - c);
  const uniq = ss.filter((s, i) => i === 0 || s - ss[i - 1] > 1e-4);
  // frames (parallel transport)
  const ts = uniq.map(tOfS);
  const pts = ts.map(P);
  const tan = pts.map((p, i) => (i < pts.length - 1 ? pts[i + 1].clone().sub(p) : p.clone().sub(pts[i - 1])).normalize());
  let nor = Math.abs(tan[0].y) > 0.9 ? V(1, 0, 0) : UP.clone();
  nor = nor.sub(tan[0].clone().multiplyScalar(nor.dot(tan[0]))).normalize();
  const nors: V3[] = [], bins: V3[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) { nor.sub(tan[i].clone().multiplyScalar(nor.dot(tan[i]))).normalize(); }
    nors.push(nor.clone()); bins.push(tan[i].clone().cross(nor).normalize());
  }
  const ring = (i: number, vv: number) => {
    const base: number[] = [];
    for (let j = 0; j <= o.segs; j++) {
      const a = (j / o.segs) * Math.PI * 2;
      const r = o.rad(ts[i], a);
      const d = nors[i].clone().multiplyScalar(Math.cos(a)).add(bins[i].clone().multiplyScalar(Math.sin(a)));
      const p = pts[i].clone().add(d.clone().multiplyScalar(r));
      base.push(b.vert(p, d, cellUV(o.cell, j / o.segs, vv), o.color(ts[i]), o.flex ? o.flex(ts[i]) : 0));
    }
    return base;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const s0 = uniq[i], s1 = uniq[i + 1];
    const rep = Math.floor((s0 + 1e-5) / o.mpr);
    const v0 = s0 / o.mpr - rep, v1 = Math.min(1, s1 / o.mpr - rep);
    const A = ring(i, v0), B = ring(i + 1, v1);
    for (let j = 0; j < o.segs; j++) b.quad(A[j], A[j + 1], B[j + 1], B[j]);
  }
  return { length: L, top: pts[pts.length - 1] };
}

/** Double-sided strip card along a polyline with a lateral offset direction per point (UV s across, t along). */
function strip(b: PlantBuilder, pts: V3[], side: V3[], width: number[], cell: CellId, s0: number, s1: number,
  color: (i: number) => THREE.Color, flex: (i: number) => number, normal: (i: number) => V3, t0 = 0, t1 = 1) {
  const n = pts.length;
  const A: number[] = [], B: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + (t1 - t0) * (i / (n - 1));
    const nn = normal(i);
    A.push(b.vert(pts[i], nn, cellUV(cell, s0, t), color(i), flex(i)));
    B.push(b.vert(pts[i].clone().add(side[i].clone().multiplyScalar(width[i])), nn, cellUV(cell, s1, t), color(i), flex(i)));
  }
  for (let i = 0; i < n - 1; i++) b.quad(A[i], B[i], B[i + 1], A[i + 1]);
}

/** Axis-aligned card (quad) centered horizontally on `p` bottom, facing `f` (horizontal), size w × h. */
function card(b: PlantBuilder, p: V3, right: V3, up: V3, w: number, h: number, cell: CellId, col: THREE.Color, flex0: number, flex1: number, nrm: V3, sRange: [number, number] = [0, 1], tRange: [number, number] = [0, 1]) {
  const r = right.clone().multiplyScalar(w / 2);
  const u = up.clone().multiplyScalar(h);
  const a = b.vert(p.clone().sub(r), nrm, cellUV(cell, sRange[0], tRange[0]), col, flex0);
  const c1 = b.vert(p.clone().add(r), nrm, cellUV(cell, sRange[1], tRange[0]), col, flex0);
  const d = b.vert(p.clone().add(r).add(u), nrm, cellUV(cell, sRange[1], tRange[1]), col, flex1);
  const e = b.vert(p.clone().sub(r).add(u), nrm, cellUV(cell, sRange[0], tRange[1]), col, flex1);
  b.quad(a, c1, d, e);
}

const horiz = (az: number) => V(Math.cos(az), 0, Math.sin(az));

// ------------------------------------------------------------------------------------------------
// palm parts
// ------------------------------------------------------------------------------------------------

interface FeatherOpts { L: number; W: number; elev: number; droop: number; fold: number; planes: number; dead?: boolean; tint: THREE.Color; segs: number; twist?: number }

/** Feather (pinnate) frond: curved rachis, V-folded leaflet cards. */
function featherFrond(b: PlantBuilder, base: V3, az: number, o: FeatherOpts, crownC: V3) {
  const h = horiz(az), sd = V(-h.z, 0, h.x);
  const pts: V3[] = [];
  let p = base.clone();
  const n = o.segs;
  pts.push(p.clone());
  for (let i = 1; i <= n; i++) {
    const s = (i - 0.5) / n;
    const ang = o.elev - o.droop * Math.pow(s, 1.4);
    p = p.clone().add(h.clone().multiplyScalar(Math.cos(ang) * o.L / n)).add(V(0, Math.sin(ang) * o.L / n, 0));
    pts.push(p);
  }
  const cell: CellId = o.dead ? 'frondDead' : 'frond';
  const cols = pts.map((q, i) => shade(o.tint, 0.62 + 0.38 * Math.min(1, i / n + 0.2)));
  const flex = (i: number) => 0.15 + 0.85 * (i / n);
  const nrm = (i: number) => pts[i].clone().sub(crownC).setY(0).normalize().multiplyScalar(0.55).add(V(0, 0.85, 0)).normalize();
  const planes = o.planes === 2 ? [o.fold, -o.fold * 0.2 - 0.35] : [o.fold];
  for (const fold of planes) {
    for (const s of [-1, 1]) {
      const sides: V3[] = [], widths: number[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const tw = (o.twist ?? 0) * t;
        const f = fold + tw;
        // lateral direction rotated downward by fold
        sides.push(sd.clone().multiplyScalar(s * Math.cos(f)).add(V(0, -Math.sin(f), 0)).normalize());
        widths.push(o.W / 2);
      }
      strip(b, pts, sides, widths, cell, 0.5, s < 0 ? 0 : 1, (i) => cols[i], flex, nrm);
    }
  }
}

interface FanOpts { petL: number; R: number; elev: number; span: number; cup: number; pleat: number; dead?: boolean; tint: THREE.Color; petTint: THREE.Color; aseg: number; hang?: number }

/** Palmate / costapalmate fan leaf on a petiole. */
function fanLeaf(b: PlantBuilder, base: V3, az: number, o: FanOpts, crownC: V3) {
  const h = horiz(az), sd = V(-h.z, 0, h.x);
  const dir = h.clone().multiplyScalar(Math.cos(o.elev)).add(V(0, Math.sin(o.elev), 0)).normalize();
  const hub = base.clone().add(dir.clone().multiplyScalar(o.petL));
  // petiole: two crossed thin strips
  const pc = shade(o.petTint, 0.8);
  for (const k of [0, 1]) {
    const side = k ? sd : sd.clone().cross(dir).normalize();
    const w = 0.07;
    const a = b.vert(base.clone().sub(side.clone().multiplyScalar(w)), UP, cellUV('greenSmooth', 0, 0), pc, 0.1);
    const c = b.vert(base.clone().add(side.clone().multiplyScalar(w)), UP, cellUV('greenSmooth', 1, 0), pc, 0.1);
    const d = b.vert(hub.clone().add(side.clone().multiplyScalar(w * 0.5)), UP, cellUV('greenSmooth', 1, 1), pc, 0.5);
    const e = b.vert(hub.clone().sub(side.clone().multiplyScalar(w * 0.5)), UP, cellUV('greenSmooth', 0, 1), pc, 0.5);
    b.quad(a, c, d, e);
  }
  // blade frame: f = outward (tilted by elev, but flatter), s = side, n = normal
  const fe = o.elev * 0.6 + (o.hang ?? 0);
  const f = h.clone().multiplyScalar(Math.cos(fe)).add(V(0, Math.sin(fe), 0)).normalize();
  const nrmB = f.clone().cross(sd).normalize(); // roughly up for low elevations
  if (nrmB.y < 0) nrmB.negate();
  const cell: CellId = o.dead ? 'fanDead' : 'fan';
  const rings = [0, 0.3, 0.65, 1];
  const A = o.aseg;
  const idx: number[][] = [];
  const th0 = Math.PI / 2 - o.span / 2;
  for (let ri = 0; ri < rings.length; ri++) {
    const r = rings[ri] * o.R;
    const row: number[] = [];
    for (let ai = 0; ai <= A; ai++) {
      const th = th0 + (ai / A) * o.span;
      const pl = (ai % 2 ? 1 : -1) * o.pleat * rings[ri];
      const p = hub.clone()
        .add(sd.clone().multiplyScalar(Math.cos(th) * r))
        .add(f.clone().multiplyScalar(Math.sin(th) * r))
        .add(nrmB.clone().multiplyScalar(pl))
        .add(V(0, -o.cup * rings[ri] * rings[ri] * o.R, 0));
      const uv = cellUV(cell, 0.5 + 0.5 * rings[ri] * Math.cos(th), 0.5 + 0.5 * rings[ri] * Math.sin(th));
      const nn = p.clone().sub(crownC).normalize().multiplyScalar(0.5).add(nrmB.clone().multiplyScalar(0.3)).add(V(0, 0.6, 0)).normalize();
      row.push(b.vert(p, nn, uv, shade(o.tint, 0.75 + 0.25 * rings[ri]), 0.4 + 0.6 * rings[ri]));
    }
    idx.push(row);
  }
  for (let ri = 0; ri < rings.length - 1; ri++) for (let ai = 0; ai < A; ai++) b.quad(idx[ri][ai], idx[ri][ai + 1], idx[ri + 1][ai + 1], idx[ri + 1][ai]);
}

/** Skirt of dead hanging fronds (Washingtonia petticoat). */
function skirt(b: PlantBuilder, center: V3, rTop: number, rBot: number, len: number, n: number, R: () => number) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.2;
    const d = horiz(a), tg = V(-d.z, 0, d.x);
    const w = (2 * Math.PI * rTop / n) * 1.45;
    const l = len * (0.8 + R() * 0.3);
    const col = C(0xb8a58c).multiplyScalar(0.8 + R() * 0.3);
    const top = center.clone().add(d.clone().multiplyScalar(rTop)).add(V(0, 0.15, 0));
    const mid = center.clone().add(d.clone().multiplyScalar((rTop + rBot) / 2 + 0.05)).add(V(0, -l * 0.5, 0));
    const bot = center.clone().add(d.clone().multiplyScalar(rBot)).add(V(0, -l, 0));
    const pts = [top, mid, bot];
    const nr = d.clone().multiplyScalar(0.8).add(V(0, 0.3, 0)).normalize();
    const ws = [w * 0.5, w * 0.5, w * 0.45];
    const vs = [1, 0.5, 0];
    const L: number[] = [], Rr: number[] = [];
    pts.forEach((p, k) => {
      const c = shade(col, 0.55 + 0.45 * (1 - vs[k] * 0.6));
      L.push(b.vert(p.clone().sub(tg.clone().multiplyScalar(ws[k])), nr, cellUV('thatch', 0, vs[k]), c, 0.05 + (1 - vs[k]) * 0.2));
      Rr.push(b.vert(p.clone().add(tg.clone().multiplyScalar(ws[k])), nr, cellUV('thatch', 1, vs[k]), c, 0.05 + (1 - vs[k]) * 0.2));
    });
    for (let k = 0; k < 2; k++) b.quad(L[k], Rr[k], Rr[k + 1], L[k + 1]);
  }
}

function sphereBlob(b: PlantBuilder, c: V3, rx: number, ry: number, cell: CellId, col: THREE.Color, R: () => number, detail = 1, flex = 0.2, jitter = 0.12) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const ng = g.index ? g.toNonIndexed() : g;
  const p = ng.getAttribute('position');
  const cache = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const v = V(p.getX(i), p.getY(i), p.getZ(i));
    const key = v.toArray().map((x) => x.toFixed(3)).join(',');
    let j = cache.get(key);
    if (j === undefined) {
      const d = v.clone().normalize();
      const k = 1 + (R() - 0.5) * 2 * jitter;
      const q = c.clone().add(V(d.x * rx * k, d.y * ry * k, d.z * rx * k));
      if (q.y < 0) q.y *= 0.3;
      const uv = cellUV(cell, 0.5 + 0.5 * Math.atan2(d.z, d.x) / Math.PI * 0.98, 0.5 + 0.49 * d.y);
      j = b.vert(q, d, uv, shade(col, 0.55 + 0.45 * (0.5 + 0.5 * d.y)), flex * (0.5 + 0.5 * d.y));
      cache.set(key, j);
    }
    b.idx.push(j);
  }
  g.dispose(); if (ng !== g) ng.dispose();
}

// ------------------------------------------------------------------------------------------------
// species
// ------------------------------------------------------------------------------------------------

export type ProcKind =
  | 'palm-fan' | 'palm-sabal' | 'palm-canary' | 'palm-date' | 'palm-royal' | 'palm-queen' | 'palm-coconut'
  | 'saguaro' | 'barrel-cactus' | 'prickly-pear' | 'agave' | 'yucca' | 'ocotillo'
  | 'grass' | 'flowers' | 'shrub-box' | 'shrub-leafy' | 'shrub-desert';

/** Reference heights (m) of the variants built per kind (one geometry each). */
export const PROC_REF_H: Record<ProcKind, number[]> = {
  'palm-fan': [11, 19], 'palm-sabal': [8, 13], 'palm-canary': [9, 15], 'palm-date': [8, 13], 'palm-royal': [13, 19],
  'palm-queen': [8, 12], 'palm-coconut': [9, 14], saguaro: [5, 9], 'barrel-cactus': [0.7], 'prickly-pear': [1.2], agave: [1.0],
  yucca: [1.6, 2.6], ocotillo: [4], grass: [0.9], flowers: [0.5, 0.55], 'shrub-box': [1.1, 1.3], 'shrub-leafy': [1.6, 2.0], 'shrub-desert': [1.2],
};

export function buildProc(kind: ProcKind, H: number, seed: number, lod: number): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const R = rng(seed);
  const lo = lod > 0;
  switch (kind) {
    case 'palm-fan': palmFan(b, H, R, lo, false); break;
    case 'palm-sabal': palmFan(b, H, R, lo, true); break;
    case 'palm-canary': palmFeather(b, H, R, lo, 'canary'); break;
    case 'palm-date': palmFeather(b, H, R, lo, 'date'); break;
    case 'palm-royal': palmFeather(b, H, R, lo, 'royal'); break;
    case 'palm-queen': palmFeather(b, H, R, lo, 'queen'); break;
    case 'palm-coconut': palmFeather(b, H, R, lo, 'coconut'); break;
    case 'saguaro': saguaro(b, H, R, lo); break;
    case 'barrel-cactus': barrel(b, H, R); break;
    case 'prickly-pear': pricklyPear(b, H, R); break;
    case 'agave': agave(b, H, R, lo); break;
    case 'yucca': yucca(b, H, R, lo); break;
    case 'ocotillo': ocotillo(b, H, R, lo); break;
    case 'grass': grassTuft(b, H, R); break;
    case 'flowers': flowerBed(b, H, R, seed % 2 === 0); break;
    case 'shrub-box': shrub(b, H, R, lo, 'shrubA', C(0x8aa070), 1.25, 0.06); break;
    case 'shrub-leafy': shrub(b, H, R, lo, 'shrubB', C(0x9ab27a), 1.4, 0.25); break;
    case 'shrub-desert': shrub(b, H, R, lo, 'shrubA', C(0xb0b48a), 1.4, 0.2); break;
  }
  return b.build();
}

function palmFan(b: PlantBuilder, H: number, R: () => number, lo: boolean, sabal: boolean) {
  // Washingtonia: tall thin ringed trunk, small dense head, dead-frond skirt. Sabal: stouter, big round head.
  const crownH = sabal ? 2.6 : 2.2;
  const trunkH = H - crownH * 0.55;
  const r0 = sabal ? 0.24 : 0.3, r1 = sabal ? 0.22 : 0.19;
  const lean = V((R() - 0.5) * 0.06 * trunkH, 0, (R() - 0.5) * 0.06 * trunkH);
  const P = (t: number) => V(lean.x * t * t, t * trunkH, lean.z * t * t);
  const col = sabal ? C(0xa89a8a) : C(0x9c9286);
  tube(b, P, {
    n: lo ? 6 : 12, segs: lo ? 6 : 10, cell: sabal ? 'trunkBoot' : 'trunkRing', mpr: sabal ? 1.4 : 1.1,
    color: (t) => shade(col, 0.8 + 0.2 * t), rad: (t) => (r0 + (r1 - r0) * Math.min(1, t * 1.4)) * (1 + 0.5 * Math.max(0, 0.06 - t) / 0.06),
  });
  const top = P(1);
  const crownC = top.clone().add(V(0, 0.4, 0));
  // skirt of dead fronds (Washingtonia); sabal gets a short boot collar
  if (!sabal) {
    const len = R() < 0.4 ? 1.0 + R() * 1.2 : 2.5 + R() * 2.5;
    skirt(b, top.clone().add(V(0, -0.05, 0)), r1 + 0.12, r1 + 0.55, Math.min(len, trunkH * 0.45), lo ? 7 : 12, R);
  } else {
    tube(b, (t) => top.clone().add(V(0, -0.9 + t * 1.1, 0)), { n: 2, segs: 8, cell: 'trunkBoot', mpr: 1.2, color: () => C(0x9a8a70), rad: (t) => r1 + 0.1 + 0.12 * t });
  }
  // fronds
  const n = lo ? (sabal ? 18 : 14) : (sabal ? 34 : 24);
  const tint = sabal ? C(0x8a9c78) : C(0xa8b884);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const az = i * 2.39996 + R() * 0.3; // golden angle phyllotaxis
    const elev = sabal ? 1.2 - k * 1.9 : 1.25 - k * 1.7;
    const dead = !sabal && k > 0.82 && R() < 0.7;
    fanLeaf(b, top.clone().add(V(0, dead ? -0.1 : 0.1 + (1 - k) * 0.4, 0)), az, {
      petL: dead ? 0.5 : (sabal ? 1.2 : 1.1) + R() * 0.4, R: dead ? 0.8 : (sabal ? 1.1 : 1.0) + R() * 0.2, elev: dead ? -1.4 : elev, span: dead ? 2.0 : sabal ? 3.4 : 3.6, cup: dead ? 0.1 : sabal ? 0.55 : 0.5,
      pleat: sabal ? 0.08 : 0.04, dead, tint: dead ? C(0xc0a888) : shade(tint, 0.85 + R() * 0.25), petTint: sabal ? C(0x8a8a6a) : C(0xa09a70), aseg: lo ? 6 : 10,
      hang: sabal ? -0.4 : -0.2,
    }, crownC);
  }
}

function palmFeather(b: PlantBuilder, H: number, R: () => number, lo: boolean, sp: 'canary' | 'date' | 'royal' | 'queen' | 'coconut') {
  const S = {
    canary: { r0: 0.55, r1: 0.42, crownL: 5.2, W: 1.3, n: 60, elev: [1.1, -0.5], droop: 1.1, fold: 0.35, planes: 1, cell: 'trunkDiamond' as CellId, trunkCol: 0xb89a80, tint: 0x9aae70, crownFrac: 0.3, mpr: 1.3 },
    date: { r0: 0.3, r1: 0.27, crownL: 4.2, W: 1.0, n: 40, elev: [1.3, -0.4], droop: 0.6, fold: 0.5, planes: 1, cell: 'trunkDiamond' as CellId, trunkCol: 0xa89484, tint: 0xa8b4a0, crownFrac: 0.3, mpr: 1.0 },
    royal: { r0: 0.34, r1: 0.26, crownL: 4.6, W: 1.5, n: 18, elev: [1.0, -0.3], droop: 1.5, fold: 0.9, planes: 2, cell: 'trunkSmooth' as CellId, trunkCol: 0xd8d4cc, tint: 0x8aa868, crownFrac: 0.28, mpr: 1.6 },
    queen: { r0: 0.2, r1: 0.17, crownL: 3.6, W: 1.3, n: 16, elev: [1.1, -0.2], droop: 1.8, fold: 1.05, planes: 2, cell: 'trunkSmooth' as CellId, trunkCol: 0xb8b2a8, tint: 0x94b070, crownFrac: 0.28, mpr: 1.2 },
    coconut: { r0: 0.24, r1: 0.16, crownL: 4.4, W: 1.35, n: 24, elev: [0.9, -0.6], droop: 1.3, fold: 0.75, planes: 1, cell: 'trunkRing' as CellId, trunkCol: 0xb0a090, tint: 0x9ab468, crownFrac: 0.28, mpr: 1.4 },
  }[sp];
  const crownDrop = S.crownL * S.crownFrac;
  const trunkH = Math.max(1.5, H - crownDrop * 0.9);
  // trunk path: coconut leans & curves, others near-straight
  const leanA = R() * Math.PI * 2;
  const lean = sp === 'coconut' ? 0.18 + R() * 0.12 : 0.015 + R() * 0.02;
  const ld = horiz(leanA);
  const P = sp === 'coconut'
    ? (t: number) => ld.clone().multiplyScalar(trunkH * lean * (1.8 * t - 0.8 * t * t)).add(V(0, t * trunkH, 0))
    : (t: number) => ld.clone().multiplyScalar(trunkH * lean * t * t).add(V(0, t * trunkH, 0));
  const tc = C(S.trunkCol);
  tube(b, P, {
    n: lo ? 6 : 14, segs: lo ? 7 : 12, cell: S.cell, mpr: S.mpr,
    color: (t) => shade(tc, 0.78 + 0.22 * t),
    rad: (t) => {
      let r = S.r0 + (S.r1 - S.r0) * t;
      if (sp === 'royal') r *= 1 + 0.18 * Math.sin(Math.PI * Math.min(1, t * 1.3)); // bottle bulge
      if (sp === 'coconut' || sp === 'queen') r *= 1 + 0.5 * Math.max(0, 0.08 - t) / 0.08;
      return r;
    },
  });
  let top = P(1);
  // crownshaft (royal, queen-ish) or pineapple knob (canary/date)
  if (sp === 'royal') {
    const cs = 1.8;
    tube(b, (t) => top.clone().add(V(0, t * cs, 0)), { n: 3, segs: 10, cell: 'greenSmooth', mpr: 3, color: () => C(0x9ac080), rad: (t) => S.r1 * (1.02 - 0.15 * t) });
    top = top.clone().add(V(0, cs, 0));
  } else if (sp === 'canary' || sp === 'date') {
    tube(b, (t) => top.clone().add(V(0, -0.4 + t * 1.2, 0)), { n: 4, segs: 10, cell: 'trunkDiamond', mpr: 1.2, color: () => C(0xc8a888), rad: (t) => S.r1 * (1.05 + 0.4 * Math.sin(Math.PI * t * 0.85)) });
    top = top.clone().add(V(0, 0.5, 0));
  }
  const crownC = top.clone();
  const n = lo ? Math.ceil(S.n * 0.45) : S.n;
  const tint = C(S.tint);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const az = i * 2.39996 + R() * 0.25;
    const elev = S.elev[0] + (S.elev[1] - S.elev[0]) * k + (R() - 0.5) * 0.15;
    const dead = (sp === 'queen' || sp === 'coconut') && k > 0.9 && R() < 0.5;
    const L = S.crownL * (0.8 + R() * 0.3) * (1 - 0.25 * Math.max(0, 0.3 - k));
    featherFrond(b, top.clone().add(V(0, (1 - k) * 0.35, 0)), az, {
      L, W: S.W * (0.85 + R() * 0.3), elev, droop: S.droop * (0.8 + R() * 0.4), fold: S.fold, planes: lo ? 1 : S.planes,
      dead, tint: dead ? C(0xd0b890) : shade(tint, 0.85 + R() * 0.25), segs: lo ? 4 : 8, twist: sp === 'queen' ? 0.6 : sp === 'royal' ? 0.4 : 0.1,
    }, crownC);
  }
  // coconuts
  if (sp === 'coconut' && !lo) {
    for (let i = 0; i < 6; i++) {
      const a = R() * Math.PI * 2;
      sphereBlob(b, top.clone().add(V(Math.cos(a) * 0.3, -0.25 - R() * 0.2, Math.sin(a) * 0.3)), 0.13, 0.15, 'greenSmooth', C(0x8a9a50), R, 0, 0);
    }
  }
}

function saguaro(b: PlantBuilder, H: number, R: () => number, lo: boolean) {
  const r0 = 0.24 + H * 0.012;
  const col = C(0x9aa888);
  const segs = lo ? 12 : 24;
  const ribbed = (r: number) => (a: number) => r * (1 - 0.07 * (0.5 - 0.5 * Math.cos(12 * a)));
  const topRound = (t: number, len: number, r: number) => {
    const d = len * (1 - t);
    return d < r ? Math.sqrt(Math.max(0, r * r - (r - d) * (r - d))) / r : 1;
  };
  tube(b, (t) => V(0, t * H, 0), {
    n: lo ? 8 : 16, segs, cell: 'cactus', mpr: 1.0, color: (t) => shade(col, 0.8 + 0.2 * t), flex: (t) => t * 0.1,
    rad: (t, a) => ribbed(r0 * (1 - 0.12 * t) * topRound(t, H, r0 * 1.2))(a),
  });
  const arms = H < 5.5 ? (R() < 0.5 ? 0 : 1) : 1 + Math.floor(R() * 3.5);
  for (let i = 0; i < arms; i++) {
    const az = R() * Math.PI * 2;
    const d = horiz(az);
    const y0 = H * (0.38 + R() * 0.25);
    const ar = r0 * (0.65 + R() * 0.15);
    const out = 0.45 + R() * 0.35, up = Math.min(H - y0 - 0.2, 1.5 + R() * 2.2);
    const p0 = d.clone().multiplyScalar(r0 * 0.6).setY(y0);
    const p1 = d.clone().multiplyScalar(r0 + out).setY(y0 + 0.05);
    const p2 = d.clone().multiplyScalar(r0 + out).setY(y0 + up);
    // quadratic-ish: horizontal elbow then straight up
    const P = (t: number) => {
      if (t < 0.35) { const u = t / 0.35; return p0.clone().lerp(p1, u).add(V(0, -Math.sin(Math.PI * u) * 0.05, 0)); }
      const u = (t - 0.35) / 0.65;
      const e = p1.clone().add(d.clone().multiplyScalar(ar * 0.6 * Math.sin(Math.min(1, u * 3) * Math.PI / 2)));
      return e.lerp(p2.clone().add(d.clone().multiplyScalar(ar * 0.6)), u);
    };
    const armLen = out + up;
    tube(b, P, { n: lo ? 6 : 12, segs: lo ? 10 : 16, cell: 'cactus', mpr: 1.0, color: (t) => shade(col, 0.82 + 0.18 * t), flex: () => 0.08, rad: (t, a) => ribbed(ar * topRound(t, armLen, ar * 1.1))(a) });
  }
}

function barrel(b: PlantBuilder, H: number, R: () => number) {
  const r = H * (0.5 + R() * 0.15);
  const col = C(0x9aa870);
  tube(b, (t) => V(0, t * H, 0), {
    n: 8, segs: 20, cell: 'cactus', mpr: H,
    color: (t) => t > 0.85 ? C(0xd8c070) : shade(col, 0.75 + 0.25 * t),
    rad: (t, a) => r * Math.sqrt(Math.max(0.02, Math.sin(Math.PI * (0.18 + 0.82 * t)))) * (1 - 0.1 * (0.5 - 0.5 * Math.cos(20 * a))),
  });
}

function pricklyPear(b: PlantBuilder, H: number, R: () => number) {
  const col = C(0x98b078);
  const pads: { p: V3; az: number; s: number; tilt: number }[] = [];
  const add = (p: V3, s: number, az: number, depth: number) => {
    const tilt = (R() - 0.5) * 0.7;
    pads.push({ p, az, s, tilt });
    if (depth <= 0) return;
    const kids = 1 + Math.floor(R() * 2.2);
    for (let k = 0; k < kids; k++) {
      const off = (R() - 0.5) * 0.9;
      const f = horiz(az);
      const top = p.clone().add(V(Math.sin(tilt + off) * s * 0.9 * f.x, Math.cos(off) * s * 0.9, Math.sin(tilt + off) * s * 0.9 * f.z));
      add(top, s * (0.8 + R() * 0.15), az + (R() - 0.5) * 1.8, depth - 1);
    }
  };
  const bases = 2 + Math.floor(R() * 2);
  for (let i = 0; i < bases; i++) add(V((R() - 0.5) * 0.5, 0, (R() - 0.5) * 0.5), H * 0.38, R() * Math.PI * 2, 2);
  for (const pd of pads) {
    const f = horiz(pd.az), rt = V(-f.z, 0, f.x);
    const up = V(0, Math.cos(pd.tilt), 0).add(f.clone().multiplyScalar(Math.sin(pd.tilt))).normalize();
    const n = f.clone().multiplyScalar(0.6).add(V(0, 0.8, 0)).normalize();
    card(b, pd.p, rt, up, pd.s * 0.8, pd.s, 'pad', shade(col, 0.8 + R() * 0.3), 0.05, 0.12, n);
  }
}

function rosette(b: PlantBuilder, center: V3, n: number, L: [number, number], W: number, elev: [number, number], cell: CellId, tint: THREE.Color, R: () => number, segs: number, fold: number, curl: number) {
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const az = i * 2.39996 + R() * 0.3;
    const h = horiz(az), sd = V(-h.z, 0, h.x);
    const len = L[0] + (L[1] - L[0]) * (0.5 + 0.5 * Math.sin(k * Math.PI)) * (0.85 + R() * 0.3);
    const e0 = elev[0] + (elev[1] - elev[0]) * k;
    const pts: V3[] = [center.clone()];
    let p = center.clone();
    for (let s = 1; s <= segs; s++) {
      const ang = e0 - curl * (s / segs) ** 2;
      p = p.clone().add(h.clone().multiplyScalar(Math.cos(ang) * len / segs)).add(V(0, Math.sin(ang) * len / segs, 0));
      pts.push(p);
    }
    const c = shade(tint, 0.8 + R() * 0.3);
    const nrm = () => h.clone().multiplyScalar(0.4).add(V(0, 0.9, 0)).normalize();
    for (const s of [-1, 1]) {
      const sides = pts.map(() => sd.clone().multiplyScalar(s * Math.cos(fold)).add(V(0, Math.sin(fold), 0)).normalize());
      strip(b, pts, sides, pts.map(() => W / 2), cell, 0.5, s < 0 ? 0 : 1, (j) => shade(c, 0.7 + 0.3 * j / segs), (j) => 0.05 + 0.3 * j / segs, nrm);
    }
  }
}

function agave(b: PlantBuilder, H: number, R: () => number, lo: boolean) {
  rosette(b, V(0, 0.02, 0), lo ? 14 : 26, [H * 0.7, H * 1.15], H * 0.2, [1.35, 0.25], 'agave', C(0xb4c8c0), R, lo ? 2 : 4, 0.45, 0.3);
}

function yucca(b: PlantBuilder, H: number, R: () => number, lo: boolean) {
  const heads = H > 2 ? 2 + Math.floor(R() * 2) : 1;
  for (let hI = 0; hI < heads; hI++) {
    const az = R() * Math.PI * 2, d = horiz(az);
    const th = H * (heads > 1 ? 0.45 + R() * 0.3 : 0.35);
    const tipOff = heads > 1 ? d.clone().multiplyScalar(0.35 + R() * 0.3) : V();
    const P = (t: number) => tipOff.clone().multiplyScalar(t * t).add(V(0, t * th, 0));
    tube(b, P, { n: 3, segs: 6, cell: 'trunkBoot', mpr: 0.8, color: () => C(0x8a7a60), rad: (t) => 0.1 + 0.03 * t });
    const top = P(1);
    const n = lo ? 24 : 55;
    for (let i = 0; i < n; i++) {
      const a = i * 2.39996;
      const el = -0.5 + (i / n) * 2.1 + (R() - 0.5) * 0.2;
      const dir = horiz(a).multiplyScalar(Math.cos(el)).add(V(0, Math.sin(el), 0)).normalize();
      const len = (H - th) * (0.8 + R() * 0.4);
      const sd = V(-dir.z, 0, dir.x).normalize();
      if (sd.lengthSq() < 0.1) sd.set(1, 0, 0);
      const up = dir;
      const nrm = dir.clone().multiplyScalar(0.5).add(V(0, 0.8, 0)).normalize();
      card(b, top, sd, up, 0.07, len, 'yucca', shade(C(0x9aac80), 0.8 + R() * 0.3), 0.05, 0.35, nrm);
    }
  }
}

function ocotillo(b: PlantBuilder, H: number, R: () => number, lo: boolean) {
  const n = lo ? 8 : 16;
  for (let i = 0; i < n; i++) {
    const az = R() * Math.PI * 2, d = horiz(az);
    const el = 1.15 + R() * 0.3;
    const len = H * (0.7 + R() * 0.35);
    const pts: V3[] = [];
    const segs = 4;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const e = el + 0.12 * t;
      pts.push(d.clone().multiplyScalar(Math.cos(e) * len * t + 0.05).add(V(0, Math.sin(e) * len * t, 0)));
    }
    for (const k of [0, 1]) {
      const side = k ? V(-d.z, 0, d.x) : V(d.x * -Math.sin(el), Math.cos(el), d.z * -Math.sin(el)).cross(V(-d.z, 0, d.x)).normalize();
      const sides = pts.map(() => side);
      const nrm = () => d.clone().multiplyScalar(0.6).add(V(0, 0.7, 0)).normalize();
      const off = pts.map((p) => p.clone().sub(side.clone().multiplyScalar(0.07)));
      strip(b, off, sides, pts.map(() => 0.14), 'ocotillo', 0, 1, () => shade(C(0xb0b090), 0.85 + R() * 0.2), (j) => 0.1 + 0.5 * j / segs, nrm);
    }
  }
}

function grassTuft(b: PlantBuilder, H: number, R: () => number) {
  const n = 4;
  const col = C(0xc8c090);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI + R() * 0.3;
    const rt = horiz(a);
    const tilt = horiz(a + Math.PI / 2).multiplyScalar((R() - 0.5) * 0.3);
    const up = V(0, 1, 0).add(tilt).normalize();
    card(b, V(0, -0.02, 0), rt, up, H * 1.1, H * (0.9 + R() * 0.2), 'grass', shade(col, 0.85 + R() * 0.25), 0, 0.6, V(0, 1, 0));
  }
}

function flowerBed(b: PlantBuilder, H: number, R: () => number, warm: boolean) {
  const cell: CellId = warm ? 'flowersWarm' : 'flowersCool';
  const W = H * 2.2;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI + R() * 0.3;
    card(b, V(0, -0.03, 0), horiz(a), V(0, 1, 0), W, H, cell, C(0xe8e8e0), 0, 0.2, V(0, 1, 0), [0, 1], [0, 1]);
  }
  // top dome card
  const n = V(0, 1, 0);
  const s = W * 0.45;
  const y = H * 0.75;
  const q = [V(-s, y, -s), V(s, y, -s), V(s, y, s), V(-s, y, s)];
  const uvs: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const ids = q.map((p, k) => b.vert(p, n, cellUV(cell, uvs[k][0], uvs[k][1]), C(0xffffff), 0.15));
  b.quad(ids[0], ids[3], ids[2], ids[1]);
}

function shrub(b: PlantBuilder, H: number, R: () => number, lo: boolean, cell: CellId, tint: THREE.Color, widthK: number, loose: number) {
  // irregular mound: 1-3 overlapping lobes (loose shrubs) or one tight ball (boxwood)
  const lobes = loose > 0.1 ? 2 + Math.floor(R() * 2) : 1;
  const L: { c: V3; rx: number; ry: number }[] = [];
  for (let k = 0; k < lobes; k++) {
    const s = k === 0 ? 1 : 0.6 + R() * 0.25;
    const rx = H * widthK * 0.5 * s * (lobes > 1 ? 0.8 : 1), ry = H * 0.5 * s;
    const a = R() * Math.PI * 2, off = k === 0 ? 0 : H * widthK * 0.32;
    L.push({ c: V(Math.cos(a) * off, ry * 0.92, Math.sin(a) * off), rx, ry });
  }
  for (const l of L) sphereBlob(b, l.c, l.rx * (lo ? 0.9 : 0.72), l.ry * (lo ? 0.9 : 0.74), 'leafSolid', shade(tint, 0.62), R, lo ? 1 : 2, 0.15, 0.12 + loose * 0.5);
  if (lo) return;
  const n = 56;
  for (let i = 0; i < n; i++) {
    // points on the upper ~80% of the ellipsoid, cards roughly tangent-crossing (fuzzy leafy silhouette)
    const { c, rx, ry } = L[i % L.length];
    const u = R(), v = 0.15 + R() * 0.85;
    const th = u * Math.PI * 2, ph = Math.acos(1 - 2 * v * 0.92);
    const d = V(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
    const p = c.clone().add(V(d.x * rx, d.y * ry, d.z * rx).multiplyScalar(0.92 + loose * R()));
    const sz = H * (0.36 + R() * 0.22);
    const rt = V(-d.z, 0, d.x).normalize();
    if (rt.lengthSq() < 0.1) rt.set(1, 0, 0);
    const up = d.clone().cross(rt).normalize().multiplyScalar(-1);
    const base = p.clone().sub(up.clone().multiplyScalar(sz / 2));
    card(b, base, rt, up, sz, sz, cell, shade(tint, 0.8 + R() * 0.35), 0.2, 0.35, d);
  }
}

// ------------------------------------------------------------------------------------------------
// extras on ez-tree variants (normalized tree space: base 0, height 1)
// ------------------------------------------------------------------------------------------------

/** Spanish moss strands hanging from branch vertices of a (normalized) bark geometry. */
export function mossFor(bark: THREE.BufferGeometry, seed: number, count: number, lenN: number): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const R = rng(seed);
  const p = bark.getAttribute('position') as THREE.BufferAttribute;
  const cand: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), r = Math.hypot(p.getX(i), p.getZ(i));
    if (y > 0.28 && y < 0.85 && r > 0.07) cand.push(i);
  }
  if (!cand.length) return b.build();
  for (let k = 0; k < count; k++) {
    const i = cand[Math.floor(R() * cand.length)];
    const top = V(p.getX(i), p.getY(i), p.getZ(i));
    const len = lenN * (0.5 + R() * 0.8);
    const a = R() * Math.PI;
    const col = shade(C(0xa4ac98), 0.8 + R() * 0.25);
    const out = V(top.x, 0, top.z).normalize();
    const n = out.clone().multiplyScalar(0.6).add(V(0, 0.4, 0)).normalize();
    for (const k2 of [0, 1]) {
      const rt = horiz(a + k2 * Math.PI / 2);
      card(b, top.clone().add(V(0, -len, 0)), rt, V(0, 1, 0), len * 0.45, len, 'moss', col, 1.0, 0.6, n);
    }
  }
  return b.build();
}

/** Crape-myrtle bloom panicles: cards on the upper canopy leaf positions. */
export function blossomsFor(leaves: THREE.BufferGeometry, seed: number, count: number, sizeN: number, tint: THREE.Color): THREE.BufferGeometry {
  const b = new PlantBuilder();
  const R = rng(seed);
  const p = leaves.getAttribute('position') as THREE.BufferAttribute;
  let ymax = 0; for (let i = 0; i < p.count; i++) ymax = Math.max(ymax, p.getY(i));
  const cand: number[] = [];
  for (let i = 0; i < p.count; i += 4) if (p.getY(i) > ymax * 0.55) cand.push(i);
  if (!cand.length) return b.build();
  for (let k = 0; k < count; k++) {
    const i = cand[Math.floor(R() * cand.length)];
    const c = V(p.getX(i), p.getY(i), p.getZ(i));
    const out = V(c.x, 0.5, c.z).normalize();
    const s = sizeN * (0.7 + R() * 0.6);
    const a = R() * Math.PI;
    for (const k2 of [0, 1]) card(b, c.clone().add(V(0, -s * 0.3, 0)), horiz(a + k2 * Math.PI / 2), V(0, 1, 0), s, s, 'blossom', shade(tint, 0.85 + R() * 0.3), 0.5, 0.7, out);
  }
  return b.build();
}
