// Full-screen camera map: recipe base map, known cameras w/ status, coverage cones, fog-of-war count,
// pan/zoom, click to target, route line.
import type { Game } from '../core/game';
import { h, btn, uiRoot, fmt } from './dom';
import { layersFor, drawBase, camIcon, coneFill, STATUS_COL, TYPE_NAME, watchersOf, pointsEstimate, type Cam, canvasAngle } from './mapdraw';
import { cams, nav, playerPos, viewYaw, setTarget, updateRoute } from './nav';
import { sfx } from '../audio/sfx';

export class CameraMap {
  private el: HTMLElement | null = null;
  private cvs!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private view = { cx: 0, cz: 0, k: 1 };
  private coverage = true;
  private info!: HTMLElement;
  private stats!: HTMLElement;
  private fog!: HTMLElement;
  private raf = 0;
  private hover: string | null = null;
  private fitted = false;
  private ac: AbortController | null = null;
  onClose: (() => void) | null = null;

  constructor(private g: Game) {}
  get isOpen() { return !!this.el; }

  open() {
    if (this.el) return;
    const g = this.g;
    this.cvs = h('canvas'); this.ctx = this.cvs.getContext('2d')!;
    this.info = h('div', { class: 'info gt-glass' });
    this.stats = h('div', { class: 'st' });
    this.fog = h('div', { class: 'fog' });
    const cov = h('button', { class: 'gt-btn', style: 'padding:8px 10px;font-size:10.5px;margin-top:6px', onclick: () => { this.coverage = !this.coverage; cov.textContent = `Coverage: ${this.coverage ? 'on' : 'off'}`; sfx('ui-click'); } }, 'Coverage: on');
    const legend = h('div', { class: 'legend gt-glass' },
      h('div', { class: 'h gt-label' }, 'Legend'),
      ...(['active', 'disabled', 'down', 'repairing'] as const).map((s) => h('div', {}, h('i', { style: `background:${STATUS_COL[s]};box-shadow:0 0 8px ${STATUS_COL[s]}` }), s[0].toUpperCase() + s.slice(1))),
      ...(['pole', 'ptz', 'cluster', 'tower'] as const).map((t) => { const c = h('canvas', { width: 36, height: 36 }); const x = c.getContext('2d')!; x.scale(2, 2); camIcon(x, t, 'active', 9, 9, 5); return h('div', {}, c, TYPE_NAME[t]); }),
      h('div', {}, h('i', { style: 'background:#fff' }), 'You'), h('div', {}, h('i', { style: 'background:#2f7bff' }), 'Police'),
      h('div', { class: 'h' }, cov),
    );
    this.el = h('div', { class: 'gt-cammap' }, this.cvs,
      h('div', { class: 'top' },
        h('div', { class: 'ttl gt-glass' }, h('h2', {}, 'SURVEILLANCE GRID'), this.stats, this.fog),
        h('div', { class: 'keys gt-glass', html: 'DRAG · PAN &nbsp; WHEEL · ZOOM<br>CLICK CAMERA · SET TARGET<br>V · COVERAGE &nbsp; M / ESC · CLOSE' })),
      legend, this.info);
    uiRoot().appendChild(this.el);
    if (!this.fitted) this.fit();
    const [px, pz] = playerPos(g); this.view.cx = px; this.view.cz = pz;
    this.bind();
    this.renderInfo();
    const loop = () => { this.draw(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  close() {
    if (!this.el) return;
    cancelAnimationFrame(this.raf);
    this.ac?.abort(); this.ac = null;
    this.el.remove(); this.el = null;
    this.onClose?.();
  }

  private fit() {
    const b = this.g.recipe?.bounds; if (!b) return;
    const w = b.maxX - b.minX, hh = b.maxZ - b.minZ;
    this.view.k = Math.min(innerWidth / w, innerHeight / hh) * 1.6;
    this.fitted = true;
  }

  private toWorld(sx: number, sy: number): [number, number] {
    return [this.view.cx + (sx - innerWidth / 2) / this.view.k, this.view.cz + (sy - innerHeight / 2) / this.view.k];
  }
  private toScreen(x: number, z: number): [number, number] {
    return [(x - this.view.cx) * this.view.k + innerWidth / 2, (z - this.view.cz) * this.view.k + innerHeight / 2];
  }

  private bind() {
    this.ac = new AbortController(); const signal = this.ac.signal;
    const c = this.cvs; let drag: { x: number; y: number; moved: boolean } | null = null;
    c.addEventListener('mousedown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; c.classList.add('drag'); });
    addEventListener('mouseup', (e) => {
      if (!drag) return; c.classList.remove('drag');
      if (!drag.moved && e.target === c) this.click(e.clientX, e.clientY);
      drag = null;
    }, { signal });
    c.addEventListener('mousemove', (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.view.cx -= dx / this.view.k; this.view.cz -= dy / this.view.k; drag.x = e.clientX; drag.y = e.clientY;
      } else {
        const hit = this.pick(e.clientX, e.clientY);
        this.hover = hit?.id ?? null; c.style.cursor = hit ? 'pointer' : '';
      }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [wx, wz] = this.toWorld(e.clientX, e.clientY);
      const f = Math.exp(-e.deltaY * 0.0015);
      this.view.k = Math.max(0.15, Math.min(12, this.view.k * f));
      this.view.cx = wx - (e.clientX - innerWidth / 2) / this.view.k; this.view.cz = wz - (e.clientY - innerHeight / 2) / this.view.k;
    }, { passive: false });
  }

  handleKey(code: string): boolean {
    if (code === 'KeyV') { this.coverage = !this.coverage; return true; }
    return false;
  }

  private pick(sx: number, sy: number): Cam | null {
    let best: Cam | null = null, bd = 16;
    for (const c of cams(this.g)) {
      if (!c.discovered) continue;
      const [x, y] = this.toScreen(c.p[0], c.p[1]); const d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private click(sx: number, sy: number) {
    const c = this.pick(sx, sy);
    if (c) { sfx('ui-click'); setTarget(this.g, c.id); this.renderInfo(); }
  }

  private renderInfo() {
    const g = this.g; const all = cams(g);
    const id = g.surveillance?.selectedTarget; const c = all.find((x) => x.id === id);
    if (!c) { this.info.classList.remove('on'); return; }
    const w = watchersOf(c, all);
    const streak = g.surveillance?.streak ?? 0;
    const pts = pointsEstimate(c, w, streak);
    const [px, pz] = playerPos(g);
    const dist = Math.hypot(c.p[0] - px, c.p[1] - pz);
    this.info.replaceChildren(
      h('div', { class: 'gt-label' }, 'Target'),
      h('h3', { style: 'margin-top:8px' }, TYPE_NAME[c.type] ?? c.type),
      h('div', { class: 'ty' }, h('span', { class: `gt-status ${c.status}` }, c.status), c.plateReader ? '  ·  PLATE READER' : ''),
      h('dl', {},
        h('dt', {}, 'Disable'), h('dd', { class: 'pts' }, `+${fmt(pts.disable)}`),
        h('dt', {}, 'Cut down'), h('dd', { class: 'pts' }, pts.cut ? `+${fmt(pts.cut)}` : 'not cuttable'),
        h('dt', {}, 'Watched by'), h('dd', {}, w ? `${w} camera${w > 1 ? 's' : ''}` : 'none'),
        h('dt', {}, 'Range · FOV'), h('dd', {}, `${Math.round(c.rangeM)} m · ${Math.round(c.fovDeg)}°`),
        h('dt', {}, 'Distance'), h('dd', {}, `${Math.round(dist)} m`),
      ),
      btn('Clear target', () => { setTarget(g, null); this.renderInfo(); }),
    );
    this.info.classList.add('on');
  }

  private lastInfo = 0;
  private draw() {
    const g = this.g; const ctx = this.ctx; const cvs = this.cvs;
    const dpr = Math.min(2, devicePixelRatio || 1); const W = innerWidth, H = innerHeight;
    if (cvs.width !== Math.round(W * dpr) || cvs.height !== Math.round(H * dpr)) { cvs.width = Math.round(W * dpr); cvs.height = Math.round(H * dpr); }
    const t = performance.now() / 1000;
    const k = this.view.k;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#050608'; ctx.fillRect(0, 0, W, H);
    // world transform
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (W / 2 - this.view.cx * k), dpr * (H / 2 - this.view.cz * k));
    try { drawBase(ctx, layersFor(g.recipe), k); } catch { /* recipe missing */ }
    const all = cams(g); const known = all.filter((c) => c.discovered);
    if (this.coverage) {
      ctx.globalCompositeOperation = 'lighter';
      for (const c of known) if (c.status === 'active') coneFill(ctx, c, g.elapsed ?? t, 'rgba(255,45,61,0.22)');
      ctx.globalCompositeOperation = 'source-over';
    }
    // route
    updateRoute(g);
    if (nav.route && nav.route.length > 1) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,178,62,0.25)'; ctx.lineWidth = 10 / k; this.poly(nav.route);
      ctx.strokeStyle = '#ffb23e'; ctx.lineWidth = 3 / k; ctx.setLineDash([10 / k, 6 / k]); ctx.lineDashOffset = -t * 30 / k; this.poly(nav.route); ctx.setLineDash([]);
    }
    // screen-space overlays
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = g.surveillance?.selectedTarget;
    const s = Math.max(4.5, Math.min(9, 3 + k * 2));
    for (const c of known) {
      const [x, y] = this.toScreen(c.p[0], c.p[1]);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      if (c.status === 'active') {
        const ph = (t * 0.6 + (c.p[0] * 0.013) % 1) % 1;
        ctx.strokeStyle = `rgba(255,45,61,${0.45 * (1 - ph)})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, s + ph * 16, 0, Math.PI * 2); ctx.stroke();
      }
      // heading tick
      ctx.strokeStyle = STATUS_COL[c.status]; ctx.lineWidth = 1.5; const a = canvasAngle(c.heading);
      ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * s * 1.3, y + Math.sin(a) * s * 1.3); ctx.lineTo(x + Math.cos(a) * s * 2.3, y + Math.sin(a) * s * 2.3); ctx.stroke();
      camIcon(ctx, c.type, c.status, x, y, s * (c.id === this.hover ? 1.25 : 1), c.id === sel);
    }
    // police
    let vs: any[] = []; try { vs = g.vehicles?.all?.() ?? []; } catch { /* */ }
    const flash = Math.floor(t * 6) % 2 === 0;
    for (const v of vs) {
      if (v.kind !== 'police' || v.destroyed) continue;
      const [x, y] = this.toScreen(v.position.x, v.position.z);
      ctx.fillStyle = v.siren ? (flash ? '#ff2d3d' : '#2f7bff') : '#7aa6ff'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    }
    // player
    const [px, pz] = playerPos(g); const [sx, sy] = this.toScreen(px, pz); const yaw = viewYaw(g);
    ctx.save(); ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.beginPath(); ctx.arc(0, 0, 18 + Math.sin(t * 3) * 2, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(yaw); ctx.fillStyle = '#fff'; ctx.shadowColor = '#000'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 8); ctx.lineTo(0, 4); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
    // scale bar
    const m = niceMeters(120 / k); const px2 = m * k;
    ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(W - 24 - px2, H - 30, px2, 2);
    ctx.font = '500 11px "JetBrains Mono", monospace'; ctx.textAlign = 'right'; ctx.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, W - 24, H - 38);

    // header stats (4 Hz)
    if (t - this.lastInfo > 0.25) {
      this.lastInfo = t;
      const cnt = (st: string) => known.filter((c) => c.status === st).length;
      this.stats.innerHTML = `<span><b>${cnt('active')}</b> active</span><span><b>${cnt('disabled') + cnt('repairing')}</b> disabled</span><span><b>${cnt('down')}</b> down</span>`;
      const unknown = all.length - known.length;
      this.fog.textContent = unknown > 0 ? `≈ ${unknown} unmapped camera${unknown > 1 ? 's' : ''} suspected` : 'All cameras in this area are mapped';
      if (this.info.classList.contains('on')) this.renderInfo();
    }
  }

  private poly(pts: [number, number][]) {
    const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }
}

function niceMeters(x: number) { const p = Math.pow(10, Math.floor(Math.log10(x))); const n = x / p; return (n < 2 ? 1 : n < 5 ? 2 : 5) * p; }
