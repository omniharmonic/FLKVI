// Persistent player settings. Gameplay reads `settings.mouseSensitivity` / `settings.invertY` each frame;
// audio reads `settings.volume` / `settings.musicVolume`. Also exposed as `window.gtSettings`.
export interface Settings {
  /** Multiplier on raw mouse delta (1 = default). */
  mouseSensitivity: number;
  /** Master volume 0..1. */
  volume: number;
  /** Music volume 0..1 (relative to master). */
  musicVolume: number;
  invertY: boolean;
  quality: 'high' | 'medium' | 'low';
}

const KEY = 'groundtruth.settings.v1';
const defaults: Settings = { mouseSensitivity: 1, volume: 0.8, musicVolume: 0.6, invertY: false, quality: 'high' };

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

(window as any).gtSettings = settings;
