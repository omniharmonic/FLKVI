// Procedural fallback textures (canvas-generated, tileable) used when the asset library has no CC0 set,
// plus world-specific textures (markings wear, light pools, signs, water normals).
import * as THREE from 'three';
import { rng } from '../core/geo';

type RGBA = Uint8ClampedArray;

/** Tileable value noise with period `per` (integer lattice). */
function makeNoise(seed: number) {
  const R = rng(seed);
  const P = 256;
  const tab = new Float32Array(P * P);
  for (let i = 0; i < tab.length; i++) tab[i] = R();
  const lat = (x: number, y: number, per: number) => tab[(((x % per) + per) % per) + ((((y % per) + per) % per) * P)];
  const sm = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, per: number) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const a = lat(xi, yi, per), b = lat(xi + 1, yi, per), c = lat(xi, yi + 1, per), d = lat(xi + 1, yi + 1, per);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  /** fbm on unit square u,v in [0,1): base frequency f (integer). */
  return (u: number, v: number, f: number, oct = 4, gain = 0.5) => {
    let amp = 1, sum = 0, norm = 0, fr = f;
    for (let o = 0; o < oct; o++) { sum += amp * noise(u * fr, v * fr, fr); norm += amp; amp *= gain; fr *= 2; }
    return sum / norm;
  };
}

function canvasTex(size: number, draw: (img: RGBA, size: number) => void, srgb = true, ctxDraw?: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(size, size);
  draw(id.data, size);
  ctx.putImageData(id, 0, 0);
  ctxDraw?.(ctx);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Height (0..1 array) → tangent-space normal map texture. */
function normalFromHeight(h: Float32Array, size: number, strength: number) {
  return canvasTex(size, (d) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], dn = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz); nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }, false);
}

function grayTex(h: Float32Array, size: number, map: (v: number) => number) {
  return canvasTex(size, (d) => {
    for (let i = 0; i < size * size; i++) { const v = map(h[i]) * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
  }, false);
}

export interface ProcSet { map: THREE.Texture; normalMap?: THREE.Texture; roughnessMap?: THREE.Texture; sizeM: number }
const cache = new Map<string, ProcSet>();

function build(id: string): ProcSet {
  const S = 512;
  const h = new Float32Array(S * S);
  switch (id) {
    case 'asphalt': {
      const n = makeNoise(11), R = rng(5);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const base = n(u, v, 8, 5) * 0.5 + n(u, v, 64, 2) * 0.5;
          const speck = R();
          let g = 58 + base * 30 + (speck > 0.93 ? 40 * (speck - 0.93) / 0.07 : 0) - (speck < 0.05 ? 18 : 0);
          const patch = n(u, v, 2, 3);
          g *= 0.9 + patch * 0.2;
          const i = (y * S + x) * 4;
          d[i] = g * 0.98; d[i + 1] = g * 0.98; d[i + 2] = g * 1.0; d[i + 3] = 255;
          h[y * S + x] = base * 0.6 + (speck > 0.85 ? 0.4 : 0);
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 3.5), roughnessMap: grayTex(h, S, (v) => 0.95 - v * 0.2), sizeM: 3 };
    }
    case 'concrete': case 'curb': {
      const n = makeNoise(id === 'curb' ? 17 : 23), R = rng(9);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const base = n(u, v, 4, 5);
          const fine = n(u, v, 128, 2);
          const sp = R();
          let g = 168 + base * 32 + fine * 14 - (sp < 0.03 ? 25 : 0);
          const stain = n(u + 0.37, v + 0.11, 3, 4);
          if (stain > 0.62) g -= (stain - 0.62) * 90;
          const i = (y * S + x) * 4;
          d[i] = g * 1.0; d[i + 1] = g * 0.985; d[i + 2] = g * 0.95; d[i + 3] = 255;
          h[y * S + x] = fine * 0.5 + base * 0.3 + (sp < 0.03 ? -0.3 : 0);
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 1.6), roughnessMap: grayTex(h, S, (v) => 0.82 + v * 0.1), sizeM: 2 };
    }
    case 'grass': {
      const n = makeNoise(31), R = rng(3);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const b = n(u, v, 6, 4), f = n(u, v, 96, 2), bl = R();
          const dry = n(u + 0.5, v, 3, 3);
          const k = 0.55 + f * 0.5 + bl * 0.25;
          const i = (y * S + x) * 4;
          const r = (58 + dry * 55) * k, gg = (92 + b * 30 + dry * 20) * k, bb = (34 + dry * 12) * k;
          d[i] = r; d[i + 1] = gg; d[i + 2] = bb; d[i + 3] = 255;
          h[y * S + x] = f * 0.7 + bl * 0.3;
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 2.5), sizeM: 2.5 };
    }
    case 'dirt': {
      const n = makeNoise(41), R = rng(4);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const b = n(u, v, 5, 5), f = n(u, v, 80, 2), p = R();
          const k = 0.75 + b * 0.35 + f * 0.15 + (p > 0.96 ? 0.2 : 0);
          const i = (y * S + x) * 4;
          d[i] = 128 * k; d[i + 1] = 104 * k; d[i + 2] = 78 * k; d[i + 3] = 255;
          h[y * S + x] = b * 0.4 + f * 0.4 + (p > 0.96 ? 0.3 : 0);
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 2.5), sizeM: 3 };
    }
    case 'gravel': {
      const n = makeNoise(43), R = rng(8);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const f = n(u, v, 110, 2), p = R();
          const k = 0.6 + f * 0.6 + p * 0.15;
          const i = (y * S + x) * 4;
          d[i] = 150 * k; d[i + 1] = 138 * k; d[i + 2] = 120 * k; d[i + 3] = 255;
          h[y * S + x] = f;
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 4), sizeM: 1.5 };
    }
    case 'paving': {
      // Brick pavers in herringbone-ish running bond, 20x10 cm, 2 m tile.
      const n = makeNoise(51), R = rng(12);
      const tones: number[][] = [];
      for (let i = 0; i < 400; i++) { const t = R(); tones.push([150 + t * 40, 86 + t * 25, 66 + t * 18]); }
      const bw = S / 10, bh = S / 20;
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const row = Math.floor(y / bh);
          const xo = (x + (row % 2) * bw / 2) % S;
          const col = Math.floor(xo / bw);
          const ex = xo - col * bw, ey = y - row * bh;
          const joint = ex < 2 || ey < 2;
          const tone = tones[(row * 13 + col * 7) % tones.length];
          const f = n(x / S, y / S, 64, 2);
          const i = (y * S + x) * 4;
          const k = joint ? 0.45 : 0.85 + f * 0.25;
          d[i] = tone[0] * k; d[i + 1] = tone[1] * k; d[i + 2] = tone[2] * k; d[i + 3] = 255;
          h[y * S + x] = joint ? 0 : 0.6 + f * 0.3;
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 3), roughnessMap: grayTex(h, S, (v) => (v < 0.1 ? 0.95 : 0.8)), sizeM: 2 };
    }
    case 'rock': {
      const n = makeNoise(61);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const b = n(u, v, 4, 6, 0.55);
          const k = 0.55 + b * 0.6;
          const i = (y * S + x) * 4;
          d[i] = 150 * k; d[i + 1] = 118 * k; d[i + 2] = 96 * k; d[i + 3] = 255;
          h[y * S + x] = b;
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 5), sizeM: 8 };
    }
    case 'hedge': {
      const n = makeNoise(71), R = rng(71);
      const color = canvasTex(S, (d) => {
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          const f = n(u, v, 48, 3), p = R();
          const k = 0.35 + f * 0.8 + p * 0.1;
          const i = (y * S + x) * 4;
          d[i] = 42 * k; d[i + 1] = 78 * k; d[i + 2] = 30 * k; d[i + 3] = 255;
          h[y * S + x] = f;
        }
      });
      return { map: color, normalMap: normalFromHeight(h, S, 6), sizeM: 1.2 };
    }
    default: throw new Error('no proc texture ' + id);
  }
}

export function procSet(id: string): ProcSet {
  let s = cache.get(id);
  if (!s) { s = build(id); cache.set(id, s); }
  return s;
}

/** White paint texture with worn alpha (world-space tiled, ~4 m). */
let wear: THREE.Texture | null = null;
export function markingWearTexture() {
  if (wear) return wear;
  const n = makeNoise(99), R = rng(99);
  const S = 512;
  wear = canvasTex(S, (d) => {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const big = n(u, v, 4, 4), fine = n(u, v, 64, 2);
      let a = 1 - Math.max(0, big - 0.52) * 3.5 - (fine > 0.7 ? (fine - 0.7) * 2 : 0) - (R() < 0.08 ? 0.35 : 0);
      a = Math.max(0, Math.min(1, a));
      const i = (y * S + x) * 4;
      const g = 225 + fine * 30;
      d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = a * 255;
    }
  });
  return wear;
}

let pool: THREE.Texture | null = null;
export function lightPoolTexture() {
  if (pool) return pool;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  pool = new THREE.CanvasTexture(c);
  pool.colorSpace = THREE.SRGBColorSpace;
  return pool;
}

let wn: THREE.Texture | null = null;
export function waterNormalTexture() {
  if (wn) return wn;
  const S = 256, n = makeNoise(123);
  const h = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) h[y * S + x] = n(x / S, y / S, 8, 4, 0.55);
  wn = normalFromHeight(h, S, 6);
  return wn;
}

let stop: THREE.Texture | null = null;
export function stopSignTexture() {
  if (stop) return stop;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ddd'; ctx.fillRect(0, 0, 256, 256);
  const oct = (r: number) => {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; ctx.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r); }
    ctx.closePath();
  };
  oct(128); ctx.fillStyle = '#f2f2f2'; ctx.fill();
  oct(118); ctx.fillStyle = '#b3141b'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 74px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('STOP', 128, 133);
  stop = new THREE.CanvasTexture(c);
  stop.colorSpace = THREE.SRGBColorSpace; stop.anisotropy = 4;
  return stop;
}

let chain: THREE.Texture | null = null;
export function chainLinkTexture() {
  if (chain) return chain;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = 'rgba(200,205,210,1)'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(64, 64); ctx.moveTo(64, 0); ctx.lineTo(0, 64);
  ctx.moveTo(-32, 32); ctx.lineTo(32, 96); ctx.moveTo(32, -32); ctx.lineTo(96, 32);
  ctx.moveTo(96, 32); ctx.lineTo(32, 96); ctx.moveTo(32, -32); ctx.lineTo(-32, 32);
  ctx.stroke();
  chain = new THREE.CanvasTexture(c);
  chain.wrapS = chain.wrapT = THREE.RepeatWrapping;
  return chain;
}

let manhole: THREE.Texture | null = null;
export function manholeTexture() {
  if (manhole) return manhole;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 256);
  ctx.beginPath(); ctx.arc(128, 128, 126, 0, Math.PI * 2); ctx.fillStyle = '#3a3633'; ctx.fill();
  ctx.beginPath(); ctx.arc(128, 128, 112, 0, Math.PI * 2); ctx.fillStyle = '#4a4540'; ctx.fill();
  ctx.strokeStyle = '#2a2724'; ctx.lineWidth = 5;
  for (let r = 24; r < 110; r += 20) { ctx.beginPath(); ctx.arc(128, 128, r, 0, Math.PI * 2); ctx.stroke(); }
  for (let a = 0; a < 16; a++) { ctx.beginPath(); ctx.moveTo(128, 128); ctx.lineTo(128 + Math.cos(a * Math.PI / 8) * 110, 128 + Math.sin(a * Math.PI / 8) * 110); ctx.stroke(); }
  ctx.fillStyle = '#5a534c'; ctx.font = 'bold 22px Arial'; ctx.textAlign = 'center'; ctx.fillText('SEWER', 128, 136);
  manhole = new THREE.CanvasTexture(c);
  manhole.colorSpace = THREE.SRGBColorSpace;
  return manhole;
}
