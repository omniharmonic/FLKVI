// In-game HUD: heat, arrest meter, streak/score, grinder charges, takedown ring + prompt, minimap, compass,
// street name, speedometer, toasts, banked celebration, takedown popups.
import type { Game } from '../core/game';
import { h, safe, fmt } from './dom';
import { Minimap } from './minimap';
import { layersFor } from './mapdraw';
import { playerPos, viewYaw, selectedCam, updateRoute } from './nav';
import { Hints } from './hints';
import { sfx } from '../audio/sfx';

const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.2l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.1l-5.9 3.2 1.3-6.6-4.9-4.6 6.6-.8z"/></svg>';

export class HUD {
  readonly el: HTMLElement;
  private mini: Minimap;
  private slots: HTMLElement[] = [];
  private heatWrap: HTMLElement;
  private heatBar: HTMLElement;
  private heatMeta: HTMLElement;
  private arrest: HTMLElement;
  private arrestBar: HTMLElement;
  private score: HTMLElement;
  private streakEl: HTMLElement;
  private multEl: HTMLElement;
  private rows: { sc: HTMLElement; hot: HTMLElement; bank: HTMLElement };
  private charges: HTMLElement;
  private toasts: HTMLElement;
  private prompt: HTMLElement;
  private promptTxt: HTMLElement;
  private ring: HTMLElement;
  private ringFg: SVGCircleElement;
  private ringLab: HTMLElement;
  private speed: HTMLElement;
  private speedNum: HTMLElement;
  private speedGauge: HTMLElement;
  private vehicleCondition: HTMLElement;
  private flag: HTMLElement;
  private street: HTMLElement;
  private clock: HTMLElement;
  private compassStrip: HTMLElement;
  private compassTgt: HTMLElement;
  private vignette: HTMLElement;
  private modeEl: HTMLElement;
  private lastLevel = 0;
  private lastStreak = 0;
  private promptText: string | null = null;
  private takedownActive = false;
  private slowT = 0;
  private mult = 1;
  private pendingTakedown: { mode: 'cut' | 'disable'; upgrade: boolean; timer: number } | null = null;
  readonly hints: Hints;
  private arrestWarn: HTMLElement;
  private beatT = 0;
  private wasSpotted = false;
  private lastPopAt = -1e9;

  constructor(private g: Game) {
    this.mini = new Minimap(g);
    // heat
    this.heatWrap = h('div', { class: 'hud-heat' });
    for (let i = 0; i < 5; i++) { const s = h('div', { class: 'slot', html: STAR }); this.slots.push(s); this.heatWrap.append(s); }
    this.heatBar = h('i'); this.heatMeta = h('div', { class: 'hud-heatmeta' });
    this.arrestBar = h('i');
    this.arrest = h('div', { class: 'hud-arrest' }, h('span', { class: 't' }, 'ARREST'), h('div', { class: 'b' }, this.arrestBar));
    // score
    this.streakEl = h('b', {}, '0'); this.multEl = h('span', { class: 'mult' }, '×1.0');
    this.rows = { sc: h('span', { class: 'sc' }, '0'), hot: h('span', { class: 'hot' }, '0'), bank: h('span', { class: 'bank' }, '0') };
    this.score = h('div', { class: 'hud-score gt-glass' },
      h('div', { class: 'streak' }, h('span', { class: 'gt-label' }, 'Streak'), this.multEl, this.streakEl),
      h('div', { class: 'rows' }, h('span', {}, 'SCORE'), this.rows.sc, h('span', {}, 'HOT'), this.rows.hot, h('span', {}, 'BANKED'), this.rows.bank));
    this.charges = h('div', { class: 'hud-charges' });
    // prompt & ring
    this.promptTxt = h('div', { class: 'txt gt-glass' });
    this.ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 84 84');
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    for (const c of [bg, this.ringFg]) { c.setAttribute('cx', '42'); c.setAttribute('cy', '42'); c.setAttribute('r', '36'); }
    bg.setAttribute('class', 'bg'); this.ringFg.setAttribute('class', 'fg');
    this.ringFg.setAttribute('stroke-dasharray', String(2 * Math.PI * 36)); this.ringFg.setAttribute('stroke-dashoffset', String(2 * Math.PI * 36));
    svg.append(bg, this.ringFg);
    this.ringLab = h('div', { class: 'lab' });
    this.ring = h('div', { class: 'hud-ring' }, svg as any, this.ringLab);
    this.prompt = h('div', { class: 'hud-prompt' }, this.ring, this.promptTxt);
    // speed
    this.speedNum = h('b', {}, '0'); this.speedGauge = h('i'); this.flag = h('div', { class: 'hud-flag' }, 'PLATE FLAGGED');
    this.vehicleCondition = h('div', {class:'hud-condition',style:'font-size:11px;letter-spacing:0.08em;margin-top:6px'});
    this.speed = h('div', { class: 'hud-speed' }, this.vehicleCondition, this.speedNum, h('span', {}, 'MPH'), h('div', { class: 'gauge' }, this.speedGauge), this.flag);
    // minimap + street
    this.street = h('span', {}, ''); this.clock = h('span', { class: 'clock' }, '');
    const miniWrap = h('div', { class: 'hud-mini' }, this.mini.el);
    // compass
    this.compassStrip = h('div', { class: 'strip' }); this.compassTgt = h('div', { class: 'tgt' });
    const PX = 420 / 180;
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = -180; d <= 540; d += 15) {
      const n = ((d % 360) + 360) % 360; const x = (d + 180) * PX;
      this.compassStrip.append(h('div', { class: `tick ${n % 45 === 0 ? 'big' : ''}`, style: `left:${x}px` }));
      if (n % 45 === 0) this.compassStrip.append(h('div', { class: `lbl ${n % 90 === 0 ? 'card' : ''} ${n === 0 ? 'n' : ''}`, style: `left:${x}px` }, names[n]));
      else this.compassStrip.append(h('div', { class: 'lbl', style: `left:${x}px;font-size:9px;opacity:.5;font-weight:500` }, String(n)));
    }
    const compass = h('div', { class: 'hud-compass' }, this.compassStrip, this.compassTgt, h('div', { class: 'caret' }));
    this.vignette = h('div', { class: 'hud-vignette' });
    this.toasts = h('div', { class: 'hud-toasts' });
    this.modeEl = h('div', { class: 'hud-mode' });
    this.hints = new Hints(g);
    this.arrestWarn = h('div', { class: 'hud-arrestwarn' }, h('b', {}, 'GETTING CAUGHT'), h('span', {}, 'MOVE! BREAK AWAY FROM THE OFFICERS'));

    this.el = h('div', { class: 'gt-hud' },
      this.vignette, compass, this.modeEl,
      h('div', { class: 'hud-tl' }, h('div', { class: 'hud-street' }, this.street, this.clock), miniWrap),
      h('div', { class: 'hud-tr' }, this.heatWrap, h('div', { class: 'hud-heatbar' }, this.heatBar), this.heatMeta, this.arrest, this.score, this.charges),
      this.toasts, this.prompt, this.speed, this.hints.el, this.arrestWarn,
    );
    this.bindEvents();
    this.renderMode();
  }

  renderMode() {
    const g = this.g; const place = (g.recipe?.name ?? '').split(/,| — | - /)[0];
    this.modeEl.replaceChildren(h('span', { class: 'rec' }), h('span', {}, `${g.mode === 'freeroam' ? 'FREE ROAM' : 'TAKEDOWN'}${place ? ' · ' + place.toUpperCase() : ''}`), h('span', { class: 'hint' }, 'M MAP · ESC PAUSE'));
    this.score.style.display = g.mode === 'freeroam' ? 'none' : '';
  }

  private bindEvents() {
    const ev = this.g.events;
    ev.on('toast', (t) => this.toast(t.text, t.kind, t.ms));
    ev.on('prompt', ({ text }) => { this.promptText = text; });
    ev.on('takedownStart', ({ mode }) => { this.takedownActive = true; this.ring.classList.add('on'); this.ring.classList.toggle('cut', mode === 'cut'); this.setRing(0, mode); });
    ev.on('takedownProgress', ({ t, mode }) => { this.takedownActive = true; this.ring.classList.add('on'); this.setRing(t, mode); });
    ev.on('takedownCancel', () => { this.takedownActive = false; this.ring.classList.remove('on'); });
    ev.on('takedown', ({ mode, upgrade }) => {
      this.takedownActive = false; this.ring.classList.remove('on');
      const up = !!upgrade;
      this.pendingTakedown = { mode, upgrade: up, timer: window.setTimeout(() => { this.popTakedown(mode, null, up); this.pendingTakedown = null; }, 350) };
    });
    ev.on('score', (s) => {
      this.mult = s.multiplier ?? this.mult;
      if (this.pendingTakedown) { clearTimeout(this.pendingTakedown.timer); this.popTakedown(this.pendingTakedown.mode, s.points, this.pendingTakedown.upgrade); this.pendingTakedown = null; }
    });
    ev.on('banked', ({ amount, total }) => {
      if (performance.now() - this.lastPopAt < 900) return; // the takedown pop already says CLEAN · BANKED
      const n = h('div', { class: 'hud-banked' }, h('div', { class: 't' }, 'CLEAN ESCAPE · BANKED'), h('div', { class: 'n' }, `+${fmt(amount)}`), h('div', { class: 's' }, `TOTAL BANKED ${fmt(total)}`));
      this.el.append(n); setTimeout(() => n.remove(), 2900);
    });
    ev.on('plateHit', () => this.toast('Plate reader hit. Police know where your car is.', 'bad'));
    ev.on('cameraRepaired', () => this.toast('A disabled camera is back online.', 'warn'));
    ev.on('heatZero', () => { /* banking is celebrated via 'banked' */ });
    ev.on('playerEnterVehicle', ({ stolen }) => { if (stolen) this.toast('Vehicle stolen. Expect a report.', 'warn', 2500); });
  }

  private popTakedown(mode: 'cut' | 'disable', points: number | null, upgrade = false) {
    const banked = points != null && safe(() => this.g.surveillance.hot, 0) === 0;
    this.lastPopAt = performance.now();
    const n = h('div', { class: `hud-takedown ${mode}` },
      h('div', { class: 't' }, upgrade ? 'UPGRADED TO CUT' : mode === 'cut' ? 'CAMERA DOWN' : 'CAMERA DISABLED'),
      points != null ? h('div', { class: `p ${banked ? 'banked' : ''}` }, `+${fmt(points)}`) : null,
      points != null && this.mult > 1.01 ? h('div', { class: 'x' }, `STREAK ×${this.mult.toFixed(1)}`) : null,
      h('div', { class: 's' }, banked ? 'CLEAN · BANKED' : 'HOT · LOSE THE HEAT TO BANK'));
    this.el.append(n); setTimeout(() => n.remove(), 2600);
  }

  private setRing(t: number, mode: 'cut' | 'disable') {
    const C = 2 * Math.PI * 36; t = Math.max(0, Math.min(1, t));
    this.ringFg.setAttribute('stroke-dashoffset', String(C * (1 - t)));
    this.ringLab.innerHTML = `<div><b>${Math.round(t * 100)}%</b>${mode === 'cut' ? 'CUTTING' : 'DISABLING'}</div>`;
  }

  toast(text: string, kind: 'info' | 'warn' | 'good' | 'bad' = 'info', ms = 3200) {
    const t = h('div', { class: `hud-toast gt-glass ${kind}` }, text);
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild!.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
  }

  setVisible(v: boolean) { this.el.classList.toggle('hidden', !v); }

  update(dt: number) {
    const g = this.g; const t = performance.now() / 1000;
    // heat
    const level = Math.round(safe(() => g.heat.level, 0));
    const spotted = safe(() => g.heat.spotted, false);
    this.slots.forEach((s, i) => {
      const on = i < level; s.classList.toggle('on', on);
      if (on && i >= this.lastLevel) { s.classList.remove('pulse'); void s.offsetWidth; s.classList.add('pulse'); }
    });
    this.lastLevel = level;
    this.heatWrap.classList.toggle('spotted', spotted);
    const prog = safe(() => g.heat.progress, 0);
    this.heatBar.style.width = level > 0 ? `${Math.max(0, Math.min(1, prog)) * 100}%` : '0%';
    (this.heatBar.parentElement as HTMLElement).style.opacity = level > 0 ? '1' : '0';
    const metaTxt = level === 0 ? '' : spotted ? '<span class="st">● PURSUIT</span>' : '<span class="st search">◌ SEARCHING</span><span>LOSE THEM</span>';
    if (this.heatMeta.innerHTML !== metaTxt) this.heatMeta.innerHTML = metaTxt;
    this.vignette.classList.toggle('on', spotted && level > 0);
    this.vignette.style.setProperty('--k', String(Math.min(1, 0.35 + level * 0.13)));
    if (spotted && level > 0 && !this.wasSpotted) { this.vignette.classList.remove('flash'); void this.vignette.offsetWidth; this.vignette.classList.add('flash'); }
    this.wasSpotted = spotted && level > 0;
    const am = safe(() => g.heat.arrestMeter, 0);
    this.arrest.classList.toggle('on', am > 0.01);
    this.arrestBar.style.width = `${Math.min(1, am) * 100}%`;
    const warn = am > 0.12 && !g.paused;
    this.arrestWarn.classList.toggle('on', warn);
    this.arrestWarn.style.setProperty('--a', String(Math.min(1, am)));
    if (warn) {
      const inCar = !!safe(() => g.player.vehicleId, null);
      const sub = inCar ? 'DRIVE! GET MOVING BEFORE THEY BOX YOU IN' : 'RUN! BREAK AWAY FROM THE OFFICERS';
      const span = this.arrestWarn.lastElementChild as HTMLElement;
      if (span.textContent !== sub) span.textContent = sub;
    }
    this.arrest.classList.toggle('hi', am > 0.5);
    if (warn) {
      // heartbeat speeds up as the meter fills
      this.beatT -= dt;
      if (this.beatT <= 0) { this.beatT = 0.75 - 0.45 * Math.min(1, am); sfx('kick', { volume: 0.35 + 0.5 * am }); }
    } else this.beatT = 0;
    try { this.hints.update(dt); } catch { /* */ }
    // score (poll surveillance)
    const s = g.surveillance;
    if (s) {
      const streak = safe(() => s.streak, 0);
      if (streak !== this.lastStreak) { this.streakEl.textContent = String(streak); if (streak > this.lastStreak) { this.streakEl.classList.remove('bump'); void this.streakEl.offsetWidth; this.streakEl.classList.add('bump'); } this.lastStreak = streak; }
      const mult = Math.min(3, 1 + 0.1 * streak);
      this.multEl.textContent = `×${(this.mult > 1 ? this.mult : mult).toFixed(1)}`;
      this.rows.sc.textContent = fmt(safe(() => s.score, 0));
      this.rows.hot.textContent = fmt(safe(() => s.hot, 0));
      this.rows.bank.textContent = fmt(safe(() => s.banked, 0));
      const ch = s.grinderCharges, mx = s.grinderMax;
      if (typeof ch === 'number' && typeof mx === 'number' && mx > 0) {
        if (this.charges.dataset.v !== `${ch}/${mx}`) {
          this.charges.dataset.v = `${ch}/${mx}`;
          const pips = h('div', { class: 'pips' }); for (let i = 0; i < mx; i++) pips.append(h('div', { class: `pip ${i < ch ? 'on' : ''}` }));
          this.charges.replaceChildren(h('span', { class: 'gt-label' }, 'Grinder'), pips);
        }
      } else if (this.charges.childElementCount) this.charges.replaceChildren();
    }
    // prompt
    const showPrompt = !!this.promptText || this.takedownActive;
    this.prompt.classList.toggle('on', showPrompt);
    if (this.promptText !== null && this.promptTxt.dataset.t !== this.promptText) {
      this.promptTxt.dataset.t = this.promptText;
      this.promptTxt.innerHTML = this.promptText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\b(Hold |Press )?\b([A-Z]|Space|Shift|Tab)\b(?=:)/g, (_m, pre, k) => `${pre ?? ''}<b>${k}</b>`);
    }
    this.promptTxt.style.display = this.promptText ? '' : 'none';
    // speed
    let vid: string | null = null; try { vid = g.player?.vehicleId ?? null; } catch { /* */ }
    this.speed.classList.toggle('on', !!vid);
    if (vid) {
      const v = safe(() => g.vehicles.get(vid!), undefined);
      const mps = Math.abs(v?.speed ?? safe(() => Math.hypot(g.player.velocity.x, g.player.velocity.z), 0));
      const mph = mps * 2.23694;
      this.speedNum.textContent = String(Math.round(mph));
      const health=Math.round(v?.health??100);
      this.vehicleCondition.textContent=`${v?.gear===-1?'R':v?.gear??'D'} · CONDITION ${health}%${health<35?' · ENGINE DAMAGE':''}`;
      this.vehicleCondition.style.color=health<35?'#f28a6c':'#bdc7cf';
      this.speedGauge.style.width = `${Math.min(1, mph / 120) * 100}%`;
      this.flag.classList.toggle('on', safe(() => g.player.plateFlagged, false));
    }
    // compass
    const yaw = viewYaw(g); const yawDeg = ((yaw * 180) / Math.PI + 360) % 360; const PX = 420 / 180;
    this.compassStrip.style.transform = `translateX(${210 - (yawDeg + 180) * PX}px)`;
    const tc = selectedCam(g);
    if (tc) {
      const [px, pz] = playerPos(g); const b = (Math.atan2(tc.p[0] - px, -(tc.p[1] - pz)) * 180) / Math.PI;
      let rel = ((b - yawDeg + 540) % 360) - 180;
      this.compassTgt.style.display = Math.abs(rel) < 88 ? '' : 'none';
      this.compassTgt.style.left = `${210 + rel * PX}px`;
    } else this.compassTgt.style.display = 'none';
    // minimap
    try { this.mini.draw(t); } catch (e) { /* recipe not ready */ }
    // slow updates (4 Hz)
    this.slowT -= dt;
    if (this.slowT <= 0) {
      this.slowT = 0.25;
      updateRoute(g);
      const [px, pz] = playerPos(g);
      let name: string | null = null; try { name = layersFor(g.recipe).streetName(px, pz); } catch { /* */ }
      this.street.textContent = name ?? '';
      const time = safe(() => g.sky.time, NaN);
      if (isFinite(time)) { const hh = Math.floor(time) % 24, mm = Math.floor((time % 1) * 60); this.clock.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`; }
    }
  }
}
