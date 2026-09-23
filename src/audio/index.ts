// OWNER: audio agent. Positional audio, procedural/CC0 sounds, ambience, sirens, engine.
//
// g.audio.play(name, { at, volume, loop, rate }) → handle | null
//   • with `at`  → THREE.PositionalAudio from a pool (HRTF-less equal-power panner, inverse rolloff, Doppler on moving loops)
//   • without    → non-positional (2D) sound on the sfx bus
// Names: footstep engine tire-squeal crash door horn siren grinder spray metal-fall alert bank busted
//        ui-click ui-hover phone-dial helicopter camera-beep  (+ files from soundUrl(name) override synth)
// This module also auto-plays: 'alert' on heat increase, 'bank' on 'banked', 'busted' on 'arrested',
// and runs the ambience (traffic hum, birds by day / crickets at night) and the heat-driven music bed.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { AudioAPI } from '../core/api';
import type { Vec3 } from '../core/types';
import { audioCtx, getBuses, onUnlock, setDuck } from './engine';
import { bufferNow, getBuffer, overrideBuffer, renderAll, SOUND_NAMES } from './synth';
import { sfx, type SoundHandle } from './sfx';
import { Music } from './music';
import { soundUrl } from '../assets/library';

export { sfx, setDuck };

/** Per-sound spatial + mix defaults. */
const SPATIAL: Record<string, { ref: number; vol: number; max?: number; rolloff?: number; doppler?: boolean }> = {
  footstep: { ref: 2, vol: 0.35 },
  engine: { ref: 5, vol: 0.55, doppler: true },
  'tire-squeal': { ref: 6, vol: 0.5, doppler: true },
  crash: { ref: 8, vol: 1 },
  door: { ref: 3, vol: 0.6 },
  horn: { ref: 10, vol: 0.6, doppler: true },
  shout: { ref: 6, vol: 0.8 },
  siren: { ref: 18, vol: 0.75, rolloff: 0.9, doppler: true },
  grinder: { ref: 5, vol: 0.8 },
  spray: { ref: 2, vol: 0.45 },
  'metal-fall': { ref: 10, vol: 1 },
  helicopter: { ref: 40, vol: 0.9, rolloff: 0.7, doppler: true },
  'camera-beep': { ref: 3, vol: 0.4 },
};
const DEFAULT_SPATIAL = { ref: 6, vol: 0.7 };

interface Voice { a: THREE.PositionalAudio; busy: boolean; loop: boolean; started: number; last: THREE.Vector3; lastD: number; dop: number; baseRate: number; doppler: boolean; handle?: SoundHandle }

let menuBed: SoundHandle | null = null;
let music: Music | null = null;

/** Low ambience for the title/loading screens. Safe to call repeatedly. */
export function startMenuAmbience(): void {
  onUnlock(() => {
    if (menuBed) return;
    menuBed = sfx('amb-city', { loop: true, volume: 0.22, bus: 'amb', fadeIn: 3 });
  });
}
export function stopMenuAmbience(): void { menuBed?.stop(); menuBed = null; }

// Pre-render the whole library as soon as this module loads (cheap: a few hundred ms, off the main thread mostly).
renderAll().catch(() => {});

export async function setupAudio(g: Game): Promise<void> {
  let listener: THREE.AudioListener | null = null;
  try {
    audioCtx();
    listener = new THREE.AudioListener();
    // Route THREE's listener output through our master chain instead of straight to destination.
    listener.gain.disconnect();
    listener.gain.connect(getBuses().sfx);
    g.camera.add(listener);
  } catch (e) {
    console.warn('[audio] WebAudio unavailable', e);
    g.audio = { play: () => null, listener: null };
    return;
  }

  // Asset-library overrides (CC0 files) — replace synthesized versions when present.
  for (const name of SOUND_NAMES) {
    const url = safeUrl(name);
    if (!url) continue;
    fetch(url).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
      .then((ab) => audioCtx().decodeAudioData(ab)).then((buf) => overrideBuffer(name, buf))
      .catch(() => { /* keep synth */ });
  }

  const holder = new THREE.Group(); holder.name = 'audio'; g.scene.add(holder);
  const voices: Voice[] = [];
  const MAX_VOICES = 32;
  const tmp = new THREE.Vector3();

  const acquire = (loop: boolean): Voice | null => {
    let v = voices.find((x) => !x.busy);
    if (!v && voices.length < MAX_VOICES) {
      const a = new THREE.PositionalAudio(listener!);
      a.setDistanceModel('inverse');
      a.panner.panningModel = 'equalpower';
      holder.add(a);
      v = { a, busy: false, loop: false, started: 0, last: new THREE.Vector3(), lastD: -1, dop: 1, baseRate: 1, doppler: false };
      voices.push(v);
    }
    if (!v) {
      // steal the oldest one-shot
      const cands = voices.filter((x) => !x.loop).sort((p, q) => p.started - q.started);
      v = cands[0]; if (!v) return null;
      try { v.a.stop(); } catch { /* */ }
    }
    v.busy = true; v.loop = loop; v.started = performance.now(); v.lastD = -1; v.dop = 1;
    return v;
  };
  const release = (v: Voice) => { v.busy = false; v.loop = false; try { if (v.a.isPlaying) v.a.stop(); } catch { /* */ } };

  const play: AudioAPI['play'] = (name, opts = {}) => {
    const loop = !!opts.loop;
    const sp = SPATIAL[name] ?? DEFAULT_SPATIAL;
    let rate = opts.rate ?? 1;
    if (name === 'footstep') rate *= 0.85 + Math.random() * 0.3;
    const vol = (opts.volume ?? 1) * sp.vol;
    if (!opts.at) return sfx(name, { volume: vol, rate, loop });
    const buf = bufferNow(name);
    const v = acquire(loop);
    if (!v) return null;
    const a = v.a;
    v.baseRate = rate; v.doppler = !!sp.doppler && loop;
    a.position.set(opts.at[0], opts.at[1], opts.at[2]); a.updateMatrixWorld();
    v.last.copy(a.position);
    a.setRefDistance(sp.ref); a.setRolloffFactor(sp.rolloff ?? 1); a.setMaxDistance(sp.max ?? 10000);
    a.setVolume(vol); a.setLoop(loop); a.setPlaybackRate(rate);
    let stopped = false;
    const start = (b: AudioBuffer) => {
      if (stopped || !v.busy) return;
      a.setBuffer(b);
      try { a.play(); } catch { release(v); return; }
      const src = (a as any).source as AudioBufferSourceNode | undefined;
      if (src && !loop) {
        const orig = src.onended;
        src.onended = (e) => { try { (orig as any)?.call(src, e); } catch { /* */ } if (!v.loop && v.handle === handle) release(v); };
      }
    };
    const handle: SoundHandle = {
      stop() { stopped = true; if (v.handle === handle) release(v); },
      setVolume(x: number) { if (v.handle === handle) a.gain.gain.setTargetAtTime(x * sp.vol, a.context.currentTime, 0.03); },
      setRate(r: number) { v.baseRate = r; if (v.handle === handle && a.isPlaying) a.setPlaybackRate(r * v.dop); },
      setPosition(p: Vec3) { if (v.handle === handle) { a.position.set(p[0], p[1], p[2]); } },
    };
    v.handle = handle;
    if (buf) start(buf); else getBuffer(name).then((b) => b && start(b));
    return handle;
  };

  g.audio = { play, listener };

  // ---------- ambience ----------
  let ambCity: SoundHandle | null = null, ambBirds: SoundHandle | null = null, ambCrickets: SoundHandle | null = null;
  music = new Music();
  const startWorldBeds = () => {
    stopMenuAmbience();
    ambCity = sfx('amb-city', { loop: true, volume: 0, bus: 'amb' });
    ambBirds = sfx('amb-birds', { loop: true, volume: 0, bus: 'amb' });
    ambCrickets = sfx('amb-crickets', { loop: true, volume: 0, bus: 'amb' });
    music!.setActive(true, 4);
  };
  g.events.on('worldReady', () => onUnlock(startWorldBeds));

  // ---------- event-driven stings ----------
  g.events.on('heatChanged', ({ heat, prev }) => { if (heat > prev) sfx('alert', { volume: 0.7 }); });
  g.events.on('banked', () => sfx('bank', { volume: 0.9 }));
  g.events.on('arrested', () => { sfx('busted', { volume: 1 }); music?.setHeat(0); });

  // Duck world audio when paused (menus/map).
  let wasPaused = false;
  let distantTimer = 20 + Math.random() * 30;

  g.addSystem({
    name: 'audio',
    order: 900,
    update(dt) {
      const night = safeNum(() => g.sky.nightFactor, 0);
      const heat = safeNum(() => g.heat.level, 0);
      ambCity?.setVolume(0.35 - night * 0.1);
      ambBirds?.setVolume(Math.max(0, 1 - night * 1.6) * 0.6);
      ambCrickets?.setVolume(Math.max(0, night * 1.4 - 0.4) * 0.55);
      music?.setHeat(g.mode === 'freeroam' ? Math.min(heat, 1) : heat);
      // occasional distant city sounds
      distantTimer -= dt;
      if (distantTimer < 0 && ambCity) {
        distantTimer = 25 + Math.random() * 45;
        const pick = Math.random();
        if (pick < 0.5) { const h = sfx('siren', { volume: 0.05, loop: true, fadeIn: 3 }); setTimeout(() => h?.stop(3), 6000); }
        else sfx('horn', { volume: 0.05, rate: 0.9 + Math.random() * 0.2 });
      }
      // Doppler for moving positional loops
      listener!.getWorldPosition(tmp);
      for (const v of voices) {
        if (!v.busy || !v.doppler || !v.a.isPlaying) continue;
        const d = v.a.position.distanceTo(tmp);
        if (v.lastD >= 0 && dt > 0) {
          const vr = (d - v.lastD) / dt; // + receding
          const target = THREE.MathUtils.clamp(343 / (343 + THREE.MathUtils.clamp(vr, -120, 120)), 0.75, 1.3);
          v.dop += (target - v.dop) * Math.min(1, dt * 6);
          v.a.setPlaybackRate(v.baseRate * v.dop);
        }
        v.lastD = d;
      }
    },
  });
  // Pause detection runs outside the (paused) system loop.
  const pauseWatch = () => {
    if (g.paused !== wasPaused) { wasPaused = g.paused; setDuck(g.paused ? 0.25 : 1, 0.4); }
    requestAnimationFrame(pauseWatch);
  };
  requestAnimationFrame(pauseWatch);
}

function safeUrl(name: string): string | null { try { return soundUrl(name); } catch { return null; } }
function safeNum(fn: () => number, d: number): number { try { const v = fn(); return typeof v === 'number' && isFinite(v) ? v : d; } catch { return d; } }
