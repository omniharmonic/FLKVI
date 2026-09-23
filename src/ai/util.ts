// Small helpers shared by the AI systems. All accessors are defensive: other modules may be missing.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { VehicleHandle } from '../core/api';
import type { Vec3 } from '../core/types';

export function groundY(g: Game, x: number, z: number, fallback = 0): number {
  const w = (g as any).world;
  if (w) {
    try {
      const y = w.groundAt ? w.groundAt(x, z) : w.heightAt?.(x, z);
      if (Number.isFinite(y)) return y;
    } catch { /* ignore */ }
  }
  return fallback;
}

export function losClear(g: Game, a: Vec3, b: Vec3): boolean {
  const w = (g as any).world;
  if (!w || typeof w.losBlocked !== 'function') return true;
  try { return !w.losBlocked(a, b); } catch { return true; }
}

export function nightFactor(g: Game): number {
  const n = (g as any).sky?.nightFactor;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** Hour of day 0..24 (defaults to noon). */
export function hourOfDay(g: Game): number {
  const t = (g as any).sky?.time;
  return typeof t === 'number' && Number.isFinite(t) ? ((t % 24) + 24) % 24 : 12;
}

export function playSound(g: Game, name: string, opts?: { at?: Vec3; volume?: number; loop?: boolean; rate?: number }) {
  try { return (g as any).audio?.play?.(name, opts) ?? null; } catch { return null; }
}

export interface PlayerInfo {
  ok: boolean;
  x: number; y: number; z: number;
  vx: number; vz: number;
  speed: number;
  heading: number;
  inVehicle: boolean;
  vehicle: VehicleHandle | null;
  suspicious: boolean;
  flagged: boolean;
}

const PI: PlayerInfo = { ok: false, x: 0, y: 0, z: 0, vx: 0, vz: 0, speed: 0, heading: 0, inVehicle: false, vehicle: null, suspicious: false, flagged: false };

/** Snapshot of the player (position, velocity, vehicle). Reuses one object. */
export function playerInfo(g: Game): PlayerInfo {
  const p = (g as any).player;
  if (!p || !p.position) { PI.ok = false; return PI; }
  PI.ok = true;
  const vid = p.vehicleId as string | null;
  const veh = vid ? ((g as any).vehicles?.get?.(vid) as VehicleHandle | undefined) ?? null : null;
  PI.inVehicle = !!vid;
  PI.vehicle = veh;
  const pos = veh?.position ?? p.position;
  PI.x = pos.x; PI.y = pos.y; PI.z = pos.z;
  const vel = p.velocity as THREE.Vector3 | undefined;
  if (veh) {
    PI.heading = veh.heading;
    PI.vx = Math.sin(veh.heading) * veh.speed;
    PI.vz = -Math.cos(veh.heading) * veh.speed;
    if (vel && vel.lengthSq() > 0.01) { PI.vx = vel.x; PI.vz = vel.z; }
  } else {
    PI.heading = p.heading ?? 0;
    PI.vx = vel?.x ?? 0; PI.vz = vel?.z ?? 0;
  }
  PI.speed = Math.hypot(PI.vx, PI.vz);
  PI.suspicious = !!p.suspicious;
  PI.flagged = !!p.plateFlagged;
  return PI;
}

const frustum = new THREE.Frustum();
const projM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
let frustumFrame = -1;

/** Update the cached camera frustum (call once per frame). */
export function updateFrustum(g: Game, frame: number) {
  if (frame === frustumFrame) return;
  frustumFrame = frame;
  const cam = g.camera;
  cam.updateMatrixWorld();
  projM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projM);
}

/** Is point roughly visible to the player camera? (frustum + optional LOS, within maxD) */
export function visibleToCamera(g: Game, x: number, y: number, z: number, maxD = 260, los = true): boolean {
  const cam = g.camera;
  const d = Math.hypot(x - cam.position.x, z - cam.position.z);
  if (d > maxD) return false;
  tmpV.set(x, y + 1, z);
  if (!frustum.containsPoint(tmpV)) return d < 12;
  if (!los) return true;
  return losClear(g, [cam.position.x, cam.position.y, cam.position.z], [x, y + 1.2, z]);
}

export function dist2(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}
