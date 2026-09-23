// OWNER: compiler agent. OSM highways → RecipeRoad[] + RoadGraph.
import type { RecipeRoad, RoadClass, RoadGraph, Vec2 } from '../core/types.ts';
import type { OsmData, Tags } from './osm.ts';
import { parseLength, parseNum } from './osm.ts';
import { clipPolylineRect, polylineLength, GridIndex, distToSeg } from './geom.ts';
import type { Ctx } from './context.ts';

export const DRIVABLE: ReadonlySet<RoadClass> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'unclassified']);
export const PUBLIC_STREET: ReadonlySet<RoadClass> = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'unclassified']);
export const ARTERIAL: ReadonlySet<RoadClass> = new Set(['motorway', 'trunk', 'primary', 'secondary']);
export const CLASS_RANK: Record<RoadClass, number> = {
  motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 1, service: 1,
  pedestrian: 0, footway: 0, cycleway: 0, path: 0, steps: 0,
};

export interface RoadInfo {
  road: RecipeRoad;
  tags: Tags;
  parkL: boolean; parkR: boolean;
  drivable: boolean; /** part of the traffic graph */
  service?: string;
  wayId: number;
}

const CLASS_MAP: Record<string, RoadClass> = {
  motorway: 'motorway', motorway_link: 'motorway', trunk: 'trunk', trunk_link: 'trunk', primary: 'primary', primary_link: 'primary',
  secondary: 'secondary', secondary_link: 'secondary', tertiary: 'tertiary', tertiary_link: 'tertiary', residential: 'residential',
  unclassified: 'unclassified', road: 'unclassified', living_street: 'living_street', service: 'service', busway: 'service', track: 'service',
  pedestrian: 'pedestrian', footway: 'footway', cycleway: 'cycleway', path: 'path', bridleway: 'path', steps: 'steps',
};

const DEFAULT_MPH: Partial<Record<RoadClass, number>> = {
  motorway: 65, trunk: 50, primary: 35, secondary: 30, tertiary: 30, residential: 25, unclassified: 25, living_street: 10, service: 12,
  pedestrian: 5, footway: 5, cycleway: 12, path: 8, steps: 3,
};

export function parseSpeed(v: string | undefined, cls: RoadClass): number {
  const mph = 0.44704;
  if (v) {
    const s = v.toLowerCase();
    const n = parseFloat(s);
    if (isFinite(n) && n > 0) return +(s.includes('mph') ? n * mph : s.includes('knots') ? n * 0.5144 : n / 3.6).toFixed(2);
    if (s === 'walk') return 1.5;
  }
  return +((DEFAULT_MPH[cls] ?? 25) * mph).toFixed(2);
}

function surfaceOf(t: Tags, cls: RoadClass): RecipeRoad['surface'] {
  const s = t.surface;
  if (s) {
    if (/^(asphalt|paved|chipseal)$/.test(s)) return 'asphalt';
    if (/concrete/.test(s)) return 'concrete';
    if (/^(bricks|brick|clay)$/.test(s)) return 'brick';
    if (/(paving_stones|sett|cobblestone|unhewn_cobblestone|stone|metal|wood)/.test(s)) return 'paving';
    if (/(gravel|unpaved|dirt|compacted|ground|fine_gravel|earth|grass|sand|pebblestone|mud|woodchips)/.test(s)) return 'gravel';
  }
  if (cls === 'pedestrian') return 'paving';
  if (cls === 'footway' || cls === 'steps') return 'concrete';
  if (cls === 'path') return 'gravel';
  if (t.highway === 'track') return 'gravel';
  return 'asphalt';
}

function defaultLanes(cls: RoadClass, oneway: boolean): number {
  const two: Partial<Record<RoadClass, number>> = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1 };
  const one: Partial<Record<RoadClass, number>> = { motorway: 2, trunk: 2, primary: 2, secondary: 2, tertiary: 1, residential: 1, unclassified: 1, living_street: 1, service: 1 };
  return (oneway ? one[cls] : two[cls]) ?? 1;
}

function laneWidth(cls: RoadClass): number {
  return cls === 'motorway' || cls === 'trunk' ? 3.65 : cls === 'primary' || cls === 'secondary' ? 3.4 : cls === 'tertiary' ? 3.25 : 3.05;
}

function parkingSide(t: Tags, side: 'left' | 'right'): boolean | undefined {
  const keys = [`parking:${side}`, 'parking:both', `parking:lane:${side}`, 'parking:lane:both'];
  for (const k of keys) {
    const v = t[k];
    if (!v) continue;
    if (/^(no|no_parking|no_stopping|separate|fire_lane|none)$/.test(v)) return false;
    if (/^(lane|parallel|half_on_kerb|on_kerb|diagonal|perpendicular|street_side|yes|marked)$/.test(v)) return true;
  }
  return undefined;
}

export function buildRoads(data: OsmData, ctx: Ctx) {
  const { proj, bounds, heightAt, density } = ctx;
  const infos: RoadInfo[] = [];
  let synth = -1;
  const skipHighway = /^(proposed|construction|platform|corridor|elevator|raceway|bus_stop|rest_area|services|abandoned|escape|emergency_bay|bus_guideway|via_ferrata|no)$/;

  for (const w of data.ways.values()) {
    const t = w.tags; if (!t?.highway) continue;
    if (skipHighway.test(t.highway)) continue;
    if (t.area === 'yes') continue;
    if (t.indoor === 'yes' || (t.level && parseFloat(t.level) < 0 && !t.tunnel)) continue;
    const cls = CLASS_MAP[t.highway]; if (!cls) continue;
    if (cls === 'footway' && (t.footway === 'sidewalk' || t.footway === 'crossing' || t.footway === 'traffic_island')) continue;
    if ((cls === 'path' || cls === 'cycleway') && (t.footway === 'sidewalk' || t.path === 'sidewalk' || t.cycleway === 'crossing' || t.footway === 'crossing')) continue;
    if (t.tunnel === 'culvert') continue;
    const raw: Vec2[] = []; const ids: number[] = [];
    for (const nid of w.nodes) { const n = data.nodes.get(nid); if (!n) continue; raw.push(proj.toLocal(n.lat, n.lon)); ids.push(nid); }
    if (raw.length < 2) continue;
    const pieces = clipPolylineRect(raw, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
    const onewayTag = t.oneway;
    const isRound = t.junction === 'roundabout' || t.junction === 'circular';
    let oneway = onewayTag === 'yes' || onewayTag === 'true' || onewayTag === '1' || onewayTag === '-1' || (isRound && onewayTag !== 'no') || (cls === 'motorway' && onewayTag !== 'no' && t.highway === 'motorway');
    const reverse = onewayTag === '-1';
    const drivableCls = DRIVABLE.has(cls);
    let lanes = parseNum(t.lanes) ?? defaultLanes(cls, oneway);
    lanes = Math.max(1, Math.min(8, Math.round(lanes)));
    const service = t.service;
    const accessNo = /^(private|no)$/.test(t.access ?? '') || /^(private|no)$/.test(t.motor_vehicle ?? '') || /^(private|no)$/.test(t.motorcar ?? '');
    const drivable = drivableCls && !accessNo && !/^(parking_aisle|driveway|drive-through|emergency_access)$/.test(service ?? '') && t.area !== 'yes';

    for (let pi = 0; pi < pieces.length; pi++) {
      const pc = pieces[pi];
      let pts = pc.pts; let nodes = pc.src.map((s) => (s >= 0 ? ids[s] : synth--));
      if (reverse) { pts = pts.slice().reverse(); nodes = nodes.slice().reverse(); }
      if (polylineLength(pts) < 1) continue;
      const mid = pts[Math.floor(pts.length / 2)];
      const dens = density(mid[0], mid[1]);
      // parking lanes
      let parkL = parkingSide(t, 'left'), parkR = parkingSide(t, 'right');
      const parkDefault = (cls === 'residential' || cls === 'unclassified' || cls === 'tertiary' || cls === 'living_street')
        ? dens > 0.04 : (cls === 'secondary' || cls === 'primary') ? dens > 0.3 && lanes <= 4 : false;
      if (parkL === undefined) parkL = parkDefault && !(oneway && lanes >= 3);
      if (parkR === undefined) parkR = parkDefault;
      if (!drivableCls) { parkL = false; parkR = false; }
      let width: number;
      const tagW = parseLength(t.width);
      if (!drivableCls) {
        width = tagW ?? (cls === 'pedestrian' ? 8 : cls === 'footway' ? 2 : cls === 'cycleway' ? 2.5 : cls === 'steps' ? 2.5 : 2);
        width = Math.max(1, Math.min(width, 30));
      } else {
        const base = cls === 'service' ? (oneway ? 3.4 : 5.2) * Math.max(1, lanes / (oneway ? 1 : 1)) : lanes * laneWidth(cls);
        width = base + (parkL ? 2.4 : 0) + (parkR ? 2.4 : 0);
        if (tagW && tagW > 2.5 && tagW < 50) width = tagW;
        if (cls === 'service' && service === 'alley') width = Math.min(width, 5);
      }
      // sidewalks
      let sidewalk = 0;
      const sw = t.sidewalk ?? t['sidewalk:both'] ?? (t['sidewalk:left'] || t['sidewalk:right'] ? 'one' : undefined);
      const swDefault = () => {
        if (!drivableCls) return 0;
        if (cls === 'motorway') return 0;
        if (cls === 'service') return 0;
        if (cls === 'trunk') return dens > 0.2 ? 2.5 : 0;
        if (cls === 'primary' || cls === 'secondary' || cls === 'tertiary') return dens > 0.33 ? 4.2 : dens > 0.18 ? 3.0 : dens > 0.03 ? 1.8 : 0;
        if (cls === 'living_street') return 0;
        return dens > 0.35 ? 3.2 : dens > 0.02 ? 1.6 : 0;
      };
      if (sw === 'no' || sw === 'none') sidewalk = 0;
      else if (sw) sidewalk = Math.max(swDefault(), drivableCls ? 1.6 : 0);
      else sidewalk = swDefault();
      const swW = parseLength(t['sidewalk:width'] ?? t['sidewalk:both:width']);
      if (swW && swW > 0.8 && swW < 10) sidewalk = swW;

      const bridge = !!t.bridge && t.bridge !== 'no';
      const tunnel = !!t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
      const ys = pts.map((p) => heightAt(p[0], p[1]));
      if ((bridge || tunnel) && pts.length >= 2) {
        const L = polylineLength(pts);
        const y0 = ys[0], y1 = ys[ys.length - 1];
        const layer = parseNum(t.layer) ?? (bridge ? 1 : -1);
        let acc = 0;
        for (let i = 0; i < pts.length; i++) {
          if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          const f = L > 0 ? acc / L : 0;
          const lin = y0 + (y1 - y0) * f;
          if (bridge) {
            const clear = layer >= 1 && L > 40 ? Math.min(5.5 * layer, L * 0.08) * Math.sin(Math.PI * f) : 0;
            ys[i] = Math.max(lin + clear, Math.min(ys[i] + 0.3, lin + 8));
          } else ys[i] = lin;
        }
      }
      const road: RecipeRoad = {
        id: pieces.length > 1 ? `w${w.id}-${pi}` : `w${w.id}`,
        cls, pts, ys, width: +width.toFixed(2), lanes, oneway, sidewalk: +sidewalk.toFixed(2),
        maxSpeed: parseSpeed(t.maxspeed, cls), surface: surfaceOf(t, cls), nodes,
      };
      if (bridge) road.bridge = true;
      if (tunnel) road.tunnel = true;
      if (t.name) road.name = t.name;
      infos.push({ road, tags: t, parkL: !!parkL, parkR: !!parkR, drivable, service, wayId: w.id });
    }
  }
  return infos;
}

export interface GraphResult {
  graph: RoadGraph;
  /** OSM node id → graph index */
  idx: Map<number, number>;
  /** node id → number of incident drivable way-ends (junction if ≥3) — counts all car roads incl. private/service */
  degree: Map<number, number>;
  /** positions of junction nodes (degree ≥ 3) for exclusion zones */
  junctions: { p: Vec2; id: number; signal: boolean; maxRank: number; classes: RoadClass[] }[];
}

export function buildGraph(infos: RoadInfo[], data: OsmData, ctx: Ctx): GraphResult {
  const degree = new Map<number, number>();
  const pos = new Map<number, Vec2>();
  const posY = new Map<number, number>();
  const classesAt = new Map<number, Set<RoadClass>>();
  for (const inf of infos) {
    if (!DRIVABLE.has(inf.road.cls)) continue;
    const n = inf.road.nodes;
    for (let i = 0; i < n.length; i++) {
      const inc = i === 0 || i === n.length - 1 ? 1 : 2;
      degree.set(n[i], (degree.get(n[i]) ?? 0) + inc);
      pos.set(n[i], inf.road.pts[i]); posY.set(n[i], inf.road.ys[i]);
      let s = classesAt.get(n[i]); if (!s) classesAt.set(n[i], (s = new Set())); s.add(inf.road.cls);
    }
  }
  const junctionIds = [...degree.entries()].filter(([, d]) => d >= 3).map(([id]) => id);
  const jGrid = new GridIndex<number>(40);
  for (const id of junctionIds) { const p = pos.get(id)!; jGrid.insert(id, p[0], p[1], p[0], p[1]); }
  const nearestJunction = (p: Vec2, r: number): number | null => {
    let best: number | null = null, bd = r;
    for (const id of jGrid.near(p[0], p[1], r)) { const q = pos.get(id)!; const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = id; } }
    return best;
  };
  const signalNodes = new Set<number>(), stopNodes = new Set<number>();
  for (const [id] of degree) {
    const nd = data.nodes.get(id);
    const hw = nd?.tags?.highway;
    const isSignal = hw === 'traffic_signals' && nd?.tags?.traffic_signals !== 'emergency';
    if (isSignal) {
      if ((degree.get(id) ?? 0) >= 3) signalNodes.add(id);
      else { const j = nearestJunction(pos.get(id)!, 28); if (j != null) signalNodes.add(j); else signalNodes.add(id); }
    } else if (hw === 'stop' || hw === 'give_way') {
      if (hw === 'give_way') continue;
      if ((degree.get(id) ?? 0) >= 3) stopNodes.add(id);
      else { const j = nearestJunction(pos.get(id)!, 18); if (j != null) stopNodes.add(j); }
    }
  }
  const graph: RoadGraph = { nodes: [], edges: [] };
  const idx = new Map<number, number>();
  const getNode = (id: number): number => {
    let i = idx.get(id);
    if (i === undefined) {
      i = graph.nodes.length; idx.set(id, i);
      const p = pos.get(id)!;
      const node: RoadGraph['nodes'][number] = { id: i, p: [p[0], p[1]], y: +(posY.get(id) ?? 0).toFixed(2) };
      if (signalNodes.has(id)) node.signal = true;
      if (stopNodes.has(id) && !signalNodes.has(id)) node.stop = true;
      graph.nodes.push(node);
    }
    return i;
  };
  for (const inf of infos) {
    if (!inf.drivable) continue;
    const r = inf.road, n = r.nodes;
    let last = 0; let acc = 0;
    for (let i = 1; i < n.length; i++) {
      acc += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
      const isGraph = i === n.length - 1 || (degree.get(n[i]) ?? 0) >= 3 || signalNodes.has(n[i]) || stopNodes.has(n[i]);
      if (!isGraph) continue;
      const a = getNode(n[last]), b = getNode(n[i]);
      if (a !== b && acc > 0.5) {
        const fl = parseNum(inf.tags['lanes:forward']), bl = parseNum(inf.tags['lanes:backward']);
        const len = +acc.toFixed(2);
        if (r.oneway) graph.edges.push({ from: a, to: b, roadId: r.id, length: len, lanes: r.lanes, speed: r.maxSpeed, cls: r.cls });
        else {
          const half = Math.max(1, Math.floor(r.lanes / 2));
          graph.edges.push({ from: a, to: b, roadId: r.id, length: len, lanes: fl ?? half, speed: r.maxSpeed, cls: r.cls });
          graph.edges.push({ from: b, to: a, roadId: r.id, length: len, lanes: bl ?? half, speed: r.maxSpeed, cls: r.cls });
        }
      }
      last = i; acc = 0;
    }
  }
  const junctions = junctionIds.map((id) => {
    const cl = [...(classesAt.get(id) ?? [])];
    return { p: pos.get(id)!, id, signal: signalNodes.has(id), maxRank: Math.max(...cl.map((c) => CLASS_RANK[c])), classes: cl };
  });
  return { graph, idx, degree, junctions };
}

/** Spatial index over road segments, for distance / on-road tests. */
export class RoadIndex {
  grid = new GridIndex<number>(24);
  segs: { a: Vec2; b: Vec2; info: RoadInfo; half: number; outer: number }[] = [];
  constructor(infos: RoadInfo[]) {
    for (const inf of infos) {
      const r = inf.road;
      const half = r.width / 2, outer = half + r.sidewalk;
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i];
        const k = this.segs.length;
        this.segs.push({ a, b, info: inf, half, outer });
        this.grid.insert(k, Math.min(a[0], b[0]) - outer, Math.min(a[1], b[1]) - outer, Math.max(a[0], b[0]) + outer, Math.max(a[1], b[1]) + outer);
      }
    }
  }
  /** True if p lies on a drivable carriageway (+margin). */
  onCarriageway(x: number, z: number, margin = 0, filter?: (i: RoadInfo) => boolean): boolean {
    for (const k of this.grid.near(x, z, 1)) {
      const s = this.segs[k];
      if (!DRIVABLE.has(s.info.road.cls) && s.info.road.cls !== 'pedestrian') continue;
      if (filter && !filter(s.info)) continue;
      if (distToSeg(x, z, s.a, s.b) < s.half + margin) return true;
    }
    return false;
  }
  /** True if p lies on any road surface incl. sidewalks / paths. */
  onAnyRoad(x: number, z: number, margin = 0): boolean {
    for (const k of this.grid.near(x, z, 1)) {
      const s = this.segs[k];
      const w = DRIVABLE.has(s.info.road.cls) ? s.outer : s.half;
      if (distToSeg(x, z, s.a, s.b) < w + margin) return true;
    }
    return false;
  }
  nearest(x: number, z: number, r: number, filter?: (i: RoadInfo) => boolean) {
    let best: { info: RoadInfo; d: number; seg: number } | null = null;
    for (const k of this.grid.query(x - r, z - r, x + r, z + r)) {
      const s = this.segs[k];
      if (filter && !filter(s.info)) continue;
      const d = distToSeg(x, z, s.a, s.b);
      if (d < r && (!best || d < best.d)) best = { info: s.info, d, seg: k };
    }
    return best;
  }
}
