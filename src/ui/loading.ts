// Full-screen loading screen: animated surveillance-grid background, progress bar, stage text, rotating tips.
import { h, uiRoot } from './dom';
import { chosen } from './picker';
import { startMenuAmbience } from '../audio';

const TIPS = [
  'Cameras watch each other. Take out the watcher first and the rest of the post opens up.',
  'Disabling is quick and quiet. Cutting a pole scores 3× but the grinder is loud and slow.',
  'Points stay hot until your heat drops to zero. Escape clean to bank them.',
  'Plate readers remember a car seen at a takedown. Swap vehicles out of sight to go dark.',
  'Grinder sparks carry much farther at night. Pick your hours.',
  'An unseen takedown still sends a tamper alert. Don’t linger at the scene.',
  'PTZ domes sweep. Time your move for when it looks away.',
  'Open the camera map (M) to plan a route through the gaps in coverage.',
  'Some cameras aren’t on the map. Keep looking up.',
  'Tower trailers are rare, heavily watched, and worth 2.5× points.',
  'Every downed camera is a blind spot the police can’t use to track you.',
];

export function showLoading(): { update(stage: string, f: number): void; done(): void } {
  startMenuAmbience();
  const cvs = h('canvas');
  const bar = h('i');
  const stage = h('span', {}, 'Initializing');
  const pct = h('span', { class: 'pct' }, '0%');
  const tipP = h('p', {}, TIPS[Math.floor(Math.random() * TIPS.length)]);
  const name = chosen?.name ?? 'Pearl Street, Boulder, CO';
  const live = chosen && !chosen.baked;
  const el = h('div', { class: 'gt-loading' },
    cvs, h('div', { class: 'grad' }),
    h('div', { class: 'brand', html: 'FLK <span class="flk-vi">VI</span>' }),
    h('div', { class: 'center' },
      h('div', { class: 'loc' }, live ? 'Compiling world · live' : 'Loading world'),
      h('div', { class: 'name' }, name),
      h('div', { class: 'bar' }, bar),
      h('div', { class: 'meta' }, stage, pct),
      h('div', { class: 'tip' }, h('div', { class: 'gt-label' }, 'Field notes'), tipP),
    ),
  );
  uiRoot().appendChild(el);

  // tips rotation
  let tipI = TIPS.indexOf(tipP.textContent!);
  const tipTimer = setInterval(() => {
    tipP.classList.add('swap');
    setTimeout(() => { tipI = (tipI + 1) % TIPS.length; tipP.textContent = TIPS[tipI]; tipP.classList.remove('swap'); }, 500);
  }, 5500);

  // animated background: panning street grid + camera pings
  const ctx = cvs.getContext('2d')!;
  let alive = true; let t0 = performance.now();
  const seed = (n: number) => { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); };
  const draw = () => {
    if (!alive) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = innerWidth, H = innerHeight;
    if (cvs.width !== W * dpr) { cvs.width = W * dpr; cvs.height = H * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = (performance.now() - t0) / 1000;
    ctx.fillStyle = '#06080b'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.rotate(-0.35); ctx.scale(1.2, 1.2);
    const cell = 90; const ox = (t * 14) % cell, oy = (t * 6) % cell;
    const span = Math.max(W, H);
    // blocks
    for (let gx = -12; gx < 12; gx++) for (let gy = -12; gy < 12; gy++) {
      const x = gx * cell - ox, y = gy * cell - oy;
      if (Math.abs(x) > span || Math.abs(y) > span) continue;
      const ix = gx + Math.floor((t * 14) / cell), iy = gy + Math.floor((t * 6) / cell);
      const r = seed(ix * 31 + iy * 7);
      ctx.fillStyle = `rgba(120,140,170,${0.035 + r * 0.03})`;
      const m = 14;
      if (r < 0.7) {
        ctx.fillRect(x + m, y + m, cell - 2 * m, cell - 2 * m);
      } else {
        ctx.fillRect(x + m, y + m, (cell - 2 * m) / 2 - 3, cell - 2 * m); ctx.fillRect(x + cell / 2 + 3, y + m, (cell - 2 * m) / 2 - 3, cell - 2 * m);
      }
    }
    // streets
    ctx.strokeStyle = 'rgba(150,170,200,0.08)'; ctx.lineWidth = 1;
    for (let gx = -12; gx < 12; gx++) { const x = gx * cell - ox; ctx.beginPath(); ctx.moveTo(x, -span); ctx.lineTo(x, span); ctx.stroke(); }
    for (let gy = -12; gy < 12; gy++) { const y = gy * cell - oy; ctx.beginPath(); ctx.moveTo(-span, y); ctx.lineTo(span, y); ctx.stroke(); }
    // cameras at intersections
    for (let gx = -12; gx < 12; gx++) for (let gy = -12; gy < 12; gy++) {
      const ix = gx + Math.floor((t * 14) / cell), iy = gy + Math.floor((t * 6) / cell);
      const r = seed(ix * 13.7 + iy * 91.3);
      if (r > 0.16) continue;
      const x = gx * cell - ox, y = gy * cell - oy;
      if (Math.abs(x) > span || Math.abs(y) > span) continue;
      const ph = (t * 0.5 + r * 10) % 1;
      const heading = r * 40 + t * (r < 0.05 ? 0.8 : 0);
      ctx.fillStyle = 'rgba(255,45,61,0.07)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 70, heading - 0.4, heading + 0.4); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(255,45,61,${0.5 * (1 - ph)})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 4 + ph * 26, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ff2d3d'; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  let shown = 0;
  return {
    update(s: string, f: number) {
      const failed = /^failed/i.test(s);
      stage.textContent = s;
      stage.classList.toggle('err', failed);
      shown = Math.max(shown, Math.min(1, f));
      bar.style.width = `${(shown * 100).toFixed(1)}%`;
      pct.textContent = failed ? 'ERROR' : `${Math.round(shown * 100)}%`;
      if (failed) {
        el.querySelector('.tip')!.replaceChildren(h('div', { class: 'gt-label', style: 'color:var(--red)' }, 'Could not build this world'),
          h('p', {}, 'Check your connection or try another location. '), h('button', { class: 'gt-btn', style: 'margin-top:12px', onclick: () => { location.href = location.pathname; } }, 'Back to map'));
      }
    },
    done() {
      bar.style.width = '100%'; pct.textContent = '100%';
      setTimeout(() => {
        el.classList.add('out'); clearInterval(tipTimer);
        setTimeout(() => { alive = false; el.remove(); }, 950);
      }, 250);
    },
  };
}
