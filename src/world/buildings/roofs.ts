// Roof generator. Every pitched roof is the LOWER ENVELOPE of a set of planes (one or two per eave
// edge + a horizontal cap). On a convex base polygon this is exactly the hip / gable / gambrel /
// mansard / shed / pyramid roof (it is the straight skeleton for convex polygons). Complex footprints
// use the oriented bounding rectangle (or hull) as the base and clip the faces to the footprint; the
// resulting vertical gaps are closed by infill walls (gable ends, notches), computed the same way.
import * as THREE from 'three';
import type { RecipeBuilding, Vec2 } from '../../core/types';
import type { Style } from './kits';
import { Frame, type V3 } from './builder';
import { surf, type Buckets, type BCtx } from './facade';
import {
  signedArea, outwardNormal, isConvex, minAreaRect, obbCorners, convexHull, offsetRing, clipHalfPlane, clipByConvex,
  ringArea, interiorPoints, centroid, pointInRing, distToRing, type OBB,
} from './poly';

interface Plane { ax: number; az: number; c: number }
const hAt = (p: Plane, x: number, z: number) => p.ax * x + p.az * z + p.c;

function edgePlane(a: Vec2, b: Vec2, eave: number, slope: number, h0 = 0, d0 = 0): Plane {
  const n = outwardNormal(a, b);
  // inward distance d = -(n·(p-a)); h = eave + h0 + slope*(d - d0)
  return { ax: -slope * n[0], az: -slope * n[1], c: eave + h0 - slope * d0 + slope * (n[0] * a[0] + n[1] * a[1]) };
}

export interface RoofInfo {
  /** Max roof height (for chimneys etc.). */
  ridgeY: number;
  obb: OBB;
  /** Height function of the roof surface (pitched only). */
  heightAt?: (x: number, z: number) => number;
}

const C = (h: string) => new THREE.Color(h);

export function roofLayerId(b: RecipeBuilding): string {
  return 'roof-' + (b.roof.material || 'asphalt-shingle');
}

/** Build the roof for a building. ring is canonical-oriented (signedArea < 0). */
export function buildRoof(c: BCtx, ring: Vec2[], holes: Vec2[][]): RoofInfo {
  const { b, st, B } = c;
  const obb = minAreaRect(ring);
  let type = b.roof.type;
  if (type !== 'flat' && holes.length) type = 'flat';
  if (type !== 'flat' && ringArea(ring) < 12) type = 'flat';
  if (type === 'flat' || type === 'dome') {
    flatRoof(c, ring, holes);
    if (type === 'dome') return dome(c, ring, obb);
    return { ridgeY: c.top, obb };
  }
  return pitchedRoof(c, ring, obb, type);
}

function flatRoof(c: BCtx, ring: Vec2[], holes: Vec2[][]) {
  const { b, B } = c;
  const y = c.deckY;
  const lid = b.roof.material === 'gravel' ? 'roof-gravel' : b.roof.material === 'membrane' || b.roof.material === 'asphalt-shingle' ? 'roof-membrane' : roofLayerId(b);
  const col = C(b.roof.color || '#9a9a98');
  const mb = surf(B, 2, lid, col, 0.6);
  const pts: V3[] = ring.map((p) => [p[0], y, p[1]]);
  const hs: V3[][] = holes.map((h) => h.map((p) => [p[0], y, p[1]] as V3));
  mb.polygon(pts, [0, 1, 0], (p) => [p[0], p[2]], (p) => 0.75 + 0.25 * Math.min(1, distToRing(p[0], p[2], ring) / 1.5), hs.length ? hs : undefined);
}

function dome(c: BCtx, ring: Vec2[], obb: OBB): RoofInfo {
  const { B, b } = c;
  const [cx, cz] = centroid(ring);
  const R = Math.min(obb.hu, obb.hv) * 0.75;
  const y0 = c.deckY;
  // drum
  const drumH = R * 0.35;
  const mb = surf(B, 2, c.st.wallTex, c.st.wallColor);
  const seg = 24;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number, y: number): V3 => [cx + Math.cos(a) * R, y, cz + Math.sin(a) * R];
    mb.quad(p(a1, y0), p(a0, y0), p(a0, y0 + drumH), p(a1, y0 + drumH), [a1 * R, y0, a0 * R, y0, a0 * R, y0 + drumH, a1 * R, y0 + drumH], [0.8, 0.8, 1, 1]);
  }
  const domeCol = C(['#5f8f7a', '#7d8a8c', '#b8963e', '#6b7478'][c.b.seed % 4]);
  const rm = surf(B, 2, 'roof-standing-seam', domeCol, 1);
  const rings = 12, segD = 32;
  const yb = y0 + drumH;
  const H = R * 0.9;
  for (let j = 0; j < rings; j++) {
    const t0 = (j / rings) * Math.PI / 2, t1 = ((j + 1) / rings) * Math.PI / 2;
    for (let i = 0; i < segD; i++) {
      const a0 = (i / segD) * Math.PI * 2, a1 = ((i + 1) / segD) * Math.PI * 2;
      const p = (a: number, t: number): V3 => [cx + Math.cos(a) * R * Math.cos(t), yb + H * Math.sin(t), cz + Math.sin(a) * R * Math.cos(t)];
      const nrm = (a: number, t: number): V3 => { const nx = Math.cos(a) * Math.cos(t) / R, ny = Math.sin(t) / H, nz = Math.sin(a) * Math.cos(t) / R; const l = Math.hypot(nx, ny, nz); return [nx / l, ny / l, nz / l]; };
      rm.quadN([p(a1, t0), p(a0, t0), p(a0, t1), p(a1, t1)], [nrm(a1, t0), nrm(a0, t0), nrm(a0, t1), nrm(a1, t1)],
        [a1 * R, t0 * R, a0 * R, t0 * R, a0 * R, t1 * R, a1 * R, t1 * R], [0.9, 0.9, 1, 1]);
    }
  }
  // lantern
  const lm = surf(B, 2, c.st.wallTex, c.st.wallColor);
  lm.obox(cx, yb + H + 0.8, cz, R * 0.12, 0.8, R * 0.12, 0, [0.8, 1]);
  surf(B, 2, 'roof-standing-seam', domeCol, 1).obox(cx, yb + H + 1.7, cz, R * 0.15, 0.1, R * 0.15, 0, [0.8, 1]);
  return { ridgeY: yb + H + 1.8, obb };
}

function pitchedRoof(c: BCtx, ring: Vec2[], obb: OBB, type: RecipeBuilding['roof']['type']): RoofInfo {
  const { b, st, B } = c;
  const eave = c.top;
  const convex = isConvex(ring);
  const area = ringArea(ring);
  let base: Vec2[];
  let clip: Vec2[] | null = null;
  if (convex) base = ring;
  else {
    const fill = area / (4 * obb.hu * obb.hv);
    base = fill > 0.7 ? obbCorners(obb) : convexHull(ring);
  }
  if (signedArea(base) > 0) base = base.slice().reverse();
  const ov = type === 'mansard' ? 0.12 : Math.max(0.1, st.eave);
  const baseO = offsetRing(base, ov);
  if (!convex) clip = offsetRing(ring, ov);
  // ridge axis: explicit orientation or the long OBB axis
  let rx = obb.ux, rz = obb.uz;
  if (typeof b.roof.orientation === 'number' && isFinite(b.roof.orientation)) { rx = Math.cos(b.roof.orientation); rz = Math.sin(b.roof.orientation); }
  const hv = Math.max(1.5, obb.hv);
  let Hr = b.roofHeight > 0.3 ? b.roofHeight : defaultRoofH(st, hv, type);
  Hr = Math.min(Hr, hv * 1.6 + 1, 14);
  const planes: Plane[] = [];
  const n = base.length;
  // classify edges of the base polygon
  const gableEdge: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = base[i], q = base[(i + 1) % n];
    const dx = q[0] - a[0], dz = q[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    gableEdge.push(Math.abs((dx / l) * rx + (dz / l) * rz) < 0.35);
  }
  if (type === 'shed') {
    // single plane rising from the longest ridge-parallel edge (prefer the lowest = front)
    let best = -1, bestL = -1;
    for (let i = 0; i < n; i++) {
      if (gableEdge[i]) continue;
      const a = base[i], q = base[(i + 1) % n];
      const l = Math.hypot(q[0] - a[0], q[1] - a[1]);
      if (l > bestL) { bestL = l; best = i; }
    }
    if (best < 0) best = 0;
    planes.push(edgePlane(base[best], base[(best + 1) % n], eave, Hr / (2 * hv)));
  } else {
    const slope = Hr / hv;
    for (let i = 0; i < n; i++) {
      const a = base[i], q = base[(i + 1) % n];
      if ((type === 'gable' || type === 'gambrel') && gableEdge[i]) continue;
      if (type === 'gambrel') {
        const d1 = hv * 0.38, h1 = Hr * 0.66;
        planes.push(edgePlane(a, q, eave, h1 / d1));
        planes.push(edgePlane(a, q, eave, (Hr - h1) / (hv - d1), h1, d1));
      } else if (type === 'mansard') {
        const d1 = Math.min(1.6, hv * 0.35), h1 = Math.min(Hr, 3.2);
        planes.push(edgePlane(a, q, eave, h1 / d1));
        planes.push(edgePlane(a, q, eave, 0.12, h1, d1));
      } else planes.push(edgePlane(a, q, eave, slope));
    }
  }
  planes.push({ ax: 0, az: 0, c: eave + Hr }); // cap
  const env = (x: number, z: number) => { let m = Infinity; for (const p of planes) m = Math.min(m, hAt(p, x, z)); return m; };

  const lid = roofLayerId(b);
  const rcol = C(b.roof.color || '#5a5a5a');
  const rm = surf(B, 2, lid, rcol, 0.8);
  const soffitCol = st.trim;
  const outer = clip ?? baseO;
  for (let i = 0; i < planes.length; i++) {
    const P = planes[i];
    let poly: Vec2[] = baseO;
    for (let j = 0; j < planes.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const Q = planes[j];
      const a = P.ax - Q.ax, bz = P.az - Q.az, cc = Q.c - P.c;
      if (Math.abs(a) < 1e-9 && Math.abs(bz) < 1e-9) {
        if (P.c > Q.c + 1e-6 || (Math.abs(P.c - Q.c) <= 1e-6 && j < i)) { poly = []; break; }
        continue;
      }
      poly = clipHalfPlane(poly, { a, b: bz, c: cc });
    }
    if (poly.length < 3) continue;
    if (clip) {
      poly = clipByConvex(clip, poly);
      if (poly.length < 3) continue;
    }
    if (Math.abs(signedArea(poly)) < 0.01) continue;
    const g = Math.hypot(P.ax, P.az);
    const gx = g > 1e-6 ? P.ax / g : 1, gz = g > 1e-6 ? P.az / g : 0;
    const sl = Math.sqrt(1 + g * g);
    const nrm: V3 = [-P.ax, 1, -P.az];
    const nl = Math.hypot(nrm[0], nrm[1], nrm[2]);
    nrm[0] /= nl; nrm[1] /= nl; nrm[2] /= nl;
    const pts: V3[] = poly.map((p) => [p[0], hAt(P, p[0], p[1]), p[1]]);
    const uvf = (p: V3): [number, number] => g > 1e-6 ? [p[0] * -gz + p[2] * gx, (p[0] * gx + p[2] * gz) * sl] : [p[0], p[2]];
    rm.layer = (surf(B, 2, lid, rcol, 0.8)).layer;
    surf(B, 2, lid, rcol, 0.8).polygon(pts, nrm, uvf, (p) => {
      // darker toward the eave (grime) and in valleys
      const hRel = (p[1] - eave) / Math.max(0.5, Hr);
      return 0.82 + 0.18 * Math.min(1, Math.max(0, hRel + 0.2));
    });
    // soffit (underside) where the roof overhangs
    if (ov > 0.05) {
      const under: V3[] = pts.map((p) => [p[0], p[1] - 0.14, p[2]] as V3).reverse();
      surf(B, 2, 'paint', soffitCol).polygon(under, [-nrm[0], -nrm[1], -nrm[2]], (p) => [p[0], p[2]], () => 0.55);
    }
    // fascia along outer boundary edges
    const fm = surf(B, 2, 'paint', soffitCol);
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      if (distToRing(mx, mz, outer) > 1e-3 || distToRing(p[0], p[1], outer) > 1e-3 || distToRing(q[0], q[1], outer) > 1e-3) continue;
      const hp = hAt(P, p[0], p[1]), hq = hAt(P, q[0], q[1]);
      const fh = 0.2;
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      fm.quad([p[0], hp - fh, p[1]], [q[0], hq - fh, q[1]], [q[0], hq + 0.03, q[1]], [p[0], hp + 0.03, p[1]], [0, hp - fh, l, hq - fh, l, hq, 0, hp], 0.85);
    }
  }
  // ridge caps: thin boxes along plane intersections are omitted; eave gutters on horizontal fascia edges
  // infill walls above the eave along footprint edges (gable ends, notches, shed sides)
  let u0 = 0;
  const wm = () => surf(B, 2, st.kit === 'victorian' && st.wallTex === 'lap-siding' ? 'wood-shingle' : st.wallTex, st.kit === 'victorian' ? st.trim.clone().lerp(st.wallColor, 0.5) : st.wallColor);
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
    if (L < 0.05) continue;
    const f = Frame.fromEdge(a, q, u0);
    u0 += L;
    let poly: Vec2[] = [[0, eave], [L, eave], [L, eave + Hr + 1], [0, eave + Hr + 1]];
    for (const P of planes) {
      const al = hAt(P, a[0], a[1]), be = (hAt(P, q[0], q[1]) - al) / L;
      // y - be*s <= al
      poly = clipHalfPlane(poly, { a: -be, b: 1, c: al });
      if (poly.length < 3) break;
    }
    if (poly.length < 3 || Math.abs(signedArea(poly)) < 0.02) continue;
    const pts: V3[] = poly.map((p) => f.pt(p[0], p[1], 0));
    wm().polygon(pts, [f.nx, 0, f.nz], (p) => [f.u0 + ((p[0] - f.ox) * f.tx + (p[2] - f.oz) * f.tz), p[1]], () => 0.9);
    // gable vent / attic window
    let apexS = 0, apexY = -Infinity;
    for (const p of poly) if (p[1] > apexY) { apexY = p[1]; apexS = p[0]; }
    if (apexY - eave > 1.9 && apexS > 0.8 && apexS < L - 0.8) {
      const vy = eave + (apexY - eave) * 0.35;
      const vm = surf(B, 0, 'paint', st.trim);
      vm.box(f, apexS - 0.35, apexS + 0.35, vy, vy + 0.6, 0, 0.04, 1 | 4 | 8 | 16 | 32, [0.85, 1]);
      const dm = surf(B, 0, 'dark', C('#555555'));
      for (let k = 0; k < 5; k++) dm.box(f, apexS - 0.27, apexS + 0.27, vy + 0.08 + k * 0.09, vy + 0.13 + k * 0.09, 0.04, 0.05, 1 | 16, [0.6, 0.8]);
    }
  }
  return { ridgeY: eave + Hr, obb, heightAt: env };
}

function defaultRoofH(st: Style, hv: number, type: string): number {
  const pitch = type === 'mansard' ? 0.9 : type === 'gambrel' ? 1.0 : st.kit === 'victorian' ? 0.95 : st.kit === 'craftsman' || st.kit === 'ranch' ? 0.38 : st.kit === 'metal-shed' ? 0.2 : st.kit === 'worship' ? 1.0 : 0.55;
  return Math.max(0.8, hv * pitch);
}

// ---------------------------------------------------------------------------------------------
// Roof accessories
// ---------------------------------------------------------------------------------------------
export function rooftopProps(c: BCtx, ring: Vec2[], info: RoofInfo, rnd: () => number) {
  const { B, st, b } = c;
  const area = ringArea(ring);
  if (!c.flat) return;
  const y = c.deckY;
  const metal = C('#b9bcbd');
  if (st.rooftop === 'hvac' || st.rooftop === 'mech' || st.rooftop === 'tank') {
    const n = Math.min(10, Math.max(1, Math.floor(area / 180)));
    const pts = interiorPoints(ring, Math.max(4, Math.sqrt(area / n)), 2.2, rnd, n);
    for (const p of pts) {
      const yaw = info.obb.angle;
      const big = rnd() < 0.4;
      const hx = big ? 1.2 + rnd() * 0.8 : 0.6 + rnd() * 0.3, hz = big ? 0.8 + rnd() * 0.4 : 0.5 + rnd() * 0.2, hy = big ? 0.6 + rnd() * 0.3 : 0.45;
      const m = surf(B, 2, 'metal', metal.clone().multiplyScalar(0.85 + rnd() * 0.2));
      m.obox(p[0], y + hy, p[1], hx, hy, hz, yaw, [0.55, 1]);
      // curb + fan
      surf(B, 2, 'metal', C('#8a8d8f')).obox(p[0], y + 0.08, p[1], hx + 0.08, 0.08, hz + 0.08, yaw, [0.5, 0.8]);
      const dm = surf(B, 0, 'dark', C('#333333'));
      const fr = Math.min(hx, hz) * 0.7;
      const cy = y + 2 * hy + 0.01;
      const seg = 10;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const pc = [p[0], cy, p[1]] as V3;
        dm.polygon([pc, [p[0] + Math.cos(a1) * fr, cy, p[1] + Math.sin(a1) * fr], [p[0] + Math.cos(a0) * fr, cy, p[1] + Math.sin(a0) * fr]], [0, 1, 0], (q) => [q[0], q[2]], () => 0.5);
      }
    }
    // small vents / pipes
    const vp = interiorPoints(ring, 5, 1.2, rnd, Math.min(12, Math.floor(area / 60)));
    const vm = surf(B, 0, 'metal', C('#9a9c9e'));
    for (const p of vp) vm.obox(p[0], y + 0.3, p[1], 0.12, 0.3, 0.12, rnd() * 3, [0.6, 1]);
  }
  if ((st.rooftop === 'mech' || b.levels >= 7) && area > 200) {
    // stair / elevator penthouse
    const o = info.obb;
    const hx = Math.min(o.hu * 0.35, 5), hz = Math.min(o.hv * 0.4, 3.5);
    const ph = 3.4;
    const pw = surf(B, 2, st.win.pattern === 'curtain' ? 'metal-panel' : st.wallTex, st.win.pattern === 'curtain' ? st.sash : st.wallColor.clone().multiplyScalar(0.92));
    pw.obox(o.cx, y + ph / 2, o.cz, hx, ph / 2, hz, o.angle, [0.6, 1]);
    surf(B, 2, 'roof-membrane', C('#a8a8a4')).obox(o.cx, y + ph + 0.05, o.cz, hx + 0.1, 0.06, hz + 0.1, o.angle, [0.9, 1]);
  }
  if (st.rooftop === 'tank' && area > 120) {
    const o = info.obb;
    const px = o.cx + o.ux * o.hu * 0.4, pz = o.cz + o.uz * o.hu * 0.4;
    if (pointInRing(px, pz, ring)) waterTank(c, px, pz, y);
  }
  // skylights / solar
  if (b.era === '2000+' && rnd() < 0.25 && area > 150) {
    const pts = interiorPoints(ring, 3.5, 2.5, rnd, 12);
    const sm = surf(B, 2, 'glass-curtain', C('#1d2a44'));
    for (const p of pts) {
      const yaw = info.obb.angle;
      sm.obox(p[0], y + 0.35, p[1], 0.85, 0.05, 0.5, yaw, [0.9, 1]);
    }
  }
}

function waterTank(c: BCtx, x: number, z: number, y: number) {
  const { B } = c;
  const R = 1.8, H = 3.6, leg = 2.4;
  const legs = surf(B, 2, 'metal', C('#3a3a3a'));
  for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) legs.obox(x + dx * R * 0.6, y + leg / 2, z + dz * R * 0.6, 0.08, leg / 2, 0.08, 0, [0.6, 1]);
  legs.obox(x, y + leg - 0.1, z, R, 0.1, R, 0, [0.7, 1]);
  const wm = surf(B, 2, 'wood-planks', C('#7a5b40'));
  const seg = 16;
  const y0 = y + leg, y1 = y0 + H;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number, yy: number): V3 => [x + Math.cos(a) * R, yy, z + Math.sin(a) * R];
    // planks vertical: u = y, v = arc
    wm.quad(p(a1, y0), p(a0, y0), p(a0, y1), p(a1, y1), [y0, a1 * R, y0, a0 * R, y1, a0 * R, y1, a1 * R], [0.7, 0.7, 1, 1]);
    const rm = surf(B, 2, 'roof-standing-seam', C('#4a4a48'));
    const top: V3 = [x, y1 + 1.2, z];
    rm.polygon([p(a0, y1 + 0.05), top, p(a1, y1 + 0.05)].map((q) => [q[0], q[1], q[2]] as V3), normalOf(p(a0, y1), top, p(a1, y1)), (q) => [q[0], q[2]]);
    wm.layer = surf(B, 2, 'wood-planks', C('#7a5b40')).layer;
  }
  const hoop = surf(B, 0, 'metal', C('#2a2a2a'));
  for (const hy of [0.5, 1.5, 2.5, 3.3]) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p = (a: number, yy: number): V3 => [x + Math.cos(a) * (R + 0.02), yy, z + Math.sin(a) * (R + 0.02)];
      hoop.quad(p(a1, y0 + hy), p(a0, y0 + hy), p(a0, y0 + hy + 0.05), p(a1, y0 + hy + 0.05), [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  }
}

function normalOf(a: V3, b: V3, c: V3): V3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return [nx, ny, nz];
}

export function chimney(c: BCtx, ring: Vec2[], info: RoofInfo, rnd: () => number) {
  const { B } = c;
  const o = info.obb;
  const side = rnd() < 0.5 ? -1 : 1;
  const along = o.hu * (0.55 + rnd() * 0.25) * side;
  const px = o.cx + o.ux * along, pz = o.cz + o.uz * along;
  if (!pointInRing(px, pz, ring) || distToRing(px, pz, ring) < 0.5) return;
  const top = info.ridgeY + 0.9;
  const y0 = c.top - 0.3;
  const m = surf(B, 2, 'brick-red', C(pick(rnd, ['#8e4a36', '#7a4434', '#9a5a44', '#6e4a3e'])));
  m.obox(px, (y0 + top) / 2, pz, 0.45, (top - y0) / 2, 0.32, o.angle, [0.85, 1]);
  surf(B, 2, 'concrete-plain', C('#9a968e')).obox(px, top + 0.06, pz, 0.52, 0.06, 0.39, o.angle, [0.8, 1]);
  surf(B, 0, 'dark', C('#222222')).obox(px, top + 0.2, pz, 0.12, 0.1, 0.12, o.angle, [0.5, 0.7]);
}

function pick<T>(r: () => number, a: T[]): T { return a[Math.floor(r() * a.length) % a.length]; }

export type { Buckets };
