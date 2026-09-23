// Non-positional one-shots / loops that work before the Game exists (UI sounds, stings, beds).
import { audioCtx, getBuses, isUnlocked } from './engine';
import { bufferNow, getBuffer } from './synth';

export interface SoundHandle { stop(fade?: number): void; setVolume(v: number): void; setRate(r: number): void; setPosition(p: [number, number, number]): void }

const UI_SOUNDS = new Set(['ui-click', 'ui-hover']);
const lastPlayed = new Map<string, number>();

export function sfx(name: string, opts: { volume?: number; rate?: number; loop?: boolean; bus?: 'sfx' | 'ui' | 'music' | 'amb'; fadeIn?: number } = {}): SoundHandle | null {
  let ctx: AudioContext;
  try { ctx = audioCtx(); } catch { return null; }
  if (!isUnlocked() && !opts.loop) return null;
  const now = ctx.currentTime;
  // Throttle rapid repeats (hover spam) to 30 ms.
  if ((lastPlayed.get(name) ?? -1) > now - 0.03 && !opts.loop) return null;
  lastPlayed.set(name, now);
  const buses = getBuses();
  const g = ctx.createGain();
  const vol = opts.volume ?? 1;
  const bus = buses[opts.bus ?? (UI_SOUNDS.has(name) ? 'ui' : 'sfx')];
  g.connect(bus);
  let src: AudioBufferSourceNode | null = null;
  let stopped = false;
  let rate = opts.rate ?? 1;
  const start = (buf: AudioBuffer) => {
    if (stopped) return;
    src = ctx.createBufferSource();
    src.buffer = buf; src.loop = !!opts.loop; src.playbackRate.value = rate;
    src.connect(g);
    const t = ctx.currentTime;
    if (opts.fadeIn) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + opts.fadeIn); } else g.gain.value = vol;
    src.start();
    src.onended = () => { if (!src!.loop) g.disconnect(); };
  };
  const b = bufferNow(name);
  if (b) start(b); else getBuffer(name).then((bb) => bb && start(bb));
  return {
    stop(fade: number = 0.08) {
      if (stopped) return; stopped = true;
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade);
      try { src?.stop(t + fade + 0.02); } catch { /* not started */ }
      setTimeout(() => g.disconnect(), (fade + 0.1) * 1000);
    },
    setVolume(v: number) { g.gain.setTargetAtTime(v, ctx.currentTime, 0.03); },
    setRate(r: number) { rate = r; if (src) src.playbackRate.setTargetAtTime(r, ctx.currentTime, 0.02); },
    setPosition() { /* non-positional */ },
  };
}
