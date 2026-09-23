// OWNER: compiler agent. Trees: OSM trees/tree rows + seeded scatter (parks, forest, yards, street-tree rows).
import type { RecipeTree, RecipeArea, Vec2 } from '../core/types.ts';
import type { OsmData } from './osm.ts';
import { parseLength } from './osm.ts';
import { rng, hashString } from '../core/geo.ts';
import { bbox, pointInPoly, r2, GridIndex, polylineLength } from './geom.ts';
import { pickWeighted, type Species } from './region.ts';
import type { Ctx } from './context.ts';
import type { RoadIndex, RoadInfo } from './roads.ts';
import { insideBuilding, type BuildResult } from './buildings.ts';

const LEAF_SPECIES: Record<string, string> = { needleleaved: 'ponderosa-pine', broadleaved: '' };

export function buildTrees(data: OsmData, areas: RecipeArea[], infos: RoadInfo[], roads: RoadIndex, bld: BuildResult, ctx: Ctx): RecipeTree[] {
  const { bounds, heightAt, palette, proj } = ctx;
  const trees: RecipeTree[] = [];
  const grid = new GridIndex<number>(10);
  const inB = (p: Vec2) => p[0] > bounds.minX + 1 && p[0] < bounds.maxX - 1 && p[1] > bounds.minZ + 1 && p[1] < bounds.maxZ - 1;
  const tooClose = (p: Vec2, d: number) => {
    for (const i of grid.near(p[0], p[1], d)) { const q = trees[i].p; if ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < d * d) return true; }
    return false;
  };
  const water = areas.filter((a) => a.kind === 'water');
  const hardAreas = areas.filter((a) => a.kind === 'parking' || a.kind === 'pitch' || a.kind === 'plaza' || a.kind === 'pedestrian' || a.kind === 'water');
  const hardGrid = new GridIndex<number>(40);
  hardAreas.forEach((a, i) => { const b = bbox(a.poly); hardGrid.insert(i, b.minX, b.minZ, b.maxX, b.maxZ); });
  const inHard = (p: Vec2) => { for (const i of hardGrid.near(p[0], p[1], 0)) if (pointInPoly(p[0], p[1], hardAreas[i].poly, hardAreas[i].holes)) return true; return false; };

  const add = (p: Vec2, sp: Species, seed: number, heightOverride?: number, spacing = 3) => {
    if (!inB(p) || tooClose(p, spacing)) return false;
    const R = rng(seed);
    const h = heightOverride ?? sp.h[0] + (sp.h[1] - sp.h[0]) * (0.3 + 0.7 * R());
    const crown = Math.max(1.2, h * sp.crown * (0.85 + R() * 0.3));
    trees.push({ p: [r2(p[0]), r2(p[1])], y: r2(heightAt(p[0], p[1])), species: sp.name, height: r2(h), crown: r2(crown), seed: seed >>> 0 });
    grid.insert(trees.length - 1, p[0], p[1], p[0], p[1]);
    return true;
  };
  const clear = (p: Vec2, roadMargin: number, bMargin: number) =>
    !roads.onAnyRoad(p[0], p[1], roadMargin) && !insideBuilding(p[0], p[1], bld, bMargin) && !inHard(p);

  // 1) OSM mapped trees
  const R0 = rng(ctx.seed ^ 0x1234);
  for (const n of data.nodes.values()) {
    if (n.tags?.natural !== 'tree') continue;
    const p = proj.toLocal(n.lat, n.lon);
    const t = n.tags;
    let sp = pickWeighted(palette.street, R0());
    const g = (t.genus ?? '').toLowerCase(), s = (t.species ?? t['species:en'] ?? t.taxon ?? '').toLowerCase();
    const guess = speciesFromTags(g, s, t.leaf_type);
    if (guess) sp = { ...sp, name: guess };
    const h = parseLength(t.height);
    add(p, sp, n.id % 2147483647, h && h > 1 && h < 60 ? h : undefined, 1.5);
  }
  // 2) tree rows
  for (const w of data.ways.values()) {
    if (w.tags?.natural !== 'tree_row') continue;
    const pts: Vec2[] = [];
    for (const id of w.nodes) { const n = data.nodes.get(id); if (n) pts.push(proj.toLocal(n.lat, n.lon)); }
    const R = rng(w.id);
    const sp = pickWeighted(palette.street, R());
    walk(pts, 8, (p) => { add(p, sp, hashString(`${w.id}:${p[0].toFixed(1)}`), undefined, 4); });
  }
  // 3) street trees along residential / tertiary streets
  for (const inf of infos) {
    const r = inf.road;
    if (!(r.cls === 'residential' || r.cls === 'tertiary' || r.cls === 'secondary' || r.cls === 'unclassified' || r.cls === 'living_street')) continue;
    if (r.sidewalk <= 0 && r.cls !== 'living_street') continue;
    const R = rng(hashString(r.id) ^ ctx.seed);
    const streetSp = pickWeighted(palette.street, R());
    const dens = ctx.density(r.pts[0][0], r.pts[0][1]);
    const downtown = r.sidewalk >= 3;
    const spacing = downtown ? 11 : 12 + R() * 4;
    const occupancy = downtown ? 0.6 : r.cls === 'residential' ? 0.75 : 0.5;
    for (const side of [-1, 1]) {
      const off = downtown ? r.width / 2 + 0.9 : r.width / 2 + Math.min(r.sidewalk, 1.8) + 1.4 + (dens < 0.1 ? 1 : 0);
      walkOffset(r.pts, spacing, side * off, 8, (p, i) => {
        const seed = hashString(`${r.id}:${side}:${i}`);
        const q = rng(seed);
        if (q() > occupancy) return;
        const sp = q() < 0.75 ? streetSp : pickWeighted(palette.street, q());
        // tree lawns: don't sit on any road surface other than own sidewalk strip
        if (roads.onCarriageway(p[0], p[1], 0.8)) return;
        if (!downtown && roads.onAnyRoad(p[0], p[1], 0.2)) return;
        if (insideBuilding(p[0], p[1], bld, 2)) return;
        if (inHard(p)) return;
        add(p, sp, seed, undefined, 5);
      });
    }
  }
  // 3b) yard trees around detached houses (works even where landuse=residential isn't mapped)
  const yardPal = palette.street.concat(palette.park);
  for (const b of bld.buildings) {
    if (b.use !== 'residential-single' || b.kit === 'generic') continue;
    const c = b.footprint.reduce((a, p) => [a[0] + p[0] / b.footprint.length, a[1] + p[1] / b.footprint.length] as Vec2, [0, 0] as Vec2);
    if (ctx.density(c[0], c[1]) > 0.45) continue;
    const R = rng(b.seed ^ 0x7a2e);
    const n = R() < 0.35 ? 0 : R() < 0.6 ? 1 : 2;
    const rad = Math.sqrt(Math.max(40, Math.abs(b.footprint.reduce((s, p, i) => { const q = b.footprint[(i + 1) % b.footprint.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2))) / 2;
    for (let k = 0; k < n; k++) {
      const ang = R() * Math.PI * 2, d = rad + 3 + R() * 5;
      const p: Vec2 = [c[0] + Math.cos(ang) * d, c[1] + Math.sin(ang) * d];
      if (!clear(p, 2, 2)) continue;
      add(p, pickWeighted(yardPal, R()), hashString(`${b.id}:y${k}`), undefined, 5);
    }
  }
  // 4) area scatter: parks, forests, grass, cemetery, residential yards
  const cap = 30000;
  for (const a of areas) {
    const spec = a.kind === 'forest' ? { d: 45, pal: palette.forest, clump: 0.7 }
      : a.kind === 'park' ? { d: 170, pal: palette.park, clump: 0.5 }
      : a.kind === 'cemetery' ? { d: 220, pal: palette.park, clump: 0.3 }
      : a.kind === 'grass' ? { d: 450, pal: palette.park, clump: 0.5 }
      : a.kind === 'residential' ? { d: 260, pal: palette.street.concat(palette.park), clump: 0.2 }
      : null;
    if (!spec) continue;
    const bb = bbox(a.poly);
    const areaM = Math.abs((bb.maxX - bb.minX) * (bb.maxZ - bb.minZ));
    const R = rng(hashString(a.id) ^ ctx.seed);
    const n = Math.min(4000, Math.floor(areaM / spec.d));
    // clumps
    const centers: Vec2[] = [];
    for (let i = 0; i < Math.max(1, n / 12); i++) centers.push([bb.minX + R() * (bb.maxX - bb.minX), bb.minZ + R() * (bb.maxZ - bb.minZ)]);
    const baseSp = pickWeighted(spec.pal, R());
    for (let i = 0; i < n && trees.length < cap; i++) {
      let p: Vec2;
      if (R() < spec.clump) { const c = centers[Math.floor(R() * centers.length)]; const ang = R() * Math.PI * 2, rr = Math.sqrt(R()) * 22; p = [c[0] + Math.cos(ang) * rr, c[1] + Math.sin(ang) * rr]; }
      else p = [bb.minX + R() * (bb.maxX - bb.minX), bb.minZ + R() * (bb.maxZ - bb.minZ)];
      if (!pointInPoly(p[0], p[1], a.poly, a.holes)) continue;
      if (water.some((w) => pointInPoly(p[0], p[1], w.poly, w.holes)) && a.kind !== 'forest') continue;
      if (!clear(p, a.kind === 'residential' ? 2.5 : 1.2, a.kind === 'residential' ? 2.5 : 1.5)) continue;
      const sp = R() < 0.55 ? baseSp : pickWeighted(spec.pal, R());
      add(p, sp, hashString(`${a.id}:${i}`), undefined, a.kind === 'forest' ? 3.5 : 5);
    }
  }
  return trees;
}

function speciesFromTags(g: string, s: string, leaf?: string): string | null {
  const x = g + ' ' + s;
  if (/gleditsia|locust/.test(x)) return 'honey-locust';
  if (/fraxinus|ash/.test(x)) return 'green-ash';
  if (/populus|cottonwood|poplar/.test(x)) return 'cottonwood';
  if (/picea|spruce/.test(x)) return 'blue-spruce';
  if (/pinus|pine/.test(x)) return 'ponderosa-pine';
  if (/acer|maple/.test(x)) return /saccharinum|silver/.test(x) ? 'silver-maple' : 'red-maple';
  if (/tilia|linden|basswood/.test(x)) return 'linden';
  if (/malus|crab/.test(x)) return 'crabapple';
  if (/platanus|plane|sycamore/.test(x)) return 'london-plane';
  if (/quercus virginiana|live oak/.test(x)) return 'live-oak';
  if (/quercus|oak/.test(x)) return 'pin-oak';
  if (/ulmus|elm/.test(x)) return 'american-elm';
  if (/ginkgo/.test(x)) return 'ginkgo';
  if (/pyrus|pear/.test(x)) return 'callery-pear';
  if (/washingtonia|phoenix|palm|sabal/.test(x)) return 'washingtonia-palm';
  if (/lagerstroemia|crape/.test(x)) return 'crape-myrtle';
  if (/magnolia/.test(x)) return 'magnolia';
  if (/parkinsonia|palo/.test(x)) return 'palo-verde';
  if (/prosopis|mesquite/.test(x)) return 'mesquite';
  if (/eucalyptus/.test(x)) return 'eucalyptus';
  if (/celtis|hackberry/.test(x)) return 'hackberry';
  if (leaf === 'needleleaved') return LEAF_SPECIES.needleleaved;
  return null;
}

/** Call fn at every `step` meters along a polyline. */
export function walk(pts: Vec2[], step: number, fn: (p: Vec2, i: number, dir: Vec2) => void, startOffset = step / 2) {
  let dist = startOffset, k = 0;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const dir: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    while (dist <= acc + L) {
      const t = (dist - acc) / L;
      fn([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], k++, dir);
      dist += step;
    }
    acc += L;
  }
}

/** Walk at a lateral offset (positive = right side of travel direction, i.e. (−dz, dx)·−1 ...). endMargin skips near ends. */
export function walkOffset(pts: Vec2[], step: number, offset: number, endMargin: number, fn: (p: Vec2, i: number, dir: Vec2) => void) {
  const L = polylineLength(pts);
  walk(pts, step, (p, i, dir) => {
    // right-hand normal seen from above (north up): for dir (dx,dz), right = (−dz, dx)
    const q: Vec2 = [p[0] - dir[1] * offset, p[1] + dir[0] * offset];
    fn(q, i, dir);
  }, endMargin);
  void L;
}
