// Persistent player settings. Gameplay reads `settings.mouseSensitivity` / `settings.invertY` / `settings.fov` each
// frame; audio reads `settings.volume` / `settings.musicVolume` / `settings.sfxVolume`. Also exposed as `window.gtSettings`.
export interface Settings {
  /** Multiplier on raw mouse delta (1 = default). */
  mouseSensitivity: number;
  /** Master volume 0..1. */
  volume: number;
  /** Music volume 0..1 (relative to master). */
  musicVolume: number;
  /** Sound-effects / world volume 0..1 (relative to master). */
  sfxVolume: number;
  invertY: boolean;
  quality: 'high' | 'medium' | 'low';
  /** Base on-foot vertical FOV in degrees (camera adds sprint/speed widening on top). */
  fov: number;
  /** Render resolution multiplier on top of the quality tier's pixel ratio (0.5..1). */
  resScale: number;
  /** FPS / draw-call overlay (F3). */
  showFps: boolean;
  /** 'auto' follows the OS prefers-reduced-motion setting. */
  reduceMotion: 'auto' | 'on' | 'off';
}

const KEY = 'groundtruth.settings.v1';
const defaults: Settings = { mouseSensitivity: 1, volume: 0.8, musicVolume: 0.6, sfxVolume: 1, invertY: false, quality: 'high', fov: 62, resScale: 1, showFps: false, reduceMotion: 'auto' };

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...defaults };
}

export const settings: Settings = load();
const listeners = new Set<(s: Settings) => void>();

export function saveSettings(patch: Partial<Settings>): void {
  Object.assign(settings, patch);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  for (const fn of listeners) { try { fn(settings); } catch (e) { console.error(e); } }
}

export function onSettingsChange(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True when motion should be toned down (fly-in length, camera shake, UI animation). */
let mq: MediaQueryList | null = null;
try { mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch { /* */ }
export function reducedMotion(): boolean {
  if (settings.reduceMotion === 'on') return true;
  if (settings.reduceMotion === 'off') return false;
  return !!mq?.matches;
}

function syncMotionClass() {
  try { const r = document.documentElement.classList; r.toggle('gt-reduce-motion', reducedMotion()); r.toggle('gt-motion-full', settings.reduceMotion === 'off'); } catch { /* */ }
}
syncMotionClass();
onSettingsChange(syncMotionClass);

(window as any).gtSettings = settings;
