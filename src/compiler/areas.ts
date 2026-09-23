// OWNER: compiler agent. Land cover polygons: parks, grass, forest, water (incl. buffered waterways), parking, plazas, landuse.
import type { RecipeArea, AreaKind, Vec2 } from '../core/types.ts';
import type { OsmData, Tags } from './osm.ts';
import { multipolygonRings, parseLength } from './osm.ts';
import { cleanRing, clipRingRect, makeCCW, makeCW, polyArea, bufferPolyline, clipPolylineRect, r2, pointInRing } from './geom.ts';
import type { Ctx } from './context.ts';

export function areaKind(t: Tags): AreaKind | null {
  if (t.building) return null;
  const n = t.natural, l = t.landuse, le = t.leisure, a = t.amenity;
  if (n === 'water' || l === 'reservoir' || l === 'basin' || t.waterway === 'riverbank' || t.waterway === 'dock' || le === 'swimming_pool' || t.water) return 'water';
  if (a === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey' && t.parking !== 'rooftop') return 'parking';
  if (t.highway === 'pedestrian' || t['area:highway'] === 'pedestrian' || t['area:highway'] === 'footway') return 'pedestrian';
  if (t.place === 'square' || (t.highway === 'footway' && t.area === 'yes')) return 'plaza';
  if (le === 'playground') return 'playground';
  if (le === 'pitch' || le === 'track') return 'pitch';
  if (le === 'park' || le === 'garden' || le === 'recreation_ground' || le === 'dog_park' || le === 'common' || le === 'golf_course' || le === 'nature_reserve') return 'park';
  if (l === 'forest' || n === 'wood') return 'forest';
  if (n === 'scrub' || n === 'heath' || n === 'grassland' || l === 'grass' || l === 'meadow' || l === 'village_green' || l === 'recreation_ground' || n === 'wetland' || l === 'flowerbed') return 'grass';
  if (n === 'sand' || n === 'beach' || n === 'bare_rock' || n === 'scree') return 'sand';
  if (l === 'farmland' || l === 'orchard' || l === 'vineyard' || l === 'allotments' || l === 'farmyard') return 'farmland';
  if (l === 'cemetery' || a === 'grave_yard') return 'cemetery';
  if (l === 'residential') return 'residential';
  if (l === 'commercial' || l === 'retail') return 'commercial';
  if (l === 'industrial' || l === 'railway' || l === 'construction' || l === 'brownfield') return 'industrial';
  if (a === 'school' || a === 'university' || a === 'college') return 'grass';
  return null;
}

export function buildAreas(data: OsmData, ctx: Ctx): RecipeArea[] {
  const { proj, bounds } = ctx;
  const out: RecipeArea[] = [];
  const toLocal = (ids: number[]): Vec2[] | null => {
    const pts: Vec2[] = [];
    for (const id of ids) { const n = data.nodes.get(id); if (!n) return null; pts.push(proj.toLocal(n.lat, n.lon)); }
    return pts;
  };
  const push = (id: string, kind: AreaKind, outer: Vec2[], inners: Vec2[][]) => {
    let o = clipRingRect(cleanRing(outer), bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ);
    if (o.length < 3 || polyArea(o) < 4) return;
    o = makeCCW(o);
    const holes: Vec2[][] = [];
    for (const h of inners) { const c = clipRingRect(cleanRing(h), bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ); if (c.length >= 3 && polyArea(c) > 2) holes.push(makeCW(c)); }
    const a: RecipeArea = { id, kind, poly: o.map((p) => [r2(p[0]), r2(p[1])] as Vec2) };
    if (holes.length) a.holes = holes.map((h) => h.map((p) => [r2(p[0]), r2(p[1])] as Vec2));
    out.push(a);
  };
  for (const w of data.ways.values()) {
    const t = w.tags; if (!t) continue;
    if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    if (t.highway && t.highway !== 'pedestrian' && !(t.highway === 'footway' && t.area === 'yes')) { if (!t['area:highway']) continue; }
    if (t.highway === 'pedestrian' && t.area !== 'yes' && !t['area:highway']) continue; // linear pedestrian street handled as road
    const k = areaKind(t); if (!k) continue;
    const pts = toLocal(w.nodes); if (!pts) continue;
    push(`w${w.id}`, k, pts, []);
  }
  for (const r of data.rels.values()) {
    const t = r.tags; if (!t || t.type !== 'multipolygon') continue;
    const k = areaKind(t); if (!k) continue;
    const { outers, inners } = multipolygonRings(r, data);
    const innerPts = inners.map(toLocal).filter((x): x is Vec2[] => !!x);
    outers.forEach((o, i) => {
      const pts = toLocal(o); if (!pts) return;
      push(`r${r.id}-${i}`, k, pts, innerPts.filter((h) => pointInRing(h[0][0], h[0][1], pts)));
    });
  }
  // waterways as buffered polygons (skip culverts / tunnels)
  const waterAreas = out.filter((a) => a.kind === 'water');
  for (const w of data.ways.values()) {
    const t = w.tags; if (!t?.waterway) continue;
    if (!/^(river|stream|canal|ditch|drain|brook|tidal_channel)$/.test(t.waterway)) continue;
    if (t.tunnel || t.intermittent === 'yes' && t.waterway !== 'river' && t.waterway !== 'stream') continue;
    if (t.tunnel) continue;
    const pts = toLocal(w.nodes); if (!pts || pts.length < 2) continue;
    const width = parseLength(t.width) ?? (t.waterway === 'river' ? 18 : t.waterway === 'canal' ? 9 : t.waterway === 'stream' ? 6 : 2.5);
    for (const [pi, pc] of clipPolylineRect(pts, bounds.minX - 5, bounds.minZ - 5, bounds.maxX + 5, bounds.maxZ + 5).entries()) {
      // skip if mostly inside a mapped water area already
      const mid = pc.pts[Math.floor(pc.pts.length / 2)];
      if (waterAreas.some((a) => pointInRing(mid[0], mid[1], a.poly)) && width > 8) continue;
      const poly = bufferPolyline(pc.pts, width / 2);
      if (poly.length < 3) continue;
      push(`ww${w.id}-${pi}`, 'water', poly, []);
    }
  }
  // order: big landuse first so specific covers draw on top
  const order: AreaKind[] = ['residential', 'commercial', 'industrial', 'farmland', 'cemetery', 'forest', 'grass', 'park', 'sand', 'pitch', 'playground', 'parking', 'plaza', 'pedestrian', 'water'];
  out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return out;
}
