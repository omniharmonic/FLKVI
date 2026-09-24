// OWNER: world (vegetation). Runtime understory: foundation plantings along building walls with a yard,
// shrub / grass / flower clusters in parks, and desert specimens (saguaro, ocotillo, yucca) in Southwest yards.
// Output is RecipeTree entries with understory species ids that trees.ts renders procedurally.
import type * as THREE from 'three';
import type { Recipe, RecipeTree } from '../core/types';
import { rng, hashString } from '../core/geo';
import { pointInPoly } from './util';
import type { RoadNetwork } from './roads';

interface Ctx {
  recipe: Recipe;
  groundAt: (x: number, z: number) => number;
  inBuilding: (x: number, z: number) => boolean;
  roads: RoadNetwork;
}

type Mix = [string, number, [number, number]][]; // species, weight, height range

function palettes(recipe: Recipe): { base: Mix; park: Mix; yard?: Mix } {
  const lat = recipe.origin.lat, lon = recipe.origin.lon;
  if (recipe.region === 'southwest') {
    const base: Mix = [['agave', 3, [0.8, 1.3]], ['shrub-desert', 3, [0.8, 1.5]], ['barrel-cactus', 1.2, [0.4, 0.9]], ['prickly-pear', 1.2, [0.8, 1.5]],
      ['yucca', 1.5, [1.2, 2.6]], ['grass', 1.5, [0.7, 1.2]], ['flowers', 0.4, [0.35, 0.5]]];
    return { base, park: [['shrub-desert', 3, [0.9, 1.6]], ['grass', 2, [0.7, 1.2]], ['agave', 1, [0.8, 1.2]], ['shrub-leafy', 1, [1.0, 1.8]]],
      yard: [['saguaro', 1, [3.5, 8]], ['ocotillo', 1.2, [2.5, 4.5]], ['yucca', 1, [1.8, 3]], ['prickly-pear', 0.8, [1, 1.6]]] };
  }
  if (lat < 27.5 && lon > -82) { // South Florida
    return { base: [['shrub-leafy', 4, [0.9, 2.0]], ['shrub-box', 2, [0.7, 1.2]], ['flowers', 1.5, [0.4, 0.6]], ['grass', 0.8, [0.6, 1.0]], ['agave', 0.4, [0.8, 1.1]], ['yucca', 0.3, [1.2, 2]]],
      park: [['shrub-leafy', 3, [1.2, 2.2]], ['flowers', 1, [0.4, 0.6]], ['grass', 1, [0.6, 1.0]]] };
  }
  if (recipe.climate === 'humid' || (recipe.region === 'southeast') || recipe.region === 'south-central') {
    return { base: [['shrub-leafy', 4, [0.9, 1.9]], ['shrub-box', 2.5, [0.6, 1.2]], ['flowers', 1.2, [0.35, 0.55]], ['grass', 1, [0.5, 0.9]], ['yucca', 0.2, [1, 1.8]]],
      park: [['shrub-leafy', 3, [1.2, 2.2]], ['shrub-box', 1, [0.8, 1.2]], ['flowers', 1, [0.4, 0.55]], ['grass', 1, [0.6, 1.0]]] };
  }
  if (recipe.region === 'mountain-west') {
    return { base: [['shrub-box', 2.5, [0.6, 1.2]], ['shrub-leafy', 2.5, [0.9, 1.7]], ['grass', 2, [0.6, 1.2]], ['flowers', 1.2, [0.35, 0.55]], ['yucca', 0.4, [0.8, 1.2]]],
      park: [['shrub-leafy', 2, [1.0, 2.0]], ['grass', 2, [0.7, 1.2]], ['shrub-box', 1, [0.8, 1.2]]] };
  }
  return { base: [['shrub-box', 3, [0.6, 1.2]], ['shrub-leafy', 3, [0.9, 1.8]], ['grass', 1.4, [0.6, 1.1]], ['flowers', 1.4, [0.35, 0.55]]],
    park: [['shrub-leafy', 3, [1.2, 2.2]], ['shrub-box', 1, [0.8, 1.2]], ['grass', 1, [0.6, 1.0]], ['flowers', 0.6, [0.4, 0.55]]] };
}

function pick(m: Mix, r: number) {
  const tot = m.reduce((s, e) => s + e[1], 0);
  let x = r * tot;
  for (const e of m) { x -= e[1]; if (x <= 0) return e; }
  return m[m.length - 1];
}

export function buildUnderstory(ctx: Ctx, existing: RecipeTree[]): RecipeTree[] {
  const { recipe, groundAt, inBuilding, roads } = ctx;
  const out: RecipeTree[] = [];
  const pal = palettes(recipe);
  const sp = recipe.spawn.p;
  const b = recipe.bounds;
  // spacing grid (existing trunks + new plants)
  const cell = 2;
  const occ = new Set<number>();
  const key = (x: number, z: number) => (Math.floor(x / cell) + 32768) * 65536 + (Math.floor(z / cell) + 32768);
  for (const t of existing) occ.add(key(t.p[0], t.p[1]));
  const hard = recipe.areas.filter((a) => a.kind === 'parking' || a.kind === 'plaza' || a.kind === 'pedestrian' || a.kind === 'water' || a.kind === 'pitch' || a.kind === 'commercial' || a.kind === 'industrial');
  const inHard = (x: number, z: number) => hard.some((a) => pointInPoly(x, z, a.poly));
  const ok = (x: number, z: number, clear = 0.5) => {
    if (x < b.minX + 2 || x > b.maxX - 2 || z < b.minZ + 2 || z > b.maxZ - 2) return false;
    if (Math.hypot(x - sp[0], z - sp[1]) < 6) return false;
    if (inBuilding(x, z)) return false;
    if (roads.inCorridor(x, z, clear)) return false;
    if (roads.surfaceAt(x, z)) return false;
    return !inHard(x, z);
  };
  const add = (x: number, z: number, e: [string, number, [number, number]], R: () => number, seed: number, force = false) => {
    const k = key(x, z);
    if (!force && occ.has(k)) return false;
    occ.add(k);
    const h = e[2][0] + (e[2][1] - e[2][0]) * R();
    out.push({ p: [Math.round(x * 100) / 100, Math.round(z * 100) / 100], y: groundAt(x, z), species: e[0], height: h, crown: h, seed: seed >>> 0 });
    return true;
  };
  const CAP = 4500;

  // 1) foundation plantings along building walls that have some yard in front
  const plantUses = new Set(['residential-single', 'residential-multi', 'civic', 'school', 'religious', 'hospital', 'office']);
  for (const bl of recipe.buildings) {
    if (out.length > CAP) break;
    if (!plantUses.has(bl.use) || bl.storefront || bl.minHeight) continue;
    const R = rng(bl.seed ^ 0x51a7);
    if (R() < 0.3) continue;
    const fp = bl.footprint;
    const n = fp.length;
    const run = pick(pal.base, R()); // each building has a dominant plant + accents
    for (let i = 0; i < n; i++) {
      const a = fp[i], c = fp[(i + 1) % n];
      const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
      if (L < 3) continue;
      if (R() < 0.35) continue;
      let nx = dz / L, nz = -dx / L;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      if (inBuilding(mx + nx * 0.4, mz + nz * 0.4)) { nx = -nx; nz = -nz; }
      const step = 1.3 + R() * 0.9;
      const off = 0.75 + R() * 0.4;
      // need yard: 3 m out must also be clear of the road corridor
      if (!ok(mx + nx * 3, mz + nz * 3, 0.3)) continue;
      for (let s = 0.9; s < L - 0.6; s += step) {
        const x = a[0] + dx / L * s + nx * off, z = a[1] + dz / L * s + nz * off;
        if (!ok(x, z)) continue;
        const e = R() < 0.72 ? run : pick(pal.base, R());
        add(x, z, e, R, hashString(`${bl.id}:${i}:${s.toFixed(1)}`));
      }
    }
    // Southwest yard specimens
    if (pal.yard && bl.use === 'residential-single' && R() < 0.55) {
      let cx = 0, cz = 0; for (const p of fp) { cx += p[0] / n; cz += p[1] / n; }
      const rad = Math.sqrt(Math.max(40, Math.abs(fp.reduce((s, p, i) => { const q = fp[(i + 1) % n]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2))) / 2;
      const k = 1 + Math.floor(R() * 2);
      for (let j = 0; j < k; j++) {
        const ang = R() * Math.PI * 2, d = rad + 3 + R() * 4;
        const x = cx + Math.cos(ang) * d, z = cz + Math.sin(ang) * d;
        if (ok(x, z, 0.8)) add(x, z, pick(pal.yard, R()), R, hashString(`${bl.id}:yd${j}`));
      }
    }
  }

  // 2) park / lawn clusters
  for (const a of recipe.areas) {
    if (out.length > CAP) break;
    if (!(a.kind === 'park' || a.kind === 'grass' || a.kind === 'cemetery' || a.kind === 'playground')) continue;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of a.poly) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    const area = (maxX - minX) * (maxZ - minZ);
    const R = rng(hashString(a.id) ^ 0x77e1);
    const clusters = Math.min(40, Math.floor(area / (a.kind === 'grass' ? 900 : 450)));
    for (let c = 0; c < clusters; c++) {
      const cx = minX + R() * (maxX - minX), cz = minZ + R() * (maxZ - minZ);
      if (!pointInPoly(cx, cz, a.poly)) continue;
      const dom = pick(pal.park, R());
      const k = 3 + Math.floor(R() * 6);
      for (let j = 0; j < k; j++) {
        const ang = R() * Math.PI * 2, r = Math.sqrt(R()) * 3.2;
        const x = cx + Math.cos(ang) * r, z = cz + Math.sin(ang) * r;
        if (!pointInPoly(x, z, a.poly) || !ok(x, z, 1)) continue;
        add(x, z, R() < 0.7 ? dom : pick(pal.park, R()), R, hashString(`${a.id}:${c}:${j}`));
      }
    }
  }
  const cnt: Record<string, number> = {};
  for (const t of out) cnt[t.species] = (cnt[t.species] ?? 0) + 1;
  console.info(`[veg] understory ${out.length}: ${JSON.stringify(cnt)}`);
  return out;
}


/**
 * Carve soil / mulch planting beds under understory plants into the terrain land-cover masks
 * (bare channel on, hardscape off), so shrubs sit in beds instead of growing out of paving.
 */
export function paintPlantingBeds(mask: { tex: THREE.Texture; hard: THREE.Texture; origin: THREE.Vector2; size: THREE.Vector2 }, plants: RecipeTree[]) {
  const c = mask.tex.image as HTMLCanvasElement, hc = mask.hard.image as HTMLCanvasElement;
  if (!c?.getContext || !hc?.getContext) return;
  const res = mask.size.x / c.width;
  const ctx = c.getContext('2d')!, hx = hc.getContext('2d')!;
  // load time: beds are drawn sharp into scratch layers, then composited with ONE blur pass each
  // (a ctx.filter active while drawing runs a blur pass per circle: thousands of GPU passes)
  if ((typeof location !== 'undefined' && location.search.includes('legacyload'))) {
    ctx.save(); hx.save();
    ctx.filter = 'blur(1px)'; hx.filter = 'blur(1px)';
    ctx.globalCompositeOperation = 'lighten';
    ctx.fillStyle = 'rgb(0,235,0)'; hx.fillStyle = '#000';
    for (const t of plants) {
      if (t.species === 'saguaro' || t.species === 'ocotillo') continue;
      const r = Math.max(0.45, Math.min(1.5, t.height * 0.55 + 0.3)) / res;
      const x = (t.p[0] - mask.origin.x) / res, y = (t.p[1] - mask.origin.y) / res;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      hx.beginPath(); hx.arc(x, y, r * 1.1, 0, Math.PI * 2); hx.fill();
    }
    ctx.restore(); hx.restore();
    mask.tex.needsUpdate = true; mask.hard.needsUpdate = true;
    return;
  }
  const layer = () => { const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; return t; };
  const bed = layer(), apron = layer();
  const bx = bed.getContext('2d')!, ax = apron.getContext('2d')!;
  bx.fillStyle = 'rgb(0,235,0)'; ax.fillStyle = '#000';
  for (const t of plants) {
    if (t.species === 'saguaro' || t.species === 'ocotillo') continue;
    const r = Math.max(0.45, Math.min(1.5, t.height * 0.55 + 0.3)) / res;
    const x = (t.p[0] - mask.origin.x) / res, y = (t.p[1] - mask.origin.y) / res;
    bx.moveTo(x + r, y); bx.arc(x, y, r, 0, Math.PI * 2);
    ax.moveTo(x + r * 1.1, y); ax.arc(x, y, r * 1.1, 0, Math.PI * 2);
  }
  bx.fill(); ax.fill();
  ctx.save(); hx.save();
  ctx.filter = 'blur(1px)'; hx.filter = 'blur(1px)';
  ctx.globalCompositeOperation = 'lighten';
  ctx.drawImage(bed, 0, 0);
  hx.drawImage(apron, 0, 0);
  ctx.restore(); hx.restore();
  bed.width = bed.height = apron.width = apron.height = 0;
  mask.tex.needsUpdate = true; mask.hard.needsUpdate = true;
}
