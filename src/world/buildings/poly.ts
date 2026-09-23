// 2D polygon utilities in [x, z] meters for the building generator.
import type { Vec2 } from '../../core/types';

export function signedArea(r: Vec2[]): number {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Canonical orientation used here: CCW seen from above (north up) ⇔ signedArea < 0.
 *  With that orientation the outward normal of edge p→q is (-dz, dx)/L. */
export function outwardNormal(p: Vec2, q: Vec2): Vec2 {
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const l = Math.hypot(dx, dz) || 1;
  return [-dz / l, dx / l];
}

export function centroid(r: Vec2[]): Vec2 {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of r) { sx += p[0]; sz += p[1]; }
    return [sx / r.length, sz / r.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, r: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSeg(px: number, pz: number, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - a[0] - t * dx, pz - a[1] - t * dz);
}

export function distToRing(px: number, pz: number, r: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < r.length; i++) d = Math.min(d, distToSeg(px, pz, r[i], r[(i + 1) % r.length]));
  return d;
}

/**
 * Clean a ring: drop duplicate / near-collinear vertices and tiny edges.
 * Returns the cleaned ring and, for each new edge, the index of the original edge it mostly came from.
 */
export function cleanRing(ring: Vec2[], minEdge = 0.25, collinearDeg = 4): { ring: Vec2[]; src: number[] } {
  let pts = ring.map((p, i) => ({ p: [p[0], p[1]] as Vec2, e: i }));
  // closed input guard
  if (pts.length > 2) {
    const a = pts[0].p, b = pts[pts.length - 1].p;
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  }
  const sinTol = Math.sin((collinearDeg * Math.PI) / 180);
  let changed = true;
  let guard = 0;
  while (changed && pts.length > 3 && guard++ < 20) {
    changed = false;
    // tiny edges
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = pts[i].p, b = pts[(i + 1) % pts.length].p;
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minEdge) {
        // merge b into a (keep midpoint)
        const j = (i + 1) % pts.length;
        pts[i].p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        pts.splice(j, 1);
        changed = true;
        i--;
      }
    }
    // collinear
    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const n = pts.length;
      const a = pts[(i - 1 + n) % n].p, b = pts[i].p, c = pts[(i + 1) % n].p;
      const ux = b[0] - a[0], uz = b[1] - a[1], vx = c[0] - b[0], vz = c[1] - b[1];
      const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
      if (lu < 1e-6 || lv < 1e-6) { pts.splice(i, 1); changed = true; i--; continue; }
      const cr = (ux * vz - uz * vx) / (lu * lv);
      const dot = (ux * vx + uz * vz) / (lu * lv);
      if (Math.abs(cr) < sinTol && dot > 0) {
        // vertex b is removed; edge (a→c) inherits the longer source edge
        const prev = (i - 1 + n) % n;
        if (lv > lu) pts[prev].e = pts[i].e;
        pts.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return { ring: pts.map((p) => p.p), src: pts.map((p) => p.e) };
}

export function isConvex(r: Vec2[]): boolean {
  const n = r.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], c = r[(i + 2) % n];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Convex hull (monotone chain), returned in canonical orientation (signedArea < 0). */
export function convexHull(pts: Vec2[]): Vec2[] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  const h = lower.concat(upper);
  return signedArea(h) > 0 ? h.reverse() : h;
}

export interface OBB { cx: number; cz: number; ux: number; uz: number; /** half length along u */ hu: number; /** half length along v=(−uz,ux) */ hv: number; angle: number }

/** Minimum-area oriented bounding rectangle via rotating edges of the hull. */
export function minAreaRect(pts: Vec2[]): OBB {
  const hull = convexHull(pts);
  let best: OBB | null = null;
  let bestA = Infinity;
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i], b = hull[(i + 1) % n];
    let ux = b[0] - a[0], uz = b[1] - a[1];
    const l = Math.hypot(ux, uz);
    if (l < 1e-6) continue;
    ux /= l; uz /= l;
    const vx = -uz, vz = ux;
    let mnu = Infinity, mxu = -Infinity, mnv = Infinity, mxv = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz, v = p[0] * vx + p[1] * vz;
      if (u < mnu) mnu = u; if (u > mxu) mxu = u; if (v < mnv) mnv = v; if (v > mxv) mxv = v;
    }
    const area = (mxu - mnu) * (mxv - mnv);
    if (area < bestA - 1e-6) {
      bestA = area;
      const cu = (mnu + mxu) / 2, cv = (mnv + mxv) / 2;
      best = { cx: cu * ux + cv * vx, cz: cu * uz + cv * vz, ux, uz, hu: (mxu - mnu) / 2, hv: (mxv - mnv) / 2, angle: Math.atan2(uz, ux) };
    }
  }
  if (!best) {
    const c = pts[0] ?? [0, 0];
    best = { cx: c[0], cz: c[1], ux: 1, uz: 0, hu: 0.5, hv: 0.5, angle: 0 };
  }
  // make u the long axis
  if (best.hv > best.hu) {
    best = { cx: best.cx, cz: best.cz, ux: -best.uz, uz: best.ux, hu: best.hv, hv: best.hu, angle: 0 };
    best.angle = Math.atan2(best.uz, best.ux);
  }
  return best;
}

export function obbCorners(o: OBB): Vec2[] {
  const vx = -o.uz, vz = o.ux;
  const c: Vec2[] = [
    [o.cx - o.ux * o.hu - vx * o.hv, o.cz - o.uz * o.hu - vz * o.hv],
    [o.cx + o.ux * o.hu - vx * o.hv, o.cz + o.uz * o.hu - vz * o.hv],
    [o.cx + o.ux * o.hu + vx * o.hv, o.cz + o.uz * o.hu + vz * o.hv],
    [o.cx - o.ux * o.hu + vx * o.hv, o.cz - o.uz * o.hu + vz * o.hv],
  ];
  return signedArea(c) > 0 ? c.reverse() : c;
}

/** Miter offset of a ring outward by d (negative = inset). Miter clamped. Ring in canonical orientation. */
export function offsetRing(r: Vec2[], d: number, miterLimit = 3): Vec2[] {
  const n = r.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = r[(i - 1 + n) % n], b = r[i], c = r[(i + 1) % n];
    const n1 = outwardNormal(a, b), n2 = outwardNormal(b, c);
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push([b[0] + n1[0] * d, b[1] + n1[1] * d]); continue; }
    mx /= ml; mz /= ml;
    const cosHalf = mx * n1[0] + mz * n1[1];
    let k = d / Math.max(cosHalf, 1 / miterLimit);
    out.push([b[0] + mx * k, b[1] + mz * k]);
  }
  return out;
}

/** Half-plane a*x + b*z <= c. */
export interface HalfPlane { a: number; b: number; c: number }

/** Clip a convex-or-not polygon (subject) against a half-plane (Sutherland–Hodgman step). */
export function clipHalfPlane(poly: Vec2[], h: HalfPlane): Vec2[] {
  const out: Vec2[] = [];
  const n = poly.length;
  if (!n) return out;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const fp = h.a * p[0] + h.b * p[1] - h.c, fq = h.a * q[0] + h.b * q[1] - h.c;
    const pin = fp <= 1e-9, qin = fq <= 1e-9;
    if (pin) out.push(p);
    if (pin !== qin) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Clip subject polygon by a convex clip polygon (canonical orientation). */
export function clipByConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const p = clip[i], q = clip[(i + 1) % clip.length];
    const nrm = outwardNormal(p, q);
    out = clipHalfPlane(out, { a: nrm[0], b: nrm[1], c: nrm[0] * p[0] + nrm[1] * p[1] });
  }
  return out;
}

export function ringArea(r: Vec2[]): number { return Math.abs(signedArea(r)); }

/** Evenly-spaced sample points inside the polygon on a jittered grid (for rooftop props). */
export function interiorPoints(r: Vec2[], spacing: number, margin: number, rnd: () => number, max = 50): Vec2[] {
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
  for (const p of r) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mnz = Math.min(mnz, p[1]); mxz = Math.max(mxz, p[1]); }
  const out: Vec2[] = [];
  for (let x = mnx + margin; x < mxx - margin; x += spacing) {
    for (let z = mnz + margin; z < mxz - margin; z += spacing) {
      const px = x + (rnd() - 0.5) * spacing * 0.5, pz = z + (rnd() - 0.5) * spacing * 0.5;
      if (pointInRing(px, pz, r) && distToRing(px, pz, r) > margin) out.push([px, pz]);
      if (out.length >= max) return out;
    }
  }
  return out;
}
