// Shared helpers for the gameplay module.
import * as THREE from 'three';
import type { Game } from '../core/game';
import type { Vec3 } from '../core/types';

/**
 * Heading convention (same as RecipeCamera.heading): radians, 0 = facing north (−Z),
 * increasing clockwise seen from above (π/2 = east, +X).
 * forward = (sin h, 0, −cos h); THREE rotation.y = −h for a model whose front faces −Z.
 */
export function headingToDir(h: number, out = new THREE.Vector3()) {
  return out.set(Math.sin(h), 0, -Math.cos(h));
}
export function dirToHeading(x: number, z: number) {
  return Math.atan2(x, -z);
}
export function wrapAngle(a: number) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
export function lerpAngle(a: number, b: number, t: number) {
  return a + wrapAngle(b - a) * t;
}
export function damp(a: number, b: number, lambda: number, dt: number) {
  return THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));
}
export function clamp(v: number, a: number, b: number) {
  return v < a ? a : v > b ? b : v;
}

export type SoundHandle = { stop(): void; setVolume(v: number): void; setRate(r: number): void; setPosition(p: Vec3): void } | null;

/** Defensive wrapper around g.audio.play — the audio module may be missing or incomplete. */
export function playSound(g: Game, name: string, opts?: { at?: Vec3; volume?: number; loop?: boolean; rate?: number }): SoundHandle {
  try {
    return (g as any).audio?.play?.(name, opts) ?? null;
  } catch {
    return null;
  }
}

export function v3(p: THREE.Vector3): Vec3 {
  return [p.x, p.y, p.z];
}

/** Ground height with fallbacks (world may be missing in dev). */
export function groundY(g: Game, x: number, z: number): number {
  const w = (g as any).world;
  if (w) {
    try {
      const y = w.groundAt ? w.groundAt(x, z) : w.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    } catch { /* ignore */ }
  }
  return 0;
}

export function nightFactor(g: Game): number {
  const n = (g as any).sky?.nightFactor;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}
