// Facade grammar: per footprint edge → floors → bays → openings (real recessed geometry), trims,
// storefronts, cornices, parapets, porches, balconies, fire escapes. Emits into chunk buckets.
import * as THREE from 'three';
import type { RecipeBuilding, Vec2 } from '../../core/types';
import { MB, NullMB, Frame, type WinAttr, type V3 } from './builder';
import { layer, relTint, signSlot } from './materials';
import type { Style } from './kits';
import { signWord } from './kits';
import { shopCategory } from './shopGlsl';
import { wallLantern, wallPack, plaque, downLens, ghostSign, storefrontClutter, sidewalkY } from './streetDetail';

export interface Buckets {
  /** surface buckets: [lod0 detail, lod1 far, common] */
  s: [MB, MB, MB];
  /** glass buckets: [lod0, lod1, common] */
  g: [MB, MB, MB];
  sign: MB;
}
export type Lod = 0 | 1 | 2;

export function newBuckets(): Buckets {
  return { s: [new MB('surface'), new MB('surface'), new MB('surface')], g: [new MB('glass'), new MB('glass'), new MB('glass')], sign: new MB('plain') };
}
/** Buckets for chunks away from the spawn: the detailed (lod0) output is discarded (built on demand later). */
export function newFarBuckets(): Buckets {
  return { s: [new NullMB(), new MB('surface'), new MB('surface')], g: [new NullMB(), new MB('glass'), new MB('glass')], sign: new MB('plain') };
}
/** Buckets that keep only the detailed (lod0) facade output; everything else is discarded. */
export function newLod0Buckets(): Buckets {
  const n = new NullMB();
  return { s: [new MB('surface'), n, n], g: [new MB('glass'), n, n], sign: n };
}

/** Surface bucket with texture layer + relative tint applied. */
export function surf(B: Buckets, lod: Lod, id: string, color: THREE.Color, strength = 1): MB {
  const mb = B.s[lod];
  const L = layer(id);
  mb.layer = L.index;
  mb.setTint(relTint(color, L.base, strength));
  return mb;
}

const WHITE = new THREE.Color(1, 1, 1);
const DARK = new THREE.Color('#1a1a1a');
const DOOR_COLORS = ['#6b1f1a', '#1f2f25', '#1e2a3a', '#2a2a2a', '#7a5a3a', '#f1eee6', '#8a6a2a', '#3b4a5a'];
const col = (h: string) => new THREE.Color(h);

export interface Floor { y0: number; y1: number; k: number }

/** Height (m above the street) above which window openings are built flush at every LOD. */
const FLUSH_ABOVE = 45;

export interface BCtx {
  B: Buckets;
  b: RecipeBuilding;
  st: Style;
  r: () => number;
  /** terrain level under building */
  groundY: number;
  /** wall bottom (groundY + minHeight) */
  base: number;
  /** first floor level (base + foundation) */
  floorBase: number;
  floors: Floor[];
  /** top of walls (parapet top for flat roofs, eave for pitched) */
  top: number;
  /** roof deck level for flat roofs */
  deckY: number;
  flat: boolean;
  isPart: boolean;
  frontEdge: number;
  streetSet: Set<number>;
  ring: Vec2[];
  /** extra output: approximate triangle counts etc. */
  winCount: number;
  /** position of the front door along the front edge (set by the ground-floor grammar) */
  doorS?: number;
  /** y where rain streaks start on the upper wall (under the cornice / coping) */
  streakTop?: number;
  /** a painted ghost sign was placed on this building */
  ghostDone?: boolean;
}

export function aoAt(c: BCtx, y: number): number {
  const h = y - c.groundY;
  let a = 0.62 + 0.38 * Math.min(1, Math.max(0, h / 2.2));
  if (c.st.cornice !== 'none' && y > c.top - c.st.corniceH - 0.9 && y < c.top - c.st.corniceH + 0.05) a *= 0.86;
  return a;
}

// ---------------------------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------------------------
export type OpType = 'win' | 'door' | 'store' | 'entry' | 'garage' | 'loading' | 'open' | 'lobby' | 'balc' | 'spandrel';
export interface Op {
  s0: number; s1: number; y0: number; y1: number;
  t: OpType;
  r: number;
  muntin: number;
  kind: number;
  reflect: number;
  roomW: number;
  floorY: number;
  floorH: number;
  seed: number;
  color?: THREE.Color;
}

/** Solid wall rectangle [sA,sB]×[yA,yB] at depth d with rectangular holes. */
function wallGrid(c: BCtx, mb: MB, f: Frame, sA: number, sB: number, yA: number, yB: number, ops: Op[], d = 0) {
  if (sB - sA < 1e-3 || yB - yA < 1e-3) return;
  const xs = [sA, sB], ys = [yA, yB];
  for (const o of ops) {
    if (o.s1 <= sA || o.s0 >= sB || o.y1 <= yA || o.y0 >= yB) continue;
    xs.push(Math.max(sA, o.s0), Math.min(sB, o.s1));
    ys.push(Math.max(yA, o.y0), Math.min(yB, o.y1));
  }
  // AO rows near the ground
  for (const h of [0.35, 1.1, 2.2]) { const y = c.groundY + h; if (y > yA + 0.05 && y < yB - 0.05) ys.push(y); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const X = xs.filter((v, i) => i === 0 || v - xs[i - 1] > 1e-4);
  const Y = ys.filter((v, i) => i === 0 || v - ys[i - 1] > 1e-4);
  const u0 = f.u0;
  const topY = c.streakTop ?? Infinity;
  for (let j = 0; j < Y.length - 1; j++) {
    const ya = Y[j], yb = Y[j + 1], cy = (ya + yb) / 2;
    const aa = aoAt(c, ya), ab = aoAt(c, yb);
    let run = -1, runKey = -1;
    // rain-streak source per cell: the window sill directly above (key = op index), else none (-1)
    const keyOf = (i: number) => {
      for (let k = 0; k < ops.length; k++) {
        const o = ops[k];
        if (o.t === 'win' && Math.abs(o.y0 - yb) < 1e-3 && X[i] >= o.s0 - 1e-4 && X[i + 1] <= o.s1 + 1e-4) return k;
      }
      return -1;
    };
    const emit = (xa: number, xb: number, key: number) => {
      if (key >= 0) {
        const h = yb - ya;
        mb.wxq = [1, h, 0, 0, 1, h, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
      } else if (topY - yb < 1.8 && topY >= yb - 1e-3) {
        const va = topY - ya, vb = topY - yb;
        mb.wxq = [0.8, va, 0, 0, 0.8, va, 0, 0, 0.8, vb, 0, 0, 0.8, vb, 0, 0];
      }
      mb.quad(f.pt(xa, ya, d), f.pt(xb, ya, d), f.pt(xb, yb, d), f.pt(xa, yb, d), [u0 + xa, ya, u0 + xb, ya, u0 + xb, yb, u0 + xa, yb], [aa, aa, ab, ab]);
      mb.wxq = null;
    };
    for (let i = 0; i <= X.length - 1; i++) {
      let filled = false, key = -1;
      if (i < X.length - 1) {
        const cx = (X[i] + X[i + 1]) / 2;
        filled = true;
        for (const o of ops) if (cx > o.s0 && cx < o.s1 && cy > o.y0 && cy < o.y1) { filled = false; break; }
        if (filled && ops.length) key = keyOf(i);
      }
      if (run >= 0 && (!filled || key !== runKey)) { emit(X[run], X[i], runKey); run = -1; }
      if (filled && run < 0) { run = i; runKey = key; }
    }
  }
}

function glassQuad(mb: MB, f: Frame, s0: number, s1: number, y0: number, y1: number, d: number, o: Op, sash: THREE.Color) {
  const w = s1 - s0, h = y1 - y0;
  const wa: WinAttr = { lx: 0, ly: 0, a: [w, h, y0 - o.floorY, o.floorH], b: [o.seed % 10007, o.kind + Math.min(0.95, o.reflect), o.muntin, o.roomW] };
  mb.setTint(sash);
  mb.quad(f.pt(s0, y0, d), f.pt(s1, y0, d), f.pt(s1, y1, d), f.pt(s0, y1, d), [0, 0, 1, 0, 1, 1, 0, 1], 1, wa, [[0, 0], [w, 0], [w, h], [0, h]]);
}

/** Reveal (jambs/head/sill faces) of an opening recessed by r. */
function reveal(mb: MB, f: Frame, o: Op, r: number, aoOut = 0.85, aoIn = 0.55, bottom = true) {
  const { s0, s1, y0, y1 } = o;
  const P = (s: number, y: number, d: number) => f.pt(s, y, d);
  const u0 = f.u0;
  mb.quad(P(s0, y0, 0), P(s0, y0, -r), P(s0, y1, -r), P(s0, y1, 0), [u0 + s0, y0, u0 + s0 + r, y0, u0 + s0 + r, y1, u0 + s0, y1], [aoOut, aoIn, aoIn, aoOut]);
  mb.quad(P(s1, y0, -r), P(s1, y0, 0), P(s1, y1, 0), P(s1, y1, -r), [u0 + s1 - r, y0, u0 + s1, y0, u0 + s1, y1, u0 + s1 - r, y1], [aoIn, aoOut, aoOut, aoIn]);
  mb.quad(P(s0, y1, -r), P(s1, y1, -r), P(s1, y1, 0), P(s0, y1, 0), [u0 + s0, -r, u0 + s1, -r, u0 + s1, 0, u0 + s0, 0], [aoIn * 0.8, aoIn * 0.8, aoOut * 0.8, aoOut * 0.8]);
  if (bottom) mb.quad(P(s0, y0, 0), P(s1, y0, 0), P(s1, y0, -r), P(s0, y0, -r), [u0 + s0, 0, u0 + s1, 0, u0 + s1, -r, u0 + s0, -r], [aoOut, aoOut, aoIn, aoIn]);
}

/** Frame ring (sash) inside an opening at depth dz. */
function frameRing(mb: MB, f: Frame, s0: number, s1: number, y0: number, y1: number, dz: number, fw: number, depth: number) {
  mb.box(f, s0, s0 + fw, y0, y1, dz - depth, dz, 1, [0.8, 0.9]);
  mb.box(f, s1 - fw, s1, y0, y1, dz - depth, dz, 1, [0.8, 0.9]);
  mb.box(f, s0 + fw, s1 - fw, y1 - fw, y1, dz - depth, dz, 1 | 32, [0.85, 0.85]);
  mb.box(f, s0 + fw, s1 - fw, y0, y0 + fw, dz - depth, dz, 1 | 16, [0.9, 0.9]);
}

function emitOpening(c: BCtx, f: Frame, o: Op, wallId: string) {
  const { B, st } = c;
  const w = o.s1 - o.s0;
  const r = o.r;
  // ---- LOD1 (flush) ----
  // Openings high up a tower (> FLUSH_ABOVE m over the street) are flush at both LODs: their reveals,
  // frames and sills are a pixel or two from the street, yet cost ~60 tris per window × hundreds of floors.
  const flushOnly = o.y0 - c.groundY > FLUSH_ABOVE;
  for (const L of (flushOnly ? [1, 0] : [1]) as Lod[]) {
    if (o.t === 'garage' || o.t === 'loading') {
      const mb = surf(B, L, o.t === 'loading' ? 'lap-siding' : 'paint', o.color ?? st.trim);
      mb.quad(f.pt(o.s0, o.y0, 0.01), f.pt(o.s1, o.y0, 0.01), f.pt(o.s1, o.y1, 0.01), f.pt(o.s0, o.y1, 0.01), [f.u0 + o.s0, o.y0, f.u0 + o.s1, o.y0, f.u0 + o.s1, o.y1, f.u0 + o.s0, o.y1], 0.85);
    } else if (o.t === 'door') {
      const mb = surf(B, L, 'paint', o.color ?? DARK);
      mb.quad(f.pt(o.s0, o.y0, 0.01), f.pt(o.s1, o.y0, 0.01), f.pt(o.s1, o.y1, 0.01), f.pt(o.s0, o.y1, 0.01), [0, 0, 1, 0, 1, 1, 0, 1], 0.8);
    } else {
      const gy0 = o.t === 'store' ? o.y0 + 0.5 : o.y0;
      if (o.t === 'store') {
        const mb = surf(B, L, 'paint', st.trim);
        mb.quad(f.pt(o.s0, o.y0, 0.01), f.pt(o.s1, o.y0, 0.01), f.pt(o.s1, gy0, 0.01), f.pt(o.s0, gy0, 0.01), [0, 0, 1, 0, 1, 1, 0, 1], 0.7);
      }
      glassQuad(B.g[L], f, o.s0, o.s1, gy0, o.y1, 0.012, o, st.sash);
    }
  }
  if (flushOnly) return;

  // ---- LOD0 (detail) ----
  const s0 = B.s[0];
  // reveal in wall material (storefront/entry use trim)
  const revId = o.t === 'store' || o.t === 'entry' || o.t === 'lobby' ? 'paint' : o.t === 'open' ? 'concrete' : wallId;
  const revCol = revId === 'paint' ? st.trim : revId === 'concrete' ? col('#b8b4ab') : st.wallColor;
  if (r > 0.005) {
    surf(B, 0, revId, revCol);
    reveal(s0, f, o, r, 0.85, o.t === 'entry' ? 0.45 : 0.55, o.t !== 'door' && o.t !== 'entry' && o.t !== 'garage' && o.t !== 'loading' && o.t !== 'store');
  }
  const dz = -r;
  switch (o.t) {
    case 'win':
    case 'balc': {
      const fw = o.muntin === 0 && o.kind === 1 ? 0.05 : 0.065;
      surf(B, 0, 'paint', st.sash);
      frameRing(s0, f, o.s0, o.s1, o.y0, o.y1, dz, fw, 0.07);
      glassQuad(B.g[0], f, o.s0 + fw, o.s1 - fw, o.y0 + fw, o.y1 - fw, dz - 0.03, o, st.sash);
      // sill
      if (o.t === 'win' && st.win.sillType !== 'none') {
        const stone = st.win.sillType === 'stone';
        const mb = stone ? surf(B, 0, 'trim-stone', st.stone) : surf(B, 0, 'paint', st.trim);
        const ext = stone ? 0.08 : 0.05;
        mb.box(f, o.s0 - ext, o.s1 + ext, o.y0 - (stone ? 0.1 : 0.05), o.y0, -r * 0.3, stone ? 0.07 : 0.05, 1 | 16 | 32, [0.8, 1]);
      }
      // lintel / head
      lintel(c, f, o);
      if (st.win.casing) {
        const mb = surf(B, 0, 'paint', st.trim);
        mb.box(f, o.s0 - 0.1, o.s0, o.y0, o.y1, 0, 0.025, 1 | 8, [0.9, 1]);
        mb.box(f, o.s1, o.s1 + 0.1, o.y0, o.y1, 0, 0.025, 1 | 4, [0.9, 1]);
        if (st.win.lintel === 'none') mb.box(f, o.s0 - 0.1, o.s1 + 0.1, o.y1, o.y1 + 0.12, 0, 0.025, 1 | 16 | 4 | 8, [0.9, 1]);
      }
      if (st.win.shutters && o.t === 'win') {
        const sc = st.trim.getHSL({ h: 0, s: 0, l: 0 }).l > 0.6 ? col(pick(c.r, ['#1f2f25', '#2a2a2a', '#1e2a3a', '#5a2a22'])) : st.trim;
        const mb = surf(B, 0, 'paint', sc);
        const sw = w * 0.5;
        mb.box(f, o.s0 - 0.08 - sw, o.s0 - 0.08, o.y0, o.y1, 0.01, 0.05, 1 | 4 | 8 | 16, [0.85, 1]);
        mb.box(f, o.s1 + 0.08, o.s1 + 0.08 + sw, o.y0, o.y1, 0.01, 0.05, 1 | 4 | 8 | 16, [0.85, 1]);
        // louver hint: horizontal rails
        const n = Math.max(2, Math.floor((o.y1 - o.y0) / 0.35));
        for (let i = 1; i < n; i++) {
          const y = o.y0 + (o.y1 - o.y0) * i / n;
          mb.box(f, o.s0 - 0.08 - sw, o.s0 - 0.08, y - 0.015, y + 0.015, 0.05, 0.06, 1 | 16, [0.8, 0.9]);
          mb.box(f, o.s1 + 0.08, o.s1 + 0.08 + sw, y - 0.015, y + 0.015, 0.05, 0.06, 1 | 16, [0.8, 0.9]);
        }
      }
      break;
    }
    case 'spandrel': {
      glassQuad(B.g[0], f, o.s0, o.s1, o.y0, o.y1, dz - 0.01, o, st.sash);
      break;
    }
    case 'door': {
      const dc = o.color ?? col(pick(c.r, DOOR_COLORS));
      surf(B, 0, 'paint', st.trim);
      frameRing(s0, f, o.s0, o.s1, o.y0, o.y1, dz, 0.07, 0.06);
      const mb = surf(B, 0, 'paint', dc);
      const x0 = o.s0 + 0.07, x1 = o.s1 - 0.07, ytop = o.y1 - 0.07;
      mb.box(f, x0, x1, o.y0, ytop, dz - 0.08, dz - 0.04, 1, [0.75, 0.9]);
      // raised panels
      const pw = (x1 - x0 - 0.3) / 2;
      for (const px of [x0 + 0.1, x0 + 0.2 + pw]) {
        mb.box(f, px, px + pw, o.y0 + 0.2, o.y0 + 0.9, dz - 0.04, dz - 0.025, 1 | 16 | 4 | 8, [0.8, 0.9]);
      }
      if ((o.seed & 3) !== 0) {
        glassQuad(B.g[0], f, x0 + 0.12, x1 - 0.12, o.y0 + 1.15, ytop - 0.15, dz - 0.035, { ...o, kind: 0, muntin: (o.seed & 4) ? 2 : 0 }, dc);
      } else {
        mb.box(f, x0 + 0.1, x1 - 0.1, o.y0 + 1.1, ytop - 0.15, dz - 0.04, dz - 0.025, 1 | 16 | 4 | 8, [0.8, 0.9]);
      }
      // knob
      surf(B, 0, 'metal', col('#b8a060')).box(f, x1 - 0.12, x1 - 0.07, o.y0 + 0.95, o.y0 + 1.0, dz - 0.04, dz + 0.0, 1 | 4 | 8 | 16);
      lintel(c, f, o);
      {
        // porch lantern(s) + house number
        const cw = st.win.casing ? 0.12 : 0.02;
        if (o.kind === 3) wallPack(c, f, (o.s0 + o.s1) / 2, o.y1 + 0.3);
        else {
          if (o.s0 - cw - 0.35 > 0.1) wallLantern(c, f, o.s0 - cw - 0.2, o.y0 + 1.72);
          if (o.seed & 1) wallLantern(c, f, o.s1 + cw + 0.2, o.y0 + 1.72);
          else plaque(c, f, o.s1 + cw + 0.08, o.y0 + 1.55, o.seed >>> 3);
        }
      }
      if (st.win.casing) {
        const tm = surf(B, 0, 'paint', st.trim);
        tm.box(f, o.s0 - 0.12, o.s0, o.y0, o.y1, 0, 0.03, 1 | 8, [0.9, 1]);
        tm.box(f, o.s1, o.s1 + 0.12, o.y0, o.y1, 0, 0.03, 1 | 4, [0.9, 1]);
        tm.box(f, o.s0 - 0.12, o.s1 + 0.12, o.y1, o.y1 + 0.16, 0, 0.035, 1 | 16 | 4 | 8, [0.9, 1]);
      }
      break;
    }
    case 'store': {
      const tm = surf(B, 0, 'paint', st.trim);
      // kickplate
      tm.box(f, o.s0, o.s1, o.y0, o.y0 + 0.5, dz - 0.05, dz + 0.04, 1 | 16, [0.6, 0.8]);
      const fw = 0.08;
      frameRing(tm, f, o.s0, o.s1, o.y0 + 0.5, o.y1, dz + 0.04, fw, 0.1);
      const nm = Math.max(1, Math.round((o.s1 - o.s0) / 2.6));
      for (let i = 1; i < nm; i++) {
        const x = o.s0 + (o.s1 - o.s0) * i / nm;
        tm.box(f, x - 0.04, x + 0.04, o.y0 + 0.5, o.y1, dz - 0.06, dz + 0.04, 1 | 4 | 8, [0.8, 0.9]);
      }
      glassQuad(B.g[0], f, o.s0 + fw, o.s1 - fw, o.y0 + 0.5 + fw, o.y1 - fw, dz - 0.02, o, st.trim);
      break;
    }
    case 'entry': {
      // deep recessed entry: glass door + sidelights at the back, transom above
      const tm = surf(B, 0, 'paint', st.trim);
      const bw = o.s1 - o.s0;
      const dw = Math.min(1.0, bw * 0.55);
      const dm = (o.s0 + o.s1) / 2;
      const hDoor = Math.min(2.3, o.y1 - o.y0 - 0.4);
      // back wall: glass with frame
      frameRing(tm, f, o.s0, o.s1, o.y0, o.y1, dz + 0.06, 0.08, 0.08);
      tm.box(f, dm - dw / 2 - 0.05, dm - dw / 2 + 0.03, o.y0, o.y0 + hDoor, dz - 0.03, dz + 0.06, 1 | 4 | 8, [0.8, 0.9]);
      tm.box(f, dm + dw / 2 - 0.03, dm + dw / 2 + 0.05, o.y0, o.y0 + hDoor, dz - 0.03, dz + 0.06, 1 | 4 | 8, [0.8, 0.9]);
      tm.box(f, o.s0 + 0.08, o.s1 - 0.08, o.y0 + hDoor, o.y0 + hDoor + 0.1, dz - 0.03, dz + 0.06, 1 | 16 | 32, [0.8, 0.9]);
      glassQuad(B.g[0], f, o.s0 + 0.08, o.s1 - 0.08, o.y0 + 0.08, o.y1 - 0.08, dz, { ...o, kind: 2, muntin: o.muntin % 1 }, st.trim);
      // floor tile + ceiling of the recess
      const fl = surf(B, 0, 'trim-stone', col('#8c877f'));
      fl.quad(f.pt(o.s0, o.y0 + 0.01, 0), f.pt(o.s1, o.y0 + 0.01, 0), f.pt(o.s1, o.y0 + 0.01, dz), f.pt(o.s0, o.y0 + 0.01, dz), [0, 0, bw, 0, bw, r, 0, r], [0.8, 0.8, 0.5, 0.5]);
      // door pull
      surf(B, 0, 'metal', col('#c0b08a')).box(f, dm + dw / 2 - 0.2, dm + dw / 2 - 0.17, o.y0 + 0.8, o.y0 + 1.4, dz + 0.06, dz + 0.1, 1 | 4 | 8);
      break;
    }
    case 'lobby': {
      const tm = surf(B, 0, 'metal', st.sash);
      frameRing(tm, f, o.s0, o.s1, o.y0, o.y1, dz + 0.05, 0.08, 0.1);
      glassQuad(B.g[0], f, o.s0 + 0.08, o.s1 - 0.08, o.y0 + 0.08, o.y1 - 0.08, dz, o, st.sash);
      break;
    }
    case 'garage':
    case 'loading': {
      const gc = o.color ?? (o.t === 'loading' ? col('#8a8f94') : st.trim);
      const mb = surf(B, 0, o.t === 'loading' ? 'lap-siding' : 'paint', gc);
      const n = o.t === 'loading' ? 1 : 4;
      const h = (o.y1 - o.y0) / n;
      for (let i = 0; i < n; i++) {
        const ya = o.y0 + i * h;
        mb.box(f, o.s0, o.s1, ya + 0.01, ya + h - 0.01, dz - 0.05, dz, 1 | 16 | 32, [0.75, 0.85]);
        if (o.t === 'garage') {
          // panel recesses
          const np = Math.max(2, Math.round((o.s1 - o.s0) / 0.6));
          const pw = (o.s1 - o.s0) / np;
          for (let k = 0; k < np; k++) mb.box(f, o.s0 + k * pw + 0.05, o.s0 + (k + 1) * pw - 0.05, ya + 0.08, ya + h - 0.08, dz, dz + 0.012, 1 | 16 | 32 | 4 | 8, [0.8, 0.9]);
        }
      }
      if (o.t === 'garage' && (o.seed & 1)) {
        glassQuad(B.g[0], f, o.s0 + 0.15, o.s1 - 0.15, o.y1 - h + 0.12, o.y1 - 0.14, dz + 0.013, { ...o, kind: 3, muntin: 9.06 }, gc);
      }
      const trimC = surf(B, 0, 'paint', st.trim);
      trimC.box(f, o.s0 - 0.1, o.s1 + 0.1, o.y1, o.y1 + 0.14, 0, 0.03, 1 | 16 | 4 | 8, [0.9, 1]);
      break;
    }
    case 'open': {
      glassQuad(B.g[0], f, o.s0, o.s1, o.y0, o.y1, dz, o, DARK);
      break;
    }
  }
}

function pick<T>(r: () => number, a: T[]): T { return a[Math.floor(r() * a.length) % a.length]; }

function lintel(c: BCtx, f: Frame, o: Op) {
  const { B, st } = c;
  const y1 = o.y1;
  switch (st.win.lintel) {
    case 'stone': surf(B, 0, 'trim-stone', st.stone).box(f, o.s0 - 0.12, o.s1 + 0.12, y1, y1 + 0.24, 0, 0.035, 1 | 16 | 32, [0.85, 1]); break;
    case 'keystone': {
      const mb = surf(B, 0, 'trim-stone', st.stone);
      mb.box(f, o.s0 - 0.1, o.s1 + 0.1, y1, y1 + 0.22, 0, 0.03, 1 | 16 | 32, [0.85, 1]);
      const m = (o.s0 + o.s1) / 2;
      mb.box(f, m - 0.12, m + 0.12, y1 - 0.05, y1 + 0.34, 0, 0.06, 1 | 16 | 32, [0.85, 1]);
      break;
    }
    case 'soldier': surf(B, 0, st.wallTex, st.wallColor.clone().multiplyScalar(0.82)).box(f, o.s0 - 0.08, o.s1 + 0.08, y1, y1 + 0.25, 0, 0.02, 1 | 32, [0.85, 1]); break;
    case 'hood': {
      const mb = st.wallTex.startsWith('brick') || st.wallTex === 'stone' || st.wallTex === 'sandstone' ? surf(B, 0, 'trim-stone', st.stone) : surf(B, 0, 'paint', st.trim);
      mb.box(f, o.s0 - 0.14, o.s1 + 0.14, y1 + 0.02, y1 + 0.26, 0, 0.08, 1 | 32, [0.85, 1]);
      mb.box(f, o.s0 - 0.2, o.s1 + 0.2, y1 + 0.26, y1 + 0.34, 0, 0.14, 63, [0.85, 1]);
      // small brackets
      mb.box(f, o.s0 - 0.14, o.s0 - 0.06, y1 - 0.15, y1 + 0.02, 0, 0.07, 1 | 32, [0.8, 1]);
      mb.box(f, o.s1 + 0.06, o.s1 + 0.14, y1 - 0.15, y1 + 0.02, 0, 0.07, 1 | 32, [0.8, 1]);
      break;
    }
    case 'wood': {
      const mb = surf(B, 0, 'paint', st.trim);
      mb.box(f, o.s0 - 0.14, o.s1 + 0.14, y1, y1 + 0.18, 0, 0.035, 1 | 32, [0.9, 1]);
      mb.box(f, o.s0 - 0.18, o.s1 + 0.18, y1 + 0.18, y1 + 0.23, 0, 0.07, 63, [0.9, 1]);
      break;
    }
    case 'flat': surf(B, 0, 'paint', st.trim).box(f, o.s0 - 0.12, o.s1 + 0.12, y1, y1 + 0.16, 0, 0.04, 1 | 16 | 32, [0.9, 1]); break;
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Edge facade
// ---------------------------------------------------------------------------------------------
export interface EdgeInfo { a: Vec2; b: Vec2; L: number; f: Frame; street: boolean; front: boolean; rear: boolean; i: number }

/** Plain wall rect in common bucket (identical at both LODs). */
function plainWall(c: BCtx, f: Frame, s0: number, s1: number, y0: number, y1: number, id: string, color: THREE.Color, d = 0) {
  const mb = surf(c.B, 2, id, color);
  wallGrid(c, mb, f, s0, s1, y0, y1, [], d);
}

let seedCounter = 0;

export function facadeEdge(c: BCtx, e: EdgeInfo) {
  const { B, st, b } = c;
  const f = e.f, L = e.L;
  const w = st.win;
  const wallId = st.wallTex;
  const r = c.r;
  seedCounter = (b.seed ^ (e.i * 7919)) >>> 0;
  c.streakTop = c.top - (st.cornice !== 'none' ? st.corniceH : c.flat && st.coping ? 0 : 0.2);
  const nextSeed = () => (seedCounter = (Math.imul(seedCounter, 1664525) + 1013904223) >>> 0);

  // foundation band (residential raised floor / civic plinth)
  const fTop = c.floorBase;
  if (fTop > c.base + 0.02) {
    const fid = st.kit === 'civic' || st.kit === 'brownstone' ? 'trim-stone' : 'concrete-plain';
    const fc = fid === 'trim-stone' ? st.stone : col('#a9a59c');
    plainWall(c, f, 0, L, c.base - 0.6, fTop, fid, fc, 0.03);
    surf(B, 2, fid, fc).box(f, 0, L, fTop - 0.02, fTop, 0, 0.03, 16, [1, 1]);
  } else if (!c.isPart) {
    // bury walls slightly into terrain
    plainWall(c, f, 0, L, c.base - 0.6, c.base, wallId, st.wallColor);
  }

  const tooShort = L < 1.4;
  let hasWin = true;
  if (!e.street && st.blankSides) hasWin = e.rear ? r() < 0.85 : r() < st.sideWindows;
  if (tooShort) hasWin = false;

  const margin = st.cornerPiers ? 0.7 : 0.55;
  const lastFloorTop = c.floors.length ? c.floors[c.floors.length - 1].y1 : fTop;

  // curtain-wall towers: whole edge is glass
  if (w.pattern === 'curtain' && !tooShort) {
    curtainEdge(c, e, lastFloorTop);
  } else {
    // bay grid shared by all floors on this edge
    const bayW = e.street || !st.blankSides ? w.bay : w.bay * 1.3;
    const usable = L - 2 * margin;
    let nb = Math.floor(usable / bayW);
    const groupW = w.group * w.w + (w.group - 1) * 0.2;
    if (nb < 1 && usable > groupW + 0.3) nb = 1;
    const bay = nb > 0 ? usable / nb : 0;
    // balcony columns (stacked vertically)
    const balcCols = new Set<number>();
    if (st.balconies > 0 && c.floors.length > 1) for (let i = 0; i < nb; i++) if (((b.seed >>> (i % 24)) & 7) / 8 < st.balconies && e.L > 6) balcCols.add(i);

    for (const fl of c.floors) {
      const ops: Op[] = [];
      const fh = fl.y1 - fl.y0;
      const ground = fl.k === 0 && !c.isPart;
      let handled = false;
      if (ground) handled = groundFloor(c, e, fl, ops, nb, bay, margin, nextSeed);
      if (!handled && (hasWin || (ground && ops.length > 0)) && (nb > 0 || w.pattern === 'parking')) {
        if (w.pattern === 'ribbon') {
          const y0 = fl.y0 + w.sill, y1 = Math.min(fl.y1 - 0.35, y0 + w.h);
          ops.push({ s0: margin, s1: L - margin, y0, y1, t: 'win', r: 0.06, muntin: 9 + w.bay / 10, kind: w.kind, reflect: w.reflect, roomW: 9, floorY: fl.y0, floorH: fh, seed: nextSeed() });
        } else if (w.pattern === 'parking') {
          const nCol = Math.max(1, Math.round((L - 0.6) / 8));
          const cw = (L - 0.6) / nCol;
          for (let i = 0; i < nCol; i++) {
            const a0 = 0.3 + i * cw + 0.25, a1 = 0.3 + (i + 1) * cw - 0.25;
            if (ops.some((o) => o.s1 > a0 && o.s0 < a1)) continue;
            ops.push({ s0: 0.3 + i * cw + 0.25, s1: 0.3 + (i + 1) * cw - 0.25, y0: fl.y0 + 1.05, y1: fl.y1 - 0.4, t: 'open', r: 0.3, muntin: 0, kind: 5, reflect: 0, roomW: 30, floorY: fl.y0, floorH: fh, seed: nextSeed() });
          }
        } else if (w.pattern !== 'blank') {
          for (let i = 0; i < nb; i++) {
            const cx = margin + (i + 0.5) * bay;
            const balc = balcCols.has(i) && fl.k > 0;
            const sd = nextSeed();
            for (let g = 0; g < w.group; g++) {
              const x0 = cx - groupW / 2 + g * (w.w + 0.2);
              let y0 = fl.y0 + w.sill, y1 = Math.min(fl.y1 - 0.3, y0 + w.h);
              if (y1 - y0 < 0.5) continue;
              if (balc) { y0 = fl.y0 + 0.02; y1 = Math.min(fl.y1 - 0.3, fl.y0 + 2.3); }
              ops.push({ s0: x0, s1: x0 + w.w, y0, y1, t: balc ? 'balc' : 'win', r: w.reveal, muntin: w.muntin, kind: w.kind, reflect: w.reflect, roomW: 3 + (sd % 100) / 40, floorY: fl.y0, floorH: fh, seed: sd + g });
            }
            if (balc && e.L > 6) balcony(c, f, cx - Math.max(groupW, 1.6) / 2 - 0.5, cx + Math.max(groupW, 1.6) / 2 + 0.5, fl.y0);
          }
        }
      }
      // wall band with openings
      wallGrid(c, surf(B, 0, wallId, st.wallColor), f, 0, L, fl.y0, fl.y1, ops);
      wallGrid(c, surf(B, 1, wallId, st.wallColor), f, 0, L, fl.y0, fl.y1, []);
      for (const o of ops) emitOpening(c, f, o, wallId);
      c.winCount += ops.length;
      // string course / floor band at top of floor
      if (fl.k < c.floors.length - 1) {
        if (st.stringCourse && (fl.k === 0 || st.kit === 'civic' || st.kit === 'masonry-tower')) surf(B, 2, 'trim-stone', st.stone).box(f, 0, L, fl.y1 - 0.12, fl.y1 + 0.12, 0, 0.05, 1 | 4 | 8 | 16 | 32, [0.85, 1]);
        else if (st.floorBands) {
          const id = st.accentTex ?? 'concrete-plain';
          surf(B, 2, id, st.accentTex ? st.accentColor : col('#b0aca4')).box(f, 0, L, fl.y1 - 0.18, fl.y1 + 0.12, 0, 0.04, 1 | 4 | 8 | 16 | 32, [0.9, 1]);
        }
      }
    }
    // podium/modern accent panels: vertical accent strip panels on upper floors
    if (st.accentTex && c.floors.length > 1 && L > 8) accentPanels(c, e, nb, bay, margin);
    // faded painted advertising on blank side walls of old brick buildings
    if (!hasWin && !c.ghostDone && !c.isPart && wallId.startsWith('brick') && (b.era === 'pre-1900' || b.era === '1900-1939') && (b.seed % 5) < 3 && L > 6) {
      ghostSign(c, surf, f, L, (c.streakTop ?? c.top) - 0.7, b.seed >>> 2);
      c.ghostDone = true;
    }
  }

  // frieze / parapet band above top floor (identical at both LODs)
  if (c.top > lastFloorTop + 0.01) plainWall(c, f, 0, L, lastFloorTop, c.top, w.pattern === 'curtain' ? 'metal-panel' : wallId, w.pattern === 'curtain' ? st.sash : st.wallColor);
  // parapet inner face + coping
  if (c.flat && st.parapet > 0.05) {
    const pm = surf(B, 2, w.pattern === 'curtain' ? 'metal-panel' : wallId, w.pattern === 'curtain' ? st.sash : st.wallColor.clone().multiplyScalar(0.9));
    pm.box(f, 0, L, c.deckY - 0.05, c.top, -0.3, 0, 2, [0.7, 1]);
    if (st.coping) surf(B, 2, st.wallTex.startsWith('brick') || st.kit === 'civic' ? 'trim-stone' : 'metal', st.wallTex.startsWith('brick') ? st.stone : col('#9a9c9e')).box(f, -0.02, L + 0.02, c.top, c.top + 0.08, -0.34, 0.05, 1 | 2 | 16 | 4 | 8, [0.9, 1]);
  }
  // corner piers / pilasters / quoins
  if (st.cornerPiers && L > 2) {
    const pc = st.wallColor.clone().multiplyScalar(0.93);
    const mb = surf(B, 2, wallId, pc);
    const y0 = c.floorBase, y1 = c.top - (st.cornice !== 'none' ? st.corniceH : 0);
    mb.box(f, 0, 0.5, y0, y1, 0, 0.07, 1 | 4 | 8, [0.8, 1]);
    mb.box(f, L - 0.5, L, y0, y1, 0, 0.07, 1 | 4 | 8, [0.8, 1]);
  }
  if (st.quoins && L > 2) {
    const mb = surf(B, 0, 'trim-stone', st.stone);
    let k = 0;
    for (let y = c.floorBase; y < c.top - (st.corniceH + 0.4); y += 0.34, k++) {
      const wq = k % 2 ? 0.35 : 0.6;
      mb.box(f, 0, wq, y + 0.01, y + 0.32, 0.07, 0.11, 1 | 4 | 16 | 32, [0.85, 1]);
      mb.box(f, L - wq, L, y + 0.01, y + 0.32, 0.07, 0.11, 1 | 8 | 16 | 32, [0.85, 1]);
    }
  }
  // cornice
  if (st.cornice !== 'none' && (e.street || !st.blankSides || e.rear) && L > 1) cornice(c, e);
  // vigas (pueblo)
  if (st.vigas && L > 2) {
    const mb = surf(B, 2, 'wood-planks', col('#6b4a2e'));
    const y = c.deckY - 0.35;
    for (let s = 0.6; s < L - 0.4; s += 0.8) mb.box(f, s - 0.1, s + 0.1, y - 0.1, y + 0.1, 0, 0.45, 1 | 4 | 8 | 16 | 32, [0.7, 0.9]);
  }
  // fire escape on rear (or street for tenements without rear)
  if (st.fireEscape && c.floors.length >= 3 && L > 5 && (e.rear || (e.street && st.kit === 'brownstone' && false))) fireEscape(c, f, L);
}

function accentPanels(c: BCtx, e: EdgeInfo, nb: number, bay: number, margin: number) {
  const { B, st } = c;
  if (!st.accentTex || nb < 2) return;
  const f = e.f;
  const mb = surf(B, 2, st.accentTex, st.accentColor);
  const up = c.floors.filter((x) => x.k > 0);
  if (!up.length) return;
  const y0 = up[0].y0 + 0.02, y1 = up[up.length - 1].y1 - 0.02;
  // alternate bays: accent cladding piers between windows (projecting 8 cm)
  for (let i = 0; i <= nb; i++) {
    if ((i + (c.b.seed & 1)) % 2) continue;
    const x = margin + i * bay;
    const hw = Math.min(0.55, (bay - c.st.win.w * c.st.win.group) / 2 - 0.08);
    if (hw < 0.15) continue;
    mb.box(f, Math.max(0, x - hw), Math.min(e.L, x + hw), y0, y1, 0, 0.08, 1 | 4 | 8 | 16 | 32, [0.85, 1]);
  }
}

function curtainEdge(c: BCtx, e: EdgeInfo, lastTop: number) {
  const { B, st } = c;
  const f = e.f, L = e.L, w = st.win;
  const n = Math.max(1, Math.round(L / w.bay));
  const bay = L / n;
  const sash = st.sash;
  for (const fl of c.floors) {
    const fh = fl.y1 - fl.y0;
    const ground = fl.k === 0 && !c.isPart;
    const sd = (c.b.seed * 31 + fl.k * 977 + e.i * 13) >>> 0;
    if (ground) {
      // lobby: tall clear glass slightly recessed behind the column line
      const o: Op = { s0: 0, s1: L, y0: fl.y0, y1: fl.y1, t: 'lobby', r: 0, muntin: 9 + Math.min(0.29, bay / 10), kind: 6, reflect: 0.05, roomW: 20, floorY: fl.y0, floorH: fh, seed: sd };
      glassQuad(B.g[2], f, 0, L, fl.y0, fl.y1 - 0.5, -0.8, o, sash);
      surf(B, 2, 'metal-panel', sash).box(f, 0, L, fl.y1 - 0.5, fl.y1, -0.8, 0, 1 | 32, [0.7, 0.9]);
      surf(B, 2, 'trim-stone', col('#8c877f')).quad(f.pt(0, fl.y0 + 0.01, 0), f.pt(L, fl.y0 + 0.01, 0), f.pt(L, fl.y0 + 0.01, -0.8), f.pt(0, fl.y0 + 0.01, -0.8), [0, 0, L, 0, L, 0.8, 0, 0.8], 0.7);
      continue;
    }
    const spH = Math.min(1.0, fh * 0.28);
    const oS: Op = { s0: 0, s1: L, y0: fl.y0, y1: fl.y0 + spH, t: 'spandrel', r: 0, muntin: 9 + Math.min(0.29, bay / 10), kind: 4, reflect: w.reflect, roomW: 20, floorY: fl.y0, floorH: fh, seed: sd };
    const oV: Op = { ...oS, y0: fl.y0 + spH, y1: fl.y1, t: 'win', kind: 1, muntin: 9 + Math.min(0.29, bay / 10), roomW: 9, seed: sd + 1 };
    glassQuad(B.g[2], f, 0, L, oS.y0, oS.y1, 0, oS, sash);
    glassQuad(B.g[2], f, 0, L, oV.y0, oV.y1, 0, oV, sash);
    c.winCount += n;
  }
  // mullion fins (vertical) and floor-line transoms
  const ym0 = c.floors[0].y1, ym1 = lastTop;
  if (ym1 > ym0) {
    const m = surf(B, 2, 'metal', sash);
    for (let i = 0; i <= n; i++) {
      const x = i * bay;
      m.box(f, Math.max(0, x - 0.04), Math.min(L, x + 0.04), ym0, ym1, 0, 0.1, 1 | 4 | 8, [0.9, 1]);
    }
    for (const fl of c.floors) if (fl.k > 0) m.box(f, 0, L, fl.y0 - 0.04, fl.y0 + 0.04, 0, 0.06, 1 | 16 | 32, [0.9, 1]);
  }
  // lobby columns
  const colM = surf(B, 2, 'metal-panel', sash);
  const g0 = c.floors[0];
  if (g0) for (let x = 0; x <= L + 0.01; x += Math.max(L / Math.max(1, Math.round(L / 8)), 4)) colM.box(f, Math.max(0, x - 0.3), Math.min(L, x + 0.3), g0.y0, g0.y1, -0.6, 0, 1 | 4 | 8, [0.8, 1]);
}

function groundFloor(c: BCtx, e: EdgeInfo, fl: Floor, ops: Op[], nb: number, bay: number, margin: number, nextSeed: () => number): boolean {
  const { st, b } = c;
  const L = e.L, f = e.f;
  const fh = fl.y1 - fl.y0;
  const w = st.win;
  if ((st.ground === 'storefront') && e.street) {
    // storefront bays separated by pilasters
    const nS = Math.max(1, Math.round((L - 0.8) / 5.5));
    const sb = (L - 0.8) / nS;
    const top = fl.y1 - Math.min(1.0, fh * 0.24); // sign band above
    for (let i = 0; i < nS; i++) {
      const a = 0.4 + i * sb + 0.22, z = 0.4 + (i + 1) * sb - 0.22;
      const sd = nextSeed();
      // interior category (encoded in the muntin fraction): shared by a building's bays, occasionally varied
      const catI = shopCategory(i > 0 && (sd & 7) === 0 ? undefined : b.signage, (b.seed + (i > 0 && (sd & 7) === 0 ? i : 0)) >>> 0);
      const cat = catI * 0.05;
      const entryHere = sb > 3.2 && (i % 2 === 0 || nS === 1);
      let entryS: number | null = null;
      if (entryHere) {
        const ew = Math.min(1.8, sb * 0.38);
        const left = (sd & 1) === 1;
        const ea = left ? a : z - ew, ez = left ? a + ew : z;
        entryS = (ea + ez) / 2;
        ops.push({ s0: ea, s1: ez, y0: fl.y0, y1: top, t: 'entry', r: 1.1, muntin: cat, kind: 2, reflect: 0, roomW: 8, floorY: fl.y0, floorH: fh, seed: sd + 7 });
        const da = left ? ez : a, dz = left ? z : ea;
        if (dz - da > 0.8) ops.push({ s0: da, s1: dz, y0: fl.y0, y1: top, t: 'store', r: 0.18, muntin: 7 + cat, kind: 2, reflect: 0, roomW: 8, floorY: fl.y0, floorH: fh, seed: sd });
      } else {
        ops.push({ s0: a, s1: z, y0: fl.y0, y1: top, t: 'store', r: 0.18, muntin: 7 + cat, kind: 2, reflect: 0, roomW: 8, floorY: fl.y0, floorH: fh, seed: sd });
      }
      storefrontDress(c, f, a - 0.22, z + 0.22, fl.y0, top, fl.y1, i, sd, L < 16 && nS > 1);
      storefrontClutter(c, f, a, z, catI, sd, entryS);
    }
    if (L < 16 && nS > 1) storefrontSign(c, f, 0.6, L - 0.6, top, fl.y1, 0, nextSeed());
    // pilasters between bays (+ends)
    const pm = st.kit === 'main-street-block' || st.kit === 'brick-warehouse' ? surf(c.B, 2, 'paint', st.trim) : surf(c.B, 2, st.wallTex, st.wallColor.clone().multiplyScalar(0.9));
    for (let i = 0; i <= nS; i++) {
      const x = 0.4 + i * sb;
      pm.box(f, Math.max(0, x - 0.26), Math.min(L, x + 0.26), fl.y0, top + 0.05, 0, 0.12, 1 | 4 | 8, [0.75, 1]);
      pm.box(f, Math.max(0, x - 0.3), Math.min(L, x + 0.3), fl.y0, fl.y0 + 0.3, 0, 0.15, 1 | 4 | 8 | 16, [0.7, 0.8]);
    }
    // storefront cornice (beam) over the sign band
    const bm = surf(c.B, 2, 'paint', st.trim);
    bm.box(f, 0, L, fl.y1 - 0.18, fl.y1, 0, 0.2, 1 | 4 | 8 | 16 | 32, [0.8, 1]);
    bm.box(f, 0, L, top, top + 0.12, 0, 0.1, 1 | 4 | 8 | 16 | 32, [0.8, 1]);
    return true;
  }
  if (st.ground === 'lobby' && e.street) {
    const lw = Math.min(L - 2 * margin, Math.max(3.5, L * 0.35));
    const a = (L - lw) / 2;
    ops.push({ s0: a, s1: a + lw, y0: fl.y0, y1: fl.y1 - 0.6, t: 'lobby', r: 0.5, muntin: 9.15, kind: 6, reflect: 0.05, roomW: 14, floorY: fl.y0, floorH: fh, seed: nextSeed() });
    // side windows in remaining bays
    for (let i = 0; i < nb; i++) {
      const cx = margin + (i + 0.5) * bay;
      if (cx + w.w / 2 > a - 0.3 && cx - w.w / 2 < a + lw + 0.3) continue;
      ops.push({ s0: cx - w.w / 2, s1: cx + w.w / 2, y0: fl.y0 + 0.9, y1: Math.min(fl.y1 - 0.4, fl.y0 + 0.9 + Math.max(w.h, 2.0)), t: 'win', r: w.reveal, muntin: w.muntin, kind: 1, reflect: w.reflect, roomW: 6, floorY: fl.y0, floorH: fh, seed: nextSeed() });
    }
    canopyOver(c, f, a - 0.5, a + lw + 0.5, fl.y1 - 0.45, 2.0);
    return true;
  }
  if (st.ground === 'loading' && e.street) {
    const dw = st.kit === 'metal-shed' ? 4.0 : 3.2;
    const n = Math.max(1, Math.min(4, Math.floor((L - 2) / (dw + 3))));
    const sp = L / n;
    for (let i = 0; i < n; i++) {
      const cx = (i + 0.5) * sp;
      ops.push({ s0: cx - dw / 2, s1: cx + dw / 2, y0: fl.y0, y1: fl.y0 + Math.min(fh - 0.5, 4.2), t: 'loading', r: 0.15, muntin: 0, kind: 3, reflect: 0, roomW: 8, floorY: fl.y0, floorH: fh, seed: nextSeed() });
      // man door beside
      if (sp > dw + 2.2) ops.push({ s0: cx + dw / 2 + 0.6, s1: cx + dw / 2 + 1.5, y0: fl.y0, y1: fl.y0 + 2.1, t: 'door', r: 0.08, muntin: 0, kind: 3, reflect: 0, roomW: 4, floorY: fl.y0, floorH: fh, seed: nextSeed(), color: col('#5a5f63') });
    }
    return true;
  }
  if (st.ground === 'parking' && e.front) {
    const ew = Math.min(7, L * 0.4);
    ops.push({ s0: (L - ew) / 2, s1: (L + ew) / 2, y0: fl.y0, y1: fl.y1 - 0.4, t: 'open', r: 0.3, muntin: 0, kind: 5, reflect: 0, roomW: 30, floorY: fl.y0, floorH: fh, seed: nextSeed() });
    return false;
  }
  if (st.ground === 'residential' && e.front) {
    // garage at one end, door, windows in remaining bays
    let gA = Infinity, gB = -Infinity;
    if (st.garage > 0 && L > 7) {
      const gw = st.garage === 1 ? 2.6 : st.garage === 2 ? 5.0 : 7.6;
      const gwc = Math.min(gw, L * 0.55);
      const left = (b.seed & 2) === 2;
      gA = left ? margin : L - margin - gwc; gB = gA + gwc;
      if (st.garage >= 3 && gwc > 7) {
        ops.push({ s0: gA, s1: gA + 4.9, y0: fl.y0 - (c.floorBase - c.base), y1: c.base + 2.2, t: 'garage', r: 0.12, muntin: 0, kind: 3, reflect: 0, roomW: 6, floorY: fl.y0, floorH: fh, seed: nextSeed() });
        ops.push({ s0: gA + 5.1, s1: gB, y0: fl.y0 - (c.floorBase - c.base), y1: c.base + 2.2, t: 'garage', r: 0.12, muntin: 0, kind: 3, reflect: 0, roomW: 6, floorY: fl.y0, floorH: fh, seed: nextSeed() });
      } else {
        ops.push({ s0: gA, s1: gB, y0: fl.y0 - (c.floorBase - c.base), y1: c.base + 2.2, t: 'garage', r: 0.12, muntin: 0, kind: 3, reflect: 0, roomW: 6, floorY: fl.y0, floorH: fh, seed: nextSeed() });
      }
    }
    // door position: center bay for colonial/victorian, else a bay next to garage
    const free: number[] = [];
    for (let i = 0; i < nb; i++) {
      const cx = margin + (i + 0.5) * bay;
      if (cx + 0.9 > gA - 0.2 && cx - 0.9 < gB + 0.2) continue;
      free.push(i);
    }
    let di = -1;
    if (free.length) {
      if (st.kit === 'colonial' || st.kit === 'civic' || st.kit === 'brownstone') di = free[Math.floor(free.length / 2)];
      else if (gB > 0 && gA < Infinity) di = free.reduce((best, i) => Math.abs(margin + (i + 0.5) * bay - (gA + gB) / 2) < Math.abs(margin + (best + 0.5) * bay - (gA + gB) / 2) ? i : best, free[0]);
      else di = free[Math.floor(free.length / 2)];
    }
    const dH = Math.min(fh - 0.35, 2.2);
    for (const i of free) {
      const cx = margin + (i + 0.5) * bay;
      if (i === di) {
        const dw = st.kit === 'brownstone' ? 1.2 : 0.95;
        c.doorS = cx;
        ops.push({ s0: cx - dw / 2, s1: cx + dw / 2, y0: fl.y0, y1: fl.y0 + dH, t: 'door', r: 0.12, muntin: 0, kind: 0, reflect: 0, roomW: 4, floorY: fl.y0, floorH: fh, seed: nextSeed() });
        continue;
      }
      const groupW = w.group * w.w + (w.group - 1) * 0.2;
      const sd = nextSeed();
      // occasional picture window (ranch)
      const pic = st.kit === 'ranch' && (sd & 7) === 0 && bay > 2.6;
      const ww = pic ? Math.min(bay - 0.6, 2.4) : groupW;
      const ng = pic ? 1 : w.group;
      const one = pic ? ww : w.w;
      for (let g = 0; g < ng; g++) {
        const x0 = cx - ww / 2 + g * (one + 0.2);
        const y0 = fl.y0 + (pic ? 0.6 : w.sill), y1 = Math.min(fl.y1 - 0.3, y0 + (pic ? 1.6 : w.h));
        ops.push({ s0: x0, s1: x0 + one, y0, y1, t: 'win', r: w.reveal, muntin: pic ? 0 : w.muntin, kind: 0, reflect: 0, roomW: 3.5 + (sd % 100) / 50, floorY: fl.y0, floorH: fh, seed: sd + g });
      }
    }
    return true;
  }
  return false;
}

/** Sign board, awning, and night-lit sign for one storefront bay. */
function storefrontSign(c: BCtx, f: Frame, a: number, z: number, top: number, floorTop: number, i: number, sd: number) {
  const { B, st, b } = c;
  const w = z - a;
  const bandH = floorTop - top - 0.3;
  if (bandH > 0.35 && w > 1.5) {
    const sh = Math.min(bandH - 0.1, 0.75), sw = Math.min(w - 0.5, sh * (512 / 96) * 1.15);
    const sx = (a + z) / 2 - sw / 2, sy = top + 0.12 + (bandH - sh) / 2;
    const text = signWord(b, () => ((sd >>> 3) % 1000) / 1000 + (i * 0.37) % 1);
    const [u0, v0, u1, v1] = signSlot(text, (st.signStyle + i) % 8);
    const d = 0.1;
    surf(B, 2, 'paint', DARK).box(f, sx - 0.03, sx + sw + 0.03, sy - 0.03, sy + sh + 0.03, 0, d, 4 | 8 | 16 | 32, [0.8, 1]);
    const mb = B.sign;
    mb.setTint([1, 1, 1]);
    mb.quad(f.pt(sx, sy, d), f.pt(sx + sw, sy, d), f.pt(sx + sw, sy + sh, d), f.pt(sx, sy + sh, d), [u0, v0, u1, v0, u1, v1, u0, v1]);
    // gooseneck lamps
    const lm = surf(B, 0, 'metal', DARK);
    // at the board's ends: heads at 20%/80% hung 0.36 m in front of the lettering and, seen from above,
    // hid the top of one letter ("CLOTH.NG")
    for (const lx of [sx + 0.08, sx + sw - 0.08]) {
      lm.box(f, lx - 0.02, lx + 0.02, sy + sh + 0.05, sy + sh + 0.1, 0, 0.35, 63);
      lm.box(f, lx - 0.07, lx + 0.07, sy + sh - 0.02, sy + sh + 0.08, 0.3, 0.42, 63);
      downLens(c, f, lx, sy + sh - 0.025, 0.36, 0.05);
    }
  }
}

/** Sign board (unless shared), awning for one storefront bay. */
function storefrontDress(c: BCtx, f: Frame, a: number, z: number, y0: number, top: number, floorTop: number, i: number, sd: number, sharedSign = false) {
  const { st, b } = c;
  const w = z - a;
  if (!sharedSign) storefrontSign(c, f, a, z, top, floorTop, i, sd);
  // awning: valance must clear the sidewalk by ≥ 2.2 m (low ground floors / sloped or raised sidewalks)
  const gy = Math.max(y0, c.groundY, sidewalkY(f, (a + z) / 2) ?? -Infinity);
  const val = 0.25;
  let yT = top - 0.05, drop = 0.75;
  if (yT - drop - val < gy + 2.3) {
    drop = yT - val - gy - 2.3;
    if (drop < 0.35) { drop = 0.35; yT = Math.min(floorTop - 0.05, gy + 2.3 + val + drop); }
  }
  if (st.awnings && w > 1.5 && yT - drop - val >= gy + 2.1) {
    const ac = st.awningColors[0];
    void i;
    const striped = st.awningStriped;
    const proj = 1.3;
    const fb = c.B;
    const n = striped ? Math.max(2, Math.round(w / 0.3)) : 1;
    const sw = (w - 0.3) / n;
    for (let k = 0; k < n; k++) {
      const cc = striped && k % 2 ? st.awningColors[1] ?? WHITE : ac;
      const mb = surf(fb, 2, 'fabric', cc);
      const s0 = a + 0.15 + k * sw, s1 = s0 + sw;
      // slope (front and back faces)
      const p0 = f.pt(s0, yT, 0.02), p1 = f.pt(s1, yT, 0.02), p2 = f.pt(s1, yT - drop, proj), p3 = f.pt(s0, yT - drop, proj);
      mb.quad(p3, p2, p1, p0, [s0, 0, s1, 0, s1, 1.4, s0, 1.4], [0.95, 0.95, 1, 1]);
      mb.quad(p0, p1, p2, p3, [s0, 0, s1, 0, s1, 1.4, s0, 1.4], 0.55);
      // valance
      const q0 = f.pt(s0, yT - drop - val, proj), q1 = f.pt(s1, yT - drop - val, proj);
      mb.quad(q0, q1, p2, p3, [s0, 0, s1, 0, s1, val, s0, val], 0.9);
      mb.quad(q1, q0, p3, p2, [s0, 0, s1, 0, s1, val, s0, val], 0.5);
    }
    // side panels
    const mb = surf(fb, 2, 'fabric', ac);
    for (const [s, sgn] of [[a + 0.15, -1], [z - 0.15, 1]] as [number, number][]) {
      const t0 = f.pt(s, yT, 0.02), t1 = f.pt(s, yT - drop, proj), t2 = f.pt(s, yT - drop - val, proj);
      const pts: V3[] = sgn > 0 ? [t0, t2, t1] : [t0, t1, t2];
      const nrm: V3 = [f.tx * sgn, 0, f.tz * sgn];
      mb.polygon(pts, nrm, (p) => [p[0] + p[2], p[1]]);
      mb.polygon(pts.slice().reverse(), [-nrm[0], 0, -nrm[2]], (p) => [p[0] + p[2], p[1]], () => 0.6);
    }
  }
}

function canopyOver(c: BCtx, f: Frame, s0: number, s1: number, y: number, depth: number) {
  const m = surf(c.B, 2, 'metal-panel', c.st.sash);
  m.box(f, s0, s1, y, y + 0.35, 0, depth, 63, [0.7, 1]);
}

function cornice(c: BCtx, e: EdgeInfo) {
  const { B, st } = c;
  const f = e.f, L = e.L;
  const T = c.top;
  const H = st.corniceH;
  const stoneLike = st.wallTex.startsWith('brick') || st.wallTex === 'stone' || st.wallTex === 'sandstone';
  const trimId = stoneLike && st.cornice !== 'bracketed' ? 'trim-stone' : 'paint';
  const trimCol = trimId === 'trim-stone' ? st.stone : st.trim;
  const ext = 0.25;
  switch (st.cornice) {
    case 'simple': {
      const m = surf(B, 2, trimId, trimCol);
      m.box(f, -0.1, L + 0.1, T - 0.3, T - 0.05, 0, 0.18, 63, [0.7, 1]);
      m.box(f, -0.05, L + 0.05, T - 0.45, T - 0.3, 0, 0.08, 1 | 4 | 8 | 32, [0.7, 0.9]);
      break;
    }
    case 'modern': {
      surf(B, 2, 'metal', col('#8d9093')).box(f, -0.04, L + 0.04, T - 0.3, T + 0.02, 0, 0.1, 63, [0.85, 1]);
      break;
    }
    case 'corbel': {
      const m = surf(B, 2, st.wallTex, st.wallColor.clone().multiplyScalar(0.95));
      m.box(f, -0.06, L + 0.06, T - H, T - H + 0.15, 0, 0.06, 1 | 4 | 8 | 16 | 32, [0.7, 1]);
      m.box(f, -0.12, L + 0.12, T - H + 0.15, T - H + 0.3, 0, 0.12, 1 | 4 | 8 | 16 | 32, [0.7, 1]);
      m.box(f, -0.18, L + 0.18, T - 0.3, T - 0.1, 0, 0.2, 1 | 4 | 8 | 32, [0.7, 1]);
      const d0 = surf(B, 0, st.wallTex, st.wallColor.clone().multiplyScalar(0.9));
      for (let s = 0.2; s < L - 0.1; s += 0.34) d0.box(f, s, s + 0.17, T - H + 0.3, T - H + 0.48, 0, 0.1, 1 | 4 | 8 | 32, [0.7, 0.9]);
      surf(B, 2, 'trim-stone', st.stone).box(f, -0.2, L + 0.2, T - 0.1, T + 0.04, -0.3, 0.24, 63, [0.85, 1]);
      break;
    }
    case 'bracketed': {
      const m = surf(B, 2, 'paint', st.trim);
      m.box(f, 0, L, T - H, T - 0.35, 0, 0.05, 1 | 32, [0.8, 0.95]); // frieze
      m.box(f, -ext, L + ext, T - 0.35, T - 0.05, 0, 0.5, 63, [0.65, 1]); // crown
      m.box(f, -ext - 0.05, L + ext + 0.05, T - 0.05, T + 0.05, 0, 0.56, 63, [0.9, 1]);
      const d0 = surf(B, 0, 'paint', st.trim);
      const n = Math.max(2, Math.round(L / 0.9));
      for (let i = 0; i <= n; i++) {
        const s = Math.min(L - 0.1, Math.max(0.1, (i / n) * L));
        d0.box(f, s - 0.07, s + 0.07, T - H + 0.05, T - 0.35, 0, 0.42, 1 | 4 | 8 | 32, [0.6, 0.9]);
        d0.box(f, s - 0.07, s + 0.07, T - H - 0.12, T - H + 0.05, 0, 0.18, 1 | 4 | 8 | 32, [0.6, 0.9]);
      }
      // panels in frieze
      for (let i = 0; i < n; i++) {
        const s = ((i + 0.5) / n) * L;
        d0.box(f, s - L / n * 0.3, s + L / n * 0.3, T - H + 0.12, T - 0.45, 0.05, 0.07, 1 | 16 | 32 | 4 | 8, [0.8, 0.9]);
      }
      break;
    }
    case 'classical': {
      const m = surf(B, 2, trimId, trimCol);
      m.box(f, -0.05, L + 0.05, T - H, T - H + 0.25, 0, 0.06, 1 | 4 | 8 | 32 | 16, [0.8, 1]); // architrave
      m.box(f, -ext, L + ext, T - 0.4, T - 0.05, 0, 0.45, 63, [0.65, 1]); // corona
      m.box(f, -ext - 0.05, L + ext + 0.05, T - 0.05, T + 0.06, 0, 0.5, 63, [0.9, 1]);
      const d0 = surf(B, 0, trimId, trimCol);
      for (let s = 0.1; s < L - 0.1; s += 0.26) d0.box(f, s, s + 0.13, T - 0.58, T - 0.4, 0, 0.14, 1 | 4 | 8 | 32, [0.65, 0.9]);
      break;
    }
    case 'deco': {
      const m = surf(B, 2, st.wallTex, st.wallColor.clone().multiplyScalar(1.05));
      m.box(f, 0, L, T - 0.5, T, 0, 0.06, 1 | 4 | 8 | 16 | 32, [0.8, 1]);
      if (e.street && L > 10) {
        const w = L / 3;
        m.box(f, L / 2 - w / 2, L / 2 + w / 2, T, T + 2.2, -0.3, 0.06, 1 | 2 | 4 | 8 | 16, [0.8, 1]);
        m.box(f, L / 2 - w / 4, L / 2 + w / 4, T + 2.2, T + 3.4, -0.3, 0.06, 1 | 2 | 4 | 8 | 16, [0.8, 1]);
        const fin = surf(B, 2, st.wallTex, st.wallColor.clone().multiplyScalar(0.95));
        for (let k = 0; k <= 4; k++) { const s = L / 2 - w / 2 + (k * w) / 4; fin.box(f, s - 0.15, s + 0.15, c.floors[0]?.y1 ?? T - 8, T + 2.2, 0, 0.2, 1 | 4 | 8 | 16, [0.8, 1]); }
      }
      break;
    }
  }
}

function balcony(c: BCtx, f: Frame, s0: number, s1: number, y: number) {
  const { B } = c;
  const d = 1.4;
  surf(B, 2, 'concrete-plain', col('#bdb9b0')).box(f, s0, s1, y - 0.22, y, 0, d, 1 | 4 | 8 | 16 | 32, [0.6, 1]);
  const m = surf(B, 0, 'metal', c.st.sash);
  const hr = y + 1.05;
  m.box(f, s0, s1, hr - 0.04, hr, d - 0.05, d, 63);
  m.box(f, s0, s0 + 0.04, y, hr, 0.05, d, 63);
  m.box(f, s1 - 0.04, s1, y, hr, 0.05, d, 63);
  m.box(f, s0, s1, y + 0.06, y + 0.1, d - 0.05, d, 1 | 16);
  for (let s = s0 + 0.12; s < s1 - 0.08; s += 0.12) m.box(f, s, s + 0.018, y, hr, d - 0.035, d - 0.017, 1 | 4 | 8);
  // far LOD: a simple translucent-looking railing panel
  surf(B, 1, 'metal', c.st.sash.clone().multiplyScalar(0.6)).box(f, s0, s1, y, hr, d - 0.03, d, 1 | 4 | 8 | 16);
}

function fireEscape(c: BCtx, f: Frame, L: number) {
  const { B } = c;
  const m = surf(B, 0, 'metal', col('#1c1c1c'));
  const w = Math.min(4.2, L * 0.45);
  const s0 = L / 2 - w / 2, s1 = L / 2 + w / 2, d = 1.25;
  const fls = c.floors.filter((x) => x.k > 0);
  // far version (lod1): platforms, top rail + posts and a slanted stair slab per floor (~60 tris
  // instead of ~2k), so fire escapes don't vanish when a dense block drops its near detail
  const m1 = surf(B, 1, 'metal', col('#1c1c1c'));
  fls.forEach((fl, idx) => {
    const y = fl.y0, hr = y + 1.0;
    m1.box(f, s0, s1, y - 0.05, y, 0, d, 1 | 4 | 8 | 16 | 32);
    m1.box(f, s0, s1, hr - 0.05, hr, d - 0.05, d, 1 | 16 | 32);
    m1.box(f, s0, s0 + 0.05, y, hr, d - 0.05, d, 1 | 8);
    m1.box(f, s1 - 0.05, s1, y, hr, d - 0.05, d, 1 | 4);
    const nx = fls[idx + 1];
    if (nx) {
      const xa = s1 - 0.2, xb = s0 + 0.6, dd0 = d - 0.75, dd1 = d - 0.1;
      const p0 = f.pt(xa, y, dd1), p1 = f.pt(xb, nx.y0, dd1), p2 = f.pt(xb, nx.y0, dd0), p3 = f.pt(xa, y, dd0);
      m1.quad(p0, p1, p2, p3, [0, 0, 1, 0, 1, 1, 0, 1], 0.8);
      m1.quad(p3, p2, p1, p0, [0, 0, 1, 0, 1, 1, 0, 1], 0.6);
    }
  });
  fls.forEach((fl, idx) => {
    const y = fl.y0;
    m.box(f, s0, s1, y - 0.05, y, 0, d, 63);
    const hr = y + 1.0;
    m.box(f, s0, s1, hr - 0.04, hr, d - 0.04, d, 63);
    m.box(f, s0, s0 + 0.04, hr - 0.04, hr, 0, d, 63);
    m.box(f, s1 - 0.04, s1, hr - 0.04, hr, 0, d, 63);
    for (let s = s0; s <= s1; s += 0.15) m.box(f, s, s + 0.015, y, hr, d - 0.03, d - 0.015, 1 | 4 | 8);
    m.box(f, s0, s0 + 0.04, y, hr, d - 0.04, d, 63);
    m.box(f, s1 - 0.04, s1, y, hr, d - 0.04, d, 63);
    // stair to the platform above (diagonal stringers + treads)
    const nx = fls[idx + 1];
    if (nx) {
      const ya = y, yb = nx.y0, xa = s1 - 0.2, xb = s0 + 0.6;
      const steps = Math.max(6, Math.round((yb - ya) / 0.22));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const x = xa + (xb - xa) * t, yy = ya + (yb - ya) * t;
        m.box(f, x - 0.12, x + 0.12, yy - 0.02, yy, d - 0.75, d - 0.1, 1 | 16 | 32);
      }
      // stringer as a thin slanted quad (both sides)
      for (const dd of [d - 0.1, d - 0.75]) {
        const p0 = f.pt(xa, ya, dd), p1 = f.pt(xb, yb, dd), p2 = f.pt(xb, yb + 0.18, dd), p3 = f.pt(xa, ya + 0.18, dd);
        m.quad(p1, p0, p3, p2, [0, 0, 1, 0, 1, 1, 0, 1]);
        m.quad(p0, p1, p2, p3, [0, 0, 1, 0, 1, 1, 0, 1]);
      }
    }
  });
  // drop ladder
  if (fls.length) {
    const y = fls[0].y0;
    m.box(f, s0 + 0.3, s0 + 0.34, y - 2.2, y, d - 0.3, d - 0.26, 63);
    m.box(f, s0 + 0.7, s0 + 0.74, y - 2.2, y, d - 0.3, d - 0.26, 63);
    for (let yy = y - 2.1; yy < y; yy += 0.3) m.box(f, s0 + 0.3, s0 + 0.74, yy, yy + 0.03, d - 0.3, d - 0.26, 1 | 16);
  }
}

export { plainWall, wallGrid };
