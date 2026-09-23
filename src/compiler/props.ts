// OWNER: compiler agent. Street furniture: OSM-mapped props + rule-based placement (lights, hydrants, parked cars, poles...).
import type { RecipeProp, PropType, RecipeArea, Vec2 } from '../core/types.ts';
import type { OsmData } from './osm.ts';
import { rng, hashString } from '../core/geo.ts';
import { headingOf, r2, GridIndex, orientedBox, pointInPoly, polyArea, clipPolylineRect, polylineLength } from './geom.ts';
import type { Ctx } from './context.ts';
import { PUBLIC_STREET, CLASS_RANK, type RoadIndex, type RoadInfo, type GraphResult } from './roads.ts';
import { insideBuilding, type BuildResult } from './buildings.ts';
import { walk } from './vegetation.ts';

export interface Leg { info: RoadInfo; d: Vec2; hw: number; sidewalk: number; inbound: boolean; outbound: boolean; rank: number }
export interface SignalPole { p: Vec2; heading: number; junction: Vec2; mast: boolean; height: number }

/** Legs of each junction node (OSM node id), for placing corner furniture. */
export function junctionLegs(infos: RoadInfo[]): Map<number, Leg[]> {
  const m = new Map<number, Leg[]>();
  for (const inf of infos) {
    const r = inf.road;
    if (!PUBLIC_STREET.has(r.cls) && r.cls !== 'service') continue;
    for (let i = 0; i < r.nodes.length; i++) {
      const id = r.nodes[i];
      const push = (j: number, forward: boolean) => {
        const a = r.pts[i], b = r.pts[j];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 0.1) return;
        let arr = m.get(id); if (!arr) m.set(id, (arr = []));
        // forward = leg follows way direction away from node → traffic on oneway goes outbound
        arr.push({ info: inf, d: [(b[0] - a[0]) / L, (b[1] - a[1]) / L], hw: r.width / 2, sidewalk: r.sidewalk, inbound: !r.oneway || !forward, outbound: !r.oneway || forward, rank: CLASS_RANK[r.cls] });
      };
      if (i > 0) push(i - 1, false);
      if (i < r.nodes.length - 1) push(i + 1, true);
    }
  }
  return m;
}

export interface PropsResult { props: RecipeProp[]; signalPoles: SignalPole[]; crossings: Vec2[] }

export function buildProps(data: OsmData, infos: RoadInfo[], gr: GraphResult, roads: RoadIndex, bld: BuildResult, areas: RecipeArea[], ctx: Ctx): PropsResult {
  const { proj, bounds, heightAt } = ctx;
  const props: RecipeProp[] = [];
  const grid = new GridIndex<number>(20);
  const inB = (p: Vec2) => p[0] > bounds.minX && p[0] < bounds.maxX && p[1] > bounds.minZ && p[1] < bounds.maxZ;
  const add = (type: PropType, p: Vec2, rot: number, variant = 0, line?: Vec2[]): boolean => {
    if (!line && !inB(p)) return false;
    const pr: RecipeProp = { type, p: [r2(p[0]), r2(p[1])], y: r2(heightAt(p[0], p[1])), rot: +(((rot % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toFixed(3), variant };
    if (line) pr.line = line.map((q) => [r2(q[0]), r2(q[1])] as Vec2);
    props.push(pr);
    grid.insert(props.length - 1, p[0], p[1], p[0], p[1]);
    return true;
  };
  const near = (type: PropType | null, p: Vec2, r: number) => {
    for (const i of grid.near(p[0], p[1], r)) {
      const q = props[i];
      if ((type === null || q.type === type) && (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2 < r * r) return true;
    }
    return false;
  };
  /** Snap a point off the carriageway onto the curb edge of the nearest road. Returns point + heading facing the road. */
  const toCurb = (p: Vec2, extra = 0.5): { p: Vec2; face: number } => {
    const n = roads.nearest(p[0], p[1], 25, (i) => i.drivable || PUBLIC_STREET.has(i.road.cls));
    if (!n) return { p, face: 0 };
    const s = roads.segs[n.seg];
    const sx = s.b[0] - s.a[0], sz = s.b[1] - s.a[1];
    const l2 = sx * sx + sz * sz;
    let t = l2 > 0 ? ((p[0] - s.a[0]) * sx + (p[1] - s.a[1]) * sz) / l2 : 0; t = Math.max(0, Math.min(1, t));
    const q: Vec2 = [s.a[0] + t * sx, s.a[1] + t * sz];
    let vx = p[0] - q[0], vz = p[1] - q[1];
    let d = Math.hypot(vx, vz);
    if (d < 0.05) { const L = Math.sqrt(l2) || 1; vx = -sz / L; vz = sx / L; d = 1; } else { vx /= d; vz /= d; }
    const face = headingOf(-vx, -vz);
    if (n.d < s.half + extra) return { p: [q[0] + vx * (s.half + extra), q[1] + vz * (s.half + extra)], face };
    return { p, face };
  };

  const crossings: Vec2[] = [];
  const hydrantsMapped: Vec2[] = [], lampsMapped: Vec2[] = [], polesMapped: Vec2[] = [], busStops: Vec2[] = [];

  // ---------- OSM point props ----------
  for (const n of data.nodes.values()) {
    const t = n.tags; if (!t) continue;
    const p = proj.toLocal(n.lat, n.lon);
    if (!inB(p)) continue;
    const hw = t.highway;
    if (hw === 'street_lamp') { const c = toCurb(p, 0.5); add('streetlight', c.p, c.face, 0); lampsMapped.push(c.p); }
    else if (hw === 'crossing' || (t.crossing && t.crossing !== 'no' && !t.amenity)) {
      // crosswalk marking on a drivable road
      const nr = roads.nearest(p[0], p[1], 3, (i) => i.drivable || i.road.cls === 'service');
      if (!nr) continue;
      if (t.crossing === 'unmarked' || t['crossing:markings'] === 'no') continue;
      const s = roads.segs[nr.seg];
      const rot = headingOf(s.b[0] - s.a[0], s.b[1] - s.a[1]);
      if (!near('crosswalk', p, 6)) { add('crosswalk', p, rot, CLASS_RANK[s.info.road.cls] >= 3 || t.crossing_ref === 'zebra' || t['crossing:markings'] === 'zebra' ? 0 : 1); crossings.push(p); }
    }
    else if (hw === 'bus_stop' || (t.public_transport === 'platform' && t.bus === 'yes')) {
      const c = toCurb(p, 0.8);
      if (!near('bus-stop', c.p, 10)) { add('bus-stop', c.p, c.face, t.shelter === 'yes' ? 1 : 0); busStops.push(c.p); }
    }
    else if (t.emergency === 'fire_hydrant') { const c = toCurb(p, 0.5); add('hydrant', c.p, c.face, 0); hydrantsMapped.push(c.p); }
    else if (t.amenity === 'bench' || t.leisure === 'picnic_table') { if (!insideBuilding(p[0], p[1], bld)) add('bench', roads.onCarriageway(p[0], p[1]) ? toCurb(p, 1.2).p : p, toCurb(p).face + Math.PI, t.leisure === 'picnic_table' ? 1 : 0); }
    else if (t.amenity === 'waste_basket' || t.amenity === 'recycling' && t.recycling_type === 'container') { add('trash-can', roads.onCarriageway(p[0], p[1]) ? toCurb(p, 0.7).p : p, 0, t.amenity === 'recycling' ? 1 : 0); }
    else if (t.barrier === 'bollard') { add('bollard', p, 0, 0); }
    else if (t.amenity === 'bicycle_parking') { if (!insideBuilding(p[0], p[1], bld)) add('bike-rack', roads.onCarriageway(p[0], p[1]) ? toCurb(p, 1).p : p, toCurb(p).face + Math.PI / 2, 0); }
    else if (t.amenity === 'post_box') { add('mailbox', toCurb(p, 0.6).p, toCurb(p).face, 0); }
    else if (t.amenity === 'vending_machine' && /parking_tickets/.test(t.vending ?? '')) { add('parking-meter', toCurb(p, 0.5).p, toCurb(p).face, 1); }
    else if (t.power === 'pole' || t.man_made === 'utility_pole') { if (!roads.onCarriageway(p[0], p[1])) { add('utility-pole', p, 0, 0); polesMapped.push(p); } }
  }

  // ---------- fences / hedges ----------
  for (const w of data.ways.values()) {
    const b = w.tags?.barrier; if (!b || !/^(fence|hedge|wall|retaining_wall)$/.test(b)) continue;
    const pts: Vec2[] = [];
    for (const id of w.nodes) { const n = data.nodes.get(id); if (n) pts.push(proj.toLocal(n.lat, n.lon)); }
    for (const pc of clipPolylineRect(pts, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ)) {
      if (polylineLength(pc.pts) < 2) continue;
      const mid = pc.pts[Math.floor(pc.pts.length / 2)];
      const variant = b === 'hedge' ? 0 : b === 'fence' ? (/chain|metal/.test(w.tags!.fence_type ?? '') ? 1 : /wood|board|picket/.test(w.tags!.fence_type ?? '') ? 0 : 2) : 3;
      add(b === 'hedge' ? 'hedge' : 'fence', mid, 0, variant, pc.pts);
    }
  }

  // ---------- junction furniture: signals, stop signs, crosswalks ----------
  const legs = junctionLegs(infos);
  const signalPoles: SignalPole[] = [];
  for (const node of gr.graph.nodes) {
    if (!node.signal && !node.stop) continue;
    // find OSM id for this graph node
    let osmId: number | undefined;
    for (const [id, idx] of gr.idx) if (idx === node.id) { osmId = id; break; }
    if (osmId === undefined) continue;
    const L = (legs.get(osmId) ?? []).filter((l) => PUBLIC_STREET.has(l.info.road.cls));
    if (L.length === 0) continue;
    const J = node.p;
    const H = Math.max(...L.map((l) => l.hw));
    const maxRank = Math.max(...L.map((l) => l.rank));
    const isJunction = L.length >= 3 || (gr.degree.get(osmId) ?? 0) >= 3;
    for (const l of L) {
      const Hother = Math.max(3, ...L.filter((o) => o !== l).map((o) => o.hw + (isJunction ? o.sidewalk * 0.5 : 0)));
      const setback = isJunction ? Hother + 1.2 : 0.5;
      const rightOfApproach: Vec2 = [l.d[1], -l.d[0]];
      const base: Vec2 = [J[0] + l.d[0] * setback, J[1] + l.d[1] * setback];
      const pole: Vec2 = [base[0] + rightOfApproach[0] * (l.hw + 0.6), base[1] + rightOfApproach[1] * (l.hw + 0.6)];
      const face = headingOf(l.d[0], l.d[1]);
      if (node.signal) {
        if (l.inbound && !insideBuilding(pole[0], pole[1], bld) && !near('traffic-signal', pole, 4)) {
          const mast = l.hw * 2 >= 9;
          add('traffic-signal', pole, face, mast ? 1 : 0);
          signalPoles.push({ p: pole, heading: face, junction: J, mast, height: mast ? 6.8 : 4.2 });
          // pedestrian push-button / light also covered by the signal model; add a streetlight arm on big corners
        }
        const cw: Vec2 = [J[0] + l.d[0] * (Hother + 2.2), J[1] + l.d[1] * (Hother + 2.2)];
        if (isJunction && !near('crosswalk', cw, 5)) { add('crosswalk', cw, face, 0); crossings.push(cw); }
      } else if (node.stop) {
        const minor = l.rank < maxRank || L.every((o) => o.rank === maxRank);
        if (minor && l.inbound && !insideBuilding(pole[0], pole[1], bld) && !near('stop-sign', pole, 3)) add('stop-sign', pole, face, L.every((o) => o.rank === maxRank) ? 1 : 0);
      }
    }
  }

  // ---------- junction exclusion helper ----------
  const jGrid = new GridIndex<{ p: Vec2; r: number }>(30);
  for (const j of gr.junctions) {
    const onlyService = j.classes.every((c) => c === 'service') || (j.classes.includes('service') && j.maxRank <= 2 && j.classes.filter((c) => c !== 'service').length === 1);
    const r = onlyService ? 5.5 : 13;
    jGrid.insert({ p: j.p, r }, j.p[0] - r, j.p[1] - r, j.p[0] + r, j.p[1] + r);
  }
  const nearJunction = (p: Vec2, extra = 0) => { for (const j of jGrid.near(p[0], p[1], 14)) if (Math.hypot(j.p[0] - p[0], j.p[1] - p[1]) < j.r + extra) return true; return false; };
  // driveway joins: nodes where non-public service ways meet public roads
  const publicNodes = new Set<number>();
  for (const inf of infos) if (PUBLIC_STREET.has(inf.road.cls)) for (const n of inf.road.nodes) publicNodes.add(n);
  const drivewayPts: Vec2[] = [];
  for (const inf of infos) {
    if (inf.road.cls !== 'service' && inf.road.cls !== 'footway' && inf.road.cls !== 'path' && inf.road.cls !== 'cycleway') continue;
    const n = inf.road.nodes;
    for (const k of [0, n.length - 1]) if (publicNodes.has(n[k])) drivewayPts.push(inf.road.pts[k]);
  }
  const dwGrid = new GridIndex<Vec2>(20);
  for (const p of drivewayPts) dwGrid.insert(p, p[0], p[1], p[0], p[1]);
  const nearDriveway = (p: Vec2, r: number) => { for (const q of dwGrid.near(p[0], p[1], r)) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < r) return true; return false; };
  const nearList = (list: Vec2[], p: Vec2, r: number) => list.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < r);

  // ---------- rule-based along streets ----------
  for (const inf of infos) {
    const r = inf.road;
    if (!PUBLIC_STREET.has(r.cls) || r.cls === 'motorway' || r.tunnel) continue;
    const len = polylineLength(r.pts);
    if (len < 12) continue;
    const R = rng(hashString(r.id) ^ ctx.seed ^ 0x51ed);
    const dens = ctx.density(r.pts[Math.floor(r.pts.length / 2)][0], r.pts[Math.floor(r.pts.length / 2)][1]);
    const downtown = r.sidewalk >= 3;
    const off = (extra: number) => r.width / 2 + extra;
    const faceRoad = (side: number, dir: Vec2) => headingOf(side * dir[1], -side * dir[0]); // toward the centerline
    const place = (type: PropType, side: number, p: Vec2, dir: Vec2, variant: number, rotOverride?: number, clearR = 1.2) => {
      if (roads.onCarriageway(p[0], p[1], 0.25)) return false;
      if (insideBuilding(p[0], p[1], bld, 0.3)) return false;
      if (near(null, p, clearR)) return false;
      return add(type, p, rotOverride ?? faceRoad(side, dir), variant);
    };
    // Streetlights
    let mappedNear = 0;
    for (const q of lampsMapped) {
      const nr = roads.nearest(q[0], q[1], r.width / 2 + r.sidewalk + 5);
      if (nr && nr.info === inf) mappedNear++;
    }
    if (mappedNear < len / 90 && r.cls !== 'service') {
      const step = downtown ? 28 : r.cls === 'residential' ? 38 : 33;
      const both = downtown || CLASS_RANK[r.cls] >= 4;
      walk(r.pts, step, (p, i, dir) => {
        const sides = both ? [1, -1] : [i % 2 === 0 ? 1 : -1];
        for (const side of sides) {
          const o = r.sidewalk > 0 ? off(0.55) : off(1.0);
          const q: Vec2 = [p[0] - dir[1] * o * side, p[1] + dir[0] * o * side];
          if (nearList(lampsMapped, q, 12)) continue;
          if (near('streetlight', q, 10)) continue;
          place('streetlight', side, q, dir, downtown ? 1 : r.cls === 'residential' ? 2 : 0);
        }
      }, 6 + R() * 8);
    }
    // Hydrants
    if (dens > 0.015 && r.cls !== 'trunk') {
      walk(r.pts, 95, (p, i, dir) => {
        const side = (hashString(r.id) + i) % 2 ? 1 : -1;
        const q: Vec2 = [p[0] - dir[1] * off(0.6) * side, p[1] + dir[0] * off(0.6) * side];
        if (nearList(hydrantsMapped, q, 70)) return;
        if (near('hydrant', q, 60)) return;
        if (place('hydrant', side, q, dir, 0)) hydrantsMapped.push(q);
      }, 18 + R() * 20);
    }
    // Downtown trash cans, benches, parking meters, newspaper boxes
    if (downtown) {
      walk(r.pts, 42, (p, i, dir) => {
        const side = i % 2 ? 1 : -1;
        const q: Vec2 = [p[0] - dir[1] * off(0.75) * side, p[1] + dir[0] * off(0.75) * side];
        place('trash-can', side, q, dir, 0);
      }, 10 + R() * 10);
      walk(r.pts, 75, (p, i, dir) => {
        const side = i % 2 ? -1 : 1;
        const q: Vec2 = [p[0] - dir[1] * off(r.sidewalk - 0.7) * side, p[1] + dir[0] * off(r.sidewalk - 0.7) * side];
        place('bench', side, q, dir, 0, faceRoad(side, dir));
      }, 25 + R() * 20);
      if ((inf.parkL || inf.parkR) && CLASS_RANK[r.cls] >= 3 && dens > 0.4) walk(r.pts, 16, (p, i, dir) => {
        for (const side of [1, -1]) {
          if ((side === 1 && !inf.parkR) || (side === -1 && !inf.parkL)) continue;
          const q: Vec2 = [p[0] - dir[1] * off(0.45) * side, p[1] + dir[0] * off(0.45) * side];
          if (nearJunction(q)) continue;
          place('parking-meter', side, q, dir, 0, undefined, 0.8);
        }
      }, 9);
      if (R() < 0.5) walk(r.pts, 120, (p, i, dir) => {
        const side = i % 2 ? 1 : -1;
        const q: Vec2 = [p[0] - dir[1] * off(1.0) * side, p[1] + dir[0] * off(1.0) * side];
        place('newspaper-box', side, q, dir, i % 3);
      }, 20 + R() * 30);
    }
    // Utility poles on residential streets (one side), when not mapped
    if ((r.cls === 'residential' || r.cls === 'unclassified') && dens < 0.45 && dens > 0.01 && ctx.region !== 'northeast') {
      const side = hashString(r.id) % 2 ? 1 : -1;
      walk(r.pts, 38, (p, i, dir) => {
        const o = r.sidewalk > 0 ? off(r.sidewalk + 0.7) : off(1.5);
        const q: Vec2 = [p[0] - dir[1] * o * side, p[1] + dir[0] * o * side];
        if (nearList(polesMapped, q, 30)) return;
        place('utility-pole', side, q, dir, 0, headingOf(dir[0], dir[1]));
      }, 10 + R() * 15);
    }
  }

  // ---------- parked cars along curbs ----------
  const carGrid = new GridIndex<Vec2>(10);
  const carNear = (p: Vec2, r: number) => { for (const q of carGrid.near(p[0], p[1], r)) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < r) return true; return false; };
  for (const inf of infos) {
    const r = inf.road;
    if (!(inf.parkL || inf.parkR) || r.bridge || r.tunnel) continue;
    const dens = ctx.density(r.pts[0][0], r.pts[0][1]);
    const occ = r.sidewalk >= 3 ? 0.66 : dens > 0.2 ? 0.58 : 0.5;
    for (const side of [1, -1]) {
      if ((side === 1 && !inf.parkR) || (side === -1 && !inf.parkL)) continue;
      const o = r.width / 2 - 1.15;
      walk(r.pts, 6.3, (p, i, dir) => {
        const q: Vec2 = [p[0] - dir[1] * o * side, p[1] + dir[0] * o * side];
        const seed = hashString(`${r.id}:${side}:${i}`);
        const R = rng(seed);
        if (R() > occ) return;
        if (nearJunction(q, 1)) return;
        if (nearDriveway(q, 5)) return;
        if (nearList(crossings, q, 7) || nearList(busStops, q, 16)) return;
        if (near('hydrant', q, 4.5)) return;
        if (carNear(q, 5.4)) return;
        if (insideBuilding(q[0], q[1], bld, 1)) return;
        // stay off other roads' carriageways (e.g. near overlapping ways)
        if (roads.onCarriageway(q[0], q[1], -0.5, (x) => x !== inf && x.road.cls !== 'service')) return;
        const heading = headingOf(dir[0], dir[1]) + (side === -1 && !r.oneway ? Math.PI : 0) + (R() - 0.5) * 0.04;
        const along = (R() - 0.5) * 0.8;
        const qq: Vec2 = [q[0] + dir[0] * along, q[1] + dir[1] * along];
        add('parked-car', qq, heading, Math.floor(R() * 6));
        carGrid.insert(qq, qq[0], qq[1], qq[0], qq[1]);
      }, 8 + (hashString(r.id) % 5));
    }
  }

  // ---------- parking lots: stall rows ----------
  for (const a of areas) {
    if (a.kind !== 'parking') continue;
    const area = polyArea(a.poly);
    if (area < 120) continue;
    const box = orientedBox(a.poly);
    const u: Vec2 = [Math.cos(box.angle), Math.sin(box.angle)], v: Vec2 = [-u[1], u[0]];
    const R = rng(hashString(a.id) ^ ctx.seed);
    const occ = 0.35 + R() * 0.4;
    const module = 5.3 * 2 + 6.8;
    const nRowsMod = Math.max(1, Math.floor(box.wid / module + 0.35));
    const stall = 2.75;
    const nStalls = Math.floor(box.len / stall);
    for (let m = 0; m < nRowsMod; m++) {
      const v0 = -box.wid / 2 + m * module;
      const rows = [v0 + 2.65, v0 + 2.65 + 5.3 + 6.8];
      rows.forEach((vv, ri) => {
        if (vv > box.wid / 2 - 2.3) return;
        for (let s = 0; s < nStalls; s++) {
          const uu = -box.len / 2 + (s + 0.5) * stall + (box.len - nStalls * stall) / 2;
          const c: Vec2 = [box.cx + u[0] * uu + v[0] * vv, box.cz + u[1] * uu + v[1] * vv];
          const seed = hashString(`${a.id}:${m}:${ri}:${s}`);
          const q = rng(seed);
          if (q() > occ) continue;
          // all four corners inside
          let ok = true;
          for (const [du, dv] of [[-1, -2.5], [1, -2.5], [-1, 2.5], [1, 2.5]] as const) {
            const x = c[0] + u[0] * du + v[0] * dv, z = c[1] + u[1] * du + v[1] * dv;
            if (!pointInPoly(x, z, a.poly, a.holes)) { ok = false; break; }
          }
          if (!ok) continue;
          if (insideBuilding(c[0], c[1], bld, 1.2)) continue;
          if (roads.onCarriageway(c[0], c[1], 1.4)) continue;
          if (carNear(c, 2.5)) continue;
          const face = headingOf(v[0], v[1]) + (ri === 0 ? Math.PI : 0) + (q() < 0.15 ? Math.PI : 0) + (q() - 0.5) * 0.08;
          add('parked-car', c, face, Math.floor(q() * 6));
          carGrid.insert(c, c[0], c[1], c[0], c[1]);
        }
      });
    }
  }
  return { props, signalPoles, crossings };
}
