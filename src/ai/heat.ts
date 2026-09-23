// Wanted level (heat) state machine. Pure logic; the police module drives it with sightings.
import type { Vec2 } from '../core/types.ts';

export interface HeatTuning {
  /** Seconds unseen required to drop from level L to L-1 (index = L). */
  decay: number[];
  /** Seconds of continuous police pursuit (spotted) at level L before escalating to L+1. */
  escalate: number[];
  /** Min seconds between heat bumps from the same kind of source. */
  bumpCooldown: { camera: number; npc: number; police: number };
  /** Max level reachable through NPC calls alone. */
  npcCap: number;
  /** Max level reachable through camera reports alone. */
  cameraCap: number;
}

export const HEAT_TUNING: HeatTuning = {
  decay: [0, 14, 20, 26, 34, 42],
  escalate: [0, 22, 30, 40, 55, Infinity],
  bumpCooldown: { camera: 12, npc: 15, police: 8 },
  npcCap: 3,
  cameraCap: 4,
};

export interface Witness { source: 'camera' | 'npc' | 'police'; p: Vec2; confidence: number; delay: number; sourceId?: string }

export type HeatEmit = (type: 'heatChanged' | 'heatZero', payload: any) => void;

export interface WitnessResult {
  /** true when the report raised heat */
  raised: boolean;
  /** low-confidence report: send one investigating unit without heat */
  investigate: boolean;
  p: Vec2;
}

export class HeatState {
  level = 0;
  /** Evasion progress 0..1 within the current level (1 = about to drop a level). 0 while spotted. */
  progress = 0;
  lastKnown: Vec2 | null = null;
  spotted = false;
  arrestMeter = 0;
  /** Seconds since police/cameras last saw the player. */
  unseen = 0;
  /** Seconds of continuous pursuit at this level. */
  pursuitTime = 0;
  /** Game time (s). */
  now = 0;
  /** Game time of the last heat raise (police use it to know a fresh incident happened). */
  lastRaise = -1e9;
  private lastBump = { camera: -1e9, npc: -1e9, police: -1e9 };
  private pending: { at: number; w: Witness }[] = [];
  /** Called for every applied witness report (after delay). */
  onWitness?: (r: WitnessResult, w: Witness) => void;

  private emit: HeatEmit;
  tuning: HeatTuning;
  constructor(emit: HeatEmit, tuning: HeatTuning = HEAT_TUNING) { this.emit = emit; this.tuning = tuning; }

  private setLevel(n: number) {
    n = Math.max(0, Math.min(5, Math.round(n)));
    const prev = this.level;
    if (n === prev) return;
    this.level = n;
    this.pursuitTime = 0;
    this.unseen = 0;
    this.progress = 0;
    if (n > prev) this.lastRaise = this.now;
    this.emit('heatChanged', { heat: n, prev });
    if (n === 0) {
      this.lastKnown = null;
      this.spotted = false;
      this.arrestMeter = 0;
      this.emit('heatZero', {});
    }
  }

  add(amount: number, p: Vec2) {
    this.lastKnown = [p[0], p[1]];
    this.unseen = 0;
    this.progress = 0;
    this.setLevel(Math.min(5, this.level + amount));
  }

  clear() {
    this.pending.length = 0;
    this.pursuitTime = 0;
    this.unseen = 0;
    this.progress = 0;
    this.arrestMeter = 0;
    this.spotted = false;
    const had = this.level;
    this.level = 0;
    this.lastKnown = null;
    if (had) this.emit('heatChanged', { heat: 0, prev: had });
  }

  /** Queue a witness report (applied after its delay). */
  witness(w: Witness) {
    if (w.delay > 0) this.pending.push({ at: this.now + w.delay, w });
    else this.applyWitness(w);
  }

  applyWitness(w: Witness): WitnessResult {
    const t = this.tuning;
    const res: WitnessResult = { raised: false, investigate: false, p: w.p };
    const since = this.now - this.lastBump[w.source];
    const before = this.level;
    if (w.source === 'camera') {
      const floor = w.confidence >= 0.85 ? 2 : 1;
      if (this.level < floor) this.setLevel(floor);
      else if (since > t.bumpCooldown.camera && this.level < t.cameraCap) this.setLevel(this.level + 1);
      this.lastKnown = [w.p[0], w.p[1]];
      this.unseen = 0;
    } else if (w.source === 'npc') {
      if (w.confidence < 0.4) {
        res.investigate = true;
        this.onWitness?.(res, w);
        return res;
      }
      if (this.level === 0) this.setLevel(1);
      else if (since > t.bumpCooldown.npc && this.level < t.npcCap) this.setLevel(this.level + 1);
      this.lastKnown = [w.p[0], w.p[1]];
      this.unseen = Math.min(this.unseen, 2);
    } else {
      if (this.level === 0) this.setLevel(1);
      else if (since > t.bumpCooldown.police) this.setLevel(this.level + 1);
      this.lastKnown = [w.p[0], w.p[1]];
      this.unseen = 0;
    }
    res.raised = this.level > before;
    if (res.raised) this.lastBump[w.source] = this.now;
    this.onWitness?.(res, w);
    return res;
  }

  /** Police / heli / camera currently see the player at p. */
  seen(p: Vec2) {
    this.lastKnown = [p[0], p[1]];
    this.unseen = 0;
    this.progress = 0;
  }

  /**
   * Advance time. `spottedNow`: police (incl. heli) see the player this tick.
   * `camSeen`: a camera saw the player this tick (resets evasion but does not escalate).
   */
  update(dt: number, spottedNow: boolean, playerP?: Vec2, camSeen = false) {
    this.now += dt;
    if (this.pending.length) {
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].at <= this.now) {
          const w = this.pending[i].w;
          this.pending.splice(i, 1);
          this.applyWitness(w);
        }
      }
    }
    this.spotted = spottedNow && this.level > 0;
    if (this.level === 0) { this.progress = 0; this.pursuitTime = 0; return; }
    if (spottedNow || camSeen) {
      if (playerP) this.seen(playerP);
      if (spottedNow) {
        this.pursuitTime += dt;
        if (this.pursuitTime >= this.tuning.escalate[this.level]) this.setLevel(this.level + 1);
      }
      return;
    }
    this.pursuitTime = Math.max(0, this.pursuitTime - dt * 0.5);
    this.unseen += dt;
    const need = this.tuning.decay[this.level];
    this.progress = Math.min(1, this.unseen / need);
    if (this.unseen >= need) this.setLevel(this.level - 1);
  }
}
