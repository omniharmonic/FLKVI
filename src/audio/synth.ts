// Procedural sound library: every named sound is rendered once to an AudioBuffer with OfflineAudioContext.
// Loops are rendered slightly long and folded (tail crossfaded into head) so they repeat seamlessly.
import { rng } from '../core/geo';

const SR = 44100;
type Build = (oc: OfflineAudioContext, out: AudioNode, dur: number) => void;
interface Def { dur: number; loop?: boolean; build: Build; gain?: number; /** loop is already sample-exact (no crossfade fold) */ exact?: boolean }

// ---------- helpers ----------
function noise(oc: BaseAudioContext, dur: number, color: 'white' | 'pink' | 'brown' = 'white', seed = 1): AudioBufferSourceNode {
  const len = Math.ceil(dur * oc.sampleRate);
  const b = oc.createBuffer(1, len, oc.sampleRate);
  const d = b.getChannelData(0);
  const r = rng(seed);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = r() * 2 - 1;
    if (color === 'white') d[i] = w;
    else if (color === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2; }
    else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
  }
  const s = oc.createBufferSource(); s.buffer = b; return s;
}
function osc(oc: BaseAudioContext, type: OscillatorType, f: number): OscillatorNode { const o = oc.createOscillator(); o.type = type; o.frequency.value = f; return o; }
function gain(oc: BaseAudioContext, v = 1): GainNode { const g = oc.createGain(); g.gain.value = v; return g; }
function filt(oc: BaseAudioContext, type: BiquadFilterType, f: number, q = 0.707): BiquadFilterNode { const b = oc.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function chain(...nodes: AudioNode[]): AudioNode { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }
/** Percussive envelope: attack then exponential decay. */
function perc(g: GainNode, t0: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.setTargetAtTime(0.0001, t0 + attack, decay / 4);
}
function shaper(oc: BaseAudioContext, k: number): WaveShaperNode {
  const w = oc.createWaveShaper(); const n = 1024; const c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  w.curve = c; return w;
}
function play(src: AudioScheduledSourceNode, t0 = 0, t1?: number) { src.start(t0); if (t1 !== undefined) src.stop(t1); }
function tone(oc: BaseAudioContext, out: AudioNode, type: OscillatorType, f: number, t0: number, peak: number, attack: number, decay: number, f1?: number) {
  const o = osc(oc, type, f); const g = gain(oc, 0);
  if (f1) { o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + attack + decay); }
  perc(g, t0, peak, attack, decay); chain(o, g, out); play(o, t0, t0 + attack + decay * 2 + 0.05);
}

// ---------- definitions ----------
const XF = 0.12; // loop crossfade seconds

const defs: Record<string, Def> = {
  footstep: { dur: 0.2, build(oc, out) {
    const n = noise(oc, 0.2, 'pink', 3); const g = gain(oc, 0); perc(g, 0.002, 0.9, 0.003, 0.07);
    chain(n, filt(oc, 'bandpass', 900, 0.9), filt(oc, 'lowpass', 2400), g, out); play(n);
    const n2 = noise(oc, 0.2, 'white', 4); const g2 = gain(oc, 0); perc(g2, 0.004, 0.18, 0.002, 0.03);
    chain(n2, filt(oc, 'highpass', 3000), g2, out); play(n2);
    tone(oc, out, 'sine', 95, 0, 0.7, 0.004, 0.05, 60);
  } },
  engine: { dur: 1, loop: true, gain: 0.8, build(oc, out) {
    const lp = filt(oc, 'lowpass', 520, 2.5); const sh = shaper(oc, 2.2); const g = gain(oc, 0.5);
    chain(lp, sh, g, out);
    for (const [f, t, v] of [[30, 'sawtooth', 0.6], [60, 'square', 0.25], [90, 'sawtooth', 0.22], [15, 'sine', 0.5], [120, 'triangle', 0.1]] as [number, OscillatorType, number][]) {
      const o = osc(oc, t, f); const og = gain(oc, v); chain(o, og, lp); play(o);
    }
    // combustion "chug": band noise amplitude-modulated at firing rate
    const n = noise(oc, 1 + XF, 'brown', 7); const am = gain(oc, 0.3); const lfo = osc(oc, 'sine', 30); const lfoG = gain(oc, 0.3);
    chain(lfo, lfoG); lfoG.connect(am.gain); chain(n, filt(oc, 'bandpass', 180, 1.2), am, out); play(n); play(lfo);
  } },
  'tire-squeal': { dur: 1.2, loop: true, gain: 0.5, build(oc, out) {
    for (const [f, v] of [[1180, 0.4], [1790, 0.2], [2450, 0.08]]) {
      const o = osc(oc, 'sine', f); const vib = osc(oc, 'sine', 6.5); const vg = gain(oc, f * 0.03); chain(vib, vg); vg.connect(o.frequency);
      const g = gain(oc, v); chain(o, g, out); play(o); play(vib);
    }
    const n = noise(oc, 1.2 + XF, 'white', 9); chain(n, filt(oc, 'bandpass', 2600, 2.5), gain(oc, 0.35), out); play(n);
  } },
  crash: { dur: 1.8, build(oc, out) {
    const n = noise(oc, 1.8, 'white', 11); const lp = filt(oc, 'lowpass', 7000); lp.frequency.setTargetAtTime(700, 0.02, 0.25);
    const g = gain(oc, 0); perc(g, 0, 1, 0.004, 0.9); chain(n, lp, g, out); play(n);
    tone(oc, out, 'sine', 120, 0, 1, 0.005, 0.35, 40);
    [[340, 0.25, 0.6], [862, 0.18, 0.45], [1433, 0.12, 0.35], [2210, 0.08, 0.25], [3120, 0.05, 0.2]].forEach(([f, v, d]) => tone(oc, out, 'sine', f, 0.005, v, 0.002, d));
    const r = rng(12);
    for (let i = 0; i < 14; i++) { // glass/debris tinkles
      const t = 0.08 + r() * 0.7; const gn = noise(oc, 0.06, 'white', 20 + i); const gg = gain(oc, 0); perc(gg, t, 0.25 * r(), 0.001, 0.03);
      chain(gn, filt(oc, 'bandpass', 4000 + r() * 5000, 6), gg, out); play(gn, t);
    }
  } },
  door: { dur: 0.4, build(oc, out) {
    tone(oc, out, 'sine', 120, 0.03, 0.9, 0.004, 0.1, 55);
    for (const [t, f] of [[0, 2600], [0.03, 1600]]) { const n = noise(oc, 0.05, 'white', 30 + t * 100); const g = gain(oc, 0); perc(g, t, 0.5, 0.001, 0.02); chain(n, filt(oc, 'bandpass', f, 3), g, out); play(n, t); }
    const n = noise(oc, 0.3, 'brown', 33); const g = gain(oc, 0); perc(g, 0.03, 0.6, 0.004, 0.12); chain(n, filt(oc, 'lowpass', 500), g, out); play(n, 0.03);
  } },
  horn: { dur: 0.7, loop: true, gain: 0.45, build(oc, out) {
    const lp = filt(oc, 'lowpass', 2600, 1); const pk = filt(oc, 'peaking', 1100, 2); pk.gain.value = 8; const sh = shaper(oc, 1.8);
    chain(lp, pk, sh, out);
    for (const f of [420, 500]) { const o = osc(oc, 'sawtooth', f); chain(o, gain(oc, 0.35), lp); play(o); }
  } },
  shout: { dur: 0.9, gain: 0.7, build(oc, out) {
    // Two barked syllables ("STOP!" / "HEY!"): buzzy glottal source through vowel formants, pitch falling.
    const f1 = filt(oc, 'bandpass', 750, 5); const f2 = filt(oc, 'bandpass', 1250, 6); const f3 = filt(oc, 'bandpass', 2600, 8);
    const sum = gain(oc, 1); const sh = shaper(oc, 2.2); chain(sum, sh, out);
    for (const f of [f1, f2, f3]) f.connect(sum);
    for (const [t, len, p0, p1] of [[0.02, 0.28, 230, 170], [0.42, 0.38, 250, 160]]) {
      const src = osc(oc, 'sawtooth', p0); src.frequency.setValueAtTime(p0, t); src.frequency.exponentialRampToValueAtTime(p1, t + len);
      const g = gain(oc, 0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.9, t + 0.03); g.gain.setTargetAtTime(0.0001, t + len * 0.7, 0.05);
      chain(src, g); g.connect(f1); g.connect(f2); g.connect(f3); play(src, t, t + len + 0.15);
      const n = noise(oc, 0.08, 'white', 77 + t * 10); const ng = gain(oc, 0); perc(ng, t, 0.25, 0.002, 0.05); chain(n, filt(oc, 'highpass', 3000), ng, out); play(n, t);
    }
  } },
  siren: { dur: 4, loop: true, exact: true, gain: 0.55, build(oc, out) {
    // Wail: integral of f(t) over 4 s = 3800 whole cycles so the loop is phase-continuous.
    const N = 512; const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) curve[i] = 950 + 400 * Math.sin((2 * Math.PI * i) / (N - 1) - Math.PI / 2);
    const bp = filt(oc, 'bandpass', 1300, 0.6); const sh = shaper(oc, 2.5); const lp = filt(oc, 'lowpass', 4200);
    chain(sh, bp, lp, out);
    for (const [t, v, m] of [['square', 0.25, 1], ['triangle', 0.5, 1], ['sine', 0.2, 2]] as [OscillatorType, number, number][]) {
      const o = osc(oc, t, 0); o.frequency.setValueCurveAtTime(curve.map((f) => f * m), 0, 4); chain(o, gain(oc, v), sh); play(o, 0, 4);
    }
  } },
  grinder: { dur: 2, loop: true, gain: 0.6, build(oc, out) {
    const whine = osc(oc, 'sawtooth', 3000); const fm = osc(oc, 'sine', 4); const fmg = gain(oc, 35); chain(fm, fmg); fmg.connect(whine.frequency);
    chain(whine, filt(oc, 'bandpass', 3000, 3), gain(oc, 0.35), out); play(whine); play(fm);
    const w2 = osc(oc, 'sine', 6000); chain(w2, gain(oc, 0.08), out); play(w2);
    const hum = osc(oc, 'sawtooth', 190); chain(hum, filt(oc, 'lowpass', 700), gain(oc, 0.25), out); play(hum);
    // metal scream: harsh band noise with fluttering amplitude
    const n = noise(oc, 2 + XF, 'white', 41); const am = gain(oc, 0.4); const lfo = osc(oc, 'sawtooth', 13); const lg = gain(oc, 0.25); chain(lfo, lg); lg.connect(am.gain);
    chain(n, filt(oc, 'bandpass', 4800, 1.6), shaper(oc, 3), am, out); play(n); play(lfo);
    const n2 = noise(oc, 2 + XF, 'white', 42); chain(n2, filt(oc, 'highpass', 8000), gain(oc, 0.12), out); play(n2);
  } },
  spray: { dur: 1, loop: true, gain: 0.45, build(oc, out) {
    const n = noise(oc, 1 + XF, 'white', 51); const am = gain(oc, 0.8); const lfo = osc(oc, 'sine', 9); const lg = gain(oc, 0.08); chain(lfo, lg); lg.connect(am.gain);
    chain(n, filt(oc, 'highpass', 3200), filt(oc, 'lowpass', 11000), filt(oc, 'peaking', 6500, 1), am, out); play(n); play(lfo);
  } },
  'metal-fall': { dur: 3, build(oc, out) {
    const hit = (t0: number, amp: number, detune: number, seed: number) => {
      const n = noise(oc, 0.4, 'white', seed); const g = gain(oc, 0); perc(g, t0, amp * 0.9, 0.002, 0.18); chain(n, filt(oc, 'lowpass', 3500), g, out); play(n, t0);
      tone(oc, out, 'sine', 70 * detune, t0, amp, 0.004, 0.4, 38);
      const partials = [157, 389, 702, 1113, 1631, 2410, 3350]; const decays = [2.4, 1.8, 1.3, 1.0, 0.7, 0.5, 0.35]; const amps = [0.35, 0.3, 0.22, 0.18, 0.12, 0.09, 0.05];
      partials.forEach((f, i) => tone(oc, out, 'sine', f * detune, t0 + 0.002, amps[i] * amp, 0.002, decays[i]));
    };
    hit(0, 1, 1, 61); hit(0.42, 0.45, 1.03, 62); hit(0.68, 0.18, 0.98, 63);
  } },
  alert: { dur: 1.2, gain: 0.8, build(oc, out) {
    tone(oc, out, 'sine', 70, 0, 1, 0.005, 0.5, 42);
    const lp = filt(oc, 'lowpass', 5000, 1.5); lp.frequency.setTargetAtTime(500, 0.05, 0.25); const g = gain(oc, 0); perc(g, 0, 0.45, 0.01, 0.7);
    chain(lp, g, out);
    for (const f of [220, 233.1, 311.1, 440, 466.2]) { const o = osc(oc, 'sawtooth', f); chain(o, gain(oc, 0.2), lp); play(o, 0, 1.2); }
    tone(oc, out, 'square', 1760, 0.0, 0.06, 0.003, 0.06); tone(oc, out, 'square', 1318.5, 0.1, 0.06, 0.003, 0.08);
  } },
  bank: { dur: 2, gain: 0.8, build(oc, out) {
    const notes = [1046.5, 1318.5, 1568, 2093];
    notes.forEach((f, i) => { const t = i * 0.075; tone(oc, out, 'sine', f, t, 0.35, 0.004, 0.9); tone(oc, out, 'sine', f * 2.76, t, 0.07, 0.002, 0.3); tone(oc, out, 'sine', f * 5.4, t, 0.03, 0.002, 0.15); });
    tone(oc, out, 'triangle', 523.25, 0.3, 0.2, 0.01, 1.2);
    const n = noise(oc, 1.2, 'white', 71); const g = gain(oc, 0); g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(0.06, 0.25); g.gain.linearRampToValueAtTime(0, 1.2);
    chain(n, filt(oc, 'highpass', 7000), g, out); play(n);
  } },
  busted: { dur: 2.6, gain: 0.9, build(oc, out) {
    tone(oc, out, 'sine', 90, 0, 1, 0.005, 0.9, 30);
    const n = noise(oc, 1, 'white', 81); const ng = gain(oc, 0); perc(ng, 0, 0.5, 0.003, 0.3); chain(n, filt(oc, 'lowpass', 2500), ng, out); play(n);
    const lp = filt(oc, 'lowpass', 1600, 2); lp.frequency.setTargetAtTime(260, 0.1, 0.6); const g = gain(oc, 0); perc(g, 0, 0.5, 0.02, 2.0); const sh = shaper(oc, 2);
    chain(lp, sh, g, out);
    for (const [f, d] of [[55, 0], [55, 7], [65.41, -5], [82.41, 4], [110, -8]]) { const o = osc(oc, 'sawtooth', f); o.detune.value = d; o.frequency.setValueAtTime(f, 0.2); o.frequency.exponentialRampToValueAtTime(f * 0.94, 2.4); chain(o, gain(oc, 0.25), lp); play(o, 0, 2.6); }
  } },
  'ui-click': { dur: 0.08, gain: 0.5, build(oc, out) {
    tone(oc, out, 'sine', 2600, 0, 0.5, 0.001, 0.03, 1500);
    const n = noise(oc, 0.02, 'white', 91); const g = gain(oc, 0); perc(g, 0, 0.25, 0.0005, 0.008); chain(n, filt(oc, 'highpass', 4000), g, out); play(n);
  } },
  'ui-hover': { dur: 0.06, gain: 0.25, build(oc, out) { tone(oc, out, 'sine', 1900, 0, 0.3, 0.002, 0.025, 2300); } },
  'phone-dial': { dur: 1.4, gain: 0.8, build(oc, out) {
    const rows = [697, 770, 852, 941], cols = [1209, 1336, 1477];
    const digits = [[0, 1], [2, 0], [1, 2], [3, 1], [0, 0], [2, 2]];
    digits.forEach(([r, c], i) => { const t = i * 0.2; for (const f of [rows[r], cols[c]]) { const o = osc(oc, 'sine', f); const g = gain(oc, 0); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.3, t + 0.005); g.gain.setValueAtTime(0.3, t + 0.11); g.gain.linearRampToValueAtTime(0, t + 0.12); chain(o, g, out); play(o, t, t + 0.13); } });
  } },
  helicopter: { dur: 1, loop: true, gain: 0.7, build(oc, out) {
    // 11 blade passes per second → integer count per loop.
    const n = noise(oc, 1 + XF, 'brown', 101); const g = gain(oc, 0.05); chain(n, filt(oc, 'lowpass', 380), g, out); play(n);
    for (let i = 0; i < 12; i++) { const t = i / 11; g.gain.setValueAtTime(0.05, t); g.gain.linearRampToValueAtTime(1, t + 0.012); g.gain.setTargetAtTime(0.05, t + 0.012, 0.025); }
    const hum = osc(oc, 'sawtooth', 22); chain(hum, filt(oc, 'lowpass', 120), gain(oc, 0.35), out); play(hum);
    const tail = osc(oc, 'triangle', 88); const tg = gain(oc, 0.05); chain(tail, tg, out); play(tail);
    const tn = noise(oc, 1 + XF, 'white', 102); chain(tn, filt(oc, 'bandpass', 1600, 2), gain(oc, 0.04), out); play(tn);
  } },
  'camera-beep': { dur: 0.3, gain: 1.6, build(oc, out) { tone(oc, out, 'sine', 2637, 0, 0.3, 0.002, 0.04); tone(oc, out, 'sine', 2637, 0.12, 0.3, 0.002, 0.04); } },

  // ---- internal: music drums + ambience beds ----
  kick: { dur: 0.5, build(oc, out) { tone(oc, out, 'sine', 140, 0, 1, 0.002, 0.22, 42); const n = noise(oc, 0.03, 'white', 111); const g = gain(oc, 0); perc(g, 0, 0.2, 0.0005, 0.01); chain(n, filt(oc, 'lowpass', 3000), g, out); play(n); } },
  hat: { dur: 0.12, build(oc, out) { const n = noise(oc, 0.12, 'white', 121); const g = gain(oc, 0); perc(g, 0, 0.5, 0.001, 0.035); chain(n, filt(oc, 'highpass', 8000), g, out); play(n); } },
  snare: { dur: 0.35, build(oc, out) { const n = noise(oc, 0.35, 'white', 131); const g = gain(oc, 0); perc(g, 0, 0.6, 0.001, 0.14); chain(n, filt(oc, 'bandpass', 2200, 0.8), g, out); play(n); tone(oc, out, 'triangle', 190, 0, 0.4, 0.001, 0.06, 150); } },
  'amb-city': { dur: 8, loop: true, build(oc, out) {
    const n = noise(oc, 8 + XF, 'brown', 141); chain(n, filt(oc, 'lowpass', 260), gain(oc, 0.9), out); play(n);
    const p = noise(oc, 8 + XF, 'pink', 142); const am = gain(oc, 0.12); const lfo = osc(oc, 'sine', 0.25); const lg = gain(oc, 0.06); chain(lfo, lg); lg.connect(am.gain);
    chain(p, filt(oc, 'bandpass', 700, 0.6), am, out); play(p); play(lfo);
    // distant passing car swells
    const r = rng(143);
    for (let i = 0; i < 3; i++) { const t = 0.5 + i * 2.6 + r(); const cn = noise(oc, 3, 'pink', 150 + i); const g = gain(oc, 0); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 1.2); g.gain.linearRampToValueAtTime(0, t + 2.6); chain(cn, filt(oc, 'bandpass', 420 + r() * 300, 1), g, out); play(cn, t); }
  } },
  'amb-birds': { dur: 10, loop: true, build(oc, out) {
    const r = rng(161);
    for (let i = 0; i < 22; i++) {
      const t0 = r() * 9.3; const base = 2600 + r() * 2600; const reps = 1 + Math.floor(r() * 4); const vol = 0.05 + r() * 0.12; const kind = r();
      for (let k = 0; k < reps; k++) {
        const t = t0 + k * (0.09 + r() * 0.05); const o = osc(oc, 'sine', base); const g = gain(oc, 0);
        const d = 0.04 + r() * 0.05;
        if (kind < 0.5) { o.frequency.setValueAtTime(base, t); o.frequency.exponentialRampToValueAtTime(base * 1.45, t + d); }
        else { o.frequency.setValueAtTime(base * 1.3, t); o.frequency.exponentialRampToValueAtTime(base * 0.85, t + d); }
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.linearRampToValueAtTime(0, t + d);
        chain(o, g, out); play(o, t, t + d + 0.02);
      }
    }
  } },
  'amb-crickets': { dur: 6, loop: true, build(oc, out) {
    const r = rng(171);
    for (let c = 0; c < 5; c++) {
      const f = 4300 + r() * 900; const period = 0.45 + r() * 0.4; const vol = 0.02 + r() * 0.04; const off = r() * period;
      for (let t = off; t < 6 - 0.1; t += period) {
        for (let p = 0; p < 3; p++) {
          const tt = t + p * 0.028; const o = osc(oc, 'sine', f); const g = gain(oc, 0);
          g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(vol, tt + 0.004); g.gain.linearRampToValueAtTime(0, tt + 0.018);
          chain(o, g, out); play(o, tt, tt + 0.02);
        }
      }
    }
    const n = noise(oc, 6 + XF, 'pink', 172); chain(n, filt(oc, 'lowpass', 300), gain(oc, 0.15), out); play(n);
  } },
};

export const SOUND_NAMES = Object.keys(defs);
export function isLoopSound(name: string): boolean { return !!defs[name]?.loop; }

async function render(name: string, def: Def): Promise<AudioBuffer> {
  const fold = def.loop && !def.exact;
  const len = def.dur + (fold ? XF : 0);
  const oc = new OfflineAudioContext(1, Math.ceil(len * SR), SR);
  const out = oc.createGain(); out.gain.value = def.gain ?? 1; out.connect(oc.destination);
  def.build(oc, out, def.dur);
  const buf = await oc.startRendering();
  // Peak-normalize hot renders so nothing clips before the mix bus.
  { const d = buf.getChannelData(0); let pk = 0; for (let i = 0; i < d.length; i++) pk = Math.max(pk, Math.abs(d[i]));
    if (pk > 0.9) { const k = 0.9 / pk; for (let i = 0; i < d.length; i++) d[i] *= k; } }
  if (def.loop && !fold) return buf;
  if (!def.loop) {
    // short fade at end to avoid clicks
    const d = buf.getChannelData(0); const f = Math.min(256, d.length);
    for (let i = 0; i < f; i++) d[d.length - 1 - i] *= i / f;
    return buf;
  }
  // Fold: crossfade the extra tail into the head, then trim to dur.
  const src = buf.getChannelData(0); const n = Math.ceil(def.dur * SR); const x = src.length - n;
  const outBuf = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 1 });
  const d = outBuf.getChannelData(0);
  d.set(src.subarray(0, n));
  for (let i = 0; i < x; i++) { const a = i / x; d[i] = src[i] * Math.sqrt(a) + src[n + i] * Math.sqrt(1 - a); }
  return outBuf;
}

const cache = new Map<string, Promise<AudioBuffer | null>>();
const ready = new Map<string, AudioBuffer>();

/** Render (or fetch cached) the buffer for a named sound. */
export function getBuffer(name: string): Promise<AudioBuffer | null> {
  let p = cache.get(name);
  if (!p) {
    const def = defs[name];
    p = def ? render(name, def).then((b) => { ready.set(name, b); return b; }).catch((e) => { console.warn('[audio] synth failed', name, e); return null; }) : Promise.resolve(null);
    cache.set(name, p);
  }
  return p;
}
/** Buffer if already rendered/loaded, else null (and kicks off rendering). */
export function bufferNow(name: string): AudioBuffer | null {
  const b = ready.get(name);
  if (!b) getBuffer(name);
  return b ?? null;
}
/** Replace a synthesized sound with a decoded file (from the asset library). */
export function overrideBuffer(name: string, buf: AudioBuffer): void {
  ready.set(name, buf); cache.set(name, Promise.resolve(buf));
}
export async function renderAll(): Promise<void> { await Promise.all(SOUND_NAMES.map(getBuffer)); }
