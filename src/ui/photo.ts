// Photo mode (P): pauses the simulation, free camera (WASD + drag / mouse look, Q/E down/up, wheel = speed),
// hides the HUD, adjusts time of day / FOV / tilt, and saves a PNG of the rendered frame.
// Depth of field is not offered: src/render has no DOF pass.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { VehicleSystem } from '../game/vehicles/manager';
import { h, uiRoot } from './dom';
import { renderAndGrab, canvasBlob, downloadBlob, fileStamp } from './perf';
import { settings } from './settings';
import { sfx } from '../audio/sfx';

/** Systems whose update is pure view-dependent culling/LOD (safe to run while the sim is paused). */
const VIEW_SYSTEMS = new Set(['world', 'render-shadow-distance', 'render-instanced-shadow-lod']);

export interface PhotoMode { readonly isOpen: boolean; open(): void; close(relock?: boolean): void }

export function createPhotoMode(g: Game, hooks: { onOpen(): void; onClose(relock: boolean): void }): PhotoMode {
  let open = false;
  let el: HTMLElement | null = null;
  let raf = 0;
  const keys = new Set<string>();
  let yaw = 0, pitch = 0, roll = 0, speed = 8, fov = 55;
  let dragging = false;
  let prevCycle = false;
  const cam = g.camera;
  const pos = new THREE.Vector3();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  let restoreFov = cam.fov;

  const skyTime = () => { try { return g.sky?.time ?? 12; } catch { return 12; } };
  const applySky = () => {
    const s = g.sky as any;
    try { for (let i = 0; i < 6; i++) s?.update?.(0.25); } catch { /* */ }
  };

  const fmtHr = (v: number) => `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.round((v % 1) * 60) % 60).padStart(2, '0')}`;

  function build() {
    const slider = (label: string, min: number, max: number, step: number, value: number, f: (v: number) => string, on: (v: number) => void) => {
      const v = h('span', { class: 'v' }, f(value));
      const i = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
      i.addEventListener('input', () => { const x = parseFloat(i.value); v.textContent = f(x); on(x); });
      i.addEventListener('keydown', (ev) => ev.stopPropagation());
      return h('div', { class: 'row' }, h('label', {}, label, v), i);
    };
    const speedV = h('span', { class: 'v' }, `${speed.toFixed(0)} m/s`);
    const shot = h('button', { class: 'gt-btn primary', onclick: () => save() }, 'Save PNG');
    const panel = h('div', { class: 'panel gt-glass', role: 'dialog', 'aria-label': 'Photo mode' },
      h('div', { class: 'hd' }, h('b', {}, 'PHOTO MODE'), h('span', { class: 'rec' }, 'PAUSED')),
      slider('Time of day', 0, 23.75, 0.25, skyTime(), fmtHr, (v) => { try { if (g.sky) g.sky.time = v; } catch { /* */ } applySky(); }),
      slider('Field of view', 15, 100, 1, fov, (v) => `${v.toFixed(0)}°`, (v) => { fov = v; }),
      slider('Tilt', -25, 25, 0.5, 0, (v) => `${v.toFixed(1)}°`, (v) => { roll = THREE.MathUtils.degToRad(v); }),
      h('div', { class: 'row' }, h('label', {}, 'Fly speed', speedV), h('small', {}, 'Mouse wheel · Shift ×4 · Alt ×¼')),
      h('div', { class: 'keys' },
        h('span', {}, h('kbd', {}, 'W A S D'), ' move'), h('span', {}, h('kbd', {}, 'Q'), h('kbd', {}, 'E'), ' down / up'),
        h('span', {}, h('kbd', {}, 'Drag'), ' look'), h('span', {}, h('kbd', {}, 'H'), ' hide panel'),
        h('span', {}, h('kbd', {}, 'Enter'), ' save'), h('span', {}, h('kbd', {}, 'P'), h('kbd', {}, 'Esc'), ' exit')),
      h('div', { class: 'btns' }, shot, h('button', { class: 'gt-btn', onclick: () => close(true) }, 'Exit')),
    );
    (panel as any)._speedV = speedV;
    const flash = h('div', { class: 'flash' });
    const frame = h('div', { class: 'thirds gt-passthrough' }, h('i'), h('i'), h('i'), h('i'));
    const root = h('div', { class: 'gt-photo' }, frame, flash, panel);
    return root;
  }

  async function save() {
    const c = renderAndGrab(g, 3840);
    if (!c || !el) return;
    el.classList.remove('shot'); void el.offsetWidth; el.classList.add('shot');
    sfx('ui-click');
    const b = await canvasBlob(c, 'image/png');
    if (!b) return;
    const city = (g.recipe?.name ?? 'city').split(/[,—-]/)[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadBlob(b, `flk-vi-${city}-${fileStamp()}.png`);
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    if (!open) return;
    if ((ev.target as HTMLElement)?.tagName === 'INPUT' && ev.code !== 'Escape') return;
    if (ev.code === 'Escape' || ev.code === 'KeyP') { ev.preventDefault(); ev.stopImmediatePropagation(); close(ev.code !== 'Escape'); return; }
    if (ev.code === 'KeyH') { el?.classList.toggle('bare'); ev.stopImmediatePropagation(); return; }
    if (ev.code === 'Enter') { ev.preventDefault(); save(); return; }
    if (ev.code === 'F3') return;
    keys.add(ev.code);
    ev.stopImmediatePropagation();
    if (['Space', 'Tab'].includes(ev.code)) ev.preventDefault();
  };
  const onKeyUp = (ev: KeyboardEvent) => { keys.delete(ev.code); };
  const onDown = (ev: MouseEvent) => {
    if (!open || !el) return;
    if ((ev.target as HTMLElement).closest('.panel')) return;
    dragging = true;
  };
  const onUp = () => { dragging = false; };
  const onMove = (ev: MouseEvent) => {
    if (!open || !dragging) return;
    const k = 0.0032 * (settings.mouseSensitivity || 1) * (fov / 60);
    yaw -= ev.movementX * k;
    pitch = THREE.MathUtils.clamp(pitch - ev.movementY * k * (settings.invertY ? -1 : 1), -1.5, 1.5);
  };
  const onWheel = (ev: WheelEvent) => {
    if (!open || (ev.target as HTMLElement).closest?.('.panel')) return;
    speed = THREE.MathUtils.clamp(speed * (ev.deltaY > 0 ? 1 / 1.25 : 1.25), 0.5, 120);
    const v = (el?.querySelector('.panel') as any)?._speedV as HTMLElement | undefined;
    if (v) v.textContent = `${speed < 10 ? speed.toFixed(1) : speed.toFixed(0)} m/s`;
  };

  let last = 0;
  const loop = () => {
    if (!open) return;
    raf = requestAnimationFrame(loop);
    const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    let mul = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1;
    if (keys.has('AltLeft') || keys.has('AltRight')) mul *= 0.25;
    const f = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    const r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const mv = new THREE.Vector3();
    if (keys.has('KeyW') || keys.has('ArrowUp')) mv.add(f);
    if (keys.has('KeyS') || keys.has('ArrowDown')) mv.sub(f);
    if (keys.has('KeyD') || keys.has('ArrowRight')) mv.add(r);
    if (keys.has('KeyA') || keys.has('ArrowLeft')) mv.sub(r);
    if (keys.has('KeyE') || keys.has('Space')) mv.y += 1;
    if (keys.has('KeyQ') || keys.has('KeyC')) mv.y -= 1;
    if (mv.lengthSq() > 0) pos.addScaledVector(mv.normalize(), speed * mul * dt);
    // keep inside the world and above ground
    const b = g.recipe.bounds; const m = 150;
    pos.x = THREE.MathUtils.clamp(pos.x, b.minX - m, b.maxX + m);
    pos.z = THREE.MathUtils.clamp(pos.z, b.minZ - m, b.maxZ + m);
    let gy = -1e9; try { gy = g.world?.groundAt?.(pos.x, pos.z) ?? -1e9; } catch { /* */ }
    if (Number.isFinite(gy)) pos.y = THREE.MathUtils.clamp(pos.y, gy + 0.25, gy + 600);
    cam.position.copy(pos);
    e.set(pitch, yaw, roll, 'YXZ');
    cam.quaternion.setFromEuler(e);
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    // The sim is paused, but view-dependent culling/LOD (trees, building detail, terrain, shadow LODs) runs in
    // system updates: keep those following the free camera, or flying away shows missing trees / flat facades.
    try {
      for (const s of ((g as any).systems ?? []) as { name: string; update?: (dt: number, g: unknown) => void }[]) {
        if (VIEW_SYSTEMS.has(s.name)) s.update?.(dt, g);
      }
      const vehicles = g.vehicles as VehicleSystem | undefined;
      vehicles?.parking.refresh(cam.position, false, cam);
      vehicles?.lateUpdate(0); // rebuild view-dependent batches without advancing the simulation
    } catch (err) { console.warn('[photo] view update', err); }
  };

  function openMode() {
    if (open) return;
    open = true;
    hooks.onOpen();
    pos.copy(cam.position);
    e.setFromQuaternion(cam.quaternion, 'YXZ');
    pitch = e.x; yaw = e.y; roll = 0; fov = Math.round(cam.fov); restoreFov = cam.fov;
    try { prevCycle = (g.sky as any)?.cyclePaused ?? false; (g.sky as any).cyclePaused = true; } catch { /* */ }
    el = build();
    uiRoot().appendChild(el);
    keys.clear();
    addEventListener('keydown', onKeyDown, true);
    addEventListener('keyup', onKeyUp, true);
    addEventListener('mousedown', onDown, true);
    addEventListener('mouseup', onUp, true);
    addEventListener('mousemove', onMove);
    addEventListener('wheel', onWheel, { passive: true });
    last = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function close(relock = true) {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('keyup', onKeyUp, true);
    removeEventListener('mousedown', onDown, true);
    removeEventListener('mouseup', onUp, true);
    removeEventListener('mousemove', onMove);
    removeEventListener('wheel', onWheel);
    try { (g.sky as any).cyclePaused = prevCycle; } catch { /* */ }
    cam.fov = restoreFov; cam.updateProjectionMatrix();
    el?.remove(); el = null;
    hooks.onClose(relock);
  }

  return { get isOpen() { return open; }, open: openMode, close };
}
