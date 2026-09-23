// Arrival fly-in (docs 03 M5): a ~7 s cinematic camera move from high above the city down to the player's
// shoulder, passing a surveillance camera or two with a scan highlight, under letterbox bars and a title card.
// Runs as a late System after the camera rig (order 90): it reads the rig's pose each frame and blends into it,
// so the hand-off is seamless. Skippable with any key / click.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec2 } from '../core/types';
import { h, uiRoot } from './dom';
import { reducedMotion } from './settings';

type Cam = { id: string; type: string; p: Vec2; y: number; poleHeight: number; plateReader: boolean; status?: string };

const TYPE_LABEL: Record<string, string> = { pole: 'POLE CAMERA', ptz: 'PTZ DOME', cluster: 'CAMERA CLUSTER', tower: 'SURVEILLANCE TOWER' };

/** "Boulder, CO — Pearl Street" → "PEARL STREET · BOULDER, CO"; "Pearl St, Boulder, CO" → "PEARL ST · BOULDER, CO". */
export function placeLine(name: string): string {
  const n = (name || '').trim();
  if (!n) return 'UNKNOWN LOCATION';
  const dash = n.split(/\s+[—–-]\s+/);
  if (dash.length >= 2) return `${dash.slice(1).join(' ')} · ${dash[0]}`.toUpperCase();
  const parts = n.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return `${parts[0]} · ${parts.slice(1).join(', ')}`.toUpperCase();
  return n.toUpperCase();
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Mostly ease-out: fast sweep from altitude, long gentle settle. */
const flyEase = (t: number) => { const a = 1 - Math.pow(1 - t, 2.2); return a * 0.8 + easeInOut(t) * 0.2; };

export function playArrival(g: Game, opts: { onGestureSkip?: () => void } = {}): Promise<void> {
  return new Promise((resolve) => {
    const rm = reducedMotion();
    const T = rm ? 3.6 : 7.6;
    const cam = g.camera;
    const sp = g.recipe.spawn;
    const S = new THREE.Vector3(sp.p[0], 0, sp.p[1]);
    const ground = (x: number, z: number) => { try { const y = g.world?.groundAt?.(x, z); return Number.isFinite(y) ? y : sp.y; } catch { return sp.y ?? 0; } };
    S.y = ground(S.x, S.z);
    const fwd = new THREE.Vector3(Math.sin(sp.heading), 0, -Math.cos(sp.heading));
    const side = new THREE.Vector3(Math.cos(sp.heading), 0, Math.sin(sp.heading));

    // ---------- pick 1–2 cameras between the start and the spawn ----------
    let all: Cam[] = [];
    try { all = (g.surveillance?.cameras?.() ?? g.recipe.cameras) as Cam[]; } catch { all = g.recipe.cameras as Cam[]; }
    const active = all.filter((c) => !c.status || c.status === 'active');
    const scored = active.map((c) => {
      const v = new THREE.Vector3(c.p[0] - S.x, 0, c.p[1] - S.z);
      return { c, along: -v.dot(fwd), lat: Math.abs(v.dot(side)), d: v.length() };
    });
    const pick = (lo: number, hi: number, ideal: number, not?: Cam) => {
      const cand = scored.filter((s) => s.c !== not && s.along > lo && s.along < hi && s.lat < 140);
      cand.sort((a, b) => (Math.abs(a.along - ideal) + a.lat * 0.8) - (Math.abs(b.along - ideal) + b.lat * 0.8));
      return cand[0]?.c;
    };
    let camA = pick(150, 420, 240);
    let camB = pick(25, 150, 70, camA);
    if (!camA && !camB) { // nothing behind the spawn: take the nearest ones anywhere
      const near = [...scored].filter((s) => s.d > 20 && s.d < 320).sort((a, b) => a.d - b.d);
      camB = near[0]?.c; camA = near.find((s) => s.c !== camB && s.d > 90)?.c;
    }
    const head = (c: Cam) => new THREE.Vector3(c.p[0], (Number.isFinite(c.y) ? c.y : ground(c.p[0], c.p[1])) + (c.poleHeight || 5), c.p[1]);
    const featured = [camA, camB].filter(Boolean) as Cam[];

    // ---------- spline ----------
    const up = (v: THREE.Vector3, y: number) => v.clone().setY(v.y + y);
    const P0 = S.clone().addScaledVector(fwd, -620).addScaledVector(side, 140); P0.y = S.y + 400;
    const L0 = S.clone().addScaledVector(fwd, 260); L0.y = S.y + 30;
    const pos: THREE.Vector3[] = [P0];
    const look: THREE.Vector3[] = [L0];
    if (camA && !rm) {
      const a = head(camA);
      const p = a.clone().addScaledVector(fwd, -70).addScaledVector(side, 25); p.y = Math.max(a.y + 60, ground(p.x, p.z) + 60);
      pos.push(p); look.push(up(a, -2));
    } else {
      const mid = P0.clone().lerp(S, 0.45); mid.y = S.y + 170; pos.push(mid); look.push(up(S.clone().addScaledVector(fwd, 120), 10));
    }
    if (camB) {
      const b = head(camB);
      const p = b.clone().addScaledVector(fwd, -30).addScaledVector(side, -12); p.y = Math.max(b.y + 20, ground(p.x, p.z) + 18);
      pos.push(p); look.push(up(b, -1));
    }
    const approach = S.clone().addScaledVector(fwd, -14); approach.y = S.y + 8;
    const endPos = S.clone().addScaledVector(fwd, -4.2).addScaledVector(side, 0.5); endPos.y = S.y + 1.9;
    pos.push(approach, endPos);
    look.push(up(S.clone().addScaledVector(fwd, 12), 1.5), up(S.clone().addScaledVector(fwd, 14), 1.6));
    const posCurve = new THREE.CatmullRomCurve3(pos, false, 'centripetal', 0.5);
    const lookCurve = new THREE.CatmullRomCurve3(look, false, 'catmullrom', 0.3);
    // Where along the path (0..1 arc length) each featured camera is closest, for highlight timing.
    const featuredAt = new Map<string, number>();
    for (const c of featured) {
      const hp = head(c); let best = 0; let bd = Infinity;
      for (let i = 0; i <= 200; i++) { const d = posCurve.getPointAt(i / 200).distanceTo(hp); if (d < bd) { bd = d; best = i / 200; } }
      featuredAt.set(c.id, best);
    }

    // ---------- overlay ----------
    const count = active.length;
    const hrs = (() => { try { return g.sky?.time ?? 17.5; } catch { return 17.5; } })();
    const hh = String(Math.floor(hrs) % 24).padStart(2, '0'), mm = String(Math.floor((hrs % 1) * 60)).padStart(2, '0');
    const o = g.recipe.origin;
    const coord = `${Math.abs(o.lat).toFixed(4)}°${o.lat >= 0 ? 'N' : 'S'} ${Math.abs(o.lon).toFixed(4)}°${o.lon >= 0 ? 'E' : 'W'}`;
    const place = placeLine(g.recipe.name);
    const words = place.split(' · ');
    const titleEl = h('div', { class: 'ttl' },
      h('div', { class: 'k' }, `ARRIVAL · ${hh}:${mm} LOCAL · ${coord}`),
      h('div', { class: 'pl' }, ...words.map((w, i) => h('span', { style: `--i:${i}` }, (i ? '· ' : '') + w + ' '))),
      h('div', { class: 'cnt' }, h('b', {}, String(count)), ` CAMERA${count === 1 ? '' : 'S'} ACTIVE`),
    );
    const brackets = h('div', { class: 'brk-layer' });
    const bEls = new Map<string, HTMLElement>();
    for (const c of featured) {
      const el = h('div', { class: 'brk' }, h('i', { class: 'c tl' }), h('i', { class: 'c tr' }), h('i', { class: 'c bl' }), h('i', { class: 'c br' }), h('i', { class: 'sweep' }),
        h('div', { class: 'lab' }, h('b', {}, TYPE_LABEL[c.type] ?? 'CAMERA'), h('span', {}, c.plateReader ? 'PLATE READER · ACTIVE' : 'ACTIVE'), h('span', { class: 'd' }, '')));
      brackets.append(el); bEls.set(c.id, el);
    }
    const skip = h('div', { class: 'skip' }, h('kbd', {}, 'ANY KEY'), ' SKIP');
    const root = h('div', { class: `gt-arrival gt-passthrough ${rm ? 'rm' : ''}` },
      h('div', { class: 'grade' }), brackets, h('div', { class: 'bar top' }), h('div', { class: 'bar bot' }), titleEl, skip);
    uiRoot().appendChild(root);
    requestAnimationFrame(() => root.classList.add('in'));

    // ---------- driver ----------
    const rigPos = new THREE.Vector3(); const rigQ = new THREE.Quaternion(); let rigFov = cam.fov;
    const m = new THREE.Matrix4(); const q = new THREE.Quaternion(); const p = new THREE.Vector3(); const l = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const t0 = performance.now();
    let skipAt = -1; let skipFrom: { p: THREE.Vector3; q: THREE.Quaternion; fov: number } | null = null;
    let done = false;
    const wasEnabled = (() => { try { return g.player.controlsEnabled; } catch { return true; } })();
    try { g.player.controlsEnabled = false; } catch { /* */ }

    const finish = () => {
      if (done) return; done = true;
      g.removeSystem('ui-arrival');
      removeEventListener('keydown', onKey, true);
      removeEventListener('mousedown', onMouse, true);
      try { g.player.controlsEnabled = wasEnabled || true; } catch { /* */ }
      root.classList.remove('in'); root.classList.add('out');
      setTimeout(() => root.remove(), 700);
      resolve();
    };
    const doSkip = () => {
      if (skipAt >= 0 || done) return;
      skipAt = performance.now();
      skipFrom = { p: cam.position.clone(), q: cam.quaternion.clone(), fov: cam.fov };
      root.classList.add('skipping');
    };
    const onKey = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.code === 'F3' || e.code === 'F12') return;
      e.preventDefault(); e.stopPropagation();
      doSkip();
    };
    const onMouse = () => { doSkip(); try { opts.onGestureSkip?.(); } catch { /* */ } };
    addEventListener('keydown', onKey, true);
    addEventListener('mousedown', onMouse, true);

    let lastTitle = -1;
    g.addSystem({
      name: 'ui-arrival',
      order: 95,
      lateUpdate: () => {
        if (done) return;
        // the rig has just placed the camera behind the player: that's the target pose
        rigPos.copy(cam.position); rigQ.copy(cam.quaternion); rigFov = cam.fov;
        const now = performance.now();
        const t = Math.min(1, (now - t0) / 1000 / T);
        // spline pose
        const u = flyEase(t);
        const tp = posCurve.getUtoTmapping(u, 0);
        posCurve.getPoint(tp, p); lookCurve.getPoint(tp, l);
        const gy = ground(p.x, p.z);
        if (p.y < gy + 1.2) p.y = gy + 1.2;
        m.lookAt(p, l, THREE.Object3D.DEFAULT_UP); q.setFromRotationMatrix(m);
        // gentle bank on the sweep
        const bank = Math.sin(t * Math.PI) * (rm ? 0 : 0.035);
        q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), bank));
        let fov = THREE.MathUtils.lerp(40, 52, smooth(0, 0.6, t));
        // blend into the rig
        const w = smooth(0.74, 1.0, t);
        p.lerp(rigPos, w); q.slerp(rigQ, w); fov = THREE.MathUtils.lerp(fov, rigFov, w);
        if (skipAt >= 0 && skipFrom) {
          const k = easeInOut(Math.min(1, (now - skipAt) / (rm ? 250 : 650)));
          p.copy(skipFrom.p).lerp(rigPos, k); q.copy(skipFrom.q).slerp(rigQ, k); fov = THREE.MathUtils.lerp(skipFrom.fov, rigFov, k);
          if (k >= 1) { cam.position.copy(rigPos); cam.quaternion.copy(rigQ); finish(); return; }
        }
        cam.position.copy(p); cam.quaternion.copy(q);
        if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
        cam.updateMatrixWorld();

        // title card
        const showTitle = skipAt < 0 && t > (rm ? 0.1 : 0.2) && t < 0.86;
        if (+showTitle !== lastTitle) { titleEl.classList.toggle('on', showTitle); lastTitle = +showTitle; }
        // camera highlights
        const W = innerWidth, H = innerHeight;
        for (const c of featured) {
          const el = bEls.get(c.id)!;
          const at = featuredAt.get(c.id) ?? 0;
          const hp = head(c);
          const vis = skipAt < 0 && Math.abs(u - at) < 0.2 && u < 0.9;
          proj.copy(hp).project(cam);
          const onScreen = proj.z < 1 && Math.abs(proj.x) < 0.92 && Math.abs(proj.y) < 0.85;
          const on = vis && onScreen;
          el.classList.toggle('on', on);
          if (!on) continue;
          const d = cam.position.distanceTo(hp);
          const sz = THREE.MathUtils.clamp(2600 / Math.max(8, d), 34, 120);
          el.style.transform = `translate(${((proj.x + 1) / 2) * W - sz / 2}px, ${((1 - proj.y) / 2) * H - sz / 2}px)`;
          el.style.width = el.style.height = `${sz}px`;
          (el.querySelector('.d') as HTMLElement).textContent = `${Math.round(d)} M`;
        }
        if (t >= 1 && skipAt < 0) { cam.position.copy(rigPos); cam.quaternion.copy(rigQ); finish(); }
      },
    });
    // Safety net: never trap the player if the loop stalls.
    setTimeout(() => finish(), (T + 6) * 1000);
  });
}
