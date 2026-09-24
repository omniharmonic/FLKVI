// FPS / draw-call overlay (F3) and render resolution scale (settings.resScale on top of the quality tier).
import type { Game } from '../core/game';
import { h, uiRoot } from './dom';
import { settings, saveSettings, onSettingsChange } from './settings';

export function setupFpsOverlay(g: Game): void {
  const fps = h('b', {}, '—'); const ms = h('span', {}, ''); const dc = h('span', {}, ''); const tri = h('span', {}, '');
  const el = h('div', { class: 'gt-fps gt-passthrough', 'aria-hidden': 'true' }, fps, h('i', {}, 'FPS'), ms, dc, tri);
  uiRoot().appendChild(el);
  const paint = () => el.classList.toggle('on', !!settings.showFps);
  paint(); onSettingsChange(paint);
  addEventListener('keydown', (e) => {
    if (e.code !== 'F3' || e.repeat) return;
    e.preventDefault();
    saveSettings({ showFps: !settings.showFps });
  });
  let frames = 0; let acc = 0; let last = performance.now(); let worst = 0;
  const tick = () => {
    requestAnimationFrame(tick);
    const now = performance.now(); const dt = now - last; last = now;
    if (!settings.showFps) return;
    frames++; acc += dt; worst = Math.max(worst, dt);
    if (acc < 500) return;
    const f = (frames * 1000) / acc;
    fps.textContent = f.toFixed(0);
    fps.style.color = f >= 55 ? '#3ee08f' : f >= 30 ? '#ffb23e' : '#ff5a66';
    ms.textContent = `${(acc / frames).toFixed(1)} ms · max ${worst.toFixed(0)}`;
    try {
      const info = g.renderer?.info;
      dc.textContent = `${info?.render.calls ?? 0} draws`;
      tri.textContent = `${(((info?.render.triangles ?? 0)) / 1e6).toFixed(2)} M tris · ${g.quality} · ${Math.round((settings.resScale || 1) * 100)}%`;
    } catch { /* */ }
    frames = 0; acc = 0; worst = 0;
  };
  requestAnimationFrame(tick);
}

/** Copy the current WebGL frame into a 2D canvas. Must run right after a render in the same task (no preserveDrawingBuffer). */
export function grabFrame(g: Game, maxW = 1920, target?: HTMLCanvasElement): HTMLCanvasElement | null {
  try {
    const src = g.renderer.domElement;
    if (!src.width || !src.height) return null;
    const k = Math.min(1, maxW / src.width);
    const c = target ?? document.createElement('canvas');
    const w = Math.round(src.width * k), hh = Math.round(src.height * k);
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0, w, hh);
    return c;
  } catch { return null; }
}

/** Render a fresh frame and grab it immediately (safe outside the render loop). */
export function renderAndGrab(g: Game, maxW = 3840): HTMLCanvasElement | null {
  try { g.renderFrame(0); } catch { /* */ }
  return grabFrame(g, maxW);
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function canvasBlob(c: HTMLCanvasElement, type = 'image/png', q?: number): Promise<Blob | null> {
  return new Promise((res) => { try { c.toBlob((b) => res(b), type, q); } catch { res(null); } });
}

/** Copy a PNG blob to the clipboard. Returns false when unsupported / denied. */
export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    const CI = (window as any).ClipboardItem;
    if (!CI || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new CI({ 'image/png': blob })]);
    return true;
  } catch { return false; }
}

export function fileStamp(): string {
  const d = new Date(); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
