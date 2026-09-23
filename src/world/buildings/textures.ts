// Procedural, tileable PBR textures (albedo + normal) generated on a canvas. Used as the fallback
// whenever the asset library has no texture set for an id. Real-world scale: one tile = sizeM meters.
import * as THREE from 'three';
import { rng } from '../../core/geo';

export interface ProcTex { alb: HTMLCanvasElement; nrm: HTMLCanvasElement; sizeM: number; base: THREE.Color; roughness: number; metalness: number }
export const TEX_RES = 512;

const RES = 512;

/** Tileable value noise with integer period. */
function makeNoise(period: number, seed: number) {
  const r = rng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}
/** fBm over [0,1)² tileable; base period p cells (slow reference implementation). */
function makeFbmSlow(p: number, oct: number, seed: number) {
  const ns = Array.from({ length: oct }, (_, i) => makeNoise(p << i, seed + i * 31));
  return (u: number, v: number) => {
    let s = 0, a = 0.5, t = 0;
    for (let i = 0; i < oct; i++) { s += ns[i](u * (p << i), v * (p << i)) * a; t += a; a *= 0.5; }
    return s / t;
  };
}
/** Precomputed tileable fBm fields (one per base period), shared by all textures. */
const fields = new Map<string, Float32Array>();
function field(p: number, oct: number): Float32Array {
  const key = p + ':' + oct;
  let f = fields.get(key);
  if (f) return f;
  f = new Float32Array(RES * RES);
  const fn = makeFbmSlow(p, oct, 1000 + p * 7 + oct);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) f[y * RES + x] = fn(x / RES, y / RES);
  fields.set(key, f);
  return f;
}
/** Fast fBm sampler: a precomputed field shifted by a seed-dependent offset (still tileable). */
function makeFbm(p: number, oct: number, seed: number) {
  const f = field(p, Math.min(oct, 3));
  const ox = (seed * 7919) % RES, oy = (seed * 104729) % RES;
  return (u: number, v: number) => {
    const x = ((Math.floor(u * RES) + ox) % RES + RES) % RES;
    const y = ((Math.floor(v * RES) + oy) % RES + RES) % RES;
    return f[y * RES + x];
  };
}

interface Layer { alb: Float32Array; h: Float32Array }
function alloc(): Layer { return { alb: new Float32Array(RES * RES * 3), h: new Float32Array(RES * RES) }; }

function finish(L: Layer, sizeM: number, normalStrength: number, roughness: number, metalness = 0): ProcTex {
  const c1 = document.createElement('canvas'); c1.width = c1.height = RES;
  const c2 = document.createElement('canvas'); c2.width = c2.height = RES;
  const x1 = c1.getContext('2d')!, x2 = c2.getContext('2d')!;
  const d1 = x1.createImageData(RES, RES), d2 = x2.createImageData(RES, RES);
  let sr = 0, sg = 0, sb = 0;
  for (let y = 0; y < RES; y++) {
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      const r = L.alb[i * 3], g = L.alb[i * 3 + 1], b = L.alb[i * 3 + 2];
      d1.data[i * 4] = Math.max(0, Math.min(255, r * 255));
      d1.data[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
      d1.data[i * 4 + 2] = Math.max(0, Math.min(255, b * 255));
      d1.data[i * 4 + 3] = 255;
      sr += r; sg += g; sb += b;
      const xl = (x - 1 + RES) % RES, xr = (x + 1) % RES, yu = (y - 1 + RES) % RES, yd = (y + 1) % RES;
      const dx = (L.h[y * RES + xr] - L.h[y * RES + xl]) * normalStrength;
      const dy = (L.h[yu * RES + x] - L.h[yd * RES + x]) * normalStrength;
      const nl = Math.sqrt(dx * dx + dy * dy + 1);
      d2.data[i * 4] = (-dx / nl * 0.5 + 0.5) * 255;
      d2.data[i * 4 + 1] = (-dy / nl * 0.5 + 0.5) * 255;
      d2.data[i * 4 + 2] = (1 / nl * 0.5 + 0.5) * 255;
      d2.data[i * 4 + 3] = 255;
    }
  }
  x1.putImageData(d1, 0, 0); x2.putImageData(d2, 0, 0);
  const n = RES * RES;
  const base = new THREE.Color().setRGB(sr / n, sg / n, sb / n, THREE.SRGBColorSpace);
  return { alb: c1, nrm: c2, sizeM, base, roughness, metalness };
}

type RGB = [number, number, number];
const hex = (h: string): RGB => { const c = new THREE.Color(h); return [c.r, c.g, c.b].map((v) => Math.pow(v, 1)) as RGB; };
// NB: THREE.Color(hex) converts to linear; canvas wants sRGB → convert back.
const srgb = (h: string): RGB => { const c = new THREE.Color(h); c.convertLinearToSRGB(); return [c.r, c.g, c.b]; };
void hex;

function put(L: Layer, i: number, c: RGB, k: number) { L.alb[i * 3] = c[0] * k; L.alb[i * 3 + 1] = c[1] * k; L.alb[i * 3 + 2] = c[2] * k; }

/** Running-bond brick. mortarC and brick palette in sRGB. */
function brick(palette: string[], mortar: string, seed: number, painted = false): ProcTex {
  const sizeM = 1.8; // 8 bricks × 0.225, 24 courses × 0.075
  const L = alloc();
  const r = rng(seed);
  const cols = 8, rows = 24;
  const bw = RES / cols, bh = RES / rows;
  const jt = 3.2 / 512 * RES; // mortar px (~1.1 cm)
  const pal = palette.map(srgb), mc = srgb(mortar);
  const brickCol: RGB[] = [];
  const brickK: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const p = pal[Math.floor(r() * pal.length)];
    brickCol.push(p);
    brickK.push(painted ? 0.97 + r() * 0.05 : 0.78 + r() * 0.36 - (r() < 0.07 ? 0.25 : 0));
  }
  const fine = makeFbm(64, 3, seed + 5), blot = makeFbm(4, 3, seed + 9);
  for (let y = 0; y < RES; y++) {
    const row = Math.floor(y / bh);
    const off = row % 2 ? bw / 2 : 0;
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      const xx = (x + off) % RES;
      const col = Math.floor(xx / bw);
      const lx = xx - col * bw, ly = y - row * bh;
      const ex = Math.min(lx, bw - lx), ey = Math.min(ly, bh - ly);
      const e = Math.min(ex, ey);
      const u = x / RES, v = y / RES;
      const nz = fine(u, v);
      if (e < jt * 0.5) {
        const k = 0.85 + nz * 0.25;
        put(L, i, painted ? pal[0] : mc, painted ? k * 0.93 : k);
        L.h[i] = 0.1 + nz * 0.1;
      } else {
        const bi = row * cols + col;
        const k = brickK[bi] * (0.86 + nz * 0.28) * (0.92 + blot(u, v) * 0.16);
        put(L, i, brickCol[bi], k);
        const edge = Math.min(1, (e - jt * 0.5) / 2.2);
        L.h[i] = 0.55 + 0.45 * edge + (nz - 0.5) * 0.2;
      }
    }
  }
  return finish(L, sizeM, 2.2, painted ? 0.75 : 0.88);
}

function lap(color: string, seed: number, exposure = 0.15, vertical = false): ProcTex {
  const sizeM = 1.8;
  const L = alloc();
  const n = Math.round(sizeM / exposure);
  const bp = RES / n;
  const c = srgb(color);
  const grain = makeFbm(8, 4, seed), fine = makeFbm(64, 2, seed + 3);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = y * RES + x;
    const a = vertical ? x : y, b = vertical ? y : x;
    const lp = (a % bp) / bp; // 0 top of board .. 1 bottom (lap)
    const g = grain(vertical ? a / RES * 0.2 : b / RES, vertical ? b / RES : a / RES * 0.2);
    let k = 0.9 + g * 0.08 + fine(x / RES, y / RES) * 0.05;
    let h = vertical ? 0.5 : lp; // thicker at bottom for lap
    if (!vertical && lp > 0.93) { k *= 0.55; h = 0; }
    if (vertical) {
      // board & batten: battens every 2 boards
      const bb = (x % (bp * 2)) / (bp * 2);
      if (bb < 0.18) { h = 1; k *= 1.02; } else { h = 0.3; if (bb < 0.2 || bb > 0.98) k *= 0.7; }
    }
    put(L, i, c, k);
    L.h[i] = h;
  }
  return finish(L, sizeM, vertical ? 3 : 5, 0.7);
}

function noiseSurface(color: string, seed: number, sizeM: number, amp: number, detail: number, rough: number, extra?: (L: Layer, u: number, v: number, i: number) => void, nStrength = 1.2): ProcTex {
  const L = alloc();
  const c = srgb(color);
  const f1 = makeFbm(4, 4, seed), f2 = makeFbm(32, 3, seed + 7), f3 = makeFbm(128, 2, seed + 13);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = y * RES + x;
    const u = x / RES, v = y / RES;
    const a = f1(u, v), b = f2(u, v), d = f3(u, v);
    put(L, i, c, 1 - amp + amp * (a * 0.6 + b * 0.4) * 2 * 0.5 + (d - 0.5) * detail);
    L.h[i] = b * 0.6 + d * 0.4;
    extra?.(L, u, v, i);
  }
  return finish(L, sizeM, nStrength, rough);
}

function ashlar(palette: string[], mortar: string, seed: number, courseH: number[], sizeM = 2.4): ProcTex {
  const L = alloc();
  const r = rng(seed);
  const pal = palette.map(srgb), mc = srgb(mortar);
  const f = makeFbm(16, 4, seed + 1), fine = makeFbm(96, 2, seed + 2);
  // build courses to fill exactly
  const rowsPx: { y0: number; y1: number; cuts: number[]; cols: RGB[]; ks: number[] }[] = [];
  let y = 0;
  while (y < RES) {
    const h = Math.round((courseH[Math.floor(r() * courseH.length)] / sizeM) * RES);
    const y1 = Math.min(RES, y + h);
    const cuts: number[] = [];
    let x = Math.floor(r() * 60);
    while (x < RES) { cuts.push(x); x += Math.round(((0.5 + r() * 0.9) / sizeM) * RES); }
    rowsPx.push({ y0: y, y1: RES - y1 < 20 ? RES : y1, cuts, cols: cuts.map(() => pal[Math.floor(r() * pal.length)]), ks: cuts.map(() => 0.85 + r() * 0.25) });
    if (RES - y1 < 20) break;
    y = y1;
  }
  const jt = 2.5;
  for (const row of rowsPx) {
    for (let yy = row.y0; yy < row.y1; yy++) for (let x = 0; x < RES; x++) {
      const i = yy * RES + x;
      let ci = row.cuts.length - 1;
      for (let k = 0; k < row.cuts.length; k++) if (row.cuts[k] <= x) ci = k;
      const c0 = row.cuts[ci], c1 = ci + 1 < row.cuts.length ? row.cuts[ci + 1] : row.cuts[0] + RES;
      const xx = x < row.cuts[0] ? x + RES : x;
      const ex = Math.min(Math.abs(xx - c0), Math.abs(c1 - xx));
      const ey = Math.min(yy - row.y0, row.y1 - yy);
      const e = Math.min(ex, ey);
      const u = x / RES, v = yy / RES;
      if (e < jt) { put(L, i, mc, 0.9 + fine(u, v) * 0.15); L.h[i] = 0.1; }
      else {
        const k = row.ks[ci] * (0.82 + f(u, v) * 0.3 + (fine(u, v) - 0.5) * 0.12);
        put(L, i, row.cols[ci], k);
        L.h[i] = 0.6 + Math.min(1, (e - jt) / 4) * 0.3 + f(u, v) * 0.25;
      }
    }
  }
  return finish(L, sizeM, 2, 0.85);
}

function shingles(color: string, seed: number, exposure: number, tabW: number, sizeM: number, kind: 'asphalt' | 'wood' | 'slate'): ProcTex {
  const L = alloc();
  const r = rng(seed);
  const c = srgb(color);
  const rows = Math.round(sizeM / exposure);
  const rp = RES / rows;
  const gran = makeFbm(128, 2, seed + 4), blot = makeFbm(4, 3, seed + 6);
  const rowCuts: number[][] = [], rowK: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const cuts: number[] = [];
    let x = kind === 'asphalt' ? (i % 2) * (tabW / sizeM * RES / 2) : Math.floor(r() * 40);
    while (x < RES + 200) { cuts.push(x % RES); x += kind === 'asphalt' ? tabW / sizeM * RES : ((tabW * (0.5 + r())) / sizeM) * RES; }
    rowCuts.push(cuts.sort((a, b) => a - b));
    rowK.push(cuts.map(() => (kind === 'asphalt' ? 0.9 + r() * 0.15 : 0.75 + r() * 0.4)));
  }
  for (let y = 0; y < RES; y++) {
    // v up the roof: row 0 at canvas bottom (y=RES) for flipY → use yy = RES-1-y so exposure bottom edge is darker
    const yy = RES - 1 - y;
    const row = Math.floor(yy / rp);
    const ly = (yy % rp) / rp; // 0 = bottom (butt edge) .. 1 = top (covered)
    const cuts = rowCuts[row], ks = rowK[row];
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      let ci = cuts.length - 1;
      for (let k = 0; k < cuts.length; k++) if (cuts[k] <= x) ci = k;
      const dcut = Math.min(Math.abs(x - cuts[ci]), ci + 1 < cuts.length ? Math.abs(cuts[ci + 1] - x) : RES);
      const g = gran(x / RES, y / RES);
      let k = ks[ci] * (0.8 + g * 0.4) * (0.9 + blot(x / RES, y / RES) * 0.2);
      let h = 1 - ly * 0.7;
      if (ly < 0.06) { k *= 0.55; h = 0; } // butt edge shadow
      if (dcut < 1.6 && kind !== 'asphalt') { k *= 0.5; h *= 0.4; }
      if (dcut < 1.2 && kind === 'asphalt' && ly < 0.7) { k *= 0.6; h *= 0.5; }
      put(L, i, c, k);
      L.h[i] = h;
    }
  }
  return finish(L, sizeM, kind === 'asphalt' ? 3 : 4, kind === 'slate' ? 0.6 : 0.9);
}

function clayTile(color: string, seed: number): ProcTex {
  const sizeM = 1.5;
  const L = alloc();
  const c = srgb(color);
  const f = makeFbm(8, 3, seed), fine = makeFbm(64, 2, seed + 1);
  const r = rng(seed);
  const cols = 6, rows = 5; // 0.25 wide × 0.3 exposure
  const kk = Array.from({ length: cols * rows }, () => 0.8 + r() * 0.35);
  for (let y = 0; y < RES; y++) {
    const yy = RES - 1 - y;
    const row = Math.floor(yy / (RES / rows));
    const ly = (yy % (RES / rows)) / (RES / rows);
    for (let x = 0; x < RES; x++) {
      const i = y * RES + x;
      const col = Math.floor(x / (RES / cols));
      const lx = (x % (RES / cols)) / (RES / cols);
      const barrel = Math.sin(lx * Math.PI);
      let k = kk[row * cols + col] * (0.75 + 0.35 * barrel) * (0.85 + f(x / RES, y / RES) * 0.3);
      let h = barrel * 0.8 + (1 - ly) * 0.2;
      if (ly < 0.07) { k *= 0.5; h *= 0.3; }
      k *= 0.95 + (fine(x / RES, y / RES) - 0.5) * 0.15;
      put(L, i, c, k);
      L.h[i] = h;
    }
  }
  return finish(L, sizeM, 6, 0.75);
}

function seams(color: string, seed: number, spacing: number, sizeM: number, rough: number, metal: number, ribW = 0.03): ProcTex {
  const L = alloc();
  const c = srgb(color);
  const f = makeFbm(4, 3, seed), fine = makeFbm(64, 2, seed + 2);
  const n = Math.round(sizeM / spacing);
  const sp = RES / n;
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const i = y * RES + x;
    const lx = (x % sp) / sp;
    const d = Math.min(lx, 1 - lx) * spacing;
    const rib = d < ribW ? 1 - d / ribW : 0;
    const k = (0.9 + f(x / RES, y / RES) * 0.12 + (fine(x / RES, y / RES) - 0.5) * 0.05) * (rib > 0 ? 0.92 + rib * 0.15 : 1);
    put(L, i, c, k);
    L.h[i] = rib;
  }
  return finish(L, sizeM, 8, rough, metal);
}

function concrete(color: string, seed: number, formwork: boolean): ProcTex {
  return noiseSurface(color, seed, 2.4, 0.22, 0.12, 0.92, formwork ? (L, u, v, i) => {
    // tie holes on a 0.6 m grid and panel joints every 1.2 m
    const gu = (u * 4) % 1, gv = (v * 4) % 1;
    const dh = Math.hypot(gu - 0.5, gv - 0.5);
    if (dh < 0.035) { L.alb[i * 3] *= 0.6; L.alb[i * 3 + 1] *= 0.6; L.alb[i * 3 + 2] *= 0.6; L.h[i] = 0; }
    const ju = (u * 2) % 1, jv = (v * 2) % 1;
    if (ju < 0.004 || jv < 0.004) { L.alb[i * 3] *= 0.8; L.alb[i * 3 + 1] *= 0.8; L.alb[i * 3 + 2] *= 0.8; L.h[i] *= 0.5; }
  } : undefined);
}

const cache = new Map<string, ProcTex>();

/** Procedural texture for a facade/roof/trim id. */
export const texTimes: Record<string, number> = {};
export function procTexture(id: string): ProcTex {
  let t = cache.get(id);
  if (t) return t;
  const t0 = performance.now();
  t = gen(id);
  texTimes[id] = performance.now() - t0;
  cache.set(id, t);
  return t;
}
function gen(id: string): ProcTex {
  let t: ProcTex;
  switch (id) {
    case 'brick-red': t = brick(['#9c4630', '#a8503a', '#8a3b28', '#b25a41', '#7e3a2c'], '#b9b1a4', 11); break;
    case 'brick-brown': t = brick(['#6e4535', '#7d5140', '#5e3b2e', '#8a5c45'], '#a9a092', 12); break;
    case 'brick-tan': t = brick(['#c9ab83', '#bf9f78', '#d4b891', '#b3936c'], '#cfc6b5', 13); break;
    case 'brick-painted': t = brick(['#e6e2d8'], '#e6e2d8', 14, true); break;
    case 'lap-siding': t = lap('#eeeeea', 21, 0.15); break;
    case 'board-batten': t = lap('#ecebe6', 22, 0.2, true); break;
    case 'wood-shingle': t = shingles('#9b7a58', 23, 0.18, 0.2, 1.8, 'wood'); break;
    case 'stucco': t = noiseSurface('#e9e3d6', 31, 2.0, 0.16, 0.14, 0.95, undefined, 2.5); break;
    case 'plaster': t = noiseSurface('#efece6', 32, 2.0, 0.08, 0.05, 0.8, undefined, 0.6); break;
    case 'adobe': t = noiseSurface('#b98e66', 33, 3.0, 0.3, 0.1, 0.97, undefined, 1.8); break;
    case 'stone': t = ashlar(['#a9a39a', '#9b958b', '#b4ada2', '#8f8a83'], '#c3bdb2', 41, [0.3, 0.35, 0.4]); break;
    case 'sandstone': t = ashlar(['#c89b83', '#b98a72', '#d1a78c', '#a97f6b', '#c39680'], '#d0c0ae', 42, [0.25, 0.3, 0.45]); break;
    case 'concrete': t = concrete('#b5b2ab', 51, true); break;
    case 'concrete-plain': t = concrete('#b8b5ae', 52, false); break;
    case 'metal-panel': t = seams('#d9dadc', 61, 0.3, 1.8, 0.45, 0.5, 0.04); break;
    case 'glass-curtain': t = seams('#39434b', 62, 1.5, 3.0, 0.2, 0.7, 0.03); break;
    case 'roof-asphalt-shingle': t = shingles('#58585a', 71, 0.14, 0.33, 1.68, 'asphalt'); break;
    case 'roof-wood-shingle': t = shingles('#7a6048', 72, 0.14, 0.2, 1.68, 'wood'); break;
    case 'roof-slate': t = shingles('#4a4f57', 73, 0.2, 0.3, 1.8, 'slate'); break;
    case 'roof-clay-tile': t = clayTile('#b0583a', 74); break;
    case 'roof-standing-seam': t = seams('#8a9096', 75, 0.45, 1.8, 0.38, 0.35, 0.025); break;
    case 'roof-membrane': t = noiseSurface('#cfd0cd', 76, 6.0, 0.12, 0.05, 0.85, (L, u, v, i) => {
      if ((u * 2) % 1 < 0.004 || (v * 2) % 1 < 0.003) { L.alb[i * 3] *= 0.85; L.alb[i * 3 + 1] *= 0.85; L.alb[i * 3 + 2] *= 0.85; L.h[i] = 1; }
    }); break;
    case 'roof-gravel': t = noiseSurface('#8f8b84', 77, 1.5, 0.3, 0.5, 0.95, undefined, 3); break;
    case 'fabric': t = noiseSurface('#ffffff', 81, 0.5, 0.05, 0.06, 0.9, (L, u, v, i) => {
      const w = ((Math.floor(u * 180) + Math.floor(v * 180)) % 2) * 0.05;
      L.alb[i * 3] -= w; L.alb[i * 3 + 1] -= w; L.alb[i * 3 + 2] -= w;
    }); break;
    case 'paint': t = noiseSurface('#f4f4f2', 82, 2.0, 0.05, 0.04, 0.6, undefined, 0.3); break;
    case 'metal': t = noiseSurface('#d8d8d8', 83, 2.0, 0.06, 0.05, 0.42, undefined, 0.3); t.metalness = 0.75; break;
    case 'wood-planks': t = lap('#9a7552', 84, 0.14, false); t.roughness = 0.8; break;
    case 'trim-stone': t = noiseSurface('#d9d2c2', 86, 1.6, 0.12, 0.08, 0.8, (L, u, v, i) => {
      if ((v * 2) % 1 < 0.006 || ((u * 2 + Math.floor(v * 2) * 0.5) % 1) < 0.004) { L.alb[i * 3] *= 0.82; L.alb[i * 3 + 1] *= 0.82; L.alb[i * 3 + 2] *= 0.82; L.h[i] = 0; }
    }, 1.5); break;
    case 'dark': t = noiseSurface('#202020', 85, 2.0, 0.1, 0.05, 0.9, undefined, 0.3); break;
    default: t = noiseSurface('#cccccc', 99, 2.0, 0.15, 0.1, 0.9); break;
  }
  return t;
}
