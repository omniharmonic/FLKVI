// BUSTED sequence + end-of-run results screen with per-city personal best.
import type { Game } from '../core/game';
import type { GameEvents } from '../core/events';
import { h, btn, uiRoot, fmt, fmtTime } from './dom';
import { runStats } from './runstats';
import { chosen } from './picker';

export function showBusted(lost: number): HTMLElement {
  const el = h('div', { class: 'gt-busted' }, h('div', { class: 'veil' }), h('div', { class: 'flash' }),
    h('div', { class: 'txt' }, h('h1', {}, 'BUSTED'), h('p', {}, lost > 0 ? `UNBANKED POINTS LOST · ${fmt(lost)}` : 'THE RUN IS OVER')));
  uiRoot().appendChild(el);
  return el;
}

interface PB { streak: number; score: number }
function pbKey(g: Game) { return `groundtruth.pb.${chosen?.baked ?? g.recipe?.name ?? 'unknown'}`; }
function loadPB(g: Game): PB | null { try { const r = localStorage.getItem(pbKey(g)); return r ? JSON.parse(r) : null; } catch { return null; } }
function savePB(g: Game, pb: PB) { try { localStorage.setItem(pbKey(g), JSON.stringify(pb)); } catch { /* */ } }

export function showResults(g: Game, r: GameEvents['runEnd'], actions: { runAgain(): void; freeRoam(): void; newLocation(): void }): HTMLElement {
  const st = runStats(g);
  const prev = loadPB(g);
  const isPB = !prev || r.streak > prev.streak || (r.streak === prev.streak && r.score > prev.score);
  if (isPB) savePB(g, { streak: r.streak, score: r.score });
  const stat = (v: string, label: string, sub?: string) => h('div', {}, h('b', {}, v), h('span', {}, label), sub ? h('small', {}, sub) : null);
  const el = h('div', { class: 'gt-results-scr' },
    h('div', { class: 'wrap' },
      h('div', { class: 'k' }, r.reason === 'arrested' ? 'RUN ENDED · ARRESTED' : 'RUN ENDED'),
      h('div', { class: 'big' }, String(r.streak)),
      h('div', { class: 'bl' }, 'CAMERA STREAK'),
      isPB && (r.streak > 0 || r.score > 0) ? h('div', { class: 'pb' }, 'NEW PERSONAL BEST') : prev ? h('div', { class: 'pb old' }, `PERSONAL BEST · ${prev.streak} STREAK · ${fmt(prev.score)}`) : null,
      h('div', { class: 'stats' },
        stat(fmt(r.score), 'Score'),
        stat(fmt(r.banked), 'Banked'),
        stat(String(st.cuts + st.disables), 'Takedowns', `${st.cuts} cut · ${st.disables} disabled`),
        stat(fmtTime(st.time()), 'Time survived'),
        stat((chosen?.name ?? g.recipe?.name ?? '').split(',')[0] || '—', 'Location'),
      ),
      h('div', { class: 'btns' },
        btn('Run again', actions.runAgain, 'gt-btn primary'),
        btn('Free roam', actions.freeRoam),
        btn('New location', actions.newLocation),
      ),
    ),
  );
  uiRoot().appendChild(el);
  return el;
}
