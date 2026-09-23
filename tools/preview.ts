// Render a top-down PNG preview of a baked recipe + print sanity stats.
// Usage: node --experimental-strip-types tools/preview.ts boulder [scale]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unpackRecipe } from '../src/compiler/compile.ts';
import { encodePNG } from './png.ts';
import type { Recipe, Vec2 } from '../src/core/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2] ?? 'boulder';
const scale = +(process.argv[3] ?? 1.2);
const outDir = process.env.OUT ?? join(root, 'node_modules', '.cache', 'groundtruth', 'preview');
mkdirSync(outDir, { recursive: true });
const raw = readFileSync(join(root, 'public', 'recipes', `${id}.json`), 'utf8');
const r: Recipe = unpackRecipe(JSON.parse(raw));

// ---------------- sanity ----------------
const issues: string[] = [];
const chk = (v: unknown, where: string) => { if (typeof v !== 'number' || !isFinite(v)) issues.push(`NaN/invalid at ${where}`); };
r.roads.forEach((x) => { x.pts.forEach((p, i) => { chk(p[0], x.id); chk(p[1], x.id); chk(x.ys[i], x.id + ' y'); }); if (x.pts.length !== x.ys.length || x.pts.length !== x.nodes.length) issues.push(`road ${x.id} length mismatch`); });
r.buildings.forEach((b) => { b.footprint.forEach((p) => { chk(p[0], b.id); chk(p[1], b.id); }); chk(b.height, b.id + ' h'); chk(b.baseY, b.id + ' base'); chk(b.roofHeight, b.id + ' roofH'); });
r.graph.nodes.forEach((n, i) => { if (n.id !== i) issues.push(`graph node ${i} id ${n.id}`); });
r.graph.edges.forEach((e) => { if (!r.graph.nodes[e.from] || !r.graph.nodes[e.to]) issues.push('edge oob'); chk(e.length, 'edge'); });
r.trees.forEach((t) => { chk(t.p[0], 'tree'); chk(t.y, 'tree y'); });
r.props.forEach((p) => { chk(p.p[0], 'prop'); chk(p.y, 'prop y'); chk(p.rot, 'prop rot'); });
r.cameras.forEach((c) => { chk(c.p[0], c.id); chk(c.y, c.id); chk(c.heading, c.id); });
for (const h of r.terrain.heights) if (!isFinite(h)) { issues.push('terrain NaN'); break; }
const hs = r.buildings.map((b) => b.height + b.roofHeight).sort((a, b) => a - b);
const q = (f: number) => hs[Math.floor(f * (hs.length - 1))]?.toFixed(1);
const count = <T,>(a: T[], k: (x: T) => string) => { const m: Record<string, number> = {}; for (const x of a) m[k(x)] = (m[k(x)] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '); };
const th = r.terrain.heights; let tmin = Infinity, tmax = -Infinity; for (const h of th) { if (h < tmin) tmin = h; if (h > tmax) tmax = h; }
let fmin = Infinity, fmax = -Infinity; if (r.farTerrain) for (const h of r.farTerrain.heights) { if (h < fmin) fmin = h; if (h > fmax) fmax = h; }
const km2 = ((r.bounds.maxX - r.bounds.minX) * (r.bounds.maxZ - r.bounds.minZ)) / 1e6;
console.log(`# ${r.name}  region=${r.region} climate=${r.climate} elevation=${r.elevation} size=${(raw.length / 1e6).toFixed(2)}MB`);
console.log(`terrain ${r.terrain.cols}x${r.terrain.rows}@${r.terrain.cellSize}m range ${tmin.toFixed(1)}..${tmax.toFixed(1)}; far ${r.farTerrain?.cols}x${r.farTerrain?.rows}@${r.farTerrain?.cellSize}m range ${fmin.toFixed(0)}..${fmax.toFixed(0)}`);
console.log(`roads ${r.roads.length} [${count(r.roads, (x) => x.cls)}]`);
console.log(`graph nodes ${r.graph.nodes.length} edges ${r.graph.edges.length} signals ${r.graph.nodes.filter((n) => n.signal).length} stops ${r.graph.nodes.filter((n) => n.stop).length}`);
console.log(`buildings ${r.buildings.length}; height p10/50/90/max ${q(0.1)}/${q(0.5)}/${q(0.9)}/${q(1)}; storefronts ${r.buildings.filter((b) => b.storefront).length}; sensitive ${r.buildings.filter((b) => b.sensitive).length}`);
console.log(`  use [${count(r.buildings, (b) => b.use)}]`);
console.log(`  kit [${count(r.buildings, (b) => b.kit)}]`);
console.log(`  era [${count(r.buildings, (b) => b.era)}]  roof [${count(r.buildings, (b) => b.roof.type)}]`);
console.log(`  material [${count(r.buildings, (b) => b.material)}]`);
console.log(`  signage [${count(r.buildings.filter((b) => b.signage), (b) => b.signage!)}]`);
console.log(`areas ${r.areas.length} [${count(r.areas, (a) => a.kind)}]`);
console.log(`trees ${r.trees.length} [${count(r.trees, (t) => t.species)}]`);
console.log(`props ${r.props.length} [${count(r.props, (p) => p.type)}]`);
console.log(`cameras ${r.cameras.length} (${(r.cameras.length / km2).toFixed(1)}/km²) [${count(r.cameras, (c) => c.type)}] mapped ${r.cameras.filter((c) => c.mapped).length}`);
let minCam = Infinity; for (const a of r.cameras) for (const b of r.cameras) if (a !== b) minCam = Math.min(minCam, Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]));
const spawnCam = Math.min(...r.cameras.map((c) => Math.hypot(c.p[0] - r.spawn.p[0], c.p[1] - r.spawn.p[1])));
console.log(`min camera spacing ${minCam.toFixed(1)} m; spawn ${JSON.stringify(r.spawn)} nearest cam ${spawnCam.toFixed(1)} m`);
console.log(issues.length ? `ISSUES (${issues.length}): ${issues.slice(0, 10).join('; ')}` : 'no NaN / index issues');

// ---------------- raster ----------------
if (process.env.CROP) { const [a, b, c, d] = process.env.CROP.split(',').map(Number); r.bounds = { minX: a, minZ: b, maxX: c, maxZ: d }; }
const W = Math.round((r.bounds.maxX - r.bounds.minX) * scale), H = Math.round((r.bounds.maxZ - r.bounds.minZ) * scale);
const img = new Uint8Array(W * H * 3);
const X = (x: number) => (x - r.bounds.minX) * scale, Z = (z: number) => (z - r.bounds.minZ) * scale;
const hex = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function blend(i: number, c: [number, number, number], a: number) { img[i] = img[i] * (1 - a) + c[0] * a; img[i + 1] = img[i + 1] * (1 - a) + c[1] * a; img[i + 2] = img[i + 2] * (1 - a) + c[2] * a; }
function fillPoly(rings: Vec2[][], c: [number, number, number], a = 1) {
  let minY = Infinity, maxY = -Infinity;
  const rs = rings.map((ring) => ring.map((p) => [X(p[0]), Z(p[1])] as Vec2));
  for (const ring of rs) for (const p of ring) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
    const yc = y + 0.5; const xs: number[] = [];
    for (const ring of rs) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      if ((y1 > yc) !== (y2 > yc)) xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.round(xs[k])); x < Math.min(W, Math.round(xs[k + 1])); x++) blend((y * W + x) * 3, c, a);
  }
}
function thickLine(pts: Vec2[], w: number, c: [number, number, number], a = 1) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const L = Math.hypot(bx - ax, bz - az) || 1; const nx = (-(bz - az) / L) * w / 2, nz = ((bx - ax) / L) * w / 2;
    fillPoly([[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]], c, a);
    disc(bx, bz, w / 2, c, a);
  }
  if (pts.length) disc(pts[0][0], pts[0][1], w / 2, c, a);
}
function disc(x: number, z: number, rad: number, c: [number, number, number], a = 1) {
  const cx = X(x), cz = Z(z), rr = Math.max(0.7, rad * scale);
  for (let y = Math.floor(cz - rr); y <= Math.ceil(cz + rr); y++) for (let xx = Math.floor(cx - rr); xx <= Math.ceil(cx + rr); xx++) {
    if (xx < 0 || y < 0 || xx >= W || y >= H) continue;
    if ((xx + 0.5 - cx) ** 2 + (y + 0.5 - cz) ** 2 <= rr * rr) blend((y * W + xx) * 3, c, a);
  }
}
// terrain hillshade
const T = r.terrain;
const hAt = (x: number, z: number) => { const c = Math.min(T.cols - 2, Math.max(0, Math.floor((x - T.originX) / T.cellSize))), rr = Math.min(T.rows - 2, Math.max(0, Math.floor((z - T.originZ) / T.cellSize))); return T.heights[rr * T.cols + c]; };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const wx = r.bounds.minX + x / scale, wz = r.bounds.minZ + y / scale;
  const dzx = hAt(wx + 3, wz) - hAt(wx - 3, wz), dzz = hAt(wx, wz + 3) - hAt(wx, wz - 3);
  const shade = Math.max(0, Math.min(1, 0.75 - dzx * 0.05 + dzz * 0.05));
  const h01 = (hAt(wx, wz) - tmin) / Math.max(1, tmax - tmin);
  const i = (y * W + x) * 3;
  img[i] = (200 + 30 * h01) * shade; img[i + 1] = (205 + 10 * h01) * shade; img[i + 2] = (185 - 20 * h01) * shade;
}
const AREA_COL: Record<string, string> = { park: '#9cc58a', grass: '#b5d69a', forest: '#6f9f5f', water: '#6fa6d6', parking: '#b9b6b0', pedestrian: '#e0d6c4', plaza: '#e3d9c6', sand: '#e6d6a8', farmland: '#d7d49a', residential: '#dcd8cf', commercial: '#e3d3d3', industrial: '#d6cfdf', playground: '#c7e0a8', pitch: '#8fc47a', cemetery: '#a9c49a' };
for (const a of r.areas) fillPoly([a.poly, ...(a.holes ?? [])], hex(AREA_COL[a.kind] ?? '#cccccc'), a.kind === 'residential' || a.kind === 'commercial' || a.kind === 'industrial' ? 0.5 : 0.9);
const DRIV = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'living_street', 'unclassified']);
for (const rd of r.roads) if (DRIV.has(rd.cls) && rd.sidewalk > 0) thickLine(rd.pts, rd.width + rd.sidewalk * 2, [236, 233, 226]);
for (const rd of r.roads) if (!DRIV.has(rd.cls)) thickLine(rd.pts, rd.width, rd.cls === 'pedestrian' ? [240, 226, 200] : [214, 196, 160]);
for (const rd of r.roads) if (DRIV.has(rd.cls)) thickLine(rd.pts, rd.width, rd.cls === 'primary' || rd.cls === 'secondary' || rd.cls === 'trunk' ? [70, 70, 76] : rd.cls === 'service' ? [120, 120, 122] : [92, 92, 96]);
for (const rd of r.roads) if (rd.bridge) thickLine(rd.pts, 1, [255, 140, 0]);
for (const b of r.buildings) {
  fillPoly([b.footprint, ...(b.holes ?? [])], hex(b.color));
  const outline = b.storefront ? [255, 200, 0] as [number, number, number] : [40, 40, 40] as [number, number, number];
  const f = b.footprint;
  for (let i = 0; i < f.length; i++) { const a = f[i], c = f[(i + 1) % f.length]; thickLine([a, c], b.streetEdges.includes(i) ? 0.9 : 0.35, b.streetEdges.includes(i) ? [230, 40, 200] : outline); }
}
for (const t of r.trees) disc(t.p[0], t.p[1], t.crown / 2, [46, 110, 40], 0.7);
const PROP_COL: Record<string, [number, number, number]> = { streetlight: [255, 230, 80], 'traffic-signal': [255, 0, 0], 'stop-sign': [200, 0, 0], hydrant: [255, 60, 60], 'parked-car': [40, 60, 150], crosswalk: [255, 255, 255], 'utility-pole': [120, 80, 40], 'trash-can': [30, 30, 30], bench: [140, 90, 50] };
for (const p of r.props) {
  if (p.line) { thickLine(p.line, 0.4, p.type === 'hedge' ? [40, 90, 30] : [110, 100, 90]); continue; }
  const c = PROP_COL[p.type] ?? [0, 160, 160];
  if (p.type === 'parked-car') { const fx = Math.sin(p.rot), fz = -Math.cos(p.rot); thickLine([[p.p[0] - fx * 2.2, p.p[1] - fz * 2.2], [p.p[0] + fx * 2.2, p.p[1] + fz * 2.2]], 1.8, c); }
  else if (p.type === 'crosswalk') { const fx = Math.sin(p.rot), fz = -Math.cos(p.rot); thickLine([[p.p[0] + fz * 5, p.p[1] - fx * 5], [p.p[0] - fz * 5, p.p[1] + fx * 5]], 2.5, c, 0.8); }
  else disc(p.p[0], p.p[1], 0.6, c);
}
for (const cam of r.cameras) {
  const col: [number, number, number] = cam.type === 'pole' ? [230, 20, 20] : cam.type === 'ptz' ? [255, 120, 0] : cam.type === 'cluster' ? [170, 0, 200] : [0, 0, 0];
  if (cam.type !== 'tower') {
    const half = (cam.fovDeg / 2) * Math.PI / 180;
    for (const d of [-half, 0, half]) { const h = cam.heading + d; thickLine([cam.p, [cam.p[0] + Math.sin(h) * cam.rangeM * 0.5, cam.p[1] - Math.cos(h) * cam.rangeM * 0.5]], d === 0 ? 0.8 : 0.4, col, 0.7); }
  } else disc(cam.p[0], cam.p[1], cam.rangeM * 0.5, col, 0.12);
  disc(cam.p[0], cam.p[1], 3, col);
  if (!cam.mapped) disc(cam.p[0], cam.p[1], 1.2, [255, 255, 255]);
}
disc(r.spawn.p[0], r.spawn.p[1], 5, [0, 90, 255]);
thickLine([r.spawn.p, [r.spawn.p[0] + Math.sin(r.spawn.heading) * 20, r.spawn.p[1] - Math.cos(r.spawn.heading) * 20]], 1.5, [0, 90, 255]);
const out = join(outDir, `${id}${process.env.CROP ? '-crop' : ''}.png`);
writeFileSync(out, encodePNG(W, H, img));
console.log(`preview → ${out}`);
