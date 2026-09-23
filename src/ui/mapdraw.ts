// Shared 2D map rendering of a Recipe (minimap + camera map). All paths are in world meters (x = east, y = z = south),
// so north is up on an untransformed canvas.
import type { Recipe, RecipeCamera, AreaKind, RoadClass, Vec2 } from '../core/types';

export type CamStatus = 'active' | 'disabled' | 'down' | 'repairing';
export type Cam = RecipeCamera & { status: CamStatus; discovered: boolean };

const AREA_COL: Partial<Record<AreaKind, string>> = {
  park: '#0f2419', grass: '#0f2218', forest: '#0c2016', playground: '#12281c', pitch: '#11291c', cemetery: '#0f1f18',
  water: '#0a1b2e', parking: '#161a21', pedestrian: '#1b1f27', plaza: '#1b1f27', sand: '#221f17', farmland: '#131a12',
  commercial: '#12151b', industrial: '#131519', residential: '#101318',
};
const AREA_ORDER: AreaKind[] = ['residential', 'commercial', 'industrial', 'farmland', 'forest', 'park', 'grass', 'cemetery', 'pitch', 'playground', 'sand', 'parking', 'pedestrian', 'plaza', 'water'];
const MAJOR: RoadClass[] = ['motorway', 'trunk', 'primary', 'secondary'];
const PATHY: RoadClass[] = ['footway', 'cycleway', 'path', 'steps', 'pedestrian'];

export interface MapLayers {
  areas: { color: string; path: Path2D }[];
  buildings: Path2D;
  casings: { width: number; path: Path2D }[];
  roads: { width: number; color: string; path: Path2D }[];
  paths: Path2D;
  bounds: Recipe['bounds'];
  streetName(x: number, z: number): string | null;
  nodePos: Map<number, Vec2>;
}

const cache = new WeakMap<Recipe, MapLayers>();

export function layersFor(recipe: Recipe): MapLayers {
  const c = cache.get(recipe); if (c) return c;
  const L = build(recipe); cache.set(recipe, L); return L;
}

function ring(p: Path2D, pts: Vec2[]) {
  if (!pts?.length) return;
  p.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  p.closePath();
}

function build(r: Recipe): MapLayers {
  const areaPaths = new Map<AreaKind, Path2D>();
  for (const a of r.areas ?? []) {
    if (!AREA_COL[a.kind]) continue;
    let p = areaPaths.get(a.kind); if (!p) areaPaths.set(a.kind, (p = new Path2D()));
    ring(p, a.poly); for (const hole of a.holes ?? []) ring(p, hole);
  }
  const areas = AREA_ORDER.filter((k) => areaPaths.has(k)).map((k) => ({ color: AREA_COL[k]!, path: areaPaths.get(k)! }));
  const buildings = new Path2D();
  for (const b of r.buildings ?? []) ring(buildings, b.footprint);

  const roadG = new Map<string, { width: number; color: string; path: Path2D }>();
  const casG = new Map<number, { width: number; path: Path2D }>();
  const paths = new Path2D();
  // segment grid for street names
  const CELL = 40; const grid = new Map<string, { a: Vec2; b: Vec2; name: string }[]>();
  for (const rd of r.roads ?? []) {
    if (!rd.pts?.length || rd.tunnel) continue;
    const poly = new Path2D(); poly.moveTo(rd.pts[0][0], rd.pts[0][1]); for (let i = 1; i < rd.pts.length; i++) poly.lineTo(rd.pts[i][0], rd.pts[i][1]);
    if (PATHY.includes(rd.cls)) { paths.addPath(poly); continue; }
    const w = Math.max(3, Math.round(rd.width || 6));
    const color = MAJOR.includes(rd.cls) ? '#3d3a36' : rd.cls === 'service' ? '#23282f' : '#2c323b';
    const key = `${w}|${color}`;
    let g = roadG.get(key); if (!g) roadG.set(key, (g = { width: w, color, path: new Path2D() }));
    g.path.addPath(poly);
    const cw = Math.round(w + 2 * (rd.sidewalk || 0) + 1);
    let cg = casG.get(cw); if (!cg) casG.set(cw, (cg = { width: cw, path: new Path2D() }));
    cg.path.addPath(poly);
    if (rd.name) for (let i = 0; i < rd.pts.length - 1; i++) {
      const a = rd.pts[i], b = rd.pts[i + 1];
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const z0 = Math.floor(Math.min(a[1], b[1]) / CELL), z1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`; let l = grid.get(k); if (!l) grid.set(k, (l = []));
        l.push({ a, b, name: rd.name });
      }
    }
  }
  const nodePos = new Map<number, Vec2>();
  for (const n of r.graph?.nodes ?? []) nodePos.set(n.id, n.p);

  return {
    areas, buildings, paths, bounds: r.bounds,
    casings: [...casG.values()].sort((a, b) => a.width - b.width),
    roads: [...roadG.values()].sort((a, b) => a.width - b.width),
    nodePos,
    streetName(x, z) {
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      let best: string | null = null, bd = 28;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const s of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const d = distSeg(x, z, s.a, s.b); if (d < bd) { bd = d; best = s.name; }
        }
      }
      return best;
    },
  };
}

function distSeg(px: number, pz: number, a: Vec2, b: Vec2) {
  const dx = b[0] - a[0], dz = b[1] - a[1]; const l = dx * dx + dz * dz;
  let t = l ? ((px - a[0]) * dx + (pz - a[1]) * dz) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[1] + t * dz));
}

/** Draw the static base map. ctx transform must already map world meters → pixels; pxPerM = current scale. */
export function drawBase(ctx: CanvasRenderingContext2D, L: MapLayers, pxPerM: number, opts: { buildings?: boolean } = {}) {
  const b = L.bounds;
  ctx.fillStyle = '#0c0f13'; ctx.fillRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);
  for (const a of L.areas) { ctx.fillStyle = a.color; ctx.fill(a.path, 'evenodd'); }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const c of L.casings) { ctx.strokeStyle = '#191d24'; ctx.lineWidth = c.width; ctx.stroke(c.path); }
  ctx.strokeStyle = '#1e232b'; ctx.lineWidth = Math.max(1.2, 1.4 / pxPerM); ctx.setLineDash([2.5, 2.5]); ctx.stroke(L.paths); ctx.setLineDash([]);
  for (const r of L.roads) { ctx.strokeStyle = r.color; ctx.lineWidth = Math.max(r.width, 1.5 / pxPerM); ctx.stroke(r.path); }
  if (opts.buildings !== false) {
    ctx.fillStyle = '#1a1f27'; ctx.fill(L.buildings);
    ctx.strokeStyle = '#262c36'; ctx.lineWidth = Math.max(0.5, 0.8 / pxPerM); ctx.stroke(L.buildings);
  }
  // map edge
  ctx.strokeStyle = 'rgba(255,45,61,0.25)'; ctx.lineWidth = 2 / pxPerM; ctx.setLineDash([8 / pxPerM, 6 / pxPerM]);
  ctx.strokeRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ); ctx.setLineDash([]);
}

export const STATUS_COL: Record<CamStatus, string> = { active: '#ff2d3d', disabled: '#ffb23e', down: '#3ee08f', repairing: '#3d8bff' };
export const TYPE_NAME: Record<string, string> = { pole: 'Pole camera', ptz: 'PTZ dome', cluster: 'Mast cluster', tower: 'Surveillance tower' };
const TYPE_MULT: Record<string, number> = { pole: 1, ptz: 1.25, cluster: 1.5, tower: 2.5 };

/** Heading (0 = north/−Z, clockwise) → canvas angle. */
export const canvasAngle = (h: number) => h - Math.PI / 2;

/** Vision cone in world units. */
export function coneFill(ctx: CanvasRenderingContext2D, c: Cam, t: number, color: string, withSweep = true) {
  const fov = ((c.fovDeg ?? 60) * Math.PI) / 180;
  const R = c.rangeM ?? 40;
  if (fov >= Math.PI * 1.9) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(c.p[0], c.p[1], R, 0, Math.PI * 2); ctx.fill(); return; }
  let h = c.heading;
  if (c.sweep && withSweep) {
    const amp = (c.sweep.amplitudeDeg * Math.PI) / 180;
    // full sweep extent, faint
    ctx.fillStyle = color.replace(/[\d.]+\)$/, (m) => `${parseFloat(m) * 0.4})`);
    ctx.beginPath(); ctx.moveTo(c.p[0], c.p[1]); ctx.arc(c.p[0], c.p[1], R, canvasAngle(h - amp - fov / 2), canvasAngle(h + amp + fov / 2)); ctx.closePath(); ctx.fill();
    h += amp * Math.sin((t * 2 * Math.PI) / (c.sweep.periodS || 8));
  }
  const grad = ctx.createRadialGradient(c.p[0], c.p[1], 0, c.p[0], c.p[1], R);
  grad.addColorStop(0, color); grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(c.p[0], c.p[1]); ctx.arc(c.p[0], c.p[1], R, canvasAngle(h - fov / 2), canvasAngle(h + fov / 2)); ctx.closePath(); ctx.fill();
}

/** Camera icon in screen pixels at (x,y). */
export function camIcon(ctx: CanvasRenderingContext2D, type: string, status: CamStatus, x: number, y: number, s: number, selected = false) {
  const col = STATUS_COL[status] ?? '#fff';
  ctx.save(); ctx.translate(x, y);
  if (selected) { ctx.strokeStyle = '#ffb23e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, s * 1.9, 0, Math.PI * 2); ctx.stroke(); }
  ctx.shadowColor = col; ctx.shadowBlur = status === 'active' ? s * 1.2 : 0;
  ctx.fillStyle = '#0a0c10'; ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, s * 0.28);
  ctx.beginPath();
  if (type === 'tower') { ctx.moveTo(0, -s * 1.25); ctx.lineTo(s * 1.25, 0); ctx.lineTo(0, s * 1.25); ctx.lineTo(-s * 1.25, 0); ctx.closePath(); }
  else if (type === 'cluster') { ctx.roundRect(-s, -s, 2 * s, 2 * s, s * 0.35); }
  else ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = col;
  if (type === 'ptz') { ctx.lineWidth = Math.max(1, s * 0.2); ctx.beginPath(); ctx.arc(0, 0, s * 0.5, Math.PI, 0); ctx.stroke(); ctx.beginPath(); ctx.arc(0, s * 0.05, s * 0.2, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(-s * 0.6, -s * 0.02, s * 1.2, s * 0.14); }
  else if (type === 'pole') { ctx.beginPath(); ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2); ctx.fill(); }
  else if (type === 'cluster') { for (const [dx, dy] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) { ctx.beginPath(); ctx.arc(dx * s, dy * s, s * 0.22, 0, Math.PI * 2); ctx.fill(); } }
  else { ctx.beginPath(); ctx.arc(0, 0, s * 0.45, 0, Math.PI * 2); ctx.fill(); }
  if (status === 'down') { ctx.strokeStyle = '#0a0c10'; ctx.lineWidth = s * 0.3; ctx.beginPath(); ctx.moveTo(-s * 0.55, -s * 0.55); ctx.lineTo(s * 0.55, s * 0.55); ctx.stroke(); }
  ctx.restore();
}

/** True if camera `w` (active) can see point p. */
export function sees(w: Cam, p: Vec2): boolean {
  const dx = p[0] - w.p[0], dz = p[1] - w.p[1]; const d = Math.hypot(dx, dz);
  if (d > (w.rangeM ?? 40) || d < 0.5) return false;
  const fov = ((w.fovDeg ?? 60) * Math.PI) / 180 + (w.sweep ? (2 * w.sweep.amplitudeDeg * Math.PI) / 180 : 0);
  if (fov >= Math.PI * 1.9) return true;
  const ang = Math.atan2(dx, -dz); // heading convention
  let diff = Math.abs(((ang - w.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  return diff <= fov / 2;
}

export function watchersOf(c: Cam, cams: Cam[]): number {
  let n = 0; for (const w of cams) if (w.id !== c.id && w.status === 'active' && sees(w, c.p)) n++;
  return n;
}

export function pointsEstimate(c: Cam, watchers: number, streak: number): { disable: number; cut: number | null } {
  const mult = (TYPE_MULT[c.type] ?? 1) * (1 + 0.25 * watchers) * Math.min(3, 1 + 0.1 * streak);
  return { disable: Math.round(100 * mult), cut: c.cuttable ? Math.round(300 * mult) : null };
}
