// Retaining walls where a street's grade departs from the ground beside it by more than ~1.5 m.
// Road flattening alone blends the terrain back to its natural level over ~5 m, which reads as a long smeared
// grass slope (and, on real terraced grades like Savannah's bluff or Seattle's hills, looks nothing like the city).
// Here the blend is undone beyond a wall line at the sidewalk's outer edge, the heightfield rows either side of the
// line are snapped onto it (a true vertical step in the terrain mesh), and a concrete wall with a cap / parapet is
// built on the line: cut side (ground above the street) → retaining face toward the street; fill side (street on an
// embankment) → a wall down to the low ground with a parapet at the sidewalk.
import type { Vec2 } from '../core/types';
import type { Heightfield } from './terrain';
import { CURB_H, type Chain, type RoadNetwork } from './roads';
import type { ChunkBatcher } from './util';

const MIN_STEP = 1.5;
const SAMPLE = 1.5;

export interface WallBox { ax: number; az: number; bx: number; bz: number; y0: number; y1: number; t: number }

interface WP { x: number; z: number; nx: number; nz: number; yRoad: number; yGround: number; yHi: number; yLo: number; diff: number; ok: boolean }

/**
 * @param h0 heights before road flattening
 * @param flat per-vertex flatten weight / owner from RoadNetwork.flattenTerrain
 */
export function buildRetainingWalls(
  roads: RoadNetwork, hf: Heightfield, h0: Float32Array, flat: { best: Float32Array; owner: Int32Array },
  inBuilding: (x: number, z: number) => boolean, B: ChunkBatcher,
): { walls: number; length: number; boxes: WallBox[] } {
  const raw = (x: number, z: number) => {
    let fx = (x - hf.ox) / hf.cell, fz = (z - hf.oz) / hf.cell;
    fx = Math.max(0, Math.min(hf.cols - 1.0001, fx)); fz = Math.max(0, Math.min(hf.rows - 1.0001, fz));
    const c = Math.floor(fx), r = Math.floor(fz), u = fx - c, v = fz - r, C = hf.cols;
    return h0[r * C + c] * (1 - u) * (1 - v) + h0[r * C + c + 1] * u * (1 - v) + h0[(r + 1) * C + c] * (1 - u) * v + h0[(r + 1) * C + c + 1] * u * v;
  };
  const ownerAt = (x: number, z: number) => {
    const c = Math.round((x - hf.ox) / hf.cell), r = Math.round((z - hf.oz) / hf.cell);
    if (c < 0 || r < 0 || c >= hf.cols || r >= hf.rows) return -3;
    return flat.best[r * hf.cols + c] > 0.999 ? flat.owner[r * hf.cols + c] : -1;
  };
  const boxes: WallBox[] = [];
  let walls = 0, length = 0;
  for (const c of roads.chains) {
    if (c.bridge || c.tunnel || c.internal || c.len < 8) continue;
    for (const sg of [-1, 1] as const) {
      const side = sg > 0 ? 1 : 0;
      const cs = sg > 0 ? (c.sR ?? c.s) : (c.sL ?? c.s);
      const oW = c.w + cs + 0.25;
      const a = Math.max(c.trim[0], cs > 0 ? c.sw[0][side] : 0) + 0.5;
      const b = c.len - Math.max(c.trim[1], cs > 0 ? c.sw[1][side] : 0) - 0.5;
      if (b - a < 6) continue;
      const n = Math.max(2, Math.round((b - a) / SAMPLE) + 1);
      const P: WP[] = [];
      for (let i = 0; i < n; i++) {
        const s = a + ((b - a) * i) / (n - 1);
        const q = roads.chainPoint(c, s);
        const nx = -q.dz * sg, nz = q.dx * sg;
        const x = q.x + nx * oW, z = q.z + nz * oW;
        const yRoad = q.y + (cs > 0 ? CURB_H : 0);
        const g1 = raw(x + nx * 2, z + nz * 2), g2 = raw(x + nx * 4.5, z + nz * 4.5);
        const yGround = (g1 + g2) / 2;
        // not where the ground beyond is another street, a junction, or a building (its facade is the wall there)
        let ok = !inBuilding(x + nx * 1.5, z + nz * 1.5) && !inBuilding(x + nx * 4, z + nz * 4);
        for (const d of [1, 3, 5]) { const o = ownerAt(x + nx * d, z + nz * d); if (o !== -1 && o !== c.idx) ok = false; }
        if (ok) { const h = roads.nearestChain([x + nx * 3, z + nz * 3], 25); if (h && h.c !== c && h.d < h.c.w + h.c.s + 1.5) ok = false; }
        const n0 = raw(x + nx * 0.3, z + nz * 0.3), n1 = raw(x + nx * 1.5, z + nz * 1.5), n2 = raw(x + nx * 3, z + nz * 3);
        P.push({ x, z, nx, nz, yRoad, yGround, yHi: Math.max(n0, n1, n2), yLo: Math.min(n0, n1, n2), diff: yGround - yRoad, ok });
      }
      // runs of consistent sign exceeding the step threshold (short gaps bridged), tapered out while |diff| > 0.6
      const flag = P.map((p) => (p.ok && Math.abs(p.diff) > MIN_STEP ? Math.sign(p.diff) : 0));
      for (let i = 1; i + 2 < flag.length; i++) if (!flag[i] && flag[i - 1] && (flag[i + 1] === flag[i - 1] || flag[i + 2] === flag[i - 1]) && P[i].ok && Math.sign(P[i].diff) === flag[i - 1]) flag[i] = flag[i - 1];
      let i = 0;
      while (i < flag.length) {
        if (!flag[i]) { i++; continue; }
        const sgn = flag[i];
        let j = i; while (j + 1 < flag.length && flag[j + 1] === sgn) j++;
        if (j - i + 1 >= 4) {
          let i0 = i, j0 = j;
          for (let k = 0; k < 4 && i0 > 0 && P[i0 - 1].ok && P[i0 - 1].diff * sgn > 0.6; k++) i0--;
          for (let k = 0; k < 4 && j0 + 1 < P.length && P[j0 + 1].ok && P[j0 + 1].diff * sgn > 0.6; k++) j0++;
          const run = P.slice(i0, j0 + 1);
          carve(hf, h0, flat, c, run);
          emitWall(B, run, sgn > 0, boxes);
          walls++;
          for (let k = 1; k < run.length; k++) length += Math.hypot(run[k].x - run[k - 1].x, run[k].z - run[k - 1].z);
        }
        i = j + 1;
      }
    }
  }
  return { walls, length, boxes };
}

/** Undo the flatten blend beyond the wall line and snap the grid rows either side of it onto the line. */
function carve(hf: Heightfield, h0: Float32Array, flat: { best: Float32Array; owner: Int32Array }, c: Chain, run: WP[]) {
  const off = hf.ensureOffsets(), cliff = hf.cliff!;
  const reach = 6.5, snapD = hf.cell * 1.45;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of run) { x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z); }
  const c0 = Math.max(0, Math.floor((x0 - reach - hf.ox) / hf.cell)), c1 = Math.min(hf.cols - 1, Math.ceil((x1 + reach - hf.ox) / hf.cell));
  const r0 = Math.max(0, Math.floor((z0 - reach - hf.oz) / hf.cell)), r1 = Math.min(hf.rows - 1, Math.ceil((z1 + reach - hf.oz) / hf.cell));
  const snapped: number[] = [];
  for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
    const x = hf.ox + cc * hf.cell, z = hf.oz + r * hf.cell;
    // nearest point on the wall line
    let bd = Infinity, bt = 0, bi = 0, bOut = 0;
    for (let i = 0; i + 1 < run.length; i++) {
      const A = run[i], Bp = run[i + 1];
      const dx = Bp.x - A.x, dz = Bp.z - A.z, l2 = dx * dx + dz * dz || 1;
      const tr = ((x - A.x) * dx + (z - A.z) * dz) / l2, t = Math.max(0, Math.min(1, tr));
      const qx = A.x + dx * t, qz = A.z + dz * t, d = Math.hypot(x - qx, z - qz);
      if (d < bd) { bd = d; bt = t; bi = i; bOut = tr < -0.02 && i === 0 ? -1 : tr > 1.02 && i === run.length - 2 ? 1 : 0; }
    }
    if (bOut) continue; // beyond the run's ends
    const A = run[bi], Bp = run[bi + 1];
    const nx = A.nx + (Bp.nx - A.nx) * bt, nz = A.nz + (Bp.nz - A.nz) * bt;
    const nl = Math.hypot(nx, nz) || 1;
    const lx = A.x + (Bp.x - A.x) * bt, lz = A.z + (Bp.z - A.z) * bt;
    const d = ((x - lx) * nx + (z - lz) * nz) / nl; // + = away from the street
    if (d > reach || d < -snapD) continue;
    const k = r * hf.cols + cc;
    const own = flat.best[k] > 0.999 ? flat.owner[k] : -1;
    if (d > 0) {
      if (own !== -1 && own !== c.idx) continue;
      hf.h[k] = h0[k];
    }
    if (Math.abs(d) < snapD) {
      off[k * 2] = -(d * nx) / nl; off[k * 2 + 1] = -(d * nz) / nl;
      snapped.push(k);
    }
  }
  for (const k of snapped) {
    const r = Math.floor(k / hf.cols), cc = k % hf.cols;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, c2 = cc + dc;
      if (rr >= 0 && c2 >= 0 && rr < hf.rows && c2 < hf.cols) cliff[rr * hf.cols + c2] = 1;
    }
  }
}

function emitWall(B: ChunkBatcher, run: WP[], cut: boolean, boxes: WallBox[]) {
  // thickness sits on the far side of the line (fill) / straddles it (cut); the street-side face is at the line
  // for cuts, and at the sidewalk edge for fill parapets
  const inner = cut ? -0.03 : -0.27, outer = cut ? 0.35 : 0.03;
  const PAR = 0.85, CAP = 0.25;
  const top = (p: WP) => (cut ? Math.max(p.yHi, p.yRoad) + CAP : Math.max(p.yRoad + PAR, p.yHi + 0.3));
  const lowIn = (p: WP) => (cut ? p.yRoad - 0.4 : p.yRoad - 0.1);
  const lowOut = (p: WP) => (cut ? p.yLo - 0.6 : Math.min(p.yLo, p.yRoad) - 0.5);
  const mid = run[run.length >> 1];
  const mb = B.get('retainWall', mid.x, mid.z);
  let u = 0;
  for (let i = 0; i + 1 < run.length; i++) {
    const A = run[i], Bp = run[i + 1];
    const L = Math.hypot(Bp.x - A.x, Bp.z - A.z);
    if (L < 1e-3) continue;
    const at = (p: WP, o: number): [number, number] => [p.x + p.nx * o, p.z + p.nz * o];
    const face = (o: number, yA0: number, yA1: number, yB0: number, yB1: number, sgn: number) => {
      const nx = ((A.nx + Bp.nx) / 2) * sgn, nz = ((A.nz + Bp.nz) / 2) * sgn;
      const [ax, az] = at(A, o), [bx, bz] = at(Bp, o);
      const i0 = mb.v(ax, yA0, az, nx, 0, nz, u, yA0), i1 = mb.v(bx, yB0, bz, nx, 0, nz, u + L, yB0);
      const i2 = mb.v(bx, yB1, bz, nx, 0, nz, u + L, yB1), i3 = mb.v(ax, yA1, az, nx, 0, nz, u, yA1);
      mb.triN(i0, i1, i2, nx, 0, nz); mb.triN(i0, i2, i3, nx, 0, nz);
    };
    // street-side face (faces the street: -n), far face (+n), cap
    face(inner, lowIn(A), top(A), lowIn(Bp), top(Bp), -1);
    face(outer, lowOut(A), top(A), lowOut(Bp), top(Bp), 1);
    {
      const [ax0, az0] = at(A, inner), [bx0, bz0] = at(Bp, inner), [ax1, az1] = at(A, outer), [bx1, bz1] = at(Bp, outer);
      const i0 = mb.v(ax0, top(A), az0, 0, 1, 0, u, 0), i1 = mb.v(bx0, top(Bp), bz0, 0, 1, 0, u + L, 0);
      const i2 = mb.v(bx1, top(Bp), bz1, 0, 1, 0, u + L, outer - inner), i3 = mb.v(ax1, top(A), az1, 0, 1, 0, u, outer - inner);
      mb.triN(i0, i1, i2, 0, 1, 0); mb.triN(i0, i2, i3, 0, 1, 0);
    }
    u += L;
  }
  // colliders: one box per ~6 m of wall (the line is near-straight at that scale)
  for (let i = 0; i + 1 < run.length; i += 4) {
    const j = Math.min(run.length - 1, i + 4);
    const A = run[i], Bp = run[j];
    let y0 = Infinity, y1 = -Infinity;
    for (let k = i; k <= j; k++) { y0 = Math.min(y0, lowIn(run[k]), lowOut(run[k])); y1 = Math.max(y1, top(run[k])); }
    const m = (inner + outer) / 2;
    boxes.push({ ax: A.x + A.nx * m, az: A.z + A.nz * m, bx: Bp.x + Bp.nx * m, bz: Bp.z + Bp.nz * m, y0, y1, t: outer - inner });
  }
  // end caps
  for (const [p, sgn] of [[run[0], -1], [run[run.length - 1], 1]] as [WP, number][]) {
    const tx = -p.nz * sgn, tz = p.nx * sgn; // along the line, pointing out of the run
    const nb = run.length > 1 ? run[sgn < 0 ? 1 : run.length - 2] : p;
    const dir = Math.sign((p.x - nb.x) * tx + (p.z - nb.z) * tz) || 1;
    const fx = tx * dir, fz = tz * dir;
    const pa: Vec2 = [p.x + p.nx * inner, p.z + p.nz * inner], pb: Vec2 = [p.x + p.nx * outer, p.z + p.nz * outer];
    const lo = Math.min(lowIn(p), lowOut(p)), hi = top(p);
    const i0 = mb.v(pa[0], lo, pa[1], fx, 0, fz, 0, lo), i1 = mb.v(pb[0], lo, pb[1], fx, 0, fz, outer - inner, lo);
    const i2 = mb.v(pb[0], hi, pb[1], fx, 0, fz, outer - inner, hi), i3 = mb.v(pa[0], hi, pa[1], fx, 0, fz, 0, hi);
    mb.triN(i0, i1, i2, fx, 0, fz); mb.triN(i0, i2, i3, fx, 0, fz);
  }
}
