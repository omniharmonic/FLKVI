// Street-level detail emitted into the chunk buckets (no extra draw calls): wall lanterns that glow at
// night, address plaques, faded painted wall signs, and sidewalk clutter in front of storefronts
// (sandwich boards, cafe tables, planters).
import * as THREE from 'three';
import { Frame, type MB } from './builder';
import { layer, relTint, lampSlot, OVERLAY } from './materials';
import type { BCtx } from './facade';

type Surf = (B: BCtx['B'], lod: 0 | 1 | 2, id: string, color: THREE.Color, strength?: number) => MB;
const C = (h: string) => new THREE.Color(h);
const DARKM = C('#1b1c1d');

/** Sidewalk info in front of a facade point: free depth (m) before the curb, and ground height. */
export type FrontInfo = (x: number, z: number) => { clear: number; y: number } | null;
let frontInfo: FrontInfo | null = null;
/** World hook: lets the facade grammar place sidewalk clutter only where the sidewalk is deep enough. */
export function setFrontInfo(fn: FrontInfo | null) { frontInfo = fn; }

function surfOf(B: BCtx['B'], lod: 0 | 1 | 2, id: string, color: THREE.Color): MB {
  const mb = B.s[lod];
  const L = layer(id);
  mb.layer = L.index;
  mb.setTint(relTint(color, L.base));
  return mb;
}

/** Emissive lens quad (sign bucket) facing +N of frame f, centred at (s, y), depth d. */
function lens(c: BCtx, f: Frame, s0: number, s1: number, y0: number, y1: number, d: number) {
  const [u0, v0, u1, v1] = lampSlot();
  const mb = c.B.sign;
  mb.setTint([1, 1, 1]);
  mb.quad(f.pt(s0, y0, d), f.pt(s1, y0, d), f.pt(s1, y1, d), f.pt(s0, y1, d), [u0, v0, u1, v0, u1, v1, u0, v1]);
}

/** Carriage lantern on the wall at (s, y) (bottom of the lantern). */
export function wallLantern(c: BCtx, f: Frame, s: number, y: number) {
  const m = surfOf(c.B, 0, 'metal', DARKM);
  m.box(f, s - 0.07, s + 0.07, y + 0.05, y + 0.32, 0, 0.025, 1 | 4 | 8 | 16 | 32, [0.8, 1]); // back plate
  m.box(f, s - 0.015, s + 0.015, y + 0.25, y + 0.28, 0.02, 0.12, 63); // arm
  m.box(f, s - 0.09, s + 0.09, y + 0.3, y + 0.34, 0.07, 0.25, 63); // cap
  m.box(f, s - 0.07, s + 0.07, y - 0.02, y + 0.01, 0.09, 0.23, 63); // base
  for (const [a, b] of [[-0.075, -0.06], [0.06, 0.075]]) {
    m.box(f, s + a, s + b, y, y + 0.3, 0.09, 0.105, 63);
    m.box(f, s + a, s + b, y, y + 0.3, 0.215, 0.23, 63);
  }
  // glowing glass panes: front + both sides
  lens(c, f, s - 0.062, s + 0.062, y + 0.02, y + 0.29, 0.222);
  const pr = f.pt(s + 0.068, 0, 0.22), pl = f.pt(s - 0.068, 0, 0.1);
  const fs = new Frame(pr[0], pr[2], -f.nx, -f.nz); // faces +T
  const fn = new Frame(pl[0], pl[2], f.nx, f.nz); // faces -T
  lens(c, fs, 0, 0.12, y + 0.02, y + 0.29, 0);
  lens(c, fn, 0, 0.12, y + 0.02, y + 0.29, 0);
}

/** Industrial wall pack above a door: box with a downward lens. */
export function wallPack(c: BCtx, f: Frame, s: number, y: number) {
  surfOf(c.B, 0, 'metal', C('#3a3d40')).box(f, s - 0.16, s + 0.16, y, y + 0.22, 0, 0.18, 63, [0.8, 1]);
  const [u0, v0, u1, v1] = lampSlot();
  const mb = c.B.sign;
  mb.setTint([1, 1, 1]);
  mb.quad(f.pt(s - 0.14, y - 0.002, 0.02), f.pt(s + 0.14, y - 0.002, 0.02), f.pt(s + 0.14, y - 0.002, 0.16), f.pt(s - 0.14, y - 0.002, 0.16), [u0, v0, u1, v0, u1, v1, u0, v1]);
}

/** Gooseneck sign lamp head lens (faces down). */
export function downLens(c: BCtx, f: Frame, s: number, y: number, d: number, hw: number) {
  const [u0, v0, u1, v1] = lampSlot();
  const mb = c.B.sign;
  mb.setTint([1, 1, 1]);
  mb.quad(f.pt(s - hw, y, d - hw), f.pt(s + hw, y, d - hw), f.pt(s + hw, y, d + hw), f.pt(s - hw, y, d + hw), [u0, v0, u1, v0, u1, v1, u0, v1]);
}

/** House-number plaque (0.2 m square) with its left edge at s, centre height y. */
export function plaque(c: BCtx, f: Frame, s: number, y: number, seed: number) {
  const k = seed % 16, i = k % 4, j = Math.floor(k / 4);
  const mb = surfOf(c.B, 0, 'plaque', C('#ffffff'));
  mb.setTint([1, 1, 1]);
  const d = 0.018, h = 0.1;
  mb.quad(f.pt(s, y - h, d), f.pt(s + 0.2, y - h, d), f.pt(s + 0.2, y + h, d), f.pt(s, y + h, d), [i / 4, 1 - (j + 1) / 4, (i + 1) / 4, 1 - (j + 1) / 4, (i + 1) / 4, 1 - j / 4, i / 4, 1 - j / 4]);
  surfOf(c.B, 0, 'metal', C('#3a3a3a')).box(f, s, s + 0.2, y - h, y + h, 0, d, 4 | 8 | 16 | 32);
}

/** Faded painted advertisement on a blank old-brick wall (overlay on the wall texture). */
export function ghostSign(c: BCtx, surf: Surf, f: Frame, L: number, y1: number, seed: number) {
  const { st } = c;
  const w = Math.min(L - 1.6, 11, Math.max(0, (y1 - c.floorBase - 3) * 4));
  if (w < 4.5) return;
  const h = w / 4;
  const s0 = 0.8 + ((seed >>> 4) % 100) / 100 * (L - 1.6 - w), s1 = s0 + w;
  const y0 = y1 - h;
  const mb = surf(c.B, 2, st.wallTex, st.wallColor);
  mb.layer += OVERLAY;
  const k = seed % 4;
  const vl = 1 - (k + 1) / 4 + 0.004, vh = 1 - k / 4 - 0.004;
  mb.wxq = [0, 0, 0, vl, 0, 0, 1, vl, 0, 0, 1, vh, 0, 0, 0, vh];
  const u0 = f.u0, d = 0.012;
  mb.quad(f.pt(s0, y0, d), f.pt(s1, y0, d), f.pt(s1, y1, d), f.pt(s0, y1, d), [u0 + s0, y0, u0 + s1, y0, u0 + s1, y1, u0 + s0, y1]);
  mb.wxq = null;
  mb.layer -= OVERLAY;
}

// ---------------------------------------------------------------------------------------------
// Sidewalk clutter in front of one storefront bay [a, z] (facade frame f, ground y at the wall)
// ---------------------------------------------------------------------------------------------
export function storefrontClutter(c: BCtx, f: Frame, a: number, z: number, cat: number, sd: number, entryS: number | null) {
  if (!frontInfo) return;
  const mid = (a + z) / 2;
  const p = f.pt(mid, 0, 1.2);
  const fi = frontInfo(p[0], p[2]);
  if (!fi || fi.clear < 2.2) return;
  const y = fi.y;
  if (Math.abs(y - c.groundY) > 0.6) return;
  const r = (k: number) => ((Math.imul(sd ^ (k * 0x9e3779b1), 2654435761) >>> 0) / 4294967296);
  const B = c.B;
  const food = cat === 1;
  // sandwich board near the entry
  if ((food && r(1) < 0.8) || (!food && r(1) < 0.3)) {
    const s = entryS ?? mid;
    const dd = Math.min(fi.clear - 0.9, food ? 2.2 : 1.6);
    if (dd > 0.8) sandwichBoard(c, f, s + (r(2) < 0.5 ? -1 : 1) * 0.9, dd, y, sd);
  }
  // cafe tables on wide sidewalks
  if (food && fi.clear >= 4.0 && z - a > 2.6) {
    const n = Math.max(1, Math.min(3, Math.floor((z - a - 0.6) / 2.2)));
    for (let i = 0; i < n; i++) {
      const s = a + (z - a) * (i + 0.5) / n;
      if (entryS !== null && Math.abs(s - entryS) < 1.1) continue;
      bistroSet(c, f, s, 1.05, y, sd + i * 17);
    }
  } else if (!food && fi.clear >= 3.0 && r(3) < 0.35) {
    planter(c, f, (r(4) < 0.5 ? a + 0.7 : z - 0.7), 0.45, y, sd);
  }
  void B;
}

function sandwichBoard(c: BCtx, f: Frame, s: number, d: number, y: number, sd: number) {
  const B = c.B;
  // NB: surfOf() sets layer/tint on the shared bucket, so re-select before each group
  const board = () => surfOf(B, 2, 'dark', C(sd & 1 ? '#1d2220' : '#26211d'));
  const frame = () => surfOf(B, 2, 'wood-planks', C('#6b4a2e'));
  const H = 0.95, W = 0.6, spread = 0.2;
  // two leaves hinged at the top, splayed along the facade normal
  for (const sg of [-1, 1]) {
    const dT = d, dB = d + sg * spread;
    const q0 = f.pt(s - W / 2, y, dB), q1 = f.pt(s + W / 2, y, dB), q2 = f.pt(s + W / 2, y + H, dT), q3 = f.pt(s - W / 2, y + H, dT);
    if (sg > 0) { board().quad(q0, q1, q2, q3, [0, 0, W, 0, W, H, 0, H], [0.8, 0.8, 1, 1]); }
    else { board().quad(q1, q0, q3, q2, [0, 0, W, 0, W, H, 0, H], [0.8, 0.8, 1, 1]); }
    // frame rails
    frame().quad(f.pt(s - W / 2 - 0.03, y, dB + sg * 0.002), f.pt(s - W / 2, y, dB + sg * 0.002), f.pt(s - W / 2, y + H, dT), f.pt(s - W / 2 - 0.03, y + H, dT), [0, 0, 0.03, 0, 0.03, H, 0, H]);
    frame().quad(f.pt(s + W / 2, y, dB + sg * 0.002), f.pt(s + W / 2 + 0.03, y, dB + sg * 0.002), f.pt(s + W / 2 + 0.03, y + H, dT), f.pt(s + W / 2, y + H, dT), [0, 0, 0.03, 0, 0.03, H, 0, H]);
  }
  // chalk lines (light paint strips on the street-facing leaf)
  const chalk = surfOf(B, 2, 'paint', C('#d8d4c8'));
  for (let k = 0; k < 5; k++) {
    const t0 = 0.25 + k * 0.12, t1 = t0 + 0.035;
    const lw = 0.18 + 0.2 * (((sd >>> k) & 3) / 3);
    const dd0 = d + spread * (1 - t0) + 0.006, dd1 = d + spread * (1 - t1) + 0.006;
    chalk.quad(f.pt(s - lw, y + H * t0, dd0), f.pt(s + lw, y + H * t0, dd0), f.pt(s + lw, y + H * t1, dd1), f.pt(s - lw, y + H * t1, dd1), [0, 0, 1, 0, 1, 1, 0, 1]);
  }
}

function bistroSet(c: BCtx, f: Frame, s: number, d: number, y: number, sd: number) {
  const B = c.B;
  const metalC = C(sd & 2 ? '#1c1f1d' : '#2c2a27');
  // table: round-ish top (octagon prism), post, base
  const top = sd & 1 ? surfOf(B, 2, 'wood-planks', C('#7a5a3c')) : surfOf(B, 2, 'metal', C('#9a9c9c'));
  const cp = f.pt(s, 0, d);
  const R = 0.32, n = 8;
  const ring: [number, number, number][] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + Math.PI / n; ring.push([cp[0] + Math.cos(a) * R, y + 0.74, cp[2] + Math.sin(a) * R]); }
  top.polygon(ring.map((p) => [p[0], y + 0.76, p[2]] as [number, number, number]), [0, 1, 0], (p) => [p[0], p[2]]);
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    top.quad([q[0], y + 0.72, q[2]], [p[0], y + 0.72, p[2]], [p[0], y + 0.76, p[2]], [q[0], y + 0.76, q[2]], [0, 0, 1, 0, 1, 1, 0, 1], 0.8);
  }
  const metal = surfOf(B, 2, 'metal', metalC);
  metal.obox(cp[0], y + 0.37, cp[2], 0.025, 0.36, 0.025, 0);
  metal.obox(cp[0], y + 0.015, cp[2], 0.22, 0.015, 0.22, Math.PI / 4);
  // two chairs either side along the facade
  const yaw = Math.atan2(f.tz, f.tx);
  for (const sg of [-1, 1]) {
    const ch = f.pt(s + sg * 0.6, 0, d);
    const bx = f.pt(s + sg * 0.78, 0, d);
    metal.obox(ch[0], y + 0.45, ch[2], 0.2, 0.02, 0.2, yaw); // seat
    metal.obox(bx[0], y + 0.68, bx[2], 0.015, 0.22, 0.19, yaw); // back
    for (const [ox, oz] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
      const lp = f.pt(s + sg * 0.6 + ox, 0, d + oz);
      metal.obox(lp[0], y + 0.22, lp[2], 0.012, 0.22, 0.012, yaw, [0.8, 1], 1 | 2 | 4 | 8);
    }
  }
}

function planter(c: BCtx, f: Frame, s: number, d: number, y: number, sd: number) {
  const B = c.B;
  const pot = surfOf(B, 2, sd & 1 ? 'concrete-plain' : 'paint', C(sd & 1 ? '#a8a49c' : '#3a3f3c'));
  pot.box(f, s - 0.45, s + 0.45, y, y + 0.55, d - 0.25, d + 0.25, 1 | 4 | 8 | 16 | 2, [0.75, 1]);
  const soil = surfOf(B, 2, 'dark', C('#2b2118'));
  soil.box(f, s - 0.4, s + 0.4, y + 0.5, y + 0.53, d - 0.2, d + 0.2, 16);
  // clipped shrub: a few stacked, offset boxes of dark green
  const g = surfOf(B, 2, 'roof-gravel', C(sd & 2 ? '#2f4a22' : '#3b5526'));
  for (let k = 0; k < 3; k++) {
    const o = (((sd >>> (k * 3)) & 7) / 7 - 0.5) * 0.12;
    g.box(f, s - 0.36 + o, s + 0.36 + o, y + 0.53 + k * 0.14, y + 0.72 + k * 0.14 - k * 0.02, d - 0.19 + o * 0.5, d + 0.19 - o * 0.5, 63, [0.7, 1]);
  }
}
