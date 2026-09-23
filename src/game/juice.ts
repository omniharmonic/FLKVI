// Game feel: slow-motion + camera shake beats around takedowns (listens to events; no other module state).
import type { Game, System } from '../core/game';
import type { CameraRig } from './camera';
import type { Player } from './player';

const SLOWMO_SCALE = 0.4;
const SLOWMO_HOLD = 1.1; // real seconds at full slow-mo
const SLOWMO_EASE = 0.6; // real seconds back to normal speed

export class Juice implements System {
  name = 'juice';
  order = 95;
  private slowT = -1; // real seconds since slow-mo started, -1 = off
  private last = performance.now();

  constructor(private g: Game, private cam: CameraRig, private player: Player) {
    const ev = g.events;
    ev.on('takedown', (e) => {
      if (e.mode === 'cut') { this.slowT = 0; this.cam.addTrauma(0.35); }
      else this.cam.addTrauma(0.12);
    });
    ev.on('noise', (n) => {
      if (n.kind !== 'metal-fall' && n.kind !== 'crash') return;
      const p = this.player.position;
      const d = Math.hypot(n.p[0] - p.x, n.p[1] - p.z);
      const k = Math.max(0, 1 - d / Math.max(20, n.radius)) * (n.kind === 'metal-fall' ? 0.75 : 0.5);
      if (k > 0.02) this.cam.addTrauma(k);
    });
    ev.on('arrested', () => this.stop());
    ev.on('runStart', () => this.stop());
    ev.on('playerSpotted', (e) => { if (e.by === 'police' && this.g.heat?.level >= 3) this.cam.addTrauma(0.04); });
  }

  private stop() { this.slowT = -1; this.g.timeScale = 1; }

  // Runs on real time so the slow-mo itself doesn't stretch its own duration.
  update() {
    const now = performance.now();
    const real = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.slowT < 0) return;
    if (this.g.paused) return;
    this.slowT += real;
    const t = this.slowT;
    if (t < SLOWMO_HOLD) this.g.timeScale = t < 0.12 ? 1 - (1 - SLOWMO_SCALE) * (t / 0.12) : SLOWMO_SCALE;
    else if (t < SLOWMO_HOLD + SLOWMO_EASE) { const k = (t - SLOWMO_HOLD) / SLOWMO_EASE; this.g.timeScale = SLOWMO_SCALE + (1 - SLOWMO_SCALE) * k * k * (3 - 2 * k); }
    else this.stop();
  }
}
