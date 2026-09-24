// Dressing for windowless walls (party walls exposed above a lower neighbor, side walls of commercial
// blocks): long rain streaks from the coping, patched brick, utility pipes and conduit, a roof-access
// ladder, and either a faded ghost sign or a painted (generic, non-branded) mural. All geometry goes into
// the chunk's existing surface buckets (no extra draw calls); overlays reuse the wall's own texture layer.
import * as THREE from 'three';
import type { Frame, MB } from './builder';
import { OVERLAY } from './materials';
import { ghostSign } from './streetDetail';
import type { BCtx, EdgeInfo } from './facade';

type Surf = (B: BCtx['B'], lod: 0 | 1 | 2, id: string, color: THREE.Color, strength?: number) => MB;
const C = (h: string) => new THREE.Color(h);
const PIPE_COLS = ['#5d6062', '#3a3c3e', '#6b4a36', '#7c7f80'];

/** Deterministic per-wall random stream (independent of the building's main rng, so it never shifts it). */
function wallRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
}

/** Overlay quad in front of the wall with the wall's own texture layer and UVs (same look, extra data). */
function overlayQuad(mb: MB, f: Frame, s0: number, s1: number, y0: number, y1: number, d: number) {
  const u0 = f.u0;
  mb.quad(f.pt(s0, y0, d), f.pt(s1, y0, d), f.pt(s1, y1, d), f.pt(s0, y1, d), [u0 + s0, y0, u0 + s1, y0, u0 + s1, y1, u0 + s0, y1]);
}

export function blankWallDressing(c: BCtx, surf: Surf, e: EdgeInfo) {
  const { B, st, b } = c;
  const f = e.f, L = e.L;
  if (L < 3 || c.isPart) return;
  const wallId = st.wallTex;
  const masonry = /^(brick|stucco|plaster|concrete|stone|sandstone|adobe)/.test(wallId);
  if (!masonry) return;
  const r = wallRng((b.seed ^ Math.imul(e.i + 1, 0x85ebca6b)) >>> 0);
  const exposedFrom = Number.isFinite(e.abutTop ?? -Infinity) ? Math.max(c.floorBase, (e.abutTop as number) + 0.3) : c.floorBase;
  const y1 = (c.streakTop ?? c.top) - 0.05;
  const visH = y1 - exposedFrom;
  if (visH < 1.5) return; // fully hidden by the neighbor
  const toGround = exposedFrom <= c.floorBase + 0.01;
  const brick = wallId.startsWith('brick');

  // 1) long rain streaks from the coping (the facade shader's leak mask, stretched over several metres)
  if (visH > 2.5) {
    const mb = surf(B, 2, wallId, st.wallColor);
    const h = Math.min(visH, 4 + r() * 5);
    const a = 0.7 + r() * 0.3;
    mb.wxq = [a, 1.79, 0, 0, a, 1.79, 0, 0, a, 0, 0, 0, a, 0, 0, 0];
    overlayQuad(mb, f, 0.15, L - 0.15, y1 - h, y1, 0.008);
    mb.wxq = null;
  }

  // 3) art: painted mural or a faded ghost sign (at most one per building)
  let artS0 = -1, artS1 = -1;
  const oldEra = b.era === 'pre-1900' || b.era === '1900-1939' || b.era === '1940-1969';
  if (!c.ghostDone && visH >= 4.5 && L >= 7) {
    const roll = r();
    if (roll < 0.3) {
      // mural: ~1:1 to 1.6:1, from near the sidewalk (or the neighbor's roof) upward
      let h = Math.min(visH - 1.2, 9);
      let w = Math.min(L - 1.6, h * (1 + r() * 0.6));
      h = Math.min(h, w * 1.1);
      if (w >= 4 && h >= 3) {
        const s0 = 0.8 + r() * (L - 1.6 - w);
        const y0 = toGround ? c.floorBase + 0.6 + r() * Math.max(0, visH - h - 1.6) : exposedFrom + 0.4;
        const k = Math.floor(r() * 4), i = k % 2, j = k >> 1;
        const mb = surf(B, 2, wallId, st.wallColor);
        mb.layer += 2 * OVERLAY;
        const ul = i / 2 + 0.004, uh = (i + 1) / 2 - 0.004, vl = 1 - (j + 1) / 2 + 0.004, vh = 1 - j / 2 - 0.004;
        mb.wxq = [0, 0, ul, vl, 0, 0, uh, vl, 0, 0, uh, vh, 0, 0, ul, vh];
        overlayQuad(mb, f, s0, s0 + w, y0, y0 + h, 0.012);
        mb.wxq = null;
        mb.layer -= 2 * OVERLAY;
        c.ghostDone = true;
        artS0 = s0; artS1 = s0 + w;
      }
    } else if (roll < 0.75 && oldEra && (brick || wallId === 'stucco' || wallId === 'plaster')) {
      ghostSign(c, surf, f, L, y1 - 0.6, (b.seed >>> 2) ^ e.i);
      c.ghostDone = true;
      artS0 = 0.8; artS1 = L - 0.8; // conservative: keep pipes/ladders at the ends
    }
  }
  const clear = (s: number, hw: number) => artS0 < 0 || s + hw < artS0 - 0.3 || s - hw > artS1 + 0.3;

  // 3b) patched / repointed brick: rectangles of slightly different brick, offset bond
  if (brick && r() < 0.65) {
    const n = 1 + Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const w = 1.2 + r() * 2.6, h = 0.8 + r() * 1.8;
      if (w > L - 1 || h > visH - 0.6) continue;
      const s0 = 0.5 + r() * (L - 1 - w), y0 = exposedFrom + 0.3 + r() * (visH - h - 0.6);
      if (!clear(s0 + w / 2, w / 2)) continue;
      const tint = st.wallColor.clone().multiplyScalar(0.84 + r() * 0.3);
      tint.offsetHSL((r() - 0.5) * 0.02, (r() - 0.5) * 0.1, 0);
      const mb = surf(B, 2, wallId, tint);
      const u0 = f.u0 + 0.37, sh = 0.21;
      mb.quad(f.pt(s0, y0, 0.016), f.pt(s0 + w, y0, 0.016), f.pt(s0 + w, y0 + h, 0.016), f.pt(s0, y0 + h, 0.016),
        [u0 + s0, y0 + sh, u0 + s0 + w, y0 + sh, u0 + s0 + w, y0 + h + sh, u0 + s0, y0 + h + sh]);
    }
  }

  // 4) utility pipes / conduit running up the wall near an end, with standoff clamps
  if (visH > 3.5 && r() < 0.6) {
    const n = r() < 0.3 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const s = r() < 0.5 ? 0.45 + r() * 1.2 : L - 0.45 - r() * 1.2;
      const hw = 0.05 + r() * 0.04;
      if (!clear(s, hw + 0.3)) continue;
      const pc = C(PIPE_COLS[Math.floor(r() * PIPE_COLS.length)]);
      const yb = toGround ? c.groundY + 0.25 : exposedFrom;
      const yt = c.top + (c.flat ? 0.25 : -0.1);
      surf(B, 2, 'metal', pc).box(f, s - hw, s + hw, yb, yt, 0.06, 0.06 + hw * 2, 1 | 4 | 8 | 16);
      const m0 = surf(B, 0, 'metal', pc.clone().multiplyScalar(0.8));
      for (let y = yb + 1.2; y < yt - 0.3; y += 2.4) m0.box(f, s - hw - 0.03, s + hw + 0.03, y, y + 0.06, 0, 0.08 + hw * 2, 1 | 4 | 8 | 16 | 32);
    }
    // a service meter box + conduit near the sidewalk
    if (toGround && r() < 0.5) {
      const s = 1 + r() * (L - 2);
      if (clear(s, 0.5)) {
        const y0 = c.groundY + 1.1;
        surf(B, 0, 'metal', C('#8a8d8f')).box(f, s - 0.22, s + 0.22, y0, y0 + 0.6, 0, 0.2, 1 | 4 | 8 | 16 | 32);
        surf(B, 0, 'metal', C('#4d5052')).box(f, s - 0.03, s + 0.03, y0 + 0.6, Math.min(y1, y0 + 3.5), 0.03, 0.09, 1 | 4 | 8);
      }
    }
  }

  // 5) roof-access ladder (flat roofs): caged-less fixed ladder from ~2.7 m up, goose-neck over the parapet
  if (c.flat && visH > 5 && r() < 0.35) {
    const s = r() < 0.5 ? 1.2 + r() * 2 : L - 1.7 - r() * 2;
    if (clear(s + 0.25, 0.6) && s > 0.4 && s + 0.5 < L - 0.4) {
      const ya = Math.max(exposedFrom, c.groundY) + (toGround ? 2.7 : 0.4), yb = c.top + 1.0;
      const lc = C('#2b2d2f'), d0 = 0.16, d1 = 0.2;
      const rails = surf(B, 2, 'metal', lc);
      rails.box(f, s, s + 0.05, ya, yb, d0, d1, 1 | 4 | 8);
      rails.box(f, s + 0.45, s + 0.5, ya, yb, d0, d1, 1 | 4 | 8);
      // goose-neck handrails bending back over the coping
      rails.box(f, s, s + 0.05, yb - 0.05, yb, -0.5, d1, 1 | 4 | 8 | 16);
      rails.box(f, s + 0.45, s + 0.5, yb - 0.05, yb, -0.5, d1, 1 | 4 | 8 | 16);
      const m0 = surf(B, 0, 'metal', lc);
      for (let y = ya + 0.2; y < c.top - 0.1; y += 0.3) m0.box(f, s + 0.05, s + 0.45, y, y + 0.025, d0 + 0.01, d1 - 0.01, 1 | 16);
      for (let y = ya + 0.5; y < yb - 0.3; y += 2.2) { m0.box(f, s, s + 0.04, y, y + 0.05, 0, d0, 1 | 4 | 16); m0.box(f, s + 0.46, s + 0.5, y, y + 0.05, 0, d0, 1 | 8 | 16); }
    }
  }
}
