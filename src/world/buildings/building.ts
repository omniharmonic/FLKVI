// One building: footprint cleanup → style → floors → facades per edge → roof → attachments.
import * as THREE from 'three';
import type { RecipeBuilding, Region, Vec2 } from '../../core/types';
import { rng } from '../../core/geo';
import { Frame, type V3 } from './builder';
import { resolveStyle } from './kits';
import { facadeEdge, surf, plainWall, type BCtx, type Buckets, type EdgeInfo, type Floor } from './facade';
import { buildRoof, rooftopProps, chimney } from './roofs';
import { cleanRing, signedArea, outwardNormal, ringArea, centroid } from './poly';

const C = (h: string) => new THREE.Color(h);

export function generateBuilding(B: Buckets, b: RecipeBuilding, region: Region): number {
  if (!b.footprint || b.footprint.length < 3 || !(b.height > 0.5)) return 0;
  // --- footprint cleanup + canonical orientation (signedArea < 0), remap street edges
  let src = b.footprint;
  let streetSrc = new Set(b.streetEdges ?? []);
  if (signedArea(src) > 0) {
    const n = src.length;
    src = src.slice().reverse();
    // old edge i (p_i→p_{i+1}) becomes new edge n-2-i (mod n)
    streetSrc = new Set([...streetSrc].map((i) => (((n - 2 - i) % n) + n) % n));
  }
  const cl = cleanRing(src, 0.35, 5);
  const ring = cl.ring;
  if (ring.length < 3 || ringArea(ring) < 4) return 0;
  const holes = (b.holes ?? []).map((h) => cleanRing(signedArea(h) < 0 ? h.slice().reverse() : h, 0.35, 5).ring).filter((h) => h.length >= 3);
  const streetSet = new Set<number>();
  cl.src.forEach((e, i) => { if (streetSrc.has(e)) streetSet.add(i); });

  const st = resolveStyle(b, region);
  const r = rng(b.seed ^ 0x9e3779b9);
  const isPart = (b.minHeight ?? 0) > 0.5;
  const groundY = b.baseY;
  const base = b.baseY + (b.minHeight ?? 0);
  const top = b.baseY + b.height;
  const flat = b.roof.type === 'flat' || b.roof.type === 'dome' || (b.holes?.length ?? 0) > 0;
  if (!flat) st.parapet = 0;
  const parapet = flat ? Math.min(st.parapet, Math.max(0, (top - base) * 0.25)) : 0;
  const deckY = top - parapet;
  const foundation = isPart ? 0 : Math.min(st.foundation, Math.max(0, (top - base) * 0.2));
  const floorBase = base + foundation;

  // --- floors
  const H = deckY - floorBase - (flat && st.cornice !== 'none' && parapet < st.corniceH ? Math.max(0, st.corniceH * 0.5 - parapet) : 0);
  let n = Math.max(1, b.levels || Math.round((H - st.groundH) / st.floorH) + 1);
  let gH = isPart ? st.floorH : st.groundH;
  if (H / n < 2.5) n = Math.max(1, Math.floor(H / 2.8));
  let uH = n > 1 ? (H - gH) / (n - 1) : 0;
  if (n > 1 && uH < 2.6) { gH = Math.max(2.6, Math.min(gH, H - (n - 1) * 2.7)); uH = (H - gH) / (n - 1); if (uH < 2.5) { n = Math.max(1, Math.floor(H / 3)); gH = n > 1 ? Math.min(gH, H / n * 1.2) : H; uH = n > 1 ? (H - gH) / (n - 1) : 0; } }
  if (n > 1 && uH > 5.2) { const extra = Math.round((H - gH) / st.floorH) - (n - 1); if (extra > 0) { n += extra; uH = (H - gH) / (n - 1); } }
  if (n === 1) gH = Math.max(2.2, H);
  const floors: Floor[] = [];
  let y = floorBase;
  for (let k = 0; k < n; k++) {
    const h = k === 0 ? gH : uH;
    floors.push({ y0: y, y1: y + h, k });
    y += h;
  }

  // front edge: longest street edge, else longest edge
  let frontEdge = -1, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
    const score = L + (streetSet.has(i) ? 1000 : 0);
    if (score > best) { best = score; frontEdge = i; }
  }
  if (!streetSet.size && frontEdge >= 0) streetSet.add(frontEdge);
  const fa = ring[frontEdge], fq = ring[(frontEdge + 1) % ring.length];
  const fN = outwardNormal(fa, fq);

  const c: BCtx = {
    B, b, st, r, groundY, base, floorBase, floors, top, deckY, flat, isPart, frontEdge, streetSet, ring, winCount: 0,
  };

  // --- facades
  let u0 = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], q = ring[(i + 1) % ring.length];
    const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
    const f = Frame.fromEdge(a, q, u0);
    const nn = outwardNormal(a, q);
    const dot = nn[0] * fN[0] + nn[1] * fN[1];
    const e: EdgeInfo = { a, b: q, L, f, street: streetSet.has(i), front: i === frontEdge, rear: !streetSet.has(i) && dot < -0.7, i };
    facadeEdge(c, e);
    u0 += L;
  }
  for (const h of holes) {
    let hu = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], q = h[(i + 1) % h.length];
      const L = Math.hypot(q[0] - a[0], q[1] - a[1]);
      const f = Frame.fromEdge(a, q, hu);
      facadeEdge(c, { a, b: q, L, f, street: false, front: false, rear: true, i: 1000 + i });
      hu += L;
    }
  }

  // --- roof
  const info = buildRoof(c, ring, holes);
  rooftopProps(c, ring, info, r);
  if (st.chimney && !flat) chimney(c, ring, info, r);

  // --- attachments on the front edge
  const ff = Frame.fromEdge(fa, fq);
  const fL = Math.hypot(fq[0] - fa[0], fq[1] - fa[1]);
  if (!isPart) {
    porch(c, ff, fL);
    if (st.canopy && st.ground === 'storefront') stripCanopy(c, ff, fL);
    if (st.steeple) steeple(c, ff, fL, info.ridgeY);
  }
  return c.winCount;
}

// ---------------------------------------------------------------------------------------------
function box(mb: ReturnType<typeof surf>, f: Frame, s0: number, s1: number, y0: number, y1: number, d0: number, d1: number, faces = 63, ao: [number, number] = [0.8, 1]) {
  mb.box(f, s0, s1, y0, y1, d0, d1, faces, ao);
}

/** Cylinder column (12 segments) centered at frame position (s, d). */
function column(mb: ReturnType<typeof surf>, f: Frame, s: number, d: number, y0: number, y1: number, r0: number, r1: number, seg = 16) {
  const c = f.pt(s, 0, d);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a: number, y: number, r: number): V3 => [c[0] + Math.cos(a) * r, y, c[2] + Math.sin(a) * r];
    const n = (a: number): V3 => [Math.cos(a), 0, Math.sin(a)];
    mb.quadN([p(a1, y0, r0), p(a0, y0, r0), p(a0, y1, r1), p(a1, y1, r1)], [n(a1), n(a0), n(a0), n(a1)], [a1 * r0, y0, a0 * r0, y0, a0 * r1, y1, a1 * r1, y1], [0.8, 0.8, 1, 1]);
  }
}

function steps(c: BCtx, f: Frame, s0: number, s1: number, yTop: number, dStart: number, id = 'concrete-plain', color = C('#b5b1a8')) {
  const rise = yTop - c.groundY;
  if (rise < 0.1) return;
  const n = Math.max(1, Math.round(rise / 0.18));
  const h = rise / n;
  const mb = surf(c.B, 2, id, color);
  for (let k = 0; k < n; k++) {
    const yy = yTop - (k + 1) * h;
    box(mb, f, s0, s1, c.groundY - 0.3, yy + h, dStart, dStart + (k + 1) * 0.28, 1 | 4 | 8 | 16, [0.75, 1]);
  }
}

function porch(c: BCtx, f: Frame, L: number) {
  const { st, B } = c;
  const fb = c.floorBase;
  const g = c.floors[0];
  if (!g) return;
  switch (st.porch) {
    case 'craftsman':
    case 'victorian':
    case 'farm': {
      if (L < 5) return;
      const w = st.porch === 'farm' ? Math.min(L - 1, L * 0.7) : Math.min(L - 0.6, Math.max(4, L * (0.55 + c.r() * 0.4)));
      const ds = c.doorS ?? L / 2;
      // porch covers the door; shift toward the side away from the garage
      let left = ds - w * (0.3 + c.r() * 0.4);
      left = Math.max(0.2, Math.min(L - 0.2 - w, left));
      const s0 = Math.max(0.1, left), s1 = Math.min(L - 0.1, s0 + w);
      const D = st.porch === 'farm' ? 1.8 : 2.4;
      const deckY = fb - 0.02;
      // deck + skirt
      const deck = surf(B, 2, 'wood-planks', C(st.porch === 'craftsman' ? '#8b7862' : '#9a8f80'));
      box(deck, f, s0, s1, deckY - 0.08, deckY, 0, D, 1 | 4 | 8 | 16, [0.8, 1]);
      const skirt = st.porch === 'craftsman' ? surf(B, 2, 'brick-red', C('#8e4a36')) : surf(B, 2, 'paint', st.trim);
      box(skirt, f, s0 + 0.05, s1 - 0.05, c.groundY - 0.3, deckY - 0.08, 0.02, D - 0.05, 1 | 4 | 8, [0.6, 0.8]);
      // steps in front of the door
      const sm = Math.max(s0 + 0.8, Math.min(s1 - 0.8, ds));
      steps(c, f, sm - 0.7, sm + 0.7, deckY, D, 'concrete-plain');
      // posts
      const beamY = Math.min(g.y1 - 0.2, deckY + 2.5);
      const nPost = st.porch === 'victorian' ? Math.max(3, Math.round(w / 1.8) + 1) : Math.max(2, Math.round(w / 3) + 1);
      const trim = surf(B, 2, 'paint', st.trim);
      for (let k = 0; k < nPost; k++) {
        const s = s0 + 0.2 + ((s1 - s0 - 0.4) * k) / (nPost - 1);
        if (Math.abs(s - sm) < 0.75 && nPost > 2 && k !== 0 && k !== nPost - 1) continue;
        if (st.porch === 'craftsman') {
          const pier = surf(B, 2, c.r() < 0.5 ? 'stone' : 'brick-red', c.r() < 0.5 ? C('#8f8a83') : C('#8a4633'));
          box(pier, f, s - 0.26, s + 0.26, deckY, deckY + 0.95, D - 0.52, D, 1 | 4 | 8 | 16, [0.75, 1]);
          // tapered column
          const tp = surf(B, 2, 'paint', st.trim);
          const cy0 = deckY + 0.95, cy1 = beamY;
          const pts = (hw: number, y: number, dd: number) => [f.pt(s - hw, y, dd - hw), f.pt(s + hw, y, dd - hw), f.pt(s + hw, y, dd + hw), f.pt(s - hw, y, dd + hw)];
          const bot = pts(0.19, cy0, D - 0.26), topP = pts(0.12, cy1, D - 0.26);
          for (let k2 = 0; k2 < 4; k2++) {
            const k3 = (k2 + 1) % 4;
            tp.quad(bot[k3], bot[k2], topP[k2], topP[k3], [0, cy0, 0.3, cy0, 0.3, cy1, 0, cy1], [0.8, 0.8, 1, 1]);
          }
        } else {
          const pw = st.porch === 'victorian' ? 0.07 : 0.1;
          box(trim, f, s - pw, s + pw, deckY, beamY, D - 0.25 - pw, D - 0.25 + pw, 1 | 2 | 4 | 8, [0.8, 1]);
          if (st.porch === 'victorian') {
            // brackets
            box(trim, f, s - 0.25, s + 0.25, beamY - 0.3, beamY, D - 0.28, D - 0.22, 1 | 2 | 32, [0.8, 1]);
          }
        }
      }
      // beam
      box(trim, f, s0, s1, beamY, beamY + 0.25, D - 0.4, D - 0.1, 63, [0.8, 1]);
      // railing (victorian/farm)
      if (st.porch !== 'craftsman') {
        const rm = surf(B, 0, 'paint', st.trim);
        const ry = deckY + 0.9;
        for (const [a0, a1] of [[s0 + 0.1, sm - 0.75], [sm + 0.75, s1 - 0.1]]) {
          if (a1 - a0 < 0.3) continue;
          box(rm, f, a0, a1, ry - 0.05, ry, D - 0.3, D - 0.2, 63);
          box(rm, f, a0, a1, deckY + 0.08, deckY + 0.13, D - 0.3, D - 0.2, 1 | 16);
          for (let s = a0 + 0.08; s < a1 - 0.04; s += 0.14) box(rm, f, s, s + 0.04, deckY + 0.1, ry - 0.04, D - 0.27, D - 0.23, 1 | 2 | 4 | 8);
        }
        surf(B, 1, 'paint', st.trim).box(f, s0 + 0.1, s1 - 0.1, deckY, deckY + 0.9, D - 0.26, D - 0.24, 1, [0.9, 1]);
      } else {
        // low sided wall between piers (siding)
        const lw = surf(B, 2, st.wallTex, st.wallColor);
        box(lw, f, s0 + 0.26, sm - 0.75, deckY, deckY + 0.8, D - 0.4, D - 0.2, 1 | 2 | 16, [0.8, 1]);
        box(lw, f, sm + 0.75, s1 - 0.26, deckY, deckY + 0.8, D - 0.4, D - 0.2, 1 | 2 | 16, [0.8, 1]);
      }
      // porch roof: shed from the wall down to the beam, overhanging
      const yW = Math.min(g.y1 + 0.15, beamY + 0.9), yE = beamY + 0.25;
      const ov = 0.35;
      const rid = 'roof-' + (c.b.roof.material || 'asphalt-shingle');
      const rm = surf(B, 2, rid, C(c.b.roof.color || '#555555'), 0.8);
      const p0 = f.pt(s0 - ov, yW, 0), p1 = f.pt(s1 + ov, yW, 0), p2 = f.pt(s1 + ov, yE - 0.1, D + ov), p3 = f.pt(s0 - ov, yE - 0.1, D + ov);
      const sl = Math.hypot(D + ov, yW - yE);
      rm.quad(p3, p2, p1, p0, [s0, 0, s1, 0, s1, sl, s0, sl]);
      const sf = surf(B, 2, 'paint', st.trim);
      sf.quad(f.pt(s0 - ov, yW - 0.15, 0), f.pt(s0 - ov, yE - 0.25, D + ov), f.pt(s1 + ov, yE - 0.25, D + ov), f.pt(s1 + ov, yW - 0.15, 0), [0, 0, 1, 0, 1, 1, 0, 1], 0.6);
      // fascia + sides
      sf.quad(f.pt(s0 - ov, yE - 0.3, D + ov), f.pt(s1 + ov, yE - 0.3, D + ov), f.pt(s1 + ov, yE - 0.1, D + ov), f.pt(s0 - ov, yE - 0.1, D + ov), [0, 0, 1, 0, 1, 1, 0, 1], 0.9);
      sf.polygon([f.pt(s0 - ov, yW, 0), f.pt(s0 - ov, yE - 0.1, D + ov), f.pt(s0 - ov, yE - 0.3, D + ov), f.pt(s0 - ov, yW - 0.15, 0)], [-f.tx, 0, -f.tz], (p) => [p[0] + p[2], p[1]]);
      sf.polygon([f.pt(s1 + ov, yW - 0.15, 0), f.pt(s1 + ov, yE - 0.3, D + ov), f.pt(s1 + ov, yE - 0.1, D + ov), f.pt(s1 + ov, yW, 0)], [f.tx, 0, f.tz], (p) => [p[0] + p[2], p[1]]);
      break;
    }
    case 'stoop':
    case 'stoop-small': {
      // find door-ish position: middle for small stoops, one side for brownstones
      const s = c.doorS ?? (st.porch === 'stoop' ? Math.min(L - 1.2, 1.6) : L / 2);
      const w = st.porch === 'stoop' ? 1.8 : 1.6;
      const top = fb;
      if (top - c.groundY < 0.15) return;
      const land = st.porch === 'stoop' ? 1.2 : 1.0;
      const id = st.porch === 'stoop' ? st.wallTex : 'concrete-plain';
      const col = st.porch === 'stoop' ? st.wallColor : C('#b5b1a8');
      const mb = surf(B, 2, id, col);
      box(mb, f, s - w / 2, s + w / 2, c.groundY - 0.3, top, 0, land, 1 | 4 | 8 | 16, [0.75, 1]);
      steps(c, f, s - w / 2 + 0.1, s + w / 2 - 0.1, top, land, id, col);
      if (st.porch === 'stoop') {
        // side walls / railings
        const rise = top - c.groundY;
        const run = Math.round(rise / 0.18) * 0.28 + land;
        const rm = surf(B, 0, 'metal', C('#1a1a1a'));
        for (const sx of [s - w / 2 + 0.05, s + w / 2 - 0.05]) {
          const a = f.pt(sx, top + 0.9, 0.1), bq = f.pt(sx, c.groundY + 0.9, run);
          const a2 = f.pt(sx, top + 0.95, 0.1), b2 = f.pt(sx, c.groundY + 0.95, run);
          rm.quad(a, bq, b2, a2, [0, 0, 1, 0, 1, 1, 0, 1]);
          rm.quad(bq, a, a2, b2, [0, 0, 1, 0, 1, 1, 0, 1]);
          for (let t = 0.1; t < 1; t += 0.12) {
            const px = f.pt(sx, 0, 0.1 + (run - 0.1) * t);
            const yy = top + 0.9 + (c.groundY - top) * t;
            const yb = top + (c.groundY - top) * Math.min(1, t * 1.05);
            rm.obox(px[0], (yy + yb) / 2, px[2], 0.012, (yy - yb) / 2, 0.012, 0, [0.8, 1]);
          }
        }
      } else if (c.r() < 0.6) {
        // small gable hood over the door
        const hm = surf(B, 2, 'paint', st.trim);
        const y0 = fb + 2.35;
        box(hm, f, s - 0.8, s + 0.8, y0, y0 + 0.12, 0, 0.9, 63, [0.7, 1]);
        const rid = 'roof-' + (c.b.roof.material || 'asphalt-shingle');
        const rm = surf(B, 2, rid, C(c.b.roof.color || '#555555'), 0.8);
        rm.quad(f.pt(s - 0.9, y0 + 0.12, 0.95), f.pt(s, y0 + 0.6, 0.95), f.pt(s, y0 + 0.6, 0), f.pt(s - 0.9, y0 + 0.12, 0), [0, 0, 1, 0, 1, 1, 0, 1]);
        rm.quad(f.pt(s, y0 + 0.6, 0.95), f.pt(s + 0.9, y0 + 0.12, 0.95), f.pt(s + 0.9, y0 + 0.12, 0), f.pt(s, y0 + 0.6, 0), [0, 0, 1, 0, 1, 1, 0, 1]);
        hm.polygon([f.pt(s - 0.8, y0 + 0.12, 0.9), f.pt(s + 0.8, y0 + 0.12, 0.9), f.pt(s, y0 + 0.55, 0.9)], [f.nx, 0, f.nz], (p) => [p[0] + p[2], p[1]]);
        // brackets
        box(hm, f, s - 0.75, s - 0.65, y0 - 0.35, y0, 0.05, 0.6, 1 | 4 | 8 | 32);
        box(hm, f, s + 0.65, s + 0.75, y0 - 0.35, y0, 0.05, 0.6, 1 | 4 | 8 | 32);
      }
      break;
    }
    case 'portico': {
      const civic = st.kit === 'civic';
      if (L < (civic ? 12 : 4)) return;
      const w = civic ? Math.min(L * 0.6, 26) : 2.6;
      const s0 = (L - w) / 2, s1 = s0 + w;
      const D = civic ? 3.2 : 1.3;
      const colH = civic ? Math.min((c.floors[1]?.y1 ?? g.y1) - fb, 11) : Math.min(2.8, g.y1 - fb - 0.1);
      const sm = surf(B, 2, civic ? 'trim-stone' : 'paint', civic ? st.stone : st.trim);
      // podium / landing
      box(surf(B, 2, 'trim-stone', st.stone), f, s0 - 0.3, s1 + 0.3, c.groundY - 0.3, fb, 0, D + 0.3, 1 | 4 | 8 | 16, [0.75, 1]);
      steps(c, f, s0, s1, fb, D + 0.3, 'trim-stone', st.stone);
      const nC = civic ? Math.max(4, Math.round(w / 3) + 1) : 2;
      for (let k = 0; k < nC; k++) {
        const s = s0 + 0.4 + ((w - 0.8) * k) / (nC - 1);
        const r0 = civic ? 0.42 : 0.14;
        column(sm, f, s, D - r0 - 0.1, fb, fb + colH, r0, r0 * 0.85);
        box(sm, f, s - r0 - 0.08, s + r0 + 0.08, fb, fb + 0.25, D - 2 * r0 - 0.2, D, 1 | 4 | 8 | 16, [0.8, 1]);
        box(sm, f, s - r0 - 0.05, s + r0 + 0.05, fb + colH - 0.2, fb + colH, D - 2 * r0 - 0.15, D - 0.05, 63, [0.8, 1]);
      }
      // entablature + pediment
      const ey = fb + colH;
      const eh = civic ? 1.2 : 0.35;
      box(sm, f, s0 - 0.2, s1 + 0.2, ey, ey + eh, 0, D + 0.1, 63, [0.75, 1]);
      const ph = civic ? w * 0.18 : 0.7;
      const py = ey + eh;
      sm.polygon([f.pt(s0 - 0.2, py, D + 0.1), f.pt(s1 + 0.2, py, D + 0.1), f.pt((s0 + s1) / 2, py + ph, D + 0.1)], [f.nx, 0, f.nz], (p) => [p[0] + p[2], p[1]], () => 0.9);
      const rid = civic ? 'roof-standing-seam' : 'roof-' + (c.b.roof.material || 'asphalt-shingle');
      const rm = surf(B, 2, rid, civic ? C('#6a6f70') : C(c.b.roof.color || '#555555'), 0.8);
      const mid = (s0 + s1) / 2;
      rm.quad(f.pt(s0 - 0.3, py - 0.02, D + 0.2), f.pt(mid, py + ph, D + 0.2), f.pt(mid, py + ph, -0.2), f.pt(s0 - 0.3, py - 0.02, -0.2), [0, 0, 1, 0, 1, 1, 0, 1]);
      rm.quad(f.pt(mid, py + ph, D + 0.2), f.pt(s1 + 0.3, py - 0.02, D + 0.2), f.pt(s1 + 0.3, py - 0.02, -0.2), f.pt(mid, py + ph, -0.2), [0, 0, 1, 0, 1, 1, 0, 1]);
      // ceiling
      surf(B, 2, 'paint', st.trim).quad(f.pt(s0, ey - 0.01, 0), f.pt(s0, ey - 0.01, D), f.pt(s1, ey - 0.01, D), f.pt(s1, ey - 0.01, 0), [0, 0, 1, 0, 1, 1, 0, 1], 0.5);
      break;
    }
    default: break;
  }
}

function stripCanopy(c: BCtx, f: Frame, L: number) {
  const { B, st } = c;
  const g = c.floors[0];
  if (!g || L < 4) return;
  const y = g.y1 - Math.min(1.1, (g.y1 - g.y0) * 0.25) - 0.1;
  const D = st.kit === 'strip-mall' ? 2.8 : 1.8;
  const m = surf(B, 2, 'stucco', st.trim);
  // fascia band (sign band) projecting
  m.box(f, -0.2, L + 0.2, y, y + 0.9, 0, D, 63, [0.6, 1]);
  // soffit
  surf(B, 2, 'paint', C('#d8d4cc')).quad(f.pt(-0.2, y - 0.001, 0), f.pt(-0.2, y - 0.001, D), f.pt(L + 0.2, y - 0.001, D), f.pt(L + 0.2, y - 0.001, 0), [0, 0, 1, 0, 1, 1, 0, 1], 0.55);
  if (st.kit === 'strip-mall') {
    const cm = surf(B, 2, 'paint', st.trim.clone().multiplyScalar(0.85));
    const n = Math.max(2, Math.round(L / 6) + 1);
    for (let k = 0; k < n; k++) {
      const s = 0.2 + ((L - 0.4) * k) / (n - 1);
      m.layer = cm.layer;
      box(cm, f, s - 0.18, s + 0.18, g.y0, y, D - 0.5, D - 0.14, 1 | 2 | 4 | 8, [0.7, 1]);
    }
  }
}

function steeple(c: BCtx, f: Frame, L: number, ridgeY: number) {
  const { B, st } = c;
  const side = (c.b.seed & 1) ? 0.3 : L - 0.3 - 4.2;
  const s0 = Math.max(0.2, side), s1 = Math.min(L - 0.2, s0 + 4.2);
  const w = s1 - s0;
  if (w < 3) return;
  const y0 = c.floorBase, towerTop = Math.max(ridgeY + 4, c.top + 8);
  const wm = surf(B, 2, st.wallTex, st.wallColor);
  box(wm, f, s0, s1, c.base - 0.3, towerTop, -w + 0.4, 0.4, 1 | 4 | 8 | 2, [0.8, 1]);
  // belfry openings (dark)
  const dm = surf(B, 2, 'dark', C('#2a2a2a'));
  const by = towerTop - 3.2;
  box(dm, f, s0 + 0.9, s1 - 0.9, by, by + 2.2, 0.4, 0.42, 1, [0.5, 0.6]);
  box(surf(B, 2, 'trim-stone', st.stone), f, s0 - 0.1, s1 + 0.1, towerTop - 0.3, towerTop, -w + 0.3, 0.5, 63, [0.8, 1]);
  // spire
  const rm = surf(B, 2, 'roof-slate', C('#4a4f57'));
  const cxs = (s0 + s1) / 2, cd = -w / 2 + 0.4;
  const apex = f.pt(cxs, towerTop + w * 2.2, cd);
  const cs = [f.pt(s0, towerTop, 0.4), f.pt(s1, towerTop, 0.4), f.pt(s1, towerTop, -w + 0.4), f.pt(s0, towerTop, -w + 0.4)];
  for (let k = 0; k < 4; k++) {
    const a = cs[k], b = cs[(k + 1) % 4];
    const ux = b[0] - a[0], uz = b[2] - a[2];
    const vx = apex[0] - a[0], vy = apex[1] - a[1], vz = apex[2] - a[2];
    let nx = -uz * vy, ny = uz * vx - ux * vz, nz = ux * vy;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    rm.polygon([a, b, apex], [nx, ny, nz], (p) => [p[0] + p[2], p[1]]);
  }
  void plainWall; void centroid;
}
