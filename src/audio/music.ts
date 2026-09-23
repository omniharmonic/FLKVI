// Adaptive music bed driven by heat: a slow tension pad always, a bass pulse from heat 1-2, percussion at 2+,
// driving snare/hats and faster tempo at 4+. Built live from oscillators + synthesized drum buffers.
import { audioCtx, getBuses } from './engine';
import { bufferNow } from './synth';

// Chords as semitone offsets from A1 (55 Hz). Minor, unresolved: Am(add9) → Fmaj7 → Dm9 → Esus
const CHORDS = [
  [0, 7, 12, 14, 19], // A E A B E
  [-4, 3, 8, 12, 16], // F C F A C#? (F maj7-ish)
  [-7, 5, 8, 12, 15], // D ... Dm9-ish
  [-5, 7, 9, 14, 19], // E sus
];
const hz = (semi: number, base = 55) => base * Math.pow(2, semi / 12);

export class Music {
  private ctx = audioCtx();
  private out: GainNode;
  private padGain: GainNode;
  private padFilter: BiquadFilterNode;
  private voices: OscillatorNode[][] = [];
  private pulseGain: GainNode;
  private percGain: GainNode;
  private intensity = 0; // smoothed heat 0..5
  private target = 0;
  private running = false;
  private chord = 0;
  private nextNote = 0;
  private step = 0;
  private timer: number | null = null;
  private lastChordChange = 0;

  constructor() {
    const ctx = this.ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(getBuses().music);
    this.padFilter = ctx.createBiquadFilter(); this.padFilter.type = 'lowpass'; this.padFilter.frequency.value = 700; this.padFilter.Q.value = 0.8;
    this.padGain = ctx.createGain(); this.padGain.gain.value = 0.12;
    this.padFilter.connect(this.padGain); this.padGain.connect(this.out);
    // slow filter LFO
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05; const lg = ctx.createGain(); lg.gain.value = 250; lfo.connect(lg); lg.connect(this.padFilter.frequency); lfo.start();
    for (const semi of CHORDS[0]) {
      const pair: OscillatorNode[] = [];
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(semi, 110); o.detune.value = det;
        const g = ctx.createGain(); g.gain.value = 0.08; o.connect(g); g.connect(this.padFilter); o.start(); pair.push(o);
      }
      this.voices.push(pair);
    }
    // sub drone
    const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 55; const sg = ctx.createGain(); sg.gain.value = 0.25; sub.connect(sg); sg.connect(this.padGain); sub.start();
    this.voices.push([sub]);
    this.pulseGain = ctx.createGain(); this.pulseGain.gain.value = 0; this.pulseGain.connect(this.out);
    this.percGain = ctx.createGain(); this.percGain.gain.value = 0; this.percGain.connect(this.out);
  }

  setHeat(level: number) { this.target = Math.max(0, Math.min(5, level)); }

  /** Fade the bed in (gameplay) or out (menus). */
  setActive(on: boolean, fade = 2) {
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t); this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(on ? 1 : 0, t + fade);
    if (on && !this.running) {
      this.running = true; this.nextNote = t + 0.1;
      this.timer = window.setInterval(() => this.schedule(), 25);
    }
  }

  private setChord(i: number, t: number) {
    this.chord = i;
    const semis = CHORDS[i];
    semis.forEach((s, k) => this.voices[k].forEach((o) => o.frequency.setTargetAtTime(hz(s, 110), t, 0.6)));
    this.voices[semis.length][0].frequency.setTargetAtTime(hz(semis[0]), t, 0.6);
  }

  private schedule() {
    const ctx = this.ctx; const now = ctx.currentTime;
    this.intensity += (this.target - this.intensity) * 0.02;
    const I = this.intensity;
    // mix targets
    this.pulseGain.gain.setTargetAtTime(I < 0.8 ? 0 : Math.min(0.55, 0.18 + (I - 0.8) * 0.25), now, 0.5);
    this.percGain.gain.setTargetAtTime(I < 1.7 ? 0 : Math.min(0.7, 0.3 + (I - 1.7) * 0.2), now, 0.5);
    this.padGain.gain.setTargetAtTime(0.12 - Math.min(0.04, I * 0.01), now, 1);
    if (I > 3.5) this.padFilter.frequency.setTargetAtTime(1300, now, 1); else this.padFilter.frequency.setTargetAtTime(700, now, 1);
    const bpm = I >= 3.5 ? 124 : I >= 1.7 ? 108 : 92;
    const sixteenth = 60 / bpm / 4;
    while (this.nextNote < now + 0.12) {
      const t = this.nextNote; const s = this.step % 16;
      const bar = Math.floor(this.step / 16);
      if (s === 0 && bar % 2 === 0 && t - this.lastChordChange > 3) { this.setChord((bar / 2) % CHORDS.length, t); this.lastChordChange = t; }
      // bass pulse on 8ths
      if (I >= 0.8 && s % 2 === 0) this.bass(t, hz(CHORDS[this.chord][0] - 12 + (s === 6 || s === 14 ? 12 : 0)), sixteenth * 1.6);
      if (I >= 1.7) {
        if (s === 0 || s === 8 || (I >= 3.5 && (s === 10))) this.drum('kick', t, 0.9);
        if (s % 2 === 0 || I >= 3.5) this.drum('hat', t, s % 4 === 2 ? 0.35 : 0.16);
        if (I >= 3.5 && (s === 4 || s === 12)) this.drum('snare', t, 0.55);
      }
      this.nextNote += sixteenth; this.step++;
    }
  }

  private bass(t: number, f: number, dur: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.Q.value = 6; fl.frequency.setValueAtTime(900, t); fl.frequency.exponentialRampToValueAtTime(140, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.35, t + 0.006); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(fl); fl.connect(g); g.connect(this.pulseGain); o.start(t); o.stop(t + dur + 0.05);
  }

  private drum(name: string, t: number, vol: number) {
    const b = bufferNow(name); if (!b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; const g = this.ctx.createGain(); g.gain.value = vol;
    s.connect(g); g.connect(this.percGain); s.start(t);
  }
}
