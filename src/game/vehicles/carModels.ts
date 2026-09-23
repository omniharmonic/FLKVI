// Procedural car models: a lofted body (stations along the length × a cross-section ring) gives smooth,
// car-like surfaces with wheel arches, tumblehome, a glass greenhouse and real panel reflections.
// Front of every model faces −Z. Origin = ground level under the car's center at rest ride height.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { PAL, palUV } from './palette';

export type CarModelId = 'sedan' | 'hatchback' | 'suv' | 'pickup' | 'van' | 'sports' | 'taxi' | 'police' | 'police-suv';
export const CAR_MODEL_IDS: CarModelId[] = ['sedan', 'hatchback', 'suv', 'pickup', 'van', 'sports', 'taxi', 'police', 'police-suv'];
/** Models used for random civilian traffic / parked cars. */
export const CIVILIAN_MODELS: CarModelId[] = ['sedan', 'sedan', 'hatchback', 'suv', 'suv', 'pickup', 'van', 'sports', 'hatchback', 'sedan'];

type Keys = [number, number][];

interface BodySpec {
  L: number;
  /** Max half width. */
  W: number;
  axleF: number; // distance from front tip
  axleR: number;
  wheelR: number;
  tireW: number;
  bottom: Keys;
  top: Keys;
  roof: Keys;
  /** Greenhouse base half-width as fraction of W. */
  cabin: number;
  tumble: number;
  windshield: [number, number];
  rearWindow?: [number, number];
  sideGlass: [number, number][];
  doors: [number, number][];
  noseR: number;
  tailR: number;
  rimStyle: 'spoke5' | 'spoke10' | 'steel';
  bulge: number;
  hoodCrown: number;
}

const SPECS: Record<'sedan' | 'hatchback' | 'suv' | 'pickup' | 'van' | 'sports', BodySpec> = {
  sedan: {
    L: 4.85, W: 0.915, axleF: 1.0, axleR: 3.82, wheelR: 0.335, tireW: 0.225,
    bottom: [[0, 0.34], [0.3, 0.25], [0.75, 0.2], [4.2, 0.2], [4.6, 0.3], [4.85, 0.4]],
    top: [[0, 0.7], [0.1, 0.79], [0.45, 0.855], [1.35, 0.965], [2.2, 0.99], [3.9, 1.04], [4.55, 1.05], [4.85, 0.95]],
    roof: [[1.33, 0.965], [2.25, 1.42], [2.55, 1.455], [3.15, 1.455], [3.5, 1.41], [4.08, 1.045]],
    cabin: 0.86, tumble: 0.34,
    windshield: [1.38, 2.25], rearWindow: [3.5, 4.02],
    sideGlass: [[1.62, 2.64], [2.76, 3.86]],
    doors: [[1.52, 2.7], [2.7, 3.72]],
    noseR: 0.14, tailR: 0.13, rimStyle: 'spoke5', bulge: 0.025, hoodCrown: 0.035,
  },
  hatchback: {
    L: 4.25, W: 0.89, axleF: 0.86, axleR: 3.44, wheelR: 0.32, tireW: 0.205,
    bottom: [[0, 0.34], [0.3, 0.24], [0.7, 0.19], [3.75, 0.2], [4.1, 0.3], [4.25, 0.4]],
    top: [[0, 0.7], [0.1, 0.79], [0.42, 0.86], [1.18, 0.97], [3.3, 1.0], [4.05, 1.0], [4.25, 0.94]],
    roof: [[1.16, 0.97], [2.02, 1.46], [2.35, 1.5], [3.55, 1.48], [3.95, 1.4], [4.12, 1.02]],
    cabin: 0.87, tumble: 0.3,
    windshield: [1.2, 2.02], rearWindow: [3.62, 4.08],
    sideGlass: [[1.42, 2.38], [2.5, 3.72]],
    doors: [[1.35, 2.44], [2.44, 3.38]],
    noseR: 0.13, tailR: 0.1, rimStyle: 'spoke10', bulge: 0.022, hoodCrown: 0.03,
  },
  suv: {
    L: 4.85, W: 0.97, axleF: 1.0, axleR: 3.88, wheelR: 0.38, tireW: 0.245,
    bottom: [[0, 0.46], [0.3, 0.36], [0.8, 0.31], [4.1, 0.31], [4.55, 0.38], [4.85, 0.5]],
    top: [[0, 0.9], [0.12, 1.0], [0.5, 1.06], [1.28, 1.12], [4.55, 1.19], [4.85, 1.1]],
    roof: [[1.26, 1.12], [2.02, 1.74], [2.3, 1.785], [4.4, 1.77], [4.62, 1.68], [4.74, 1.2]],
    cabin: 0.88, tumble: 0.26,
    windshield: [1.3, 2.02], rearWindow: [4.5, 4.72],
    sideGlass: [[1.45, 2.58], [2.7, 3.55], [3.66, 4.45]],
    doors: [[1.4, 2.64], [2.64, 3.62]],
    noseR: 0.12, tailR: 0.1, rimStyle: 'spoke5', bulge: 0.022, hoodCrown: 0.03,
  },
  pickup: {
    L: 5.35, W: 0.99, axleF: 1.05, axleR: 4.3, wheelR: 0.39, tireW: 0.255,
    bottom: [[0, 0.5], [0.3, 0.38], [0.8, 0.34], [4.9, 0.36], [5.35, 0.52]],
    top: [[0, 0.95], [0.12, 1.06], [0.5, 1.11], [1.33, 1.17], [3.2, 1.19], [5.25, 1.2], [5.35, 1.16]],
    roof: [[1.31, 1.17], [2.02, 1.8], [2.3, 1.84], [3.02, 1.84], [3.12, 1.72], [3.17, 1.19]],
    cabin: 0.88, tumble: 0.24,
    windshield: [1.35, 2.02],
    sideGlass: [[1.5, 2.3], [2.4, 3.02]],
    doors: [[1.42, 2.36], [2.36, 3.15]],
    noseR: 0.1, tailR: 0.06, rimStyle: 'steel', bulge: 0.025, hoodCrown: 0.02,
  },
  van: {
    L: 5.25, W: 0.99, axleF: 0.95, axleR: 4.25, wheelR: 0.36, tireW: 0.23,
    bottom: [[0, 0.42], [0.3, 0.31], [0.7, 0.27], [4.6, 0.28], [5.0, 0.34], [5.25, 0.44]],
    top: [[0, 0.86], [0.12, 0.97], [0.5, 1.05], [0.98, 1.1], [5.25, 1.12]],
    roof: [[0.96, 1.1], [1.78, 1.96], [2.1, 2.03], [4.95, 2.02], [5.12, 1.94], [5.2, 1.13]],
    cabin: 0.92, tumble: 0.12,
    windshield: [1.0, 1.78],
    sideGlass: [[1.15, 2.2]],
    doors: [[1.08, 2.28], [2.4, 3.6]],
    noseR: 0.12, tailR: 0.05, rimStyle: 'steel', bulge: 0.02, hoodCrown: 0.025,
  },
  sports: {
    L: 4.5, W: 0.955, axleF: 1.1, axleR: 3.64, wheelR: 0.345, tireW: 0.27,
    bottom: [[0, 0.24], [0.3, 0.16], [0.7, 0.13], [4.0, 0.14], [4.35, 0.24], [4.5, 0.3]],
    top: [[0, 0.56], [0.1, 0.63], [0.5, 0.71], [1.62, 0.86], [3.0, 0.91], [4.25, 0.95], [4.5, 0.87]],
    roof: [[1.6, 0.86], [2.48, 1.2], [2.78, 1.235], [3.08, 1.19], [4.1, 0.945]],
    cabin: 0.8, tumble: 0.42,
    windshield: [1.66, 2.48], rearWindow: [3.1, 3.95],
    sideGlass: [[1.9, 3.12]],
    doors: [[1.78, 3.02]],
    noseR: 0.15, tailR: 0.14, rimStyle: 'spoke10', bulge: 0.03, hoodCrown: 0.03,
  },
};

// ---------- Interpolation ----------

/** Monotone cubic (Fritsch–Carlson) interpolation over keyframes; clamps outside. */
function curve(keys: Keys) {
  const n = keys.length;
  const xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
  const d: number[] = [], m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ---------- Body loft ----------

const MAT_PAINT = 0, MAT_GLASS = 1, MAT_DARK = 2, MAT_TRIM = 3;
type Cat = 'under' | 'wellWall' | 'wellCeil' | 'side' | 'deck' | 'gSeal' | 'gSide' | 'gShoulder' | 'gTop';

function makeBodyFns(s: BodySpec) {
  const bottom = curve(s.bottom), top = curve(s.top), roofC = curve(s.roof);
  const r0 = s.roof[0][0], r1 = s.roof[s.roof.length - 1][0];
  const archR = s.wheelR + 0.065;
  const halfW = (d: number) => {
    const f = Math.max(0, 1 - d / 0.95), r = Math.max(0, 1 - (s.L - d) / 0.75);
    return s.W * (1 - 0.075 * f * f - 0.055 * r * r);
  };
  const inset = (d: number) => {
    const rn = s.noseR, rt = s.tailR;
    if (d < rn) { const u = rn - d; return rn - Math.sqrt(Math.max(0, rn * rn - u * u)); }
    if (d > s.L - rt) { const u = d - (s.L - rt); return rt - Math.sqrt(Math.max(0, rt * rt - u * u)); }
    return 0;
  };
  const archY = (d: number) => {
    for (const dc of [s.axleF, s.axleR]) {
      const u = d - dc;
      if (Math.abs(u) <= archR + 1e-6) return s.wheelR + Math.sqrt(Math.max(0, archR * archR - u * u));
    }
    return 0;
  };
  const roofH = (d: number) => (d <= r0 || d >= r1 ? 0 : Math.max(0, roofC(d) - top(d)));
  return { bottom, top, roofH, halfW, inset, archY, archR };
}

function ringAt(s: BodySpec, fns: ReturnType<typeof makeBodyFns>, d: number, lod = 0) {
  // lod 0 = full, 1 = far, 2 = very far / shadow hull (perf)
  const nArc = lod ? 1 : 3, nSide = lod === 2 ? 1 : lod ? 2 : 5, nG = lod ? 1 : 3, nTop = lod === 2 ? 1 : lod ? 2 : 4;
  const a = fns.inset(d);
  const w = fns.halfW(d) - a;
  const yb = fns.bottom(d) + a * 0.6;
  const yt = fns.top(d) - a * 0.85;
  const yLow = Math.min(Math.max(yb, fns.archY(d)), yt - 0.12);
  const wIn = w - 0.3;
  const rb = 0.05;
  const pts: [number, number][] = [];
  const cats: Cat[] = [];
  const bul = (y: number) => {
    // Side section: widest a bit below the belt, tucking under toward the sill.
    const ym = 0.45 * yLow + 0.55 * yt;
    const hs = Math.max(0.2, (yt - yLow) * 0.6);
    const u = (y - ym) / hs;
    return s.bulge * Math.min(1.6, u * u) + (y < ym ? s.bulge * 0.6 * ((ym - y) / hs) : 0);
  };
  const push = (x: number, y: number, c?: Cat) => { pts.push([x, y]); if (c) cats.push(c); };
  push(0, yb, 'under');
  push(wIn, yb, 'wellWall');
  push(wIn, yLow, 'wellCeil');
  const y0 = yLow + rb;
  const wl = w - bul(y0);
  push(wl - rb, yLow, 'side');
  for (let k = 1; k <= nArc; k++) {
    const t = (k / nArc) * Math.PI / 2;
    push(wl - rb + rb * Math.sin(t), y0 - rb * Math.cos(t), 'side');
  }
  const gh = fns.roofH(d);
  const rs = Math.min(0.075, (yt - y0) / 3);
  const y1 = yt - rs;
  for (let k = 1; k <= nSide; k++) {
    const y = y0 + ((y1 - y0) * k) / nSide;
    push(w - bul(y), y, 'side');
  }
  const wu = w - bul(y1);
  for (let k = 1; k <= nArc; k++) {
    const t = (k / nArc) * Math.PI / 2;
    push(wu - rs + rs * Math.cos(t), y1 + rs * Math.sin(t), k === nArc ? 'deck' : 'side');
  }
  // Greenhouse
  const gw = Math.min(s.W * s.cabin * (fns.halfW(d) / s.W), wu - rs - 0.02);
  const crownH = s.hoodCrown * Math.max(0, 1 - gh / 0.08);
  const crownR = 0.035 * Math.min(1, gh / 0.2);
  const cy = (x: number) => crownH * (1 - (x / w) ** 2);
  push(gw, yt + cy(gw), 'gSeal');
  const seal = Math.min(0.035, gh * 0.25);
  const gwTop = gw - gh * s.tumble;
  const rr = Math.min(0.065, gh * 0.3);
  const gSideTop = yt + gh - rr;
  const xs = gw - seal * s.tumble;
  push(xs, yt + seal + cy(xs), 'gSide');
  for (let k = 1; k <= nG; k++) {
    const t = k / nG;
    const y = yt + seal + (gSideTop - yt - seal) * t;
    const x = xs + (gwTop - xs) * t;
    push(x, y + cy(x), k === nG ? 'gShoulder' : 'gSide');
  }
  for (let k = 1; k <= nArc; k++) {
    const t = (k / nArc) * Math.PI / 2;
    const x = gwTop - rr + rr * Math.cos(t);
    push(x, gSideTop + rr * Math.sin(t) + cy(x), k === nArc ? 'gTop' : 'gShoulder');
  }
  const x0 = gwTop - rr;
  for (let k = 1; k <= nTop; k++) {
    const t = k / nTop;
    const x = x0 * (1 - t);
    const yRoof = yt + gh + crownR * (1 - (x / Math.max(0.01, x0)) ** 2);
    push(x, yRoof + cy(x), k === nTop ? undefined : 'gTop');
  }
  return { pts, cats, yb, yt, w };
}

function inRanges(d: number, rs: [number, number][]) {
  for (const r of rs) if (d > r[0] && d < r[1]) return true;
  return false;
}

function buildBodyGeometry(s: BodySpec, lod = 0) {
  const fns = makeBodyFns(s);
  // Stations
  const st: number[] = [];
  for (let d = 0; d <= s.L + 1e-6; d += lod === 2 ? 0.75 : lod ? 0.32 : 0.17) st.push(d);
  for (const e of lod === 2 ? [0.05] : lod ? [0.02, 0.08] : [0.005, 0.02, 0.045, 0.08, 0.12, 0.17, 0.24]) { st.push(e); st.push(s.L - e); }
  for (const dc of [s.axleF, s.axleR]) {
    const R = fns.archR;
    const na = lod === 2 ? 2 : lod ? 5 : 10;
    for (let k = 0; k <= na; k++) st.push(dc - R * Math.cos((k / na) * Math.PI));
    st.push(dc - R - 0.012, dc + R + 0.012);
  }
  const bps = [s.windshield[0], s.windshield[1], ...(s.rearWindow ?? []), ...s.sideGlass.flat(), s.roof[0][0], s.roof[s.roof.length - 1][0]];
  st.push(...bps);
  st.sort((a, b) => a - b);
  const stations: number[] = [];
  for (const d of st) {
    const c = Math.min(Math.max(d, 0), s.L);
    if (!stations.length || c - stations[stations.length - 1] > 0.006) stations.push(c);
    else if (bps.includes(d) || c === s.L) stations[stations.length - 1] = c;
  }
  const rings = stations.map((d) => ringAt(s, fns, d, lod));
  const M = rings[0].pts.length;
  const pos: number[] = [], uv: number[] = [];
  const groups: number[][] = [[], [], [], []];
  const half = s.L / 2;
  const U = (side: number, d: number) => (side > 0 ? 0.5 * (1 - d / s.L) : 0.5 + 0.5 * (d / s.L));
  const V = (y: number) => y / 2.2;
  let base = 0;
  for (const side of [1, -1]) {
    base = pos.length / 3;
    for (let i = 0; i < stations.length; i++) {
      const d = stations[i];
      for (const [x, y] of rings[i].pts) {
        pos.push(side * x, y, d - half);
        uv.push(U(side, d), V(y));
      }
    }
    for (let i = 0; i < stations.length - 1; i++) {
      const dm = (stations[i] + stations[i + 1]) / 2;
      for (let j = 0; j < M - 1; j++) {
        const cat = rings[i].cats[j];
        let m = MAT_PAINT;
        if (cat === 'under' || cat === 'wellWall' || cat === 'wellCeil') m = MAT_DARK;
        else if (cat === 'gSeal') m = inRanges(dm, s.sideGlass) ? MAT_TRIM : MAT_PAINT;
        else if (cat === 'gSide') m = inRanges(dm, s.sideGlass) ? MAT_GLASS : inRanges(dm, [[s.sideGlass[0][0], s.sideGlass[s.sideGlass.length - 1][1]]]) ? MAT_TRIM : MAT_PAINT;
        else if (cat === 'gTop') m = inRanges(dm, [s.windshield, ...(s.rearWindow ? [s.rearWindow] : [])]) ? MAT_GLASS : MAT_PAINT;
        const a = base + i * M + j, b = a + 1, c = a + M, dd = c + 1;
        if (side > 0) groups[m].push(a, b, c, b, dd, c);
        else groups[m].push(a, c, b, b, c, dd);
      }
    }
    // End caps (fans)
    for (const [ri, dir] of [[0, -1], [stations.length - 1, 1]] as const) {
      const ring = rings[ri];
      const cIdx = pos.length / 3;
      const d = stations[ri];
      pos.push(0, (ring.yb + ring.yt) / 2, d - half);
      uv.push(U(side, d), V((ring.yb + ring.yt) / 2));
      for (let j = 0; j < M - 1; j++) {
        const a = base + ri * M + j, b = a + 1;
        const flip = (dir < 0) !== (side < 0);
        const m = j < 3 ? MAT_DARK : MAT_PAINT;
        if (flip) groups[m].push(cIdx, b, a); else groups[m].push(cIdx, a, b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const idx: number[] = [];
  for (let m = 0; m < 4; m++) {
    geo.addGroup(idx.length, groups[m].length, m);
    idx.push(...groups[m]);
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Weld normals across the x=0 seam (the two halves have separate vertices for the UV atlas).
  const p = geo.attributes.position as THREE.BufferAttribute, n = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) < 1e-5) {
      const ny = n.getY(i), nz = n.getZ(i), l = Math.hypot(ny, nz) || 1;
      n.setXYZ(i, 0, ny / l, nz / l);
    }
  }
  return { geo, fns };
}

// ---------- Livery / detail textures ----------

type Livery = 'plain' | 'police' | 'taxi';

function detailTexture(s: BodySpec, livery: Livery, fns: ReturnType<typeof makeBodyFns>) {
  const Wpx = 2048, Hpx = 512;
  const cv = document.createElement('canvas');
  cv.width = Wpx; cv.height = Hpx;
  const x = cv.getContext('2d')!;
  const pxPerM = (Wpx / 2) / s.L;
  const Y = (y: number) => Hpx - (y / 2.2) * Hpx;
  // Draw in "right-side view" space for each half (front at right for right half; front at left for left half).
  const drawHalf = (ox: number, frontRight: boolean) => {
    const X = (d: number) => ox + (frontRight ? (1 - d / s.L) : d / s.L) * (Wpx / 2);
    x.save();
    x.beginPath(); x.rect(ox, 0, Wpx / 2, Hpx); x.clip();
    // base
    x.fillStyle = livery === 'police' ? '#0d0e10' : livery === 'taxi' ? '#f2c019' : '#ffffff';
    x.fillRect(ox, 0, Wpx / 2, Hpx);
    const sill = 0.3, belt = fns.top(2.2);
    if (livery === 'police') {
      // White doors + white roof, black hood/trunk/fenders.
      const d0 = s.doors[0][0] - 0.02, d1 = s.doors[s.doors.length - 1][1] + 0.02;
      x.fillStyle = '#f4f5f6';
      x.fillRect(Math.min(X(d0), X(d1)), Y(belt + 0.08), Math.abs(X(d1) - X(d0)), Y(0.0) - Y(belt + 0.08));
      x.fillRect(ox, 0, Wpx / 2, Y(fns.top(2.2) + 0.28));
      // POLICE text on the front door
      const dd = (s.doors[0][0] + s.doors[0][1]) / 2 + (s.doors.length > 1 ? 0.35 : 0);
      x.fillStyle = '#0d0e10';
      x.font = `bold ${Math.round(0.2 * pxPerM)}px "Arial Black", Arial, sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('POLICE', X(dd), Y(0.66), 1.25 * pxPerM);
      // thin reflective stripe
      x.fillStyle = '#9aa3ad';
      x.fillRect(Math.min(X(d0), X(d1)), Y(0.47), Math.abs(X(d1) - X(d0)), 0.025 * pxPerM);
    }
    if (livery === 'taxi') {
      // Checker band along the side (generic).
      const d0 = s.doors[0][0], d1 = s.doors[s.doors.length - 1][1];
      const sq = 0.06;
      for (let d = d0; d < d1; d += sq) for (let r = 0; r < 2; r++) {
        if ((Math.round((d - d0) / sq) + r) % 2) continue;
        x.fillStyle = '#111';
        x.fillRect(Math.min(X(d), X(d + sq)), Y(0.62 + (r + 1) * sq), sq * pxPerM + 1, sq * pxPerM + 1);
      }
      x.fillStyle = '#111';
      x.font = `bold ${Math.round(0.12 * pxPerM)}px Arial, sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      const dr = s.doors[s.doors.length - 1];
      x.fillText('CITY CAB', X((dr[0] + dr[1]) / 2), Y(0.45));
    }
    // Panel seams + handles.
    x.strokeStyle = livery === 'police' ? 'rgba(0,0,0,0.9)' : 'rgba(10,10,12,0.8)';
    x.lineWidth = Math.max(2, 0.006 * pxPerM);
    for (const [a, b] of s.doors) {
      x.beginPath();
      x.moveTo(X(a), Y(sill)); x.lineTo(X(a), Y(belt + 0.02));
      x.moveTo(X(b), Y(sill)); x.lineTo(X(b), Y(belt + 0.02));
      x.moveTo(X(a), Y(sill + 0.02)); x.lineTo(X(b), Y(sill + 0.02));
      x.stroke();
      // handle
      const hx = X(b - 0.22), hy = Y(belt - 0.1);
      x.fillStyle = 'rgba(20,20,22,0.85)';
      x.fillRect(Math.min(hx, X(b - 0.06)), hy - 0.012 * pxPerM, 0.16 * pxPerM, 0.028 * pxPerM);
    }
    // Hood seam (cowl) and front bumper split.
    x.beginPath();
    const cowl = s.windshield[0] - 0.05;
    x.moveTo(X(cowl), Y(belt + 0.1)); x.lineTo(X(cowl), Y(2.2));
    x.moveTo(X(0.22), Y(fns.top(0.22) - 0.02)); x.lineTo(X(0.22), Y(fns.top(0.22) + 0.3));
    x.moveTo(X(s.L - 0.18), Y(fns.top(s.L - 0.18) - 0.02)); x.lineTo(X(s.L - 0.18), Y(fns.top(s.L - 0.18) + 0.3));
    x.stroke();
    // Fuel door (right side of image half only: rear quarter).
    x.strokeRect(Math.min(X(s.axleR - 0.55), X(s.axleR - 0.4)), Y(belt - 0.08), 0.15 * pxPerM, 0.15 * pxPerM);
    // Subtle lower-body grime gradient.
    const gr = x.createLinearGradient(0, Y(0.55), 0, Y(0.15));
    gr.addColorStop(0, 'rgba(60,55,50,0)'); gr.addColorStop(1, 'rgba(60,55,50,0.35)');
    x.fillStyle = gr; x.fillRect(ox, Y(0.55), Wpx / 2, Y(0.15) - Y(0.55));
    // Road spray: speckled dirt thrown up behind each wheel and along the sills.
    let sd = 1234 + ox;
    const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    for (const dc of [s.axleF, s.axleR]) {
      for (let k = 0; k < 900; k++) {
        const u = rnd(), v = rnd();
        const d = dc + 0.15 + u * 0.9 * (1 - v * 0.5), y = 0.18 + v * v * 0.45;
        x.fillStyle = `rgba(${70 + rnd() * 30},${62 + rnd() * 25},${52 + rnd() * 20},${0.08 + (1 - v) * 0.22 * (1 - u)})`;
        const r = 0.6 + rnd() * 1.8;
        x.fillRect(X(d), Y(y), r, r);
      }
    }
    x.restore();
  };
  drawHalf(0, true);
  drawHalf(Wpx / 2, false);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------- Wheels ----------

function buildLod(s: BodySpec, wheelPos: THREE.Vector3[], head: THREE.BufferGeometry[], tail: THREE.BufferGeometry[]) {
  const body = buildBodyGeometry(s, 1).geo;
  const tires: THREE.BufferGeometry[] = [], rims: THREE.BufferGeometry[] = [];
  for (const p of wheelPos) {
    const t = new THREE.CylinderGeometry(s.wheelR, s.wheelR, s.tireW, 12, 1);
    t.rotateZ(Math.PI / 2);
    t.translate(p.x, p.y, p.z);
    tires.push(t);
    const r = new THREE.CircleGeometry(s.wheelR * 0.62, 10);
    r.rotateY(p.x > 0 ? Math.PI / 2 : -Math.PI / 2);
    r.translate(p.x + Math.sign(p.x) * (s.tireW / 2 + 0.003), p.y, p.z);
    rims.push(r);
  }
  const wheels = mergeGeometries([mergeGeometries(tires.map(stripAttrs))!, mergeGeometries(rims.map(stripAttrs))!], true)!;
  const h = mergeGeometries(head.map(stripAttrs))!, t = mergeGeometries(tail.map(stripAttrs))!;
  const c = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  return { body, wheels, head: h, tail: t, tris: c(body) + c(wheels) + c(h) + c(t) };
}

function buildWheel(R: number, tw: number, style: BodySpec['rimStyle']) {
  const rimR = R * 0.64;
  const prof: THREE.Vector2[] = [];
  const hw = tw / 2;
  const tireProfile: [number, number][] = [
    [rimR - 0.005, -hw + 0.012], [R - 0.05, -hw - 0.004], [R - 0.022, -hw + 0.004], [R - 0.004, -hw + 0.026],
    [R, -hw + 0.045], [R - 0.006, -hw * 0.35], [R, -hw * 0.3], [R, hw * 0.3], [R - 0.006, hw * 0.35],
    [R, hw - 0.045], [R - 0.004, hw - 0.026], [R - 0.022, hw - 0.004], [R - 0.05, hw + 0.004], [rimR - 0.005, hw - 0.012],
  ];
  for (const [r, y] of tireProfile) prof.push(new THREE.Vector2(r, y));
  const tire = new THREE.LatheGeometry(prof, 22);
  const yf = hw - 0.018;
  const rimProf: [number, number][] = style === 'steel'
    ? [[0.001, yf - 0.005], [0.07, yf - 0.006], [0.085, yf - 0.02], [rimR - 0.06, yf - 0.035], [rimR - 0.035, yf - 0.012], [rimR - 0.012, yf + 0.004], [rimR, yf], [rimR, -hw + 0.02]]
    : [[0.001, yf + 0.006], [0.045, yf + 0.006], [0.055, yf - 0.002], [rimR - 0.018, yf - 0.004], [rimR - 0.006, yf + 0.004], [rimR, yf], [rimR, -hw + 0.02]];
  const rim = new THREE.LatheGeometry(rimProf.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 22);
  const parts: THREE.BufferGeometry[] = [];
  const darkParts: THREE.BufferGeometry[] = [];
  if (style !== 'steel') {
    // Spoked alloy: dark dish recessed behind spokes.
    const dish = new THREE.CylinderGeometry(rimR - 0.012, rimR - 0.012, 0.01, 22, 1);
    dish.translate(0, yf - 0.07, 0);
    darkParts.push(dish);
    const nSp = style === 'spoke5' ? 5 : 10;
    const sw = style === 'spoke5' ? 0.05 : 0.026;
    for (let k = 0; k < nSp; k++) {
      const len = rimR - 0.05;
      const b = new THREE.BoxGeometry(sw, 0.05, len, 1, 1, 1);
      // radial along +Z in the (x,z) lathe plane before axis rotation; tilt so outer end sits deeper
      b.translate(0, 0, 0.04 + len / 2);
      b.rotateX(0.06);
      b.translate(0, yf - 0.018, 0);
      b.rotateY((k / nSp) * Math.PI * 2);
      parts.push(b);
    }
    const hub = new THREE.CylinderGeometry(0.06, 0.07, 0.03, 20);
    hub.translate(0, yf - 0.005, 0);
    parts.push(hub);
    // Strip the non-lathe parts so the rim geometry matches: the dish replaces the flat lathe face.
    const rimOuter = new THREE.LatheGeometry(
      ([[rimR - 0.02, yf - 0.02], [rimR - 0.006, yf + 0.004], [rimR, yf], [rimR, -hw + 0.02]] as [number, number][])
        .map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 22);
    rim.dispose();
    parts.push(rimOuter);
  } else {
    parts.push(rim);
    // lug nuts
    for (let k = 0; k < 5; k++) {
      const c = new THREE.CylinderGeometry(0.012, 0.012, 0.02, 6);
      const a = (k / 5) * Math.PI * 2;
      c.translate(Math.cos(a) * 0.055, yf, Math.sin(a) * 0.055);
      parts.push(c);
    }
    const cap = new THREE.CylinderGeometry(0.04, 0.045, 0.02, 16);
    cap.translate(0, yf + 0.004, 0);
    parts.push(cap);
  }
  const strip = (g: THREE.BufferGeometry) => {
    const ng = g.index ? g : g;
    for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'uv'].includes(k)) ng.deleteAttribute(k);
    return ng;
  };
  const rimGeo = mergeGeometries(parts.map(strip))!;
  const darkGeo = darkParts.length ? mergeGeometries(darkParts.map(strip))! : null;
  // Axis: lathe Y → wheel axle +X (outer face toward +X).
  const all: THREE.BufferGeometry[] = [tire, rimGeo];
  if (darkGeo) all.push(darkGeo);
  for (const g of all) g.rotateZ(-Math.PI / 2);
  const merged = mergeGeometries(all.map(strip), true)!;
  return merged; // groups: 0 tire, 1 rim, 2 dark dish (optional)
}

// ---------- Surface-projected patches ----------

function pointInRing(pts: [number, number][], x: number, y: number) {
  // Right half ring (x>=0) closed along x=0.
  const ax = Math.abs(x);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && ax < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Station d where the body surface is first hit from the front (or rear) at (x, y). */
function surfaceD(s: BodySpec, fns: ReturnType<typeof makeBodyFns>, x: number, y: number, rear: boolean, lod = 0) {
  const inside = (d: number) => pointInRing(ringAt(s, fns, d, lod).pts, x, y);
  const step = 0.01;
  let prev = rear ? s.L : 0;
  for (let k = 0; k <= 80; k++) {
    const d = rear ? s.L - k * step : k * step;
    if (inside(d)) {
      let a = prev, b = d;
      for (let i = 0; i < 10; i++) { const m = (a + b) / 2; if (inside(m)) b = m; else a = m; }
      return b;
    }
    prev = d;
  }
  return NaN;
}

/**
 * Bilinear patch over 4 (x,y) corners (CCW as seen from outside), projected along Z onto the front (or rear)
 * surface and offset outward. UV = patch (u,v).
 */
function projectPatch(s: BodySpec, fns: ReturnType<typeof makeBodyFns>, c: [number, number][], nu: number, nv: number, rear: boolean, off: number, lod = 0) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const half = s.L / 2;
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv;
      let bx = (1 - v) * ((1 - u) * c[0][0] + u * c[1][0]) + v * ((1 - u) * c[3][0] + u * c[2][0]);
      const by = (1 - v) * ((1 - u) * c[0][1] + u * c[1][1]) + v * ((1 - u) * c[3][1] + u * c[2][1]);
      let d = surfaceD(s, fns, bx, by, rear, lod);
      // Outside the silhouette: pull the vertex inward until it lands on the body.
      for (let k = 0; k < 30 && Number.isNaN(d); k++) { bx *= 0.97; d = surfaceD(s, fns, bx, by, rear, lod); }
      if (Number.isNaN(d)) d = rear ? s.L : 0;
      pos.push(bx, by, d - half + (rear ? off : -off));
      uv.push(u, v);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, cc = a + nu + 1, dd = cc + 1;
    idx.push(a, b, dd, a, dd, cc);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- Model assembly ----------

export interface CarModel {
  id: CarModelId;
  spec: BodySpec;
  L: number;
  W: number;
  height: number;
  body: THREE.BufferGeometry; // groups: paint, glass, dark, trim
  paintMap: THREE.Texture;
  /** Extra paint-colored parts (mirrors). */
  paintParts: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry | null;
  grille: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  reverse: THREE.BufferGeometry;
  plate: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  /** Wheel centers at rest (FL, FR, RL, RR); left side = −X. */
  wheelPos: THREE.Vector3[];
  wheelR: number;
  lightbar?: { base: THREE.BufferGeometry; red: THREE.BufferGeometry; blue: THREE.BufferGeometry; redPos: THREE.Vector3; bluePos: THREE.Vector3 };
  taxiSign?: THREE.BufferGeometry;
  /** Cabin interior (seats, dash, wheel, trim shell), palette-UV'd (see palette.ts). */
  interior: THREE.BufferGeometry;
  /** Seated driver figures (palette-UV'd), a few skin/shirt variants. */
  drivers: THREE.BufferGeometry[];
  /** Amber turn-signal lenses; groups: 0 = left (−X), 1 = right (+X). */
  signals: THREE.BufferGeometry;
  livery: Livery;
  /** Collider: half extents and center (chassis local). */
  colHalf: THREE.Vector3;
  colCenter: THREE.Vector3;
  /** Cabin collider (upper box). */
  cabHalf: THREE.Vector3;
  cabCenter: THREE.Vector3;
  driverSeat: THREE.Vector3;
  driverDoor: THREE.Vector3;
  headlightPos: THREE.Vector3[];
  hoodPos: THREE.Vector3;
  roofY: number;
  tris: number;
  /** Far LOD: coarse body (same 4 groups), 4 merged wheels (groups tire/rim), head/tail lamps. */
  lod: { body: THREE.BufferGeometry; wheels: THREE.BufferGeometry; head: THREE.BufferGeometry; tail: THREE.BufferGeometry; tris: number };
  /** Very-far LOD body (same 4 groups, ~1/3 of lod.body's triangles): distant parked cars + shadow hulls. */
  lod2: { body: THREE.BufferGeometry };
}

function rbox(w: number, h: number, d: number, r: number, seg = 1) {
  const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return g;
}

function stripAttrs(g: THREE.BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.index) {
    const n = g.attributes.position.count;
    g.setIndex([...Array(n).keys()]);
  }
  return g;
}
function merge(gs: THREE.BufferGeometry[]) {
  return mergeGeometries(gs.map(stripAttrs), false)!;
}

const modelCache = new Map<CarModelId, CarModel>();

export function getCarModel(id: CarModelId): CarModel {
  let m = modelCache.get(id);
  if (!m) { m = buildCarModel(id); modelCache.set(id, m); }
  return m;
}

function buildCarModel(id: CarModelId): CarModel {
  const baseId = id === 'taxi' || id === 'police' ? 'sedan' : id === 'police-suv' ? 'suv' : id;
  const s = SPECS[baseId];
  const livery: Livery = id === 'police' || id === 'police-suv' ? 'police' : id === 'taxi' ? 'taxi' : 'plain';
  const { geo: body, fns } = buildBodyGeometry(s);
  const half = s.L / 2;
  const Z = (d: number) => d - half;
  const paintMap = detailTexture(s, livery, fns);

  // Lights, grille, intakes: patches projected onto the body surface so they sit flush.
  const headParts: THREE.BufferGeometry[] = [], tailParts: THREE.BufferGeometry[] = [], revParts: THREE.BufferGeometry[] = [];
  const trimParts: THREE.BufferGeometry[] = [], chromeParts: THREE.BufferGeometry[] = [], paintParts: THREE.BufferGeometry[] = [];
  const grilleParts: THREE.BufferGeometry[] = [];
  const lodHead: THREE.BufferGeometry[] = [], lodTail: THREE.BufferGeometry[] = [];
  const headlightPos: THREE.Vector3[] = [];
  const tall = baseId === 'suv' || baseId === 'pickup' || baseId === 'van';
  const wF = fns.halfW(0.3), wR = fns.halfW(s.L - 0.3);
  const ytF = fns.top(0.02) - s.noseR * 0.85, ybF = fns.bottom(0.02) + s.noseR * 0.6;
  const ytR = fns.top(s.L - 0.02) - s.tailR * 0.85, ybR = fns.bottom(s.L - 0.02) + s.tailR * 0.6;
  for (const sx of [-1, 1]) {
    // Headlight: sleek trapezoid wrapping the front corner.
    const hTop = fns.top(0.05) - (tall ? 0.03 : 0.02);
    const hh = baseId === 'sports' ? 0.07 : tall ? 0.15 : 0.1;
    const inner = baseId === 'sports' ? wF - 0.52 : wF - 0.56;
    const q = (x: number, y: number) => [sx * x, y] as [number, number];
    const hc: [number, number][] = sx < 0
      ? [q(inner, hTop - hh), q(wF + 0.02, hTop - hh * 1.1), q(wF + 0.03, hTop), q(inner, hTop - hh * 0.15)]
      : [q(wF + 0.02, hTop - hh * 1.1), q(inner, hTop - hh), q(inner, hTop - hh * 0.15), q(wF + 0.03, hTop)];
    headParts.push(projectPatch(s, fns, hc, 8, 3, false, 0.006));
    lodHead.push(projectPatch(s, fns, hc, 3, 1, false, 0.02, 1));
    headlightPos.push(new THREE.Vector3(sx * (inner + wF) / 2, hTop - hh / 2, Z(0.0)));
    // Taillight: wraps the rear corner. Tall vehicles: vertical lamps.
    const tTop = tall ? ytR - 0.02 : fns.top(s.L - 0.05) - 0.03;
    const th = tall ? (baseId === 'suv' ? 0.34 : 0.42) : 0.14;
    const tIn = tall ? wR - 0.16 : wR - 0.5;
    const tq = (x: number, y: number) => [sx * x, y] as [number, number];
    const quad = (x0: number, x1: number, y0: number, y1: number): [number, number][] => sx < 0
      ? [tq(x1, y0), tq(x0, y0), tq(x0, y1), tq(x1, y1)]
      : [tq(x0, y0), tq(x1, y0), tq(x1, y1), tq(x0, y1)];
    // quads are built as seen from behind (−sx side appears on the left)
    tailParts.push(projectPatch(s, fns, quad(tIn, wR + 0.03, tTop - th, tTop), 6, 3, true, 0.006));
    lodTail.push(projectPatch(s, fns, quad(tIn, wR + 0.03, tTop - th, tTop), 2, 1, true, 0.02, 1));
    if (tall) revParts.push(projectPatch(s, fns, quad(tIn + 0.01, wR - 0.02, tTop - th - 0.1, tTop - th - 0.01), 3, 2, true, 0.006));
    else revParts.push(projectPatch(s, fns, quad(tIn - 0.16, tIn - 0.01, tTop - th * 0.8, tTop - th * 0.2), 3, 2, true, 0.006));
  }
  // Rear light bar for sedans/sports (connecting strip)
  if (baseId === 'sedan' || baseId === 'sports') {
    const tTop = fns.top(s.L - 0.05) - 0.07;
    tailParts.push(projectPatch(s, fns, [[-(wR - 0.66), tTop - 0.025], [wR - 0.66, tTop - 0.025], [wR - 0.66, tTop], [-(wR - 0.66), tTop]], 6, 1, true, 0.005));
  }
  {
    // Grille (textured mesh) with chrome surround line
    const gTop = fns.top(0.04) - (tall ? 0.06 : 0.09);
    const gh = tall ? 0.3 : baseId === 'sports' ? 0.06 : 0.14;
    const gw = tall ? wF - 0.5 : wF - 0.58;
    grilleParts.push(projectPatch(s, fns, [[gw, gTop - gh], [-gw, gTop - gh], [-gw, gTop], [gw, gTop]], 6, 3, false, 0.006));
    chromeParts.push(projectPatch(s, fns, [[gw + 0.02, gTop], [-gw - 0.02, gTop], [-gw - 0.02, gTop + 0.018], [gw + 0.02, gTop + 0.018]], 6, 1, false, 0.008));
    if (tall) {
      for (let k = 1; k < 3; k++) {
        const y = gTop - (gh * k) / 3;
        chromeParts.push(projectPatch(s, fns, [[gw, y - 0.012], [-gw, y - 0.012], [-gw, y + 0.012], [gw, y + 0.012]], 4, 1, false, 0.01));
      }
    }
    // Lower intake
    const iTop = ybF + (tall ? 0.2 : 0.17);
    const iw = wF - (baseId === 'sports' ? 0.3 : 0.42);
    grilleParts.push(projectPatch(s, fns, [[iw, ybF + 0.05], [-iw, ybF + 0.05], [-iw, iTop], [iw, iTop]], 8, 2, false, 0.006));
    // Fog-light style corner inserts
    for (const sx of [-1, 1]) {
      const x0 = iw + 0.06, x1 = wF - 0.06;
      if (x1 - x0 > 0.08) trimParts.push(projectPatch(s, fns, sx > 0 ? [[x1, ybF + 0.07], [x0, ybF + 0.07], [x0, iTop - 0.03], [x1, iTop - 0.03]] : [[-x0, ybF + 0.07], [-x1, ybF + 0.07], [-x1, iTop - 0.03], [-x0, iTop - 0.03]], 3, 2, false, 0.005));
    }
    // Rear diffuser / lower valance
    const rTop = ybR + 0.12;
    trimParts.push(projectPatch(s, fns, [[-(wR - 0.12), ybR + 0.02], [wR - 0.12, ybR + 0.02], [wR - 0.12, rTop], [-(wR - 0.12), rTop]], 8, 2, true, 0.005));
    // side sills / rocker trim
    for (const sx of [-1, 1]) {
      const len = s.axleR - s.axleF - 2 * fns.archR - 0.05;
      const r = rbox(0.05, 0.07, len, 0.02);
      r.translate(sx * (s.W - 0.05), fns.bottom(2) + 0.06, Z((s.axleF + s.axleR) / 2));
      trimParts.push(r);
    }
  }
  // Mirrors
  for (const sx of [-1, 1]) {
    const md = s.windshield[0] + 0.2;
    const my = fns.top(md) + 0.12;
    const mx = fns.halfW(md) + 0.05;
    const hsg = rbox(0.2, 0.12, 0.11, 0.04);
    hsg.translate(sx * (mx + 0.04), my, Z(md));
    paintParts.push(hsg);
    const glass = rbox(0.17, 0.09, 0.02, 0.008);
    glass.translate(sx * (mx + 0.04), my, Z(md) + 0.055);
    trimParts.push(glass);
    const stalk = rbox(0.12, 0.03, 0.05, 0.01);
    stalk.translate(sx * (mx - 0.06), my - 0.03, Z(md) + 0.01);
    trimParts.push(stalk);
  }
  // Wipers
  {
    const wd = s.windshield[0] + 0.06;
    for (const sx of [-0.35, 0.25]) {
      const w = rbox(0.55, 0.012, 0.018, 0.004);
      w.rotateY(0.1);
      w.translate(sx, fns.top(wd) + fns.roofH(wd) + 0.01, Z(wd));
      trimParts.push(w);
    }
  }
  // Roof rails for SUVs / vans
  if (baseId === 'suv') {
    for (const sx of [-1, 1]) {
      const a = 2.45, b = 4.35;
      const rail = rbox(0.035, 0.035, b - a, 0.012);
      rail.translate(sx * (s.W * s.cabin - 0.08 - 1.75 * 0.0), fns.top(3) + fns.roofH(3) + 0.035, Z((a + b) / 2));
      trimParts.push(rail);
    }
  }
  // Black plastic wheel-arch flares on SUVs / pickups.
  if (baseId === 'suv' || baseId === 'pickup') {
    for (const sx of [-1, 1]) for (const dc of [s.axleF, s.axleR]) {
      const fl = new THREE.TorusGeometry(fns.archR + 0.025, 0.035, 4, 14, Math.PI);
      fl.scale(1, 1, 0.9);
      fl.rotateY(Math.PI / 2);
      fl.translate(sx * (fns.halfW(dc) - 0.02), s.wheelR, Z(dc));
      trimParts.push(fl);
    }
  }
  // Pickup bed cover + tailgate handle
  if (baseId === 'pickup') {
    const a = 3.26, b = 5.28;
    const cov = rbox((s.W - 0.1) * 2, 0.04, b - a, 0.015);
    cov.translate(0, fns.top(4) + 0.01, Z((a + b) / 2));
    trimParts.push(cov);
    const bump = rbox(s.W * 2 - 0.1, 0.12, 0.14, 0.03);
    bump.translate(0, fns.bottom(s.L - 0.1) + 0.12, Z(s.L - 0.02));
    chromeParts.push(bump);
    const fb = rbox(s.W * 2 - 0.12, 0.13, 0.12, 0.03);
    fb.translate(0, fns.bottom(0.05) + 0.12, Z(0.02));
    chromeParts.push(fb);
  }
  // Police push bar
  if (livery === 'police') {
    const y0 = fns.bottom(0) + 0.08;
    for (const sx of [-0.32, 0.32]) {
      const up = rbox(0.06, 0.52, 0.06, 0.02);
      up.translate(sx, y0 + 0.28, Z(-0.1));
      trimParts.push(up);
    }
    const cross = rbox(0.85, 0.06, 0.06, 0.02);
    cross.translate(0, y0 + 0.36, Z(-0.1));
    trimParts.push(cross);
    const cross2 = rbox(0.85, 0.05, 0.06, 0.02);
    cross2.translate(0, y0 + 0.12, Z(-0.1));
    trimParts.push(cross2);
    for (const sx of [-0.32, 0.32]) {
      const arm = rbox(0.05, 0.05, 0.2, 0.02);
      arm.translate(sx, y0 + 0.2, Z(0.0));
      trimParts.push(arm);
    }
  }
  // Plates (front + rear): UV cell 0 of the atlas.
  const plateParts: THREE.BufferGeometry[] = [];
  {
    const mk = (d: number, y: number, rear: boolean) => {
      const p = new THREE.PlaneGeometry(0.305, 0.152);
      const uv = p.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.25, 0.75 + uv.getY(i) * 0.25);
      if (!rear) p.rotateY(Math.PI);
      p.translate(0, y, Z(d) + (rear ? 0.012 : -0.012));
      plateParts.push(p);
      const back = rbox(0.33, 0.17, 0.02, 0.006);
      back.translate(0, y, Z(d));
      trimParts.push(back);
    };
    mk(0.0, fns.bottom(0) + 0.2, false);
    const rearD = s.L;
    mk(rearD, baseId === 'pickup' ? fns.bottom(rearD) + 0.28 : fns.top(rearD) - 0.28, true);
  }
  // Lightbar
  let lightbar: CarModel['lightbar'];
  let roofY = 0;
  {
    const rd = (s.roof[1][0] + s.roof[s.roof.length - 2][0]) / 2;
    roofY = fns.top(rd) + fns.roofH(rd) + 0.035;
  }
  if (livery === 'police') {
    const rd = s.roof[1][0] + 0.45;
    const ry = fns.top(rd) + fns.roofH(rd) + 0.03;
    const base = merge([
      (() => { const g = rbox(1.25, 0.05, 0.3, 0.02); g.translate(0, ry + 0.035, Z(rd)); return g; })(),
      (() => { const g = rbox(0.2, 0.09, 0.28, 0.02); g.translate(0, ry + 0.09, Z(rd)); return g; })(),
      ...[-0.5, 0.5].map((sx) => { const g = rbox(0.06, 0.04, 0.3, 0.01); g.translate(sx, ry, Z(rd)); return g; }),
    ]);
    const lens = (sx: number) => {
      const g = rbox(0.5, 0.085, 0.27, 0.035, 3);
      g.translate(sx * 0.36, ry + 0.095, Z(rd));
      return g;
    };
    lightbar = { base, red: lens(-1), blue: lens(1), redPos: new THREE.Vector3(-0.36, ry + 0.1, Z(rd)), bluePos: new THREE.Vector3(0.36, ry + 0.1, Z(rd)) };
  }
  let taxiSign: THREE.BufferGeometry | undefined;
  if (livery === 'taxi') {
    const rd = (s.roof[1][0] + s.roof[2][0]) / 2 + 0.25;
    const ry = fns.top(rd) + fns.roofH(rd) + 0.02;
    const g = rbox(0.62, 0.2, 0.16, 0.04, 3);
    g.translate(0, ry + 0.11, Z(rd));
    taxiSign = g;
  }

  const wheel = buildWheel(s.wheelR, s.tireW, s.rimStyle);
  const wx = s.W - 0.035 - s.tireW / 2;
  const wheelPos = [
    new THREE.Vector3(-wx, s.wheelR, Z(s.axleF)), new THREE.Vector3(wx, s.wheelR, Z(s.axleF)),
    new THREE.Vector3(-wx, s.wheelR, Z(s.axleR)), new THREE.Vector3(wx, s.wheelR, Z(s.axleR)),
  ];

  const belt = fns.top(2.4);
  const yb = fns.bottom(2);
  const colBottom = yb + 0.08;
  const colHalf = new THREE.Vector3(s.W - 0.02, (belt - colBottom) / 2, s.L / 2 - 0.05);
  const colCenter = new THREE.Vector3(0, colBottom + colHalf.y, 0);
  const r0 = s.roof[0][0], r1 = s.roof[s.roof.length - 1][0];
  const cabTop = roofY;
  const cabHalf = new THREE.Vector3(s.W * s.cabin - 0.08, (cabTop - belt) / 2, (r1 - r0) / 2 * 0.8);
  const cabCenter = new THREE.Vector3(0, belt + cabHalf.y, Z((r0 + r1) / 2));

  // Turn signals: small amber lenses under the headlight corners and below the tail lamps.
  const sigL: THREE.BufferGeometry[] = [], sigR: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    const out = sx < 0 ? sigL : sigR;
    const hTop = fns.top(0.05) - (tall ? 0.03 : 0.02);
    const hh = baseId === 'sports' ? 0.07 : tall ? 0.15 : 0.1;
    const y1 = hTop - hh * 1.1 - 0.012, y0 = y1 - 0.045;
    const x0 = wF - 0.22, x1 = wF + 0.02;
    out.push(projectPatch(s, fns, sx > 0 ? [[x1, y0], [x0, y0], [x0, y1], [x1, y1]] : [[-x0, y0], [-x1, y0], [-x1, y1], [-x0, y1]], 3, 1, false, 0.007));
    const tTop = tall ? ytR - 0.02 : fns.top(s.L - 0.05) - 0.03;
    const th = tall ? (baseId === 'suv' ? 0.34 : 0.42) : 0.14;
    const ry1 = tall ? tTop - th - 0.11 : tTop - th - 0.012, ry0 = ry1 - 0.05;
    const rx0 = wR - (tall ? 0.16 : 0.3), rx1 = wR + 0.02;
    out.push(projectPatch(s, fns, sx < 0 ? [[-rx1, ry0], [-rx0, ry0], [-rx0, ry1], [-rx1, ry1]] : [[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]], 3, 1, true, 0.007));
  }
  const signals = mergeGeometries([merge(sigL), merge(sigR)], true)!;
  const { interior, drivers } = buildInterior(s, fns, baseId, livery);

  const model: CarModel = {
    id, spec: s, L: s.L, W: s.W, height: cabTop,
    body, paintMap,
    paintParts: merge(paintParts), trim: merge(trimParts),
    chrome: chromeParts.length ? merge(chromeParts) : null,
    grille: merge(grilleParts),
    head: merge(headParts), tail: merge(tailParts), reverse: merge(revParts), plate: merge(plateParts),
    wheel, wheelPos, wheelR: s.wheelR,
    lightbar, taxiSign, livery, interior, drivers, signals,
    colHalf, colCenter, cabHalf, cabCenter,
    driverSeat: new THREE.Vector3(-0.38, belt - 0.35, Z(s.windshield[1] + 0.35)),
    driverDoor: new THREE.Vector3(-(s.W + 0.75), 0, Z(s.doors[0][0] + 0.5)),
    headlightPos,
    hoodPos: new THREE.Vector3(0, fns.top(0.6) + 0.02, Z(0.6)),
    roofY, tris: 0,
    lod: buildLod(s, wheelPos, lodHead, lodTail),
    lod2: { body: buildBodyGeometry(s, 2).geo },
  };
  const count = (g: THREE.BufferGeometry | null | undefined) => (g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0);
  model.tris = count(body) + count(model.paintParts) + count(model.trim) + count(model.chrome) + count(model.grille) + count(model.head) + count(model.tail)
    + count(model.reverse) + count(model.plate) + 4 * count(wheel) + (lightbar ? count(lightbar.base) + count(lightbar.red) * 2 : 0) + count(taxiSign)
    + count(interior) + count(drivers[0]) + count(signals);
  return model;
}

// ---------- Interior + driver ----------

/** Box from a to b (thickness tx × ty), palette colored. */
function limb(a: THREE.Vector3, b: THREE.Vector3, tx: number, ty: number, cell: number) {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(tx, ty, len);
  const m = new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 1, 0));
  g.applyMatrix4(m);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return palUV(g, cell);
}
function pbox(w: number, h: number, d: number, x: number, y: number, z: number, cell: number, rx = 0, r = 0.02) {
  const g = r > 0 ? rbox(w, h, d, r) : new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  return palUV(stripAttrs(g), cell);
}

function buildInterior(s: BodySpec, fns: ReturnType<typeof makeBodyFns>, baseId: string, livery: Livery) {
  const half = s.L / 2;
  const Z = (d: number) => d - half;
  const parts: THREE.BufferGeometry[] = [];
  const sports = baseId === 'sports';
  const floorY = fns.bottom(2) + 0.08;
  const yH = floorY + (sports ? 0.13 : baseId === 'suv' || baseId === 'pickup' || baseId === 'van' ? 0.26 : 0.2);
  const dF = s.windshield[1] + (sports ? 0.25 : 0.2);
  const belt = fns.top(dF);
  const iw = s.W * s.cabin - 0.07;
  const seatCell = livery === 'police' || livery === 'taxi' ? PAL.seatDark : baseId === 'sedan' ? PAL.seatBeige : baseId === 'suv' || baseId === 'van' ? PAL.seatGrey : PAL.seatDark;
  const glassH = (d: number) => fns.top(d) + fns.roofH(d);
  const seat = (x: number, d: number, w: number) => {
    parts.push(pbox(w, 0.13, 0.5, x, yH, Z(d - 0.02), seatCell, 0.08));
    parts.push(pbox(w * 0.96, 0.62, 0.13, x, yH + 0.33, Z(d + 0.27), seatCell, -0.22, 0.04));
    parts.push(pbox(w * 0.5, 0.17, 0.1, x, yH + 0.72, Z(d + 0.36), seatCell, -0.15, 0.035));
  };
  const rearSeats = s.doors.length > 1 && baseId !== 'van';
  const dR = dF + (baseId === 'pickup' ? 0.82 : 0.92);
  seat(-0.37, dF, 0.5);
  seat(0.37, dF, 0.5);
  if (rearSeats) {
    parts.push(pbox(iw * 2 - 0.1, 0.14, 0.5, 0, yH + 0.02, Z(dR), seatCell, 0.08));
    parts.push(pbox(iw * 2 - 0.1, 0.6, 0.14, 0, yH + 0.34, Z(dR + 0.27), seatCell, -0.2, 0.04));
    for (const x of [-0.42, 0.42]) parts.push(pbox(0.25, 0.15, 0.1, x, yH + 0.7, Z(dR + 0.35), seatCell, -0.15, 0.035));
  }
  // Dashboard: low front block under the windshield base + upper instrument binnacle.
  const d0 = s.windshield[0] + 0.12;
  const dashRear = dF - 0.5;
  const upperFront = Math.max(d0, dashRear - 0.3);
  const upperTop = Math.min(belt + 0.07, glassH(upperFront) - 0.03);
  parts.push(pbox(iw * 2, upperTop - (belt - 0.35), dashRear - upperFront, 0, (upperTop + belt - 0.35) / 2, Z((upperFront + dashRear) / 2), PAL.dash, 0, 0.03));
  if (upperFront - d0 > 0.05) {
    const lowTop = Math.min(belt, glassH(d0) - 0.03);
    parts.push(pbox(iw * 2, lowTop - (belt - 0.4), upperFront - d0 + 0.02, 0, (lowTop + belt - 0.4) / 2, Z((d0 + upperFront) / 2), PAL.dash, 0, 0.02));
  }
  parts.push(pbox(0.24, 0.3, 0.7, 0, yH + 0.05, Z(dF - 0.35), PAL.dash, 0, 0.03)); // console
  // Steering wheel + column.
  const wc = new THREE.Vector3(-0.37, belt - 0.02, Z(dashRear + 0.14));
  const rim = new THREE.TorusGeometry(0.185, 0.02, 5, 16);
  rim.rotateX(-0.45);
  rim.translate(wc.x, wc.y, wc.z);
  parts.push(palUV(stripAttrs(rim), PAL.wheel));
  parts.push(limb(wc, new THREE.Vector3(wc.x, wc.y - 0.1, wc.z - 0.25), 0.07, 0.07, PAL.wheel));
  parts.push(limb(new THREE.Vector3(wc.x - 0.16, wc.y - 0.04, wc.z + 0.02), new THREE.Vector3(wc.x + 0.16, wc.y - 0.04, wc.z + 0.02), 0.03, 0.02, PAL.wheel));
  // Shell: floor, door panels, headliner, rear bulkhead / parcel shelf (the body skin is single-sided).
  const back = s.rearWindow && (baseId === 'sedan' || sports) ? s.rearWindow[1] : s.rearWindow ? s.rearWindow[0] + (s.rearWindow[1] - s.rearWindow[0]) * 0.3 : s.roof[s.roof.length - 1][0] - 0.1;
  const front = s.windshield[0];
  parts.push(pbox(iw * 2 + 0.1, 0.04, back - front, 0, floorY, Z((front + back) / 2), PAL.carpet, 0, 0));
  for (const sx of [-1, 1]) {
    parts.push(pbox(0.04, belt - floorY + 0.02, back - front - 0.1, sx * (s.W - s.bulge - 0.09), (belt + floorY) / 2, Z((front + back) / 2), PAL.panel, 0, 0));
  }
  const r0 = s.windshield[1], r1 = s.rearWindow && (baseId === 'sedan' || sports) ? s.rearWindow[0] : s.roof[s.roof.length - 2][0];
  let roofMin = 9;
  for (let d = r0; d <= r1; d += 0.1) roofMin = Math.min(roofMin, glassH(d));
  const gTopW = Math.max(0.3, s.W * s.cabin - (roofMin - belt) * s.tumble - 0.06);
  parts.push(pbox(gTopW * 2, 0.03, r1 - r0 + 0.1, 0, roofMin - 0.045, Z((r0 + r1) / 2), PAL.headliner, 0, 0));
  if (baseId === 'sedan' || sports) {
    // Parcel shelf over the trunk + bulkhead behind the (rear) seat back.
    const a = (rearSeats ? dR : dF) + 0.35;
    parts.push(pbox(iw * 2, 0.03, back - a, 0, fns.top(back) + 0.01, Z((a + back) / 2), PAL.dash, 0, 0));
    parts.push(pbox(iw * 2, fns.top(a) - floorY, 0.04, 0, (fns.top(a) + floorY) / 2, Z(a), PAL.panel, 0, 0));
  } else {
    // Cargo floor + inner tailgate / cab back wall.
    const top = glassH(back) - 0.05;
    if (baseId !== 'pickup') parts.push(pbox(iw * 2, 0.05, back - dR - 0.3, 0, yH - 0.05, Z((dR + 0.3 + back) / 2), PAL.carpet, 0, 0));
    parts.push(pbox(iw * 2 + 0.1, top - floorY, 0.04, 0, (top + floorY) / 2, Z(back), PAL.panel, 0, 0));
    if (baseId === 'van') {
      // Bulkhead behind the front seats.
      const bd = dF + 0.5, bt = glassH(bd) - 0.05;
      parts.push(pbox(iw * 2 + 0.1, bt - floorY, 0.04, 0, (bt + floorY) / 2, Z(bd), PAL.panel, 0, 0));
    }
  }
  const interior = mergeGeometries(parts.map(stripAttrs), false)!;

  // Seated driver (low-poly), wheel at wc.
  const drivers: THREE.BufferGeometry[] = [];
  const looks: [number, number][] = livery === 'police'
    ? [[PAL.skin1, PAL.uniform], [PAL.skin2, PAL.uniform], [PAL.skin3, PAL.uniform]]
    : [[PAL.skin1, PAL.shirt1], [PAL.skin2, PAL.shirt2], [PAL.skin3, PAL.shirt3]];
  for (const [skin, shirt] of looks) {
    const b: THREE.BufferGeometry[] = [];
    const x = -0.37;
    const hip = new THREE.Vector3(x, yH + 0.1, Z(dF + 0.12));
    const neck = new THREE.Vector3(x, yH + 0.62, Z(dF + 0.2));
    b.push(limb(hip, neck, 0.36, 0.22, shirt));
    const head = new THREE.SphereGeometry(0.1, 8, 6);
    head.scale(0.9, 1.1, 1);
    head.translate(x, neck.y + 0.15, neck.z - 0.03);
    b.push(palUV(stripAttrs(head), skin));
    const hair = new THREE.SphereGeometry(0.103, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
    hair.scale(0.92, 1.05, 1.03);
    hair.translate(x, neck.y + 0.17, neck.z - 0.015);
    b.push(palUV(stripAttrs(hair), PAL.hair));
    b.push(limb(neck, new THREE.Vector3(x, neck.y + 0.08, neck.z - 0.02), 0.08, 0.08, skin));
    for (const sx of [-1, 1]) {
      const sh = new THREE.Vector3(x + sx * 0.19, yH + 0.55, Z(dF + 0.18));
      const hand = new THREE.Vector3(wc.x + sx * 0.16, wc.y + 0.03, wc.z + 0.03);
      const elbow = new THREE.Vector3(x + sx * 0.22, yH + 0.33, (sh.z + hand.z) / 2 + 0.06);
      b.push(limb(sh, elbow, 0.1, 0.1, shirt));
      b.push(limb(elbow, hand, 0.08, 0.08, shirt));
      const knee = new THREE.Vector3(x + sx * 0.11, yH + 0.14, Z(dF - 0.38));
      b.push(limb(new THREE.Vector3(x + sx * 0.1, yH + 0.1, Z(dF + 0.02)), knee, 0.15, 0.14, PAL.pants));
      b.push(limb(knee, new THREE.Vector3(knee.x, floorY + 0.08, knee.z - 0.12), 0.11, 0.11, PAL.pants));
    }
    drivers.push(mergeGeometries(b.map(stripAttrs), false)!);
  }
  return { interior, drivers };
}
