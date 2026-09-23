// First-run onboarding: short contextual objective hints that teach the loop one step at a time.
// Each hint shows at most once (ever), can be dismissed (× or Backspace), and completes itself when the
// player does the thing. Seen hints persist in localStorage (guarded: private mode / blocked storage).
import type { Game } from '../core/game';
import { h, safe } from './dom';

type HintId = 'map' | 'approach' | 'act' | 'seen' | 'bank';

interface HintDef {
  id: HintId;
  html: string;
  /** Hint becomes eligible when this returns true (checked ~5 Hz). */
  when(): boolean;
  /** Hint is complete (hide + mark seen) when this returns true. */
  done(): boolean;
  /** Auto-hide after this many seconds on screen (still marked seen). */
  ttl: number;
}

const KEY = 'groundtruth.hints.v1';
function loadSeen(): Set<string> {
  try { const r = localStorage.getItem(KEY); return new Set(r ? (JSON.parse(r) as string[]) : []); } catch { return new Set(); }
}
function saveSeen(s: Set<string>) {
  try { localStorage.setItem(KEY, JSON.stringify([...s])); } catch { /* storage unavailable */ }
}

export class Hints {
  readonly el: HTMLElement;
  private seen = loadSeen();
  private cur: { def: HintDef; t: number } | null = null;
  private defs: HintDef[];
  private acc = 0;
  private playT = 0;
  private prompt: string | null = null;
  private heatSeen = false;
  private hotSeen = false;
  private startedAct = false;
  private banked = false;

  constructor(private g: Game) {
    this.el = h('div', { class: 'hud-hint' });
    const ev = g.events;
    ev.on('prompt', ({ text }) => { this.prompt = text; });
    ev.on('takedownStart', () => { this.startedAct = true; });
    ev.on('heatChanged', ({ heat }) => { if (heat > 0) this.heatSeen = true; });
    ev.on('score', (s) => { if (s.hot > 0) this.hotSeen = true; });
    ev.on('banked', () => { this.banked = true; });
    addEventListener('keydown', (e) => { if (e.code === 'Backspace' && this.cur) this.finish(); });
    const sv = () => g.surveillance;
    const takedownMode = () => g.mode !== 'freeroam';
    const heat = () => safe(() => g.heat.level, 0);
    this.defs = [
      {
        id: 'map', ttl: 25,
        html: 'Open the camera map <b>M</b> and pick a target',
        when: () => takedownMode() && this.playT > 2.5 && !sv()?.selectedTarget,
        done: () => !!sv()?.selectedTarget || this.startedAct,
      },
      {
        id: 'approach', ttl: 22,
        html: 'Get close to the pole: follow the <i>orange route</i> and the beacon',
        when: () => takedownMode() && !!sv()?.selectedTarget && (sv()?.targetDistance ?? 0) > 12,
        done: () => (sv()?.targetDistance ?? 99) < 6 || !!this.prompt?.includes('Hold') || this.startedAct,
      },
      {
        id: 'act', ttl: 20,
        html: 'Hold <b>E</b> to disable (quiet) or <b>R</b> to cut (loud, more points)',
        when: () => takedownMode() && !!this.prompt?.includes('Hold E'),
        done: () => this.startedAct,
      },
      {
        id: 'bank', ttl: 10,
        html: 'Lie low to bank your points: no heat = points are safe',
        when: () => takedownMode() && this.hotSeen && (sv()?.hot ?? 0) > 0,
        done: () => this.banked || (sv()?.hot ?? 0) === 0,
      },
      {
        id: 'seen', ttl: 9,
        html: 'You\'ve been reported. Break line of sight with police, cameras and witnesses to lose heat',
        when: () => takedownMode() && this.heatSeen && heat() > 0,
        done: () => heat() === 0,
      },
    ];
    this.el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.x')) this.finish(); });
  }

  /** Called every animation frame by the HUD (dt real seconds). */
  update(dt: number) {
    const g = this.g;
    if (g.paused) return;
    this.playT += dt;
    if (this.cur) {
      this.cur.t += dt;
      if (this.cur.def.done() || this.cur.t > this.cur.def.ttl) this.finish();
      return;
    }
    this.acc -= dt;
    if (this.acc > 0) return;
    this.acc = 0.2;
    for (const d of this.defs) {
      if (this.seen.has(d.id)) continue;
      let ok = false;
      try { ok = d.when() && !d.done(); } catch { ok = false; }
      if (ok) { this.show(d); break; }
    }
  }

  private show(def: HintDef) {
    this.cur = { def, t: 0 };
    this.el.replaceChildren(
      h('span', { class: 'k' }, 'OBJECTIVE'),
      h('span', { class: 'm', html: def.html }),
      h('button', { class: 'x', title: 'Dismiss (Backspace)' }, '×'),
    );
    this.el.classList.remove('on'); void this.el.offsetWidth; this.el.classList.add('on');
  }

  private finish() {
    if (!this.cur) return;
    this.seen.add(this.cur.def.id);
    saveSeen(this.seen);
    this.cur = null;
    this.el.classList.remove('on');
  }

  /** Debug: forget all seen hints. */
  reset() { this.seen.clear(); saveSeen(this.seen); }
}
