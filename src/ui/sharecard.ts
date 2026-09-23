// Shareable run card (1200×630 canvas): city, streak, score, cuts/disables, time and a screenshot captured at the
// moment of the last takedown. Copy image (clipboard) or download.
import type { Game } from '../core/game';
import { h, btn, fmt, fmtTime } from './dom';
import { grabFrame, renderAndGrab, canvasBlob, copyImage, downloadBlob, fileStamp } from './perf';
import { placeLine } from './intro';

const shots = new WeakMap<Game, HTMLCanvasElement>();

/** Capture a downscaled frame shortly after each takedown (pole falling / sparks). */
export function trackTakedownShots(g: Game): void {
  const target = document.createElement('canvas');
  g.events.on('takedown', () => {
    setTimeout(() => requestAnimationFrame(() => {
      // this rAF callback runs after the game loop's render in the same frame, so the drawing buffer is intact
      if (grabFrame(g, 960, target)) shots.set(g, target);
    }), 280);
  });
  g.events.on('runStart', () => shots.delete(g));
}

export interface CardData {
  city: string; streak: number; score: number; banked: number; cuts: number; disables: number; time: number;
  reason: string; pb: boolean; mode: string;
}

export async function renderCard(g: Game, d: CardData): Promise<HTMLCanvasElement> {
  try { await (document as any).fonts?.ready; } catch { /* */ }
  const W = 1200, H = 630;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  x.fillStyle = '#07090c'; x.fillRect(0, 0, W, H);
  const shot = shots.get(g) ?? renderAndGrab(g, 1280);
  if (shot && shot.width) {
    const k = Math.max(W / shot.width, H / shot.height);
    const sw = shot.width * k, sh = shot.height * k;
    x.filter = 'saturate(1.08) contrast(1.05)';
    x.drawImage(shot, (W - sw) / 2 + 120, (H - sh) / 2, sw, sh);
    x.filter = 'none';
  }
  // grade: dark from the left for type, vignette, warm/red wash
  let gr = x.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, 'rgba(6,8,11,0.96)'); gr.addColorStop(0.42, 'rgba(6,8,11,0.78)'); gr.addColorStop(0.75, 'rgba(6,8,11,0.15)'); gr.addColorStop(1, 'rgba(6,8,11,0.05)');
  x.fillStyle = gr; x.fillRect(0, 0, W, H);
  gr = x.createLinearGradient(0, H, 0, H * 0.55);
  gr.addColorStop(0, 'rgba(6,8,11,0.9)'); gr.addColorStop(1, 'rgba(6,8,11,0)');
  x.fillStyle = gr; x.fillRect(0, 0, W, H);
  const rg = x.createRadialGradient(W * 0.7, H * 0.45, H * 0.2, W * 0.7, H * 0.45, W * 0.75);
  rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,0.5)');
  x.fillStyle = rg; x.fillRect(0, 0, W, H);
  // scanlines
  x.fillStyle = 'rgba(255,255,255,0.018)';
  for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
  // red rule
  x.fillStyle = '#ff2d3d'; x.fillRect(0, 0, 6, H);

  const mono = (s: number, wgt = 500) => `${wgt} ${s}px "JetBrains Mono", ui-monospace, monospace`;
  const sans = (s: number, wgt = 800) => `${wgt} ${s}px Inter, system-ui, sans-serif`;
  const spaced = (t: string, px: number, py: number, sp: number) => { let cx = px; for (const ch of t) { x.fillText(ch, cx, py); cx += x.measureText(ch).width + sp; } return cx; };
  x.textBaseline = 'alphabetic';
  // logo
  x.fillStyle = '#fff'; x.font = sans(30); x.fillText('GROUNDTRUTH', 64, 84);
  const lw = x.measureText('GROUNDTRUTH').width; x.fillStyle = '#ff2d3d'; x.fillText('.', 64 + lw, 84);
  // REC
  x.fillStyle = '#ff2d3d'; x.beginPath(); x.arc(W - 150, 74, 7, 0, Math.PI * 2); x.fill();
  x.font = mono(15, 500); spaced('RUN REPORT', W - 134, 80, 3);
  // kicker + city
  const date = new Date().toISOString().slice(0, 10);
  x.fillStyle = '#ff5a66'; x.font = mono(14, 500);
  spaced(`${d.mode === 'freeroam' ? 'FREE ROAM' : 'TAKEDOWN'} · ${d.reason === 'arrested' ? 'ARRESTED' : 'ENDED'} · ${date}`, 64, 150, 3);
  x.fillStyle = '#e9edf2'; x.font = sans(30, 800);
  let city = placeLine(d.city);
  while (x.measureText(city).width > 620 && city.length > 8) city = city.slice(0, -2);
  if (city !== placeLine(d.city)) city = city.trimEnd() + '…';
  x.fillText(city, 64, 196);
  // big streak
  x.font = sans(220, 800);
  const big = String(d.streak);
  const bg = x.createLinearGradient(0, 230, 0, 420);
  bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#9aa3af');
  x.fillStyle = bg; x.fillText(big, 56, 410);
  const bw = x.measureText(big).width;
  x.fillStyle = '#8a94a3'; x.font = mono(16, 500); spaced('CAMERA', 64 + bw + 18, 356, 4); spaced('STREAK', 64 + bw + 18, 382, 4);
  if (d.pb && (d.streak > 0 || d.score > 0)) {
    const px = 64 + bw + 18, py = 300;
    const pg = x.createLinearGradient(px, 0, px + 200, 0); pg.addColorStop(0, '#ffd479'); pg.addColorStop(1, '#ffb23e');
    x.fillStyle = pg; roundRect(x, px, py, 214, 32, 16); x.fill();
    x.fillStyle = '#111'; x.font = mono(13, 500); spaced('NEW PERSONAL BEST', px + 16, py + 21, 1.5);
  }
  // stats row
  const stats: [string, string][] = [[fmt(d.score), 'SCORE'], [fmt(d.banked), 'BANKED'], [String(d.cuts), 'CUT DOWN'], [String(d.disables), 'DISABLED'], [fmtTime(d.time), 'TIME']];
  const sx = 64, sy = 470, cw = 150;
  x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(sx, sy - 6, cw * stats.length - 20, 1);
  stats.forEach(([v, l], i) => {
    x.fillStyle = '#ffffff'; x.font = sans(34, 800); x.fillText(v, sx + i * cw, sy + 42);
    x.fillStyle = '#8a94a3'; x.font = mono(12, 500); spaced(l, sx + i * cw, sy + 66, 2.5);
  });
  // footer
  x.fillStyle = '#7a8494'; x.font = mono(13, 500);
  spaced('OMNIHARMONIC.GITHUB.IO/GROUNDTRUTH', 64, H - 40, 2);
  x.textAlign = 'right'; x.fillText('Real places from OpenStreetMap · a work of fiction', W - 48, H - 40); x.textAlign = 'left';
  return c;
}

function roundRect(x: CanvasRenderingContext2D, px: number, py: number, w: number, hh: number, r: number) {
  x.beginPath(); x.moveTo(px + r, py); x.arcTo(px + w, py, px + w, py + hh, r); x.arcTo(px + w, py + hh, px, py + hh, r);
  x.arcTo(px, py + hh, px, py, r); x.arcTo(px, py, px + w, py, r); x.closePath();
}

/** Modal with the card preview and Copy / Download. */
export function openShareModal(g: Game, d: CardData): void {
  const status = h('div', { class: 'st', role: 'status', 'aria-live': 'polite' }, 'Rendering card…');
  const holder = h('div', { class: 'card' });
  let blob: Blob | null = null;
  const name = `groundtruth-${(d.city.split(/[,—-]/)[0] || 'run').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${d.streak}-${fileStamp()}.png`;
  const copyB = btn('Copy image', async () => {
    if (!blob) return;
    const ok = await copyImage(blob);
    status.textContent = ok ? 'Copied to clipboard.' : 'This browser blocked clipboard images. Use Download instead.';
  }, 'gt-btn primary');
  const dlB = btn('Download', () => { if (blob) { downloadBlob(blob, name); status.textContent = 'Saved.'; } });
  const wrap = h('div', { class: 'gt-modal-wrap gt-share', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share your run' });
  const close = () => { wrap.remove(); removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); } };
  addEventListener('keydown', onKey, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.append(h('div', { class: 'gt-modal gt-glass' }, h('h2', {}, 'Share your run'), holder, h('div', { class: 'row' }, status, h('div', { class: 'b' }, copyB, dlB, btn('Close', close)))));
  document.body.appendChild(wrap);
  copyB.disabled = true; dlB.disabled = true;
  renderCard(g, d).then(async (c) => {
    c.setAttribute('role', 'img'); c.setAttribute('aria-label', `Run card: ${d.streak} camera streak in ${d.city}, score ${fmt(d.score)}`);
    holder.append(c);
    blob = await canvasBlob(c, 'image/png');
    status.textContent = blob ? '1200 × 630 PNG' : 'Could not encode the image.';
    copyB.disabled = !blob; dlB.disabled = !blob;
    copyB.focus();
  }).catch((e) => { console.warn('[share]', e); status.textContent = 'Could not render the card.'; });
}
