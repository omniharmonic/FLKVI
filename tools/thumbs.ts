// Prebuild featured-city picker thumbnails: a stylized top-down map of each baked recipe
// (public/recipes/<id>.json → public/recipes/thumbs/<id>.png, 320×200) plus public/recipes/thumbs/index.json
// with small facts (region, camera and building counts). Same look as src/ui/thumbs.ts drawThumb().
// Usage: node --experimental-strip-types tools/thumbs.ts [id ...]
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePNG } from './png.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REC = join(ROOT, 'public/recipes');
const OUT = join(REC, 'thumbs');
const W = 320, H = 200, SS = 3; // supersampled 3×
const VIEW = 760; // meters across

type RGB = [number, number, number];
type P = [number, number];

class Canvas {
  w = W * SS; h = H * SS;
  px = new Float32Array(this.w * this.h * 3);
  fillAll(c: RGB) { for (let i = 0; i < this.w * this.h; i++) { this.px[i * 3] = c[0]; this.px[i * 3 + 1] = c[1]; this.px[i * 3 + 2] = c[2]; } }
  blend(i: number, c: RGB, a: number) {
    const k = i * 3; const p = this.px;
    p[k] += (c[0] - p[k]) * a; p[k + 1] += (c[1] - p[k + 1]) * a; p[k + 2] += (c[2] - p[k + 2]) * a;
  }
  /** Even-odd scanline polygon fill (one or more rings). */
  poly(rings: P[][], c: RGB, a = 1) {
    let minY = Infinity, maxY = -Infinity;
    for (const r of rings) for (const [, y] of r) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(this.h - 1, Math.ceil(maxY));
    const xs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5; xs.length = 0;
      for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xa, ya] = r[i], [xb, yb] = r[j];
        if ((ya > sy) !== (yb > sy)) xs.push(xa + ((sy - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(this.w, Math.round(xs[k + 1]));
        for (let x = xa; x < xb; x++) this.blend(y * this.w + x, c, a);
      }
    }
  }
  circle(cx: number, cy: number, r: number, c: RGB, a = 1) {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(this.h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(this.w - 1, Math.ceil(cx + r)); x++)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.blend(y * this.w + x, c, a);
  }
  ring(cx: number, cy: number, r0: number, r1: number, c: RGB) {
    for (let y = Math.max(0, Math.floor(cy - r1)); y <= Math.min(this.h - 1, Math.ceil(cy + r1)); y++)
      for (let x = Math.max(0, Math.floor(cx - r1)); x <= Math.min(this.w - 1, Math.ceil(cx + r1)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d >= r0 && d <= r1) this.blend(y * this.w + x, c, 1);
      }
  }
  glow(cx: number, cy: number, r: number, c: RGB, a0: number) {
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(this.h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(this.w - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r; if (d < 1) this.blend(y * this.w + x, c, a0 * (1 - d));
      }
  }
  /** Thick polyline: quads per segment + round joins. */
  line(pts: P[], width: number, c: RGB) {
    const hw = width / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const L = Math.hypot(bx - ax, by - ay) || 1; const nx = (-(by - ay) / L) * hw, ny = ((bx - ax) / L) * hw;
      this.poly([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]]], c);
    }
    if (hw > 0.8) for (const [x, y] of pts) this.circle(x, y, hw, c);
  }
  /** Box-downsample to W×H and apply a vignette. */
  toRGB(): Uint8Array {
    const out = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const k = ((y * SS + j) * this.w + x * SS + i) * 3; r += this.px[k]; g += this.px[k + 1]; b += this.px[k + 2]; }
      const n = SS * SS;
      const d = Math.hypot(x - W / 2, y - H / 2) / Math.hypot(W / 2, H / 2);
      const v = 1 - 0.55 * Math.min(1, Math.max(0, (d - 0.45) / 0.55));
      const o = (y * W + x) * 3;
      out[o] = Math.round((r / n) * v); out[o + 1] = Math.round((g / n) * v); out[o + 2] = Math.round((b / n) * v);
    }
    return out;
  }
}

const GREEN = new Set(['park', 'grass', 'pitch', 'playground', 'forest', 'garden', 'cemetery', 'meadow', 'golf']);
const hex = (s: string): RGB => { const m = /^#?([0-9a-f]{6})$/i.exec(s || ''); if (!m) return [140, 140, 140]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

function render(r: any): Buffer {
  const cv = new Canvas();
  const [cx, cz] = r.spawn.p as P;
  const s = cv.w / VIEW;
  const T = ([x, z]: P): P => [(x - cx) * s + cv.w / 2, (z - cz) * s + cv.h / 2];
  cv.fillAll([12, 15, 19]);
  for (const a of r.areas ?? []) {
    const k = a.kind as string;
    const c: RGB | null = k === 'water' ? [18, 48, 73] : GREEN.has(k) ? [24, 48, 31] : k === 'parking' ? [21, 24, 29] : k === 'pedestrian' ? [29, 33, 39] : null;
    if (c) cv.poly([a.poly.map(T), ...(a.holes ?? []).map((h: P[]) => h.map(T))], c);
  }
  const roads = [...(r.roads ?? [])].sort((a: any, b: any) => a.width - b.width);
  for (const pass of [0, 1]) for (const rd of roads) {
    if (rd.pts.length < 2) continue;
    const w = Math.max(0.7 * SS, (rd.width + (pass ? 0 : (rd.sidewalk || 0) * 2)) * s);
    cv.line(rd.pts.map(T), w, pass ? (rd.width > 12 ? [90, 98, 112] : [61, 67, 77]) : [26, 30, 36]);
  }
  for (const b of r.buildings ?? []) {
    const f = b.footprint as P[]; if (!f || f.length < 3) continue;
    const col = hex(b.color);
    const k = 0.34 + Math.min(1, (b.height + (b.roofHeight || 0)) / 60) * 0.3;
    const base: RGB = [38, 42, 50];
    const c = base.map((v, i) => Math.round(v * (1 - k) + col[i] * k)) as RGB;
    const ring = f.map(T);
    cv.poly([ring], c);
    cv.line([...ring, ring[0]], 0.6 * SS * 0.5, [255, 255, 255].map((v, i) => c[i] + (v - c[i]) * 0.08) as RGB);
  }
  for (const cm of r.cameras ?? []) {
    const [x, y] = T(cm.p);
    cv.glow(x, y, 7 * SS * 0.6, [255, 45, 61], 0.55);
    cv.circle(x, y, 1.7 * SS * 0.8, [255, 59, 74]);
  }
  cv.ring(cv.w / 2, cv.h / 2, 5 * SS * 0.8 - 1.2, 5 * SS * 0.8 + 1.2, [255, 178, 62]);
  cv.circle(cv.w / 2, cv.h / 2, 1.8 * SS * 0.8, [255, 178, 62]);
  return encodePNG(W, H, cv.toRGB());
}

mkdirSync(OUT, { recursive: true });
const want = process.argv.slice(2);
const ids = readdirSync(REC).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => !want.length || want.includes(id));
let index: Record<string, unknown> = {};
try { index = JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')); } catch { /* fresh */ }
for (const id of ids) {
  const t0 = Date.now();
  const r = JSON.parse(readFileSync(join(REC, `${id}.json`), 'utf8'));
  writeFileSync(join(OUT, `${id}.png`), render(r));
  index[id] = { region: r.region, cams: r.cameras?.length ?? 0, bldgs: r.buildings?.length ?? 0 };
  console.log(`${id}: ${Date.now() - t0} ms`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index, null, 1));
