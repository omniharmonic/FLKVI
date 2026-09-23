// OWNER: compiler agent. Procedural surveillance camera placement (Game Design §10 Option A).
import type { RecipeCamera, CameraType, RecipeArea, Vec2 } from '../core/types.ts';
import { rng, hashString } from '../core/geo.ts';
import { headingOf, polyArea, orientedBox, distToRing, pointInRing, centroid, polylineLength } from './geom.ts';
import type { Ctx } from './context.ts';
import { ARTERIAL, CLASS_RANK, PUBLIC_STREET, type RoadIndex, type RoadInfo, type GraphResult } from './roads.ts';
import { insideBuilding, type BuildResult } from './buildings.ts';
import { junctionLegs, type SignalPole } from './props.ts';
import { walk } from './vegetation.ts';

interface Cand {
  p: Vec2; heading: number; score: number; kind: 'intersection' | 'entry' | 'lot' | 'plaza' | 'corridor';
  signal?: SignalPole; lotArea?: number; tags: Set<CameraType>;
}

export function placeCameras(infos: RoadInfo[], gr: GraphResult, roads: RoadIndex, bld: BuildResult, areas: RecipeArea[], signalPoles: SignalPole[], ctx: Ctx): RecipeCamera[] {
  const { bounds, heightAt, density } = ctx;
  const R = rng(ctx.seed ^ 0xca3e7a);
  const cands: Cand[] = [];
  const legs = junctionLegs(infos);
  const inner = (p: Vec2, m = 8) => p[0] > bounds.minX + m && p[0] < bounds.maxX - m && p[1] > bounds.minZ + m && p[1] < bounds.maxZ - m;
  const curbSpot = (base: Vec2, dir: Vec2, hw: number, side: number, extra = 0.7): Vec2 => [base[0] - dir[1] * (hw + extra) * side, base[1] + dir[0] * (hw + extra) * side];

  // a) arterial intersections (secondary+), weighted by class; signalized ones may carry clusters
  for (const j of gr.junctions) {
    if (j.maxRank < 3) continue;
    const L = (legs.get(j.id) ?? []).filter((l) => PUBLIC_STREET.has(l.info.road.cls));
    if (L.length < 3) continue;
    const arterialLegs = L.filter((l) => ARTERIAL.has(l.info.road.cls)).length;
    const base = j.maxRank >= 4 ? 3 : 1.4;
    const score = base + arterialLegs * 0.6 + (j.signal ? 1.5 : 0) + density(j.p[0], j.p[1]) * 2;
    // choose the leg of the highest class to watch; camera at the near-right corner facing approaching traffic
    const sorted = L.slice().sort((a, b) => b.rank - a.rank || b.hw - a.hw);
    const H = Math.max(...L.map((l) => l.hw));
    for (let k = 0; k < Math.min(2, sorted.length); k++) {
      const l = sorted[k];
      if (!l.inbound) continue;
      const setback = H + 3 + R() * 4;
      const b: Vec2 = [j.p[0] + l.d[0] * setback, j.p[1] + l.d[1] * setback];
      const p = curbSpot(b, [-l.d[0], -l.d[1]], l.hw, 1, Math.min(1.0, Math.max(0.5, l.sidewalk * 0.3)));
      // look out along the leg at approaching vehicles (~25 m out)
      const tgt: Vec2 = [j.p[0] + l.d[0] * (setback + 25), j.p[1] + l.d[1] * (setback + 25)];
      cands.push({ p, heading: headingOf(tgt[0] - p[0], tgt[1] - p[1]), score: score - k * 0.8, kind: 'intersection', tags: new Set(['pole', 'ptz']) });
    }
  }
  // signal-mast clusters
  for (const sp of signalPoles) {
    if (!sp.mast) continue;
    const jr = gr.junctions.find((j) => Math.hypot(j.p[0] - sp.junction[0], j.p[1] - sp.junction[1]) < 0.5);
    const rank = jr ? jr.maxRank : 3;
    cands.push({ p: sp.p, heading: headingOf(sp.junction[0] - sp.p[0], sp.junction[1] - sp.p[1]), score: 2 + rank * 0.5 + density(sp.p[0], sp.p[1]), kind: 'intersection', signal: sp, tags: new Set(['cluster']) });
  }
  // b) entry roads: tertiary+ crossing the boundary
  for (const inf of infos) {
    const r = inf.road;
    if (CLASS_RANK[r.cls] < 3 || !PUBLIC_STREET.has(r.cls)) continue;
    for (const end of [0, r.pts.length - 1]) {
      const e = r.pts[end];
      if (inner(e, 2)) continue;
      // walk 50 m inward
      const pts = end === 0 ? r.pts : r.pts.slice().reverse();
      if (polylineLength(pts) < 60) continue;
      let placed = false;
      walk(pts, 50, (p, i, dir) => {
        if (placed || i > 0) return;
        placed = true;
        const side = r.oneway && end !== 0 ? -1 : 1;
        const q = curbSpot(p, [-dir[0], -dir[1]], r.width / 2, side === 1 ? 1 : -1, 0.8);
        const out: Vec2 = [p[0] - dir[0] * 30, p[1] - dir[1] * 30];
        cands.push({ p: q, heading: headingOf(out[0] - q[0], out[1] - q[1]), score: 2.2 + CLASS_RANK[r.cls] * 0.4, kind: 'entry', tags: new Set(['pole']) });
      }, 45);
    }
  }
  // c) parking lot entrances (+ towers in big lots)
  for (const a of areas) {
    if (a.kind !== 'parking') continue;
    const area = polyArea(a.poly);
    if (area < 400) continue;
    // entrance = polygon vertex closest to a public street
    let best: { p: Vec2; d: number; road: RoadInfo; seg: number } | null = null;
    for (const v of a.poly) {
      const n = roads.nearest(v[0], v[1], 30, (i) => PUBLIC_STREET.has(i.road.cls));
      if (n && (!best || n.d < best.d)) best = { p: v, d: n.d, road: n.info, seg: n.seg };
    }
    if (best) {
      const c = centroid(a.poly);
      const s = roads.segs[best.seg];
      const dir: Vec2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
      const L = Math.hypot(dir[0], dir[1]) || 1;
      // place on the curb/edge between lot and road
      const toLot: Vec2 = [c[0] - best.p[0], c[1] - best.p[1]];
      const tl = Math.hypot(toLot[0], toLot[1]) || 1;
      const p: Vec2 = [best.p[0] + (toLot[0] / tl) * 2, best.p[1] + (toLot[1] / tl) * 2];
      void L;
      // face from the lot edge out toward the entrance / road traffic
      cands.push({ p, heading: headingOf(best.p[0] - c[0], best.p[1] - c[1]), score: 1.6 + Math.min(2, area / 3000), kind: 'lot', lotArea: area, tags: new Set(['pole']) });
    }
    if (area > 2500) {
      const box = orientedBox(a.poly);
      const p: Vec2 = [box.cx, box.cz];
      if (pointInRing(p[0], p[1], a.poly)) cands.push({ p, heading: 0, score: 2 + area / 4000, kind: 'lot', lotArea: area, tags: new Set(['tower']) });
    }
  }
  // d) plazas / pedestrian streets / parks next to downtown
  for (const a of areas) {
    if (a.kind !== 'plaza' && a.kind !== 'pedestrian') continue;
    const area = polyArea(a.poly);
    if (area < 250) continue;
    const c = centroid(a.poly);
    // pole at the edge, looking at center
    let best = a.poly[0], bd = Infinity;
    for (const v of a.poly) { const d = Math.hypot(v[0] - c[0], v[1] - c[1]); if (d < bd) { bd = d; best = v; } }
    const p: Vec2 = [best[0] + (c[0] - best[0]) * 0.15, best[1] + (c[1] - best[1]) * 0.15];
    cands.push({ p, heading: headingOf(c[0] - p[0], c[1] - p[1]), score: 2.5 + Math.min(2, area / 2000), kind: 'plaza', tags: new Set(['ptz']) });
  }
  for (const inf of infos) {
    if (inf.road.cls !== 'pedestrian') continue;
    const len = polylineLength(inf.road.pts);
    if (len < 60) continue;
    walk(inf.road.pts, 85, (p, i, dir) => {
      const side = i % 2 ? 1 : -1;
      const q = curbSpot(p, dir, inf.road.width / 2, side, -1.2);
      cands.push({ p: q, heading: headingOf(-dir[1] * -side, dir[0] * -side), score: 2.8, kind: 'plaza', tags: new Set(['ptz']) });
    }, 30);
  }
  // e) commercial corridors: mid-block coverage on busy commercial streets
  for (const inf of infos) {
    const r = inf.road;
    if (!(CLASS_RANK[r.cls] >= 2 && PUBLIC_STREET.has(r.cls))) continue;
    walk(r.pts, 110, (p, i, dir) => {
      const d = density(p[0], p[1]);
      if (d < 0.3) return;
      const side = (hashString(r.id) + i) % 2 ? 1 : -1;
      const q = curbSpot(p, dir, r.width / 2, side, 0.7);
      const look: Vec2 = [p[0] + dir[0] * 20 * side, p[1] + dir[1] * 20 * side];
      cands.push({ p: q, heading: headingOf(look[0] - q[0], look[1] - q[1]), score: 0.8 + d * 1.5 + CLASS_RANK[r.cls] * 0.2, kind: 'corridor', tags: new Set(['pole', 'ptz']) });
    }, 40);
  }

  // ---------- selection ----------
  const km2 = ((bounds.maxX - bounds.minX) * (bounds.maxZ - bounds.minZ)) / 1e6;
  let avgDens = 0, nS = 0;
  for (let x = bounds.minX + 50; x < bounds.maxX; x += 100) for (let z = bounds.minZ + 50; z < bounds.maxZ; z += 100) { avgDens += density(x, z); nS++; }
  avgDens /= Math.max(1, nS);
  const perKm2 = avgDens > 0.3 ? 30 : avgDens > 0.18 ? 24 : avgDens > 0.08 ? 16 : 9;
  const target = Math.max(8, Math.round(km2 * perKm2));

  const valid = (c: Cand) => {
    if (!inner(c.p, 6)) return false;
    if (c.kind !== 'intersection' || !c.signal) {
      if (roads.onCarriageway(c.p[0], c.p[1], 0.3, (i) => i.road.cls !== 'pedestrian')) return false;
    }
    if (insideBuilding(c.p[0], c.p[1], bld, 0.6)) return false;
    for (const s of bld.sensitivePts) {
      if (Math.hypot(s.p[0] - c.p[0], s.p[1] - c.p[1]) < 60 + 200) {
        if (pointInRing(c.p[0], c.p[1], s.ring) || distToRing(c.p[0], c.p[1], s.ring) < 60) return false;
      }
    }
    return true;
  };
  for (const c of cands) c.score *= 0.75 + R() * 0.5;
  cands.sort((a, b) => b.score - a.score);
  const chosen: Cand[] = [];
  const quota = { cluster: Math.round(target * 0.15), tower: Math.max(0, Math.round(target * 0.05)), ptz: Math.round(target * 0.25) };
  const counts = { cluster: 0, tower: 0, ptz: 0, pole: 0 };
  const types: CameraType[] = [];
  const spacingOK = (p: Vec2, min = 60) => chosen.every((c) => Math.hypot(c.p[0] - p[0], c.p[1] - p[1]) >= min);
  // two passes: reserve the rare types (mast clusters, lot towers) first, then fill with poles/PTZs
  const ordered = cands.filter((c) => c.tags.has('cluster') || c.tags.has('tower')).concat(cands.filter((c) => !(c.tags.has('cluster') || c.tags.has('tower'))));
  for (const c of ordered) {
    if (chosen.length >= target) break;
    let t: CameraType | null = null;
    if (c.tags.has('cluster')) { if (counts.cluster < quota.cluster) t = 'cluster'; }
    else if (c.tags.has('tower')) { if (counts.tower < quota.tower) t = 'tower'; }
    else if (c.tags.has('ptz') && c.kind === 'plaza') t = counts.ptz < quota.ptz ? 'ptz' : 'pole';
    else if (c.tags.has('ptz') && counts.ptz < quota.ptz && (R() < 0.3 || c.kind === 'corridor' && R() < 0.5)) t = 'ptz';
    else if (c.tags.has('pole')) t = 'pole';
    else if (c.tags.has('ptz')) t = 'pole';
    if (!t) continue;
    if (!spacingOK(c.p)) continue;
    if (!valid(c)) continue;
    chosen.push(c); types.push(t); counts[t]++;
  }
  // top up ptz share from poles if short (downtown poles with good views)
  for (let i = 0; i < chosen.length && counts.ptz < quota.ptz; i++) {
    if (types[i] === 'pole' && chosen[i].kind !== 'entry' && R() < 0.6) { types[i] = 'ptz'; counts.ptz++; counts.pole--; }
  }

  const cams: RecipeCamera[] = chosen.map((c, i) => {
    const t = types[i];
    const cr = rng(hashString(`cam${i}:${c.p[0].toFixed(1)}`) ^ ctx.seed);
    const cam: RecipeCamera = {
      id: `cam-${String(i + 1).padStart(3, '0')}`, type: t,
      p: [+c.p[0].toFixed(2), +c.p[1].toFixed(2)], y: +heightAt(c.p[0], c.p[1]).toFixed(2),
      heading: +(((c.heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toFixed(3),
      poleHeight: 5, cuttable: true, fovDeg: 40, rangeM: 55, plateReader: false, mapped: cr() < 0.75,
    };
    switch (t) {
      case 'pole': cam.poleHeight = +(4.2 + cr() * 1.6).toFixed(2); cam.fovDeg = 40; cam.rangeM = 55; cam.plateReader = true; break;
      case 'ptz': cam.poleHeight = +(6 + cr() * 2).toFixed(2); cam.fovDeg = 70; cam.rangeM = 45; cam.sweep = { amplitudeDeg: 50 + Math.round(cr() * 40), periodS: 8 + Math.round(cr() * 8) }; break;
      case 'cluster': cam.poleHeight = c.signal?.height ?? 6.8; cam.cuttable = false; cam.fovDeg = 60; cam.rangeM = 40; cam.plateReader = cr() < 0.5; break;
      case 'tower': cam.poleHeight = +(7.5 + cr() * 1.5).toFixed(2); cam.fovDeg = 360; cam.rangeM = 60; cam.heading = 0; break;
    }
    return cam;
  });
  return cams;
}
