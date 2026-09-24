// Settings rows shared by the pause menu (in game) and the title-screen settings modal (no Game yet).
import type { Game } from '../core/game';
import { h, btn } from './dom';
import { settings, saveSettings, type Settings } from './settings';
import { sfx } from '../audio/sfx';

type Q = Settings['quality'];

export function settingsRows(g: Game | null): HTMLElement[] {
  let n = 0;
  const row = (label: string, input: HTMLElement, val?: HTMLElement, id?: string) => {
    const lab = h('label', id ? { for: id } : {}, label);
    return h('div', { class: 'gt-set' }, lab, input, val ?? h('span'));
  };
  const slider = (label: string, min: number, max: number, step: number, value: number, fmtV: (v: number) => string, on: (v: number) => void) => {
    const id = `gt-set-${++n}`;
    const v = h('span', { class: 'v' }, fmtV(value));
    const i = h('input', { type: 'range', id, min, max, step, value, 'aria-valuetext': fmtV(value) });
    i.addEventListener('input', () => { const x = parseFloat(i.value); v.textContent = fmtV(x); i.setAttribute('aria-valuetext', fmtV(x)); on(x); });
    return row(label, i, v, id);
  };
  const opts = <T extends string>(label: string, list: T[], cur: T, on: (v: T) => void, names?: Record<string, string>) => {
    const wrap = h('div', { class: 'opts', role: 'radiogroup', 'aria-label': label });
    const paint = (c: T) => wrap.replaceChildren(...list.map((o) => h('button', {
      class: o === c ? 'on' : '', role: 'radio', 'aria-checked': o === c ? 'true' : 'false',
      onclick: () => { sfx('ui-click'); on(o); paint(o); (wrap.querySelector(`[data-v="${o}"]`) as HTMLElement | null)?.focus(); },
      'data-v': o,
    }, names?.[o] ?? o)));
    paint(cur);
    return row(label, wrap);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const rows: HTMLElement[] = [];
  const head = (t: string) => h('div', { class: 'gt-set-h' }, t);

  rows.push(head('Graphics'));
  rows.push(opts<Q>('Quality', ['low', 'medium', 'high'], (g?.quality ?? settings.quality) as Q, (q) => {
    saveSettings({ quality: q });
    if (g) { g.quality = q; import('../render').then((render) => (render as any).setQuality?.(g, q)).catch((e) => console.warn(e)); }
    else { try { localStorage.setItem('gt.quality', q); } catch { /* */ } }
  }));
  rows.push(slider('Resolution scale', 0.5, 1, 0.05, settings.resScale ?? 1, pct, (v) => saveSettings({ resScale: v })));
  rows.push(slider('Field of view', 50, 90, 1, settings.fov ?? 62, (v) => `${v.toFixed(0)}°`, (v) => saveSettings({ fov: v })));
  rows.push(opts('Show FPS (F3)', ['off', 'on'], settings.showFps ? 'on' : 'off', (v) => saveSettings({ showFps: v === 'on' })));
  if (g) {
    const skyTime = (() => { try { return g.sky?.time ?? 12; } catch { return 12; } })();
    rows.push(slider('Time of day', 0, 23.75, 0.25, skyTime, (v) => `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`, (v) => { try { if (g.sky) g.sky.time = v; } catch { /* */ } }));
  }
  rows.push(head('Controls'));
  rows.push(slider('Mouse sensitivity', 0.2, 3, 0.05, settings.mouseSensitivity, (v) => `${v.toFixed(2)}×`, (v) => saveSettings({ mouseSensitivity: v })));
  rows.push(opts('Invert Y', ['off', 'on'], settings.invertY ? 'on' : 'off', (v) => saveSettings({ invertY: v === 'on' })));
  rows.push(head('Audio'));
  rows.push(slider('Master volume', 0, 1, 0.01, settings.volume, pct, (v) => saveSettings({ volume: v })));
  rows.push(slider('Music volume', 0, 1, 0.01, settings.musicVolume, pct, (v) => saveSettings({ musicVolume: v })));
  rows.push(slider('Effects volume', 0, 1, 0.01, settings.sfxVolume ?? 1, pct, (v) => saveSettings({ sfxVolume: v })));
  rows.push(head('Accessibility'));
  rows.push(opts('Reduce motion', ['auto', 'on', 'off'], settings.reduceMotion ?? 'auto', (v) => saveSettings({ reduceMotion: v }), { auto: 'system' }));
  return rows;
}

/** Title-screen settings modal. */
export function showSettingsModal(): void {
  const wrap = h('div', { class: 'gt-modal-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' });
  const prev = document.activeElement as HTMLElement | null;
  const close = () => { wrap.remove(); removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); close(); } };
  addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const closeB = btn('Done', close, 'gt-btn primary');
  wrap.append(h('div', { class: 'gt-modal gt-glass gt-settings-modal' }, h('h2', {}, 'Settings'), ...settingsRows(null), h('div', { style: 'margin-top:22px;text-align:right' }, closeB)));
  document.body.appendChild(wrap);
  (wrap.querySelector('button, input') as HTMLElement | null)?.focus();
}
