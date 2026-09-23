// Shared WebAudio context + mix buses. Shares its AudioContext with THREE (THREE.AudioContext) so positional
// audio from THREE.AudioListener and our own buses end up in one graph.
import * as THREE from 'three';
import { settings, onSettingsChange } from '../ui/settings';

let ctx: AudioContext | null = null;
export interface Buses { master: GainNode; sfx: GainNode; ui: GainNode; music: GainNode; amb: GainNode; duck: GainNode }
let buses: Buses | null = null;

export function audioCtx(): AudioContext {
  if (!ctx) {
    ctx = THREE.AudioContext.getContext() as AudioContext;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    const master = ctx.createGain();
    master.gain.value = settings.volume;
    master.connect(comp); comp.connect(ctx.destination);
    // `duck` sits before master for world sounds (sfx, amb) so menus can duck the world without muting UI.
    const duck = ctx.createGain(); duck.connect(master);
    const sfx = ctx.createGain(); sfx.gain.value = 1; sfx.connect(duck);
    const amb = ctx.createGain(); amb.gain.value = 1; amb.connect(duck);
    const music = ctx.createGain(); music.gain.value = settings.musicVolume; music.connect(master);
    const ui = ctx.createGain(); ui.gain.value = 0.7; ui.connect(master);
    buses = { master, sfx, ui, music, amb, duck };
    onSettingsChange((s) => {
      const t = ctx!.currentTime;
      buses!.master.gain.setTargetAtTime(s.volume, t, 0.05);
      buses!.music.gain.setTargetAtTime(s.musicVolume, t, 0.05);
    });
    installUnlock();
  }
  return ctx;
}

export function getBuses(): Buses { audioCtx(); return buses!; }

/** Duck world audio (0..1) e.g. in pause menu / map. */
export function setDuck(level: number, time = 0.25): void {
  const b = getBuses();
  b.duck.gain.setTargetAtTime(level, ctx!.currentTime, time / 3);
}

let unlocked = false;
const unlockCbs: (() => void)[] = [];
export function onUnlock(fn: () => void): void { if (unlocked) fn(); else unlockCbs.push(fn); }
export function isUnlocked(): boolean { return unlocked; }

function installUnlock() {
  const tryUnlock = () => {
    if (!ctx) return;
    ctx.resume().then(() => {
      if (unlocked || ctx!.state !== 'running') return;
      unlocked = true;
      for (const fn of unlockCbs.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
      removeEventListener('pointerdown', tryUnlock, true);
      removeEventListener('keydown', tryUnlock, true);
    }).catch(() => {});
  };
  addEventListener('pointerdown', tryUnlock, true);
  addEventListener('keydown', tryUnlock, true);
  if (ctx!.state === 'running') tryUnlock();
}
