// OWNER: UI agent. Title/spawn picker, loading screen, HUD, minimap, camera map, results, pause/settings.
import type { Game } from '../core/game';
import type { SpawnLocation } from '../core/location';
import * as surveillance from '../surveillance';
import { showSpawnPicker as pickerFlow, autostartLocation, chosen } from './picker';
import { HUD } from './hud';
import { CameraMap } from './cammap';
import { openPause } from './pause';
import { showBusted, showResults } from './results';
import { runStats } from './runstats';
import { h, uiRoot } from './dom';
import { setDuck } from '../audio/engine';
import { stopMenuAmbience } from '../audio';

export { showLoading } from './loading';
export { settings } from './settings';

export async function showSpawnPicker(): Promise<SpawnLocation> {
  return autostartLocation() ?? pickerFlow();
}

export function setupHUD(g: Game): void {
  if (chosen?.mode && g.mode !== chosen.mode) g.mode = chosen.mode;
  runStats(g);
  const hud = new HUD(g);
  uiRoot().appendChild(hud.el);
  const map = new CameraMap(g);
  const state = { pause: null as ReturnType<typeof openPause> | null, results: null as HTMLElement | null, busted: null as HTMLElement | null, clickplay: null as HTMLElement | null, pauseAt: 0 };
  const menuOpen = () => !!(state.pause || state.results || state.busted || map.isOpen);
  (window as any).gtUI = { hud, map, state }; // debug handle

  const setPaused = (p: boolean) => {
    g.paused = p;
    try { g.input.enabled = !p; } catch { /* */ }
  };
  const exitLock = () => { try { if (document.pointerLockElement) document.exitPointerLock(); } catch { /* */ } };

  // ---------- click to play ----------
  const showClickPlay = () => {
    if (state.clickplay || menuOpen()) return;
    const el = h('div', { class: 'gt-clickplay' }, h('div', { class: 'box gt-glass' }, h('b', {}, 'CLICK TO PLAY'), h('span', {}, 'Mouse to look · Esc to pause · M for camera map')));
    el.addEventListener('click', () => {
      hideClickPlay();
      try { g.input.requestPointerLock(); } catch { /* */ }
    });
    uiRoot().appendChild(el); state.clickplay = el;
  };
  const hideClickPlay = () => { state.clickplay?.remove(); state.clickplay = null; };

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) { hideClickPlay(); return; }
    // Lock lost (Esc or alt-tab) during gameplay → pause menu.
    if (!menuOpen()) openPauseMenu();
  });

  // ---------- pause ----------
  const openPauseMenu = () => {
    if (state.pause || state.results || state.busted) return;
    if (map.isOpen) map.close();
    hideClickPlay(); exitLock(); setPaused(true);
    state.pauseAt = performance.now();
    state.pause = openPause(g, resume);
  };
  const resume = () => {
    state.pause?.close(); state.pause = null;
    setPaused(false);
    try { g.input.requestPointerLock(); } catch { /* */ }
    if (!document.pointerLockElement) showClickPlay();
  };

  // ---------- camera map ----------
  map.onClose = () => { if (!state.pause && !state.results && !state.busted) { setPaused(false); hud.setVisible(true); showClickPlay(); } };
  const toggleMap = () => {
    if (map.isOpen) { map.close(); return; }
    if (state.pause || state.results || state.busted) return;
    hideClickPlay();
    // open first so the pointerlockchange handler sees a menu open
    map.open(); exitLock(); setPaused(true); hud.setVisible(false);
  };

  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code === 'Escape') {
      if (map.isOpen) { map.close(); e.preventDefault(); return; }
      if (state.pause) { if (performance.now() - state.pauseAt > 350) resume(); return; }
      if (!state.results && !state.busted) openPauseMenu();
      return;
    }
    if (e.code === 'KeyM' || e.code === 'Tab') {
      if (e.repeat) return;
      e.preventDefault(); toggleMap(); return;
    }
    if (map.isOpen) map.handleKey(e.code);
  }, true);

  // ---------- busted / results ----------
  let lastHot = 0;
  g.events.on('score', (s) => { lastHot = s.hot; });
  let bustedAt = 0;
  g.events.on('arrested', () => {
    if (state.busted) return;
    const lost = (() => { try { return g.surveillance?.hot ?? lastHot; } catch { return lastHot; } })() || lastHot;
    exitLock(); hideClickPlay();
    if (map.isOpen) map.close();
    try { g.player.controlsEnabled = false; } catch { /* */ }
    hud.setVisible(false);
    state.busted = showBusted(lost);
    bustedAt = performance.now();
  });
  g.events.on('runEnd', (r) => {
    if (g.mode === 'freeroam' && r.reason !== 'arrested') return;
    const delay = state.busted ? Math.max(0, 3200 - (performance.now() - bustedAt)) : 0;
    setTimeout(() => {
      state.busted?.remove(); state.busted = null;
      if (state.results) return;
      state.pause?.close(); state.pause = null;
      exitLock(); hideClickPlay(); setPaused(true); hud.setVisible(false); setDuck(0.35);
      state.results = showResults(g, r, {
        runAgain: () => restart('takedown'),
        freeRoam: () => restart('freeroam'),
        newLocation: () => { location.href = location.pathname; },
      });
    }, delay);
  });
  // Arrest in free roam (no runEnd from surveillance): recover after the sting.
  g.events.on('arrested', () => {
    if (g.mode !== 'freeroam') return;
    setTimeout(() => { if (!state.results) { state.busted?.remove(); state.busted = null; restart('freeroam'); } }, 3400);
  });

  const restart = (mode: 'takedown' | 'freeroam') => {
    state.results?.remove(); state.results = null;
    state.busted?.remove(); state.busted = null;
    g.mode = mode;
    const fn = (surveillance as any).startNewRun as ((g: Game) => void) | undefined;
    try {
      if (mode === 'takedown' && typeof fn === 'function') fn(g);
      else {
        try { g.heat?.clear(); } catch { /* */ }
        try { g.player?.respawn(g.recipe.spawn.p, g.recipe.spawn.heading); } catch { /* */ }
        if (mode === 'takedown') g.events.emit('runStart', {});
      }
    } catch (e) { console.error('[ui] restart failed', e); }
    try { g.player.controlsEnabled = true; } catch { /* */ }
    setPaused(false); setDuck(1); hud.setVisible(true); hud.renderMode();
    showClickPlay();
  };

  // ---------- frame update ----------
  // HUD must keep animating while paused, so drive it from rAF rather than a System.
  let last = performance.now();
  const tick = () => {
    const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    try { hud.update(dt); } catch (e) { console.warn('[hud]', e); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  g.events.on('worldReady', () => { stopMenuAmbience(); setTimeout(showClickPlay, 600); });
  g.events.on('runStart', () => { try { g.player.controlsEnabled = true; } catch { /* */ } });
}
