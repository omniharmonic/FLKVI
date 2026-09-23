// Per-run statistics tracked from events (for results + pause screens).
import type { Game } from '../core/game';

export interface RunStats { cuts: number; disables: number; startedAt: number; endedAt: number | null; bestStreak: number; time(): number }

const stats = new WeakMap<Game, RunStats>();

export function runStats(g: Game): RunStats {
  let s = stats.get(g);
  if (!s) {
    const st: RunStats = { cuts: 0, disables: 0, startedAt: g.elapsed ?? 0, endedAt: null, bestStreak: 0, time() { return (st.endedAt ?? g.elapsed ?? 0) - st.startedAt; } };
    s = st;
    stats.set(g, s);
    g.events.on('runStart', () => { st.cuts = 0; st.disables = 0; st.startedAt = g.elapsed ?? 0; st.endedAt = null; st.bestStreak = 0; });
    g.events.on('takedown', ({ mode }) => { if (mode === 'cut') st.cuts++; else st.disables++; });
    g.events.on('score', ({ streak }) => { st.bestStreak = Math.max(st.bestStreak, streak); });
    g.events.on('runEnd', () => { st.endedAt = g.elapsed ?? 0; });
  }
  return s;
}
