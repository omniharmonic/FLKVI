// Shared perception: view cone + range + line of sight. Used by NPCs, police, the helicopter,
// and (re-exported for) the surveillance module's cameras.
import type { Game } from '../core/game';
import type { Vec3 } from '../core/types';

export interface Observer {
  /** Eye position (m). */
  pos: Vec3;
  /** Heading in radians: 0 = looking toward -Z (north), increasing clockwise seen from above. */
  dir: number;
  /** Full horizontal field of view in degrees (>= 360 means omnidirectional). */
  fovDeg: number;
  /** Nominal daylight range (m). */
  range: number;
  /** Infrared / camera: range is NOT reduced at night. */
  ir?: boolean;
  /**
   * Optional downward-looking cone (helicopter): max angle (deg) off straight-down.
   * When set, `dir`/`fovDeg` are ignored and the cone points at -Y.
   */
  downConeDeg?: number;
}

export interface SeeOpts {
  /** Target is crouching (reduces detection range). Auto-detected for the player when omitted. */
  crouching?: boolean;
  /** Skip the (expensive) line-of-sight raycast. */
  skipLos?: boolean;
  /** Extra range multiplier (e.g. lit by a searchlight, suspicious act visible from farther). */
  rangeMul?: number;
}

/** Night multiplier for non-IR observers (NPC eyes, officers). */
export const NIGHT_RANGE_FACTOR = 0.45;
/** Range multiplier when the target crouches. */
export const CROUCH_RANGE_FACTOR = 0.55;

/** Unit direction (x, z) for a heading (0 = -Z, clockwise). */
export function headingDir(h: number): [number, number] {
  return [Math.sin(h), -Math.cos(h)];
}
/** Heading (0 = -Z, clockwise) of the direction (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}
/** Signed smallest difference a-b in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

function nightFactor(g: Game): number {
  const n = (g as any).sky?.nightFactor;
  return typeof n === 'number' ? n : 0;
}

function playerCrouching(g: Game, target: Vec3): boolean {
  const p = (g as any).player;
  if (!p || !p.position || p.vehicleId) return false;
  const dx = p.position.x - target[0], dz = p.position.z - target[2];
  if (dx * dx + dz * dz > 1.0) return false;
  return !!(p.crouching ?? p.crouched ?? p.isCrouching);
}

/** Effective detection range for an observer (night / crouch adjusted). */
export function effectiveRange(observer: Observer, g: Game, crouching = false, rangeMul = 1): number {
  let r = observer.range * rangeMul;
  if (!observer.ir) r *= 1 - (1 - NIGHT_RANGE_FACTOR) * nightFactor(g);
  if (crouching) r *= CROUCH_RANGE_FACTOR;
  return r;
}

/**
 * Can `observer` see the point `target`? View cone (horizontal), range (night-reduced unless IR,
 * crouch-reduced for the player), and static line of sight via g.world.losBlocked.
 */
export function canSee(observer: Observer, target: Vec3, g: Game, opts: SeeOpts = {}): boolean {
  const dx = target[0] - observer.pos[0];
  const dy = target[1] - observer.pos[1];
  const dz = target[2] - observer.pos[2];
  const crouch = opts.crouching ?? playerCrouching(g, target);
  const range = effectiveRange(observer, g, crouch, opts.rangeMul ?? 1);
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > range * range) return false;
  if (d2 < 1e-6) return true;
  if (observer.downConeDeg !== undefined) {
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const ang = Math.atan2(horiz, -dy); // 0 = straight down
    if (ang > (observer.downConeDeg * Math.PI) / 180) return false;
  } else if (observer.fovDeg < 360) {
    const h2 = dx * dx + dz * dz;
    if (h2 > 0.04) {
      const [fx, fz] = headingDir(observer.dir);
      const cos = (dx * fx + dz * fz) / Math.sqrt(h2);
      if (cos < Math.cos(((observer.fovDeg / 2) * Math.PI) / 180)) return false;
    }
  }
  if (opts.skipLos) return true;
  const w = (g as any).world;
  if (!w || typeof w.losBlocked !== 'function') return true;
  return !w.losBlocked(observer.pos, target);
}

/** Convenience: the player's chest point (Vec3), or null when there is no player. */
export function playerTarget(g: Game): Vec3 | null {
  const p = (g as any).player;
  if (!p || !p.position) return null;
  const inCar = !!p.vehicleId;
  const crouch = !inCar && !!(p.crouching ?? p.crouched);
  return [p.position.x, p.position.y + (inCar ? 1.0 : crouch ? 0.8 : 1.3), p.position.z];
}
