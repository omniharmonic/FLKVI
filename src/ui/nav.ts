// Shared HUD state: camera list snapshot, selected target, route polyline, player pose helpers.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec2 } from '../core/types';
import type { Cam } from './mapdraw';
import { layersFor } from './mapdraw';

export const nav = {
  route: null as Vec2[] | null,
  routeFor: null as string | null,
  lastCalc: 0,
};

export function cams(g: Game): Cam[] {
  try { return (g.surveillance?.cameras?.() ?? []) as Cam[]; } catch { return []; }
}

export function playerPos(g: Game): Vec2 {
  try { const p = g.player.position; if (p && isFinite(p.x)) return [p.x, p.z]; } catch { /* */ }
  try { return [g.camera.position.x, g.camera.position.z]; } catch { return [0, 0]; }
}

const dir = new THREE.Vector3();
/** View yaw: 0 = north (−Z), clockwise positive. Uses the render camera (what the player sees). */
export function viewYaw(g: Game): number {
  try {
    g.camera.getWorldDirection(dir);
    if (Math.hypot(dir.x, dir.z) > 1e-3) return Math.atan2(dir.x, -dir.z);
  } catch { /* */ }
  try { return g.player.heading ?? 0; } catch { return 0; }
}

export function selectedCam(g: Game): Cam | null {
  const id = g.surveillance?.selectedTarget; if (!id) return null;
  return cams(g).find((c) => c.id === id) ?? null;
}

export function setTarget(g: Game, id: string | null) {
  try { if (g.surveillance) g.surveillance.selectedTarget = id; } catch { /* */ }
  nav.routeFor = null; nav.route = null;
  updateRoute(g, true);
}

/** Recompute the road route to the selected target (≤ 1 Hz). */
export function updateRoute(g: Game, force = false) {
  const c = selectedCam(g);
  if (!c) { nav.route = null; nav.routeFor = null; return; }
  const now = performance.now();
  if (!force && now - nav.lastCalc < 1000 && nav.routeFor === c.id) return;
  nav.lastCalc = now; nav.routeFor = c.id;
  const p = playerPos(g);
  let pts: Vec2[] = [p];
  try {
    const w = g.world;
    if (w?.route && w.nearestNode) {
      const a = w.nearestNode(p), b = w.nearestNode(c.p);
      const ids = w.route(a, b) ?? [];
      const L = layersFor(g.recipe);
      for (const id of ids) { const q = L.nodePos.get(id) ?? g.recipe.graph.nodes[id]?.p; if (q) pts.push(q); }
    }
  } catch { /* straight line fallback */ }
  pts.push(c.p);
  nav.route = pts;
}
