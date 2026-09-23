// Heading-up circular minimap drawn on canvas from a pre-rendered recipe base layer.
import type { Game } from '../core/game';
import { layersFor, drawBase, camIcon, STATUS_COL } from './mapdraw';
import { cams, nav, playerPos, viewYaw, selectedCam } from './nav';

export class Minimap {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private baseScale = 1;
  private zoom = 1.7; // px per meter
  private size = 232;

  constructor(private g: Game) {
    this.el = document.createElement('canvas');
    this.ctx = this.el.getContext('2d')!;
  }

  private buildBase() {
    const r = this.g.recipe; if (!r?.bounds) return;
    const b = r.bounds; const w = b.maxX - b.minX, hgt = b.maxZ - b.minZ;
    if (!(w > 0 && hgt > 0)) return;
    const S = Math.min(2.5, 4096 / Math.max(w, hgt));
    const c = document.createElement('canvas'); c.width = Math.ceil(w * S); c.height = Math.ceil(hgt * S);
    const x = c.getContext('2d')!;
    x.setTransform(S, 0, 0, S, -b.minX * S, -b.minZ * S);
    try { drawBase(x, layersFor(r), S); } catch (e) { console.warn('[minimap] base', e); }
    this.base = c; this.baseScale = S;
  }

  draw(t: number) {
    const g = this.g;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = this.el.clientWidth || this.size; this.size = size;
    if (this.el.width !== Math.round(size * dpr)) { this.el.width = Math.round(size * dpr); this.el.height = Math.round(size * dpr); }
    if (!this.base) this.buildBase();
    const ctx = this.ctx; const R = size / 2;
    const [px, pz] = playerPos(g); const yaw = viewYaw(g);
    // zoom out with speed
    let speed = 0; try { speed = Math.hypot(g.player.velocity.x, g.player.velocity.z); } catch { /* */ }
    const targetZoom = speed > 6 ? Math.max(0.75, 1.7 - (speed - 6) * 0.04) : 1.7;
    this.zoom += (targetZoom - this.zoom) * 0.05;
    const k = this.zoom;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#080a0d'; ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(R, R); ctx.rotate(-yaw); ctx.scale(k, k); ctx.translate(-px, -pz);
    const b = g.recipe?.bounds;
    if (this.base && b) {
      // Only blit the part of the base image around the player (rotation-safe square).
      const S = this.baseScale; const half = (R / k) * 1.45;
      const x0 = Math.max(b.minX, px - half), z0 = Math.max(b.minZ, pz - half);
      const x1 = Math.min(b.minX + this.base.width / S, px + half), z1 = Math.min(b.minZ + this.base.height / S, pz + half);
      if (x1 > x0 && z1 > z0) ctx.drawImage(this.base, (x0 - b.minX) * S, (z0 - b.minZ) * S, (x1 - x0) * S, (z1 - z0) * S, x0, z0, x1 - x0, z1 - z0);
    }
    // route
    if (nav.route && nav.route.length > 1) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,178,62,0.25)'; ctx.lineWidth = 9 / k; this.poly(nav.route);
      ctx.strokeStyle = '#ffb23e'; ctx.lineWidth = 3.2 / k; this.poly(nav.route);
    }
    ctx.restore();

    // world → screen
    const cs = Math.cos(-yaw), sn = Math.sin(-yaw);
    const toS = (x: number, z: number): [number, number] => { const dx = (x - px) * k, dz = (z - pz) * k; return [R + dx * cs - dz * sn, R + dx * sn + dz * cs]; };

    // cameras
    const sel = g.surveillance?.selectedTarget;
    for (const c of cams(g)) {
      if (!c.discovered) continue;
      const [sx, sy] = toS(c.p[0], c.p[1]);
      if (Math.hypot(sx - R, sy - R) > R - 6) continue;
      camIcon(ctx, c.type, c.status, sx, sy, 4.6, c.id === sel);
    }
    // police
    let vs: any[] = []; try { vs = g.vehicles?.all?.() ?? []; } catch { /* */ }
    const flash = Math.floor(t * 6) % 2 === 0;
    for (const v of vs) {
      if (v.kind !== 'police' || v.destroyed) continue;
      let [sx, sy] = toS(v.position.x, v.position.z);
      const d = Math.hypot(sx - R, sy - R); const edge = d > R - 8;
      if (edge) { sx = R + ((sx - R) / d) * (R - 8); sy = R + ((sy - R) / d) * (R - 8); }
      ctx.fillStyle = v.siren ? (flash ? '#ff2d3d' : '#2f7bff') : '#7aa6ff';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(sx, sy, edge ? 3.5 : 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    // target waypoint (clamped to rim)
    const tc = selectedCam(g);
    if (tc) {
      let [sx, sy] = toS(tc.p[0], tc.p[1]); const d = Math.hypot(sx - R, sy - R);
      if (d > R - 12) { sx = R + ((sx - R) / d) * (R - 12); sy = R + ((sy - R) / d) * (R - 12); }
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#ffb23e'; ctx.shadowColor = '#ffb23e'; ctx.shadowBlur = 12; ctx.fillRect(-5, -5, 10, 10); ctx.restore();
    }
    // player arrow
    ctx.save(); ctx.translate(R, R);
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 46); grd.addColorStop(0, 'rgba(255,255,255,0.08)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grd; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 46, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7); ctx.closePath(); ctx.fill();
    ctx.restore();
    // rim + north marker
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(R, R, R - 1, 0, Math.PI * 2); ctx.stroke();
    const na = -yaw - Math.PI / 2; const nx = R + Math.cos(na) * (R - 13), ny = R + Math.sin(na) * (R - 13);
    ctx.fillStyle = 'rgba(8,10,13,0.85)'; ctx.beginPath(); ctx.arc(nx, ny, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = STATUS_COL.active; ctx.font = '800 10px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', nx, ny + 0.5);
  }

  private poly(pts: [number, number][]) {
    const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
}
