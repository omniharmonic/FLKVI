// OWNER: world (vegetation). Procedural texture atlas for palms, cacti, succulents, grasses, flowers,
// dense shrubs and Spanish moss — painted once on a canvas at startup (no downloads, CC0 by construction).
// Colors are painted near-neutral mid-tones; per-species tint comes from vertex colors.
import * as THREE from 'three';
import { rng } from '../core/geo';

export const ATLAS_PX = 2048;
const U = 128; // grid unit (16 × 16 units)

/** Cell rects in grid units on the canvas (x, y from top-left, w, h). */
const CELLS = {
  frond: [0, 0, 2, 8],
  frondDead: [2, 0, 2, 8],
  fan: [4, 0, 4, 4],
  fanDead: [8, 0, 4, 4],
  thatch: [4, 4, 4, 4],
  trunkRing: [12, 0, 2, 4],
  trunkSmooth: [14, 0, 2, 4],
  trunkDiamond: [12, 4, 2, 4],
  trunkBoot: [14, 4, 2, 4],
  greenSmooth: [8, 4, 1, 4],
  cactus: [9, 4, 3, 4],
  agave: [0, 8, 2, 4],
  yucca: [2, 8, 1, 4],
  grass: [3, 8, 3, 4],
  flowersWarm: [6, 8, 2, 2],
  flowersCool: [6, 10, 2, 2],
  pad: [8, 8, 2, 2],
  blossom: [8, 10, 2, 2],
  moss: [10, 8, 2, 4],
  ocotillo: [12, 8, 1, 4],
  shrubA: [13, 8, 3, 3],
  shrubB: [0, 12, 3, 3],
  leafSolid: [3, 12, 2, 2],
  bark: [5, 12, 2, 4],
} as const;
export type CellId = keyof typeof CELLS;

/** Map cell-local (s: 0 left → 1 right, t: 0 bottom → 1 top) to atlas UV (flipY texture). */
export function cellUV(c: CellId, s: number, t: number): [number, number] {
  const [x, y, w, h] = CELLS[c];
  const inset = 2 / ATLAS_PX; // keep bilinear taps inside the cell
  const u0 = x * U / ATLAS_PX + inset, u1 = (x + w) * U / ATLAS_PX - inset;
  const vTop = 1 - y * U / ATLAS_PX - inset, vBot = 1 - (y + h) * U / ATLAS_PX + inset;
  return [u0 + (u1 - u0) * s, vBot + (vTop - vBot) * t];
}

type Ctx = CanvasRenderingContext2D;
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

function withCell(ctx: Ctx, c: CellId, fn: (w: number, h: number) => void) {
  const [x, y, w, h] = CELLS[c];
  ctx.save();
  ctx.beginPath(); ctx.rect(x * U, y * U, w * U, h * U); ctx.clip();
  ctx.translate(x * U, y * U);
  fn(w * U, h * U);
  ctx.restore();
}

/** Lanceolate blade from (x0,y0) along angle a (radians, canvas coords), length L, max half-width W. */
function blade(ctx: Ctx, x0: number, y0: number, a: number, L: number, W: number, fill: string | CanvasGradient, bend = 0) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const nx = -sa, ny = ca;
  const P = (t: number, side: number) => {
    const w = W * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (1 - t * 0.35);
    const b = bend * t * t * L;
    return [x0 + ca * L * t + nx * (side * w + b), y0 + sa * L * t + ny * (side * w + b)];
  };
  ctx.beginPath();
  const N = 8;
  let p = P(0, 1); ctx.moveTo(p[0], p[1]);
  for (let i = 1; i <= N; i++) { p = P(i / N, 1); ctx.lineTo(p[0], p[1]); }
  for (let i = N; i >= 0; i--) { p = P(i / N, -1); ctx.lineTo(p[0], p[1]); }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
}

function noiseFill(ctx: Ctx, w: number, h: number, R: () => number, n: number, col: (r: number) => string, sz: [number, number]) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = col(R());
    ctx.fillRect(R() * w, R() * h, sz[0] * (0.5 + R()), sz[1] * (0.5 + R()));
  }
}

function paintFrond(ctx: Ctx, w: number, h: number, dead: boolean) {
  const R = rng(dead ? 91 : 17);
  const cx = w / 2;
  // leaflets: both sides, angled toward the tip (tip = top of the cell)
  for (let side = -1; side <= 1; side += 2) {
    for (let t = 0.06; t < 0.985; t += 0.0105 + R() * 0.004) {
      if (R() < 0.05) continue; // gaps
      const y = h * (1 - t);
      const env = Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) * (1 - 0.25 * t);
      const L = (w / 2 - 6) * env * (0.85 + R() * 0.15) / Math.cos(0.75);
      const a = -Math.PI / 2 + side * (0.72 + 0.25 * (1 - t) + (R() - 0.5) * 0.15); // up + outward
      const light = dead ? 34 + R() * 14 : 30 + R() * 16;
      const g = ctx.createLinearGradient(cx, y, cx + Math.cos(a) * L, y + Math.sin(a) * L);
      if (dead) { g.addColorStop(0, hsl(32, 35, light)); g.addColorStop(1, hsl(36, 30, light + 12)); }
      else { g.addColorStop(0, hsl(88 + R() * 10, 45, light - 6)); g.addColorStop(0.6, hsl(84 + R() * 12, 42, light)); g.addColorStop(1, hsl(70 + R() * 12, 40, light + 8)); }
      blade(ctx, cx + side * 2, y, a, L, 3.2 + env * 3.2, g, side * 0.04);
    }
  }
  // rachis
  const rg = ctx.createLinearGradient(0, h, 0, 0);
  rg.addColorStop(0, dead ? hsl(30, 30, 38) : hsl(60, 30, 50)); rg.addColorStop(1, dead ? hsl(32, 25, 45) : hsl(75, 35, 45));
  ctx.fillStyle = rg;
  ctx.beginPath(); ctx.moveTo(cx - 6, h); ctx.lineTo(cx - 1.2, 0); ctx.lineTo(cx + 1.2, 0); ctx.lineTo(cx + 6, h); ctx.fill();
}

function paintFan(ctx: Ctx, w: number, h: number, dead: boolean) {
  const R = rng(dead ? 5 : 3);
  const cx = w / 2, cy = h / 2, rad = w / 2 - 4;
  const n = 64;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (R() - 0.5) * 0.02;
    const L = rad * (0.82 + R() * 0.18);
    const light = dead ? 36 + R() * 12 : 32 + R() * 14;
    const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * L, cy + Math.sin(a) * L);
    if (dead) { g.addColorStop(0, hsl(34, 30, light - 6)); g.addColorStop(1, hsl(36, 28, light + 10)); }
    else { g.addColorStop(0, hsl(95, 30, light - 8)); g.addColorStop(0.5, hsl(88, 38, light)); g.addColorStop(1, hsl(78, 35, light + 6)); }
    // segment: wide near the middle, split tip
    ctx.beginPath();
    const w0 = (Math.PI * 2 * rad) / n * 0.62;
    const p = (r: number, off: number) => [cx + Math.cos(a) * r - Math.sin(a) * off, cy + Math.sin(a) * r + Math.cos(a) * off];
    const pts = [p(rad * 0.06, 0), p(L * 0.55, w0 * 0.55), p(L * 0.92, w0 * 0.45), p(L, w0 * 0.1), p(L * 0.86, 0), p(L, -w0 * 0.1), p(L * 0.92, -w0 * 0.45), p(L * 0.55, -w0 * 0.55)];
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) ctx.lineTo(q[0], q[1]);
    ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    // fold line (costa)
    ctx.strokeStyle = dead ? hsl(30, 25, 30, 0.5) : hsl(90, 30, 22, 0.45); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(p(rad * 0.1, 0)[0], p(rad * 0.1, 0)[1]); ctx.lineTo(p(L * 0.85, 0)[0], p(L * 0.85, 0)[1]); ctx.stroke();
    // filaments
    if (R() < 0.5) {
      ctx.strokeStyle = dead ? hsl(35, 20, 60, 0.8) : hsl(60, 20, 70, 0.7); ctx.lineWidth = 0.8;
      const s = p(L, 0), e = p(L + 10 + R() * 18, (R() - 0.5) * 10);
      ctx.beginPath(); ctx.moveTo(s[0], s[1]); ctx.lineTo(e[0], e[1]); ctx.stroke();
    }
  }
  // hastula
  ctx.fillStyle = dead ? hsl(30, 25, 30) : hsl(70, 25, 35);
  ctx.beginPath(); ctx.arc(cx, cy, rad * 0.07, 0, Math.PI * 2); ctx.fill();
}

function paintThatch(ctx: Ctx, w: number, h: number) {
  const R = rng(77);
  for (let i = 0; i < 420; i++) {
    const x = R() * w, len = h * (0.62 + R() * 0.38);
    const l = 30 + R() * 22;
    const g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, hsl(30, 22, l * 0.6)); g.addColorStop(0.4, hsl(33, 25, l)); g.addColorStop(1, hsl(36, 20, l + 10));
    ctx.fillStyle = g;
    const ww = 4 + R() * 7;
    ctx.beginPath(); ctx.moveTo(x - ww / 2, 0); ctx.lineTo(x + ww / 2, 0); ctx.lineTo(x + ww * 0.1 + (R() - 0.5) * 8, len); ctx.lineTo(x - ww * 0.2 + (R() - 0.5) * 8, len - 6); ctx.fill();
  }
  ctx.fillStyle = hsl(30, 20, 18, 0.9); ctx.fillRect(0, 0, w, 10);
}

function paintTrunkRing(ctx: Ctx, w: number, h: number, smooth: boolean) {
  const R = rng(smooth ? 8 : 9);
  ctx.fillStyle = smooth ? hsl(40, 6, 62) : hsl(30, 14, 40); ctx.fillRect(0, 0, w, h);
  noiseFill(ctx, w, h, R, smooth ? 900 : 2600, (r) => smooth ? hsl(35, 6, 52 + r * 20, 0.35) : hsl(28 + r * 10, 15, 26 + r * 26, 0.5), smooth ? [6, 3] : [2, 14]);
  // growth rings (leaf scars) — tile vertically
  const rings = smooth ? 7 : 11;
  for (let i = 0; i < rings; i++) {
    const y = (i + 0.5) * h / rings + (R() - 0.5) * 8;
    const th = smooth ? 2 + R() * 2 : 5 + R() * 6;
    ctx.fillStyle = smooth ? hsl(35, 8, 42, 0.55) : hsl(25, 18, 18, 0.75);
    ctx.beginPath(); ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += 16) ctx.lineTo(x, y + Math.sin(x * 0.05 + i) * 2 + (R() - 0.5) * 2);
    for (let x = w; x >= 0; x -= 16) ctx.lineTo(x, y + th + Math.sin(x * 0.05 + i) * 2);
    ctx.fill();
    ctx.fillStyle = smooth ? hsl(40, 6, 72, 0.5) : hsl(32, 15, 52, 0.5);
    ctx.fillRect(0, y - 2, w, 2);
  }
}

function paintDiamond(ctx: Ctx, w: number, h: number) {
  const R = rng(21);
  ctx.fillStyle = hsl(28, 25, 22); ctx.fillRect(0, 0, w, h);
  const cols = 4, rows = 10, dw = w / cols, dh = h / rows;
  for (let r = -1; r <= rows; r++) for (let c = -1; c <= cols; c++) {
    const x = (c + (r % 2 ? 0.5 : 0)) * dw, y = r * dh;
    const l = 36 + R() * 14;
    const g = ctx.createLinearGradient(x, y, x, y + dh * 1.1);
    g.addColorStop(0, hsl(32, 30, l + 12)); g.addColorStop(0.55, hsl(28, 30, l)); g.addColorStop(1, hsl(24, 28, l - 16));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x + dw / 2, y); ctx.lineTo(x + dw - 3, y + dh * 0.55); ctx.lineTo(x + dw / 2, y + dh * 1.08); ctx.lineTo(x + 3, y + dh * 0.55); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = hsl(30, 20, 60, 0.35); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x + 6, y + dh * 0.5); ctx.lineTo(x + dw / 2, y + 3); ctx.lineTo(x + dw - 6, y + dh * 0.5); ctx.stroke();
  }
  noiseFill(ctx, w, h, R, 1200, (r) => hsl(30, 15, 20 + r * 40, 0.25), [2, 6]);
}

function paintBoot(ctx: Ctx, w: number, h: number) {
  const R = rng(33);
  ctx.fillStyle = hsl(30, 18, 26); ctx.fillRect(0, 0, w, h);
  noiseFill(ctx, w, h, R, 1500, (r) => hsl(32, 18, 24 + r * 25, 0.5), [2, 10]);
  const rows = 9, cols = 3;
  for (let r = 0; r < rows; r++) for (let c = 0; c <= cols; c++) {
    const x = (c + (r % 2 ? 0.5 : 0)) * w / cols, y = (r + 0.5) * h / rows;
    const l = 36 + R() * 16;
    for (const s of [-1, 1]) {
      ctx.fillStyle = hsl(34, 22, l);
      ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x + s * w / cols * 0.55, y - 22); ctx.lineTo(x + s * w / cols * 0.42, y - 30); ctx.lineTo(x - s * 4, y + 6); ctx.fill();
    }
    ctx.fillStyle = hsl(28, 20, 12, 0.8); ctx.beginPath(); ctx.ellipse(x, y + 22, 14, 7, 0, 0, Math.PI * 2); ctx.fill();
  }
}

function paintCactus(ctx: Ctx, w: number, h: number) {
  const R = rng(44);
  ctx.fillStyle = hsl(95, 22, 38); ctx.fillRect(0, 0, w, h);
  const ribs = 12, rw = w / ribs;
  for (let k = 0; k <= ribs; k++) {
    // crest highlight at x = k*rw, valley shade at (k+0.5)*rw
    const g = ctx.createLinearGradient(k * rw - rw / 2, 0, k * rw + rw / 2, 0);
    g.addColorStop(0, hsl(100, 22, 26, 0.6)); g.addColorStop(0.5, hsl(92, 20, 48, 0.5)); g.addColorStop(1, hsl(100, 22, 26, 0.6));
    ctx.fillStyle = g; ctx.fillRect(k * rw - rw / 2, 0, rw, h);
  }
  noiseFill(ctx, w, h, R, 1200, (r) => hsl(90, 18, 30 + r * 20, 0.25), [1.5, 12]);
  for (let k = 0; k <= ribs; k++) for (let y = 6; y < h; y += 24) {
    const x = k * rw + (R() - 0.5) * 2;
    ctx.fillStyle = hsl(45, 25, 75, 0.9); ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = hsl(40, 20, 80, 0.6); ctx.lineWidth = 0.8;
    for (let s = 0; s < 4; s++) { const a = R() * Math.PI * 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7); ctx.stroke(); }
  }
}

function paintAgave(ctx: Ctx, w: number, h: number) {
  const R = rng(55);
  const g = ctx.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, hsl(150, 12, 62)); g.addColorStop(0.7, hsl(160, 14, 55)); g.addColorStop(1, hsl(150, 14, 48));
  const cx = w / 2;
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(cx - w * 0.46, h);
  ctx.quadraticCurveTo(cx - w * 0.48, h * 0.45, cx - 3, 10);
  ctx.lineTo(cx, 0); ctx.lineTo(cx + 3, 10);
  ctx.quadraticCurveTo(cx + w * 0.48, h * 0.45, cx + w * 0.46, h); ctx.fill();
  // margin + teeth
  for (const s of [-1, 1]) for (let y = 30; y < h - 10; y += 22 + R() * 8) {
    const t = 1 - y / h;
    const x = cx + s * (w * 0.46) * Math.sqrt(Math.min(1, (1 - t) * 1.2)) * 0.98;
    ctx.fillStyle = hsl(25, 35, 25);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s * 6, y - 5); ctx.lineTo(x, y - 7); ctx.fill();
  }
  ctx.fillStyle = hsl(25, 35, 20); ctx.fillRect(cx - 2, 0, 4, 22);
  // bud imprints (faint)
  noiseFill(ctx, w, h, R, 300, (r) => hsl(150, 10, 45 + r * 20, 0.2), [8, 3]);
}

function paintBlades(ctx: Ctx, w: number, h: number, seed: number, n: number, hue: number, light: number, plumes: boolean, spread: number) {
  const R = rng(seed);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (R() - 0.5) * spread;
    const L = h * (0.55 + R() * 0.45);
    const bend = (a + Math.PI / 2) * 0.6 + (R() - 0.5) * 0.2;
    const l = light + (R() - 0.5) * 18;
    const g = ctx.createLinearGradient(0, h, 0, h - L);
    g.addColorStop(0, hsl(hue + 10, 30, l - 12)); g.addColorStop(1, hsl(hue - 10, 35, l + 10));
    blade(ctx, w / 2 + (R() - 0.5) * w * 0.12, h, a, L, 2.5 + R() * 2.5, g, bend);
    if (plumes && R() < 0.35) {
      const ex = w / 2 + Math.cos(a) * L * 0.9 + bend * L * 0.3, ey = h + Math.sin(a) * L * 0.9;
      ctx.fillStyle = hsl(40, 30, 72, 0.8);
      for (let k = 0; k < 14; k++) { ctx.beginPath(); ctx.ellipse(ex + (R() - 0.5) * 12, ey + k * 3, 3, 5, R(), 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

function paintLeafClump(ctx: Ctx, w: number, h: number, seed: number, n: number, size: number, hue: number, light: number, gloss: boolean, round = true) {
  const R = rng(seed);
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let x: number, y: number;
    if (round) { const a = R() * Math.PI * 2, r = Math.sqrt(R()) * (w / 2 - size * 1.2); x = cx + Math.cos(a) * r; y = cy + Math.sin(a) * r; }
    else { x = R() * w; y = R() * h; }
    const depth = round ? 1 - Math.hypot(x - cx, y - cy) / (w / 2) : R();
    const l = light - 10 + t * 16 + (R() - 0.5) * 10 - depth * 6;
    ctx.save(); ctx.translate(x, y); ctx.rotate(R() * Math.PI * 2);
    const s = size * (0.7 + R() * 0.6);
    ctx.fillStyle = hsl(hue + (R() - 0.5) * 12, 35 + R() * 10, l);
    ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    if (gloss) { ctx.fillStyle = hsl(hue, 20, l + 18, 0.5); ctx.beginPath(); ctx.ellipse(-s * 0.2, -s * 0.12, s * 0.45, s * 0.14, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = hsl(hue, 30, l - 12, 0.5); ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
    ctx.restore();
  }
}

function paintFlowers(ctx: Ctx, w: number, h: number, seed: number, cols: [number, number, number][]) {
  paintLeafClump(ctx, w, h, seed, 260, 9, 100, 34, false);
  const R = rng(seed + 1);
  for (let i = 0; i < 90; i++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * (w / 2 - 18);
    const x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r;
    const c = cols[Math.floor(R() * cols.length)];
    const s = 4 + R() * 4;
    for (let p = 0; p < 5; p++) {
      const pa = p / 5 * Math.PI * 2 + R();
      ctx.fillStyle = hsl(c[0], c[1], c[2] + (R() - 0.5) * 10);
      ctx.beginPath(); ctx.ellipse(x + Math.cos(pa) * s * 0.6, y + Math.sin(pa) * s * 0.6, s * 0.6, s * 0.35, pa, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = hsl(48, 80, 45); ctx.beginPath(); ctx.arc(x, y, s * 0.25, 0, Math.PI * 2); ctx.fill();
  }
}

function paintPad(ctx: Ctx, w: number, h: number) {
  const R = rng(66);
  const g = ctx.createRadialGradient(w * 0.45, h * 0.45, 5, w / 2, h / 2, w / 2);
  g.addColorStop(0, hsl(85, 30, 48)); g.addColorStop(0.85, hsl(90, 32, 38)); g.addColorStop(1, hsl(70, 30, 45));
  ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w / 2 - 6, h / 2 - 3, 0, 0, Math.PI * 2); ctx.fill();
  for (let i = 0; i < 40; i++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * 0.85;
    const x = w / 2 + Math.cos(a) * r * (w / 2 - 10), y = h / 2 + Math.sin(a) * r * (h / 2 - 8);
    ctx.fillStyle = hsl(45, 30, 70, 0.9); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  }
}

function paintMoss(ctx: Ctx, w: number, h: number) {
  const R = rng(88);
  for (let i = 0; i < 160; i++) {
    let x = R() * w, y = 0;
    const len = h * (0.35 + R() * 0.65);
    ctx.strokeStyle = hsl(80 + R() * 30, 8 + R() * 8, 52 + R() * 18, 0.85);
    ctx.lineWidth = 1 + R() * 2.2;
    ctx.beginPath(); ctx.moveTo(x, y);
    const f = 0.02 + R() * 0.03, ph = R() * 6;
    for (; y < len; y += 8) { x += Math.sin(y * f + ph) * 2.2 + (R() - 0.5) * 1.5; ctx.lineTo(x, y); }
    ctx.stroke();
  }
}

function paintOcotillo(ctx: Ctx, w: number, h: number) {
  const R = rng(99);
  const cx = w / 2;
  for (let y = 4; y < h; y += 7) {
    for (const s of [-1, 1]) if (R() < 0.8) {
      ctx.fillStyle = hsl(85 + R() * 15, 40, 32 + R() * 12);
      ctx.save(); ctx.translate(cx + s * 3, y); ctx.rotate(-Math.PI / 2 + s * (0.9 + R() * 0.4));
      ctx.beginPath(); ctx.ellipse(9, 0, 10, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  }
  ctx.fillStyle = hsl(30, 15, 38); ctx.fillRect(cx - 4, 0, 8, h);
  ctx.fillStyle = hsl(30, 10, 55, 0.6); ctx.fillRect(cx - 1, 0, 2, h);
}

function paintBark(ctx: Ctx, w: number, h: number) {
  const R = rng(123);
  ctx.fillStyle = hsl(28, 14, 32); ctx.fillRect(0, 0, w, h);
  noiseFill(ctx, w, h, R, 2600, (r) => hsl(26 + r * 8, 12, 18 + r * 30, 0.55), [3, 20]);
}

let atlasTex: THREE.DataTexture | null = null;
let atlasCanvas: HTMLCanvasElement | null = null;

/** Build (once) and return the plant atlas texture. */
export function plantAtlas(): THREE.Texture {
  if (atlasTex) return atlasTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS_PX;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, ATLAS_PX, ATLAS_PX);
  withCell(ctx, 'frond', (w, h) => paintFrond(ctx, w, h, false));
  withCell(ctx, 'frondDead', (w, h) => paintFrond(ctx, w, h, true));
  withCell(ctx, 'fan', (w, h) => paintFan(ctx, w, h, false));
  withCell(ctx, 'fanDead', (w, h) => paintFan(ctx, w, h, true));
  withCell(ctx, 'thatch', (w, h) => paintThatch(ctx, w, h));
  withCell(ctx, 'trunkRing', (w, h) => paintTrunkRing(ctx, w, h, false));
  withCell(ctx, 'trunkSmooth', (w, h) => paintTrunkRing(ctx, w, h, true));
  withCell(ctx, 'trunkDiamond', (w, h) => paintDiamond(ctx, w, h));
  withCell(ctx, 'trunkBoot', (w, h) => paintBoot(ctx, w, h));
  withCell(ctx, 'greenSmooth', (w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, hsl(95, 30, 40)); g.addColorStop(0.5, hsl(92, 32, 50)); g.addColorStop(1, hsl(95, 30, 40));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); noiseFill(ctx, w, h, rng(4), 300, (r) => hsl(90, 25, 40 + r * 15, 0.25), [3, 12]);
  });
  withCell(ctx, 'cactus', (w, h) => paintCactus(ctx, w, h));
  withCell(ctx, 'agave', (w, h) => paintAgave(ctx, w, h));
  withCell(ctx, 'yucca', (w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, hsl(70, 25, 45)); g.addColorStop(0.3, hsl(100, 30, 36)); g.addColorStop(1, hsl(95, 28, 44));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(w * 0.2, h); ctx.quadraticCurveTo(w * 0.02, h * 0.35, w * 0.47, 2); ctx.lineTo(w * 0.53, 2); ctx.quadraticCurveTo(w * 0.98, h * 0.35, w * 0.8, h); ctx.fill();
    ctx.strokeStyle = hsl(60, 30, 70, 0.6); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w / 2, h); ctx.lineTo(w / 2, 6); ctx.stroke();
  });
  withCell(ctx, 'grass', (w, h) => paintBlades(ctx, w, h, 12, 140, 62, 52, true, 1.3));
  withCell(ctx, 'flowersWarm', (w, h) => paintFlowers(ctx, w, h, 31, [[4, 75, 50], [40, 85, 55], [20, 80, 55], [52, 85, 58]]));
  withCell(ctx, 'flowersCool', (w, h) => paintFlowers(ctx, w, h, 37, [[275, 45, 55], [0, 0, 92], [320, 60, 70], [230, 45, 60]]));
  withCell(ctx, 'pad', (w, h) => paintPad(ctx, w, h));
  withCell(ctx, 'blossom', (w, h) => {
    paintLeafClump(ctx, w, h, 71, 70, 10, 100, 30, true);
    const R = rng(72);
    for (let i = 0; i < 700; i++) {
      const a = R() * Math.PI * 2, r = Math.sqrt(R()) * (w / 2 - 12);
      ctx.fillStyle = hsl(330 + R() * 20, 25 + R() * 20, 78 + R() * 14);
      ctx.beginPath(); ctx.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r * 1.1, 2.5 + R() * 3, 0, Math.PI * 2); ctx.fill();
    }
  });
  withCell(ctx, 'moss', (w, h) => paintMoss(ctx, w, h));
  withCell(ctx, 'ocotillo', (w, h) => paintOcotillo(ctx, w, h));
  withCell(ctx, 'shrubA', (w, h) => paintLeafClump(ctx, w, h, 81, 1400, 7, 100, 36, false));
  withCell(ctx, 'shrubB', (w, h) => paintLeafClump(ctx, w, h, 82, 520, 15, 105, 32, true));
  withCell(ctx, 'leafSolid', (w, h) => { ctx.fillStyle = hsl(100, 35, 22); ctx.fillRect(0, 0, w, h); paintLeafClump(ctx, w, h, 83, 900, 8, 100, 30, false, false); });
  withCell(ctx, 'bark', (w, h) => paintBark(ctx, w, h));
  atlasCanvas = cv;
  atlasTex = freeze(cv);
  return atlasTex;
}

/**
 * Copy canvas pixels into a DataTexture (rows flipped so UVs match a flipY CanvasTexture). A 2D canvas
 * can be evicted and restored blank by the browser under memory pressure before its first GPU upload.
 */
function freeze(cv: HTMLCanvasElement): THREE.DataTexture {
  const w = cv.width, h = cv.height;
  const src = cv.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h * 4);
  const row = w * 4;
  for (let y = 0; y < h; y++) data.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Debug: data URL of the atlas (for inspection). */
export function plantAtlasDataURL(): string {
  plantAtlas();
  return atlasCanvas!.toDataURL('image/png');
}

const foliageCache = new Map<string, THREE.Texture>();
/**
 * Leaf-card textures for ez-tree canopies whose stock textures read wrong: 'fine' = bipinnate sprays of
 * tiny leaflets (palo verde, mesquite, honey locust), 'small' = dense small simple leaves (live oak, elm,
 * crape myrtle). Card UV: base at bottom-center, tip at top (matches ez-tree leaf quads).
 */
export function foliageTexture(kind: 'fine' | 'small'): THREE.Texture {
  const hit = foliageCache.get(kind);
  if (hit) return hit;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const R = rng(kind === 'fine' ? 501 : 502);
  const twig = (x0: number, y0: number, a: number, L: number, w: number) => {
    ctx.strokeStyle = hsl(30, 20, 30); ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(a) * L, y0 + Math.sin(a) * L); ctx.stroke();
  };
  if (kind === 'fine') {
    // main twig from bottom center, several bipinnate leaves
    const base = [S / 2, S - 4] as const;
    twig(base[0], base[1], -Math.PI / 2, S * 0.55, 3);
    const leaves = 13;
    for (let i = 0; i < leaves; i++) {
      const t = 0.1 + (i / leaves) * 0.9;
      const px = base[0] + (R() - 0.5) * 6, py = base[1] - S * 0.55 * t;
      const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * (0.5 + R() * 0.7) * (1.1 - t * 0.5);
      const L = S * (0.32 + R() * 0.16);
      twig(px, py, a, L, 1.6);
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let k = 0.1; k < 1; k += 0.045) {
        const qx = px + ca * L * k, qy = py + sa * L * k;
        for (const s of [-1, 1]) {
          const la = a + s * (0.8 + R() * 0.4);
          const ll = 14 + R() * 8;
          ctx.fillStyle = hsl(72 + R() * 18, 26, 34 + R() * 16);
          ctx.save(); ctx.translate(qx + Math.cos(la) * ll * 0.5, qy + Math.sin(la) * ll * 0.5); ctx.rotate(la);
          ctx.beginPath(); ctx.ellipse(0, 0, ll * 0.55, 3.4, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        }
      }
    }
  } else {
    const base = [S / 2, S - 4] as const;
    twig(base[0], base[1], -Math.PI / 2, S * 0.7, 3);
    for (let i = 0; i < 9; i++) {
      const t = 0.15 + (i / 9) * 0.85;
      const px = base[0], py = base[1] - S * 0.7 * t;
      const a = -Math.PI / 2 + (i % 2 ? 1 : -1) * (0.6 + R() * 0.5);
      twig(px, py, a, S * 0.25, 1.5);
    }
    for (let i = 0; i < 260; i++) {
      const a = R() * Math.PI * 2, r = Math.sqrt(R());
      const x = S / 2 + Math.cos(a) * r * S * 0.42, y = S * 0.48 + Math.sin(a) * r * S * 0.44;
      const s = 16 + R() * 10;
      const l = 28 + R() * 20;
      ctx.save(); ctx.translate(x, y); ctx.rotate(R() * Math.PI * 2);
      ctx.fillStyle = hsl(88 + R() * 16, 30, l);
      ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hsl(90, 25, l + 14, 0.45); ctx.beginPath(); ctx.ellipse(-s * 0.2, -s * 0.1, s * 0.5, s * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = hsl(90, 30, l - 10, 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0); ctx.stroke();
      ctx.restore();
    }
  }
  const tex = freeze(cv);
  foliageCache.set(kind, tex);
  return tex;
}
